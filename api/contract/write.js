// POST /api/contract/write  -- body: { action, ...payload }
//
// Single-round-trip write endpoint for contract.html, mirroring
// api/bikes/write.js almost verbatim (see that file's own comment, and
// api/accounts/write.js's original comment, for the full "why"). Same
// withDrive guard, same ConflictError -> 409 mapping, same
// setSessionCookie-on-change pattern every other /api/* route here uses.
//
// STATUS (2026-08-17): all 4 in-scope contract.html actions are
// implemented in lib/contractWrites.js (addContract, editContract,
// cancelContract, customerIntake) -- see that file's header comment and
// PROGRESS.md for the full traced action inventory, including the 6
// document-generation actions (regenerateContract, findContractDocument,
// generateReceipt, getFilesForShare, findChecklistDocument,
// generateChecklist) deliberately left OUT of scope. contract.html's own
// frontend does NOT call this endpoint yet -- it is net-new and
// unreferenced, so its mere existence changes nothing about how
// contract.html behaves today.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ConflictError } = require('../../lib/googleDrive');
const { setSessionCookie } = require('../../lib/session');
const { createContractWrites, createSheetIO } = require('../../lib/contractWrites');

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
    const writes = createContractWrites(sheetIO);

    let result;
    try {
      result = await writes.contractWriteDispatch(body);
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
