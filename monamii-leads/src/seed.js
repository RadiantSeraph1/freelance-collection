// Sample data so the demo is browsable. Every lead, agent and figure here is
// fictional and must be removed before real use (start with SEED_DEMO=off).
const { hashPassword, addNote } = require('./db');

function seedAdmin(db, { adminUser, adminPassword }) {
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, 'Office manager', 'admin', ?)")
      .run(adminUser, hashPassword(adminPassword));
  }
}

function seedDemo(db, { agentPassword }) {
  if (db.prepare('SELECT 1 FROM leads LIMIT 1').get()) return;
  const addAgent = db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'agent', ?)");
  const hash = hashPassword(agentPassword);
  const [kofi, abena, yaw] = [['kofi', 'Kofi'], ['abena', 'Abena'], ['yaw', 'Yaw']].map(([u, n]) => Number(addAgent.run(u, n, hash).lastInsertRowid));

  const when = (days) => db.prepare("SELECT datetime('now', ?) AS t").get(`-${days} days`).t;
  const day = (offset) => db.prepare("SELECT date('now', ?) AS d").get(`${offset >= 0 ? '+' : ''}${offset} days`).d;

  // [name, phone, interest, budget, ref, message, source, stage, agent, daysAgo, hoursToReply, followUpOffset, dealValue, lostReason, lastTouchDaysAgo]
  const leads = [
    ['Abena Frimpong', '024 555 0101', 'buy', 'GH₵ 900k', '3-bed house, East Legon', 'Is it still available? I can view this weekend.', 'website', 'viewing', kofi, 6, 1, 1, null, '', 1],
    ['Daniel Mensah', '020 555 0102', 'rent', '$1,500 / month', '2-bed apartment, Cantonments', 'Looking for a 12-month lease from January.', 'whatsapp', 'contacted', abena, 4, 2, -1, null, '', 2],
    ['Sarah Addo', '055 555 0103', 'land', 'GH₵ 350k', '', 'Serviced plot near Oyarifa.', 'instagram', 'negotiating', yaw, 12, 3, 0, null, '', 1],
    ['Emmanuel Owusu', '027 555 0104', 'off_plan', '$250k', 'Off-plan townhouse', 'Please send the payment plan.', 'facebook', 'contacted', kofi, 9, 20, -3, null, '', 9],
    ['Linda Boateng', '054 555 0105', 'property_management', '', 'Three-unit block, Adenta', 'Need someone to manage tenants and rent collection.', 'referral', 'negotiating', abena, 15, 1, 2, null, '', 3],
    ['Yaw Asante', '', 'construction', 'GH₵ 1.2m', '', 'Want to build a 4-bedroom house on my own land at Dodowa.', 'website', 'new', null, 0, null, 0, null, '', 0],
    ['Grace Tetteh', '026 555 0107', 'buy', 'GH₵ 600k', '', 'Budget is fixed. Any 3-bedroom under 600k?', 'tiktok', 'new', null, 0, null, 0, null, '', 0],
    ['Michael Quaye', '050 555 0108', 'rent', 'GH₵ 4,000 / month', '1-bed apartment, Osu', 'Can I see it today?', 'whatsapp', 'won', kofi, 20, 1, null, 28800, '', 8],
    ['Efua Darko', '024 555 0109', 'buy', 'GH₵ 1.5m', '4-bed house, Spintex', 'We are relocating from the UK.', 'website', 'won', yaw, 30, 2, null, 1450000, '', 14],
    ['Joseph Ankrah', '020 555 0110', 'land', 'GH₵ 200k', '', 'Cheapest plot you have.', 'facebook', 'lost', abena, 18, 30, null, null, 'budget', 11],
    ['Mavis Ofori', '055 555 0111', 'buy', 'GH₵ 800k', '', 'Just browsing for now.', 'instagram', 'lost', kofi, 25, 40, null, null, 'not_serious', 20],
    ['Nana Kwesi', '027 555 0112', 'architecture', 'GH₵ 40k', '', 'Need house plans and permit drawings.', 'linkedin', 'contacted', yaw, 8, 4, 1, null, '', 1],
    ['Patience Nyarko', '054 555 0113', 'consultation', '', '', 'I want advice on buying land safely.', 'phone', 'viewing', abena, 5, 1, 3, null, '', 2],
    ['Kwame Adjei', '026 555 0114', 'rent', '$900 / month', '', 'Furnished one-bedroom please.', 'website', 'won', abena, 22, 3, null, 10800, '', 15],
    ['Ama Serwaa', '024 555 0115', 'buy', 'GH₵ 700k', '', 'Sent two messages, no reply yet.', 'whatsapp', 'lost', yaw, 28, 70, null, null, 'no_response', 21],
    ['Isaac Bonsu', '020 555 0116', 'off_plan', '$180k', '', 'Is the off-plan project still selling?', 'walk-in', 'viewing', kofi, 9, 1, -2, null, '', 8],
  ];

  const insert = db.prepare(`INSERT INTO leads (name, phone, phone_key, email, interest, budget, property_ref, message, source, stage, agent_id,
    created_at, updated_at, first_response_at, next_follow_up, deal_value, lost_reason, closed_at)
    VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [name, phone, interest, budget, ref, message, source, stage, agent, daysAgo, reply, followUp, deal, lost, touched] of leads) {
    const created = when(daysAgo);
    const closed = stage === 'won' || stage === 'lost';
    const lastTouch = when(touched);
    const key = phone.replace(/\D/g, '').slice(-9);
    const firstResponse = reply === null ? null : db.prepare("SELECT datetime(?, ?) AS t").get(created, `+${reply} hours`).t;
    const id = Number(insert.run(name, phone, key, interest, budget, ref, message, source, stage, agent, created, lastTouch, firstResponse,
      closed || followUp === null ? null : day(followUp), deal, lost, closed ? lastTouch : null).lastInsertRowid);
    if (agent) addNote(db, id, 'Assigned automatically.', 'system');
    if (stage !== 'new') addNote(db, id, `Stage: New → ${stage[0].toUpperCase()}${stage.slice(1)}.`, 'demo');
  }
}

module.exports = { seedAdmin, seedDemo };
