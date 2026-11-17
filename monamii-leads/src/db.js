const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const STAGES = ['new', 'contacted', 'viewing', 'negotiating', 'won', 'lost'];
const OPEN_STAGES = ['new', 'contacted', 'viewing', 'negotiating'];
const INTERESTS = ['buy', 'rent', 'land', 'off_plan', 'property_management', 'construction', 'architecture', 'consultation', 'other'];
const SOURCES = ['website', 'whatsapp', 'facebook', 'instagram', 'tiktok', 'linkedin', 'phone', 'walk-in', 'referral', 'other'];
const LOST_REASONS = ['budget', 'bought_elsewhere', 'no_response', 'not_serious', 'location', 'other'];
// Days until the next follow-up is due when a lead moves into a stage and
// nobody has chosen a date. This is what keeps leads from going quiet.
const FOLLOW_UP_DAYS = { new: 0, contacted: 2, viewing: 1, negotiating: 2 };

const OPEN_SQL = OPEN_STAGES.map((s) => `'${s}'`).join(',');

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

// Ghana numbers arrive as 024…, +233 24…, 233-24… and so on. Comparing the last
// nine digits treats them all as the same person.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

// International digits for a wa.me link, assuming a Ghana number when it
// starts with a local 0.
function toWaNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 9) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.length === 9) return `233${digits}`;
  return digits;
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
      role TEXT NOT NULL DEFAULT 'agent',
      active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      phone_key TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      interest TEXT NOT NULL DEFAULT 'other',
      budget TEXT NOT NULL DEFAULT '',
      property_ref TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'website',
      stage TEXT NOT NULL DEFAULT 'new',
      agent_id INTEGER REFERENCES users(id),
      next_follow_up TEXT,
      deal_value INTEGER,
      lost_reason TEXT NOT NULL DEFAULT '',
      repeat_count INTEGER NOT NULL DEFAULT 0,
      first_response_at TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lead_notes (
      id INTEGER PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
    CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads(agent_id);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_key);
    CREATE INDEX IF NOT EXISTS idx_notes_lead ON lead_notes(lead_id);
  `);
  return db;
}

const getSetting = (db, key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
};
const setSetting = (db, key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, value);

const daysFromNow = (db, n) => db.prepare("SELECT date('now', ?) AS d").get(`${n >= 0 ? '+' : ''}${n} days`).d;

// The active agent with the fewest open leads, so new enquiries are shared out
// evenly. Returns null when automatic assignment is switched off.
function pickAgent(db) {
  if (getSetting(db, 'auto_assign', 'on') !== 'on') return null;
  const row = db.prepare(`SELECT u.id FROM users u WHERE u.role = 'agent' AND u.active = 1
    ORDER BY (SELECT COUNT(*) FROM leads l WHERE l.agent_id = u.id AND l.stage IN (${OPEN_SQL})), u.id LIMIT 1`).get();
  return row ? row.id : null;
}

const addNote = (db, leadId, note, author) => db.prepare('INSERT INTO lead_notes (lead_id, note, author) VALUES (?, ?, ?)').run(leadId, note, author);

// Single entry point for every new enquiry, whichever channel it came from.
// If the person already has an open lead (same phone or email) the new message
// is added to it, and its follow-up is brought forward to today, instead of
// creating a duplicate that two agents might both chase.
function captureLead(db, lead, { actor = 'system' } = {}) {
  const phoneKey = normalizePhone(lead.phone);
  const email = String(lead.email || '').toLowerCase();
  const existing = db.prepare(`SELECT * FROM leads WHERE stage IN (${OPEN_SQL})
    AND ((? != '' AND phone_key = ?) OR (? != '' AND lower(email) = ?)) ORDER BY id LIMIT 1`).get(phoneKey, phoneKey, email, email);

  if (existing) {
    const detail = [`Enquired again via ${lead.source}`, lead.property_ref && `about ${lead.property_ref}`, lead.message && `“${lead.message}”`].filter(Boolean).join(' ');
    addNote(db, existing.id, `${detail}.`, actor);
    db.prepare("UPDATE leads SET repeat_count = repeat_count + 1, next_follow_up = date('now'), updated_at = datetime('now') WHERE id = ?").run(existing.id);
    return { id: existing.id, duplicate: true };
  }

  const agentId = lead.agent_id ?? pickAgent(db);
  const result = db.prepare(`INSERT INTO leads (name, phone, phone_key, email, interest, budget, property_ref, message, source, agent_id, next_follow_up)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(lead.name, lead.phone || '', phoneKey, lead.email || '', lead.interest || 'other', lead.budget || '', lead.property_ref || '',
      lead.message || '', lead.source || 'website', agentId, lead.next_follow_up || daysFromNow(db, 0));
  const id = Number(result.lastInsertRowid);
  if (agentId) {
    const agent = db.prepare('SELECT name FROM users WHERE id = ?').get(agentId);
    addNote(db, id, `Assigned to ${agent.name}${lead.agent_id == null ? ' automatically' : ''}.`, actor);
  }
  return { id, duplicate: false };
}

module.exports = {
  openDb, hashPassword, verifyPassword, normalizePhone, toWaNumber, captureLead, pickAgent, addNote, daysFromNow,
  getSetting, setSetting,
  STAGES, OPEN_STAGES, OPEN_SQL, INTERESTS, SOURCES, LOST_REASONS, FOLLOW_UP_DAYS,
};
