// ---- Shared guard for every /api/data/* and /api/write/* route: requires
// a valid session, builds an authenticated Drive client from it, and
// re-persists the session cookie if googleapis silently rotated the access
// token mid-request (see clientFromSession's onTokensRefreshed comment).
// Wrap a handler with withDrive(handler) and it receives
// (req, res, { drive, folderId, session }) instead of the raw (req, res). ----
const { getSession, setSessionCookie } = require('./session');
const { driveClientFromSession } = require('./googleDrive');

function withDrive(handler) {
  return async function wrapped(req, res) {
    const session = getSession(req);
    if (!session || !session.refresh_token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Not signed in.' }));
      return;
    }
    if (!session.driveFolderId) {
      // Shouldn't normally happen (callback.js resolves this at login
      // time) -- but don't hard-fail a whole request over it if it does;
      // the individual route can call ensureAppFolder itself as a fallback
      // if it really needs to.
    }

    // Re-set the cookie the MOMENT googleapis rotates the access token,
    // not after the handler finishes -- the handler is free to call
    // res.end() itself (most do, to send their JSON response), and a
    // Set-Cookie header can only be attached before headers go out. If a
    // refresh happens to race past that point anyway, it's harmless: the
    // refresh_token itself (the only thing that actually matters for
    // staying logged in) is untouched, so the next request just pays for
    // one extra refresh round trip instead of losing the session.
    const drive = driveClientFromSession(session, (refreshed) => {
      Object.assign(session, refreshed);
      if (!res.headersSent) setSessionCookie(res, session);
    });

    await handler(req, res, { drive, folderId: session.driveFolderId, session });
  };
}

module.exports = { withDrive };
