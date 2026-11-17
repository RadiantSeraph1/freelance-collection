const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  openDb, verifyPassword, hashPassword, transaction, today, daysFromNow, addDays,
  quote, parseWeight, createShipment, changeStatus, assignRider, businessStatement,
  SERVICES, ZONES, WEIGHT_BANDS, MAX_WEIGHT_KG, PAYMENT_MODES, STATUSES, ACTIVE_STATUSES, FAIL_REASONS, FAIL_TEXT, STATUS_TEXT, SAME_DAY_CUTOFF_HOUR, STANDARD_DAYS,
} = require('./src/db');
const { seedManager, seedDemo } = require('./src/seed');
const { sessionMiddleware } = require('./src/session');
const { icon, initials } = require('./src/ui');

const STATUS_LABEL = {
  booked: 'Booked', pickup_scheduled: 'Pickup scheduled', picked_up: 'Picked up', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', failed: 'Delivery failed', returned: 'Returned to sender', cancelled: 'Cancelled',
};
const LABELS = {
  ...STATUS_LABEL,
  sender_cash: 'Sender pays cash at pickup', receiver_cash: 'Receiver pays on delivery', account: 'Business account',
  web: 'Website', phone: 'Phone / WhatsApp', bulk: 'Bulk upload',
  manager: 'Dispatcher', rider: 'Rider', business: 'Business customer',
  ...Object.fromEntries(Object.entries(FAIL_TEXT)),
};
Object.entries(SERVICES).forEach(([k, v]) => { LABELS[k] = v.name; });

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isPeriod = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const money = (n) => `GH₵${Number(n || 0).toLocaleString('en-US')}`;
const toWaNumber = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 9) return '';
  if (d.startsWith('0')) return `233${d.slice(1)}`;
  return d.length === 9 ? `233${d}` : d;
};
const TRACKING_RE = /^EE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const PHONE_RE = /^[+\d][\d\s()-]{6,}$/;
const zoneNames = Object.keys(ZONES);

// Checks one booking. `fixedSender` is the business account's own pickup details.
function validateBooking(input, { fixedSender = null, allowedPayments = ['sender_cash', 'receiver_cash'] } = {}) {
  const v = {
    sender_name: fixedSender ? fixedSender.name : clean(input.sender_name, 100),
    sender_phone: fixedSender ? fixedSender.phone : clean(input.sender_phone, 30),
    pickup_address: fixedSender ? fixedSender.address : clean(input.pickup_address, 200),
    pickup_zone: fixedSender ? fixedSender.zone : clean(input.pickup_zone, 40),
    receiver_name: clean(input.receiver_name, 100), receiver_phone: clean(input.receiver_phone, 30),
    delivery_address: clean(input.delivery_address, 200), delivery_zone: clean(input.delivery_zone, 40),
    description: clean(input.description, 200), weight_kg: parseWeight(input.weight_kg),
    service: clean(input.service, 20), payment_mode: oneOf(clean(input.payment_mode, 20), allowedPayments, allowedPayments[0]),
    cod_amount: intOrNull(input.cod_amount || 0) ?? NaN,
  };
  const errors = [];
  if (v.sender_name.length < 2) errors.push('Enter the sender’s name.');
  if (!PHONE_RE.test(v.sender_phone)) errors.push('Enter a valid sender phone number.');
  if (v.pickup_address.length < 3) errors.push('Enter the pickup address.');
  if (v.receiver_name.length < 2) errors.push('Enter the receiver’s name.');
  if (!PHONE_RE.test(v.receiver_phone)) errors.push('Enter a valid receiver phone number.');
  if (v.delivery_address.length < 3) errors.push('Enter the delivery address.');
  if (v.description.length < 3) errors.push('Describe what is being sent.');
  if (!(v.cod_amount >= 0 && v.cod_amount <= 50000)) errors.push('Cash to collect on delivery must be between GH₵0 and GH₵50,000.');
  const q = quote(v.service, v.pickup_zone, v.delivery_zone, v.weight_kg);
  if (q.error) errors.push(q.error);
  return { v, errors, q };
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production');
  }
  const site = {
    name: env.SITE_NAME || 'Emirad Express',
    phone: env.SITE_PHONE || '+233 00 000 0000',
    email: env.SITE_EMAIL || 'bookings@example.com',
    address: env.SITE_ADDRESS || 'Accra, Ghana',
    demo: env.DEMO_BANNER !== 'off',
    temporary: (options.dbPath || env.DB_PATH) === ':memory:',
  };
  site.whatsapp = (env.SITE_WHATSAPP || site.phone).replace(/\D/g, '');

  const db = openDb(options.dbPath || env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
  seedManager(db, { user: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD || 'admin123' });
  // Demo accounts share a documented password, so in production they exist only if explicitly requested.
  if (env.SEED_DEMO ? env.SEED_DEMO === 'on' : !production) seedDemo(db, { password: env.DEMO_PASSWORD || 'demo-pass-1' });

  const app = express();
  app.locals.db = db;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(sessionMiddleware(env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), production));

  app.use((req, res, next) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    Object.assign(res.locals, {
      site, icon, initials, label: (k) => LABELS[k] || k, session: req.session, path: req.path, me: null, money, todayDate: today(db),
      SERVICES, ZONES, zoneNames, FAIL_REASONS, STATUS_LABEL,
      waLink: (phone, text) => `https://wa.me/${toWaNumber(phone)}?text=${encodeURIComponent(text)}`,
      trackUrl: (code) => `${origin}/track/${code}`,
    });
    next();
  });

  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const key = `${req.path.split('/')[1]}|${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return res.status(429).render('message', { title: 'Please try again later', body: 'Too many requests from your connection. Please wait a few minutes or call us instead.' });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
  const notFound = (res) => res.status(404).render('message', { title: 'Page not found', body: 'The page you are looking for does not exist.' });
  const forbidden = (res) => res.status(403).render('message', { title: 'Not allowed', body: 'You do not have access to this page.' });

  const SHIPMENT_SELECT = `SELECT s.*, r.name AS rider_name, r.phone AS rider_phone, b.company AS business_company,
      (s.status IN ('booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed') AND s.due_date < date('now')) AS late
    FROM shipments s LEFT JOIN users r ON r.id = s.rider_id LEFT JOIN users b ON b.id = s.business_id`;
  const getShipment = (id) => db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ?`).get(intOrNull(id));
  const eventsOf = (id, onlyVisible) => db.prepare(`SELECT * FROM events WHERE shipment_id = ? ${onlyVisible ? 'AND visible = 1' : ''} ORDER BY created_at, id`).all(id);
  const activeRiders = () => db.prepare("SELECT id, name FROM users WHERE role = 'rider' AND active = 1 ORDER BY name").all();
  const statusText = (s) => (s.status === 'failed' ? `${STATUS_TEXT.failed} (${FAIL_TEXT[s.failure_reason] || ''})` : STATUS_TEXT[s.status]).toLowerCase();
  const notifyText = (s, who, url) => `Hello ${(who === 'sender' ? s.sender_name : s.receiver_name).split(' ')[0]}, your parcel ${s.tracking} ${who === 'sender' ? `to ${s.receiver_name.split(' ')[0]}` : `from ${s.sender_name}`} is now: ${statusText(s)}. Track it: ${url}`;

  // ---------- Public: home, price quote, booking, tracking ----------

  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok', uptime: Math.round(process.uptime()) }); });

  app.get('/', (req, res) => {
    const samples = site.demo ? db.prepare(`SELECT tracking, status FROM shipments WHERE status IN ('delivered', 'out_for_delivery', 'failed') ORDER BY (status = 'out_for_delivery') DESC, id DESC`).all()
      .filter((s, i, all) => all.findIndex((x) => x.status === s.status) === i) : [];
    res.render('home', { title: `${site.name}: send and track parcels`, samples, error: null });
  });

  app.get('/rates', (req, res) => res.render('rates', { title: 'Delivery rates', WEIGHT_BANDS, MAX_WEIGHT_KG, SAME_DAY_CUTOFF_HOUR, STANDARD_DAYS }));

  app.get('/quote', (req, res) => {
    const form = { pickup_zone: clean(req.query.pickup_zone, 40), delivery_zone: clean(req.query.delivery_zone, 40), weight_kg: clean(req.query.weight_kg, 8), service: clean(req.query.service, 20) };
    const asked = Object.values(form).some(Boolean);
    const result = asked ? quote(form.service, form.pickup_zone, form.delivery_zone, parseWeight(form.weight_kg)) : null;
    res.render('quote', { title: 'Get a price', form, result });
  });

  const bookingPage = (res, status = 200, errors = [], form = {}) => res.status(status).render('book', { title: 'Book a pickup', errors, form });
  app.get('/book', (req, res) => bookingPage(res, 200, [], { service: oneOf(req.query.service, Object.keys(SERVICES), 'next_day'), pickup_zone: clean(req.query.pickup_zone, 40), delivery_zone: clean(req.query.delivery_zone, 40), weight_kg: clean(req.query.weight_kg, 8), payment_mode: 'sender_cash' }));

  app.post('/book', limit(6, 10 * 60 * 1000), (req, res) => {
    if (clean(req.body.website)) return res.redirect('/booked/EE-XXXX-XXXX'); // honeypot: pretend it worked
    const { v, errors } = validateBooking(req.body);
    if (errors.length) return bookingPage(res, 400, errors, { ...req.body });
    const made = createShipment(db, { ...v, source: 'web' }, { by: v.sender_name });
    res.redirect(`/booked/${made.tracking}`);
  });

  app.get('/booked/:code', (req, res) => {
    const s = TRACKING_RE.test(req.params.code) ? db.prepare('SELECT tracking, price, service, payment_mode, due_date, receiver_name FROM shipments WHERE tracking = ?').get(req.params.code) : null;
    if (!s && req.params.code !== 'EE-XXXX-XXXX') return notFound(res);
    res.render('booked', { title: 'Booking received', s });
  });

  app.get('/track', limit(40, 10 * 60 * 1000), (req, res) => {
    const code = clean(req.query.code, 20).toUpperCase().replace(/\s+/g, '');
    if (!code) return res.redirect('/');
    if (!TRACKING_RE.test(code)) return res.status(400).render('home', { title: site.name, samples: [], error: 'That does not look like a tracking number. It looks like EE-ABCD-2345.' });
    res.redirect(`/track/${code}`);
  });

  // Tracking shows progress and areas only. Phone numbers, street addresses and
  // internal notes are never shown, so a tracking number alone reveals little.
  app.get('/track/:code', limit(40, 10 * 60 * 1000), (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const s = TRACKING_RE.test(code) ? getShipment(db.prepare('SELECT id FROM shipments WHERE tracking = ?').get(code)?.id) : null;
    if (!s) return res.status(404).render('message', { title: 'Tracking number not found', body: 'We could not find that tracking number. Please check it and try again, or call us.' });
    res.render('track', { title: `Tracking ${s.tracking}`, s, events: eventsOf(s.id, true), closed: ['delivered', 'returned', 'cancelled'].includes(s.status) });
  });

  // ---------- Sign-in ----------

  const home = (role) => ({ manager: '/admin', rider: '/rider', business: '/account' }[role]);
  app.get('/login', (req, res) => {
    const me = req.session && db.prepare('SELECT role FROM users WHERE username = ? AND active = 1').get(req.session.user);
    return me ? res.redirect(home(me.role)) : res.render('login', { title: 'Sign in', error: null });
  });

  // Only failed attempts count towards the limit, so shared mobile-network
  // addresses never lock out people who are signing in correctly.
  const failedLogins = new Map();
  const maxFailures = Number(env.LOGIN_FAILURES) || 8;
  const recentFailures = (ip) => (failedLogins.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
  app.post('/login', (req, res) => {
    if (recentFailures(req.ip).length >= maxFailures) {
      return res.status(429).render('message', { title: 'Please try again later', body: 'Too many failed sign-in attempts from your connection. Please wait ten minutes and try again.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(clean(req.body.username, 60).toLowerCase());
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      failedLogins.set(req.ip, [...recentFailures(req.ip), Date.now()]);
      return res.status(401).render('login', { title: 'Sign in', error: 'Wrong username or password.' });
    }
    res.startSession(user.username);
    res.redirect(home(user.role));
  });

  const auth = (req, res, next) => {
    const me = req.session && db.prepare('SELECT id, username, name, role, company, phone, address, zone FROM users WHERE username = ? AND active = 1').get(req.session.user);
    if (!me) { res.endSession(); return res.redirect('/login'); }
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
      return res.status(403).render('message', { title: 'Session expired', body: 'Please go back, refresh the page and try again.' });
    }
    req.me = me;
    res.locals.me = me;
    res.locals.csrf = req.session.csrf;
    res.set('Cache-Control', 'no-store');
    next();
  };
  const only = (role) => (req, res, next) => (req.me.role === role ? next() : forbidden(res));

  const account = express.Router();
  account.post('/logout', (req, res) => { res.endSession(); res.redirect('/'); });
  account.get('/password', (req, res) => res.render('password', { title: 'Change password', errors: [], done: false }));
  account.post('/password', limit(10, 10 * 60 * 1000), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.me.id);
    const errors = [];
    if (!verifyPassword(String(req.body.current || ''), user.password_hash)) errors.push('Your current password is not correct.');
    if (String(req.body.next || '').length < 8) errors.push('The new password must be at least 8 characters.');
    if (req.body.next !== req.body.confirm) errors.push('The new password and its confirmation do not match.');
    if (errors.length) return res.status(400).render('password', { title: 'Change password', errors, done: false });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.next), req.me.id);
    res.render('password', { title: 'Change password', errors: [], done: true });
  });
  app.use('/account-settings', auth, account);

  // ---------- Dispatcher ----------

  const admin = express.Router();
  const ACTIVE_SQL = "s.status IN ('booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed')";

  admin.get('/', (req, res) => {
    const count = (where, ...p) => db.prepare(`SELECT COUNT(*) AS n FROM shipments s WHERE ${where}`).get(...p).n;
    const stats = {
      today: count("date(s.created_at) = date('now')"),
      toAssign: count("s.status = 'booked'"),
      moving: count("s.status IN ('picked_up', 'out_for_delivery')"),
      deliveredToday: count("s.status = 'delivered' AND date(s.closed_at) = date('now')"),
      failed: count("s.status = 'failed'"),
      late: count(`${ACTIVE_SQL} AND s.due_date < date('now')`),
      dueToday: count(`${ACTIVE_SQL} AND s.due_date = date('now')`),
    };
    const list = (where, order = 's.created_at', n = 10) => db.prepare(`${SHIPMENT_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${n}`).all();
    const cash = db.prepare(`SELECT u.id, u.name, COUNT(*) AS items, SUM(c.collected) AS total FROM cash_items c JOIN users u ON u.id = c.rider_id WHERE c.remitted_at IS NULL GROUP BY u.id ORDER BY total DESC`).all();
    res.render('admin/dashboard', {
      title: 'Dispatch dashboard', stats, cash, riders: activeRiders(),
      toAssign: list("s.status = 'booked'"), late: list(`${ACTIVE_SQL} AND s.due_date < date('now')`, 's.due_date'), failed: list("s.status = 'failed'", 's.updated_at'),
      dueToday: list(`${ACTIVE_SQL} AND s.due_date = date('now')`, 's.created_at', 8),
    });
  });

  admin.get('/board', (req, res) => {
    const rider = oneOf(req.query.rider ?? '', ['', ...activeRiders().map((r) => String(r.id))], '');
    const rows = db.prepare(`${SHIPMENT_SELECT} WHERE ${ACTIVE_SQL} ${rider ? 'AND s.rider_id = ?' : ''} ORDER BY s.due_date, s.id`).all(...(rider ? [Number(rider)] : []));
    res.render('admin/board', { title: 'Board', columns: ACTIVE_STATUSES.map((st) => ({ status: st, rows: rows.filter((r) => r.status === st) })), riders: activeRiders(), rider });
  });

  admin.get('/shipments', (req, res) => {
    const f = { q: clean(req.query.q, 60), status: oneOf(req.query.status, [...STATUSES, 'active'], ''), service: oneOf(req.query.service, Object.keys(SERVICES), ''), rider: clean(req.query.rider, 10), business: intOrNull(req.query.business), date: isDate(clean(req.query.date, 10)) ? req.query.date : '' };
    const where = ['1 = 1'];
    const params = [];
    if (f.q) { where.push('(s.tracking LIKE ? OR s.sender_name LIKE ? OR s.receiver_name LIKE ? OR s.receiver_phone LIKE ? OR s.sender_phone LIKE ?)'); params.push(...Array(5).fill(`%${f.q}%`)); }
    if (f.status === 'active') where.push(ACTIVE_SQL); else if (f.status) { where.push('s.status = ?'); params.push(f.status); }
    if (f.service) { where.push('s.service = ?'); params.push(f.service); }
    if (f.rider === 'none') where.push('s.rider_id IS NULL'); else if (intOrNull(f.rider) !== null) { where.push('s.rider_id = ?'); params.push(intOrNull(f.rider)); }
    if (f.business !== null) { where.push('s.business_id = ?'); params.push(f.business); }
    if (f.date) { where.push('date(s.created_at) = ?'); params.push(f.date); }
    const shipments = db.prepare(`${SHIPMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT 300`).all(...params);
    res.render('admin/shipments', { title: 'Shipments', shipments, f, riders: activeRiders(), STATUSES, businesses: db.prepare("SELECT id, company FROM users WHERE role = 'business' ORDER BY company").all() });
  });

  admin.get('/shipments.csv', (req, res) => {
    const header = ['Tracking', 'Created', 'Status', 'Service', 'Sender', 'Sender phone', 'From', 'Receiver', 'Receiver phone', 'To', 'Weight kg', 'Payment', 'Price', 'COD', 'Rider', 'Due', 'Attempts'];
    const lines = db.prepare(`${SHIPMENT_SELECT} ORDER BY s.id`).all().map((s) => [s.tracking, s.created_at, STATUS_LABEL[s.status], SERVICES[s.service].name, s.sender_name, s.sender_phone, s.pickup_zone,
      s.receiver_name, s.receiver_phone, s.delivery_zone, s.weight_kg, LABELS[s.payment_mode], s.price, s.cod_amount, s.rider_name || '', s.due_date, s.attempts].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shipments.csv"' });
    res.send(`﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
  });

  const businessesList = () => db.prepare("SELECT id, company, name, phone, address, zone FROM users WHERE role = 'business' AND active = 1 ORDER BY company").all();
  const newBooking = (res, status = 200, errors = [], form = {}) => res.status(status).render('admin/book', { title: 'Book a parcel for a caller', errors, form, businesses: businessesList(), riders: activeRiders() });
  admin.get('/shipments/new', (req, res) => newBooking(res, 200, [], { service: 'next_day', payment_mode: 'sender_cash', pickup_zone: 'Haatso' }));

  admin.post('/shipments', (req, res) => {
    const biz = intOrNull(req.body.business_id) ? db.prepare("SELECT * FROM users WHERE id = ? AND role = 'business' AND active = 1").get(intOrNull(req.body.business_id)) : null;
    const { v, errors } = validateBooking(req.body, { fixedSender: biz ? { name: biz.company, phone: biz.phone, address: clean(req.body.pickup_address, 200) || biz.address, zone: clean(req.body.pickup_zone, 40) || biz.zone } : null, allowedPayments: biz ? ['account', 'sender_cash', 'receiver_cash'] : ['sender_cash', 'receiver_cash'] });
    if (errors.length) return newBooking(res, 400, errors, { ...req.body });
    const made = createShipment(db, { ...v, business_id: biz ? biz.id : null, source: 'phone' }, { by: req.me.name });
    const rider = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'rider' AND active = 1").get(intOrNull(req.body.rider_id));
    if (rider) assignRider(db, getShipment(made.id), rider, req.me.name);
    res.redirect(`/admin/shipments/${made.id}`);
  });

  const shipmentPage = (res, req, id, status = 200, errors = []) => {
    const s = getShipment(id);
    if (!s) return notFound(res);
    const url = res.locals.trackUrl(s.tracking);
    return res.status(status).render('admin/shipment', {
      title: s.tracking, s, errors, events: eventsOf(s.id, false), riders: activeRiders(), cash: db.prepare('SELECT * FROM cash_items WHERE shipment_id = ? ORDER BY id').all(s.id),
      next: require('./src/db').TRANSITIONS[s.status], url, senderText: notifyText(s, 'sender', url), receiverText: notifyText(s, 'receiver', url),
    });
  };
  admin.get('/shipments/:id', (req, res) => shipmentPage(res, req, req.params.id));

  admin.post('/shipments/:id/assign', (req, res) => {
    const s = getShipment(req.params.id);
    if (!s) return notFound(res);
    const result = assignRider(db, s, db.prepare('SELECT * FROM users WHERE id = ?').get(intOrNull(req.body.rider_id)), req.me.name);
    if (result.error) return shipmentPage(res, req, s.id, 400, [result.error]);
    res.redirect(req.body.back === 'dashboard' ? '/admin' : `/admin/shipments/${s.id}`);
  });

  admin.post('/shipments/:id/status', (req, res) => {
    const s = getShipment(req.params.id);
    if (!s) return notFound(res);
    const result = changeStatus(db, s, oneOf(req.body.to, STATUSES, ''), { by: req.me.name, note: req.body.note, recipient: req.body.recipient, reason: req.body.reason, collected: req.body.collected });
    if (result.error) return shipmentPage(res, req, s.id, 400, [result.error]);
    res.redirect(`/admin/shipments/${s.id}`);
  });

  admin.get('/cash', (req, res) => {
    const riders = db.prepare(`SELECT u.id, u.name, u.phone,
        COALESCE(SUM(CASE WHEN c.remitted_at IS NULL THEN c.collected END), 0) AS holding,
        COALESCE(SUM(CASE WHEN c.remitted_at IS NULL THEN c.expected - c.collected END), 0) AS short,
        COUNT(CASE WHEN c.remitted_at IS NULL THEN 1 END) AS items
      FROM users u LEFT JOIN cash_items c ON c.rider_id = u.id WHERE u.role = 'rider' GROUP BY u.id ORDER BY holding DESC`).all();
    const items = db.prepare(`SELECT c.*, u.name AS rider_name, s.tracking, s.receiver_name FROM cash_items c JOIN users u ON u.id = c.rider_id JOIN shipments s ON s.id = c.shipment_id
      WHERE c.remitted_at IS NULL ORDER BY c.collected_at DESC`).all();
    const recent = db.prepare(`SELECT u.name, date(c.remitted_at) AS day, SUM(c.collected) AS total, COUNT(*) AS items, c.remitted_by FROM cash_items c JOIN users u ON u.id = c.rider_id
      WHERE c.remitted_at IS NOT NULL GROUP BY u.id, date(c.remitted_at) ORDER BY c.remitted_at DESC LIMIT 10`).all();
    res.render('admin/cash', { title: 'Cash from riders', riders, items, recent });
  });

  admin.post('/cash/remit', (req, res) => {
    const rider = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'rider'").get(intOrNull(req.body.rider_id));
    if (rider) db.prepare("UPDATE cash_items SET remitted_at = datetime('now'), remitted_by = ? WHERE rider_id = ? AND remitted_at IS NULL").run(req.me.name, rider.id);
    res.redirect('/admin/cash');
  });

  const peoplePage = (res, status = 200, errors = [], form = {}) => res.status(status).render('admin/people', {
    title: 'Riders and customers', errors, form,
    people: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM shipments WHERE rider_id = u.id AND status IN ('pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed')) AS open_jobs,
      (SELECT COUNT(*) FROM shipments WHERE business_id = u.id) AS parcels FROM users u WHERE u.role != 'manager' ORDER BY u.role DESC, u.active DESC, COALESCE(NULLIF(u.company, ''), u.name)`).all(),
  });
  admin.get('/people', (req, res) => peoplePage(res));
  admin.post('/people', (req, res) => {
    const f = { role: oneOf(req.body.role, ['rider', 'business'], 'rider'), name: clean(req.body.name, 80), company: clean(req.body.company, 100), username: clean(req.body.username, 30).toLowerCase(),
      phone: clean(req.body.phone, 30), address: clean(req.body.address, 200), zone: clean(req.body.zone, 40) };
    const password = String(req.body.password || '');
    const errors = [];
    if (f.name.length < 2) errors.push('Enter the person’s name.');
    if (f.role === 'business' && f.company.length < 2) errors.push('Enter the business name.');
    if (f.role === 'business' && (f.address.length < 3 || !(f.zone in ZONES))) errors.push('A business account needs a pickup address and area.');
    if (!PHONE_RE.test(f.phone)) errors.push('Enter a valid phone number.');
    if (!/^[a-z0-9._-]{3,30}$/.test(f.username)) errors.push('The username must be 3 to 30 letters, digits, dots or dashes.');
    if (password.length < 8) errors.push('The password must be at least 8 characters.');
    if (!errors.length && db.prepare('SELECT 1 FROM users WHERE username = ?').get(f.username)) errors.push('That username is already taken.');
    if (errors.length) return peoplePage(res, 400, errors, f);
    db.prepare('INSERT INTO users (username, name, role, company, phone, address, zone, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.username, f.name, f.role, f.role === 'business' ? f.company : '', f.phone, f.address, f.zone, hashPassword(password));
    res.redirect('/admin/people');
  });
  admin.post('/people/:id/toggle', (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role != 'manager'").get(intOrNull(req.params.id));
    if (user) {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(user.active ? 0 : 1, user.id);
      // A rider who leaves hands their unfinished pickups back to dispatch; parcels already on the road stay assigned until reassigned.
      if (user.active && user.role === 'rider') db.prepare("UPDATE shipments SET rider_id = NULL, status = 'booked' WHERE rider_id = ? AND status = 'pickup_scheduled'").run(user.id);
    }
    res.redirect('/admin/people');
  });

  admin.get('/statements', (req, res) => {
    const businesses = businessesList();
    const business = businesses.find((b) => b.id === intOrNull(req.query.business)) || businesses[0];
    const period = isPeriod(req.query.period) ? req.query.period : today(db).slice(0, 7);
    res.render('admin/statements', { title: 'Business statements', businesses, business, period, periods: periodOptions(), data: business ? businessStatement(db, business.id, period) : null });
  });
  const periodOptions = () => Array.from({ length: 12 }, (_, i) => daysFromNow(db, -30 * i).slice(0, 7)).filter((p, i, a) => a.indexOf(p) === i);

  admin.get('/reports', (req, res) => {
    const q = (sql, ...p) => db.prepare(sql).all(...p);
    const delivered = db.prepare("SELECT COUNT(*) AS n, SUM(date(closed_at) <= due_date) AS on_time FROM shipments WHERE status = 'delivered'").get();
    res.render('admin/reports', {
      title: 'Reports', delivered,
      days: q("SELECT date(created_at) AS d, COUNT(*) AS n FROM shipments WHERE date(created_at) >= date('now', '-13 days') GROUP BY d ORDER BY d"),
      byService: q("SELECT service, COUNT(*) AS n, SUM(price) AS revenue FROM shipments WHERE status != 'cancelled' GROUP BY service ORDER BY revenue DESC"),
      byStatus: q('SELECT status, COUNT(*) AS n FROM shipments GROUP BY status'),
      byCustomer: q(`SELECT COALESCE(NULLIF(u.company, ''), 'Walk-in and phone customers') AS customer, COUNT(*) AS n, SUM(s.price) AS revenue FROM shipments s LEFT JOIN users u ON u.id = s.business_id
        WHERE s.status != 'cancelled' GROUP BY s.business_id ORDER BY revenue DESC`),
      failures: q("SELECT failure_reason AS reason, COUNT(*) AS n FROM shipments WHERE failure_reason != '' GROUP BY failure_reason ORDER BY n DESC"),
      riders: q(`SELECT u.name, SUM(s.status = 'delivered') AS delivered, SUM(s.attempts) AS failed_attempts,
          ROUND(AVG(CASE WHEN s.status = 'delivered' THEN (julianday(s.closed_at) - julianday(s.created_at)) * 24 END), 1) AS hours
        FROM users u LEFT JOIN shipments s ON s.rider_id = u.id WHERE u.role = 'rider' GROUP BY u.id ORDER BY delivered DESC`),
      cash: db.prepare("SELECT COALESCE(SUM(CASE WHEN remitted_at IS NULL THEN collected END), 0) AS holding, COALESCE(SUM(MAX(expected - collected, 0)), 0) AS short FROM cash_items").get(),
    });
  });

  app.use('/admin', auth, only('manager'), admin);

  // ---------- Riders ----------

  const rider = express.Router();
  const RIDER_STATUSES = ['picked_up', 'out_for_delivery', 'delivered', 'failed'];
  const myJob = (req, id) => db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ? AND s.rider_id = ?`).get(intOrNull(id), req.me.id);

  rider.get('/', (req, res) => {
    const jobs = db.prepare(`${SHIPMENT_SELECT} WHERE s.rider_id = ? AND ${ACTIVE_SQL} ORDER BY s.due_date, s.id`).all(req.me.id);
    const holding = db.prepare('SELECT COALESCE(SUM(collected), 0) AS n FROM cash_items WHERE rider_id = ? AND remitted_at IS NULL').get(req.me.id).n;
    const doneToday = db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE rider_id = ? AND status = 'delivered' AND date(closed_at) = date('now')").get(req.me.id).n;
    res.render('rider/jobs', { title: 'My jobs', pickups: jobs.filter((j) => j.status === 'pickup_scheduled'), deliveries: jobs.filter((j) => j.status !== 'pickup_scheduled'), holding, doneToday });
  });

  const jobPage = (res, s, status = 200, errors = []) => res.status(status).render('rider/job', { title: s.tracking, s, errors, events: eventsOf(s.id, false) });
  rider.get('/jobs/:id', (req, res) => { const s = myJob(req, req.params.id); return s ? jobPage(res, s) : notFound(res); });
  rider.post('/jobs/:id/status', (req, res) => {
    const s = myJob(req, req.params.id);
    if (!s) return notFound(res);
    const to = oneOf(req.body.to, RIDER_STATUSES, '');
    if (!to) return jobPage(res, s, 400, ['That update is not available to riders.']);
    const result = changeStatus(db, s, to, { by: req.me.name, note: req.body.note, recipient: req.body.recipient, reason: req.body.reason, collected: req.body.collected });
    if (result.error) return jobPage(res, s, 400, [result.error]);
    res.redirect(['delivered', 'failed'].includes(to) ? '/rider' : `/rider/jobs/${s.id}`);
  });
  rider.get('/cash', (req, res) => {
    res.render('rider/cash', { title: 'My cash', items: db.prepare(`SELECT c.*, s.tracking FROM cash_items c JOIN shipments s ON s.id = c.shipment_id WHERE c.rider_id = ? ORDER BY c.collected_at DESC LIMIT 60`).all(req.me.id) });
  });
  app.use('/rider', auth, only('rider'), rider);

  // ---------- Business accounts ----------

  const biz = express.Router();
  const myParcel = (req, id) => db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ? AND s.business_id = ?`).get(intOrNull(id), req.me.id);
  const fixedSender = (me) => ({ name: me.company, phone: me.phone, address: me.address, zone: me.zone });

  biz.get('/', (req, res) => {
    const c = (where) => db.prepare(`SELECT COUNT(*) AS n FROM shipments s WHERE s.business_id = ? AND ${where}`).get(req.me.id).n;
    res.render('account/dashboard', {
      title: req.me.company, stats: { active: c(ACTIVE_SQL), delivered: c("s.status = 'delivered'"), failed: c("s.status = 'failed'"), cod: db.prepare(`SELECT COALESCE(SUM(c.collected), 0) AS n FROM cash_items c JOIN shipments s ON s.id = c.shipment_id WHERE s.business_id = ? AND c.kind = 'delivery_collection'`).get(req.me.id).n },
      shipments: db.prepare(`${SHIPMENT_SELECT} WHERE s.business_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 30`).all(req.me.id),
    });
  });

  const bookForm = (res, status = 200, errors = [], form = {}) => res.status(status).render('account/book', { title: 'Book a delivery', errors, form });
  biz.get('/book', (req, res) => bookForm(res, 200, [], { service: 'next_day' }));
  biz.post('/book', limit(60, 10 * 60 * 1000), (req, res) => {
    const { v, errors } = validateBooking(req.body, { fixedSender: fixedSender(req.me), allowedPayments: ['account'] });
    if (errors.length) return bookForm(res, 400, errors, { ...req.body });
    const made = createShipment(db, { ...v, business_id: req.me.id, source: 'account' }, { by: req.me.company });
    res.redirect(`/account/shipments/${made.id}`);
  });

  // Bulk booking: one line per parcel, all or nothing, so a typo never books half a batch.
  const BULK_MAX = 50;
  biz.get('/bulk', (req, res) => res.render('account/bulk', { title: 'Book many deliveries', errors: [], text: '', service: 'next_day', BULK_MAX }));
  biz.post('/bulk', limit(20, 10 * 60 * 1000), (req, res) => {
    const text = String(req.body.lines || '').slice(0, 20000);
    const service = oneOf(clean(req.body.service, 20), Object.keys(SERVICES), 'next_day');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const errors = [];
    const parsed = [];
    if (!lines.length) errors.push('Paste at least one line.');
    if (lines.length > BULK_MAX) errors.push(`You can book up to ${BULK_MAX} parcels at a time.`);
    if (!errors.length) {
      lines.forEach((line, i) => {
        const [receiver_name, receiver_phone, delivery_zone, delivery_address, description, weight_kg, cod_amount] = line.split(',').map((x) => x.trim());
        const { v, errors: lineErrors } = validateBooking({ receiver_name, receiver_phone, delivery_zone, delivery_address, description, weight_kg, cod_amount: cod_amount || 0, service }, { fixedSender: fixedSender(req.me), allowedPayments: ['account'] });
        if (lineErrors.length) errors.push(`Line ${i + 1}: ${lineErrors.join(' ')}`); else parsed.push(v);
      });
    }
    if (errors.length) return res.status(400).render('account/bulk', { title: 'Book many deliveries', errors, text, service, BULK_MAX });
    const made = transaction(db, () => parsed.map((v) => createShipment(db, { ...v, business_id: req.me.id, source: 'bulk' }, { by: req.me.company })));
    res.render('account/bulk-done', { title: 'Deliveries booked', made, total: made.reduce((n, m) => n + m.price, 0) });
  });

  biz.get('/shipments/:id', (req, res) => {
    const s = myParcel(req, req.params.id);
    return s ? res.render('account/shipment', { title: s.tracking, s, events: eventsOf(s.id, true), errors: [], url: res.locals.trackUrl(s.tracking) }) : notFound(res);
  });
  biz.post('/shipments/:id/cancel', (req, res) => {
    const s = myParcel(req, req.params.id);
    if (!s) return notFound(res);
    const result = changeStatus(db, s, 'cancelled', { by: req.me.company, note: 'Cancelled by the customer' });
    if (result.error) return res.status(400).render('account/shipment', { title: s.tracking, s, events: eventsOf(s.id, true), errors: ['This parcel is already with a rider, so it can no longer be cancelled online. Please call us.'], url: res.locals.trackUrl(s.tracking) });
    res.redirect(`/account/shipments/${s.id}`);
  });
  biz.get('/statement', (req, res) => {
    const period = isPeriod(req.query.period) ? req.query.period : today(db).slice(0, 7);
    res.render('account/statement', { title: 'Monthly statement', business: req.me, period, periods: periodOptions(), data: businessStatement(db, req.me.id, period) });
  });
  app.use('/account', auth, only('business'), biz);

  app.use((req, res) => notFound(res));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', body: 'Please try again in a moment, or call us directly.' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
    if (!process.env.ADMIN_PASSWORD) console.log('Demo logins: admin / admin123 (dispatcher); kofi, esi, musah (riders), shopnest, glow (business accounts) / demo-pass-1.');
  });
}

module.exports = { createApp };
