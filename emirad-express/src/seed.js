// Sample data so the demo is browsable. Every customer, rider, parcel and price
// here is fictional and must be removed before real use. Dates are relative to
// today so the demo always looks current.
const crypto = require('node:crypto');
const { hashPassword, quote, dueDate, addEvent, TRACKING_ALPHABET, STATUS_TEXT, FAIL_TEXT, ZONES } = require('./db');

// Sample tracking numbers are the same every time the demo starts. A hosting
// platform may run several copies of the app, and the numbers shown on the home
// page must work on all of them.
function demoTracking(db, i) {
  for (let salt = 0; ; salt += 1) {
    const bytes = crypto.createHash('sha256').update(`emirad-demo-${i}-${salt}`).digest();
    const chars = Array.from(bytes.subarray(0, 8), (b) => TRACKING_ALPHABET[b % TRACKING_ALPHABET.length]).join('');
    const code = `EE-${chars.slice(0, 4)}-${chars.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM shipments WHERE tracking = ?').get(code)) return code;
  }
}

function seedManager(db, { user, password }) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, 'Dispatch office', 'manager', ?)").run(user, hashPassword(password));
  }
}

// The route each target status has taken, so history looks like real handling.
const PATH = {
  booked: ['booked'],
  pickup_scheduled: ['booked', 'pickup_scheduled'],
  picked_up: ['booked', 'pickup_scheduled', 'picked_up'],
  out_for_delivery: ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery'],
  delivered: ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'delivered'],
  failed: ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed'],
  returned: ['booked', 'pickup_scheduled', 'picked_up', 'out_for_delivery', 'failed', 'returned'],
  cancelled: ['booked', 'cancelled'],
};

function seedDemo(db, { password }) {
  if (db.prepare('SELECT 1 FROM shipments LIMIT 1').get()) return;
  const hash = hashPassword(password);
  const user = (username, name, role, extra = {}) => Number(db.prepare(
    'INSERT INTO users (username, name, role, company, phone, address, zone, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, name, role, extra.company || '', extra.phone || '', extra.address || '', extra.zone || '', hash).lastInsertRowid);
  const riders = { kofi: user('kofi', 'Kofi Mensah', 'rider', { phone: '024 800 0001' }), esi: user('esi', 'Esi Owusu', 'rider', { phone: '055 800 0002' }), musah: user('musah', 'Musah Ibrahim', 'rider', { phone: '020 800 0003' }) };
  const biz = {
    shopnest: user('shopnest', 'Nana Adjei', 'business', { company: 'ShopNest Online', phone: '024 810 0001', address: 'Shop 14, Haatso Market', zone: 'Haatso' }),
    glow: user('glow', 'Abena Sarpong', 'business', { company: 'Glow Beauty Supplies', phone: '055 810 0002', address: '3 Palm Street, Haatso', zone: 'Haatso' }),
  };

  const names = ['Akosua Boateng', 'Yaw Darko', 'Efua Quaye', 'Kwame Tetteh', 'Ama Ofori', 'Joseph Nyarko', 'Grace Adu', 'Isaac Bonsu', 'Mavis Asante', 'Daniel Amoah'];
  const streets = ['12 Oak Avenue', '7 Church Street', 'House 23, Ridge Road', '5 Market Lane', 'Plot 9, Station Road', '18 School Junction', '31 Palm Close'];
  const guests = [['Samuel Ayeh', '024 820 0001', 'Haatso'], ['Linda Mensah', '020 820 0002', 'Madina'], ['Peter Anim', '055 820 0003', 'Dome']];

  const insert = db.prepare(`INSERT INTO shipments (tracking, business_id, rider_id, source, sender_name, sender_phone, pickup_address, pickup_zone,
      receiver_name, receiver_phone, delivery_address, delivery_zone, description, weight_kg, service, payment_mode, price, cod_amount, status,
      due_date, attempts, failure_reason, delivered_to, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const cash = db.prepare('INSERT INTO cash_items (shipment_id, rider_id, kind, expected, collected, collected_at, remitted_at, remitted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const stamp = (base, minutes) => db.prepare("SELECT min(datetime(?, ?), datetime('now')) AS t").get(base, `+${minutes} minutes`).t;

  // [daysAgo, hour, service, status, business, rider, payment, cod, pickupZone, deliveryZone, weightKg, description, failedAttempts, failReason]
  const specs = [
    [0, 8, 'same_day', 'out_for_delivery', null, 'kofi', 'sender_cash', 0, 'Haatso', 'East Legon', 1, 'Signed contract documents', 0],
    [0, 9, 'same_day', 'picked_up', null, 'esi', 'receiver_cash', 0, 'Madina', 'Osu / Labone', 2, 'Laptop charger', 0],
    [0, 10, 'same_day', 'booked', null, null, 'sender_cash', 0, 'Haatso', 'Airport / Cantonments', 1, 'Birthday gift', 0],
    [0, 7, 'next_day', 'pickup_scheduled', 'shopnest', 'musah', 'account', 250, 'Haatso', 'Adenta', 3, 'Sneakers', 0],
    [0, 9, 'next_day', 'booked', 'glow', null, 'account', 180, 'Haatso', 'Spintex', 2, 'Skincare set', 0],
    [1, 9, 'same_day', 'delivered', null, 'kofi', 'sender_cash', 0, 'Dome', 'Achimota', 1, 'Passport photos', 0],
    [1, 10, 'next_day', 'delivered', 'shopnest', 'esi', 'account', 320, 'Haatso', 'Madina', 2, 'Handbag', 0],
    [1, 11, 'next_day', 'failed', 'glow', 'musah', 'account', 150, 'Haatso', 'Tema', 2, 'Hair products', 1, 'not_home'],
    [2, 9, 'standard', 'out_for_delivery', 'shopnest', 'kofi', 'account', 0, 'Haatso', 'Kasoa', 5, 'Bulk fabric', 0],
    [2, 14, 'next_day', 'delivered', 'glow', 'esi', 'account', 275, 'Haatso', 'Accra Central', 2, 'Makeup kit', 0],
    [3, 8, 'same_day', 'delivered', null, 'musah', 'receiver_cash', 500, 'Legon', 'East Legon', 4, 'Phone, cash on delivery', 0],
    [3, 10, 'next_day', 'delivered', 'shopnest', 'kofi', 'account', 410, 'Haatso', 'Dome', 3, 'Shoes', 0],
    [3, 9, 'next_day', 'out_for_delivery', 'shopnest', 'musah', 'account', 280, 'Haatso', 'Adenta', 2, 'Handbag', 0],
    [4, 9, 'next_day', 'returned', 'glow', 'esi', 'account', 199, 'Haatso', 'Adenta', 2, 'Perfume', 3, 'refused'],
    [4, 13, 'standard', 'delivered', null, 'kofi', 'sender_cash', 0, 'Haatso', 'Tema', 8, 'Printer toner', 0],
    [5, 9, 'next_day', 'delivered', 'shopnest', 'musah', 'account', 360, 'Haatso', 'Spintex', 3, 'Jeans', 0],
    [5, 15, 'same_day', 'cancelled', null, null, 'sender_cash', 0, 'Madina', 'Haatso', 1, 'Documents', 0],
    [6, 9, 'next_day', 'delivered', 'glow', 'esi', 'account', 220, 'Haatso', 'Osu / Labone', 2, 'Skincare', 0],
    [7, 10, 'next_day', 'delivered', 'shopnest', 'kofi', 'account', 300, 'Haatso', 'Achimota', 2, 'Sandals', 0],
    [8, 9, 'standard', 'delivered', 'glow', 'musah', 'account', 0, 'Haatso', 'Kasoa', 6, 'Hair extensions', 0],
    [9, 11, 'same_day', 'delivered', null, 'esi', 'sender_cash', 0, 'Haatso', 'Madina', 1, 'House keys', 0],
  ];

  const codes = [];
  specs.forEach(([daysAgo, hour, service, status, business, rider, payment, cod, pz, dz, kg, description, failedAttempts, failReason], i) => {
    const b = business ? db.prepare('SELECT * FROM users WHERE id = ?').get(biz[business]) : null;
    const g = guests[i % guests.length];
    const sender = b ? { name: b.company, phone: b.phone, address: b.address, zone: b.zone } : { name: g[0], phone: g[1], address: streets[i % streets.length], zone: pz };
    const pickupZone = b ? b.zone : pz;
    const receiver = names[i % names.length];
    const created = db.prepare("SELECT datetime(date('now', ?), ?) AS t").get(`-${daysAgo} days`, `+${hour} hours`).t;
    const createdDate = created.slice(0, 10);
    const q = quote(service, pickupZone, dz, kg);
    const attempts = status === 'failed' ? failedAttempts : status === 'returned' ? failedAttempts : 0;
    const steps = PATH[status];
    const closedAt = ['delivered', 'returned', 'cancelled'].includes(status) ? stamp(created, steps.length * 70) : null;
    const tracking = demoTracking(db, i);
    const id = Number(insert.run(tracking, b ? b.id : null, rider ? riders[rider] : null, b ? 'account' : (i % 2 ? 'phone' : 'web'), sender.name, sender.phone, sender.address,
      pickupZone, receiver, `0${24 + (i % 4)} 83${i % 10} ${1000 + i * 37}`, streets[(i + 3) % streets.length], dz, description, kg, service, payment, q.price, cod, status,
      dueDate(db, service, createdDate, hour), attempts, status === 'failed' || status === 'returned' ? failReason : '', status === 'delivered' ? receiver : '',
      created, stamp(created, steps.length * 70), closedAt).lastInsertRowid);
    steps.forEach((step, k) => {
      let text = STATUS_TEXT[step];
      if (step === 'failed' || (step === 'returned' && failReason)) text = step === 'failed' ? `${STATUS_TEXT.failed}: ${FAIL_TEXT[failReason]}` : STATUS_TEXT.returned;
      if (step === 'delivered') text += ` to ${receiver}`;
      addEvent(db, id, step, text, { at: stamp(created, k * 70), by: step === 'booked' ? sender.name : rider ? 'Rider' : 'Office' });
    });
    if (status === 'delivered' || status === 'picked_up' || status === 'out_for_delivery') {
      const riderId = riders[rider];
      const older = daysAgo >= 4; // older cash has already been handed in
      if (payment === 'sender_cash' && PATH[status].includes('picked_up')) {
        cash.run(id, riderId, 'pickup_fee', q.price, q.price, stamp(created, 140), older ? stamp(created, 900) : null, older ? 'Dispatch office' : '');
      }
      if (status === 'delivered') {
        const expected = cod + (payment === 'receiver_cash' ? q.price : 0);
        if (expected > 0) {
          const short = i === 10 ? 20 : 0; // one rider handed in less than expected
          cash.run(id, riderId, 'delivery_collection', expected, expected - short, stamp(created, 260), older ? stamp(created, 900) : null, older ? 'Dispatch office' : '');
        }
      }
    }
    codes.push([tracking, status]);
  });
  return { codes, zones: Object.keys(ZONES).length };
}

module.exports = { seedManager, seedDemo };
