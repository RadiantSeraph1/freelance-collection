// Sample data so the demo is browsable. Every landlord, tenant, property and
// figure here is fictional. Dates are relative to today so the demo always
// looks current.
const { hashPassword, ensureCharges, dueDateFor, addMonths } = require('./db');

function seedManager(db, { user, password }) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, 'Office manager', 'manager', ?)").run(user, hashPassword(password));
  }
}

function seedDemo(db, { password }) {
  if (db.prepare('SELECT 1 FROM properties LIMIT 1').get()) return;
  const hash = hashPassword(password);
  const sql = (query, ...p) => db.prepare(query).get(...p);
  const date = (modifier, base = 'now') => sql('SELECT date(?, ?) AS d', base, modifier).d;
  const monthStart = (offset) => sql("SELECT date('now', 'start of month', ?) AS d", `${offset} months`).d;
  const today = date('+0 days');
  const thisPeriod = today.slice(0, 7);

  const user = (username, name, role, phone, email = '') => Number(db.prepare(
    'INSERT INTO users (username, name, role, phone, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)').run(username, name, role, phone, email, hash).lastInsertRowid);
  const kwesi = user('kboateng', 'Kwesi Boateng', 'landlord', '024 600 0001', 'kwesi@example.com');
  const adwoa = user('asarpong', 'Adwoa Sarpong', 'landlord', '055 600 0002', 'adwoa@example.com');
  const tenants = {
    ama: user('ama', 'Ama Owusu', 'tenant', '024 600 0011'), kojo: user('kojo', 'Kojo Mensah', 'tenant', '020 600 0012'),
    efua: user('efua', 'Efua Addo', 'tenant', '027 600 0013'), yaw: user('yaw', 'Yaw Asare', 'tenant', '054 600 0014'),
    nana: user('nana', 'Nana Kwesi', 'tenant', '026 600 0015'), linda: user('linda', 'Linda Quaye', 'tenant', '050 600 0016'),
  };

  const addProperty = db.prepare('INSERT INTO properties (landlord_id, name, address, area, fee_percent) VALUES (?, ?, ?, ?, ?)');
  const addUnit = db.prepare('INSERT INTO units (property_id, label, bedrooms, bathrooms, asking_rent, currency, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const prop = (landlord, name, address, area, fee) => Number(addProperty.run(landlord, name, address, area, fee).lastInsertRowid);
  const unit = (property, label, beds, baths, rent, currency, description) => Number(addUnit.run(property, label, beds, baths, rent, currency, description).lastInsertRowid);

  const court = prop(kwesi, 'Boateng Court', '14 Lagos Avenue', 'East Legon', 10);
  const residences = prop(adwoa, 'Sarpong Residences', '7 Fifth Street', 'Cantonments', 8);
  const villa = prop(kwesi, 'Tse Addo Villa', 'Plot 22, Beach Road', 'Tse Addo', 10);
  const units = {
    a1: unit(court, 'A1', 2, 2, 1200, 'USD', 'Bright two-bedroom apartment with a balcony and backup power.'),
    a2: unit(court, 'A2', 2, 2, 1200, 'USD', 'Two-bedroom apartment on the first floor.'),
    b1: unit(court, 'B1', 1, 1, 4500, 'GHS', 'One-bedroom apartment with parking, close to shops.'),
    u101: unit(residences, '101', 3, 3, 2000, 'USD', 'Spacious three-bedroom apartment in a gated block.'),
    u102: unit(residences, '102', 2, 2, 7000, 'GHS', 'Two-bedroom apartment with a pool view.'),
    u103: unit(residences, '103', 1, 1, 5000, 'GHS', 'One-bedroom apartment, 24-hour security and gym access.'),
    u201: unit(residences, '201', 0, 1, 700, 'USD', 'Furnished studio apartment.'),
    house: unit(villa, 'Main house', 4, 5, 3500, 'USD', 'Four-bedroom beachside house with a garden and staff quarters.'),
  };

  const addTenancy = db.prepare('INSERT INTO tenancies (unit_id, tenant_id, rent, currency, due_day, start_date, end_date, deposit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const tenancy = (unitKey, tenant, rent, currency, dueDay, startOffset, endDate, deposit) =>
    Number(addTenancy.run(units[unitKey], tenants[tenant], rent, currency, dueDay, monthStart(startOffset), endDate, deposit).lastInsertRowid);
  const t = {
    ama: tenancy('a1', 'ama', 1200, 'USD', 1, -4, null, 2400),
    kojo: tenancy('a2', 'kojo', 1200, 'USD', 1, -5, null, 2400),
    efua: tenancy('u101', 'efua', 2000, 'USD', 5, -4, date('+25 days'), 4000),
    yaw: tenancy('u102', 'yaw', 7000, 'GHS', 1, -3, null, 14000),
    nana: tenancy('u201', 'nana', 700, 'USD', 25, -3, null, 1400),
    linda: tenancy('house', 'linda', 3500, 'USD', 1, -2, null, 7000),
  };
  ensureCharges(db);

  // Pay the charge for each listed month offset (0 = this month), two days after it fell due, or today if that is still ahead.
  const pay = db.prepare('INSERT INTO payments (tenancy_id, amount, paid_on, method, reference, recorded_by) VALUES (?, ?, ?, ?, ?, ?)');
  const methods = ['bank transfer', 'mobile money', 'bank transfer'];
  const payMonths = (tenancyId, rent, dueDay, offsets, partial = {}) => offsets.forEach((offset, i) => {
    const period = addMonths(thisPeriod, offset);
    const due = dueDateFor(period, dueDay);
    const paidOn = date('+2 days', due) < today ? date('+2 days', due) : today;
    pay.run(tenancyId, partial[offset] ?? rent, paidOn, methods[i % 3], `REF-${tenancyId}${String(i).padStart(2, '0')}`, 'Office manager');
  });
  payMonths(t.ama, 1200, 1, [-4, -3, -2, -1, 0]);
  payMonths(t.kojo, 1200, 1, [-5, -4, -3, -2]);                         // nothing for last month or this month
  payMonths(t.efua, 2000, 5, [-4, -3, -2], { [-2]: 1000 });             // last paid month was half paid
  payMonths(t.yaw, 7000, 1, [-3, -2, -1, 0]);
  payMonths(t.nana, 700, 25, [-3, -2, -1]);                             // this month's rent falls due on the 25th
  payMonths(t.linda, 3500, 1, [-2, -1, 0]);

  const request = db.prepare(`INSERT INTO maintenance (unit_id, reported_by, title, description, priority, status, contractor, cost, cost_currency, charge_landlord, created_at, updated_at, completed_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), ?)`);
  const note = db.prepare('INSERT INTO maintenance_notes (request_id, note, author) VALUES (?, ?, ?)');
  const r1 = Number(request.run(units.a2, tenants.kojo, 'Leaking bathroom tap', 'The tap in the main bathroom drips all night.', 'normal', 'in_progress', 'Kwame Plumbing', 0, 'GHS', 1, '-5 days', '-1 days', null).lastInsertRowid);
  note.run(r1, 'Plumber booked for Thursday morning.', 'Office manager');
  request.run(units.u101, tenants.efua, 'Air conditioner not cooling', 'The living room AC runs but the air is warm.', 'urgent', 'open', '', 0, 'GHS', 1, '-2 days', '-2 days', null);
  const r3 = Number(request.run(units.a1, null, 'Replace broken gate lock', 'Reported by the security guard.', 'normal', 'done', 'Mensah Locksmith', 450, 'GHS', 1, '-40 days', '-30 days', date('+9 days', monthStart(-1))).lastInsertRowid);
  note.run(r3, 'New lock fitted and three keys handed to the tenant.', 'Office manager');
  request.run(units.u201, tenants.nana, 'Ceiling stain after rain', 'A brown stain has appeared above the bed.', 'normal', 'scheduled', 'Asare Roofing', 0, 'GHS', 1, '-8 days', '-3 days', null);
  request.run(units.house, null, 'Generator service', 'Annual service and oil change.', 'low', 'done', 'PowerFix Ltd', 1200, 'GHS', 1, '-14 days', '-10 days', date('-10 days'));

  const inspect = db.prepare('INSERT INTO inspections (unit_id, inspected_on, kind, inspector, summary) VALUES (?, ?, ?, ?, ?)');
  const item = db.prepare('INSERT INTO inspection_items (inspection_id, area, condition, note) VALUES (?, ?, ?, ?)');
  const inspection = (unitKey, daysAgo, kind, summary, overrides = {}) => {
    const id = Number(inspect.run(units[unitKey], date(`-${daysAgo} days`), kind, 'Office manager', summary).lastInsertRowid);
    for (const area of ['Living room', 'Kitchen', 'Bathrooms', 'Bedrooms', 'Electrical', 'Plumbing', 'Exterior and compound', 'Security']) {
      const [condition, text] = overrides[area] || ['good', ''];
      item.run(id, area, condition, text);
    }
  };
  inspection('a1', 40, 'routine', 'Well kept. Minor plumbing note.', { Plumbing: ['fair', 'Slow drain in the kitchen sink.'] });
  inspection('a2', 200, 'routine', 'Tenant reported no problems.');
  inspection('u101', 100, 'routine', 'Good condition overall.', { Electrical: ['fair', 'Two sockets loose in the living room.'] });
  inspection('u201', 90, 'move_in', 'Condition recorded at move-in, photos on file.');
  inspection('house', 60, 'routine', 'Garden needs attention before the rainy season.', { 'Exterior and compound': ['poor', 'Overgrown hedge and cracked paving.'] });

  const viewing = db.prepare('INSERT INTO viewings (unit_id, name, phone, email, preferred_date, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  viewing.run(units.b1, 'Sandra Ofori', '024 600 0101', '', date('+3 days'), 'I work nearby and need to move next month.', 'requested');
  viewing.run(units.u103, 'Peter Anim', '020 600 0102', 'peter@example.com', date('+2 days'), '', 'confirmed');
  viewing.run(units.u103, 'Gifty Tawiah', '055 600 0103', '', null, 'Is the rent negotiable?', 'requested');
}

module.exports = { seedManager, seedDemo };
