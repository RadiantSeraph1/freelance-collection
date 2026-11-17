# Deploying the demos on Vercel

There are five separate apps in this repository. Create **one Vercel project per app**, all from this repository, each with a different **Root Directory**.

| App | Root Directory |
|---|---|
| Romeoville Properties | `romeoville-properties` |
| CBC Properties | `cbc-properties` |
| Monamii Construction | `monamii-leads` |
| Floorspace Realty | `floorspace-pm` |
| Emirad Express | `emirad-express` |

For each project: **Framework Preset: Other**, leave the build command and output directory empty, and leave Node.js on the default or choose 22.x. Each app already contains `app.js` (the single entry point Vercel runs) and `.vercelignore`, so there is nothing else to configure except the environment variables below. Do not add an `api/` folder or a `vercel.json` with rewrites: that makes Vercel run a second copy of the app with its own separate in-memory data.

## How data is kept on Vercel

These apps store their data in SQLite, and Vercel has no persistent disk. Each app therefore saves its database file to a **private Vercel Blob store** and restores it when an instance starts (see `src/persist.js`).

- Create one Blob store per project and connect it to that project (Storage tab). Vercel then adds `BLOB_READ_WRITE_TOKEN` automatically. Without that variable the app falls back to an in-memory database that is re-seeded with sample data on every start, and the pages say changes are temporary.
- On the first start the store is filled with the seeded sample data. After any request that changes data, the file is uploaded before the response finishes.
- This is a snapshot, not a shared database. If Vercel runs two instances at once, each works from its own copy and the last upload wins. That is fine for a demonstration where a few people click around. It is **not** suitable for real customer data or for several people editing at the same moment. For that, move the data layer to a hosted database, or use a host with a persistent disk.
- To reset a demo to its sample data, delete the app's `app.db` file from its Blob store (Storage tab); the next request recreates it.
- Blob data is billed by Vercel under your plan. A demo database is well under 1 MB.

## Environment variables

Set these under Project Settings, then Environment Variables. Vercel sets `NODE_ENV=production` itself, and in production the apps refuse to start without the first two.

| Variable | Apps | Value |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | all | Added for you when you connect a Blob store to the project. Turns on persistence. |
| `SESSION_SECRET` | all | A long random string, for example the output of `openssl rand -hex 32`. Must stay the same across deployments or everyone is signed out. |
| `ADMIN_PASSWORD` | all | The password for the `admin` account. Choose your own. |
| `SEED_DEMO` | Monamii, Floorspace, Emirad Express | `on`, to load the sample data and demo accounts. Without it they start empty. |
| `AGENT_DEMO_PASSWORD` | Monamii | Password for the demo agents `kofi`, `abena`, `yaw`. Choose your own. |
| `DEMO_PASSWORD` | Floorspace, Emirad Express | Password for the demo landlords and tenants (Floorspace), or the demo riders and business accounts (Emirad Express). Choose your own. |
| `LEAD_API_KEY` | Monamii (optional) | Lets you demonstrate the enquiry API. Without it the API stays off. |
| `SITE_NAME`, `SITE_PHONE`, `SITE_WHATSAPP`, `SITE_EMAIL` | all (optional) | Contact details shown on the public pages. They default to placeholders. |

Do not use the example passwords from the READMEs on a public URL. Anyone who finds the address can try them.

## Logins after deploying

- **Romeoville, CBC:** `admin` with your `ADMIN_PASSWORD`.
- **Monamii:** `admin` with `ADMIN_PASSWORD` (manager); `kofi`, `abena`, `yaw` with `AGENT_DEMO_PASSWORD` (agents).
- **Floorspace:** `admin` with `ADMIN_PASSWORD` (manager); `kboateng`, `asarpong` (landlords) and `ama`, `kojo`, `efua`, `yaw`, `nana`, `linda` (tenants) with `DEMO_PASSWORD`.
- **Emirad Express:** `admin` with `ADMIN_PASSWORD` (dispatcher); `kofi`, `esi`, `musah` (riders) and `shopnest`, `glow` (business accounts) with `DEMO_PASSWORD`.

## After each deployment

1. Open `/healthz`. It should return `{"status":"ok", ...}`.
2. Open the home page, then sign in and open the dashboard. If a page shows an error about a missing view, or the page has no styling, tell me: it means Vercel left some files out of the function bundle, which can only be confirmed on Vercel itself.
3. If the function fails at startup, check Runtime Logs. The most likely cause is a missing `SESSION_SECRET` or `ADMIN_PASSWORD`.

## What was and was not tested

I ran each app's `app.js` locally under production settings with an in-memory database, as Vercel would. Health check, static files, the temporary-changes banner, wrong and correct sign-in with secure cookies, and the signed-in dashboard all worked for all four apps, and the full automated test suites pass. I then confirmed on real Vercel deployments that the pages, styling and templates are served and that there is one copy of the app.

Other limits to know about: the sign-in and form rate limiters count per function instance, so they are weaker on Vercel than on a single server.
