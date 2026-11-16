const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let server, base, db;
const form = (data) => ({
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(data._headers || {}) },
  body: new URLSearchParams(Object.fromEntries(Object.entries(data).filter(([k]) => k !== '_headers'))),
});

test.before(async () => {
  const app = createApp({ dbPath: ':memory:', env: { ADMIN_PASSWORD: 'test-pass', SESSION_SECRET: 's3cret' } });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function login() {
  const res = await fetch(`${base}/admin/login`, form({ username: 'admin', password: 'test-pass' }));
  assert.equal(res.status, 302);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  return { cookie, csrf };
}

test('health check and home page respond', async () => {
  assert.deepEqual((await (await fetch(`${base}/healthz`)).json()).status, 'ok');
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Featured properties/);
});

test('catalogue filters narrow the results', async () => {
  const all = await (await fetch(`${base}/properties`)).text();
  assert.match(all, /8 properties found/);
  const rent = await (await fetch(`${base}/properties?listing=rent&type=apartment`)).text();
  assert.match(rent, /2 properties found/);
  assert.doesNotMatch(rent, /RV-101/);
  const priced = await (await fetch(`${base}/properties?currency=USD&max=250000&listing=sale`)).text();
  assert.match(priced, /1 property found/);
  assert.match(priced, /RV-103/);
  const none = await (await fetch(`${base}/properties?q=zzzz`)).text();
  assert.match(none, /No properties match/);
});

test('unknown property is a 404', async () => {
  assert.equal((await fetch(`${base}/properties/9999`)).status, 404);
});

test('public enquiry is validated, saved and escaped', async () => {
  const bad = await fetch(`${base}/enquiries`, form({ property_id: '1', name: 'A', phone: '', email: '' }));
  assert.equal(bad.status, 400);

  const before = db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n;
  const ok = await fetch(`${base}/enquiries`, form({ property_id: '1', name: '<b>Kwame</b>', phone: '+233 24 111 2222', message: 'Call me' }));
  assert.equal(ok.status, 302);
  const row = db.prepare('SELECT * FROM enquiries ORDER BY id DESC LIMIT 1').get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, before + 1);
  assert.equal(row.source, 'website');
  assert.equal(row.status, 'new');
  assert.equal(row.property_id, 1);

  const { cookie } = await login();
  const page = await (await fetch(`${base}/admin/enquiries/${row.id}`, { headers: { cookie } })).text();
  assert.match(page, /&lt;b&gt;Kwame&lt;\/b&gt;/);
});

test('honeypot submissions are dropped silently', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n;
  const res = await fetch(`${base}/enquiries`, form({ name: 'Bot', email: 'bot@example.com', website: 'http://spam' }));
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM enquiries').get().n, before);
});

test('admin pages require sign-in and reject a wrong password', async () => {
  const res = await fetch(`${base}/admin/enquiries`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
  const wrong = await fetch(`${base}/admin/login`, form({ username: 'admin', password: 'nope' }));
  assert.equal(wrong.status, 401);
  const forged = await fetch(`${base}/admin`, { redirect: 'manual', headers: { cookie: 'rv_session=eyJ1c2VyIjoiYWRtaW4ifQ.bad' } });
  assert.equal(forged.status, 302);
});

test('admin posts need the CSRF token', async () => {
  const { cookie } = await login();
  const res = await fetch(`${base}/admin/properties`, form({ title: 'No token', location: 'Osu', price: '1', _headers: { cookie } }));
  assert.equal(res.status, 403);
});

test('staff can add, edit and delete a listing', async () => {
  const { cookie, csrf } = await login();
  const h = { cookie };
  const invalid = await fetch(`${base}/admin/properties`, form({ _csrf: csrf, title: 'Bad photo', location: 'Osu', price: '10', image_url: 'javascript:alert(1)', _headers: h }));
  assert.equal(invalid.status, 400);

  const created = await fetch(`${base}/admin/properties`, form({ _csrf: csrf, title: 'Test villa', type: 'house', listing: 'sale', location: 'Labone', price: '500000', currency: 'USD', bedrooms: '4', _headers: h }));
  assert.equal(created.status, 302);
  const row = db.prepare("SELECT * FROM properties WHERE title = 'Test villa'").get();
  assert.equal(row.ref, 'RV-109');
  assert.match(await (await fetch(`${base}/properties?location=Labone`)).text(), /Test villa/);

  await fetch(`${base}/admin/properties/${row.id}`, form({ _csrf: csrf, title: 'Test villa', type: 'house', listing: 'sale', location: 'Labone', price: '480000', currency: 'USD', status: 'sold', _headers: h }));
  assert.equal(db.prepare('SELECT price FROM properties WHERE id = ?').get(row.id).price, 480000);
  assert.doesNotMatch(await (await fetch(`${base}/properties?location=Labone`)).text(), /Test villa/);

  await fetch(`${base}/admin/properties/${row.id}/delete`, form({ _csrf: csrf, _headers: h }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM properties WHERE id = ?').get(row.id).n, 0);
});

test('staff can log an enquiry and track follow-up', async () => {
  const { cookie, csrf } = await login();
  const h = { cookie };
  const res = await fetch(`${base}/admin/enquiries`, form({ _csrf: csrf, name: 'Esi Asante', phone: '+233 20 555 0000', source: 'whatsapp', property_id: '2', next_follow_up: '2020-01-01', _headers: h }));
  assert.equal(res.status, 302);
  const id = Number(res.headers.get('location').split('/').pop());

  const due = await (await fetch(`${base}/admin/enquiries?due=1`, { headers: h })).text();
  assert.match(due, /Esi Asante/);

  await fetch(`${base}/admin/enquiries/${id}`, form({ _csrf: csrf, status: 'viewing', assigned_to: 'Kofi', next_follow_up: '2099-01-01', note: 'Viewing booked for Saturday', _headers: h }));
  const row = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  assert.equal(row.status, 'viewing');
  assert.equal(row.assigned_to, 'Kofi');
  assert.equal(row.next_follow_up, '2099-01-01');
  const note = db.prepare('SELECT * FROM enquiry_notes WHERE enquiry_id = ?').get(id);
  assert.match(note.note, /Status: New → Viewing booked\. Viewing booked for Saturday/);
  assert.equal(note.author, 'admin');

  await fetch(`${base}/admin/enquiries/${id}`, form({ _csrf: csrf, status: 'won', next_follow_up: '2099-01-01', _headers: h }));
  assert.equal(db.prepare('SELECT next_follow_up FROM enquiries WHERE id = ?').get(id).next_follow_up, null);

  const dash = await (await fetch(`${base}/admin`, { headers: h })).text();
  assert.match(dash, /Where enquiries come from/);
});

test('production refuses to start without secrets', () => {
  assert.throws(() => createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
});
