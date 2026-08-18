// POST /api/accounts/write  -- body: { action, ...payload }
//
// Single-round-trip replacement for accounts.html's old client-side write
// dispatch (see lib/accountsWrites.js's file-level comment for the full
// "why"). The browser used to run ~9 sequential fetch('/api/data/...')
// calls per add/edit/delete -- each one a full browser<->Vercel<->Drive
// round trip -- because the business logic that decided WHAT to write
// lived in the browser itself. This route moves that decision-making here:
// the browser now sends one POST describing the action, this handler runs
// the exact same ported logic (lib/accountsWrites.js) against Drive
// directly, and sends back the exact same response shape
// accountsWriteDispatch used to resolve to client-side -- so accounts.html's
// UI code (rendering, the cash-disambiguation modal, warning display) needs
// no changes at all, only its dispatch function's OWN implementation does
// (see accounts.html's accountsWriteDispatch).
//
// Same withDrive guard, same ConflictError -> 409 mapping, same
// setSessionCookie-on-change pattern every other /api/* route here already
// uses (see api/data/[sheet].js) -- this route is deliberately NOT a new
// pattern, just a new single ENDPOINT that happens to do more work per call
// than a plain read/write-the-whole-sheet route does.
//
// ROUTING NOTE, added during the deposits.html port (see
// lib/depositsWrites.js's own header comment for the full reasoning):
// this endpoint ALSO serves deposits.html's 5 write actions (addDeposit,
// editDeposit, deleteDeposit, deductDeposit, deductCashDeposit), routed to
// a completely separate module (lib/depositsWrites.js) below, purely
// because Vercel's Hobby-plan 12-serverless-function cap left no room for
// a dedicated api/deposits/write.js. The two dispatch paths never mix --
// accounts.html's own actions keep going through accountsWriteDispatch
// exactly as before, untouched by this change.
//
// ROUTING NOTE, added during the customers.html port (2026-08-17, overnight
// session -- see lib/customersWrites.js's own header comment): this
// endpoint ALSO now serves customers.html's one write action
// (customerIntake), routed to yet another separate module
// (lib/customersWrites.js) below -- same 12-function-cap reasoning as
// deposits.html above, no natural home of its own to spare. All three
// dispatch paths (accounts.html's own, deposits.html's, customers.html's)
// stay fully independent modules; only the physical routing is shared.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ConflictError } = require('../../lib/googleDrive');
const { setSessionCookie } = require('../../lib/session');
const { createAccountsWrites, createSheetIO } = require('../../lib/accountsWrites');
const { createDepositsWrites } = require('../../lib/depositsWrites');
const { createCustomersWrites } = require('../../lib/customersWrites');

const DEPOSITS_ACTIONS = new Set(['addDeposit', 'editDeposit', 'deleteDeposit', 'deductDeposit', 'deductCashDeposit']);
const CUSTOMERS_ACTIONS = new Set(['customerIntake']);

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw.length ? JSON.parse(raw) : {}); }
      catch (err) { reject(new Error('Invalid JSON body: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = withDrive(async function handler(req, res, { drive, folderId, session }) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const action = body && body.action;
    if (!action || typeof action !== 'string') {
      sendJson(res, 400, { success: false, error: 'Request body must include an "action".' });
      return;
    }

    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const sheetIO = createSheetIO(drive, effectiveFolderId, session);
    const isDepositsAction = DEPOSITS_ACTIONS.has(action);
    const isCustomersAction = !isDepositsAction && CUSTOMERS_ACTIONS.has(action);
    const writes = isDepositsAction
      ? createDepositsWrites(sheetIO)
      : isCustomersAction
        ? createCustomersWrites(sheetIO, { drive, folderId: effectiveFolderId, session })
        : createAccountsWrites(sheetIO);

    let result;
    try {
      result = isDepositsAction
        ? await writes.depositsWriteDispatch(body)
        : isCustomersAction
          ? await writes.customersWriteDispatch(body)
          : await writes.accountsWriteDispatch(body);
    } catch (err) {
      if (err instanceof ConflictError || err.isConflict) {
        if (session && !res.headersSent) setSessionCookie(res, session);
        sendJson(res, 409, { success: false, error: err.message, isConflict: true });
        return;
      }
      throw err;
    }

    if (session && !res.headersSent) setSessionCookie(res, session);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
