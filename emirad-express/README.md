# Emirad Express – courier booking, tracking and dispatch (demo)

A working demonstration prepared by Radiant InnovaTech for a pitch to Emirad Express.
The only public trace I found of the business is a Facebook page where customers book by phone or WhatsApp, so this demo assumes bookings are taken that way today. Every parcel, customer, rider and price in it is sample data.

## The problem it addresses

When bookings arrive by phone and WhatsApp, three things go wrong: customers keep calling to ask where their parcel is, the office loses track of which rider has what, and cash collected on delivery goes missing or is argued over later.

## What it does

**For customers (no account needed)**
- **Tracking page.** A tracking number such as `EE-K7M2-9PQX` shows where the parcel is and its history. It shows areas and progress only: never phone numbers, street addresses or internal notes.
- **Price and booking.** Get a price from the rate card, then book online. The price is always worked out on the server.

**Dispatcher**
- **Dashboard and board** of what is waiting for a rider, on the road, late, failed, or due today.
- **Book for a caller** in a minute, optionally choosing the rider straight away, then send the sender and receiver a **WhatsApp message with the tracking link** in one tap.
- **Rider assignment** and a full history of every step.
- **Cash from riders:** delivery fees and cash on delivery that riders collected, what each should hand in, any shortfall, and a button to mark it received.
- **Reports:** bookings per day, on-time rate, revenue by service and customer, why deliveries fail, rider performance.

**Riders (phone-friendly)** see only their own jobs, with call and WhatsApp buttons, and tap through picked up, out for delivery, delivered (who received it and cash collected) or failed (with a reason). They can see the cash they are holding.

**Business accounts** (shops that send often) have their own login: book one parcel or paste up to 50 at once, see only their own parcels, and get a monthly statement of delivery fees, cash collected for them and the net.

**Rules the system enforces:** a parcel can only move through valid steps (for example it cannot be delivered before it is out for delivery), a rider must be assigned first, a delivery needs the name of who received it, and a failure needs a reason.

## Run it

Requires Node.js 22 or newer.

```
npm install
npm start          # http://localhost:3000
npm test
```

Demo logins (sample data on a local copy only, never on a hosted site): `admin` / `admin123` (dispatcher); `kofi`, `esi`, `musah` (riders) and `shopnest`, `glow` (business accounts), all with password `demo-pass-1`.
The home page lists demo tracking numbers to try.

## Settings (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `NODE_ENV=production` | Secure cookies; refuses to start without `SESSION_SECRET` and `ADMIN_PASSWORD`; starts empty |
| `SESSION_SECRET` | Long random string used to sign sessions |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Dispatcher login created when the database is first set up |
| `SEED_DEMO` | `on` or `off`. Sample data is created by default outside production and never in production unless set to `on` |
| `DEMO_PASSWORD` | Password for the demo riders and business accounts |
| `LOGIN_FAILURES` | Failed sign-ins allowed per address in ten minutes (default 8). Successful sign-ins are never limited |
| `SITE_NAME`, `SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL` | Contact details shown on the public pages |
| `DB_PATH` | Location of the SQLite file (default `data/app.db`) |
| `DEMO_BANNER=off` | Hides the "demonstration" banner |

## Assumptions to confirm with Emirad Express

- **How they work today.** I could only see a Facebook page. Whether they already use courier software, what areas they serve, and how riders report back all need asking.
- **The rate card is invented** (services, area charges, weight bands, the 20 kg online limit, the 3pm same-day cut-off). Replace it with theirs.
- **Cash flow:** riders collect the sender's fee at pickup, or the receiver's fee and any cash on delivery at delivery, and hand it in to the office. Business accounts are invoiced monthly and receive the cash collected for them.
- Times and dates are Ghana time (GMT, no daylight saving).

## Before this could go live

- Start empty, set real secrets, host behind HTTPS with a database that persists, monitor `/healthz`, and take daily backups.
- Not yet built: automatic WhatsApp or SMS messages (the buttons open WhatsApp for a person to send), proof-of-delivery photos or signatures, rider GPS location, an editable rate card, paying COD amounts out to businesses, invoices as documents, and routing multiple stops.
- Tracking numbers are 8 random characters and lookups are rate limited, but anyone with a number can see its progress, so they should be shared only with the sender and receiver.

Screenshots are in `docs/screenshots/`.
