// Sample data so the demo is browsable. Every listing and enquiry here is
// fictional and must be replaced with the client's real stock before launch.
// Photographs are free-licence stock images used as placeholders.
const { hashPassword } = require('./db');

const img = (name) => `/img/${name}-lg.jpg`;

// [ref, title, type, listing, location, price, currency, beds, baths, sqm, featured, description, photo, more photos]
const properties = [
  ['RV-101', '4-bedroom detached house', 'house', 'sale', 'East Legon', 420000, 'USD', 4, 5, 380, 1,
    'Detached family home on a quiet street with staff quarters, a fitted kitchen, backup power and parking for three cars. Large living and dining areas open onto a covered terrace.',
    'villa-dusk', ['int-living-warm', 'int-kitchen-faucet', 'int-bedroom-grey', 'villa-palms']],
  ['RV-102', '2-bedroom furnished apartment', 'apartment', 'rent', 'Cantonments', 2200, 'USD', 2, 2, 120, 1,
    'Furnished apartment in a gated block with pool, gym, 24-hour security and a standby generator. Price is per month.',
    'apt-bright', ['apt-kitchen', 'apt-living-sofa', 'int-bedroom-blue', 'apt-block-blue']],
  ['RV-103', '3-bedroom townhouse', 'townhouse', 'sale', 'Tse Addo', 245000, 'USD', 3, 4, 210, 1,
    'New townhouse in a 12-unit gated community. A flexible payment plan is available during construction.',
    'house-wood-panel', ['int-open-plan', 'apt-kitchen-2', 'int-living-scandi']],
  ['RV-104', 'Serviced residential plot', 'land', 'sale', 'Oyarifa', 380000, 'GHS', null, null, 650, 0,
    'Registered and demarcated plot in a serviced estate with access roads, drainage and electricity at the boundary.',
    'ld-plot-grass', ['ld-estate-aerial', 'ld-site', 'ld-sign-man']],
  ['RV-105', 'Ground-floor office space', 'commercial', 'rent', 'Airport Residential', 3500, 'USD', null, 2, 180, 0,
    'Open-plan office with reception, two meeting rooms and dedicated parking. Price is per month.',
    'gh-office', ['gh-cranes', 'int-open-plan-2', 'apt-block-dark']],
  ['RV-106', '3-bedroom semi-detached house', 'house', 'sale', 'Spintex', 1650000, 'GHS', 3, 3, 190, 0,
    'Semi-detached home close to Spintex Road with boys’ quarters and a tiled compound.',
    'house-stucco', ['int-living-grey', 'apt-dining', 'int-bedroom-blue']],
  ['RV-107', '1-bedroom apartment', 'apartment', 'rent', 'Osu', 900, 'USD', 1, 1, 65, 0,
    'Compact apartment a short walk from Oxford Street. Water storage and a prepaid meter are included. Price is per month.',
    'apt-living-blue', ['apt-kitchen', 'int-bedroom-grey', 'apt-block-dark']],
  ['RV-108', '5-bedroom executive house', 'house', 'sale', 'Trasacco', 890000, 'USD', 5, 6, 520, 1,
    'Executive home with pool, home office, cinema room and landscaped garden in a secured estate.',
    'villa-pool-white', ['villa-flat-roof', 'int-living-leather', 'int-open-plan', 'villa-pool-modern']],
  ['RV-109', '4-bedroom villa with pool', 'house', 'sale', 'Labone', 650000, 'USD', 4, 4, 340, 0,
    'Colonial-style villa with a heated pool, wrap-around balcony and mature tropical garden, minutes from Oxford Street.',
    'villa-tropical', ['int-living-arch', 'int-kitchen-faucet', 'int-bedroom-blue']],
  ['RV-110', '3-bedroom modern house', 'house', 'sale', 'Adjiringanor', 310000, 'USD', 3, 3, 240, 0,
    'Contemporary home with an open-plan kitchen, solar-ready roof and a pool-ready garden in a gated estate.',
    'house-pool-2', ['int-open-plan-2', 'apt-kitchen-2', 'int-living-boho']],
  ['RV-111', 'Prime plot in a planned estate', 'land', 'sale', 'Airport Hills', 280000, 'USD', null, null, 900, 0,
    'Corner plot in a planned estate with surfaced roads, street lighting and an on-site management office.',
    'ld-luxury-aerial', ['ld-estate-aerial', 'ld-sign-man']],
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
    (ref, title, type, listing, location, price, currency, bedrooms, bathrooms, size_sqm, featured, description, image_url, gallery)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of properties) insertProperty.run(...p.slice(0, 12), img(p[12]), p[13].map(img).join('\n'));

  const insertEnquiry = db.prepare(`INSERT INTO enquiries
    (property_id, name, phone, email, message, source, status, assigned_to, next_follow_up)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE date('now', ? || ' days') END)`);
  for (const e of enquiries) {
    const offset = e[8];
    insertEnquiry.run(...e.slice(0, 8), offset, offset === null ? null : String(offset));
  }
}

module.exports = { seed };
