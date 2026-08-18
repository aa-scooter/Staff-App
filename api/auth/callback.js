// GET /api/auth/callback -- Google redirects here after the user approves
// (or denies) access, with ?code=...&state=... (or ?error=... on denial).
//
// Handles TWO independent OAuth flows through this one file (see
// api/auth/login.js's header comment for why they share a route): the
// staff Drive login (existing behavior, unchanged below) and, since
// 18/08/2026, calendar.html's separate "Connect Calendar" flow -- told
// apart via the aa_oauth_flow cookie login.js sets right before redirecting
// to Google. The calendar flow needs an ALREADY-LOGGED-IN staff session
// (calendar.html itself is behind the normal staff auth-gate) because it
// stores its tokens via that staff session's own Drive access -- see
// lib/googleCalendarAuth.js's header comment for the full "why".
const { exchangeCodeForTokens, driveClientFromSession, ensureAppFolder } = require('../../lib/googleDrive');
const { exchangeCalendarCodeForTokens, fetchConnectedEmail, saveCalendarAuth } = require('../../lib/googleCalendarAuth');
const { getSession, setSessionCookie } = require('../../lib/session');

function parseCookies(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// ---- Calendar connect flow -- exchanges the code against the Calendar
// OAuth client, looks up the connected account's own email, and stores the
// result in calendar_auth.json via the CURRENT staff session's Drive access
// (not the newly-connected account's own -- see lib/googleCalendarAuth.js's
// header comment). Requires an existing staff session; calendar.html is
// already behind the normal auth-gate, so in practice this only ever runs
// for someone already logged in, but this is checked explicitly rather than
// assumed. ----
async function handleCalendarCallback(req, res, code, cookies) {
  function fail(message) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p>Calendar connect failed: ${message}</p><p><a href="/calendar.html">Back to Calendar</a></p>`);
  }

  const staffSession = getSession(req);
  if (!staffSession || !staffSession.refresh_token) {
    return fail('You need to be signed in to the app before connecting a calendar. Please sign in first, then try connecting again.');
  }

  try {
    const tokens = await exchangeCalendarCodeForTokens(code);
    if (!tokens.refresh_token) {
      return fail('Google did not return a refresh token. Try removing this app\'s access at myaccount.google.com/permissions (look for it under whichever account you just connected) and connecting again.');
    }

    let email = null;
    try { email = await fetchConnectedEmail(tokens); } catch (emailErr) { /* non-fatal -- status just won't show an email */ }

    const drive = driveClientFromSession(staffSession, (refreshed) => { Object.assign(staffSession, refreshed); });
    const folderId = staffSession.driveFolderId || await ensureAppFolder(drive);
    await saveCalendarAuth(drive, folderId, tokens, email, staffSession);
    setSessionCookie(res, staffSession); // in case driveFolderId or a rotated token needs persisting

    // Surface the refresh token ONCE, via a short-lived, non-HttpOnly cookie
    // (NOT the redirect URL -- a query string would linger in browser
    // history/server access logs, a credential shouldn't) -- purely so
    // calendar.html's own page-load JS can show it in a copyable box for
    // Anton to paste into Vercel's CALENDAR_AUTOMATION_REFRESH_TOKEN env var,
    // if he wants the headless daily sweep to work too (see
    // lib/googleCalendarAuth.js's header comment -- the interactive
    // real-time sync above works regardless, this is only for the cron
    // path). The page clears this cookie itself immediately after reading
    // it; Max-Age=120 here is just a backstop in case that JS never runs.
    const nextPath = (cookies['aa_oauth_next'] && cookies['aa_oauth_next'].startsWith('/') && !cookies['aa_oauth_next'].startsWith('//'))
      ? cookies['aa_oauth_next'] : '/calendar.html';
    const destUrl = new URL(nextPath, 'https://' + (req.headers.host || 'localhost'));
    destUrl.searchParams.set('calConnected', '1');
    if (email) destUrl.searchParams.set('calEmail', email);
    res.setHeader('Set-Cookie', [
      res.getHeader('Set-Cookie'),
      'aa_oauth_flow=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      'aa_oauth_next=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      `aa_cal_automation_token=${encodeURIComponent(tokens.refresh_token)}; Path=/; Secure; SameSite=Lax; Max-Age=120`
    ].flat());
    res.writeHead(302, { Location: destUrl.pathname + destUrl.search });
    res.end();
  } catch (err) {
    fail(err.message || 'unknown error');
  }
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  function fail(message) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<p>Sign-in failed: ${message}</p><p><a href="/login.html">Try again</a></p>`);
  }

  if (errorParam) {
    // e.g. the user clicked "Cancel" on Google's consent screen.
    return fail('Google reported: ' + errorParam);
  }
  if (!code) return fail('Missing authorization code.');

  const cookies = parseCookies(req);
  const expectedState = cookies['aa_oauth_state'];
  if (!expectedState || expectedState !== state) {
    return fail('State mismatch -- this login attempt may have expired or been tampered with. Please try again.');
  }
  // One-time use -- clear it regardless of outcome.
  res.setHeader('Set-Cookie', 'aa_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  const flow = cookies['aa_oauth_flow'] === 'calendar' ? 'calendar' : 'drive';
  if (flow === 'calendar') return handleCalendarCallback(req, res, code, cookies);

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Shouldn't happen given access_type=offline + prompt=consent (see
      // getAuthUrl's comment), but fail loudly rather than silently
      // producing a session that can't outlive its first access token.
      return fail('Google did not return a refresh token. Try removing this app\'s access at myaccount.google.com/permissions and signing in again.');
    }

    // Resolve (or create, on a genuine first run) the app's Drive folder
    // now, once, so every subsequent request can read the folder ID
    // straight out of the session cookie instead of re-searching Drive
    // every time.
    const session = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      driveFolderId: null
    };
    const drive = driveClientFromSession(session, (refreshed) => { Object.assign(session, refreshed); });
    session.driveFolderId = await ensureAppFolder(drive);

    setSessionCookie(res, session);

    // Send them back wherever the auth-gate originally caught them, if
    // anywhere -- see aa_oauth_next in login.js. Clear it either way, it's
    // one-time use.
    const nextPath = cookies['aa_oauth_next'];
    res.setHeader('Set-Cookie', [
      res.getHeader('Set-Cookie'),
      'aa_oauth_next=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    ].flat());
    const destination = (nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//')) ? nextPath : '/index.html';
    res.writeHead(302, { Location: destination });
    res.end();
  } catch (err) {
    fail(err.message || 'unknown error');
  }
};
