// GET /api/auth/login -- redirects the browser to Google's consent screen.
// This is what every page's auth-gate sends the user to when there's no
// valid session (see auth-gate.js).
const crypto = require('crypto');
const { getAuthUrl } = require('../../lib/googleDrive');

module.exports = async function handler(req, res) {
  try {
    // A random, single-use state value guards against CSRF on the OAuth
    // callback (a forged callback request without a matching state cookie
    // is rejected) -- stored in its own short-lived plain cookie rather
    // than the encrypted session cookie, since it's not sensitive on its
    // own and needs to exist before any session does.
    const state = crypto.randomBytes(16).toString('hex');
    const cookies = [`aa_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`];

    // Where to send the browser back to after a successful sign-in --
    // passed through from login.html's own ?next= (see auth-gate's
    // redirect in nav.js). Only ever a same-site path (never a full URL),
    // so this can't be abused as an open redirect.
    const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
    const next = url.searchParams.get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      cookies.push(`aa_oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    }
    res.setHeader('Set-Cookie', cookies);

    const authUrl = getAuthUrl(state);
    res.writeHead(302, { Location: authUrl });
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Could not start Google sign-in: ' + err.message);
  }
};
