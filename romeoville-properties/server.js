const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  openDb, verifyPassword, nextRef,
  TYPES, LISTINGS, PROPERTY_STATUSES, CURRENCIES, SOURCES, ENQUIRY_STATUSES, OPEN_STATUSES,
} = require('./src/db');
const { seed } = require('./src/seed');
const { sessionMiddleware } = require('./src/session');

const LABELS = {
  house: 'House', apartment: 'Apartment', townhouse: 'Townhouse', land: 'Land', commercial: 'Commercial',
  sale: 'For sale', rent: 'For rent',
  available: 'Available', under_offer: 'Under offer', sold: 'Sold / let',
  new: 'New', contacted: 'Contacted', viewing: 'Viewing booked', negotiating: 'Negotiating', won: 'Closed – won', lost: 'Closed – lost',
  website: 'Website', whatsapp: 'WhatsApp', phone: 'Phone', 'walk-in': 'Walk-in', social: 'Social media', referral: 'Referral',
};

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production');
  }

  const site = {
    name: env.SITE_NAME || 'Romeoville Properties',
    phone: env.SITE_PHONE || '+233 00 000 0000',
    email: env.SITE_EMAIL || 'sales@example.com',
    address: env.SITE_ADDRESS || 'Accra, Ghana',
    demo: env.DEMO_BANNER !== 'off',
    temporary: (options.dbPath || env.DB_PATH) === ':memory:', // serverless demo: data is not kept
  };
  site.whatsapp = (env.SITE_WHATSAPP || site.phone).replace(/\D/g, '');

  const db = openDb(options.dbPath || env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
  seed(db, { adminUser: env.ADMIN_USER || 'admin', adminPassword: env.ADMIN_PASSWORD || 'admin123' });

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
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(sessionMiddleware(env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), production));

  app.use((req, res, next) => {
    Object.assign(res.locals, {
      site, LABELS, label: (k) => LABELS[k] || k, session: req.session, path: req.path,
      money: (amount, currency) => `${currency === 'GHS' ? 'GH₵' : '$'}${Number(amount).toLocaleString('en-US')}`,
      waLink: (text) => `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(text)}`,
    });
    next();
  });

  // Simple per-IP limiter for the public form and the login form.
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

  // ---------- Public site ----------

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  app.get('/', (req, res) => {
    const featured = db.prepare("SELECT * FROM properties WHERE status != 'sold' ORDER BY featured DESC, created_at DESC, id DESC LIMIT 3").all();
    const locations = db.prepare("SELECT DISTINCT location FROM properties WHERE status != 'sold' ORDER BY location").all().map((r) => r.location);
    res.render('home', { title: site.name, featured, locations, TYPES, LISTINGS });
  });

  app.get('/properties', (req, res) => {
    const f = {
      q: clean(req.query.q, 80),
      listing: oneOf(req.query.listing, LISTINGS, ''),
      type: oneOf(req.query.type, TYPES, ''),
      location: clean(req.query.location, 80),
      beds: intOrNull(req.query.beds),
      currency: oneOf(req.query.currency, CURRENCIES, ''),
      min: intOrNull(req.query.min),
      max: intOrNull(req.query.max),
      sort: oneOf(req.query.sort, ['newest', 'price_asc', 'price_desc'], 'newest'),
    };
    const where = ["status != 'sold'"];
    const params = [];
    const add = (sql, ...p) => { where.push(sql); params.push(...p); };
    if (f.q) add("(title LIKE ? OR description LIKE ? OR location LIKE ? OR ref LIKE ?)", ...Array(4).fill(`%${f.q}%`));
    if (f.listing) add('listing = ?', f.listing);
    if (f.type) add('type = ?', f.type);
    if (f.location) add('location = ?', f.location);
    if (f.beds !== null) add('bedrooms >= ?', f.beds);
    // Prices are stored in the listing's own currency, so a price range only
    // makes sense once a currency is chosen.
    if (f.currency) add('currency = ?', f.currency);
    if (f.currency && f.min !== null) add('price >= ?', f.min);
    if (f.currency && f.max !== null) add('price <= ?', f.max);
    const order = { newest: 'created_at DESC, id DESC', price_asc: 'price ASC', price_desc: 'price DESC' }[f.sort];
    const properties = db.prepare(`SELECT * FROM properties WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...params);
    const locations = db.prepare("SELECT DISTINCT location FROM properties WHERE status != 'sold' ORDER BY location").all().map((r) => r.location);
    res.render('properties', { title: 'Properties', properties, f, locations, TYPES, LISTINGS, CURRENCIES });
  });

  app.get('/properties/:id', (req, res, next) => {
    const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(intOrNull(req.params.id));
    if (!property) return next();
    res.render('property', { title: property.title, property, errors: [], form: {} });
  });

  app.get('/contact', (req, res) => {
    res.render('contact', { title: 'Contact us', errors: [], form: {} });
  });

  app.post('/enquiries', limit(5, 10 * 60 * 1000), (req, res) => {
    const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(intOrNull(req.body.property_id));
    const form = {
      name: clean(req.body.name, 100), phone: clean(req.body.phone, 30),
      email: clean(req.body.email, 120), message: clean(req.body.message, 2000),
    };
    // Honeypot: real visitors never see or fill the "website" field.
    if (clean(req.body.website)) return res.redirect('/enquiries/thanks');

    const errors = [];
    if (form.name.length < 2) errors.push('Please enter your name.');
    if (!form.phone && !form.email) errors.push('Please give a phone number or an email address so we can reply.');
    if (form.phone && !/^[+\d][\d\s()-]{6,}$/.test(form.phone)) errors.push('That phone number does not look right.');
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.push('That email address does not look right.');
    if (errors.length) {
      return res.status(400).render(property ? 'property' : 'contact', {
        title: property ? property.title : 'Contact us', property, errors, form,
      });
    }
    db.prepare("INSERT INTO enquiries (property_id, name, phone, email, message, source, next_follow_up) VALUES (?, ?, ?, ?, ?, 'website', date('now'))")
      .run(property ? property.id : null, form.name, form.phone, form.email, form.message);
    res.redirect('/enquiries/thanks');
  });

  app.get('/enquiries/thanks', (req, res) => {
    res.render('message', { title: 'Thank you', body: 'We have received your enquiry and a member of our team will contact you shortly.' });
  });

  // ---------- Admin ----------

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

  admin.get('/', (req, res) => {
    const open = OPEN_STATUSES.map(() => '?').join(',');
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    const stats = {
      listings: count("SELECT COUNT(*) AS n FROM properties WHERE status = 'available'"),
      newEnquiries: count("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'"),
      open: count(`SELECT COUNT(*) AS n FROM enquiries WHERE status IN (${open})`, ...OPEN_STATUSES),
      due: count(`SELECT COUNT(*) AS n FROM enquiries WHERE status IN (${open}) AND next_follow_up <= date('now')`, ...OPEN_STATUSES),
      won: count("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'won'"),
      closed: count("SELECT COUNT(*) AS n FROM enquiries WHERE status IN ('won', 'lost')"),
    };
    const bySource = db.prepare("SELECT source, COUNT(*) AS total, SUM(status = 'won') AS won FROM enquiries GROUP BY source ORDER BY total DESC").all();
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM enquiries GROUP BY status').all().map((r) => [r.status, r.n]));
    const due = db.prepare(`SELECT e.*, p.ref, p.title AS property_title FROM enquiries e LEFT JOIN properties p ON p.id = e.property_id
      WHERE e.status IN (${open}) AND e.next_follow_up <= date('now') ORDER BY e.next_follow_up LIMIT 10`).all(...OPEN_STATUSES);
    res.render('admin/dashboard', { title: 'Dashboard', stats, bySource, byStatus, due, ENQUIRY_STATUSES });
  });

  // Listings
  admin.get('/properties', (req, res) => {
    const properties = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM enquiries e WHERE e.property_id = p.id) AS enquiries
      FROM properties p ORDER BY p.created_at DESC, p.id DESC`).all();
    res.render('admin/properties', { title: 'Listings', properties });
  });

  const propertyForm = (res, property, errors = [], status = 200) => res.status(status).render('admin/property-form', {
    title: property.id ? `Edit ${property.ref}` : 'New listing', property, errors,
    TYPES, LISTINGS, PROPERTY_STATUSES, CURRENCIES,
  });

  function readProperty(body) {
    const p = {
      title: clean(body.title, 120), description: clean(body.description, 4000),
      type: oneOf(body.type, TYPES, 'house'), listing: oneOf(body.listing, LISTINGS, 'sale'),
      location: clean(body.location, 80), price: intOrNull(body.price),
      currency: oneOf(body.currency, CURRENCIES, 'USD'),
      bedrooms: intOrNull(body.bedrooms), bathrooms: intOrNull(body.bathrooms), size_sqm: intOrNull(body.size_sqm),
      image_url: clean(body.image_url, 500), status: oneOf(body.status, PROPERTY_STATUSES, 'available'),
      featured: body.featured ? 1 : 0,
    };
    const errors = [];
    if (p.title.length < 3) errors.push('Give the listing a title.');
    if (!p.location) errors.push('Enter the location.');
    if (p.price === null) errors.push('Enter the price as a whole number.');
    if (p.image_url && !/^https:\/\/\S+$/.test(p.image_url)) errors.push('The photo link must start with https://');
    return { p, errors };
  }

  admin.get('/properties/new', (req, res) => propertyForm(res, { type: 'house', listing: 'sale', currency: 'USD', status: 'available' }));

  admin.post('/properties', (req, res) => {
    const { p, errors } = readProperty(req.body);
    if (errors.length) return propertyForm(res, p, errors, 400);
    db.prepare(`INSERT INTO properties (ref, title, description, type, listing, location, price, currency, bedrooms, bathrooms, size_sqm, image_url, status, featured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nextRef(db), p.title, p.description, p.type, p.listing, p.location, p.price, p.currency, p.bedrooms, p.bathrooms, p.size_sqm, p.image_url, p.status, p.featured);
    res.redirect('/admin/properties');
  });

  admin.get('/properties/:id/edit', (req, res, next) => {
    const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(intOrNull(req.params.id));
    if (!property) return next();
    propertyForm(res, property);
  });

  admin.post('/properties/:id', (req, res, next) => {
    const existing = db.prepare('SELECT id, ref FROM properties WHERE id = ?').get(intOrNull(req.params.id));
    if (!existing) return next();
    const { p, errors } = readProperty(req.body);
    if (errors.length) return propertyForm(res, { ...p, ...existing }, errors, 400);
    db.prepare(`UPDATE properties SET title = ?, description = ?, type = ?, listing = ?, location = ?, price = ?, currency = ?,
      bedrooms = ?, bathrooms = ?, size_sqm = ?, image_url = ?, status = ?, featured = ? WHERE id = ?`)
      .run(p.title, p.description, p.type, p.listing, p.location, p.price, p.currency, p.bedrooms, p.bathrooms, p.size_sqm, p.image_url, p.status, p.featured, existing.id);
    res.redirect('/admin/properties');
  });

  admin.post('/properties/:id/delete', (req, res) => {
    db.prepare('DELETE FROM properties WHERE id = ?').run(intOrNull(req.params.id));
    res.redirect('/admin/properties');
  });

  // Enquiries and follow-ups
  admin.get('/enquiries', (req, res) => {
    const f = {
      status: oneOf(req.query.status, [...ENQUIRY_STATUSES, 'open'], ''),
      source: oneOf(req.query.source, SOURCES, ''),
      due: req.query.due === '1',
    };
    const where = ['1 = 1'];
    const params = [];
    if (f.status === 'open' || f.due) { where.push(`e.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
    else if (f.status) { where.push('e.status = ?'); params.push(f.status); }
    if (f.source) { where.push('e.source = ?'); params.push(f.source); }
    if (f.due) where.push("e.next_follow_up <= date('now')");
    const enquiries = db.prepare(`SELECT e.*, p.ref, date('now') AS today FROM enquiries e LEFT JOIN properties p ON p.id = e.property_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id DESC`).all(...params);
    res.render('admin/enquiries', { title: 'Enquiries', enquiries, f, ENQUIRY_STATUSES, SOURCES });
  });

  const enquiryFormData = () => ({
    properties: db.prepare('SELECT id, ref, title FROM properties ORDER BY ref').all(), SOURCES, ENQUIRY_STATUSES,
  });

  admin.get('/enquiries/new', (req, res) => {
    res.render('admin/enquiry-new', { title: 'Log an enquiry', errors: [], form: { source: 'phone' }, ...enquiryFormData() });
  });

  admin.post('/enquiries', (req, res) => {
    const form = {
      name: clean(req.body.name, 100), phone: clean(req.body.phone, 30), email: clean(req.body.email, 120),
      message: clean(req.body.message, 2000), source: oneOf(req.body.source, SOURCES, 'phone'),
      property_id: intOrNull(req.body.property_id), assigned_to: clean(req.body.assigned_to, 60),
      next_follow_up: isDate(req.body.next_follow_up) ? req.body.next_follow_up : null,
    };
    const errors = [];
    if (form.name.length < 2) errors.push('Enter the customer’s name.');
    if (!form.phone && !form.email) errors.push('Enter a phone number or an email address.');
    if (errors.length) return res.status(400).render('admin/enquiry-new', { title: 'Log an enquiry', errors, form, ...enquiryFormData() });
    const property = db.prepare('SELECT id FROM properties WHERE id = ?').get(form.property_id);
    const result = db.prepare(`INSERT INTO enquiries (property_id, name, phone, email, message, source, assigned_to, next_follow_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(property ? property.id : null, form.name, form.phone, form.email, form.message, form.source, form.assigned_to, form.next_follow_up);
    res.redirect(`/admin/enquiries/${result.lastInsertRowid}`);
  });

  admin.get('/enquiries/:id', (req, res, next) => {
    const enquiry = db.prepare(`SELECT e.*, p.ref, p.title AS property_title FROM enquiries e
      LEFT JOIN properties p ON p.id = e.property_id WHERE e.id = ?`).get(intOrNull(req.params.id));
    if (!enquiry) return next();
    const notes = db.prepare('SELECT * FROM enquiry_notes WHERE enquiry_id = ? ORDER BY created_at DESC, id DESC').all(enquiry.id);
    res.render('admin/enquiry', { title: `Enquiry from ${enquiry.name}`, enquiry, notes, ENQUIRY_STATUSES });
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

  app.use('/admin', admin);

  app.use((req, res) => {
    res.status(404).render('message', { title: 'Page not found', body: 'The page you are looking for does not exist or the property has been removed.' });
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
