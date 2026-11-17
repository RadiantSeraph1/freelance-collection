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
  assert.match(await home.text(), /Properties we are proud to show/);
});

test('catalogue filters narrow the results', async () => {
  const all = await (await fetch(`${base}/properties`)).text();
  assert.match(all, /11 properties found/);
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
  assert.equal(row.ref, 'RV-112');
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

test('every bundled photo a listing points at exists, and pages use no inline styles', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const rows = db.prepare('SELECT image_url, gallery FROM properties').all();
  for (const r of rows) {
    for (const u of [r.image_url, ...r.gallery.split('\n')].filter(Boolean)) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', u)), `missing ${u}`);
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', u.replace('-lg.jpg', '-md.jpg'))), `missing small copy of ${u}`);
    }
  }
  for (const url of ['/', '/properties', '/properties/1', '/contact', '/admin/login']) {
    const html = await (await fetch(`${base}${url}`)).text();
    assert.doesNotMatch(html, /\sstyle="/, `${url} has an inline style, which the CSP blocks`);
  }
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
});

test('property page shows a photo gallery and a payment calculator for sales only', async () => {
  const sale = await (await fetch(`${base}/properties/1`)).text();
  assert.match(sale, /data-gallery-main/);
  assert.match(sale, /data-calc/);
  const rent = await (await fetch(`${base}/properties/2`)).text();
  assert.doesNotMatch(rent, /data-calc/);
});

test('staff can save extra gallery photos, and bad links are refused', async () => {
  const { cookie, csrf } = await login();
  const h = { cookie };
  const base_ = { _csrf: csrf, title: 'Gallery test', location: 'Osu', price: '1000', _headers: h };
  const bad = await fetch(`${base}/admin/properties`, form({ ...base_, gallery: 'https://ok.example/a.jpg\njavascript:alert(1)' }));
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/admin/properties`, form({ ...base_, image_url: '/img/villa-dusk-lg.jpg', gallery: 'https://ok.example/a.jpg\n/img/apt-bright-lg.jpg' }));
  assert.equal(ok.status, 302);
  const row = db.prepare("SELECT * FROM properties WHERE title = 'Gallery test'").get();
  assert.equal(row.gallery.split('\n').length, 2);
});

test('persistence: changes are saved to Blob storage and restored by a new instance', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { buildHandler } = require('../src/persist');

  // A stand-in for @vercel/blob that keeps files in memory.
  const store = new Map();
  const client = {
    async get(key) { return store.has(key) ? { stream: new Response(store.get(key)).body } : null; },
    async put(key, body) { store.set(key, Buffer.from(body)); },
  };
  const env = { BLOB_READ_WRITE_TOKEN: 'fake', ADMIN_PASSWORD: 'p', SESSION_SECRET: 's' };
  const launch = async (dir) => {
    const handler = buildHandler({ name: 'romeoville', env, client, tmpDir: dir, createApp: (o) => require('../server').createApp({ ...o, env }) });
    const srv = await new Promise((resolve) => { const s = require('node:http').createServer(handler).listen(0, () => resolve(s)); });
    return { srv, url: `http://127.0.0.1:${srv.address().port}` };
  };
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-b-'));

  const a = await launch(dirA);
  assert.equal((await fetch(`${a.url}/healthz`)).status, 200);
  assert.ok(store.has('romeoville/app.db'), 'first start stores the seeded database');
  const sent = await fetch(`${a.url}/enquiries`, form({ name: 'Persisted Person', phone: '+233 24 555 0000', message: 'hello' }));
  assert.equal(sent.status, 302);
  // A read-only request must not trigger an upload.
  const before = store.get('romeoville/app.db');
  await fetch(`${a.url}/properties`);
  assert.equal(store.get('romeoville/app.db'), before);
  a.srv.close();

  // A brand-new instance (empty /tmp) sees the saved enquiry.
  const b = await launch(dirB);
  assert.equal((await fetch(`${b.url}/healthz`)).status, 200);
  const copy = path.join(dirB, 'check.db');
  fs.writeFileSync(copy, store.get('romeoville/app.db'));
  const row = new DatabaseSync(copy).prepare("SELECT name FROM enquiries WHERE name = 'Persisted Person'").get();
  assert.equal(row.name, 'Persisted Person');
  const page = await fetch(`${b.url}/`);
  assert.doesNotMatch(await page.text(), /temporary and may disappear/);
  b.srv.close();
});

test('persistence: when storage fails the app answers 503 and retries later', async () => {
  const { buildHandler } = require('../src/persist');
  let fail = true;
  const client = { async get() { if (fail) throw new Error('down'); return null; }, async put() {} };
  const env = { BLOB_READ_WRITE_TOKEN: 'fake', ADMIN_PASSWORD: 'p', SESSION_SECRET: 's' };
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'persist-c-'));
  const handler = buildHandler({ name: 'romeoville', env, client, tmpDir: dir, createApp: (o) => require('../server').createApp({ ...o, env }) });
  const srv = await new Promise((resolve) => { const s = require('node:http').createServer(handler).listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await fetch(`${url}/healthz`)).status, 503);
  fail = false;
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  srv.close();
});
