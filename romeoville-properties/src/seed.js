// Sample data so the demo is browsable. Every listing and enquiry here is
// fictional and must be replaced with the client's real stock before launch.
const { hashPassword } = require('./db');

const properties = [
  ['RV-101', '4-bedroom detached house', 'house', 'sale', 'East Legon', 420000, 'USD', 4, 5, 380, 1,
    'Detached family home on a quiet street with staff quarters, fitted kitchen, backup power and parking for three cars.'],
  ['RV-102', '2-bedroom furnished apartment', 'apartment', 'rent', 'Cantonments', 2200, 'USD', 2, 2, 120, 1,
    'Furnished apartment in a gated block with pool, gym, 24-hour security and standby generator. Price is per month.'],
  ['RV-103', '3-bedroom townhouse', 'townhouse', 'sale', 'Tse Addo', 245000, 'USD', 3, 4, 210, 1,
    'New townhouse in a 12-unit gated community. Flexible payment plan available during construction.'],
  ['RV-104', 'Serviced residential plot', 'land', 'sale', 'Oyarifa', 380000, 'GHS', null, null, 650, 0,
    'Registered and demarcated plot in a serviced estate with access roads, drainage and electricity at the boundary.'],
  ['RV-105', 'Ground-floor office space', 'commercial', 'rent', 'Airport Residential', 3500, 'USD', null, 2, 180, 0,
    'Open-plan office with reception, two meeting rooms and dedicated parking. Price is per month.'],
  ['RV-106', '3-bedroom semi-detached house', 'house', 'sale', 'Spintex', 1650000, 'GHS', 3, 3, 190, 0,
    'Semi-detached home close to the Spintex Road with boys’ quarters and a tiled compound.'],
  ['RV-107', '1-bedroom apartment', 'apartment', 'rent', 'Osu', 900, 'USD', 1, 1, 65, 0,
    'Compact apartment a short walk from Oxford Street. Water storage and prepaid meter included.'],
  ['RV-108', '5-bedroom executive house', 'house', 'sale', 'Trasacco', 890000, 'USD', 5, 6, 520, 0,
    'Executive home with pool, home office, cinema room and landscaped garden in a secured estate.'],
];

const enquiries = [
  [1, 'Abena Mensah', '+233 24 000 0001', '', 'Is the price negotiable? I would like to view this weekend.', 'website', 'viewing', 'Kofi', 1],
  [3, 'Daniel Owusu', '+233 20 000 0002', 'daniel@example.com', 'Please send the payment plan for the townhouse.', 'whatsapp', 'contacted', 'Ama', -1],
  [2, 'Sarah Lindqvist', '', 'sarah@example.com', 'Relocating in January, looking for a 12-month lease.', 'website', 'new', '', null],
  [null, 'Yaw Boateng', '+233 55 000 0003', '', 'Looking for land around Oyarifa or Adenta, budget GHS 400k.', 'phone', 'negotiating', 'Kofi', 0],
  [5, 'Nana Adjei', '+233 27 000 0004', '', 'Need office space for a team of 15.', 'social', 'lost', 'Ama', null],
];

function seed(db, { adminUser, adminPassword }) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(adminUser, hashPassword(adminPassword));
  }
  if (db.prepare('SELECT 1 FROM properties LIMIT 1').get()) return;

  const insertProperty = db.prepare(`INSERT INTO properties
    (ref, title, type, listing, location, price, currency, bedrooms, bathrooms, size_sqm, featured, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of properties) insertProperty.run(...p);

  const insertEnquiry = db.prepare(`INSERT INTO enquiries
    (property_id, name, phone, email, message, source, status, assigned_to, next_follow_up)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE date('now', ? || ' days') END)`);
  for (const e of enquiries) {
    const offset = e[8];
    insertEnquiry.run(...e.slice(0, 8), offset, offset === null ? null : String(offset));
  }
}

module.exports = { seed };
