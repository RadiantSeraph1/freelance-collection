const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const TYPES = ['house', 'apartment', 'townhouse', 'land', 'commercial'];
const LISTINGS = ['sale', 'rent'];
const PROPERTY_STATUSES = ['available', 'under_offer', 'sold'];
const CURRENCIES = ['USD', 'GHS'];
const SOURCES = ['website', 'whatsapp', 'phone', 'walk-in', 'social', 'referral'];
const ENQUIRY_STATUSES = ['new', 'contacted', 'viewing', 'negotiating', 'won', 'lost'];
const OPEN_STATUSES = ['new', 'contacted', 'viewing', 'negotiating'];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
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
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY,
      ref TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      listing TEXT NOT NULL,
      location TEXT NOT NULL,
      price INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      bedrooms INTEGER,
      bathrooms INTEGER,
      size_sqm INTEGER,
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS idx_enquiries_status ON enquiries(status);
    CREATE INDEX IF NOT EXISTS idx_enquiries_follow_up ON enquiries(next_follow_up);
  `);
  return db;
}

function nextRef(db) {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(ref, 4) AS INTEGER)) AS n FROM properties").get();
  return `RV-${String((row.n || 100) + 1)}`;
}

module.exports = {
  openDb, hashPassword, verifyPassword, nextRef,
  TYPES, LISTINGS, PROPERTY_STATUSES, CURRENCIES, SOURCES, ENQUIRY_STATUSES, OPEN_STATUSES,
};
