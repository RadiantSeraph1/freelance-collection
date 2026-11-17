const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const PLOT_STATUSES = ['available', 'reserved', 'sold'];
const DEMARCATION = ['not_started', 'surveyed', 'pillared', 'handed_over'];
const SOURCES = ['website', 'whatsapp', 'phone', 'walk-in', 'social', 'referral'];
const ENQUIRY_STATUSES = ['new', 'contacted', 'site_visit', 'negotiating', 'won', 'lost'];
const OPEN_STATUSES = ['new', 'contacted', 'site_visit', 'negotiating'];
const PAYMENT_METHODS = ['bank transfer', 'mobile money', 'cash', 'cheque'];

// Default documentation steps for a land sale. Copied onto each sale when it is
// created, so changing this list later does not rewrite existing records.
const MILESTONES = [
  'Reservation fee received',
  'Offer letter issued',
  'Sale and purchase agreement signed',
  'Site plan prepared',
  'Plot demarcated and shown to customer',
  'Full payment received',
  'Indenture signed by both parties',
  'Submitted for stamping and Lands Commission registration',
  'Registered documents handed to customer',
];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS estates (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS plots (
      id INTEGER PRIMARY KEY,
      estate_id INTEGER NOT NULL REFERENCES estates(id),
      plot_no TEXT NOT NULL,
      ref TEXT NOT NULL UNIQUE,
      dimensions TEXT NOT NULL DEFAULT '',
      size_sqm INTEGER,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      demarcation TEXT NOT NULL DEFAULT 'not_started',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY,
      plot_id INTEGER REFERENCES plots(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'website',
      status TEXT NOT NULL DEFAULT 'new',
      assigned_to TEXT NOT NULL DEFAULT '',
      next_follow_up TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS enquiry_notes (
      id INTEGER PRIMARY KEY,
      enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY,
      plot_id INTEGER NOT NULL REFERENCES plots(id),
      enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE SET NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      agreed_price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      handled_by TEXT NOT NULL DEFAULT '',
      reserved_on TEXT NOT NULL DEFAULT (date('now')),
      reservation_expires TEXT,
      cancelled_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      label TEXT NOT NULL,
      done_on TEXT,
      note TEXT NOT NULL DEFAULT '',
      done_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sales_plot ON sales(plot_id);
    CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
    CREATE INDEX IF NOT EXISTS idx_milestones_sale ON milestones(sale_id);
  `);
  // Older databases predate estate photos.
  if (!db.prepare('PRAGMA table_info(estates)').all().some((c) => c.name === 'image_url')) {
    db.exec("ALTER TABLE estates ADD COLUMN image_url TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

// A sale row plus the figures every screen needs: amount paid, balance,
// documentation progress and the step it is currently waiting on.
const SALE_SELECT = `
  SELECT s.*, p.ref, p.plot_no, p.demarcation, e.name AS estate_name,
    COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) AS paid,
    (SELECT COUNT(*) FROM milestones WHERE sale_id = s.id) AS steps,
    (SELECT COUNT(*) FROM milestones WHERE sale_id = s.id AND done_on IS NOT NULL) AS steps_done,
    (SELECT label FROM milestones WHERE sale_id = s.id AND done_on IS NULL ORDER BY position LIMIT 1) AS next_step
  FROM sales s JOIN plots p ON p.id = s.plot_id JOIN estates e ON e.id = p.estate_id`;

function createSale(db, sale) {
  const result = db.prepare(`INSERT INTO sales (plot_id, enquiry_id, customer_name, phone, email, agreed_price, handled_by, reservation_expires)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sale.plot_id, sale.enquiry_id ?? null, sale.customer_name, sale.phone || '', sale.email || '', sale.agreed_price, sale.handled_by || '', sale.reservation_expires ?? null);
  const id = Number(result.lastInsertRowid);
  const insert = db.prepare('INSERT INTO milestones (sale_id, position, label) VALUES (?, ?, ?)');
  MILESTONES.forEach((label, i) => insert.run(id, i + 1, label));
  syncPlotStatus(db, sale.plot_id);
  return id;
}

// A plot's status follows its sale: no active sale = available, an active
// sale = reserved, and fully paid = sold.
function syncPlotStatus(db, plotId) {
  const sale = db.prepare(`SELECT s.agreed_price, COALESCE((SELECT SUM(amount) FROM payments WHERE sale_id = s.id), 0) AS paid
    FROM sales s WHERE s.plot_id = ? AND s.status = 'active'`).get(plotId);
  const status = !sale ? 'available' : sale.paid >= sale.agreed_price ? 'sold' : 'reserved';
  db.prepare('UPDATE plots SET status = ? WHERE id = ?').run(status, plotId);
  return status;
}

module.exports = {
  openDb, hashPassword, verifyPassword, createSale, syncPlotStatus, SALE_SELECT,
  PLOT_STATUSES, DEMARCATION, SOURCES, ENQUIRY_STATUSES, OPEN_STATUSES, PAYMENT_METHODS, MILESTONES,
};
