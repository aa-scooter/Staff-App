// ---- Session handling for the Google-login-backed staff app. ----
//
// There's no separate session database -- state (Google access/refresh
// tokens, plus the app's Drive folder ID once it's been found/created) is
// carried in a single encrypted, httpOnly cookie. That's a deliberate
// choice for a 2-user internal tool: it avoids standing up any storage
// just to remember "who's logged in", on top of the Drive JSON files that
// are already the app's real database.
//
// Encryption: AES-256-GCM using SESSION_SECRET (a 64-hex-char / 32-byte key,
// set as a Vercel env var -- see project setup notes). GCM gives us both
// confidentiality (the refresh token never appears in the browser in
// plain text) and integrity (a tampered cookie fails to decrypt rather than
// silently deserializing into something unexpected).

const crypto = require('crypto');

const COOKIE_NAME = 'aa_session';
const ALGO = 'aes-256-gcm';

function getKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length !== 64) {
    throw new Error('SESSION_SECRET env var is missing or not a 64-char hex string (see project setup notes).');
  }
  return Buffer.from(secret, 'hex');
}

// ---- Encrypts a plain JS object into a single cookie-safe string:
// base64url(iv) + '.' + base64url(authTag) + '.' + base64url(ciphertext). ----
function encryptSession(payload) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map(b => b.toString('base64url')).join('.');
}

// ---- Reverse of encryptSession. Returns null (never throws) on anything
// malformed or tampered -- a bad cookie should look exactly like "not
// logged in", not crash the request. ----
function decryptSession(token) {
  try {
    const key = getKey();
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(authTagB64, 'base64url');
    const ciphertext = Buffer.from(ciphertextB64, 'base64url');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (err) {
    return null;
  }
}

// ---- Cookie helpers -- plain Node request/response objects (Vercel's
// Node.js serverless functions use the standard http.IncomingMessage /
// ServerResponse shape), so these don't depend on any framework. ----
function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const session = decryptSession(token);
  if (!session) return null;
  return session;
}

// maxAgeSeconds defaults to 180 days -- long-lived on purpose (this cookie
// only carries the Google refresh token + folder ID, not a raw password),
// but note Google itself will still force a re-login roughly every 7 days
// while the OAuth consent screen stays in "Testing" publishing status (see
// project discussion) -- this cookie's own lifetime isn't the binding
// constraint.
function setSessionCookie(res, payload, maxAgeSeconds) {
  const token = encryptSession(payload);
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds || 180 * 24 * 60 * 60}`
  ];
  appendSetCookie(res, attrs.join('; '));
}

function clearSessionCookie(res) {
  appendSetCookie(res, `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// Vercel's Node functions expose res.setHeader like a normal Node response.
// Preserves any Set-Cookie header already set on this response instead of
// clobbering it, in case something else on the same response ever needs to
// set an additional cookie.
function appendSetCookie(res, value) {
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : null;
  if (!existing) {
    res.setHeader('Set-Cookie', value);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', existing.concat(value));
  } else {
    res.setHeader('Set-Cookie', [existing, value]);
  }
}

module.exports = {
  COOKIE_NAME,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  encryptSession,
  decryptSession
};
