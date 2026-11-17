const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { normalizePhone, toWaNumber } = require('../src/db');

let server, base, db, admin, kofi;
const post = (url, data, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(data),
});
const date = (offset) => db.prepare("SELECT date('now', ?) AS d").get(`${offset >= 0 ? '+' : ''}${offset} days`).d;
const lead = (id) => db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
const lastLead = () => db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
const notesOf = (id) => db.prepare('SELECT note FROM lead_notes WHERE lead_id = ? ORDER BY id').all(id).map((n) => n.note);
const agentId = (username) => db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;

async function login(username, password) {
  const res = await post('/admin/login', { username, password });
  assert.equal(res.status, 302, `${username} should sign in`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  return {
    cookie, csrf,
    get: async (url) => fetch(`${base}${url}`, { headers: { cookie }, redirect: 'manual' }),
    text: async (url) => (await fetch(`${base}${url}`, { headers: { cookie } })).text(),
    post: (url, data = {}) => post(url, { _csrf: csrf, ...data }, { cookie }),
  };
}

const api = (body, key = 'demo-key') => fetch(`${base}/api/leads`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify(body),
});

test.before(async () => {
  const app = createApp({ dbPath: ':memory:', env: { ADMIN_PASSWORD: 'test-pass', SESSION_SECRET: 's3cret' } });
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin', 'test-pass');
  kofi = await login('kofi', 'agent123');
});
test.after(() => server.close());

test('phone helpers treat Ghana number formats as one person', () => {
  assert.equal(normalizePhone('024 555 0101'), normalizePhone('+233 24 555 0101'));
  assert.equal(normalizePhone('233-24-555-0101'), '245550101');
  assert.equal(normalizePhone('123'), '');
  assert.equal(toWaNumber('024 555 0101'), '233245550101');
  assert.equal(toWaNumber('+233 24 555 0101'), '233245550101');
  assert.equal(toWaNumber('0044 7700 900123'), '447700900123');
  assert.equal(toWaNumber(''), '');
});

test('public pages and health check respond', async () => {
  assert.equal((await (await fetch(`${base}/healthz`)).json()).status, 'ok');
  assert.match(await (await fetch(`${base}/enquire?src=instagram`)).text(), /name="source" value="instagram"/);
  assert.match(await (await fetch(`${base}/enquire?src=<script>`)).text(), /name="source" value="website"/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('web form: validates, escapes, drops bots, and shares leads between agents', async () => {
  assert.equal((await post('/enquire', { name: 'A' })).status, 400);
  const before = db.prepare('SELECT COUNT(*) AS n FROM leads').get().n;
  assert.equal((await post('/enquire', { name: 'Bot', email: 'bot@example.com', website: 'x' })).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, before);

  // Seeded open leads: Kofi 3, Abena 3, Yaw 2, so Yaw gets the next one, then the tie goes to Kofi.
  assert.equal((await post('/enquire', { name: '<b>Ekua</b>', phone: '+233 24 700 0001', interest: 'land', source: 'instagram' })).status, 302);
  const first = lastLead();
  assert.equal(first.source, 'instagram');
  assert.equal(first.agent_id, agentId('yaw'));
  assert.equal(first.next_follow_up, date(0));
  assert.deepEqual(notesOf(first.id), ['Assigned to Yaw automatically.']);
  assert.match(await admin.text(`/admin/leads/${first.id}`), /&lt;b&gt;Ekua&lt;\/b&gt;/);

  await post('/enquire', { name: 'Kojo Mintah', phone: '+233 24 700 0002' });
  assert.equal(lastLead().agent_id, agentId('kofi'));
});

test('a repeat enquiry from another channel merges into the open lead', async () => {
  const existing = db.prepare("SELECT * FROM leads WHERE name = 'Daniel Mensah'").get(); // phone 020 555 0102, open
  const res = await api({ name: 'Daniel M', phone: '+233 20 555 0102', source: 'facebook', message: 'Is the Cantonments flat still free?' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: existing.id, duplicate: true });
  const after = lead(existing.id);
  assert.equal(after.repeat_count, 1);
  assert.equal(after.next_follow_up, date(0));
  assert.match(notesOf(existing.id).at(-1), /Enquired again via facebook .*Cantonments/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leads WHERE phone_key = '205550102'").get().n, 1);
  // Matching by email works too.
  db.prepare("UPDATE leads SET email = 'sarah@example.com' WHERE name = 'Sarah Addo'").run();
  const byEmail = await api({ name: 'Sarah', email: 'SARAH@example.com' });
  assert.equal((await byEmail.json()).duplicate, true);
});

test('a returning customer whose lead is closed gets a fresh lead', async () => {
  const res = await api({ name: 'Joseph Ankrah', phone: '020 555 0110', source: 'whatsapp', message: 'I now have more budget' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).duplicate, false);
});

test('API needs the key and a valid payload', async () => {
  assert.equal((await api({ name: 'X', phone: '0245550000' }, null)).status, 401);
  assert.equal((await api({ name: 'X', phone: '0245550000' }, 'wrong')).status, 401);
  const bad = await api({ name: 'X' });
  assert.equal(bad.status, 422);
  assert.ok((await bad.json()).errors.length >= 1);
  const ok = await api({ name: 'Wordpress Visitor', email: 'wp@example.com', source: 'website', interest: 'rent', property_ref: 'Listing 42' });
  assert.equal(ok.status, 201);
  assert.equal(lastLead().property_ref, 'Listing 42');
  const broken = await fetch(`${base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'demo-key' }, body: '{nope' });
  assert.equal(broken.status, 400);
});

test('staff area needs sign-in, a CSRF token, and respects roles', async () => {
  assert.equal((await fetch(`${base}/admin/leads`, { redirect: 'manual' })).headers.get('location'), '/admin/login');
  assert.equal((await post('/admin/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await post('/admin/team', { name: 'X', username: 'xxx', password: 'password1' }, { cookie: admin.cookie })).status, 403);

  assert.equal((await kofi.get('/admin/reports')).status, 403);
  assert.equal((await kofi.get('/admin/team')).status, 403);
  assert.equal((await kofi.get('/admin/leads.csv')).status, 403);
  assert.equal((await admin.get('/admin/reports')).status, 200);

  const mine = await kofi.text('/admin');
  assert.match(mine, /My day/);
  assert.match(mine, /Isaac Bonsu/);          // Kofi's, overdue
  assert.doesNotMatch(mine, /Daniel Mensah/); // Abena's
  assert.match(await kofi.text('/admin/?all=1'), /Daniel Mensah/);
});

test('stage changes: lost needs a reason, follow-ups default, response time and close date recorded', async () => {
  const id = db.prepare("SELECT id FROM leads WHERE name = 'Grace Tetteh'").get().id; // new, no response yet
  assert.equal(lead(id).first_response_at, null);

  assert.equal((await admin.post(`/admin/leads/${id}`, { stage: 'lost', lost_reason: '' })).status, 400);
  assert.equal(lead(id).stage, 'new');

  await admin.post(`/admin/leads/${id}`, { stage: 'contacted', agent_id: String(agentId('abena')), note: 'Called, will send options' });
  let l = lead(id);
  assert.equal(l.stage, 'contacted');
  assert.equal(l.next_follow_up, date(2));            // automatic follow-up
  assert.equal(l.agent_id, agentId('abena'));
  assert.ok(l.first_response_at);
  assert.match(notesOf(id).at(-1), /Stage: New → Contacted\. Reassigned to Abena\. Called, will send options/);

  await admin.post(`/admin/leads/${id}`, { stage: 'contacted', next_follow_up: date(5) }); // explicit date kept
  assert.equal(lead(id).next_follow_up, date(5));
  await admin.post(`/admin/leads/${id}`, { stage: 'contacted' });                          // no stage change: unchanged
  assert.equal(lead(id).next_follow_up, date(5));

  await admin.post(`/admin/leads/${id}`, { stage: 'won', deal_value: '650000', next_follow_up: date(9) });
  l = lead(id);
  assert.deepEqual([l.stage, l.next_follow_up, l.deal_value], ['won', null, 650000]);
  assert.ok(l.closed_at);

  await admin.post(`/admin/leads/${id}`, { stage: 'negotiating' }); // reopened
  l = lead(id);
  assert.deepEqual([l.closed_at, l.deal_value, l.next_follow_up], [null, null, date(2)]);

  await admin.post(`/admin/leads/${id}`, { stage: 'lost', lost_reason: 'budget' });
  l = lead(id);
  assert.deepEqual([l.stage, l.lost_reason], ['lost', 'budget']);
  assert.ok(l.closed_at);
});

test('WhatsApp button builds a message from the lead and agent', async () => {
  const id = db.prepare("SELECT id FROM leads WHERE name = 'Nana Kwesi'").get().id;
  const page = await kofi.text(`/admin/leads/${id}`);
  const href = page.match(/href="(https:\/\/wa\.me\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(href, /^https:\/\/wa\.me\/233275550112\?text=/);
  const text = decodeURIComponent(href.split('text=')[1]);
  assert.match(text, /Hello Nana, this is Kofi from Monamii Construction, following up on architecture design/);
});

test('unassigned leads can be assigned from the dashboard', async () => {
  const id = db.prepare("SELECT id FROM leads WHERE name = 'Yaw Asante'").get().id;
  assert.equal(lead(id).agent_id, null);
  assert.match(await admin.text('/admin'), /Needs an agent/);
  await admin.post(`/admin/leads/${id}/assign`, { agent_id: String(agentId('yaw')) });
  assert.equal(lead(id).agent_id, agentId('yaw'));
  assert.match(notesOf(id).at(-1), /Assigned to Yaw\./);
  await admin.post(`/admin/leads/${id}/assign`, { agent_id: '999' }); // unknown agent ignored
  assert.equal(lead(id).agent_id, agentId('yaw'));
});

test('staff can log a lead by hand; duplicates are merged', async () => {
  assert.equal((await admin.post('/admin/leads', { name: '', phone: '' })).status, 400);
  const res = await admin.post('/admin/leads', { name: 'Walk In Customer', phone: '0555550199', source: 'walk-in', interest: 'buy', agent_id: String(agentId('abena')), next_follow_up: date(3) });
  assert.equal(res.status, 302);
  const l = lastLead();
  assert.deepEqual([l.source, l.agent_id, l.next_follow_up], ['walk-in', agentId('abena'), date(3)]);
  const again = await admin.post('/admin/leads', { name: 'Walk In Customer', phone: '+233 55 555 0199', source: 'phone' });
  assert.match(again.headers.get('location'), new RegExp(`/admin/leads/${l.id}\\?duplicate=1`));
});

test('team: add agents, switch auto-assign off, deactivate returns leads', async () => {
  assert.equal((await admin.post('/admin/team', { name: 'Short', username: 'ab', password: 'x' })).status, 400);
  assert.equal((await admin.post('/admin/team', { name: 'Dup', username: 'kofi', password: 'password123' })).status, 400);
  assert.equal((await admin.post('/admin/team', { name: 'Esi', username: 'esi', password: 'password123' })).status, 302);
  const esi = await login('esi', 'password123');
  assert.equal((await esi.get('/admin')).status, 200);

  // Auto-assign off: new leads wait in the queue.
  await admin.post('/admin/team/auto-assign', {});
  await post('/enquire', { name: 'Queue Person', phone: '0245559999' });
  assert.equal(lastLead().agent_id, null);
  await admin.post('/admin/team/auto-assign', { auto_assign: 'on' });

  // Deactivate Kofi: his open leads go back to the queue and his session stops working.
  const kofiOpen = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE agent_id = ? AND stage IN ('new','contacted','viewing','negotiating')").get(agentId('kofi')).n;
  assert.ok(kofiOpen > 0);
  await admin.post(`/admin/team/${agentId('kofi')}/toggle`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads WHERE agent_id = ?').get(agentId('kofi')).n, db.prepare("SELECT COUNT(*) AS n FROM leads WHERE agent_id = ? AND stage IN ('won','lost')").get(agentId('kofi')).n);
  assert.match(notesOf(db.prepare("SELECT id FROM leads WHERE name = 'Isaac Bonsu'").get().id).at(-1), /Returned to the unassigned queue: Kofi was deactivated/);
  assert.equal((await kofi.get('/admin')).headers.get('location'), '/admin/login');
  assert.equal((await post('/admin/login', { username: 'kofi', password: 'agent123' })).status, 401);
  // Deactivated agents are not offered for new leads.
  await post('/enquire', { name: 'After Kofi', phone: '0245558888' });
  assert.notEqual(lastLead().agent_id, agentId('kofi'));
});

test('reports add up and the CSV is formula-safe', async () => {
  const page = await admin.text('/admin/reports');
  assert.match(page, /Which channels produce customers/);
  const won = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(deal_value), 0) AS v FROM leads WHERE stage = 'won'").get();
  assert.match(page, new RegExp(`GH₵${won.v.toLocaleString('en-US')}`));

  await admin.post('/admin/leads', { name: '=HYPERLINK("http://x")', phone: '0245557777', source: 'phone' });
  const res = await admin.get('/admin/leads.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(csv.split('\r\n')[0], /"Name","Phone"/);
});

test('production refuses to start without secrets, and keeps the API off without a key', async () => {
  assert.throws(() => createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production' } }), /SESSION_SECRET/);
  const app = createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production', SESSION_SECRET: 's', ADMIN_PASSWORD: 'p' } }); // no SEED_DEMO: must not create demo agents
  const s = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': '' }, body: '{"name":"Zed","phone":"0245550000"}' });
    assert.equal(res.status, 401);
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1); // only the manager, no demo agents
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 0);
  } finally { s.close(); }
});
