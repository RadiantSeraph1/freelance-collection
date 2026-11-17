const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  openDb, verifyPassword, hashPassword, captureLead, addNote, daysFromNow, toWaNumber, getSetting, setSetting,
  STAGES, OPEN_STAGES, OPEN_SQL, INTERESTS, SOURCES, LOST_REASONS, FOLLOW_UP_DAYS,
} = require('./src/db');
const { seedAdmin, seedDemo } = require('./src/seed');
const { sessionMiddleware } = require('./src/session');

const LABELS = {
  new: 'New', contacted: 'Contacted', viewing: 'Viewing / meeting booked', negotiating: 'Negotiating', won: 'Won', lost: 'Lost',
  buy: 'Buy a property', rent: 'Rent a property', land: 'Land', off_plan: 'Off-plan', property_management: 'Property management',
  construction: 'Construction', architecture: 'Architecture design', consultation: 'Consultation', other: 'Other',
  website: 'Website', whatsapp: 'WhatsApp', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn',
  phone: 'Phone call', 'walk-in': 'Walk-in', referral: 'Referral',
  budget: 'Budget too low', bought_elsewhere: 'Bought elsewhere', no_response: 'Stopped responding', not_serious: 'Just browsing', location: 'Wrong location',
  admin: 'Manager', agent: 'Agent',
};
const SHORT_STAGE = { new: 'New', contacted: 'Contacted', viewing: 'Viewing', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };

const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const intOrNull = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
// Stops spreadsheet programs treating a cell as a formula.
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

function validateLead(input) {
  const lead = {
    name: clean(input.name, 100), phone: clean(input.phone, 30), email: clean(input.email, 120),
    interest: oneOf(input.interest, INTERESTS, 'other'), budget: clean(input.budget, 60),
    property_ref: clean(input.property_ref, 120), message: clean(input.message, 2000),
    source: oneOf(input.source, SOURCES, 'website'),
  };
  const errors = [];
  if (lead.name.length < 2) errors.push('Please enter your name.');
  if (!lead.phone && !lead.email) errors.push('Please give a phone number or an email address so we can reply.');
  if (lead.phone && !/^[+\d][\d\s()-]{6,}$/.test(lead.phone)) errors.push('That phone number does not look right.');
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push('That email address does not look right.');
  return { lead, errors };
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  if (production && (!env.SESSION_SECRET || !env.ADMIN_PASSWORD)) {
    throw new Error('SESSION_SECRET and ADMIN_PASSWORD must be set in production');
  }

  const site = {
    name: env.SITE_NAME || 'Monamii Construction',
    phone: env.SITE_PHONE || '+233 00 000 0000',
    email: env.SITE_EMAIL || 'sales@example.com',
    demo: env.DEMO_BANNER !== 'off',
  };
  site.whatsapp = (env.SITE_WHATSAPP || site.phone).replace(/\D/g, '');
  // Outside production a fixed demo key lets the API be tried straight away;
  // in production the API stays off until a real key is configured.
  const apiKey = env.LEAD_API_KEY || (production ? '' : 'demo-key');
  const staleDays = Number(env.STALE_DAYS) || 7;

  const db = openDb(options.dbPath || env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
  seedAdmin(db, { adminUser: env.ADMIN_USER || 'admin', adminPassword: env.ADMIN_PASSWORD || 'admin123' });
  if (env.SEED_DEMO !== 'off') seedDemo(db, { agentPassword: env.AGENT_DEMO_PASSWORD || 'agent123' });
  const today = () => daysFromNow(db, 0);

  const app = express();
  app.locals.db = db;
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  if (production) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: production ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(express.json({ limit: '50kb' }));
  app.use(sessionMiddleware(env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), production));

  app.use((req, res, next) => {
    Object.assign(res.locals, {
      site, label: (k) => LABELS[k] || k, session: req.session, path: req.path, me: null,
      money: (amount) => `GH₵${Number(amount || 0).toLocaleString('en-US')}`,
      waLink: (phone, text) => `https://wa.me/${toWaNumber(phone)}?text=${encodeURIComponent(text)}`,
    });
    next();
  });

  const hits = new Map();
  const limit = (max, windowMs, status = 'page') => (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return status === 'json'
        ? res.status(429).json({ error: 'Too many requests' })
        : res.status(429).render('message', { title: 'Please try again later', body: 'Too many requests from your connection. Please wait a few minutes or call us instead.' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // ---------- Lead capture: web form and API ----------

  const enquiryPage = (res, status = 200, extra = {}) => res.status(status).render('enquire', {
    title: 'Make an enquiry', errors: [], form: {}, INTERESTS, SOURCES, ...extra,
  });

  app.get('/', (req, res) => enquiryPage(res, 200, { form: { source: oneOf(req.query.src, SOURCES, 'website'), interest: oneOf(req.query.interest, INTERESTS, '') } }));
  app.get('/enquire', (req, res) => enquiryPage(res, 200, { form: { source: oneOf(req.query.src, SOURCES, 'website'), interest: oneOf(req.query.interest, INTERESTS, '') } }));

  app.post('/enquire', limit(5, 10 * 60 * 1000), (req, res) => {
    if (clean(req.body.website)) return res.redirect('/enquire/thanks'); // honeypot
    const { lead, errors } = validateLead(req.body);
    if (errors.length) return enquiryPage(res, 400, { errors, form: lead });
    captureLead(db, lead, { actor: 'web form' });
    res.redirect('/enquire/thanks');
  });

  app.get('/enquire/thanks', (req, res) => {
    res.render('message', { title: 'Thank you', body: 'We have received your enquiry and one of our agents will contact you shortly.' });
  });

  // Lets the existing website forms, Zapier, a WhatsApp tool or any other
  // system push an enquiry in: POST /api/leads with an X-API-Key header.
  app.post('/api/leads', limit(60, 10 * 60 * 1000, 'json'), (req, res) => {
    const given = Buffer.from(String(req.get('x-api-key') || ''));
    const wanted = Buffer.from(apiKey);
    if (!apiKey || given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
      return res.status(401).json({ error: 'Missing or wrong X-API-Key' });
    }
    const { lead, errors } = validateLead(req.body || {});
    if (errors.length) return res.status(422).json({ errors });
    const result = captureLead(db, lead, { actor: 'api' });
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  // ---------- Staff area ----------

  app.get('/admin/login', (req, res) => {
    if (req.session) return res.redirect('/admin');
    res.render('admin/login', { title: 'Staff sign in', error: null });
  });

  app.post('/admin/login', limit(8, 10 * 60 * 1000), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(clean(req.body.username, 60).toLowerCase());
    if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      return res.status(401).render('admin/login', { title: 'Staff sign in', error: 'Wrong username or password.' });
    }
    res.startSession(user.username);
    res.redirect('/admin');
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const me = req.session && db.prepare('SELECT id, username, name, role FROM users WHERE username = ? AND active = 1').get(req.session.user);
    if (!me) { res.endSession(); return res.redirect('/admin/login'); }
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
      return res.status(403).render('message', { title: 'Session expired', body: 'Please go back, refresh the page and try again.' });
    }
    req.me = me;
    res.locals.me = me;
    res.locals.csrf = req.session.csrf;
    res.set('Cache-Control', 'no-store');
    next();
  });

  const managerOnly = (req, res, next) => (req.me.role === 'admin' ? next()
    : res.status(403).render('message', { title: 'Managers only', body: 'This page is only available to the office manager.' }));

  admin.post('/logout', (req, res) => { res.endSession(); res.redirect('/'); });

  const agents = () => db.prepare("SELECT id, name FROM users WHERE role = 'agent' AND active = 1 ORDER BY name").all();
  const STALE_SQL = `(l.stage IN (${OPEN_SQL}) AND l.updated_at < datetime('now', '-${staleDays} days'))`;
  const LEAD_SELECT = `SELECT l.*, u.name AS agent_name, date('now') AS today,
      (l.stage IN (${OPEN_SQL}) AND l.next_follow_up <= date('now')) AS due,
      ${STALE_SQL} AS stale
    FROM leads l LEFT JOIN users u ON u.id = l.agent_id`;
  const getLead = (id) => db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(intOrNull(id));

  admin.get('/', (req, res) => {
    const scope = req.query.all === '1' || req.me.role === 'admin' ? '' : ' AND l.agent_id = ?';
    const sp = scope ? [req.me.id] : [];
    const count = (where, ...p) => db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}${scope}`).get(...p, ...sp).n;
    const stats = {
      unassigned: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE stage = 'new' AND agent_id IS NULL`).get().n,
      newLeads: count("l.stage = 'new'"),
      due: count(`l.stage IN (${OPEN_SQL}) AND l.next_follow_up <= date('now')`),
      stale: count(STALE_SQL),
      open: count(`l.stage IN (${OPEN_SQL})`),
      wonMonth: count("l.stage = 'won' AND l.closed_at >= date('now', 'start of month')"),
    };
    const due = db.prepare(`${LEAD_SELECT} WHERE l.stage IN (${OPEN_SQL}) AND l.next_follow_up <= date('now')${scope}
      ORDER BY l.next_follow_up, l.id LIMIT 12`).all(...sp);
    const unassigned = db.prepare(`${LEAD_SELECT} WHERE l.stage = 'new' AND l.agent_id IS NULL ORDER BY l.created_at`).all();
    const stale = db.prepare(`${LEAD_SELECT} WHERE ${STALE_SQL}${scope} ORDER BY l.updated_at LIMIT 8`).all(...sp);
    res.render('admin/dashboard', { title: 'Dashboard', stats, due, unassigned, stale, agents: agents(), staleDays, mineOnly: Boolean(scope) });
  });

  admin.get('/pipeline', (req, res) => {
    const agent = oneOf(req.query.agent ?? '', ['', 'none', ...agents().map((a) => String(a.id))], '');
    const where = [`l.stage IN (${OPEN_SQL})`];
    const params = [];
    if (agent === 'none') where.push('l.agent_id IS NULL');
    else if (agent) { where.push('l.agent_id = ?'); params.push(Number(agent)); }
    const rows = db.prepare(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.next_follow_up, l.id`).all(...params);
    const columns = OPEN_STAGES.map((stage) => ({ stage, leads: rows.filter((l) => l.stage === stage) }));
    res.render('admin/pipeline', { title: 'Pipeline', columns, agent, agents: agents() });
  });

  admin.get('/leads', (req, res) => {
    const f = {
      q: clean(req.query.q, 80),
      stage: oneOf(req.query.stage, [...STAGES, 'open'], ''),
      source: oneOf(req.query.source, SOURCES, ''),
      interest: oneOf(req.query.interest, INTERESTS, ''),
      agent: clean(req.query.agent, 10),
      flag: oneOf(req.query.flag, ['due', 'stale'], ''),
    };
    const where = ['1 = 1'];
    const params = [];
    if (f.q) { where.push('(l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ? OR l.property_ref LIKE ? OR l.message LIKE ?)'); params.push(...Array(5).fill(`%${f.q}%`)); }
    if (f.stage === 'open') where.push(`l.stage IN (${OPEN_SQL})`);
    else if (f.stage) { where.push('l.stage = ?'); params.push(f.stage); }
    if (f.source) { where.push('l.source = ?'); params.push(f.source); }
    if (f.interest) { where.push('l.interest = ?'); params.push(f.interest); }
    if (f.agent === 'none') where.push('l.agent_id IS NULL');
    else if (f.agent === 'me') { where.push('l.agent_id = ?'); params.push(req.me.id); }
    else if (intOrNull(f.agent) !== null) { where.push('l.agent_id = ?'); params.push(intOrNull(f.agent)); }
    if (f.flag === 'due') where.push(`l.stage IN (${OPEN_SQL}) AND l.next_follow_up <= date('now')`);
    if (f.flag === 'stale') where.push(STALE_SQL);
    const leads = db.prepare(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT 300`).all(...params);
    res.render('admin/leads', { title: 'Leads', leads, f, agents: agents(), STAGES, SOURCES, INTERESTS });
  });

  const newLeadForm = (res, status, form = {}, errors = []) => res.status(status).render('admin/lead-new', {
    title: 'Log a lead', form, errors, agents: agents(), SOURCES, INTERESTS,
  });

  admin.get('/leads/new', (req, res) => newLeadForm(res, 200, { source: 'whatsapp' }));

  admin.post('/leads', (req, res) => {
    const { lead, errors } = validateLead({ ...req.body, source: oneOf(req.body.source, SOURCES, 'phone') });
    const agentId = intOrNull(req.body.agent_id);
    const chosen = agentId && db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent' AND active = 1").get(agentId);
    const form = { ...lead, agent_id: agentId, next_follow_up: req.body.next_follow_up };
    if (errors.length) return newLeadForm(res, 400, form, errors.map((e) => e.replace('Please enter your name', 'Enter the lead’s name')));
    const result = captureLead(db, {
      ...lead, agent_id: chosen ? chosen.id : undefined,
      next_follow_up: isDate(req.body.next_follow_up) ? req.body.next_follow_up : undefined,
    }, { actor: req.me.name });
    res.redirect(`/admin/leads/${result.id}${result.duplicate ? '?duplicate=1' : ''}`);
  });

  const waText = (lead, me) => {
    const first = lead.name.split(' ')[0];
    const who = me.role === 'agent' ? me.name : (lead.agent_name || 'the team');
    const topic = lead.property_ref || LABELS[lead.interest].toLowerCase();
    const templates = {
      new: `Hello ${first}, this is ${who} from ${site.name}. Thank you for your enquiry about ${topic}. When is a good time to talk?`,
      contacted: `Hello ${first}, this is ${who} from ${site.name}, following up on ${topic}. Do you have any questions I can help with?`,
      viewing: `Hello ${first}, this is ${who} from ${site.name}. Just confirming our viewing for ${topic}. Please let me know if the time still works.`,
      negotiating: `Hello ${first}, this is ${who} from ${site.name}. I wanted to check in on ${topic} and see how you are getting on with your decision.`,
    };
    return templates[lead.stage] || `Hello ${first}, this is ${who} from ${site.name}. Thank you for considering us.`;
  };

  const renderLead = (res, lead, me, errors = [], status = 200, extra = {}) => res.status(status).render('admin/lead', {
    title: lead.name, lead, errors, agents: agents(), STAGES, LOST_REASONS, FOLLOW_UP_DAYS, staleDays,
    notes: db.prepare('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC, id DESC').all(lead.id),
    wa: lead.phone ? res.locals.waLink(lead.phone, waText(lead, me)) : '',
    duplicate: false, ...extra,
  });

  admin.get('/leads/:id', (req, res, next) => {
    const lead = getLead(req.params.id);
    if (!lead) return next();
    renderLead(res, lead, req.me, [], 200, { duplicate: req.query.duplicate === '1' });
  });

  admin.post('/leads/:id', (req, res, next) => {
    const lead = getLead(req.params.id);
    if (!lead) return next();
    const stage = oneOf(req.body.stage, STAGES, lead.stage);
    const lostReason = stage === 'lost' ? oneOf(req.body.lost_reason, LOST_REASONS, '') : '';
    const errors = [];
    if (stage === 'lost' && !lostReason) errors.push('Choose why this lead was lost.');
    if (errors.length) return renderLead(res, lead, req.me, errors, 400);

    const agentChoice = String(req.body.agent_id ?? '');
    const agent = agentChoice === '' ? null
      : db.prepare("SELECT id FROM users WHERE id = ? AND role = 'agent' AND (active = 1 OR id = ?)").get(intOrNull(agentChoice), lead.agent_id);
    const agentId = agentChoice === '' ? null : (agent ? agent.id : lead.agent_id);

    const open = OPEN_STAGES.includes(stage);
    let followUp = null;
    if (open) {
      if (isDate(req.body.next_follow_up)) followUp = req.body.next_follow_up;
      else if (stage !== lead.stage || !lead.next_follow_up) followUp = daysFromNow(db, FOLLOW_UP_DAYS[stage]);
      else followUp = lead.next_follow_up;
    }
    const note = clean(req.body.note, 2000);
    const closedNow = !open && lead.stage !== stage;
    const dealValue = stage === 'won' ? intOrNull(req.body.deal_value) : null;

    db.prepare(`UPDATE leads SET stage = ?, agent_id = ?, next_follow_up = ?, deal_value = ?, lost_reason = ?,
      closed_at = CASE WHEN ? THEN datetime('now') WHEN ? THEN closed_at ELSE NULL END,
      first_response_at = CASE WHEN first_response_at IS NULL AND (? OR ?) THEN datetime('now') ELSE first_response_at END,
      updated_at = datetime('now') WHERE id = ?`)
      .run(stage, agentId, followUp, dealValue, lostReason, closedNow ? 1 : 0, open ? 0 : 1, stage !== 'new' ? 1 : 0, note ? 1 : 0, lead.id);

    const changes = [];
    if (stage !== lead.stage) changes.push(`Stage: ${SHORT_STAGE[lead.stage]} → ${SHORT_STAGE[stage]}${lostReason ? ` (${LABELS[lostReason].toLowerCase()})` : ''}.`);
    if (agentId !== lead.agent_id) {
      const to = agentId ? db.prepare('SELECT name FROM users WHERE id = ?').get(agentId).name : 'nobody';
      changes.push(`Reassigned to ${to}.`);
    }
    const text = [...changes, note].filter(Boolean).join(' ');
    if (text) addNote(db, lead.id, text, req.me.name);
    res.redirect(`/admin/leads/${lead.id}`);
  });

  admin.post('/leads/:id/assign', (req, res, next) => {
    const lead = getLead(req.params.id);
    if (!lead) return next();
    const agent = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'agent' AND active = 1").get(intOrNull(req.body.agent_id));
    if (agent) {
      db.prepare("UPDATE leads SET agent_id = ?, updated_at = datetime('now') WHERE id = ?").run(agent.id, lead.id);
      addNote(db, lead.id, `Assigned to ${agent.name}.`, req.me.name);
    }
    res.redirect(req.body.back === 'lead' ? `/admin/leads/${lead.id}` : '/admin');
  });

  // Team (manager only)
  const teamPage = (res, status = 200, errors = []) => res.status(status).render('admin/team', {
    title: 'Team', errors, autoAssign: getSetting(db, 'auto_assign', 'on') === 'on',
    team: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM leads WHERE agent_id = u.id AND stage IN (${OPEN_SQL})) AS open_leads
      FROM users u ORDER BY u.role, u.active DESC, u.name`).all(),
  });

  admin.get('/team', managerOnly, (req, res) => teamPage(res));

  admin.post('/team', managerOnly, (req, res) => {
    const u = { name: clean(req.body.name, 60), username: clean(req.body.username, 30).toLowerCase(), password: String(req.body.password || '') };
    const errors = [];
    if (u.name.length < 2) errors.push('Enter the agent’s name.');
    if (!/^[a-z0-9._-]{3,30}$/.test(u.username)) errors.push('The username must be 3 to 30 letters, digits, dots or dashes.');
    if (u.password.length < 8) errors.push('The password must be at least 8 characters.');
    if (!errors.length && db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) errors.push('That username is already taken.');
    if (errors.length) return teamPage(res, 400, errors);
    db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, 'agent', ?)").run(u.username, u.name, hashPassword(u.password));
    res.redirect('/admin/team');
  });

  admin.post('/team/:id/toggle', managerOnly, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(intOrNull(req.params.id));
    if (user) {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(user.active ? 0 : 1, user.id);
      if (user.active) {
        // Hand the leaving agent's open leads back to the unassigned queue so none are forgotten.
        const open = db.prepare(`SELECT id FROM leads WHERE agent_id = ? AND stage IN (${OPEN_SQL})`).all(user.id);
        for (const { id } of open) {
          db.prepare("UPDATE leads SET agent_id = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
          addNote(db, id, `Returned to the unassigned queue: ${user.name} was deactivated.`, req.me.name);
        }
      }
    }
    res.redirect('/admin/team');
  });

  admin.post('/team/auto-assign', managerOnly, (req, res) => {
    setSetting(db, 'auto_assign', req.body.auto_assign === 'on' ? 'on' : 'off');
    res.redirect('/admin/team');
  });

  // Reports (manager only)
  admin.get('/reports', managerOnly, (req, res) => {
    const rate = (won, lost) => (won + lost ? Math.round((100 * won) / (won + lost)) : null);
    const bySource = db.prepare(`SELECT source, COUNT(*) AS total, SUM(stage = 'won') AS won, SUM(stage = 'lost') AS lost,
        SUM(stage IN (${OPEN_SQL})) AS open, COALESCE(SUM(deal_value), 0) AS value,
        ROUND(AVG((julianday(first_response_at) - julianday(created_at)) * 24), 1) AS reply_hours
      FROM leads GROUP BY source ORDER BY total DESC`).all().map((r) => ({ ...r, rate: rate(r.won, r.lost) }));
    const byAgent = db.prepare(`SELECT COALESCE(u.name, 'Unassigned') AS agent, COUNT(*) AS total, SUM(l.stage = 'won') AS won, SUM(l.stage = 'lost') AS lost,
        SUM(l.stage IN (${OPEN_SQL})) AS open, COALESCE(SUM(l.deal_value), 0) AS value,
        SUM(l.stage IN (${OPEN_SQL}) AND l.next_follow_up < date('now')) AS overdue,
        ROUND(AVG((julianday(l.first_response_at) - julianday(l.created_at)) * 24), 1) AS reply_hours
      FROM leads l LEFT JOIN users u ON u.id = l.agent_id GROUP BY l.agent_id ORDER BY total DESC`).all().map((r) => ({ ...r, rate: rate(r.won, r.lost) }));
    const byInterest = db.prepare(`SELECT interest, COUNT(*) AS total, SUM(stage = 'won') AS won, SUM(stage = 'lost') AS lost FROM leads GROUP BY interest ORDER BY total DESC`).all()
      .map((r) => ({ ...r, rate: rate(r.won, r.lost) }));
    const lost = db.prepare("SELECT lost_reason, COUNT(*) AS n FROM leads WHERE stage = 'lost' GROUP BY lost_reason ORDER BY n DESC").all();
    const months = db.prepare("SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS n FROM leads GROUP BY month ORDER BY month DESC LIMIT 6").all().reverse();
    const stages = Object.fromEntries(db.prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage').all().map((r) => [r.stage, r.n]));
    const totals = db.prepare(`SELECT COUNT(*) AS total, SUM(stage = 'won') AS won, SUM(stage = 'lost') AS lost, COALESCE(SUM(deal_value), 0) AS value,
        ROUND(AVG(CASE WHEN stage = 'won' THEN julianday(closed_at) - julianday(created_at) END), 1) AS days_to_win,
        ROUND(AVG((julianday(first_response_at) - julianday(created_at)) * 24), 1) AS reply_hours,
        SUM(repeat_count) AS repeats FROM leads`).get();
    res.render('admin/reports', { title: 'Reports', bySource, byAgent, byInterest, lost, months, stages, totals: { ...totals, rate: rate(totals.won, totals.lost) }, STAGES });
  });

  admin.get('/leads.csv', managerOnly, (req, res) => {
    const rows = db.prepare(`${LEAD_SELECT} ORDER BY l.id`).all();
    const header = ['ID', 'Created', 'Name', 'Phone', 'Email', 'Interest', 'Budget', 'Asked about', 'Source', 'Stage', 'Agent', 'Next follow-up', 'Deal value', 'Lost reason', 'Repeat enquiries'];
    const lines = rows.map((l) => [l.id, l.created_at, l.name, l.phone, l.email, LABELS[l.interest], l.budget, l.property_ref, LABELS[l.source], LABELS[l.stage],
      l.agent_name || '', l.next_follow_up || '', l.deal_value ?? '', l.lost_reason ? LABELS[l.lost_reason] : '', l.repeat_count].map(csvCell).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
    res.send(`﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`);
  });

  app.use('/admin', admin);

  app.use((req, res) => {
    res.status(404).render('message', { title: 'Page not found', body: 'The page you are looking for does not exist or has been removed.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', body: 'Please try again in a moment, or call us directly.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Listening on http://localhost:${port}`);
    if (!process.env.ADMIN_PASSWORD) console.log('Demo logins: admin / admin123 (manager), kofi / agent123 (agent). Set ADMIN_PASSWORD and SEED_DEMO=off before going live.');
  });
}

module.exports = { createApp };
