# Floorspace Realty – property management with landlord and tenant portals (demo)

A working demonstration prepared by Radiant InnovaTech for a pitch to Floorspace Realty.
Their public site (WordPress) already advertises property management and rent collection. This is the back office and portals behind that service. It is **not** a replacement for their website. Every landlord, tenant, property and figure in it is sample data.

## The problem it addresses

Managing other people's properties means answering the same questions all month: who has paid, who is late, what did we spend on repairs, what do we owe each landlord, and when was this flat last inspected. This keeps all of that in one place and lets landlords and tenants look things up themselves.

## What it does

**Back office (manager)**
- **Rent ledger per tenancy.** Rent is charged monthly; payments are applied to the oldest unpaid month first. It shows what is overdue, for how long, and any credit. Different currencies (GH₵ and US$) are never mixed.
- **Rent reminders.** Overdue and soon-due tenants are listed, each with a WhatsApp button that opens a ready-written message, and a log of when each tenant was last reminded.
- **Properties, units and tenancies.** Landlord records, units, deposits, due days, lease end dates, rent changes, moving out. A unit can only have one current tenant.
- **Maintenance.** Repair requests with priority, status, contractor, cost and history. Costs can be charged to the landlord.
- **Inspections.** Room-by-room condition records (move-in, routine, move-out). Occupied units not inspected for 180 days are flagged.
- **Owner statements.** Monthly: rent received, the agency's management fee (a percentage set per property), repairs charged to the landlord, and the net amount payable. Printable as PDF from the browser.
- **Vacancies and viewings.** Vacant units are advertised on a public page; visitors request a viewing, and the manager confirms it.
- **People.** Create landlord and tenant logins; deactivate when needed. Rent roll CSV export.

**Landlord portal:** only their own properties: rent status per unit, repairs and costs, inspection reports, monthly statements.
**Tenant portal:** only their own tenancy: rent statement, payments received, next due date, and a form to report a problem and follow its progress.

## Run it

Requires Node.js 22.13 or newer.

```
npm install
npm start          # http://localhost:3000
npm test
```

Demo logins (sample data on a local copy only, never use these on a hosted site):
`admin` / `admin123` (manager); `kboateng`, `asarpong` (landlords), `ama`, `kojo`, `efua`, `yaw`, `nana`, `linda` (tenants), all with password `demo-pass-1`.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `NODE_ENV=production` | Secure cookies; refuses to start without `SESSION_SECRET` and `ADMIN_PASSWORD`; starts empty |
| `SESSION_SECRET` | Long random string used to sign sessions |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Manager login created when the database is first set up |
| `SEED_DEMO` | `on` or `off`. Sample data is created by default outside production and never in production unless set to `on` |
| `LOGIN_FAILURES` | Failed sign-ins allowed per address in ten minutes (default 8). Successful sign-ins are never limited |
| `SITE_NAME`, `SITE_PHONE`, `SITE_EMAIL` | Contact details shown on the public pages |
| `DB_PATH` | Location of the SQLite file (default `data/app.db`) |
| `DEMO_BANNER=off` | Hides the "demonstration" banner |

## Assumptions to confirm with Floorspace

- **Whether they already use property-management software.** I cannot see their internal tools; the plan says to ask before proposing a replacement.
- Rent is charged monthly, in full from the month a tenancy starts, so tenancies should start on the 1st unless a part-month is intended. Rent is due on a day between 1 and 28.
- The management fee is a percentage of rent actually received, set per property. Deposits are recorded but not tracked as a separate ledger.
- Statements show GH₵ and US$ separately with no conversion. A repair costing GH₵ on a dollar-rent property gives a negative net in cedis for that month, shown as costs owed by the owner. Balances are not carried into later months automatically.
- The 180-day inspection interval, and the eight inspection areas, are defaults.

## Before this could go live

- Leave `SEED_DEMO` unset, set real secrets, host behind HTTPS, monitor `/healthz`, and schedule a daily copy of the database file.
- Not yet built: automatic WhatsApp or SMS sending (the buttons open WhatsApp for a person to send), online rent payment (mobile money or card), password reset by email, photo uploads for repairs and inspections, deposit tracking, lease renewal documents, and a link between the vacancies page and their WordPress site.
- Because it holds other people's money records and contact details, it should be reviewed for Ghana's Data Protection Act requirements before real data goes in.

Screenshots are in `docs/screenshots/`.
