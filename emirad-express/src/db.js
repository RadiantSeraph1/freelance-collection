const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const ROLES = ['manager', 'rider', 'business'];

// Sample rate card. Real prices must come from Emirad Express. The price of a
// parcel is: service base + the dearer of the two zone charges + a weight charge.
const SERVICES = {
  same_day: { name: 'Same-day', base: 35, text: 'Delivered today if booked before 3pm, otherwise tomorrow' },
  next_day: { name: 'Next-day', base: 25, text: 'Delivered the next day' },
  standard: { name: 'Standard', base: 15, text: 'Delivered within 3 days' },
};
const SAME_DAY_CUTOFF_HOUR = 15;
const STANDARD_DAYS = 3;
const ZONES = {
  'Haatso': 0, 'Dome': 3, 'Legon': 3, 'Achimota': 4, 'Madina': 4, 'East Legon': 5, 'Airport / Cantonments': 6,
  'Osu / Labone': 7, 'Accra Central': 8, 'Adenta': 8, 'Spintex': 10, 'Tema': 15, 'Kasoa': 20,
};
const WEIGHT_BANDS = [[1, 0], [5, 8], [10, 18], [20, 35]]; // [up to this many kg, extra charge]
const MAX_WEIGHT_KG = WEIGHT_BANDS[WEIGHT_BANDS.length - 1][0];

const PAYMENT_MODES = ['sender_cash', 'receiver_cash', 'account'];
const STATUSES = ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'];
const ACTIVE_STATUSES = ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed'];
const CLOSED_STATUSES = ['delivered', 'returned', 'cancelled'];
const TRANSITIONS = {
  booked: ['pickup_scheduled', 'cancelled'],
  pickup_scheduled: ['picked_up', 'booked', 'cancelled'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered', 'failed'],
  failed: ['out_for_delivery', 'returned'],
  delivered: [], returned: [], cancelled: [],
};
const FAIL_REASONS = ['not_home', 'wrong_address', 'refused', 'phone_off', 'no_cash', 'other'];
const SOURCES = ['web', 'phone', 'account', 'bulk'];

const STATUS_TEXT = {
  booked: 'Booking received', pickup_scheduled: 'Rider assigned for pickup', picked_up: 'Picked up from sender',
  out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed: 'Delivery attempt failed',
  returned: 'Returned to sender', cancelled: 'Cancelled',
};
const FAIL_TEXT = {
  not_home: 'Recipient not available', wrong_address: 'Address could not be found', refused: 'Recipient refused the parcel',
  phone_off: 'Recipient’s phone was off', no_cash: 'Recipient did not have the cash', other: 'Other reason',
};

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
      company TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      zone TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY,
      tracking TEXT NOT NULL UNIQUE,
      business_id INTEGER REFERENCES users(id),
      rider_id INTEGER REFERENCES users(id),
      source TEXT NOT NULL DEFAULT 'web',
      sender_name TEXT NOT NULL,
      sender_phone TEXT NOT NULL,
      pickup_address TEXT NOT NULL,
      pickup_zone TEXT NOT NULL,
      receiver_name TEXT NOT NULL,
      receiver_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_zone TEXT NOT NULL,
      description TEXT NOT NULL,
      weight_kg REAL NOT NULL,
      service TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      price INTEGER NOT NULL,
      cod_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'booked',
      due_date TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT NOT NULL DEFAULT '',
      delivered_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1,
      by_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cash_items (
      id INTEGER PRIMARY KEY,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id),
      rider_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      expected INTEGER NOT NULL,
      collected INTEGER NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      remitted_at TEXT,
      remitted_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
    CREATE INDEX IF NOT EXISTS idx_shipments_rider ON shipments(rider_id);
    CREATE INDEX IF NOT EXISTS idx_shipments_business ON shipments(business_id);
    CREATE INDEX IF NOT EXISTS idx_events_shipment ON events(shipment_id);
    CREATE INDEX IF NOT EXISTS idx_cash_rider ON cash_items(rider_id);
  `);
  return db;
}

const today = (db) => db.prepare("SELECT date('now') AS d").get().d;
const daysFromNow = (db, n) => db.prepare("SELECT date('now', ?) AS d").get(`${n >= 0 ? '+' : ''}${n} days`).d;
const addDays = (db, date, n) => db.prepare("SELECT date(?, ?) AS d").get(date, `${n >= 0 ? '+' : ''}${n} days`).d;

const txDepth = new WeakMap();
// Runs fn atomically. Safe to nest: an inner call just joins the outer
// transaction, so a bulk booking made of many bookings commits or rolls back as one.
function transaction(db, fn) {
  if (txDepth.get(db)) return fn();
  txDepth.set(db, 1);
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth.set(db, 0);
  }
}

// ---------- Prices and delivery promises ----------

function parseWeight(value) {
  const kg = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(kg) ? Math.round(kg * 10) / 10 : NaN;
}

// Returns { price, base, zoneCharge, weightCharge } or { error }.
function quote(service, pickupZone, deliveryZone, weightKg) {
  if (!SERVICES[service]) return { error: 'Choose a delivery service.' };
  if (!(pickupZone in ZONES)) return { error: 'Choose the pickup area.' };
  if (!(deliveryZone in ZONES)) return { error: 'Choose the delivery area.' };
  if (!(weightKg > 0)) return { error: 'Enter the parcel weight in kilograms.' };
  if (weightKg > MAX_WEIGHT_KG) return { error: `Parcels over ${MAX_WEIGHT_KG} kg cannot be booked online. Please call us.` };
  const band = WEIGHT_BANDS.find(([max]) => weightKg <= max);
  const base = SERVICES[service].base;
  const zoneCharge = Math.max(ZONES[pickupZone], ZONES[deliveryZone]);
  const weightCharge = band[1];
  return { price: base + zoneCharge + weightCharge, base, zoneCharge, weightCharge };
}

// The date a parcel is due. Same-day bookings made after the cut-off are due
// the next day; every date is the Accra date (Ghana does not use daylight saving).
function dueDate(db, service, bookedDate, bookedHour) {
  if (service === 'same_day') return bookedHour < SAME_DAY_CUTOFF_HOUR ? bookedDate : addDays(db, bookedDate, 1);
  if (service === 'next_day') return addDays(db, bookedDate, 1);
  return addDays(db, bookedDate, STANDARD_DAYS);
}

const TRACKING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading
function newTracking(db) {
  for (;;) {
    const chars = Array.from(crypto.randomBytes(8), (b) => TRACKING_ALPHABET[b % TRACKING_ALPHABET.length]).join('');
    const code = `EE-${chars.slice(0, 4)}-${chars.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM shipments WHERE tracking = ?').get(code)) return code;
  }
}

const addEvent = (db, shipmentId, status, text, { visible = 1, by = '', at } = {}) => db.prepare(
  at ? 'INSERT INTO events (shipment_id, status, text, visible, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    : 'INSERT INTO events (shipment_id, status, text, visible, by_name) VALUES (?, ?, ?, ?, ?)',
).run(...[shipmentId, status, text, visible, by, ...(at ? [at] : [])]);

// ---------- Booking ----------

// The caller has already validated the input; the price is always worked out
// here, never taken from the browser.
function createShipment(db, d, { by = 'customer' } = {}) {
  const q = quote(d.service, d.pickup_zone, d.delivery_zone, d.weight_kg);
  if (q.error) throw new Error(q.error);
  const { date, hour } = db.prepare("SELECT date('now') AS date, CAST(strftime('%H', 'now') AS INTEGER) AS hour").get();
  return transaction(db, () => {
    const tracking = newTracking(db);
    const id = Number(db.prepare(`INSERT INTO shipments (tracking, business_id, source, sender_name, sender_phone, pickup_address, pickup_zone,
        receiver_name, receiver_phone, delivery_address, delivery_zone, description, weight_kg, service, payment_mode, price, cod_amount, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tracking, d.business_id ?? null, d.source || 'web', d.sender_name, d.sender_phone, d.pickup_address, d.pickup_zone,
      d.receiver_name, d.receiver_phone, d.delivery_address, d.delivery_zone, d.description, d.weight_kg, d.service, d.payment_mode,
      q.price, d.cod_amount || 0, dueDate(db, d.service, date, hour)).lastInsertRowid);
    addEvent(db, id, 'booked', STATUS_TEXT.booked, { by });
    return { id, tracking, price: q.price };
  });
}

// ---------- Status changes ----------

// One place for every status change, whoever makes it, so the rules cannot drift
// between the dispatcher's screen and the rider's. Returns { ok } or { error }.
function changeStatus(db, shipment, to, o = {}) {
  const label = (s) => STATUS_TEXT[s].toLowerCase();
  if (!(TRANSITIONS[shipment.status] || []).includes(to)) {
    return { error: `A shipment that is “${label(shipment.status)}” cannot be changed to “${label(to)}”.` };
  }
  if (['pickup_scheduled', 'picked_up', 'out_for_delivery', 'delivered', 'failed'].includes(to) && !shipment.rider_id) {
    return { error: 'Assign a rider before updating this shipment.' };
  }
  const recipient = String(o.recipient || '').trim().slice(0, 80);
  if (to === 'delivered' && recipient.length < 2) return { error: 'Enter the name of the person who received the parcel.' };
  if (to === 'failed' && !FAIL_REASONS.includes(o.reason)) return { error: 'Choose why the delivery failed.' };
  const note = String(o.note || '').trim().slice(0, 300);
  const by = o.by || '';
  const amount = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  return transaction(db, () => {
    let text = STATUS_TEXT[to];
    if (to === 'failed') text += `: ${FAIL_TEXT[o.reason]}`;
    if (to === 'delivered') text += ` to ${recipient}`;
    if (note) text += `. ${note}`;

    const sets = { status: to };
    if (to === 'pickup_scheduled' || to === 'booked') Object.assign(sets, { failure_reason: '' });
    if (to === 'out_for_delivery') Object.assign(sets, { failure_reason: '' });
    if (to === 'failed') Object.assign(sets, { failure_reason: o.reason, attempts: shipment.attempts + 1 });
    if (to === 'delivered') Object.assign(sets, { delivered_to: recipient, failure_reason: '' });
    if (CLOSED_STATUSES.includes(to)) sets.closed_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (to === 'booked') sets.rider_id = null;
    const cols = Object.keys(sets);
    db.prepare(`UPDATE shipments SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...cols.map((c) => sets[c]), shipment.id);
    addEvent(db, shipment.id, to, text, { by });

    // Cash the rider collects: the delivery fee at pickup when the sender pays cash,
    // and at delivery the goods value (cash on delivery) plus the fee when the receiver pays.
    if (to === 'picked_up' && shipment.payment_mode === 'sender_cash' && shipment.price > 0) {
      db.prepare('INSERT INTO cash_items (shipment_id, rider_id, kind, expected, collected) VALUES (?, ?, ?, ?, ?)')
        .run(shipment.id, shipment.rider_id, 'pickup_fee', shipment.price, amount(o.collected, shipment.price));
    }
    if (to === 'delivered') {
      const expected = shipment.cod_amount + (shipment.payment_mode === 'receiver_cash' ? shipment.price : 0);
      if (expected > 0) {
        db.prepare('INSERT INTO cash_items (shipment_id, rider_id, kind, expected, collected) VALUES (?, ?, ?, ?, ?)')
          .run(shipment.id, shipment.rider_id, 'delivery_collection', expected, amount(o.collected, expected));
      }
    }
    return { ok: true };
  });
}

function assignRider(db, shipment, rider, by) {
  if (CLOSED_STATUSES.includes(shipment.status)) return { error: 'This shipment is already closed.' };
  if (!rider || rider.role !== 'rider' || !rider.active) return { error: 'Choose an active rider.' };
  if (shipment.rider_id === rider.id) return { ok: true };
  return transaction(db, () => {
    db.prepare("UPDATE shipments SET rider_id = ?, updated_at = datetime('now') WHERE id = ?").run(rider.id, shipment.id);
    if (shipment.status === 'booked') {
      db.prepare("UPDATE shipments SET status = 'pickup_scheduled' WHERE id = ?").run(shipment.id);
      addEvent(db, shipment.id, 'pickup_scheduled', STATUS_TEXT.pickup_scheduled, { by });
      addEvent(db, shipment.id, 'pickup_scheduled', `Assigned to ${rider.name}`, { visible: 0, by });
    } else {
      addEvent(db, shipment.id, shipment.status, `Reassigned to ${rider.name}`, { visible: 0, by });
    }
    return { ok: true };
  });
}

// ---------- Business statements ----------

// For one calendar month: parcels completed (delivered or returned) on the
// business's account, the delivery fees due, the cash on delivery collected
// for them, and the net. Positive net is owed to the business.
function businessStatement(db, businessId, period) {
  const rows = db.prepare(`SELECT s.*, COALESCE((SELECT SUM(c.collected) FROM cash_items c WHERE c.shipment_id = s.id AND c.kind = 'delivery_collection'), 0) AS cod_collected
    FROM shipments s WHERE s.business_id = ? AND s.status IN ('delivered', 'returned') AND substr(s.closed_at, 1, 7) = ? ORDER BY s.closed_at, s.id`).all(businessId, period);
  const fees = rows.reduce((n, r) => n + (r.payment_mode === 'account' ? r.price : 0), 0);
  const cod = rows.reduce((n, r) => n + r.cod_collected, 0);
  return { period, rows, fees, cod, net: cod - fees, delivered: rows.filter((r) => r.status === 'delivered').length, returned: rows.filter((r) => r.status === 'returned').length };
}

module.exports = {
  openDb, hashPassword, verifyPassword, transaction, today, daysFromNow, addDays,
  quote, dueDate, parseWeight, newTracking, addEvent, createShipment, changeStatus, assignRider, businessStatement,
  ROLES, SERVICES, ZONES, WEIGHT_BANDS, MAX_WEIGHT_KG, PAYMENT_MODES, STATUSES, ACTIVE_STATUSES, CLOSED_STATUSES, TRANSITIONS,
  FAIL_REASONS, SOURCES, STATUS_TEXT, FAIL_TEXT, SAME_DAY_CUTOFF_HOUR, STANDARD_DAYS,
};
