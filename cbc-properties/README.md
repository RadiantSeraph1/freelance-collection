# CBC Properties – land-sales CRM and documentation tracking (demo)

A working demonstration prepared by Radiant InnovaTech for a pitch to CBC Properties.
It is not the company's live website, and every estate, plot, customer and payment in it is sample data.

## What it does

**Public site**
- Estates with the number of plots available and a "from" price.
- Searchable plot catalogue: keyword, estate, availability, minimum size, maximum price.
- Plot pages showing price, dimensions, demarcation status and availability, with an enquiry form and a WhatsApp button.

**Staff area** (`/admin`)
- **Enquiries:** website enquiries arrive automatically; phone, WhatsApp and walk-in enquiries are logged by hand. Each has a stage, an owner, a follow-up date and notes.
- **Reservations and sales:** reserving a plot (directly or from an enquiry) takes it off the market. Payments are recorded against the agreed price; the plot becomes "sold" when fully paid and is released if the sale is cancelled.
- **Documentation milestones:** every sale gets a nine-step checklist, from reservation fee to registered documents handed over, with the date, a note and who ticked each step.
- **Demarcation:** each plot is marked not yet surveyed, surveyed, pillars set or handed over.
- **Dashboard:** new enquiries, follow-ups due, reservations past their hold date, money still to collect.
- **Reports:** plots and money by estate, where sales are waiting, money received by month, enquiry sources, and a CSV download of all sales.

## Assumptions to confirm with CBC

- The nine documentation steps (`MILESTONES` in `src/db.js`) are a reasonable default, not CBC's confirmed process.
- One currency throughout (GH₵ by default, `CURRENCY_SYMBOL` to change), whole amounts only.
- "Full payment received" on the checklist is ticked by staff; it is not ticked automatically when the balance reaches zero.

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
| `CURRENCY_SYMBOL` | Shown before amounts (default `GH₵`) |
| `DB_PATH` | Location of the SQLite file (default `data/app.db`) |
| `DEMO_BANNER=off` | Hides the "demonstration" banner |

## Before this could go live

- Replace the sample estates and plots with CBC's real records, and agree the documentation steps.
- Set the real phone, WhatsApp number, email and address.
- Host behind HTTPS, point an uptime monitor at `/healthz`, and schedule a daily copy of the database file.
- Renew or replace the expired `cbcghanaltd.com` domain; only its owner can do that.
- Not yet built: separate staff accounts and permissions, document uploads (scanned indentures, site plans), printable receipts, estate site-plan map, payment reminders to customers.

Screenshots are in `docs/screenshots/`.
