const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { ledger, statement, ensureCharges, hashPassword } = require('../src/db');

let server, base, db, admin, kwesi, adwoa, kojo, efua;

const post = (url, data, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data),
});
async function login(username, password = 'demo-pass-1') {
  const res = await post('/login', { username, password });
  assert.equal(res.status, 302, `${username} should sign in`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const home = await fetch(`${base}${username === 'admin' ? '/admin' : '/portal'}`, { headers: { cookie } });
  const csrf = (await home.text()).match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  return {
    cookie, csrf,
    get: (url) => fetch(`${base}${url}`, { headers: { cookie }, redirect: 'manual' }),
    text: async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).text(),
    post: (url, data = {}) => post(url, { _csrf: csrf, ...data }, { cookie }),
  };
}
const sql = (query, ...p) => db.prepare(query).get(...p);
const date = (modifier) => sql("SELECT date('now', ?) AS d", modifier).d;
const monthStart = (offset) => sql("SELECT date('now', 'start of month', ?) AS d", `${offset} months`).d;
const id = (query, ...p) => sql(query, ...p).id;
const hash = hashPassword('demo-pass-1');

// A landlord, property, unit and tenant for tests that need exact, date-independent figures.
function fixture(name, { fee = 10, currency = 'GHS' } = {}) {
  const user = (role) => Number(db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)').run(`${name}-${role}`, `${name} ${role}`, role, hash).lastInsertRowid);
  const landlord = user('landlord');
  const tenant = user('tenant');
  const property = Number(db.prepare('INSERT INTO properties (landlord_id, name, fee_percent) VALUES (?, ?, ?)').run(landlord, `${name} House`, fee).lastInsertRowid);
  const unit = Number(db.prepare('INSERT INTO units (property_id, label, currency) VALUES (?, ?, ?)').run(property, 'U1', currency).lastInsertRowid);
  return { landlord, tenant, property, unit };
}
const endedTenancy = (f, start, end, rent, currency = 'GHS', unit = f.unit) => Number(db.prepare(
  "INSERT INTO tenancies (unit_id, tenant_id, rent, currency, due_day, start_date, status, ended_on) VALUES (?, ?, ?, ?, 1, ?, 'ended', ?)").run(unit, f.tenant, rent, currency, start, end).lastInsertRowid);
const payment = (tenancy, amount, paidOn) => db.prepare("INSERT INTO payments (tenancy_id, amount, paid_on, recorded_by) VALUES (?, ?, ?, 'test')").run(tenancy, amount, paidOn);

test.before(async () => {
  const app = createApp({ dbPath: ':memory:', env: { ADMIN_PASSWORD: 'test-pass', SESSION_SECRET: 's3cret' } });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin', 'test-pass');
  [kwesi, adwoa, kojo, efua] = await Promise.all(['kboateng', 'asarpong', 'kojo', 'efua'].map((u) => login(u)));
});
test.after(() => server.close());

test('ledger applies payments to the oldest month first and reports overdue and credit', () => {
  const f = fixture('ledger');
  const t = endedTenancy(f, '2025-01-01', '2025-03-31', 1000);
  ensureCharges(db);
  ensureCharges(db); // idempotent
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM charges WHERE tenancy_id = ?').get(t).n, 3);

  payment(t, 1500, '2025-01-05');
  let l = ledger(db, t);
  assert.deepEqual(l.rows.map((r) => [r.period, r.applied, r.outstanding]), [['2025-01', 1000, 0], ['2025-02', 500, 500], ['2025-03', 0, 1000]]);
  assert.deepEqual([l.charged, l.paid, l.balance, l.overdue, l.overdueMonths, l.oldestOverdue], [3000, 1500, 1500, 1500, 2, '2025-02-01']);
  assert.ok(l.daysOverdue > 300);

  payment(t, 2000, '2025-04-02');
  l = ledger(db, t);
  assert.deepEqual([l.balance, l.overdue, l.overdueMonths], [-500, 0, 0]); // 500 in credit
});

test('an ended tenancy stops being charged after the month it ended', () => {
  const f = fixture('ended');
  const t = endedTenancy(f, '2025-05-01', '2025-05-20', 800);
  ensureCharges(db);
  assert.deepEqual(db.prepare('SELECT period FROM charges WHERE tenancy_id = ?').all(t).map((c) => c.period), ['2025-05']);
});

test('owner statements: fee, chargeable repairs only, per currency', () => {
  const f = fixture('stmt', { fee: 10 });
  const ghs = endedTenancy(f, '2025-03-01', '2025-03-31', 5000, 'GHS');
  const unit2 = Number(db.prepare("INSERT INTO units (property_id, label, currency) VALUES (?, 'U2', 'USD')").run(f.property).lastInsertRowid);
  const usd = endedTenancy(f, '2025-03-01', '2025-03-31', 700, 'USD', unit2);
  ensureCharges(db);
  payment(ghs, 5000, '2025-03-05');
  payment(usd, 700, '2025-03-06');
  payment(ghs, 111, '2025-04-01'); // other month: ignored
  const repair = db.prepare('INSERT INTO maintenance (unit_id, title, status, cost, cost_currency, charge_landlord, completed_on) VALUES (?, ?, ?, ?, ?, ?, ?)');
  repair.run(f.unit, 'Charged repair', 'done', 300, 'GHS', 1, '2025-03-20');
  repair.run(f.unit, 'Agency absorbs', 'done', 999, 'GHS', 0, '2025-03-21');
  repair.run(f.unit, 'Not finished', 'in_progress', 100, 'GHS', 1, null);
  repair.run(f.unit, 'Done in April', 'done', 250, 'GHS', 1, '2025-04-02');

  const s = statement(db, f.landlord, '2025-03');
  assert.deepEqual(s.totals.GHS, { collected: 5000, fee: 500, repairs: 300, net: 4200 });
  assert.deepEqual(s.totals.USD, { collected: 700, fee: 70, repairs: 0, net: 630 });
  assert.equal(s.lines.find((l) => l.currency === 'GHS').repairItems[0].title, 'Charged repair');
  assert.deepEqual(statement(db, f.landlord, '2025-05').lines, []);
});

test('public vacancies list only vacant, advertised units', async () => {
  const page = await (await fetch(`${base}/vacancies`)).text();
  assert.match(page, /Boateng Court/);      // B1 is vacant
  assert.match(page, /Sarpong Residences/); // 103 is vacant
  assert.doesNotMatch(page, /Tse Addo Villa/); // occupied
  assert.equal((await fetch(`${base}/vacancies/4`)).status, 404); // occupied unit
  db.prepare('UPDATE units SET listed = 0 WHERE id = 6').run();
  assert.equal((await fetch(`${base}/vacancies/6`)).status, 404);
  db.prepare('UPDATE units SET listed = 1 WHERE id = 6').run();
  assert.match(await (await fetch(`${base}/vacancies?beds=2`)).text(), /0 available|No|Nothing|available/);
});

test('viewing requests are validated and bots are dropped', async () => {
  assert.equal((await post('/vacancies/3/viewing', { name: 'A' })).status, 400);
  assert.equal((await post('/vacancies/3/viewing', { name: 'Ama Test', phone: '0245550000', preferred_date: '2020-01-01' })).status, 400);
  assert.equal((await post('/vacancies/4/viewing', { name: 'Ama Test', phone: '0245550000' })).status, 404);
  const before = sql('SELECT COUNT(*) AS n FROM viewings').n;
  assert.equal((await post('/vacancies/3/viewing', { name: 'Bot', email: 'b@example.com', website: 'x' })).status, 302);
  assert.equal(sql('SELECT COUNT(*) AS n FROM viewings').n, before);
  assert.equal((await post('/vacancies/3/viewing', { name: '<i>Kofi</i>', phone: '024 555 0000', preferred_date: date('+3 days') })).status, 302);
  assert.match(await admin.text('/admin/viewings'), /&lt;i&gt;Kofi&lt;\/i&gt;/);
  const v = db.prepare('SELECT id FROM viewings ORDER BY id DESC').get();
  await admin.post(`/admin/viewings/${v.id}`, { status: 'confirmed', notes: 'Booked 10am' });
  assert.equal(sql('SELECT status FROM viewings WHERE id = ?', v.id).status, 'confirmed');
});

test('sign-in and role boundaries', async () => {
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/portal`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await post('/login', { username: 'kojo', password: 'wrong' })).status, 401);
  assert.equal((await kojo.get('/admin')).status, 403);
  assert.equal((await kwesi.get('/admin/rent')).status, 403);
  assert.equal((await kojo.get('/portal/statements')).status, 403);        // landlord-only
  assert.equal((await kwesi.get('/portal/properties/1')).status, 200);
  assert.equal((await admin.get('/portal')).headers.get('location'), '/admin');
  assert.equal((await post('/admin/people', { name: 'X', username: 'xxx', password: 'password1' }, { cookie: admin.cookie })).status, 403); // no CSRF token
  assert.equal((await kojo.post('/admin/people', { name: 'X', username: 'xxx', password: 'password1' })).status, 403);
});

test('landlords see only their own properties, tenants and records', async () => {
  const mine = await kwesi.text('/portal');
  assert.match(mine, /Boateng Court/);
  assert.match(mine, /Tse Addo Villa/);
  assert.doesNotMatch(mine, /Sarpong Residences/);
  assert.doesNotMatch(mine, /Efua Addo/);            // tenant of Adwoa's property
  assert.equal((await kwesi.get('/portal/properties/2')).status, 404);

  const adwoaInspection = id('SELECT i.id FROM inspections i JOIN units u ON u.id = i.unit_id WHERE u.property_id = 2');
  assert.equal((await kwesi.get(`/portal/inspections/${adwoaInspection}`)).status, 404);
  assert.equal((await adwoa.get(`/portal/inspections/${adwoaInspection}`)).status, 200);
  const adwoaRequest = id('SELECT m.id FROM maintenance m JOIN units u ON u.id = m.unit_id WHERE u.property_id = 2');
  assert.equal((await kwesi.get(`/portal/maintenance/${adwoaRequest}`)).status, 404);
  assert.equal((await adwoa.get(`/portal/maintenance/${adwoaRequest}`)).status, 200);

  const statementPage = await kwesi.text('/portal/statements');
  assert.match(statementPage, /Kwesi Boateng/);
  assert.doesNotMatch(statementPage, /Adwoa/);
});

test('tenants see only their own ledger and requests, and can report problems', async () => {
  const page = await kojo.text('/portal');
  assert.match(page, /Kojo Mensah|My tenancy/);
  assert.match(page, /Boateng Court, unit A2/);
  assert.doesNotMatch(page, /Efua|Sarpong|unit 101/);
  assert.match(page, /Overdue/);                     // seeded: Kojo is behind

  assert.equal((await kojo.post('/portal/maintenance', { title: 'x' })).status, 400);
  const res = await kojo.post('/portal/maintenance', { title: 'Broken window latch', description: 'Bedroom window will not lock', priority: 'urgent' });
  assert.equal(res.status, 302);
  const request = sql('SELECT * FROM maintenance ORDER BY id DESC LIMIT 1');
  assert.deepEqual([request.unit_id, request.reported_by, request.priority, request.status], [2, 5, 'urgent', 'open']);

  assert.equal((await kojo.get(`/portal/maintenance/${request.id}`)).status, 200);
  assert.equal((await efua.get(`/portal/maintenance/${request.id}`)).status, 404);   // another tenant
  assert.equal((await kwesi.get(`/portal/maintenance/${request.id}`)).status, 200);  // owner of that property
  assert.equal((await adwoa.get(`/portal/maintenance/${request.id}`)).status, 404);  // different owner
  assert.equal((await kwesi.post('/portal/maintenance', { title: 'Landlord cannot file as tenant' })).status, 403);
  assert.match(await admin.text('/admin'), /Broken window latch/);
});

test('dashboard shows who is overdue and builds a WhatsApp reminder', async () => {
  const dash = await admin.text('/admin');
  const overdueSection = dash.slice(dash.indexOf('<h2>Rent overdue</h2>'), dash.indexOf('<div class="two">'));
  assert.match(overdueSection, /Kojo Mensah/);
  assert.match(overdueSection, /Efua Addo/);
  assert.doesNotMatch(overdueSection, /Ama Owusu/); // up to date
  const href = overdueSection.match(/href="(https:\/\/wa\.me\/233206000012[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(decodeURIComponent(href.split('text=')[1]), /Hello Kojo, this is a friendly reminder from Floorspace Realty that \$\d[\d,]* of rent for Boateng Court, A2 is overdue/);
  await admin.post('/admin/tenancies/2/reminders', { back: 'dashboard' });
  assert.equal(sql('SELECT COUNT(*) AS n FROM reminders WHERE tenancy_id = 2').n, 1);
  assert.match(await admin.text('/admin/rent'), new RegExp(date('+0 days')));
});

test('recording payments: validation, effect on the balance, removal', async () => {
  const before = ledger(db, 2);
  assert.equal((await admin.post('/admin/tenancies/2/payments', { amount: '0', paid_on: date('+0 days') })).status, 400);
  assert.equal((await admin.post('/admin/tenancies/2/payments', { amount: '100', paid_on: date('+3 days') })).status, 400);
  assert.equal((await admin.post('/admin/tenancies/2/payments', { amount: '100', paid_on: 'nonsense' })).status, 400);
  assert.equal((await admin.post('/admin/tenancies/2/payments', { amount: '400', paid_on: date('+0 days'), method: 'cash', reference: 'RCPT-9' })).status, 302);
  const after = ledger(db, 2);
  assert.equal(after.paid, before.paid + 400);
  assert.equal(after.balance, before.balance - 400);
  const p = sql('SELECT id FROM payments WHERE tenancy_id = 2 ORDER BY id DESC').id;
  await admin.post(`/admin/tenancies/2/payments/${p}/delete`);
  assert.equal(ledger(db, 2).paid, before.paid);
});

test('tenancy lifecycle: start, no double-booking, change rent, end', async () => {
  const start = monthStart(-2);
  const body = (extra = {}) => ({ tenant_id: '7', rent: '5200', currency: 'GHS', due_day: '3', start_date: start, deposit: '10400', ...extra });
  // Unit 4 (101) is occupied.
  const clash = await admin.post('/admin/units/4/tenancies', body());
  assert.equal(clash.status, 400);
  assert.match(await clash.text(), /already has an active tenancy/);
  assert.equal((await admin.post('/admin/units/3/tenancies', body({ rent: '0' }))).status, 400);
  assert.equal((await admin.post('/admin/units/3/tenancies', body({ due_day: '31' }))).status, 400);
  assert.equal((await admin.post('/admin/units/3/tenancies', body({ end_date: '2000-01-01' }))).status, 400);

  const res = await admin.post('/admin/units/3/tenancies', body());
  assert.equal(res.status, 302);
  const tenancy = Number(res.headers.get('location').split('/').pop());
  assert.equal(sql('SELECT COUNT(*) AS n FROM charges WHERE tenancy_id = ?', tenancy).n, 3);   // two months ago, last month, this month
  assert.equal((await fetch(`${base}/vacancies/3`)).status, 404);                                // no longer advertised

  await admin.post(`/admin/tenancies/${tenancy}/rent`, { rent: '5600' });
  const amounts = db.prepare('SELECT amount FROM charges WHERE tenancy_id = ? ORDER BY due_date').all(tenancy).map((c) => c.amount);
  assert.deepEqual(amounts.slice(0, 2), [5200, 5200]);          // already due: unchanged
  assert.equal(sql('SELECT rent FROM tenancies WHERE id = ?', tenancy).rent, 5600);

  await admin.post(`/admin/tenancies/${tenancy}/end`, { ended_on: start });
  assert.equal(sql('SELECT status FROM tenancies WHERE id = ?', tenancy).status, 'ended');
  assert.equal(sql('SELECT COUNT(*) AS n FROM charges WHERE tenancy_id = ?', tenancy).n, 1);   // later months removed
  assert.equal((await fetch(`${base}/vacancies/3`)).status, 200);                                // vacant again
  assert.equal((await admin.post(`/admin/tenancies/${tenancy}/end`, {})).status, 404);          // already ended
});

test('maintenance: manager updates a request and the cost reaches the owner statement', async () => {
  const created = await admin.post('/admin/maintenance', { unit_id: '1', title: 'Repaint hallway', priority: 'low' });
  assert.equal(created.status, 302);
  const rid = Number(created.headers.get('location').split('/').pop());
  assert.equal(sql('SELECT reported_by FROM maintenance WHERE id = ?', rid).reported_by, 4); // current tenant of A1
  assert.equal((await admin.post('/admin/maintenance', { unit_id: '1', title: 'x' })).status, 400);

  assert.equal((await admin.post(`/admin/maintenance/${rid}`, { status: 'done', completed_on: date('+5 days') })).status, 400);
  await admin.post(`/admin/maintenance/${rid}`, { status: 'done', contractor: 'Paint Pros', cost: '1850', cost_currency: 'GHS', charge_landlord: '1', note: 'Two coats, tenant happy' });
  const m = sql('SELECT * FROM maintenance WHERE id = ?', rid);
  assert.deepEqual([m.status, m.cost, m.completed_on], ['done', 1850, date('+0 days')]);
  const notes = db.prepare('SELECT note FROM maintenance_notes WHERE request_id = ?').all(rid).map((n) => n.note);
  assert.match(notes.at(-1), /Status: Open → Done\. Two coats, tenant happy/);

  const period = date('+0 days').slice(0, 7);
  const page = await admin.text(`/admin/statements?landlord=2&period=${period}`);
  assert.match(page, /Repaint hallway/);
  assert.match(page, /GH₵1,850/);
  const mine = await kwesi.text(`/portal/statements?period=${period}`);
  assert.match(mine, /Repaint hallway/);
  assert.doesNotMatch(await adwoa.text(`/portal/statements?period=${period}`), /Repaint hallway/);
  // The landlord sees the cost on their own request; the tenant does not.
  assert.match(await kwesi.text(`/portal/maintenance/${rid}`), /GH₵1,850/);
});

test('inspections are recorded per area and visible only to the owner', async () => {
  assert.equal((await admin.post('/admin/inspections', { unit_id: '1', inspected_on: date('+2 days') })).status, 400);
  const res = await admin.post('/admin/inspections', { unit_id: '1', inspected_on: date('+0 days'), kind: 'move_out', summary: 'Needs repainting',
    cond_0: 'good', cond_1: 'poor', note_1: 'Burn mark on counter', cond_4: 'fair' });
  assert.equal(res.status, 302);
  const inspection = Number(res.headers.get('location').split('/').pop());
  const items = db.prepare('SELECT area, condition, note FROM inspection_items WHERE inspection_id = ? ORDER BY id').all(inspection);
  assert.equal(items.length, 8);
  assert.deepEqual({ ...items[1] }, { area: 'Kitchen', condition: 'poor', note: 'Burn mark on counter' });
  assert.equal(items[7].condition, 'good'); // unanswered areas default to good
  assert.match(await kwesi.text(`/portal/inspections/${inspection}`), /Burn mark on counter/);
  assert.equal((await adwoa.get(`/portal/inspections/${inspection}`)).status, 404);
  assert.equal((await kojo.get(`/portal/inspections/${inspection}`)).status, 403);
});

test('people and properties: validation, deactivation, password change', async () => {
  assert.equal((await admin.post('/admin/people', { name: 'Dup', role: 'tenant', username: 'kojo', password: 'password123' })).status, 400);
  assert.equal((await admin.post('/admin/people', { name: 'Short', role: 'tenant', username: 'shorty', password: 'x' })).status, 400);
  assert.equal((await admin.post('/admin/people', { name: 'New Tenant', role: 'tenant', username: 'newbie', password: 'password123' })).status, 302);
  const newbie = await login('newbie', 'password123');
  assert.equal((await newbie.get('/portal')).status, 200);

  assert.equal((await newbie.post('/account/password', { current: 'wrong', next: 'brand-new-pass', confirm: 'brand-new-pass' })).status, 400);
  assert.equal((await newbie.post('/account/password', { current: 'password123', next: 'brand-new-pass', confirm: 'different' })).status, 400);
  assert.equal((await newbie.post('/account/password', { current: 'password123', next: 'brand-new-pass', confirm: 'brand-new-pass' })).status, 200);
  assert.equal((await post('/login', { username: 'newbie', password: 'password123' })).status, 401);
  assert.equal((await post('/login', { username: 'newbie', password: 'brand-new-pass' })).status, 302);

  await admin.post(`/admin/people/${id("SELECT id FROM users WHERE username = 'newbie'")}/toggle`);
  assert.equal((await newbie.get('/portal')).headers.get('location'), '/login');
  assert.equal((await post('/login', { username: 'newbie', password: 'brand-new-pass' })).status, 401);

  assert.equal((await admin.post('/admin/properties', { landlord_id: '4', name: 'Tenant cannot own', fee_percent: '10' })).status, 400); // 4 is a tenant
  assert.equal((await admin.post('/admin/properties', { landlord_id: '2', name: 'New Block', fee_percent: '75' })).status, 400);
  const added = await admin.post('/admin/properties', { landlord_id: '2', name: 'New Block', area: 'Osu', fee_percent: '12' });
  assert.equal(added.status, 302);
  const pid = Number(added.headers.get('location').split('/').pop());
  assert.equal((await admin.post(`/admin/properties/${pid}/units`, { label: 'Flat 1', bedrooms: '2', asking_rent: '3000', currency: 'GHS', listed: '1' })).status, 302);
  assert.equal((await admin.post(`/admin/properties/${pid}/units`, { label: 'Flat 1' })).status, 400); // duplicate label
});

test('rent roll CSV neutralises spreadsheet formulas', async () => {
  const tenant = id("SELECT id FROM users WHERE username = 'ama'");
  db.prepare("UPDATE users SET name = '=HYPERLINK(\"http://x\")' WHERE id = ?").run(tenant);
  const res = await admin.get('/admin/rent-roll.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv.split('\r\n')[0], /"Property","Unit","Landlord","Tenant"/);
});

test('only failed sign-ins count towards the rate limit', async () => {
  const app = createApp({ dbPath: ':memory:', env: { LOGIN_FAILURES: '3' } });
  const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  const url = `http://127.0.0.1:${s.address().port}/login`;
  const attempt = (password) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'ama', password }) });
  try {
    for (let i = 0; i < 6; i += 1) assert.equal((await attempt('demo-pass-1')).status, 302); // good sign-ins are never limited
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('wrong')).status, 429);
    assert.equal((await attempt('demo-pass-1')).status, 429); // blocked until the window passes
  } finally { s.close(); }
});

test('production refuses to start without secrets and never creates demo accounts unasked', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  const app = createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production', SESSION_SECRET: 's', ADMIN_PASSWORD: 'p' } });
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 0);
});

test('vacancy photos exist on disk, galleries render, and public pages carry no inline styles', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const units = db.prepare('SELECT image_url, gallery FROM units WHERE image_url != \'\'').all();
  assert.ok(units.length >= 8, 'seed units should have photos');
  for (const u of units) {
    for (const p of [u.image_url, ...u.gallery.split('\n')].filter(Boolean)) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', p)), `missing ${p}`);
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', p.replace('-lg.jpg', '-md.jpg'))), `missing small ${p}`);
    }
  }
  const id = db.prepare("SELECT un.id FROM units un WHERE un.listed = 1 AND NOT EXISTS (SELECT 1 FROM tenancies t WHERE t.unit_id = un.id AND t.status = 'active') LIMIT 1").get().id;
  const detail = await (await fetch(`${base}/vacancies/${id}`)).text();
  assert.match(detail, /data-gallery-main/);
  for (const html of [detail, await (await fetch(`${base}/vacancies`)).text(), await (await fetch(`${base}/login`)).text()]) {
    assert.doesNotMatch(html, /\sstyle="/);
  }
  assert.match((await fetch(`${base}/`)).headers.get('content-security-policy'), /script-src 'self'/);
});

test('persistence: data written by one instance is restored by a new one (Blob storage)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { buildHandler } = require('../src/persist');

  const store = new Map(); // stand-in for @vercel/blob
  const client = {
    async get(key) { return store.has(key) ? { stream: new Response(store.get(key)).body } : null; },
    async put(key, body) { store.set(key, Buffer.from(body)); },
  };
  const env = { BLOB_READ_WRITE_TOKEN: 'fake', ADMIN_PASSWORD: 'p', SESSION_SECRET: 's', SEED_DEMO: 'on', DEMO_PASSWORD: 'demo-pass-1', AGENT_DEMO_PASSWORD: 'demo-pass-1' };
  const launch = (dir) => buildHandler({ name: 'floorspace', env, client, tmpDir: dir, createApp: (o) => require('../server').createApp({ ...o, env }) });
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-b-'));

  const a = await launch(dirA).boot();
  assert.ok(store.has('floorspace/app.db'), 'first start stores the seeded database');
  a.app.locals.db.exec("CREATE TABLE persist_probe (v TEXT); INSERT INTO persist_probe VALUES ('kept')");
  await a.save();

  const b = await launch(dirB).boot(); // empty /tmp, as on a cold start
  assert.equal(b.app.locals.db.prepare('SELECT v FROM persist_probe').get().v, 'kept');
  // Sample data seeded before the save is still there and was not seeded twice.
  const copy = path.join(dirB, 'check.db');
  fs.writeFileSync(copy, store.get('floorspace/app.db'));
  assert.ok(new DatabaseSync(copy).prepare('SELECT COUNT(*) AS n FROM users').get().n >= 1);
});
