// POST /api/auth/logout -- clears the session cookie. Doesn't revoke the
// Google grant itself (that's done at myaccount.google.com/permissions if
// ever needed) -- this just signs this browser out of the app.
const { clearSessionCookie } = require('../../lib/session');

module.exports = async function handler(req, res) {
  clearSessionCookie(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true }));
};
