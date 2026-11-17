const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  openDb, verifyPassword, hashPassword, ensureCharges, ledger, statement, today, daysFromNow, addMonths,
  ROLES, CURRENCIES, PRIORITIES, REQUEST_STATUSES, ACTIVE_REQUEST, INSPECTION_KINDS, CONDITIONS, AREAS, VIEWING_STATUSES, PAYMENT_METHODS, INSPECTION_EVERY_DAYS,
} = require('./src/db');
const { seedManager, seedDemo } = require('./src/seed');
const { sessionMiddleware } = require('./src/session');

const LABELS = {
  manager: 'Manager', landlord: 'Landlord', tenant: 'Tenant',
  low: 'Low', normal: 'Normal', urgent: 'Urgent',
  open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled',
  routine: 'Routine', move_in: 'Move-in', move_out: 'Move-out', good: 'Good', fair: 'Fair', poor: 'Poor',
  requested: 'Requested', confirmed: 'Confirmed',
};

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
const money = (amount, currency) => `${currency === 'USD' ? '$' : 'GH₵'}${Number(amount || 0).toLocaleString('en-US')}`;
const toWaNumber = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 9) return '';
  if (d.startsWith('0')) return `233${d.slice(1)}`;
  return d.length === 9 ? `233${d}` : d;
};

const UNIT_SELECT = `SELECT un.*, p.name AS property_name, p.address, p.area, p.landlord_id, p.fee_percent, l.name AS landlord_name,
    t.id AS tenancy_id, t.tenant_id, tu.name AS tenant_name, tu.phone AS tenant_phone, t.rent, t.currency AS rent_currency, t.end_date AS lease_end
  FROM units un JOIN properties p ON p.id = un.property_id JOIN users l ON l.id = p.landlord_id
  LEFT JOIN tenancies t ON t.unit_id = un.id AND t.status = 'active' LEFT JOIN users tu ON tu.id = t.tenant_id`;
const TENANCY_SELECT = `SELECT t.*, un.label AS unit_label, un.property_id, p.name AS property_name, p.landlord_id, p.fee_percent,
    tu.name AS tenant_name, tu.phone AS tenant_phone, tu.email AS tenant_email, l.name AS landlord_name
  FROM tenancies t JOIN units un ON un.id = t.unit_id JOIN properties p ON p.id = un.property_id
  JOIN users tu ON tu.id = t.tenant_id JOIN users l ON l.id = p.landlord_id`;
const REQUEST_SELECT = `SELECT m.*, un.label AS unit_label, un.property_id, p.name AS property_name, p.landlord_id, ru.name AS reporter_name
  FROM maintenance m JOIN units un ON un.id = m.unit_id JOIN properties p ON p.id = un.property_id LEFT JOIN users ru ON ru.id = m.reported_by`;

function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production');
  }
  const site = {
    name: env.SITE_NAME || 'Floorspace Realty',
    phone: env.SITE_PHONE || '+233 00 000 0000',
    email: env.SITE_EMAIL || 'sales@example.com',
    demo: env.DEMO_BANNER !== 'off',
  };

  const db = openDb(options.dbPath || env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
  seedManager(db, { user: env.ADMIN_USER || 'admin', password: env.ADMIN_PASSWORD || 'admin123' });
  // Demo accounts share a documented password, so in production they exist only if explicitly requested.
  if (env.SEED_DEMO ? env.SEED_DEMO === 'on' : !production) seedDemo(db, { password: env.DEMO_PASSWORD || 'demo-pass-1' });
  ensureCharges(db);

  const app = express();
  app.locals.db = db;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(sessionMiddleware(env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), production));

  app.use((req, res, next) => {
    Object.assign(res.locals, {
      site, label: (k) => LABELS[k] || k, session: req.session, path: req.path, me: null, money,
      waLink: (phone, text) => `https://wa.me/${toWaNumber(phone)}?text=${encodeURIComponent(text)}`,
      todayDate: today(db),
    });
    next();
  });

  const hits = new Map();
  const limit = (max, windowMs) => (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return res.status(429).render('message', { title: 'Please try again later', body: 'Too many requests from your connection. Please wait a few minutes or call us instead.' });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
  const notFound = (res) => res.status(404).render('message', { title: 'Page not found', body: 'The page you are looking for does not exist or has been removed.' });
  const forbidden = (res) => res.status(403).render('message', { title: 'Not allowed', body: 'You do not have access to this page.' });

  // Active tenancies with their ledger, optionally for one landlord. Used by the
  // dashboards, the rent page and the landlord portal.
  function portfolio(landlordId) {
    const rows = db.prepare(`${TENANCY_SELECT} WHERE t.status = 'active' ${landlordId ? 'AND p.landlord_id = ?' : ''} ORDER BY p.name, un.label`).all(...(landlordId ? [landlordId] : []));
    return rows.map((t) => {
      const l = ledger(db, t.id);
      const reminder = db.prepare('SELECT MAX(sent_on) AS d FROM reminders WHERE tenancy_id = ?').get(t.id).d;
      return { ...t, l, lastReminder: reminder };
    });
  }
  const reminderText = (t) => {
    const first = t.tenant_name.split(' ')[0];
    if (t.l.overdue > 0) {
      return `Hello ${first}, this is a friendly reminder from ${site.name} that ${money(t.l.overdue, t.currency)} of rent for ${t.property_name}, ${t.unit_label} is overdue (since ${t.l.oldestOverdue}). Please let us know when payment has been made. Thank you.`;
    }
    return `Hello ${first}, a friendly reminder from ${site.name} that rent of ${money(t.l.nextDue ? t.l.nextDue.amount : t.rent, t.currency)} for ${t.property_name}, ${t.unit_label} is due on ${t.l.nextDue ? t.l.nextDue.date : 'its due date'}. Thank you.`;
  };
  const totalsByCurrency = (rows, pick) => {
    const out = {};
    for (const r of rows) { const v = pick(r); if (v) out[r.currency] = (out[r.currency] || 0) + v; }
    return out;
  };

  // ---------- Public: vacancies, viewing requests, sign-in ----------

  const VACANT = `SELECT un.*, p.name AS property_name, p.area, p.address FROM units un JOIN properties p ON p.id = un.property_id
    WHERE un.listed = 1 AND NOT EXISTS (SELECT 1 FROM tenancies t WHERE t.unit_id = un.id AND t.status = 'active')`;

  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok', uptime: Math.round(process.uptime()) }); });

  const vacanciesPage = (req, res) => {
    const f = { beds: intOrNull(req.query.beds), area: clean(req.query.area, 60) };
    const where = [];
    const params = [];
    if (f.beds !== null) { where.push('un.bedrooms >= ?'); params.push(f.beds); }
    if (f.area) { where.push('p.area = ?'); params.push(f.area); }
    const units = db.prepare(`${VACANT} ${where.length ? `AND ${where.join(' AND ')}` : ''} ORDER BY p.area, un.asking_rent`).all(...params);
    const areas = db.prepare('SELECT DISTINCT area FROM properties WHERE area != \'\' ORDER BY area').all().map((r) => r.area);
    res.render('vacancies', { title: 'Available to rent', units, f, areas });
  };
  app.get('/', vacanciesPage);
  app.get('/vacancies', vacanciesPage);

  const vacancyPage = (res, unit, status = 200, errors = [], form = {}) => res.status(status).render('vacancy', { title: `${unit.property_name}, ${unit.label}`, unit, errors, form });

  app.get('/vacancies/:id', (req, res) => {
    const unit = db.prepare(`${VACANT} AND un.id = ?`).get(intOrNull(req.params.id));
    return unit ? vacancyPage(res, unit) : notFound(res);
  });

  app.post('/vacancies/:id/viewing', limit(5, 10 * 60 * 1000), (req, res) => {
    const unit = db.prepare(`${VACANT} AND un.id = ?`).get(intOrNull(req.params.id));
    if (!unit) return notFound(res);
    if (clean(req.body.website)) return res.redirect('/viewing/thanks'); // honeypot
    const form = { name: clean(req.body.name, 100), phone: clean(req.body.phone, 30), email: clean(req.body.email, 120), preferred_date: clean(req.body.preferred_date, 10), message: clean(req.body.message, 1000) };
    const errors = [];
    if (form.name.length < 2) errors.push('Please enter your name.');
    if (!form.phone && !form.email) errors.push('Please give a phone number or an email address so we can confirm.');
    if (form.phone && !/^[+\d][\d\s()-]{6,}$/.test(form.phone)) errors.push('That phone number does not look right.');
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('That email address does not look right.');
    if (form.preferred_date && (!isDate(form.preferred_date) || form.preferred_date < today(db))) errors.push('Choose a viewing date from today onwards.');
    if (errors.length) return vacancyPage(res, unit, 400, errors, form);
    db.prepare('INSERT INTO viewings (unit_id, name, phone, email, preferred_date, message) VALUES (?, ?, ?, ?, ?, ?)')
      .run(unit.id, form.name, form.phone, form.email, form.preferred_date || null, form.message);
    res.redirect('/viewing/thanks');
  });

  app.get('/viewing/thanks', (req, res) => res.render('message', { title: 'Thank you', body: 'Your viewing request has been received. We will contact you to confirm a time.' }));

  app.get('/login', (req, res) => (req.session ? res.redirect('/portal') : res.render('login', { title: 'Sign in', error: null })));

  // Only failed attempts count towards the limit, because many tenants share one
  // mobile-network address and successful sign-ins must never lock anyone out.
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
    res.redirect(user.role === 'manager' ? '/admin' : '/portal');
  });

  // ---------- Signed-in users ----------

  const auth = (req, res, next) => {
    const me = req.session && db.prepare('SELECT id, username, name, role, phone, email FROM users WHERE username = ? AND active = 1').get(req.session.user);
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
  const only = (...roles) => (req, res, next) => (roles.includes(req.me.role) ? next() : forbidden(res));

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
  app.use('/account', auth, account);

  // ---------- Manager area ----------

  const admin = express.Router();

  admin.get('/', (req, res) => {
    ensureCharges(db);
    const tenancies = portfolio();
    const todayDate = today(db);
    const overdue = tenancies.filter((t) => t.l.overdue > 0).sort((a, b) => b.l.daysOverdue - a.l.daysOverdue);
    const soon = tenancies.filter((t) => t.l.overdue === 0 && t.l.nextDue && t.l.nextDue.date <= daysFromNow(db, 7));
    const ending = tenancies.filter((t) => t.end_date && t.end_date >= todayDate && t.end_date <= daysFromNow(db, 60)).sort((a, b) => a.end_date.localeCompare(b.end_date));
    const collected = db.prepare("SELECT t.currency, SUM(pay.amount) AS n FROM payments pay JOIN tenancies t ON t.id = pay.tenancy_id WHERE substr(pay.paid_on, 1, 7) = ? GROUP BY t.currency").all(todayDate.slice(0, 7));
    const unitCount = db.prepare('SELECT COUNT(*) AS n FROM units').get().n;
    const requests = db.prepare(`${REQUEST_SELECT} WHERE m.status IN ('open', 'scheduled', 'in_progress') ORDER BY (m.priority = 'urgent') DESC, m.created_at LIMIT 8`).all();
    const inspectionsDue = db.prepare(`${UNIT_SELECT} WHERE t.id IS NOT NULL AND COALESCE((SELECT MAX(inspected_on) FROM inspections i WHERE i.unit_id = un.id), '0000-00-00') < date('now', ?) ORDER BY un.id`).all(`-${INSPECTION_EVERY_DAYS} days`)
      .map((u) => ({ ...u, last: db.prepare('SELECT MAX(inspected_on) AS d FROM inspections WHERE unit_id = ?').get(u.id).d }));
    const newViewings = db.prepare("SELECT v.*, un.label, p.name AS property_name FROM viewings v JOIN units un ON un.id = v.unit_id JOIN properties p ON p.id = un.property_id WHERE v.status = 'requested' ORDER BY v.created_at").all();
    res.render('admin/dashboard', {
      title: 'Dashboard', overdue, soon, ending, requests, inspectionsDue, newViewings, reminderText,
      arrears: totalsByCurrency(tenancies, (t) => t.l.overdue), collected: Object.fromEntries(collected.map((c) => [c.currency, c.n])),
      occupied: tenancies.length, units: unitCount, openRequests: db.prepare("SELECT COUNT(*) AS n FROM maintenance WHERE status IN ('open', 'scheduled', 'in_progress')").get().n,
      urgent: db.prepare("SELECT COUNT(*) AS n FROM maintenance WHERE status IN ('open', 'scheduled', 'in_progress') AND priority = 'urgent'").get().n,
    });
  });

  admin.get('/rent', (req, res) => {
    ensureCharges(db);
    const rows = portfolio().sort((a, b) => b.l.daysOverdue - a.l.daysOverdue || a.property_name.localeCompare(b.property_name));
    res.render('admin/rent', { title: 'Rent', rows, reminderText });
  });

  admin.get('/rent-roll.csv', (req, res) => {
    ensureCharges(db);
    const header = ['Property', 'Unit', 'Landlord', 'Tenant', 'Phone', 'Rent', 'Currency', 'Due day', 'Lease ends', 'Charged', 'Paid', 'Balance', 'Overdue', 'Days overdue'];
    const lines = portfolio().map((t) => [t.property_name, t.unit_label, t.landlord_name, t.tenant_name, t.tenant_phone, t.rent, t.currency, t.due_day, t.end_date || '',
      t.l.charged, t.l.paid, t.l.balance, t.l.overdue, t.l.daysOverdue].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rent-roll.csv"' });
    res.send(`﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
  });

  // People
  const peoplePage = (res, status = 200, errors = [], form = {}) => res.status(status).render('admin/people', {
    title: 'People', errors, form, ROLES,
    people: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM properties WHERE landlord_id = u.id) AS properties,
      (SELECT COUNT(*) FROM tenancies WHERE tenant_id = u.id AND status = 'active') AS tenancies FROM users u WHERE u.role != 'manager' ORDER BY u.role, u.name`).all(),
  });
  admin.get('/people', (req, res) => peoplePage(res));
  admin.post('/people', (req, res) => {
    const form = { name: clean(req.body.name, 80), role: oneOf(req.body.role, ['landlord', 'tenant'], 'tenant'), username: clean(req.body.username, 30).toLowerCase(), phone: clean(req.body.phone, 30), email: clean(req.body.email, 120) };
    const password = String(req.body.password || '');
    const errors = [];
    if (form.name.length < 2) errors.push('Enter the person’s name.');
    if (!/^[a-z0-9._-]{3,30}$/.test(form.username)) errors.push('The username must be 3 to 30 letters, digits, dots or dashes.');
    if (password.length < 8) errors.push('The password must be at least 8 characters.');
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('That email address does not look right.');
    if (!errors.length && db.prepare('SELECT 1 FROM users WHERE username = ?').get(form.username)) errors.push('That username is already taken.');
    if (errors.length) return peoplePage(res, 400, errors, form);
    db.prepare('INSERT INTO users (username, name, role, phone, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)').run(form.username, form.name, form.role, form.phone, form.email, hashPassword(password));
    res.redirect('/admin/people');
  });
  admin.post('/people/:id/toggle', (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role != 'manager'").get(intOrNull(req.params.id));
    if (user) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(user.active ? 0 : 1, user.id);
    res.redirect('/admin/people');
  });

  // Properties and units
  const landlords = () => db.prepare("SELECT id, name FROM users WHERE role = 'landlord' AND active = 1 ORDER BY name").all();
  const readProperty = (body) => {
    const p = { landlord_id: intOrNull(body.landlord_id), name: clean(body.name, 100), address: clean(body.address, 150), area: clean(body.area, 60), fee_percent: intOrNull(body.fee_percent), notes: clean(body.notes, 1000) };
    const errors = [];
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'landlord'").get(p.landlord_id)) errors.push('Choose the landlord who owns this property.');
    if (p.name.length < 2) errors.push('Enter the property name.');
    if (p.fee_percent === null || p.fee_percent > 50) errors.push('Enter the management fee as a percentage from 0 to 50.');
    return { p, errors };
  };

  admin.get('/properties', (req, res) => {
    const properties = db.prepare(`SELECT p.*, l.name AS landlord_name, (SELECT COUNT(*) FROM units WHERE property_id = p.id) AS units,
      (SELECT COUNT(*) FROM units un JOIN tenancies t ON t.unit_id = un.id AND t.status = 'active' WHERE un.property_id = p.id) AS occupied
      FROM properties p JOIN users l ON l.id = p.landlord_id ORDER BY p.name`).all();
    res.render('admin/properties', { title: 'Properties', properties, landlords: landlords(), errors: [], form: {} });
  });
  admin.post('/properties', (req, res) => {
    const { p, errors } = readProperty(req.body);
    if (errors.length) {
      const properties = db.prepare('SELECT p.*, l.name AS landlord_name, 0 AS units, 0 AS occupied FROM properties p JOIN users l ON l.id = p.landlord_id ORDER BY p.name').all();
      return res.status(400).render('admin/properties', { title: 'Properties', properties, landlords: landlords(), errors, form: p });
    }
    const id = db.prepare('INSERT INTO properties (landlord_id, name, address, area, fee_percent, notes) VALUES (?, ?, ?, ?, ?, ?)').run(p.landlord_id, p.name, p.address, p.area, p.fee_percent, p.notes).lastInsertRowid;
    res.redirect(`/admin/properties/${id}`);
  });

  const propertyPage = (res, id, status = 200, errors = []) => {
    const property = db.prepare('SELECT p.*, l.name AS landlord_name FROM properties p JOIN users l ON l.id = p.landlord_id WHERE p.id = ?').get(id);
    if (!property) return notFound(res);
    const units = db.prepare(`${UNIT_SELECT} WHERE un.property_id = ? ORDER BY un.label`).all(property.id)
      .map((u) => ({ ...u, l: u.tenancy_id ? ledger(db, u.tenancy_id) : null }));
    return res.status(status).render('admin/property', {
      title: property.name, property, units, errors, landlords: landlords(), CURRENCIES,
      requests: db.prepare(`${REQUEST_SELECT} WHERE un.property_id = ? ORDER BY m.created_at DESC LIMIT 6`).all(property.id),
    });
  };
  admin.get('/properties/:id', (req, res) => propertyPage(res, intOrNull(req.params.id)));
  admin.post('/properties/:id', (req, res) => {
    const id = intOrNull(req.params.id);
    if (!db.prepare('SELECT 1 FROM properties WHERE id = ?').get(id)) return notFound(res);
    const { p, errors } = readProperty(req.body);
    if (errors.length) return propertyPage(res, id, 400, errors);
    db.prepare('UPDATE properties SET landlord_id = ?, name = ?, address = ?, area = ?, fee_percent = ?, notes = ? WHERE id = ?').run(p.landlord_id, p.name, p.address, p.area, p.fee_percent, p.notes, id);
    res.redirect(`/admin/properties/${id}`);
  });

  const readUnit = (body) => ({
    label: clean(body.label, 30), bedrooms: intOrNull(body.bedrooms), bathrooms: intOrNull(body.bathrooms), asking_rent: intOrNull(body.asking_rent) ?? 0,
    currency: oneOf(body.currency, CURRENCIES, 'GHS'), listed: body.listed ? 1 : 0, description: clean(body.description, 1000),
  });
  admin.post('/properties/:id/units', (req, res) => {
    const id = intOrNull(req.params.id);
    if (!db.prepare('SELECT 1 FROM properties WHERE id = ?').get(id)) return notFound(res);
    const u = readUnit(req.body);
    if (!u.label) return propertyPage(res, id, 400, ['Enter a name or number for the unit.']);
    if (db.prepare('SELECT 1 FROM units WHERE property_id = ? AND label = ?').get(id, u.label)) return propertyPage(res, id, 400, [`This property already has a unit called ${u.label}.`]);
    const unitId = db.prepare('INSERT INTO units (property_id, label, bedrooms, bathrooms, asking_rent, currency, listed, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, u.label, u.bedrooms, u.bathrooms, u.asking_rent, u.currency, u.listed, u.description).lastInsertRowid;
    res.redirect(`/admin/units/${unitId}`);
  });

  const unitPage = (res, id, status = 200, errors = [], form = {}) => {
    const unit = db.prepare(`${UNIT_SELECT} WHERE un.id = ?`).get(id);
    if (!unit) return notFound(res);
    return res.status(status).render('admin/unit', {
      title: `${unit.property_name}, ${unit.label}`, unit, errors, form, CURRENCIES,
      tenants: db.prepare("SELECT id, name FROM users WHERE role = 'tenant' AND active = 1 ORDER BY name").all(),
      history: db.prepare(`${TENANCY_SELECT} WHERE t.unit_id = ? ORDER BY t.start_date DESC`).all(unit.id),
      requests: db.prepare(`${REQUEST_SELECT} WHERE m.unit_id = ? ORDER BY m.created_at DESC LIMIT 8`).all(unit.id),
      inspections: db.prepare('SELECT * FROM inspections WHERE unit_id = ? ORDER BY inspected_on DESC LIMIT 5').all(unit.id),
    });
  };
  admin.get('/units/:id', (req, res) => unitPage(res, intOrNull(req.params.id)));
  admin.post('/units/:id', (req, res) => {
    const id = intOrNull(req.params.id);
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!unit) return notFound(res);
    const u = readUnit(req.body);
    if (!u.label) return unitPage(res, id, 400, ['Enter a name or number for the unit.']);
    if (db.prepare('SELECT 1 FROM units WHERE property_id = ? AND label = ? AND id != ?').get(unit.property_id, u.label, id)) return unitPage(res, id, 400, [`This property already has a unit called ${u.label}.`]);
    db.prepare('UPDATE units SET label = ?, bedrooms = ?, bathrooms = ?, asking_rent = ?, currency = ?, listed = ?, description = ? WHERE id = ?')
      .run(u.label, u.bedrooms, u.bathrooms, u.asking_rent, u.currency, u.listed, u.description, id);
    res.redirect(`/admin/units/${id}`);
  });

  admin.post('/units/:id/tenancies', (req, res) => {
    const id = intOrNull(req.params.id);
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    if (!unit) return notFound(res);
    const form = { tenant_id: intOrNull(req.body.tenant_id), rent: intOrNull(req.body.rent), currency: oneOf(req.body.currency, CURRENCIES, 'GHS'), due_day: intOrNull(req.body.due_day),
      start_date: clean(req.body.start_date, 10), end_date: clean(req.body.end_date, 10), deposit: intOrNull(req.body.deposit) ?? 0 };
    const errors = [];
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'tenant' AND active = 1").get(form.tenant_id)) errors.push('Choose the tenant.');
    if (!form.rent) errors.push('Enter the monthly rent as a whole number.');
    if (!form.due_day || form.due_day > 28) errors.push('The rent due day must be between 1 and 28.');
    if (!isDate(form.start_date)) errors.push('Enter the date the tenancy starts.');
    if (form.end_date && (!isDate(form.end_date) || form.end_date < form.start_date)) errors.push('The lease end date must be after the start date.');
    if (db.prepare("SELECT 1 FROM tenancies WHERE unit_id = ? AND status = 'active'").get(id)) errors.push('This unit already has an active tenancy. End it first.');
    if (errors.length) return unitPage(res, id, 400, errors, form);
    const tenancyId = db.prepare('INSERT INTO tenancies (unit_id, tenant_id, rent, currency, due_day, start_date, end_date, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, form.tenant_id, form.rent, form.currency, form.due_day, form.start_date, form.end_date || null, form.deposit).lastInsertRowid;
    ensureCharges(db);
    res.redirect(`/admin/tenancies/${tenancyId}`);
  });

  // Tenancies, payments, reminders
  const tenancyPage = (res, id, status = 200, errors = []) => {
    ensureCharges(db);
    const tenancy = db.prepare(`${TENANCY_SELECT} WHERE t.id = ?`).get(id);
    if (!tenancy) return notFound(res);
    const l = ledger(db, tenancy.id);
    return res.status(status).render('admin/tenancy', {
      title: `${tenancy.tenant_name}, ${tenancy.unit_label}`, t: tenancy, l, errors, PAYMENT_METHODS,
      reminders: db.prepare('SELECT * FROM reminders WHERE tenancy_id = ? ORDER BY sent_on DESC, id DESC LIMIT 5').all(tenancy.id),
      reminderText: reminderText({ ...tenancy, l }),
    });
  };
  admin.get('/tenancies/:id', (req, res) => tenancyPage(res, intOrNull(req.params.id)));

  const activeTenancy = (id) => db.prepare("SELECT * FROM tenancies WHERE id = ? AND status = 'active'").get(id);

  admin.post('/tenancies/:id/payments', (req, res) => {
    const id = intOrNull(req.params.id);
    if (!db.prepare('SELECT 1 FROM tenancies WHERE id = ?').get(id)) return notFound(res);
    const amount = intOrNull(req.body.amount);
    const paidOn = clean(req.body.paid_on, 10);
    const errors = [];
    if (!amount) errors.push('Enter the amount received as a whole number.');
    if (!isDate(paidOn)) errors.push('Enter the date the payment was received.');
    else if (paidOn > today(db)) errors.push('The payment date cannot be in the future.');
    if (errors.length) return tenancyPage(res, id, 400, errors);
    db.prepare('INSERT INTO payments (tenancy_id, amount, paid_on, method, reference, recorded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, amount, paidOn, oneOf(req.body.method, PAYMENT_METHODS, 'bank transfer'), clean(req.body.reference, 60), req.me.name);
    res.redirect(`/admin/tenancies/${id}`);
  });
  admin.post('/tenancies/:id/payments/:pid/delete', (req, res) => {
    const id = intOrNull(req.params.id);
    db.prepare('DELETE FROM payments WHERE id = ? AND tenancy_id = ?').run(intOrNull(req.params.pid), id);
    res.redirect(`/admin/tenancies/${id}`);
  });
  admin.post('/tenancies/:id/reminders', (req, res) => {
    const id = intOrNull(req.params.id);
    if (!db.prepare('SELECT 1 FROM tenancies WHERE id = ?').get(id)) return notFound(res);
    db.prepare('INSERT INTO reminders (tenancy_id, sent_by) VALUES (?, ?)').run(id, req.me.name);
    res.redirect(req.body.back === 'rent' ? '/admin/rent' : req.body.back === 'dashboard' ? '/admin' : `/admin/tenancies/${id}`);
  });
  admin.post('/tenancies/:id/rent', (req, res) => {
    const id = intOrNull(req.params.id);
    if (!activeTenancy(id)) return notFound(res);
    const rent = intOrNull(req.body.rent);
    if (!rent) return tenancyPage(res, id, 400, ['Enter the new monthly rent as a whole number.']);
    db.prepare('UPDATE tenancies SET rent = ? WHERE id = ?').run(rent, id);
    // Months that have already fallen due keep the rent that applied then.
    db.prepare("UPDATE charges SET amount = ? WHERE tenancy_id = ? AND due_date > date('now')").run(rent, id);
    res.redirect(`/admin/tenancies/${id}`);
  });
  admin.post('/tenancies/:id/end', (req, res) => {
    const id = intOrNull(req.params.id);
    const t = activeTenancy(id);
    if (!t) return notFound(res);
    const endedOn = isDate(req.body.ended_on) ? req.body.ended_on : today(db);
    if (endedOn < t.start_date) return tenancyPage(res, id, 400, ['The end date cannot be before the tenancy started.']);
    db.prepare("UPDATE tenancies SET status = 'ended', ended_on = ? WHERE id = ?").run(endedOn, id);
    db.prepare('DELETE FROM charges WHERE tenancy_id = ? AND period > ?').run(id, endedOn.slice(0, 7));
    res.redirect(`/admin/tenancies/${id}`);
  });

  // Maintenance
  const maintenanceForm = (res, status = 200, errors = [], form = {}) => res.status(status).render('admin/maintenance-new', {
    title: 'Log a repair request', errors, form, PRIORITIES,
    units: db.prepare(`${UNIT_SELECT} ORDER BY p.name, un.label`).all(),
  });
  admin.get('/maintenance', (req, res) => {
    const f = { status: oneOf(req.query.status, [...REQUEST_STATUSES, 'active'], 'active'), priority: oneOf(req.query.priority, PRIORITIES, ''), property: intOrNull(req.query.property) };
    const where = ['1 = 1'];
    const params = [];
    if (f.status === 'active') where.push("m.status IN ('open', 'scheduled', 'in_progress')");
    else { where.push('m.status = ?'); params.push(f.status); }
    if (f.priority) { where.push('m.priority = ?'); params.push(f.priority); }
    if (f.property !== null) { where.push('un.property_id = ?'); params.push(f.property); }
    const requests = db.prepare(`${REQUEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY (m.priority = 'urgent') DESC, m.created_at DESC`).all(...params);
    res.render('admin/maintenance', { title: 'Maintenance', requests, f, REQUEST_STATUSES, PRIORITIES, properties: db.prepare('SELECT id, name FROM properties ORDER BY name').all() });
  });
  admin.get('/maintenance/new', (req, res) => maintenanceForm(res, 200, [], { unit_id: intOrNull(req.query.unit), priority: 'normal' }));
  admin.post('/maintenance', (req, res) => {
    const form = { unit_id: intOrNull(req.body.unit_id), title: clean(req.body.title, 120), description: clean(req.body.description, 2000), priority: oneOf(req.body.priority, PRIORITIES, 'normal') };
    const unit = db.prepare(`${UNIT_SELECT} WHERE un.id = ?`).get(form.unit_id);
    const errors = [];
    if (!unit) errors.push('Choose the unit.');
    if (form.title.length < 3) errors.push('Describe the problem in a few words.');
    if (errors.length) return maintenanceForm(res, 400, errors, form);
    const id = db.prepare('INSERT INTO maintenance (unit_id, reported_by, title, description, priority, cost_currency) VALUES (?, ?, ?, ?, ?, ?)')
      .run(unit.id, unit.tenant_id || null, form.title, form.description, form.priority, unit.currency).lastInsertRowid;
    db.prepare('INSERT INTO maintenance_notes (request_id, note, author) VALUES (?, ?, ?)').run(id, 'Logged by the office.', req.me.name);
    res.redirect(`/admin/maintenance/${id}`);
  });

  const requestPage = (res, id, status = 200, errors = []) => {
    const request = db.prepare(`${REQUEST_SELECT} WHERE m.id = ?`).get(id);
    if (!request) return notFound(res);
    return res.status(status).render('admin/maintenance-one', {
      title: request.title, request, errors, REQUEST_STATUSES, PRIORITIES, CURRENCIES,
      notes: db.prepare('SELECT * FROM maintenance_notes WHERE request_id = ? ORDER BY created_at DESC, id DESC').all(request.id),
    });
  };
  admin.get('/maintenance/:id', (req, res) => requestPage(res, intOrNull(req.params.id)));
  admin.post('/maintenance/:id', (req, res) => {
    const id = intOrNull(req.params.id);
    const request = db.prepare('SELECT * FROM maintenance WHERE id = ?').get(id);
    if (!request) return notFound(res);
    const status = oneOf(req.body.status, REQUEST_STATUSES, request.status);
    const cost = intOrNull(req.body.cost) ?? 0;
    const completedOn = isDate(req.body.completed_on) ? req.body.completed_on : request.completed_on || today(db);
    if (status === 'done' && completedOn > today(db)) return requestPage(res, id, 400, ['The completion date cannot be in the future.']);
    db.prepare(`UPDATE maintenance SET status = ?, priority = ?, contractor = ?, cost = ?, cost_currency = ?, charge_landlord = ?, completed_on = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, oneOf(req.body.priority, PRIORITIES, request.priority), clean(req.body.contractor, 100), cost, oneOf(req.body.cost_currency, CURRENCIES, 'GHS'), req.body.charge_landlord ? 1 : 0, status === 'done' ? completedOn : null, id);
    const text = [status !== request.status && `Status: ${LABELS[request.status]} → ${LABELS[status]}.`, clean(req.body.note, 1000)].filter(Boolean).join(' ');
    if (text) db.prepare('INSERT INTO maintenance_notes (request_id, note, author) VALUES (?, ?, ?)').run(id, text, req.me.name);
    res.redirect(`/admin/maintenance/${id}`);
  });

  // Inspections
  const inspectionForm = (res, status = 200, errors = [], form = {}) => res.status(status).render('admin/inspection-new', {
    title: 'Record an inspection', errors, form, AREAS, CONDITIONS, INSPECTION_KINDS, units: db.prepare(`${UNIT_SELECT} ORDER BY p.name, un.label`).all(),
  });
  admin.get('/inspections', (req, res) => {
    const inspections = db.prepare(`SELECT i.*, un.label, p.name AS property_name,
      (SELECT COUNT(*) FROM inspection_items it WHERE it.inspection_id = i.id AND it.condition = 'poor') AS poor,
      (SELECT COUNT(*) FROM inspection_items it WHERE it.inspection_id = i.id AND it.condition = 'fair') AS fair
      FROM inspections i JOIN units un ON un.id = i.unit_id JOIN properties p ON p.id = un.property_id ORDER BY i.inspected_on DESC, i.id DESC LIMIT 100`).all();
    res.render('admin/inspections', { title: 'Inspections', inspections });
  });
  admin.get('/inspections/new', (req, res) => inspectionForm(res, 200, [], { unit_id: intOrNull(req.query.unit), inspected_on: today(db), kind: 'routine' }));
  admin.post('/inspections', (req, res) => {
    const form = { unit_id: intOrNull(req.body.unit_id), inspected_on: clean(req.body.inspected_on, 10), kind: oneOf(req.body.kind, INSPECTION_KINDS, 'routine'), summary: clean(req.body.summary, 2000) };
    const errors = [];
    if (!db.prepare('SELECT 1 FROM units WHERE id = ?').get(form.unit_id)) errors.push('Choose the unit.');
    if (!isDate(form.inspected_on) || form.inspected_on > today(db)) errors.push('Enter the inspection date (today or earlier).');
    if (errors.length) return inspectionForm(res, 400, errors, form);
    const id = Number(db.prepare('INSERT INTO inspections (unit_id, inspected_on, kind, inspector, summary) VALUES (?, ?, ?, ?, ?)').run(form.unit_id, form.inspected_on, form.kind, req.me.name, form.summary).lastInsertRowid);
    AREAS.forEach((area, i) => db.prepare('INSERT INTO inspection_items (inspection_id, area, condition, note) VALUES (?, ?, ?, ?)')
      .run(id, area, oneOf(req.body[`cond_${i}`], CONDITIONS, 'good'), clean(req.body[`note_${i}`], 300)));
    res.redirect(`/admin/inspections/${id}`);
  });
  const getInspection = (id) => {
    const inspection = db.prepare(`SELECT i.*, un.label, p.name AS property_name, p.landlord_id FROM inspections i JOIN units un ON un.id = i.unit_id JOIN properties p ON p.id = un.property_id WHERE i.id = ?`).get(id);
    return inspection && { inspection, items: db.prepare('SELECT * FROM inspection_items WHERE inspection_id = ? ORDER BY id').all(id) };
  };
  admin.get('/inspections/:id', (req, res) => {
    const found = getInspection(intOrNull(req.params.id));
    return found ? res.render('admin/inspection', { title: 'Inspection', ...found, back: '/admin/inspections' }) : notFound(res);
  });

  // Viewing requests
  admin.get('/viewings', (req, res) => {
    const viewings = db.prepare(`SELECT v.*, un.label, un.asking_rent, un.currency, p.name AS property_name FROM viewings v JOIN units un ON un.id = v.unit_id
      JOIN properties p ON p.id = un.property_id ORDER BY (v.status IN ('requested', 'confirmed')) DESC, v.preferred_date, v.created_at DESC`).all();
    res.render('admin/viewings', { title: 'Viewing requests', viewings, VIEWING_STATUSES });
  });
  admin.post('/viewings/:id', (req, res) => {
    const id = intOrNull(req.params.id);
    const v = db.prepare('SELECT * FROM viewings WHERE id = ?').get(id);
    if (!v) return notFound(res);
    db.prepare('UPDATE viewings SET status = ?, preferred_date = ?, notes = ? WHERE id = ?')
      .run(oneOf(req.body.status, VIEWING_STATUSES, v.status), isDate(req.body.preferred_date) ? req.body.preferred_date : v.preferred_date, clean(req.body.notes, 500), id);
    res.redirect('/admin/viewings');
  });

  // Owner statements
  const periodOptions = () => { const now = today(db).slice(0, 7); return Array.from({ length: 12 }, (_, i) => addMonths(now, -i)); };
  admin.get('/statements', (req, res) => {
    const list = landlords();
    const landlord = list.find((l) => l.id === intOrNull(req.query.landlord)) || list[0];
    const period = isPeriod(req.query.period) ? req.query.period : addMonths(today(db).slice(0, 7), -1);
    res.render('admin/statements', { title: 'Owner statements', landlords: list, landlord, period, periods: periodOptions(), data: landlord ? statement(db, landlord.id, period) : null });
  });

  app.use('/admin', auth, only('manager'), admin);

  // ---------- Landlord and tenant portal ----------

  const portal = express.Router();
  portal.use((req, res, next) => (req.me.role === 'manager' ? res.redirect('/admin') : next()));

  const tenantView = (res, me, status = 200, errors = [], form = {}) => {
    ensureCharges(db);
    const tenancy = db.prepare(`${TENANCY_SELECT} WHERE t.tenant_id = ? ORDER BY (t.status = 'active') DESC, t.start_date DESC LIMIT 1`).get(me.id);
    return res.status(status).render('portal/tenant', {
      title: 'My tenancy', tenancy, l: tenancy ? ledger(db, tenancy.id) : null, errors, form, PRIORITIES,
      requests: db.prepare(`${REQUEST_SELECT} WHERE m.reported_by = ? ORDER BY m.created_at DESC`).all(me.id),
    });
  };

  portal.get('/', (req, res) => {
    if (req.me.role === 'tenant') return tenantView(res, req.me);
    ensureCharges(db);
    const tenancies = portfolio(req.me.id);
    const properties = db.prepare('SELECT * FROM properties WHERE landlord_id = ? ORDER BY name').all(req.me.id).map((p) => {
      const units = db.prepare(`${UNIT_SELECT} WHERE un.property_id = ? ORDER BY un.label`).all(p.id).map((u) => ({ ...u, l: u.tenancy_id ? ledger(db, u.tenancy_id) : null }));
      return { ...p, units };
    });
    res.render('portal/landlord', {
      title: 'My properties', properties, arrears: totalsByCurrency(tenancies, (t) => t.l.overdue), occupied: tenancies.length,
      units: properties.reduce((n, p) => n + p.units.length, 0),
      requests: db.prepare(`${REQUEST_SELECT} WHERE p.landlord_id = ? AND m.status IN ('open', 'scheduled', 'in_progress') ORDER BY m.created_at DESC`).all(req.me.id),
    });
  });

  portal.get('/properties/:id', only('landlord'), (req, res) => {
    const property = db.prepare('SELECT * FROM properties WHERE id = ? AND landlord_id = ?').get(intOrNull(req.params.id), req.me.id);
    if (!property) return notFound(res);
    ensureCharges(db);
    res.render('portal/property', {
      title: property.name, property,
      units: db.prepare(`${UNIT_SELECT} WHERE un.property_id = ? ORDER BY un.label`).all(property.id).map((u) => ({ ...u, l: u.tenancy_id ? ledger(db, u.tenancy_id) : null,
        lastInspection: db.prepare('SELECT id, inspected_on FROM inspections WHERE unit_id = ? ORDER BY inspected_on DESC LIMIT 1').get(u.id) })),
      requests: db.prepare(`${REQUEST_SELECT} WHERE un.property_id = ? ORDER BY m.created_at DESC LIMIT 10`).all(property.id),
    });
  });

  portal.get('/statements', only('landlord'), (req, res) => {
    const period = isPeriod(req.query.period) ? req.query.period : addMonths(today(db).slice(0, 7), -1);
    res.render('portal/statements', { title: 'Statements', landlord: req.me, period, periods: periodOptions(), data: statement(db, req.me.id, period) });
  });

  portal.get('/inspections/:id', only('landlord'), (req, res) => {
    const found = getInspection(intOrNull(req.params.id));
    return found && found.inspection.landlord_id === req.me.id ? res.render('admin/inspection', { title: 'Inspection', ...found, back: '/portal' }) : notFound(res);
  });

  // A landlord sees repairs on their own properties; a tenant sees only the ones they reported.
  portal.get('/maintenance/:id', (req, res) => {
    const request = db.prepare(`${REQUEST_SELECT} WHERE m.id = ?`).get(intOrNull(req.params.id));
    const allowed = request && (req.me.role === 'landlord' ? request.landlord_id === req.me.id : request.reported_by === req.me.id);
    if (!allowed) return notFound(res);
    res.render('portal/request', { title: request.title, request, notes: db.prepare('SELECT * FROM maintenance_notes WHERE request_id = ? ORDER BY created_at DESC, id DESC').all(request.id) });
  });

  portal.post('/maintenance', only('tenant'), (req, res) => {
    const tenancy = db.prepare("SELECT t.*, un.currency AS unit_currency FROM tenancies t JOIN units un ON un.id = t.unit_id WHERE t.tenant_id = ? AND t.status = 'active'").get(req.me.id);
    const form = { title: clean(req.body.title, 120), description: clean(req.body.description, 2000), priority: oneOf(req.body.priority, PRIORITIES, 'normal') };
    const errors = [];
    if (!tenancy) errors.push('You do not have an active tenancy to report a problem for.');
    if (form.title.length < 3) errors.push('Describe the problem in a few words.');
    if (errors.length) return tenantView(res, req.me, 400, errors, form);
    const id = db.prepare('INSERT INTO maintenance (unit_id, reported_by, title, description, priority, cost_currency) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tenancy.unit_id, req.me.id, form.title, form.description, form.priority, tenancy.unit_currency).lastInsertRowid;
    db.prepare('INSERT INTO maintenance_notes (request_id, note, author) VALUES (?, ?, ?)').run(id, 'Reported by the tenant through the portal.', req.me.name);
    res.redirect(`/portal/maintenance/${id}`);
  });

  app.use('/portal', auth, portal);

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
    if (!process.env.ADMIN_PASSWORD) console.log('Demo logins: admin / admin123 (manager), kboateng or asarpong / demo-pass-1 (landlords), ama, kojo, efua, yaw, nana, linda / demo-pass-1 (tenants).');
  });
}

module.exports = { createApp };
