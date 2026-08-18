// GET /api/auth/login -- redirects the browser to Google's consent screen.
// This is what every page's auth-gate sends the user to when there's no
// valid session (see auth-gate.js).
//
// ?flow=calendar (added 18/08/2026) -- calendar.html's own "Connect
// Calendar" button hits this same endpoint with that query param, which
// swaps in the SEPARATE, Calendar-scoped OAuth client from
// lib/googleCalendarAuth.js instead of the staff Drive login's. Both flows
// share this one file (and api/auth/callback.js) rather than needing a
// second Vercel serverless function -- the app is already at the 12-function
// Hobby cap (see api/contracts/[...path].js's own comment on that). Told
// apart on the way back via the aa_oauth_flow cookie set below, since
// Google's own redirect back to /api/auth/callback carries no flow info of
// its own beyond the (single, shared) state param.
const crypto = require('crypto');
const { getAuthUrl } = require('../../lib/googleDrive');
const { getCalendarAuthUrl } = require('../../lib/googleCalendarAuth');

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
    const flow = url.searchParams.get('flow') === 'calendar' ? 'calendar' : 'drive';

    // A random, single-use state value guards against CSRF on the OAuth
    // callback (a forged callback request without a matching state cookie
    // is rejected) -- stored in its own short-lived plain cookie rather
    // than the encrypted session cookie, since it's not sensitive on its
    // own and needs to exist before any session does.
    const state = crypto.randomBytes(16).toString('hex');
    const cookies = [
      `aa_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      `aa_oauth_flow=${flow}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    ];

    // Where to send the browser back to after a successful sign-in --
    // passed through from login.html's own ?next= (see auth-gate's
    // redirect in nav.js), or calendar.html's own page path for the
    // calendar flow. Only ever a same-site path (never a full URL), so
    // this can't be abused as an open redirect.
    const next = url.searchParams.get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      cookies.push(`aa_oauth_next=${encodeURIComponent(next)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    }
    res.setHeader('Set-Cookie', cookies);

    const authUrl = flow === 'calendar' ? getCalendarAuthUrl(state) : getAuthUrl(state);
    res.writeHead(302, { Location: authUrl });
    res.end();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Could not start Google sign-in: ' + err.message);
  }
};
