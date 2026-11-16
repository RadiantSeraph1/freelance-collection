# Romeoville Properties – property catalogue and enquiry tracking (demo)

A working demonstration prepared by Radiant InnovaTech for a pitch to Romeoville Properties.
It is not the company's live website, and every listing and enquiry in it is sample data.

## What it does

**Public site**
- Home page with featured properties and a quick search.
- Catalogue with filters: keyword, buy/rent, type, location, bedrooms, currency, price range, and sorting.
- Property pages with an enquiry form and a WhatsApp button that pre-fills the property reference.
- General contact form.

**Staff area** (`/admin`)
- Dashboard: new enquiries, follow-ups due, pipeline by stage, and enquiries and wins by source.
- Listings: add, edit, feature, mark as under offer or sold, delete.
- Enquiries: website enquiries arrive automatically; phone, WhatsApp, social and walk-in enquiries can be logged by hand.
- Each enquiry has a stage, an assigned person, a next follow-up date and a dated history of notes.

**Reliability**
- `/healthz` endpoint for an uptime monitor.
- One Node process and one SQLite file: little to break and easy to back up.

## Run it

Requires Node.js 22.13 or newer.

```
npm install
npm start          # http://localhost:3000
npm test
```

On first start it creates `data/app.db` with sample data and a staff login of `admin` / `admin123`.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `NODE_ENV=production` | Secure cookies; refuses to start without the two secrets below |
| `SESSION_SECRET` | Long random string used to sign staff sessions |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Staff login created when the database is first set up |
| `SITE_NAME`, `SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL`, `SITE_ADDRESS` | Contact details shown on the site |
| `DB_PATH` | Location of the SQLite file (default `data/app.db`) |
| `DEMO_BANNER=off` | Hides the "demonstration" banner |

## Before this could go live

- Replace the sample listings with real stock and photos (photos are currently added by link, not upload).
- Set the real phone, WhatsApp number, email and address.
- Host behind HTTPS, point an uptime monitor at `/healthz`, and schedule a daily copy of the database file.
- Diagnose the existing domain (DNS, SSL certificate, hosting) before switching it over.
- Not yet built: photo uploads, multiple photos per listing, separate staff accounts, email or SMS alerts for new enquiries.

Screenshots are in `docs/screenshots/`.
