const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  openDb, verifyPassword, createSale, syncPlotStatus, SALE_SELECT,
  PLOT_STATUSES, DEMARCATION, SOURCES, ENQUIRY_STATUSES, OPEN_STATUSES, PAYMENT_METHODS,
} = require('./src/db');
const { seed } = require('./src/seed');
const { sessionMiddleware } = require('./src/session');
const { icon, initials } = require('./src/ui');
const { layout } = require('./src/siteplan');

const LABELS = {
  available: 'Available', reserved: 'Reserved', sold: 'Sold',
  not_started: 'Not yet surveyed', surveyed: 'Surveyed', pillared: 'Pillars set', handed_over: 'Handed over to owner',
  new: 'New', contacted: 'Contacted', site_visit: 'Site visit booked', negotiating: 'Negotiating', won: 'Reserved / bought', lost: 'Lost',
  website: 'Website', whatsapp: 'WhatsApp', phone: 'Phone', 'walk-in': 'Walk-in', social: 'Social media', referral: 'Referral',
  active: 'Active', cancelled: 'Cancelled',
};

const PLOT_PHOTOS = ['ld-site', 'ld-plot-grass', 'ld-suburb', 'ld-newbuild', 'ld-suburb2', 'ld-estate-aerial'];
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const marks = (list) => list.map(() => '?').join(',');
// Stops spreadsheet programs treating a cell as a formula.
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production');
  }

  const site = {
    name: env.SITE_NAME || 'CBC Properties',
    phone: env.SITE_PHONE || '+233 00 000 0000',
    email: env.SITE_EMAIL || 'sales@example.com',
    address: env.SITE_ADDRESS || 'Accra, Ghana',
    currency: env.CURRENCY_SYMBOL || 'GH₵',
    demo: env.DEMO_BANNER !== 'off',
    temporary: (options.dbPath || env.DB_PATH) === ':memory:', // serverless demo: data is not kept
  };
  site.whatsapp = (env.SITE_WHATSAPP || site.phone).replace(/\D/g, '');

  const db = openDb(options.dbPath || env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
  seed(db, { adminUser: env.ADMIN_USER || 'admin', adminPassword: env.ADMIN_PASSWORD || 'admin123' });
  const today = () => db.prepare("SELECT date('now') AS d").get().d;

  const app = express();
  app.locals.db = db;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(sessionMiddleware(env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), production));

  app.use((req, res, next) => {
    Object.assign(res.locals, {
      site, icon, initials, label: (k) => LABELS[k] || k,
      thumb: (url) => String(url || '').replace(/-lg\.jpg$/, '-md.jpg'),
      photo: (e) => (e && e.image_url) || (e && e.estate_image) || '/img/ld-site-lg.jpg',
      // Plots have no photos of their own; vary the placeholder so a list does not repeat one image.
      plotPhoto: (p) => `/img/${PLOT_PHOTOS[p.id % PLOT_PHOTOS.length]}-lg.jpg`,
      session: req.session, path: req.path,
      money: (amount) => `${site.currency}${Number(amount || 0).toLocaleString('en-US')}`,
      waLink: (text) => `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(text)}`,
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

  const PLOT_SELECT = 'SELECT p.*, e.name AS estate_name, e.location AS estate_location, e.code AS estate_code, e.image_url AS estate_image FROM plots p JOIN estates e ON e.id = p.estate_id';
  const allEstates = () => db.prepare('SELECT * FROM estates ORDER BY name').all();
  const getPlot = (id) => db.prepare(`${PLOT_SELECT} WHERE p.id = ?`).get(intOrNull(id));
  const getSale = (id) => db.prepare(`${SALE_SELECT} WHERE s.id = ?`).get(intOrNull(id));

  // ---------- Public site ----------

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  app.get('/', (req, res) => {
    const estates = db.prepare(`SELECT e.*, COUNT(p.id) AS total, COALESCE(SUM(p.status = 'available'), 0) AS available,
      MIN(CASE WHEN p.status = 'available' THEN p.price END) AS from_price
      FROM estates e LEFT JOIN plots p ON p.estate_id = e.id GROUP BY e.id ORDER BY e.name`).all();
    const stats = db.prepare(`SELECT COUNT(*) AS plots, COALESCE(SUM(status = 'available'), 0) AS available,
      MIN(CASE WHEN status = 'available' THEN price END) AS from_price FROM plots`).get();
    res.render('home', { title: site.name, estates, stats });
  });

  app.get('/plots', (req, res) => {
    const f = {
      q: clean(req.query.q, 80),
      estate: intOrNull(req.query.estate),
      status: oneOf(req.query.status, PLOT_STATUSES, ''),
      minSize: intOrNull(req.query.min_size),
      maxPrice: intOrNull(req.query.max_price),
    };
    const where = ['1 = 1'];
    const params = [];
    const add = (sql, ...p) => { where.push(sql); params.push(...p); };
    if (f.q) add('(p.ref LIKE ? OR e.name LIKE ? OR e.location LIKE ? OR p.dimensions LIKE ?)', ...Array(4).fill(`%${f.q}%`));
    if (f.estate !== null) add('p.estate_id = ?', f.estate);
    if (f.status) add('p.status = ?', f.status);
    if (f.minSize !== null) add('p.size_sqm >= ?', f.minSize);
    if (f.maxPrice !== null) add('p.price <= ?', f.maxPrice);
    const plots = db.prepare(`${PLOT_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE p.status WHEN 'available' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END, p.ref`).all(...params);
    res.render('plots', { title: 'Plots', plots, f, estates: allEstates(), PLOT_STATUSES });
  });

  const estatePlan = (estateId) => layout(db.prepare('SELECT * FROM plots WHERE estate_id = ? ORDER BY plot_no').all(estateId));
  const plotExtras = (plot) => ({ plan: estatePlan(plot.estate_id), neighbours: db.prepare(`${PLOT_SELECT} WHERE p.estate_id = ? AND p.id != ? AND p.status = 'available' ORDER BY p.ref LIMIT 3`).all(plot.estate_id, plot.id) });

  app.get('/estates/:id', (req, res, next) => {
    const estate = db.prepare(`SELECT e.*, COUNT(p.id) AS total, COALESCE(SUM(p.status = 'available'), 0) AS available,
      MIN(CASE WHEN p.status = 'available' THEN p.price END) AS from_price
      FROM estates e LEFT JOIN plots p ON p.estate_id = e.id WHERE e.id = ? GROUP BY e.id`).get(intOrNull(req.params.id));
    if (!estate) return next();
    const plots = db.prepare(`${PLOT_SELECT} WHERE p.estate_id = ? ORDER BY p.plot_no`).all(estate.id);
    res.render('estate', { title: estate.name, estate, plots, plan: layout(plots), errors: [], form: {} });
  });

  app.get('/plots/:id', (req, res, next) => {
    const plot = getPlot(req.params.id);
    if (!plot) return next();
    res.render('plot', { title: `Plot ${plot.ref}`, plot, errors: [], form: {}, ...plotExtras(plot) });
  });

  app.get('/contact', (req, res) => res.render('contact', { title: 'Contact us', errors: [], form: {} }));

  app.post('/enquiries', limit(5, 10 * 60 * 1000), (req, res) => {
    const plot = getPlot(req.body.plot_id);
    const form = {
      name: clean(req.body.name, 100), phone: clean(req.body.phone, 30),
      email: clean(req.body.email, 120), message: clean(req.body.message, 2000),
    };
    if (clean(req.body.website)) return res.redirect('/enquiries/thanks'); // honeypot

    const errors = [];
    if (form.name.length < 2) errors.push('Please enter your name.');
    if (!form.phone && !form.email) errors.push('Please give a phone number or an email address so we can reply.');
    if (form.phone && !/^[+\d][\d\s()-]{6,}$/.test(form.phone)) errors.push('That phone number does not look right.');
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('That email address does not look right.');
    if (errors.length) {
      return res.status(400).render(plot ? 'plot' : 'contact', { title: plot ? `Plot ${plot.ref}` : 'Contact us', plot, errors, form, ...(plot ? plotExtras(plot) : {}) });
    }
    db.prepare("INSERT INTO enquiries (plot_id, name, phone, email, message, source, next_follow_up) VALUES (?, ?, ?, ?, ?, 'website', date('now'))")
      .run(plot ? plot.id : null, form.name, form.phone, form.email, form.message);
    res.redirect('/enquiries/thanks');
  });

  app.get('/enquiries/thanks', (req, res) => {
    res.render('message', { title: 'Thank you', body: 'We have received your enquiry and a member of our team will contact you shortly.' });
  });

  // ---------- Staff area ----------

  app.get('/admin/login', (req, res) => {
    if (req.session) return res.redirect('/admin');
    res.render('admin/login', { title: 'Staff sign in', error: null });
  });

  app.post('/admin/login', limit(8, 10 * 60 * 1000), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(clean(req.body.username, 60));
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).render('admin/login', { title: 'Staff sign in', error: 'Wrong username or password.' });
    }
    res.startSession(user.username);
    res.redirect('/admin');
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!req.session) return res.redirect('/admin/login');
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
      return res.status(403).render('message', { title: 'Session expired', body: 'Please go back, refresh the page and try again.' });
    }
    res.locals.csrf = req.session.csrf;
    res.set('Cache-Control', 'no-store');
    next();
  });

  admin.post('/logout', (req, res) => { res.endSession(); res.redirect('/'); });

  // Reservations whose hold date has passed without the agreement being signed.
  const LAPSED = `s.status = 'active' AND s.reservation_expires < date('now')
    AND EXISTS (SELECT 1 FROM milestones m WHERE m.sale_id = s.id AND m.position = 3 AND m.done_on IS NULL)`;

  admin.get('/', (req, res) => {
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    const totals = db.prepare(`SELECT COALESCE(SUM(agreed_price), 0) AS value,
      COALESCE(SUM((SELECT SUM(amount) FROM payments WHERE sale_id = s.id)), 0) AS paid FROM sales s WHERE status = 'active'`).get();
    const stats = {
      available: count("SELECT COUNT(*) AS n FROM plots WHERE status = 'available'"),
      newEnquiries: count("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'"),
      due: count(`SELECT COUNT(*) AS n FROM enquiries WHERE status IN (${marks(OPEN_STATUSES)}) AND next_follow_up <= date('now')`, ...OPEN_STATUSES),
      activeSales: count("SELECT COUNT(*) AS n FROM sales WHERE status = 'active'"),
      outstanding: totals.value - totals.paid,
      lapsed: count(`SELECT COUNT(*) AS n FROM sales s WHERE ${LAPSED}`),
    };
    const due = db.prepare(`SELECT e.*, p.ref FROM enquiries e LEFT JOIN plots p ON p.id = e.plot_id
      WHERE e.status IN (${marks(OPEN_STATUSES)}) AND e.next_follow_up <= date('now') ORDER BY e.next_follow_up LIMIT 10`).all(...OPEN_STATUSES);
    const lapsed = db.prepare(`${SALE_SELECT} WHERE ${LAPSED} ORDER BY s.reservation_expires`).all();
    res.render('admin/dashboard', { title: 'Dashboard', stats, due, lapsed });
  });

  // Estates
  admin.get('/estates', (req, res) => {
    const estates = db.prepare('SELECT e.*, (SELECT COUNT(*) FROM plots WHERE estate_id = e.id) AS plots FROM estates e ORDER BY e.name').all();
    res.render('admin/estates', { title: 'Estates', estates, errors: [] });
  });

  admin.post('/estates', (req, res) => {
    const e = { code: clean(req.body.code, 6).toUpperCase(), name: clean(req.body.name, 80), location: clean(req.body.location, 80), description: clean(req.body.description, 1000) };
    const errors = [];
    if (!/^[A-Z]{2,6}$/.test(e.code)) errors.push('The code must be 2 to 6 letters, for example OYH.');
    if (e.name.length < 2) errors.push('Enter the estate name.');
    if (!e.location) errors.push('Enter the location.');
    if (!errors.length && db.prepare('SELECT 1 FROM estates WHERE code = ?').get(e.code)) errors.push('That code is already used by another estate.');
    if (errors.length) {
      const estates = db.prepare('SELECT e.*, (SELECT COUNT(*) FROM plots WHERE estate_id = e.id) AS plots FROM estates e ORDER BY e.name').all();
      return res.status(400).render('admin/estates', { title: 'Estates', estates, errors });
    }
    db.prepare('INSERT INTO estates (code, name, location, description) VALUES (?, ?, ?, ?)').run(e.code, e.name, e.location, e.description);
    res.redirect('/admin/estates');
  });

  // Plots
  admin.get('/plots', (req, res) => {
    const f = { estate: intOrNull(req.query.estate), status: oneOf(req.query.status, PLOT_STATUSES, '') };
    const where = ['1 = 1'];
    const params = [];
    if (f.estate !== null) { where.push('p.estate_id = ?'); params.push(f.estate); }
    if (f.status) { where.push('p.status = ?'); params.push(f.status); }
    const plots = db.prepare(`SELECT p.*, e.name AS estate_name,
      (SELECT s.id FROM sales s WHERE s.plot_id = p.id AND s.status = 'active') AS sale_id,
      (SELECT s.customer_name FROM sales s WHERE s.plot_id = p.id AND s.status = 'active') AS customer
      FROM plots p JOIN estates e ON e.id = p.estate_id WHERE ${where.join(' AND ')} ORDER BY p.ref`).all(...params);
    res.render('admin/plots', { title: 'Plots', plots, f, estates: allEstates(), PLOT_STATUSES });
  });

  const plotForm = (res, plot, errors = [], status = 200) => res.status(status).render('admin/plot-form', {
    title: plot.id ? `Edit plot ${plot.ref}` : 'New plot', plot, errors, estates: allEstates(), DEMARCATION,
  });

  function readPlot(body) {
    const p = {
      estate_id: intOrNull(body.estate_id), plot_no: clean(body.plot_no, 10), dimensions: clean(body.dimensions, 40),
      size_sqm: intOrNull(body.size_sqm), price: intOrNull(body.price),
      demarcation: oneOf(body.demarcation, DEMARCATION, 'not_started'), notes: clean(body.notes, 2000),
    };
    const errors = [];
    const estate = db.prepare('SELECT * FROM estates WHERE id = ?').get(p.estate_id);
    if (!estate) errors.push('Choose an estate.');
    if (!/^[A-Za-z0-9]{1,10}$/.test(p.plot_no)) errors.push('Enter the plot number using letters and digits only, for example 08 or 12A.');
    if (p.price === null) errors.push('Enter the price as a whole number.');
    if (estate) p.ref = `${estate.code}-${p.plot_no.toUpperCase()}`;
    return { p, errors };
  }

  admin.get('/plots/new', (req, res) => plotForm(res, { estate_id: intOrNull(req.query.estate), demarcation: 'not_started' }));

  admin.post('/plots', (req, res) => {
    const { p, errors } = readPlot(req.body);
    if (!errors.length && db.prepare('SELECT 1 FROM plots WHERE ref = ?').get(p.ref)) errors.push(`Plot ${p.ref} already exists.`);
    if (errors.length) return plotForm(res, p, errors, 400);
    db.prepare('INSERT INTO plots (estate_id, plot_no, ref, dimensions, size_sqm, price, demarcation, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.estate_id, p.plot_no.toUpperCase(), p.ref, p.dimensions, p.size_sqm, p.price, p.demarcation, p.notes);
    res.redirect('/admin/plots');
  });

  admin.get('/plots/:id/edit', (req, res, next) => {
    const plot = getPlot(req.params.id);
    if (!plot) return next();
    plotForm(res, plot);
  });

  admin.post('/plots/:id', (req, res, next) => {
    const existing = getPlot(req.params.id);
    if (!existing) return next();
    const { p, errors } = readPlot(req.body);
    if (!errors.length && db.prepare('SELECT 1 FROM plots WHERE ref = ? AND id != ?').get(p.ref, existing.id)) errors.push(`Plot ${p.ref} already exists.`);
    if (errors.length) return plotForm(res, { ...p, id: existing.id, ref: existing.ref }, errors, 400);
    db.prepare('UPDATE plots SET estate_id = ?, plot_no = ?, ref = ?, dimensions = ?, size_sqm = ?, price = ?, demarcation = ?, notes = ? WHERE id = ?')
      .run(p.estate_id, p.plot_no.toUpperCase(), p.ref, p.dimensions, p.size_sqm, p.price, p.demarcation, p.notes, existing.id);
    res.redirect('/admin/plots');
  });

  admin.post('/plots/:id/delete', (req, res, next) => {
    const plot = getPlot(req.params.id);
    if (!plot) return next();
    if (db.prepare('SELECT 1 FROM sales WHERE plot_id = ?').get(plot.id)) {
      return plotForm(res, plot, ['This plot has a sale or reservation on record, so it cannot be deleted.'], 400);
    }
    db.prepare('DELETE FROM plots WHERE id = ?').run(plot.id);
    res.redirect('/admin/plots');
  });

  // Enquiries
  admin.get('/enquiries', (req, res) => {
    const f = {
      status: oneOf(req.query.status, [...ENQUIRY_STATUSES, 'open'], ''),
      source: oneOf(req.query.source, SOURCES, ''),
      due: req.query.due === '1',
    };
    const where = ['1 = 1'];
    const params = [];
    if (f.status === 'open' || f.due) { where.push(`e.status IN (${marks(OPEN_STATUSES)})`); params.push(...OPEN_STATUSES); }
    else if (f.status) { where.push('e.status = ?'); params.push(f.status); }
    if (f.source) { where.push('e.source = ?'); params.push(f.source); }
    if (f.due) where.push("e.next_follow_up <= date('now')");
    const enquiries = db.prepare(`SELECT e.*, p.ref FROM enquiries e LEFT JOIN plots p ON p.id = e.plot_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC`).all(...params);
    res.render('admin/enquiries', { title: 'Enquiries', enquiries, f, today: today(), ENQUIRY_STATUSES, SOURCES });
  });

  const enquiryFormData = () => ({ plots: db.prepare('SELECT id, ref FROM plots ORDER BY ref').all(), SOURCES });

  admin.get('/enquiries/new', (req, res) => {
    res.render('admin/enquiry-new', { title: 'Log an enquiry', errors: [], form: { source: 'phone' }, ...enquiryFormData() });
  });

  admin.post('/enquiries', (req, res) => {
    const form = {
      name: clean(req.body.name, 100), phone: clean(req.body.phone, 30), email: clean(req.body.email, 120),
      message: clean(req.body.message, 2000), source: oneOf(req.body.source, SOURCES, 'phone'),
      plot_id: intOrNull(req.body.plot_id), assigned_to: clean(req.body.assigned_to, 60),
      next_follow_up: isDate(req.body.next_follow_up) ? req.body.next_follow_up : null,
    };
    const errors = [];
    if (form.name.length < 2) errors.push('Enter the customer’s name.');
    if (!form.phone && !form.email) errors.push('Enter a phone number or an email address.');
    if (errors.length) return res.status(400).render('admin/enquiry-new', { title: 'Log an enquiry', errors, form, ...enquiryFormData() });
    const plot = getPlot(form.plot_id);
    const result = db.prepare(`INSERT INTO enquiries (plot_id, name, phone, email, message, source, assigned_to, next_follow_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plot ? plot.id : null, form.name, form.phone, form.email, form.message, form.source, form.assigned_to, form.next_follow_up);
    res.redirect(`/admin/enquiries/${result.lastInsertRowid}`);
  });

  admin.get('/enquiries/:id', (req, res, next) => {
    const enquiry = db.prepare(`SELECT e.*, p.ref, p.status AS plot_status FROM enquiries e LEFT JOIN plots p ON p.id = e.plot_id WHERE e.id = ?`).get(intOrNull(req.params.id));
    if (!enquiry) return next();
    const notes = db.prepare('SELECT * FROM enquiry_notes WHERE enquiry_id = ? ORDER BY created_at DESC, id DESC').all(enquiry.id);
    const sale = db.prepare('SELECT id FROM sales WHERE enquiry_id = ?').get(enquiry.id);
    res.render('admin/enquiry', { title: `Enquiry from ${enquiry.name}`, enquiry, notes, sale, ENQUIRY_STATUSES });
  });

  admin.post('/enquiries/:id', (req, res, next) => {
    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(intOrNull(req.params.id));
    if (!enquiry) return next();
    const status = oneOf(req.body.status, ENQUIRY_STATUSES, enquiry.status);
    const followUp = OPEN_STATUSES.includes(status) && isDate(req.body.next_follow_up) ? req.body.next_follow_up : null;
    db.prepare("UPDATE enquiries SET status = ?, assigned_to = ?, next_follow_up = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, clean(req.body.assigned_to, 60), followUp, enquiry.id);
    const note = clean(req.body.note, 2000);
    const changed = status !== enquiry.status ? `Status: ${LABELS[enquiry.status]} → ${LABELS[status]}. ` : '';
    if (note || changed) {
      db.prepare('INSERT INTO enquiry_notes (enquiry_id, note, author) VALUES (?, ?, ?)').run(enquiry.id, `${changed}${note}`.trim(), req.session.user);
    }
    res.redirect(`/admin/enquiries/${enquiry.id}`);
  });

  // Sales and reservations
  admin.get('/sales', (req, res) => {
    const f = { view: oneOf(req.query.view, ['active', 'owing', 'lapsed', 'completed', 'cancelled'], 'active') };
    const where = {
      active: "s.status = 'active'",
      owing: "s.status = 'active' AND COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) < s.agreed_price",
      lapsed: LAPSED,
      completed: "s.status = 'active' AND NOT EXISTS (SELECT 1 FROM milestones m WHERE m.sale_id = s.id AND m.done_on IS NULL)",
      cancelled: "s.status = 'cancelled'",
    }[f.view];
    const sales = db.prepare(`${SALE_SELECT} WHERE ${where} ORDER BY s.created_at DESC, s.id DESC`).all();
    res.render('admin/sales', { title: 'Sales and reservations', sales, f, today: today() });
  });

  const saleFormData = (selectedPlotId) => ({
    plots: db.prepare("SELECT id, ref, price FROM plots WHERE status = 'available' OR id = ? ORDER BY ref").all(selectedPlotId ?? -1),
  });

  admin.get('/sales/new', (req, res) => {
    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(intOrNull(req.query.enquiry));
    const plot = getPlot(req.query.plot ?? (enquiry && enquiry.plot_id));
    const usable = plot && plot.status === 'available' ? plot : null;
    const form = {
      enquiry_id: enquiry ? enquiry.id : null, plot_id: usable ? usable.id : null,
      customer_name: enquiry ? enquiry.name : '', phone: enquiry ? enquiry.phone : '', email: enquiry ? enquiry.email : '',
      agreed_price: usable ? usable.price : '', handled_by: enquiry ? enquiry.assigned_to : '',
      reservation_expires: db.prepare("SELECT date('now', '+14 days') AS d").get().d,
    };
    res.render('admin/sale-new', { title: 'New reservation', errors: [], form, ...saleFormData(form.plot_id) });
  });

  admin.post('/sales', (req, res) => {
    const form = {
      enquiry_id: intOrNull(req.body.enquiry_id), plot_id: intOrNull(req.body.plot_id),
      customer_name: clean(req.body.customer_name, 100), phone: clean(req.body.phone, 30), email: clean(req.body.email, 120),
      agreed_price: intOrNull(req.body.agreed_price), handled_by: clean(req.body.handled_by, 60),
      reservation_expires: isDate(req.body.reservation_expires) ? req.body.reservation_expires : null,
    };
    const errors = [];
    const plot = getPlot(form.plot_id);
    if (!plot) errors.push('Choose a plot.');
    else if (plot.status !== 'available') errors.push(`Plot ${plot.ref} is already ${LABELS[plot.status].toLowerCase()}.`);
    if (form.customer_name.length < 2) errors.push('Enter the customer’s name.');
    if (!form.phone && !form.email) errors.push('Enter a phone number or an email address.');
    if (!form.agreed_price) errors.push('Enter the agreed price as a whole number.');
    if (errors.length) return res.status(400).render('admin/sale-new', { title: 'New reservation', errors, form, ...saleFormData(form.plot_id) });

    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(form.enquiry_id);
    const id = createSale(db, { ...form, enquiry_id: enquiry ? enquiry.id : null });
    if (enquiry) {
      db.prepare("UPDATE enquiries SET status = 'won', next_follow_up = NULL, updated_at = datetime('now') WHERE id = ?").run(enquiry.id);
      db.prepare('INSERT INTO enquiry_notes (enquiry_id, note, author) VALUES (?, ?, ?)').run(enquiry.id, `Plot ${plot.ref} reserved.`, req.session.user);
    }
    res.redirect(`/admin/sales/${id}`);
  });

  const renderSale = (res, sale, errors = [], status = 200) => res.status(status).render('admin/sale', {
    title: `${sale.customer_name} – plot ${sale.ref}`, sale, errors, today: today(), PAYMENT_METHODS,
    payments: db.prepare('SELECT * FROM payments WHERE sale_id = ? ORDER BY paid_on, id').all(sale.id),
    milestones: db.prepare('SELECT * FROM milestones WHERE sale_id = ? ORDER BY position').all(sale.id),
  });

  admin.get('/sales/:id', (req, res, next) => {
    const sale = getSale(req.params.id);
    if (!sale) return next();
    renderSale(res, sale);
  });

  // Every change to a sale goes through here so cancelled sales stay read-only.
  const withActiveSale = (handler) => (req, res, next) => {
    const sale = getSale(req.params.id);
    if (!sale) return next();
    if (sale.status !== 'active') return renderSale(res, sale, ['This sale was cancelled and can no longer be changed.'], 400);
    return handler(req, res, sale);
  };

  admin.post('/sales/:id/payments', withActiveSale((req, res, sale) => {
    const amount = intOrNull(req.body.amount);
    const paidOn = isDate(req.body.paid_on) ? req.body.paid_on : null;
    const errors = [];
    if (!amount) errors.push('Enter the amount received as a whole number.');
    if (!paidOn) errors.push('Enter the date the payment was received.');
    else if (paidOn > today()) errors.push('The payment date cannot be in the future.');
    if (amount && sale.paid + amount > sale.agreed_price) errors.push(`That is more than the balance of ${res.locals.money(sale.agreed_price - sale.paid)}.`);
    if (errors.length) return renderSale(res, sale, errors, 400);
    db.prepare('INSERT INTO payments (sale_id, amount, paid_on, method, reference) VALUES (?, ?, ?, ?, ?)')
      .run(sale.id, amount, paidOn, oneOf(req.body.method, PAYMENT_METHODS, 'bank transfer'), clean(req.body.reference, 60));
    syncPlotStatus(db, sale.plot_id);
    res.redirect(`/admin/sales/${sale.id}`);
  }));

  admin.post('/sales/:id/payments/:pid/delete', withActiveSale((req, res, sale) => {
    db.prepare('DELETE FROM payments WHERE id = ? AND sale_id = ?').run(intOrNull(req.params.pid), sale.id);
    syncPlotStatus(db, sale.plot_id);
    res.redirect(`/admin/sales/${sale.id}`);
  }));

  admin.post('/sales/:id/milestones/:mid', withActiveSale((req, res, sale) => {
    const undo = req.body.action === 'undo';
    const doneOn = isDate(req.body.done_on) ? req.body.done_on : today();
    if (!undo && doneOn > today()) return renderSale(res, sale, ['A step cannot be completed on a future date.'], 400);
    db.prepare('UPDATE milestones SET done_on = ?, note = ?, done_by = ? WHERE id = ? AND sale_id = ?')
      .run(undo ? null : doneOn, undo ? '' : clean(req.body.note, 300), undo ? '' : req.session.user, intOrNull(req.params.mid), sale.id);
    res.redirect(`/admin/sales/${sale.id}`);
  }));

  admin.post('/sales/:id/cancel', withActiveSale((req, res, sale) => {
    const reason = clean(req.body.reason, 300);
    if (reason.length < 3) return renderSale(res, sale, ['Give a reason for cancelling.'], 400);
    db.prepare("UPDATE sales SET status = 'cancelled', cancelled_reason = ? WHERE id = ?").run(reason, sale.id);
    syncPlotStatus(db, sale.plot_id);
    res.redirect(`/admin/sales/${sale.id}`);
  }));

  // Reports
  const reportData = () => ({
    estates: db.prepare(`SELECT e.name, COUNT(p.id) AS total,
      COALESCE(SUM(p.status = 'available'), 0) AS available, COALESCE(SUM(p.status = 'reserved'), 0) AS reserved, COALESCE(SUM(p.status = 'sold'), 0) AS sold,
      COALESCE(SUM(CASE WHEN p.status = 'available' THEN p.price END), 0) AS unsold_value,
      COALESCE((SELECT SUM(s.agreed_price) FROM sales s JOIN plots sp ON sp.id = s.plot_id WHERE sp.estate_id = e.id AND s.status = 'active'), 0) AS agreed,
      COALESCE((SELECT SUM(pay.amount) FROM payments pay JOIN sales s ON s.id = pay.sale_id JOIN plots sp ON sp.id = s.plot_id WHERE sp.estate_id = e.id AND s.status = 'active'), 0) AS collected
      FROM estates e LEFT JOIN plots p ON p.estate_id = e.id GROUP BY e.id ORDER BY e.name`).all(),
    stages: db.prepare(`SELECT COALESCE(next_step, 'All steps complete') AS stage, COUNT(*) AS n, MIN(pos) AS pos FROM (
        SELECT (SELECT label FROM milestones WHERE sale_id = s.id AND done_on IS NULL ORDER BY position LIMIT 1) AS next_step,
               COALESCE((SELECT MIN(position) FROM milestones WHERE sale_id = s.id AND done_on IS NULL), 999) AS pos
        FROM sales s WHERE s.status = 'active') GROUP BY stage ORDER BY pos`).all(),
    months: db.prepare(`SELECT substr(pay.paid_on, 1, 7) AS month, SUM(pay.amount) AS collected, COUNT(*) AS payments
      FROM payments pay JOIN sales s ON s.id = pay.sale_id WHERE s.status = 'active' GROUP BY month ORDER BY month DESC LIMIT 12`).all(),
    sources: db.prepare("SELECT source, COUNT(*) AS total, SUM(status = 'won') AS won FROM enquiries GROUP BY source ORDER BY total DESC").all(),
    demarcation: db.prepare('SELECT demarcation, COUNT(*) AS n FROM plots GROUP BY demarcation').all(),
  });

  admin.get('/reports', (req, res) => res.render('admin/reports', { title: 'Reports', ...reportData(), DEMARCATION }));

  admin.get('/reports/sales.csv', (req, res) => {
    const rows = db.prepare(`${SALE_SELECT} ORDER BY s.id`).all();
    const header = ['Sale', 'Plot', 'Estate', 'Customer', 'Phone', 'Email', 'Status', 'Reserved on', 'Agreed price', 'Paid', 'Balance', 'Steps done', 'Waiting on', 'Handled by'];
    const lines = rows.map((s) => [s.id, s.ref, s.estate_name, s.customer_name, s.phone, s.email, LABELS[s.status], s.reserved_on,
      s.agreed_price, s.paid, s.agreed_price - s.paid, `${s.steps_done}/${s.steps}`, s.status === 'active' ? (s.next_step || 'Complete') : '', s.handled_by].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sales.csv"' });
    res.send(`﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
  });

  app.use('/admin', admin);

  app.use((req, res) => {
    res.status(404).render('message', { title: 'Page not found', body: 'The page you are looking for does not exist or has been removed.' });
  });

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
    if (!process.env.ADMIN_PASSWORD) console.log('Demo staff login: admin / admin123 (set ADMIN_PASSWORD before going live)');
  });
}

module.exports = { createApp };
