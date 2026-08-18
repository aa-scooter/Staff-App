// POST /api/bikes/write  -- body: { action, ...payload }
//
// Single-round-trip write endpoint for bikes.html, mirroring
// api/accounts/write.js almost verbatim (see that file's own comment for
// the full "why" -- moving business logic server-side so the browser
// makes ONE request instead of many sequential /api/data/... round trips).
// Same withDrive guard, same ConflictError -> 409 mapping, same
// setSessionCookie-on-change pattern every other /api/* route here uses.
//
// STATUS (2026-08-17): ALL 7 of bikes.html's actions are now implemented
// in lib/bikesWrites.js (swapBike, markReturned, earlyReturnBike,
// returnDeposit, updateReturnPickup, extendBike, closeBikeForExtend,
// customerIntake -- the long-extension pair is 2 actions, matching
// bikes.html's own frontend) -- see that file's header comment and
// PROGRESS.md for the full traced action inventory and rollout plan.
// bikes.html's own
// frontend does NOT call this endpoint yet -- it is net-new and
// unreferenced, so its mere existence changes nothing about how
// bikes.html behaves today.
//
// ROUTING NOTE, added during the add-bikes.html port (see
// lib/addBikesWrites.js's own header comment for the full reasoning): this
// endpoint ALSO serves add-bikes.html's 4 write actions (addBike, editBike,
// sellBike, unsellBike), routed to a completely separate module
// (lib/addBikesWrites.js) below, purely because Vercel's Hobby-plan
// 12-serverless-function cap left no room for a dedicated
// api/add-bikes/write.js. The two dispatch paths never mix -- bikes.html's
// own actions keep going through bikesWriteDispatch exactly as before,
// untouched by this change.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ConflictError } = require('../../lib/googleDrive');
const { setSessionCookie } = require('../../lib/session');
const { createBikesWrites, createSheetIO } = require('../../lib/bikesWrites');
const { createAddBikesWrites } = require('../../lib/addBikesWrites');

const ADD_BIKES_ACTIONS = new Set(['addBike', 'editBike', 'sellBike', 'unsellBike']);

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
    const isAddBikesAction = ADD_BIKES_ACTIONS.has(action);
    const writes = isAddBikesAction ? createAddBikesWrites(sheetIO) : createBikesWrites(sheetIO, { drive, folderId: effectiveFolderId, session });

    let result;
    try {
      result = isAddBikesAction ? await writes.addBikesWriteDispatch(body) : await writes.bikesWriteDispatch(body);
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
