const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server, base, db, auth;
const post = (url, data, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(data),
});
const staffPost = (url, data = {}) => post(url, { _csrf: auth.csrf, ...data }, { cookie: auth.cookie });
const staffGet = async (url) => (await fetch(`${base}${url}`, { headers: { cookie: auth.cookie } })).text();
const plot = (id) => db.prepare('SELECT * FROM plots WHERE id = ?').get(id);

test.before(async () => {
  const app = createApp({ dbPath: ':memory:', env: { ADMIN_PASSWORD: 'test-pass', SESSION_SECRET: 's3cret' } });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await post('/admin/login', { username: 'admin', password: 'test-pass' });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  auth = { cookie, csrf: page.match(/name="_csrf" value="([0-9a-f]+)"/)[1] };
});
test.after(() => server.close());

test('public pages and health check respond', async () => {
  assert.equal((await (await fetch(`${base}/healthz`)).json()).status, 'ok');
  assert.match(await (await fetch(`${base}/`)).text(), /Our estates/);
  assert.equal((await fetch(`${base}/plots/9999`)).status, 404);
});

test('seeded sales set plot status from payments', () => {
  assert.equal(plot(1).status, 'sold');      // fully paid
  assert.equal(plot(8).status, 'reserved');  // part paid
  assert.equal(plot(2).status, 'available');
});

test('plot catalogue filters', async () => {
  assert.match(await (await fetch(`${base}/plots`)).text(), /14 plots found/);
  assert.match(await (await fetch(`${base}/plots?status=available`)).text(), /11 plots found/);
  const cheap = await (await fetch(`${base}/plots?status=available&max_price=100000`)).text();
  assert.match(cheap, /2 plots found/);
  assert.match(cheap, /DDG-05/);
  assert.match(await (await fetch(`${base}/plots?estate=1&min_size=900`)).text(), /2 plots found/);
});

test('public enquiry is validated and saved; honeypot is dropped', async () => {
  assert.equal((await post('/enquiries', { plot_id: '2', name: 'A' })).status, 400);
  const before = db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n;
  assert.equal((await post('/enquiries', { name: 'Bot', email: 'b@example.com', website: 'x' })).status, 302);
  assert.equal((await post('/enquiries', { plot_id: '2', name: 'Ama <script>', phone: '+233 24 123 4567' })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, before + 1);
  const row = db.prepare('SELECT * FROM enquiries ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.plot_id, 2);
  assert.match(await staffGet(`/admin/enquiries/${row.id}`), /Ama &lt;script&gt;/);
});

test('staff area needs sign-in and a CSRF token', async () => {
  const res = await fetch(`${base}/admin/sales`, { redirect: 'manual' });
  assert.equal(res.headers.get('location'), '/admin/login');
  assert.equal((await post('/admin/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await post('/admin/estates', { code: 'XX', name: 'X', location: 'Y' }, { cookie: auth.cookie })).status, 403);
});

test('estates and plots can be added; duplicates are refused', async () => {
  assert.equal((await staffPost('/admin/estates', { code: 'oyh', name: 'Dup', location: 'Accra' })).status, 400);
  assert.equal((await staffPost('/admin/estates', { code: 'AFN', name: 'Afienya Park', location: 'Afienya' })).status, 302);
  const estate = db.prepare("SELECT id FROM estates WHERE code = 'AFN'").get();
  assert.equal((await staffPost('/admin/plots', { estate_id: estate.id, plot_no: '1a', price: '90000', dimensions: '70 × 100 ft' })).status, 302);
  assert.equal(db.prepare("SELECT ref FROM plots WHERE estate_id = ?").get(estate.id).ref, 'AFN-1A');
  assert.equal((await staffPost('/admin/plots', { estate_id: estate.id, plot_no: '1A', price: '90000' })).status, 400);
  assert.equal((await staffPost('/admin/plots', { estate_id: 1, plot_no: '01', price: '1' })).status, 400);
});

test('reservation lifecycle: reserve, pay, milestones, sold, cancel', async () => {
  // Start from an enquiry on plot 3.
  let res = await staffPost('/admin/enquiries', { name: 'Kofi Annor', phone: '+233 20 999 0000', source: 'phone', plot_id: '3' });
  const enquiryId = Number(res.headers.get('location').split('/').pop());
  assert.match(await staffGet(`/admin/sales/new?enquiry=${enquiryId}`), /value="Kofi Annor"/);

  res = await staffPost('/admin/sales', { enquiry_id: enquiryId, plot_id: '3', customer_name: 'Kofi Annor', phone: '+233 20 999 0000', agreed_price: '390000', reservation_expires: '2099-01-01' });
  assert.equal(res.status, 302);
  const saleId = Number(res.headers.get('location').split('/').pop());
  assert.equal(plot(3).status, 'reserved');
  assert.equal(db.prepare('SELECT status FROM enquiries WHERE id = ?').get(enquiryId).status, 'won');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE sale_id = ?').get(saleId).n, 9);

  // The same plot cannot be reserved twice.
  res = await staffPost('/admin/sales', { plot_id: '3', customer_name: 'Someone Else', phone: '+233 20 111 1111', agreed_price: '400000' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /already reserved/);

  // Payments: validation, part payment, overpayment refused, final payment sells the plot.
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '0', paid_on: '2026-01-01' })).status, 400);
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '1000', paid_on: '2999-01-01' })).status, 400);
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '90000', paid_on: '2026-01-05', method: 'cash', reference: 'R1' })).status, 302);
  assert.equal(plot(3).status, 'reserved');
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '300001', paid_on: '2026-01-06' })).status, 400);
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '300000', paid_on: '2026-01-06' })).status, 302);
  assert.equal(plot(3).status, 'sold');

  // Removing a payment reopens the balance.
  const last = db.prepare('SELECT id FROM payments WHERE sale_id = ? ORDER BY id DESC').get(saleId);
  await staffPost(`/admin/sales/${saleId}/payments/${last.id}/delete`);
  assert.equal(plot(3).status, 'reserved');

  // Milestones: tick with note, then undo.
  const first = db.prepare('SELECT id FROM milestones WHERE sale_id = ? AND position = 1').get(saleId);
  await staffPost(`/admin/sales/${saleId}/milestones/${first.id}`, { done_on: '2026-01-05', note: 'Receipt R1' });
  let m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(first.id);
  assert.deepEqual([m.done_on, m.note, m.done_by], ['2026-01-05', 'Receipt R1', 'admin']);
  assert.match(await staffGet('/admin/sales'), /Offer letter issued/);
  await staffPost(`/admin/sales/${saleId}/milestones/${first.id}`, { action: 'undo' });
  assert.equal(db.prepare('SELECT done_on FROM milestones WHERE id = ?').get(first.id).done_on, null);

  // A plot with a sale on record cannot be deleted.
  assert.equal((await staffPost('/admin/plots/3/delete')).status, 400);

  // Cancel releases the plot and freezes the record.
  assert.equal((await staffPost(`/admin/sales/${saleId}/cancel`, { reason: '' })).status, 400);
  assert.equal((await staffPost(`/admin/sales/${saleId}/cancel`, { reason: 'Customer withdrew' })).status, 302);
  assert.equal(plot(3).status, 'available');
  assert.equal((await staffPost(`/admin/sales/${saleId}/payments`, { amount: '100', paid_on: '2026-01-07' })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE sale_id = ?').get(saleId).n, 1);
});

test('dashboard flags lapsed reservations and reports add up', async () => {
  const dash = await staffGet('/admin');
  assert.match(dash, /Grace Ofori/);                    // seeded lapsed reservation
  assert.doesNotMatch(await staffGet('/admin/sales?view=lapsed'), /Emmanuel Tetteh/); // agreement signed, so not lapsed
  const reports = await staffGet('/admin/reports');
  assert.match(reports, /Plots and money by estate/);
  // Oyarifa Hills: 420,000 + 460,000 agreed; 420,000 + 5,000 collected.
  assert.match(reports, /GH₵880,000<\/td><td class="num">GH₵425,000<\/td><td class="num">GH₵455,000/);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  await staffPost('/admin/sales', { plot_id: '5', customer_name: '=HYPERLINK("x")', phone: '+233 20 000 9999', agreed_price: '470000' });
  const res = await fetch(`${base}/admin/reports/sales.csv`, { headers: { cookie: auth.cookie } });
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"OYH-01","Oyarifa Hills","Akosua Darko"/);
});

test('production refuses to start without secrets', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
});
