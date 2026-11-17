// Minimal signed-cookie session: the cookie holds {user, csrf, exp} and an HMAC.
const crypto = require('node:crypto');

const COOKIE = 'fs_session';
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionMiddleware(secret, secure) {
  return (req, res, next) => {
    req.session = null;
    const raw = readCookie(req, COOKIE);
    if (raw) {
      const [payload, mac] = raw.split('.');
      const expected = sign(payload || '', secret);
      if (mac && mac.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
        try {
          const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
          if (data.exp > Date.now()) req.session = data;
        } catch { /* malformed cookie: treat as signed out */ }
      }
    }
    res.startSession = (user) => {
      const data = { user, csrf: crypto.randomBytes(16).toString('hex'), exp: Date.now() + MAX_AGE_MS };
      const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
      res.cookie(COOKIE, `${payload}.${sign(payload, secret)}`, {
        httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE_MS, encode: String,
      });
    };
    res.endSession = () => res.clearCookie(COOKIE);
    next();
  };
}

module.exports = { sessionMiddleware };
