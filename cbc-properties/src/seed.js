// Sample data so the demo is browsable. Every estate, plot, customer and
// payment here is fictional and must be replaced with real records before use.
const { hashPassword, createSale, syncPlotStatus } = require('./db');

// [code, name, location, description, photo]. Photos are free-licence stock placeholders.
const estates = [
  ['OYH', 'Oyarifa Hills', 'Oyarifa, Accra', 'Registered residential plots on high ground with graded access roads and electricity at the boundary.', '/img/ld-estate-aerial-lg.jpg'],
  ['DDG', 'Dodowa Gardens', 'Dodowa, Greater Accra', 'Affordable plots in a planned layout, a short drive from the Dodowa main road. Flexible payment plans.', '/img/ld-suburb2-lg.jpg'],
];

// [estate index, plot no, dimensions, size m², price GH₵, demarcation]
const plots = [
  [0, '01', '70 × 100 ft', 650, 420000, 'pillared'], [0, '02', '70 × 100 ft', 650, 420000, 'pillared'],
  [0, '03', '70 × 100 ft', 650, 400000, 'pillared'], [0, '04', '80 × 100 ft', 743, 470000, 'surveyed'],
  [0, '05', '80 × 100 ft', 743, 470000, 'surveyed'], [0, '06', '100 × 100 ft', 929, 580000, 'surveyed'],
  [0, '07', '100 × 100 ft', 929, 600000, 'not_started'],
  [1, '01', '70 × 100 ft', 650, 150000, 'pillared'], [1, '02', '70 × 100 ft', 650, 150000, 'pillared'],
  [1, '03', '70 × 100 ft', 650, 145000, 'surveyed'], [1, '04', '70 × 100 ft', 650, 145000, 'surveyed'],
  [1, '05', '50 × 70 ft', 325, 85000, 'surveyed'], [1, '06', '50 × 70 ft', 325, 85000, 'not_started'],
  [1, '07', '100 × 100 ft', 929, 210000, 'not_started'],
];

function seed(db, { adminUser, adminPassword }) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(adminUser, hashPassword(adminPassword));
  }
  if (db.prepare('SELECT 1 FROM estates LIMIT 1').get()) return;

  const addEstate = db.prepare('INSERT INTO estates (code, name, location, description, image_url) VALUES (?, ?, ?, ?, ?)');
  estates.forEach((e) => addEstate.run(...e));
  const addPlot = db.prepare('INSERT INTO plots (estate_id, plot_no, ref, dimensions, size_sqm, price, demarcation) VALUES (?, ?, ?, ?, ?, ?, ?)');
  plots.forEach(([e, no, dim, size, price, dem]) => addPlot.run(e + 1, no, `${estates[e][0]}-${no}`, dim, size, price, dem));

  const day = (offset) => db.prepare("SELECT date('now', ? || ' days') AS d").get(String(offset)).d;
  const pay = db.prepare('INSERT INTO payments (sale_id, amount, paid_on, method, reference) VALUES (?, ?, ?, ?, ?)');
  const tick = db.prepare("UPDATE milestones SET done_on = ?, done_by = 'admin' WHERE sale_id = ? AND position = ?");

  // Fully paid, documents nearly complete.
  let id = createSale(db, { plot_id: 1, customer_name: 'Akosua Darko', phone: '+233 24 000 0011', agreed_price: 420000, handled_by: 'Kojo', reservation_expires: day(-60) });
  pay.run(id, 20000, day(-75), 'mobile money', 'MM-48211'); pay.run(id, 400000, day(-50), 'bank transfer', 'TRF-9917');
  [-75, -73, -68, -60, -55, -50, -30].forEach((d, i) => tick.run(day(d), id, i + 1));
  db.prepare("UPDATE plots SET demarcation = 'handed_over' WHERE id = 1").run();
  syncPlotStatus(db, 1);

  // Paying by instalments.
  id = createSale(db, { plot_id: 8, customer_name: 'Emmanuel Tetteh', phone: '+233 20 000 0012', email: 'emmanuel@example.com', agreed_price: 150000, handled_by: 'Abena', reservation_expires: day(-20) });
  pay.run(id, 10000, day(-34), 'cash', 'RCPT-0102'); pay.run(id, 50000, day(-21), 'bank transfer', 'TRF-1043');
  [-34, -32, -21].forEach((d, i) => tick.run(day(d), id, i + 1));
  syncPlotStatus(db, 8);

  // Reservation that has lapsed with only the fee paid.
  id = createSale(db, { plot_id: 4, customer_name: 'Grace Ofori', phone: '+233 55 000 0013', agreed_price: 460000, handled_by: 'Kojo', reservation_expires: day(-3) });
  pay.run(id, 5000, day(-17), 'mobile money', 'MM-51870');
  tick.run(day(-17), id, 1);
  syncPlotStatus(db, 4);
  // Date each sample reservation from its first payment.
  db.exec('UPDATE sales SET reserved_on = (SELECT MIN(paid_on) FROM payments WHERE sale_id = sales.id)');

  const addEnquiry = db.prepare(`INSERT INTO enquiries (plot_id, name, phone, email, message, source, status, assigned_to, next_follow_up)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  addEnquiry.run(2, 'Kwabena Appiah', '+233 24 000 0021', '', 'Is the land registered? Can I visit on Saturday?', 'website', 'site_visit', 'Abena', day(1));
  addEnquiry.run(9, 'Linda Quaye', '+233 27 000 0022', 'linda@example.com', 'Please send the payment plan for Dodowa.', 'whatsapp', 'contacted', 'Kojo', day(-2));
  addEnquiry.run(null, 'Joseph Amoah', '', 'joseph@example.com', 'I live abroad and want two plots side by side.', 'website', 'new', '', day(0));
  addEnquiry.run(6, 'Mavis Addo', '+233 54 000 0023', '', 'Budget is GH₵550,000. Any discount for full payment?', 'referral', 'negotiating', 'Kojo', day(0));
}

module.exports = { seed };
