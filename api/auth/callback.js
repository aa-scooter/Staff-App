// GET /api/auth/callback -- Google redirects here after the user approves
// (or denies) access, with ?code=...&state=... (or ?error=... on denial).
const { exchangeCodeForTokens, driveClientFromSession, ensureAppFolder } = require('../../lib/googleDrive');
const { setSessionCookie } = require('../../lib/session');

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
