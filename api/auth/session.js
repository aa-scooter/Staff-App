// GET /api/auth/session -- tells the client-side auth-gate (see
// auth-gate.js, loaded on every page) whether there's a currently valid
// session. The session cookie is httpOnly on purpose (so the tokens inside
// it are never reachable from page JS, even via an XSS bug) -- this is the
// one narrow read of it a page is allowed: just a yes/no, never the tokens
// themselves.
const { getSession } = require('../../lib/session');

module.exports = async function handler(req, res) {
  const session = getSession(req);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ loggedIn: !!(session && session.refresh_token) }));
};
