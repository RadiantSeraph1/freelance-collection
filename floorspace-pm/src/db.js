const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const ROLES = ['manager', 'landlord', 'tenant'];
const CURRENCIES = ['GHS', 'USD'];
const PRIORITIES = ['low', 'normal', 'urgent'];
const REQUEST_STATUSES = ['open', 'scheduled', 'in_progress', 'done', 'cancelled'];
const ACTIVE_REQUEST = ['open', 'scheduled', 'in_progress'];
const INSPECTION_KINDS = ['routine', 'move_in', 'move_out'];
const CONDITIONS = ['good', 'fair', 'poor'];
const AREAS = ['Living room', 'Kitchen', 'Bathrooms', 'Bedrooms', 'Electrical', 'Plumbing', 'Exterior and compound', 'Security'];
const VIEWING_STATUSES = ['requested', 'confirmed', 'done', 'cancelled'];
const PAYMENT_METHODS = ['bank transfer', 'mobile money', 'cash', 'cheque'];
const INSPECTION_EVERY_DAYS = 180;

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
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY,
      landlord_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      area TEXT NOT NULL DEFAULT '',
      fee_percent INTEGER NOT NULL DEFAULT 10,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id),
      label TEXT NOT NULL,
      bedrooms INTEGER,
      bathrooms INTEGER,
      asking_rent INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'GHS',
      listed INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      UNIQUE (property_id, label)
    );
    CREATE TABLE IF NOT EXISTS tenancies (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      tenant_id INTEGER NOT NULL REFERENCES users(id),
      rent INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GHS',
      due_day INTEGER NOT NULL DEFAULT 1,
      start_date TEXT NOT NULL,
      end_date TEXT,
      deposit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      ended_on TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_tenancy ON tenancies(unit_id) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS charges (
      id INTEGER PRIMARY KEY,
      tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
      period TEXT NOT NULL,
      due_date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      UNIQUE (tenancy_id, period)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
      amount INTEGER NOT NULL,
      paid_on TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'bank transfer',
      reference TEXT NOT NULL DEFAULT '',
      recorded_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY,
      tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
      sent_on TEXT NOT NULL DEFAULT (date('now')),
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      sent_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS maintenance (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      reported_by INTEGER REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      contractor TEXT NOT NULL DEFAULT '',
      cost INTEGER NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'GHS',
      charge_landlord INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_on TEXT
    );
    CREATE TABLE IF NOT EXISTS maintenance_notes (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inspections (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      inspected_on TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'routine',
      inspector TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS inspection_items (
      id INTEGER PRIMARY KEY,
      inspection_id INTEGER NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
      area TEXT NOT NULL,
      condition TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS viewings (
      id INTEGER PRIMARY KEY,
      unit_id INTEGER NOT NULL REFERENCES units(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      preferred_date TEXT,
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_units_property ON units(property_id);
    CREATE INDEX IF NOT EXISTS idx_tenancies_tenant ON tenancies(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_charges_tenancy ON charges(tenancy_id);
    CREATE INDEX IF NOT EXISTS idx_payments_tenancy ON payments(tenancy_id);
    CREATE INDEX IF NOT EXISTS idx_maintenance_unit ON maintenance(unit_id);
  `);
  return db;
}

const today = (db) => db.prepare("SELECT date('now') AS d").get().d;
const daysFromNow = (db, n) => db.prepare("SELECT date('now', ?) AS d").get(`${n >= 0 ? '+' : ''}${n} days`).d;
const daysBetween = (db, from, to) => Math.round(db.prepare('SELECT julianday(?) - julianday(?) AS n').get(to, from).n);

const addMonths = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const dueDateFor = (period, dueDay) => `${period}-${String(dueDay).padStart(2, '0')}`;

// Rent is charged once per calendar month from the month the tenancy starts to
// the current month (or the month it ended). The first month is charged in
// full, so a tenancy should start on the 1st unless a part-month is intended.
// Safe to call as often as needed: existing charges are never changed.
function ensureCharges(db) {
  const currentPeriod = today(db).slice(0, 7);
  const insert = db.prepare('INSERT OR IGNORE INTO charges (tenancy_id, period, due_date, amount) VALUES (?, ?, ?, ?)');
  for (const t of db.prepare('SELECT * FROM tenancies').all()) {
    const last = t.status === 'active' || !t.ended_on ? currentPeriod : t.ended_on.slice(0, 7) < currentPeriod ? t.ended_on.slice(0, 7) : currentPeriod;
    for (let p = t.start_date.slice(0, 7); p <= last; p = addMonths(p, 1)) insert.run(t.id, p, dueDateFor(p, t.due_day), t.rent);
  }
}

// What a tenancy owes. Payments are applied to the oldest charge first, so one
// late month shows as overdue even when later months are paid. A negative
// balance means the tenant is in credit.
function ledger(db, tenancyId) {
  const todayDate = today(db);
  const charges = db.prepare('SELECT * FROM charges WHERE tenancy_id = ? ORDER BY due_date, id').all(tenancyId);
  const payments = db.prepare('SELECT * FROM payments WHERE tenancy_id = ? ORDER BY paid_on, id').all(tenancyId);
  const paid = payments.reduce((sum, p) => sum + p.amount, 0);
  let remaining = paid;
  const rows = charges.map((c) => {
    const applied = Math.min(c.amount, Math.max(remaining, 0));
    remaining -= applied;
    return { ...c, applied, outstanding: c.amount - applied, overdue: c.amount - applied > 0 && c.due_date < todayDate };
  });
  const charged = charges.reduce((sum, c) => sum + c.amount, 0);
  const overdueRows = rows.filter((r) => r.overdue);
  const nextDue = rows.find((r) => r.outstanding > 0 && r.due_date >= todayDate);
  return {
    rows, payments, charged, paid, balance: charged - paid,
    overdue: overdueRows.reduce((sum, r) => sum + r.outstanding, 0),
    overdueMonths: overdueRows.length,
    oldestOverdue: overdueRows.length ? overdueRows[0].due_date : null,
    daysOverdue: overdueRows.length ? daysBetween(db, overdueRows[0].due_date, todayDate) : 0,
    nextDue: nextDue ? { date: nextDue.due_date, amount: nextDue.outstanding } : null,
  };
}

// Month-end figures for one landlord: rent received, the agency's management
// fee, and maintenance the landlord is charged for, per property and currency.
function statement(db, landlordId, period) {
  const lines = new Map();
  const line = (property, currency) => {
    const key = `${property.id}|${currency}`;
    if (!lines.has(key)) lines.set(key, { property_id: property.id, property: property.name, fee_percent: property.fee_percent, currency, collected: 0, fee: 0, repairs: 0, repairItems: [], net: 0, payments: [] });
    return lines.get(key);
  };
  const properties = db.prepare('SELECT * FROM properties WHERE landlord_id = ? ORDER BY name').all(landlordId);
  for (const p of properties) {
    const paid = db.prepare(`SELECT pay.*, t.currency, un.label FROM payments pay JOIN tenancies t ON t.id = pay.tenancy_id JOIN units un ON un.id = t.unit_id
      WHERE un.property_id = ? AND substr(pay.paid_on, 1, 7) = ? ORDER BY pay.paid_on, pay.id`).all(p.id, period);
    for (const pay of paid) {
      const l = line(p, pay.currency);
      l.collected += pay.amount;
      l.payments.push({ paid_on: pay.paid_on, unit: pay.label, amount: pay.amount });
    }
    const repairs = db.prepare(`SELECT m.*, un.label FROM maintenance m JOIN units un ON un.id = m.unit_id
      WHERE un.property_id = ? AND m.status = 'done' AND m.charge_landlord = 1 AND m.cost > 0 AND substr(m.completed_on, 1, 7) = ? ORDER BY m.completed_on, m.id`).all(p.id, period);
    for (const r of repairs) {
      const l = line(p, r.cost_currency);
      l.repairs += r.cost;
      l.repairItems.push({ completed_on: r.completed_on, unit: r.label, title: r.title, contractor: r.contractor, cost: r.cost });
    }
  }
  const result = [...lines.values()];
  for (const l of result) {
    l.fee = Math.round((l.collected * l.fee_percent) / 100);
    l.net = l.collected - l.fee - l.repairs;
  }
  const totals = {};
  for (const l of result) {
    const t = (totals[l.currency] ||= { collected: 0, fee: 0, repairs: 0, net: 0 });
    t.collected += l.collected; t.fee += l.fee; t.repairs += l.repairs; t.net += l.net;
  }
  return { period, lines: result, totals };
}

module.exports = {
  openDb, hashPassword, verifyPassword, ensureCharges, ledger, statement, today, daysFromNow, daysBetween, addMonths, dueDateFor,
  ROLES, CURRENCIES, PRIORITIES, REQUEST_STATUSES, ACTIVE_REQUEST, INSPECTION_KINDS, CONDITIONS, AREAS, VIEWING_STATUSES, PAYMENT_METHODS, INSPECTION_EVERY_DAYS,
};
