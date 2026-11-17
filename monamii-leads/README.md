# Monamii Construction – lead management (demo)

A working demonstration prepared by Radiant InnovaTech for a pitch to Monamii Construction.
It is **not a website**: their site already works. This is the system behind it, which gathers every enquiry in one place and makes sure each one is answered and followed up. Every lead, agent and figure in it is sample data.

## The problem it addresses

Enquiries arrive through the website forms, WhatsApp, social media, phone calls and walk-ins. Without one shared list, leads get missed, two people chase the same customer, and nobody can say which channel actually produces customers.

## What it does

- **One inbox for every channel.** A shareable enquiry form (`/enquire?src=instagram`, `?src=facebook`, `?src=tiktok`…) tags each lead with where it came from. Staff log phone, WhatsApp and walk-in enquiries by hand.
- **Plugs into the existing website.** `POST /api/leads` with an `X-API-Key` header lets the current website forms, or a tool such as Zapier, send enquiries straight in.
- **No duplicates.** If the same person enquires again, by any channel and in any phone format (`024…`, `+233 24…`), the message is added to their open lead and the follow-up is brought forward to today.
- **Assignment.** New leads are shared automatically between active agents (fewest open leads first), or assigned by hand. Deactivating an agent returns their open leads to the unassigned queue.
- **Follow-ups that cannot be forgotten.** Moving a lead to a stage sets its next follow-up (contacted +2 days, viewing +1, negotiating +2). Overdue follow-ups and leads quiet for 7+ days appear on the dashboard.
- **Pipeline board** from new to negotiating, filterable by agent, plus a searchable list of all leads.
- **One-tap contact.** Call, email, and a WhatsApp button with a message written from the lead's details and the agent's name.
- **Reports for the manager:** which channels produce customers (leads, win rate, value won, response time), agent performance, enquiry types, why leads are lost, leads per month, and a CSV download.
- **Two roles.** Agents see their own day and all leads; the manager also sees reports and manages the team.

## Run it

Requires Node.js 22.13 or newer.

```
npm install
npm start          # http://localhost:3000
npm test
```

Demo logins (sample data on a local copy only, never use these on a hosted site): `admin` / `admin123` (manager) and `kofi`, `abena` or `yaw` / `agent123` (agents).
Try the API: `curl -X POST localhost:3000/api/leads -H 'x-api-key: demo-key' -H 'content-type: application/json' -d '{"name":"Test","phone":"0245550000","source":"website"}'`

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `NODE_ENV=production` | Secure cookies; refuses to start without `SESSION_SECRET` and `ADMIN_PASSWORD`; the API stays off until `LEAD_API_KEY` is set |
| `SESSION_SECRET` | Long random string used to sign staff sessions |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Manager login created when the database is first set up |
| `SEED_DEMO` | `on` or `off`. Sample leads and demo agents are created by default outside production and never in production unless set to `on` |
| `LEAD_API_KEY` | Secret that website forms or other tools send in the `X-API-Key` header |
| `STALE_DAYS` | Days without activity before an open lead is flagged as quiet (default 7) |
| `SITE_NAME`, `SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL` | Contact details shown on the enquiry page |
| `DB_PATH` | Location of the SQLite file (default `data/app.db`) |
| `DEMO_BANNER=off` | Hides the "demonstration" banner |

## Assumptions to confirm with Monamii

- The stages (new, contacted, viewing, negotiating, won, lost) and the follow-up gaps are sensible defaults, not their confirmed process.
- Enquiry types follow what their site offers: rent, sale, land, off-plan, property management, architecture, construction, consultation.
- Their existing site's forms would need a small change (a webhook or a plugin setting) to send enquiries to the API. I have not tested against their site.
- Deal values are entered by hand when a lead is won, in cedis only.

## Before this could go live

- Leave `SEED_DEMO` unset in production so it starts empty, set real secrets and a `LEAD_API_KEY`, host behind HTTPS, monitor `/healthz`, and schedule a daily copy of the database file.
- Not yet built: automatic WhatsApp Business API messaging (the button opens WhatsApp for a person to send), SMS or email alerts for new leads, password reset, links to their property listings.

Screenshots are in `docs/screenshots/`.
