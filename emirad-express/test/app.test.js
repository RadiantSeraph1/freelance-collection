const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const d = require('../src/db');

let server, base, db, admin, kofi, esi, shopnest, glow;

const post = (url, data, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data),
});
async function login(username, password = 'demo-pass-1') {
  const res = await post('/login', { username, password });
  assert.equal(res.status, 302, `${username} should sign in`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const landing = await (await fetch(`${base}${res.headers.get('location')}`, { headers: { cookie } })).text();
  const csrf = landing.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  return {
    cookie, csrf,
    get: (url) => fetch(`${base}${url}`, { headers: { cookie }, redirect: 'manual' }),
    text: async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).text(),
    post: (url, data = {}) => post(url, { _csrf: csrf, ...data }, { cookie }),
  };
}
const sql = (query, ...p) => db.prepare(query).get(...p);
const all = (query, ...p) => db.prepare(query).all(...p);
const userId = (username) => sql('SELECT id FROM users WHERE username = ?', username).id;
const ship = (id) => sql('SELECT * FROM shipments WHERE id = ?', id);
const lastShip = () => sql('SELECT * FROM shipments ORDER BY id DESC LIMIT 1');
const events = (id) => all('SELECT * FROM events WHERE shipment_id = ? ORDER BY id', id);
const date = (modifier) => sql("SELECT date('now', ?) AS d", modifier).d;

const PARCEL = { sender_name: 'Test Sender', sender_phone: '024 555 0001', pickup_address: '1 Test Street', pickup_zone: 'Haatso', receiver_name: 'Test Receiver',
  receiver_phone: '024 555 0002', delivery_address: '2 Test Road', delivery_zone: 'East Legon', description: 'Test parcel', weight_kg: 2, service: 'next_day', payment_mode: 'sender_cash', cod_amount: 0 };
// next-day 25 + dearer area (East Legon) 5 + 2 kg band 8 = 38
const PRICE = 38;
const make = (extra = {}) => { const m = d.createShipment(db, { ...PARCEL, ...extra }); return { ...m, row: () => ship(m.id) }; };

test.before(async () => {
  const app = createApp({ dbPath: ':memory:', env: { ADMIN_PASSWORD: 'test-pass', SESSION_SECRET: 's3cret' } });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin', 'test-pass');
  [kofi, esi, shopnest, glow] = await Promise.all(['kofi', 'esi', 'shopnest', 'glow'].map((u) => login(u)));
});
test.after(() => server.close());

test('price quotes: service + dearer area + weight band, with limits', () => {
  assert.deepEqual(d.quote('same_day', 'Haatso', 'East Legon', 1), { price: 40, base: 35, zoneCharge: 5, weightCharge: 0 });
  assert.equal(d.quote('standard', 'Haatso', 'Kasoa', 20).price, 15 + 20 + 35);
  assert.equal(d.quote('next_day', 'Kasoa', 'Haatso', 1).price, 25 + 20);          // the dearer end counts, in either direction
  assert.equal(d.quote('next_day', 'Haatso', 'Haatso', 1).weightCharge, 0);          // 1 kg is the top of the first band
  assert.equal(d.quote('next_day', 'Haatso', 'Haatso', 1.1).weightCharge, 8);
  assert.equal(d.quote('next_day', 'Haatso', 'Haatso', 5).weightCharge, 8);
  assert.equal(d.quote('next_day', 'Haatso', 'Haatso', 5.1).weightCharge, 18);
  assert.match(d.quote('next_day', 'Haatso', 'Haatso', 20.1).error, /over 20 kg/);
  assert.ok(d.quote('nope', 'Haatso', 'Haatso', 1).error);
  assert.ok(d.quote('next_day', 'Nowhere', 'Haatso', 1).error);
  assert.ok(d.quote('next_day', 'Haatso', 'Haatso', 0).error);
  assert.equal(d.parseWeight('2,5'), 2.5);
  assert.ok(Number.isNaN(d.parseWeight('abc')));
});

test('delivery promise: same-day cut-off, next-day, standard', () => {
  assert.equal(d.dueDate(db, 'same_day', '2026-03-10', 14), '2026-03-10');
  assert.equal(d.dueDate(db, 'same_day', '2026-03-10', 15), '2026-03-11');    // after the 3pm cut-off
  assert.equal(d.dueDate(db, 'next_day', '2026-03-31', 9), '2026-04-01');
  assert.equal(d.dueDate(db, 'standard', '2026-02-27', 9), '2026-03-02');
});

test('tracking numbers are unambiguous, well-formed and unique', () => {
  const codes = new Set(Array.from({ length: 300 }, () => d.newTracking(db)));
  assert.equal(codes.size, 300);
  for (const c of codes) assert.match(c, /^EE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test('status rules: only valid steps, required details, attempts and cash', () => {
  const riderId = userId('kofi');
  const m = make({ payment_mode: 'receiver_cash', cod_amount: 500 });
  assert.equal(m.price, PRICE);
  const get = () => m.row();

  assert.match(d.changeStatus(db, get(), 'picked_up').error, /cannot be changed/);               // cannot skip ahead
  assert.match(d.changeStatus(db, get(), 'pickup_scheduled').error, /Assign a rider/);           // no rider yet
  assert.match(d.assignRider(db, get(), undefined, 'test').error, /active rider/);                  // no such rider
  assert.equal(d.assignRider(db, get(), sql('SELECT * FROM users WHERE id = ?', riderId), 'Office').ok, true);
  assert.equal(get().status, 'pickup_scheduled');
  assert.deepEqual(events(m.id).map((e) => [e.status, e.visible]), [['booked', 1], ['pickup_scheduled', 1], ['pickup_scheduled', 0]]); // rider's name stays internal

  assert.equal(d.changeStatus(db, get(), 'picked_up', { by: 'Kofi' }).ok, true);
  assert.equal(all('SELECT * FROM cash_items WHERE shipment_id = ?', m.id).length, 0);          // receiver pays, so nothing at pickup
  // Picked up is not yet on the road: it cannot be delivered or failed until it is out for delivery.
  assert.match(d.changeStatus(db, get(), 'delivered', { recipient: 'Too Early' }).error, /cannot be changed/);
  assert.match(d.changeStatus(db, get(), 'failed', { reason: 'not_home' }).error, /cannot be changed/);
  assert.match(d.changeStatus(db, get(), 'returned').error, /cannot be changed/);
  assert.equal(get().status, 'picked_up');
  assert.equal(d.changeStatus(db, get(), 'out_for_delivery').ok, true);
  assert.match(d.changeStatus(db, get(), 'delivered', {}).error, /name of the person/);
  assert.match(d.changeStatus(db, get(), 'failed', { reason: 'made-up' }).error, /why the delivery failed/);

  assert.equal(d.changeStatus(db, get(), 'failed', { reason: 'not_home', note: 'Gate locked' }).ok, true);
  assert.deepEqual([get().status, get().attempts, get().failure_reason], ['failed', 1, 'not_home']);
  assert.equal(d.changeStatus(db, get(), 'out_for_delivery').ok, true);                           // retry
  assert.deepEqual([get().status, get().failure_reason], ['out_for_delivery', '']);
  assert.equal(d.changeStatus(db, get(), 'delivered', { recipient: 'Ama Test', collected: '520' }).ok, true);
  const row = get();
  assert.deepEqual([row.status, row.delivered_to, !!row.closed_at], ['delivered', 'Ama Test', true]);
  const cash = all('SELECT * FROM cash_items WHERE shipment_id = ?', m.id);
  assert.deepEqual(cash.map((c) => [c.kind, c.expected, c.collected, c.rider_id]), [['delivery_collection', 500 + PRICE, 520, riderId]]); // goods + fee expected, 18 short
  assert.match(d.changeStatus(db, get(), 'out_for_delivery').error, /cannot be changed/);        // closed is final
  assert.match(d.assignRider(db, get(), sql('SELECT * FROM users WHERE id = ?', riderId), 'x').error, /already closed/);
});

test('sender-pays-cash parcels record the fee at pickup; returned and cancelled are final', () => {
  const rider = sql("SELECT * FROM users WHERE username = 'esi'");
  const m = make({ payment_mode: 'sender_cash' });
  d.assignRider(db, m.row(), rider, 'Office');
  d.changeStatus(db, m.row(), 'picked_up', { collected: String(PRICE) });
  assert.deepEqual(all('SELECT kind, expected, collected FROM cash_items WHERE shipment_id = ?', m.id).map((c) => ({ ...c })), [{ kind: 'pickup_fee', expected: PRICE, collected: PRICE }]);
  d.changeStatus(db, m.row(), 'out_for_delivery');
  d.changeStatus(db, m.row(), 'failed', { reason: 'refused' });
  assert.equal(d.changeStatus(db, m.row(), 'returned', { note: 'Sent back' }).ok, true);
  assert.ok(m.row().closed_at);
  assert.match(d.changeStatus(db, m.row(), 'cancelled').error, /cannot be changed/);

  const c = make();
  assert.equal(d.changeStatus(db, c.row(), 'cancelled').ok, true);
  assert.match(d.changeStatus(db, c.row(), 'pickup_scheduled').error, /cannot be changed/);
});

test('home, quote and rates pages work; demo tracking numbers are offered', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /Track parcel/);
  assert.match(home, /Demo tracking numbers to try/);
  assert.match(home, /temporary/);
  const q = await (await fetch(`${base}/quote?pickup_zone=Haatso&delivery_zone=Tema&weight_kg=3&service=same_day`)).text();
  assert.match(q, new RegExp(`GH₵${35 + 15 + 8}`));
  assert.match(await (await fetch(`${base}/quote?pickup_zone=Haatso&delivery_zone=Tema&weight_kg=25&service=same_day`)).text(), /over 20 kg/);
  assert.match(await (await fetch(`${base}/rates`)).text(), /Sample rate card/);
});

test('public tracking shows progress but never phone numbers, street addresses or internal notes', async () => {
  const delivered = sql("SELECT * FROM shipments WHERE status = 'delivered' AND business_id IS NULL ORDER BY id LIMIT 1");
  const page = await (await fetch(`${base}/track/${delivered.tracking}`)).text();
  assert.match(page, /Delivered to/);
  assert.match(page, new RegExp(`Received by</dt><dd>${delivered.delivered_to}`));
  for (const secret of [delivered.sender_phone, delivered.receiver_phone, delivered.pickup_address, delivered.delivery_address]) assert.ok(!page.includes(secret), `leaked ${secret}`);
  assert.doesNotMatch(page, /Assigned to|internal/);
  assert.match(page, new RegExp(`Receiver</dt><dd>${delivered.receiver_name.split(' ')[0]}</dd>`));   // the receiver is shown by first name only

  assert.equal((await fetch(`${base}/track/EE-AAAA-AAAA`)).status, 404);
  assert.equal((await fetch(`${base}/track/not-a-code`)).status, 404);
  assert.equal((await fetch(`${base}/track?code=junk`)).status, 400);
  const redirect = await fetch(`${base}/track?code=${delivered.tracking.toLowerCase()}`, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), `/track/${delivered.tracking}`);
});

test('tracking lookups are rate limited so numbers cannot be guessed in bulk', async () => {
  const app = createApp({ dbPath: ':memory:', env: { SEED_DEMO: 'off', ADMIN_PASSWORD: 'x', SESSION_SECRET: 's' } });
  const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  try {
    const statuses = [];
    for (let i = 0; i < 45; i += 1) statuses.push((await fetch(`http://127.0.0.1:${s.address().port}/track/EE-AAAA-BBB${i % 8 + 2}`)).status);
    assert.equal(statuses[0], 404);
    assert.equal(statuses.at(-1), 429);
  } finally { s.close(); }
});

test('guest booking: validated, honeypot, price always computed on the server', async () => {
  const before = sql('SELECT COUNT(*) AS n FROM shipments').n;
  const good = { ...PARCEL, payment_mode: 'receiver_cash' };
  assert.equal((await post('/book', { name: 'x' })).status, 400);
  assert.equal((await post('/book', { ...good, weight_kg: '25' })).status, 400);
  assert.equal((await post('/book', { ...good, receiver_phone: 'abc' })).status, 400);
  assert.equal((await post('/book', { ...good, website: 'http://spam' })).status, 302);          // bot: silently dropped
  assert.equal(sql('SELECT COUNT(*) AS n FROM shipments').n, before);

  const res = await post('/book', { ...good, price: '1', cod_amount: '150' });                   // tampered price is ignored
  assert.equal(res.status, 302);
  const s = lastShip();
  assert.deepEqual([s.price, s.status, s.source, s.cod_amount, s.payment_mode], [PRICE, 'booked', 'web', 150, 'receiver_cash']);
  assert.equal(res.headers.get('location'), `/booked/${s.tracking}`);
  assert.match(await (await fetch(`${base}/booked/${s.tracking}`)).text(), new RegExp(`GH₵${PRICE}`));
  assert.equal(events(s.id).length, 1);

  const tricky = await post('/book', { ...good, payment_mode: 'account' });                       // guests cannot book on account
  assert.equal(tricky.status, 302);
  assert.equal(lastShip().payment_mode, 'sender_cash');
});

test('sign-in, roles and CSRF', async () => {
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).headers.get('location'), '/login');
  assert.equal((await post('/login', { username: 'kofi', password: 'wrong' })).status, 401);
  assert.equal((await post('/login', { username: 'kofi', password: 'demo-pass-1' })).headers.get('location'), '/rider');
  assert.equal((await kofi.get('/admin')).status, 403);
  assert.equal((await shopnest.get('/admin')).status, 403);
  assert.equal((await shopnest.get('/rider')).status, 403);
  assert.equal((await kofi.get('/account')).status, 403);
  assert.equal((await admin.get('/rider')).status, 403);
  assert.equal((await post('/admin/people', { name: 'X', username: 'xxx', password: 'password1' }, { cookie: admin.cookie })).status, 403);
  assert.equal((await kofi.post('/admin/people', { name: 'X', username: 'xxx', password: 'password1' })).status, 403);
});

test('riders and businesses only ever see their own parcels', async () => {
  const kofiJob = sql("SELECT id FROM shipments WHERE rider_id = ? AND status = 'out_for_delivery' ORDER BY id", userId('kofi')).id;
  const esiJob = sql("SELECT id FROM shipments WHERE rider_id = ? AND status = 'picked_up'", userId('esi')).id;
  assert.equal((await kofi.get(`/rider/jobs/${kofiJob}`)).status, 200);
  assert.equal((await kofi.get(`/rider/jobs/${esiJob}`)).status, 404);
  assert.equal((await kofi.post(`/rider/jobs/${esiJob}/status`, { to: 'out_for_delivery' })).status, 404);
  assert.equal(ship(esiJob).status, 'picked_up');
  const list = await kofi.text('/rider');
  assert.match(list, new RegExp(ship(kofiJob).tracking));
  assert.doesNotMatch(list, new RegExp(ship(esiJob).tracking));

  const mine = sql("SELECT id FROM shipments WHERE business_id = ? ORDER BY id", userId('shopnest')).id;
  const theirs = sql("SELECT id, tracking FROM shipments WHERE business_id = ? ORDER BY id", userId('glow'));
  assert.equal((await shopnest.get(`/account/shipments/${mine}`)).status, 200);
  assert.equal((await shopnest.get(`/account/shipments/${theirs.id}`)).status, 404);
  assert.equal((await shopnest.post(`/account/shipments/${theirs.id}/cancel`)).status, 404);
  assert.doesNotMatch(await shopnest.text('/account'), new RegExp(theirs.tracking));
});

test('dispatcher books for a caller, assigns, and the rider completes with cash handed in', async () => {
  const res = await admin.post('/admin/shipments', { ...PARCEL, payment_mode: 'receiver_cash', cod_amount: '500', rider_id: String(userId('kofi')) });
  assert.equal(res.status, 302);
  const s = lastShip();
  assert.deepEqual([s.source, s.status, s.rider_id, s.price], ['phone', 'pickup_scheduled', userId('kofi'), PRICE]);

  const page = await admin.text(`/admin/shipments/${s.id}`);
  const href = page.match(/href="(https:\/\/wa\.me\/233245550002[^"]+)"/)[1].replace(/&amp;/g, '&');
  const text = decodeURIComponent(href.split('text=')[1]);
  assert.match(text, new RegExp(`${s.tracking}.*from Test Sender.*is now: rider assigned for pickup.*/track/${s.tracking}`));

  assert.equal((await kofi.post(`/rider/jobs/${s.id}/status`, { to: 'out_for_delivery' })).status, 400);   // must pick up first
  assert.equal((await kofi.post(`/rider/jobs/${s.id}/status`, { to: 'picked_up' })).status, 302);
  assert.equal((await kofi.post(`/rider/jobs/${s.id}/status`, { to: 'out_for_delivery' })).status, 302);
  assert.equal((await kofi.post(`/rider/jobs/${s.id}/status`, { to: 'delivered', recipient: '' })).status, 400);
  assert.equal((await kofi.post(`/rider/jobs/${s.id}/status`, { to: 'delivered', recipient: 'Ama Test', collected: String(500 + PRICE - 10) })).status, 302);
  assert.equal(ship(s.id).status, 'delivered');

  const cash = await admin.text('/admin/cash');
  assert.match(cash, /Kofi Mensah/);
  const short = sql("SELECT SUM(expected - collected) AS n FROM cash_items WHERE rider_id = ? AND remitted_at IS NULL", userId('kofi')).n;
  assert.ok(short >= 10);
  assert.match(cash, new RegExp(`GH₵${short}`));                                                              // the rider's total shortfall is flagged
  assert.match(cash, new RegExp(`GH₵${500 + PRICE - 10}`));                                                   // and this parcel's collected amount is listed
  const before = sql("SELECT COUNT(*) AS n FROM cash_items WHERE rider_id = ? AND remitted_at IS NULL", userId('kofi')).n;
  assert.ok(before >= 2);
  await admin.post('/admin/cash/remit', { rider_id: String(userId('kofi')) });
  assert.equal(sql("SELECT COUNT(*) AS n FROM cash_items WHERE rider_id = ? AND remitted_at IS NULL", userId('kofi')).n, 0);
  assert.equal(sql("SELECT remitted_by FROM cash_items WHERE shipment_id = ?", s.id).remitted_by, 'Dispatch office');
  assert.match(await (await fetch(`${base}/track/${s.tracking}`)).text(), /Received by<\/dt><dd>Ama Test/);
});

test('failed delivery: reason required, retried, then returned by the dispatcher', async () => {
  const m = make();
  await admin.post(`/admin/shipments/${m.id}/assign`, { rider_id: String(userId('esi')) });
  await esi.post(`/rider/jobs/${m.id}/status`, { to: 'picked_up', collected: String(PRICE) });
  await esi.post(`/rider/jobs/${m.id}/status`, { to: 'out_for_delivery' });
  assert.equal((await esi.post(`/rider/jobs/${m.id}/status`, { to: 'failed' })).status, 400);
  assert.equal((await esi.post(`/rider/jobs/${m.id}/status`, { to: 'failed', reason: 'not_home', note: 'Called twice' })).status, 302);
  let s = m.row();
  assert.deepEqual([s.status, s.attempts, s.failure_reason], ['failed', 1, 'not_home']);
  const track = await (await fetch(`${base}/track/${s.tracking}`)).text();
  assert.match(track, /Recipient not available/);
  assert.match(track, /Called twice/);

  await esi.post(`/rider/jobs/${m.id}/status`, { to: 'out_for_delivery' });
  await esi.post(`/rider/jobs/${m.id}/status`, { to: 'failed', reason: 'phone_off' });
  assert.equal(m.row().attempts, 2);
  assert.equal((await esi.post(`/rider/jobs/${m.id}/status`, { to: 'returned' })).status, 400);             // riders cannot return or cancel
  assert.equal((await esi.post(`/rider/jobs/${m.id}/status`, { to: 'cancelled' })).status, 400);
  assert.equal((await admin.post(`/admin/shipments/${m.id}/status`, { to: 'returned', note: 'Sender collected' })).status, 302);
  s = m.row();
  assert.deepEqual([s.status, !!s.closed_at], ['returned', true]);
  assert.equal((await admin.post(`/admin/shipments/${m.id}/status`, { to: 'delivered', recipient: 'Someone' })).status, 400);
});

test('dashboard: unassigned and late parcels show; assigning moves the parcel on; reassigning stays internal', async () => {
  const dash = await admin.text('/admin');
  assert.match(dash, /Waiting for a rider/);
  assert.match(dash, /<option value="">Choose rider…<\/option>/);                                       // no rider is pre-selected by accident
  assert.equal((await admin.post(`/admin/shipments/${sql("SELECT id FROM shipments WHERE status = 'booked' LIMIT 1").id}/assign`, { rider_id: '' })).status, 400);
  const lateOne = sql("SELECT tracking FROM shipments WHERE status = 'out_for_delivery' AND due_date < date('now') LIMIT 1").tracking;
  assert.match(dash, new RegExp(lateOne));
  assert.match(dash, /Late parcels/);

  const waiting = make();
  assert.match(await admin.text('/admin'), new RegExp(waiting.tracking));
  await admin.post(`/admin/shipments/${waiting.id}/assign`, { rider_id: String(userId('musah')), back: 'dashboard' });
  assert.deepEqual([waiting.row().status, waiting.row().rider_id], ['pickup_scheduled', userId('musah')]);
  assert.doesNotMatch(await admin.text('/admin'), new RegExp(`${waiting.tracking}</a></td>\\s*<td>Test Sender`));

  await admin.post(`/admin/shipments/${waiting.id}/assign`, { rider_id: String(userId('esi')) });
  assert.equal(waiting.row().rider_id, userId('esi'));
  const publicPage = await (await fetch(`${base}/track/${waiting.tracking}`)).text();
  assert.doesNotMatch(publicPage, /Reassigned|Esi|Musah/);
  assert.match(await admin.text(`/admin/shipments/${waiting.id}`), /Reassigned to Esi Owusu/);

  db.prepare("UPDATE users SET active = 0 WHERE username = 'musah'").run();
  assert.equal((await admin.post(`/admin/shipments/${waiting.id}/assign`, { rider_id: String(userId('musah')) })).status, 400);
  db.prepare("UPDATE users SET active = 1 WHERE username = 'musah'").run();
});

test('business account: books on account, bulk is all-or-nothing, cancel only before pickup', async () => {
  const me = userId('shopnest');
  const before = sql('SELECT COUNT(*) AS n FROM shipments').n;
  const res = await shopnest.post('/account/book', { ...PARCEL, sender_name: 'Someone Else', sender_phone: '000', pickup_address: 'Elsewhere', pickup_zone: 'Tema', payment_mode: 'sender_cash', cod_amount: '250' });
  assert.equal(res.status, 302);
  let s = lastShip();
  assert.deepEqual([s.business_id, s.payment_mode, s.sender_name, s.pickup_zone, s.source, s.cod_amount], [me, 'account', 'ShopNest Online', 'Haatso', 'account', 250]);
  assert.equal(s.price, 25 + 5 + 8);

  const bad = await shopnest.post('/account/bulk', { service: 'next_day', lines: 'Ama Test, 024 555 0101, East Legon, 12 Oak Avenue, Sneakers, 2, 250\nBad Line, 024 555 0102, Nowhere, 5 Road, Shirt, 1' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Line 2/);
  assert.equal(sql('SELECT COUNT(*) AS n FROM shipments').n, before + 1);                                    // nothing from the bad batch
  assert.equal((await shopnest.post('/account/bulk', { service: 'next_day', lines: Array(51).fill('A B, 024 555 0101, Haatso, 1 Rd, Item, 1').join('\n') })).status, 400);

  const ok = await shopnest.post('/account/bulk', { service: 'same_day', lines: 'Ama Test, 024 555 0101, East Legon, 12 Oak Avenue, Sneakers, 2, 250\nKofi Test, 024 555 0102, Madina, 5 Market Lane, Shirt, 1' });
  assert.equal(ok.status, 200);
  const page = await ok.text();
  assert.match(page, /2 deliveries booked/);
  assert.match(page, new RegExp(`GH₵${(35 + 5 + 8) + (35 + 4)}`));
  assert.equal(sql('SELECT COUNT(*) AS n FROM shipments').n, before + 3);
  assert.equal(all("SELECT source FROM shipments ORDER BY id DESC LIMIT 2").every((r) => r.source === 'bulk'), true);

  s = lastShip();
  assert.equal((await shopnest.post(`/account/shipments/${s.id}/cancel`)).status, 302);
  assert.equal(ship(s.id).status, 'cancelled');
  const moving = sql("SELECT id FROM shipments WHERE business_id = ? AND status = 'out_for_delivery'", me);
  assert.equal((await shopnest.post(`/account/shipments/${moving.id}/cancel`)).status, 400);
  assert.equal(ship(moving.id).status, 'out_for_delivery');
});

test('business statements: fees on account, cash collected for the business, and the net', async () => {
  const user = (name) => Number(db.prepare("INSERT INTO users (username, name, role, company, phone, address, zone, password_hash) VALUES (?, ?, 'business', ?, '0245550000', 'Addr', 'Haatso', ?)")
    .run(name, name, `${name} Ltd`, d.hashPassword('demo-pass-1')).lastInsertRowid);
  const a = user('stmta');
  const b = user('stmtb');
  const rider = userId('kofi');
  const add = (biz, status, closed, price, cod, collected) => {
    const m = make({ business_id: biz, payment_mode: 'account', cod_amount: cod });
    db.prepare('UPDATE shipments SET status = ?, closed_at = ?, price = ?, rider_id = ? WHERE id = ?').run(status, closed, price, rider, m.id);
    if (collected !== null) db.prepare("INSERT INTO cash_items (shipment_id, rider_id, kind, expected, collected) VALUES (?, ?, 'delivery_collection', ?, ?)").run(m.id, rider, cod, collected);
    return m;
  };
  add(a, 'delivered', '2025-03-05 10:00:00', 40, 300, 300);
  add(a, 'delivered', '2025-03-20 15:00:00', 45, 200, 190);          // collected a little less
  add(a, 'returned', '2025-03-25 09:00:00', 40, 100, null);          // returned: fee charged, nothing collected
  add(a, 'delivered', '2025-04-02 09:00:00', 99, 999, 999);          // other month
  add(a, 'cancelled', '2025-03-10 09:00:00', 77, 0, null);           // cancelled: not billed
  add(b, 'delivered', '2025-03-06 09:00:00', 60, 0, null);           // someone else's parcel

  const st = d.businessStatement(db, a, '2025-03');
  assert.deepEqual([st.delivered, st.returned, st.fees, st.cod, st.net], [2, 1, 125, 490, 365]);              // 40+45+40 fees; 300+190 cod; net owed to the business
  const small = d.businessStatement(db, b, '2025-03');
  assert.deepEqual([small.fees, small.cod, small.net], [60, 0, -60]);                                          // owes the courier

  const cookie = (await login('stmta')).text;
  const page = await cookie('/account/statement?period=2025-03');
  assert.match(page, /GH₵125/);
  assert.match(page, /GH₵490/);
  assert.match(page, /GH₵365/);
  assert.match(page, /We owe you/);
  assert.doesNotMatch(page, /GH₵60\b/);                                                                         // never another business's figures
  assert.match(await (await login('stmtb')).text('/account/statement?period=2025-03'), /You owe us/);
  assert.match(await admin.text(`/admin/statements?business=${a}&period=2025-03`), /GH₵365/);
});

test('riders and customers: validation, deactivation, password change', async () => {
  assert.equal((await admin.post('/admin/people', { role: 'rider', name: 'Dup', phone: '0245550000', username: 'kofi', password: 'password123' })).status, 400);
  assert.equal((await admin.post('/admin/people', { role: 'business', name: 'No Address', company: 'X Ltd', phone: '0245550000', username: 'noaddr', password: 'password123' })).status, 400);
  assert.equal((await admin.post('/admin/people', { role: 'rider', name: 'New Rider', phone: '0245550000', username: 'newrider', password: 'short' })).status, 400);
  assert.equal((await admin.post('/admin/people', { role: 'rider', name: 'New Rider', phone: '0245550000', username: 'newrider', password: 'password123' })).status, 302);
  const nr = await login('newrider', 'password123');
  assert.equal((await nr.get('/rider')).status, 200);

  const m = make();
  d.assignRider(db, m.row(), sql("SELECT * FROM users WHERE username = 'newrider'"), 'Office');
  assert.equal(m.row().status, 'pickup_scheduled');
  await admin.post(`/admin/people/${userId('newrider')}/toggle`);
  assert.deepEqual([m.row().status, m.row().rider_id], ['booked', null]);                                       // uncollected pickup goes back to dispatch
  assert.equal((await nr.get('/rider')).headers.get('location'), '/login');
  assert.equal((await post('/login', { username: 'newrider', password: 'password123' })).status, 401);

  const biz = await login('glow');
  assert.equal((await biz.post('/account-settings/password', { current: 'wrong', next: 'new-password-1', confirm: 'new-password-1' })).status, 400);
  assert.equal((await biz.post('/account-settings/password', { current: 'demo-pass-1', next: 'new-password-1', confirm: 'new-password-1' })).status, 200);
  assert.equal((await post('/login', { username: 'glow', password: 'demo-pass-1' })).status, 401);
  assert.equal((await post('/login', { username: 'glow', password: 'new-password-1' })).status, 302);
  db.prepare("UPDATE users SET password_hash = ? WHERE username = 'glow'").run(d.hashPassword('demo-pass-1'));
});

test('reports and shipments export', async () => {
  const reports = await admin.text('/admin/reports');
  assert.match(reports, /Delivered on time/);
  const delivered = sql("SELECT COUNT(*) AS n, SUM(date(closed_at) <= due_date) AS ok FROM shipments WHERE status = 'delivered'");
  assert.match(reports, new RegExp(`${Math.round(100 * delivered.ok / delivered.n)}%`));
  assert.match(reports, /Riders/);

  db.prepare("UPDATE shipments SET receiver_name = '=HYPERLINK(\"http://x\")' WHERE id = 1").run();
  const res = await admin.get('/admin/shipments.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv.split('\r\n')[0], /"Tracking","Created","Status"/);
});

test('only failed sign-ins count towards the rate limit', async () => {
  const app = createApp({ dbPath: ':memory:', env: { LOGIN_FAILURES: '3' } });
  const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  const url = `http://127.0.0.1:${s.address().port}/login`;
  const attempt = (password) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'kofi', password }) });
  try {
    for (let i = 0; i < 6; i += 1) assert.equal((await attempt('demo-pass-1')).status, 302);
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('wrong')).status, 429);
    assert.equal((await attempt('demo-pass-1')).status, 429);
  } finally { s.close(); }
});

test('production refuses to start without secrets and never creates demo accounts unasked', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  const app = createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production', SESSION_SECRET: 's', ADMIN_PASSWORD: 'p' } });
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n, 0);
});
