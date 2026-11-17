// Keeps the demo's SQLite file in a private Vercel Blob so data survives between
// requests and cold starts on Vercel, which has no persistent disk.
//
// How it works: on a cold start the saved file is downloaded to /tmp and opened;
// after any request that changed the database, the file is uploaded again before
// the response is finished. If no Blob token is configured, the app falls back to
// an in-memory database that is re-seeded on every start.
//
// Limits: this is a snapshot, not a shared database. If Vercel runs several
// instances at once, each works from its own copy and the last upload wins. That is
// acceptable for a demonstration and unsuitable for real customer data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const readStream = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

// Downloads the saved database to `file`. Returns false when nothing is saved yet.
async function restoreFile(client, key, file) {
  const found = await client.get(key, { access: 'private', useCache: false });
  if (!found || !found.stream) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  fs.writeFileSync(file, await readStream(found.stream));
  return true;
}

// Uploads are queued one after another so an older snapshot never overwrites a newer one.
function makeSaver(client, db, key, file) {
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await client.put(key, fs.readFileSync(file), {
        access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/octet-stream',
      });
    }).catch((err) => { console.error('Could not save the database to Blob storage:', err.message); });
    return chain;
  };
}

const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

function buildHandler({ name, createApp, env = process.env, client, tmpDir = os.tmpdir() }) {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    process.env.DB_PATH = process.env.DB_PATH || ':memory:';
    return createApp({});
  }
  const blob = client || require('@vercel/blob');
  const key = `${name}/app.db`;
  const file = path.join(tmpDir, `${name}.db`);

  let booting = null;
  const boot = () => {
    if (!booting) {
      booting = (async () => {
        const existed = await restoreFile(blob, key, file);
        const app = createApp({ dbPath: file });
        const save = makeSaver(blob, app.locals.db, key, file);
        if (!existed) await save(); // first run: store the freshly seeded database
        return { app, save };
      })().catch((err) => { booting = null; throw err; }); // try again on the next request
    }
    return booting;
  };

  const handler = (req, res, next) => {
    boot().then(({ app, save }) => {
      if (READ_ONLY.has(req.method)) return app(req, res, next);
      const db = app.locals.db;
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const end = res.end;
      res.end = function patchedEnd(...args) {
        res.end = end;
        const changed = db.prepare('SELECT total_changes() AS n').get().n !== before;
        if (!changed) return end.apply(this, args);
        save().then(() => end.apply(this, args));
        return this;
      };
      return app(req, res, next);
    }).catch((err) => {
      console.error('Storage unavailable:', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('The demonstration storage is not available right now. Please try again in a moment.');
    });
  };
  handler.boot = boot; // for tests
  return handler;
}

module.exports = { buildHandler, restoreFile, makeSaver };
