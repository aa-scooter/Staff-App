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
const { ensureAppFolder, findNamedFolderAnywhere, APP_FOLDER_NAME, ConflictError } = require('../../lib/googleDrive');
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

// ---- GET .../api/contract/write?cron=dailySweep (added 18/08/2026) --
// Vercel Cron's daily hit for the calendar resync + contact-reminder sweep
// (see vercel.json's `crons` entry and lib/googleCalendarSync.js's
// dailySweep). Handled BEFORE withDrive below, deliberately -- Vercel Cron
// has no browser, so there's no staff session cookie for withDrive to check;
// this path authenticates itself instead by checking Vercel's own
// Authorization: Bearer <CRON_SECRET> header (set automatically on
// Vercel-triggered cron requests when a CRON_SECRET env var exists -- see
// Vercel's cron docs) against the CRON_SECRET env var. Any other GET falls
// through to withDrive's normal 401, unchanged. ----
async function handleDailySweepCron(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers && req.headers['authorization']) || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    sendJson(res, 401, { success: false, error: 'Unauthorized.' });
    return;
  }
  try {
    const { automationClientsFromEnv } = require('../../lib/googleCalendarAuth');
    const { dailySweep } = require('../../lib/googleCalendarSync');
    const automation = automationClientsFromEnv();
    if (!automation) {
      sendJson(res, 200, { success: true, skipped: true, reason: 'CALENDAR_AUTOMATION_REFRESH_TOKEN is not set yet -- see lib/googleCalendarAuth.js.' });
      return;
    }
    // NOT ensureAppFolder here -- the automation account doesn't OWN the
    // app's Drive folder, it only has it SHARED with it (see
    // lib/googleCalendarAuth.js's header comment), so it's never "in root"
    // for this account the way ensureAppFolder's query assumes. Same fix
    // findNamedFolderAnywhere already exists for (see
    // lib/googleDrive.js's ensureContractsRootFolder comment, 2026-08-17,
    // for the identical shared-folder gotcha). Never creates a folder here
    // -- if it's not found, that means the one-time sharing step (see
    // lib/googleCalendarAuth.js) hasn't been done yet, not "make a new one".
    const found = await findNamedFolderAnywhere(automation.drive, APP_FOLDER_NAME);
    if (!found) {
      sendJson(res, 200, {
        success: true, skipped: true,
        reason: `Could not find the "${APP_FOLDER_NAME}" Drive folder from the connected calendar account -- has it been shared (Viewer) with that account's email yet? See lib/googleCalendarAuth.js's header comment.`
      });
      return;
    }
    const sheetIO = createSheetIO(automation.drive, found.id, {});
    const { rows: customerRows, modifiedTime: custModifiedTime } = await sheetIO.fetchSheetWithMeta('customer');
    const { rows: contractRows, modifiedTime: contractModifiedTime } = await sheetIO.fetchSheetWithMeta('Contract');

    const result = await dailySweep(automation.calendar, customerRows || [], contractRows || []);
    if (!result.ok) {
      sendJson(res, 200, { success: true, skipped: true, reason: result.reason });
      return;
    }

    // Each write independently try/catch'd -- a conflict on one sheet (e.g.
    // a staff member saved something the same moment this ran) shouldn't
    // lose the other sheet's already-computed changes; the next day's sweep
    // just re-converges on whatever's current.
    try { await sheetIO.writeSheetJson('customer', result.customerRows, custModifiedTime); }
    catch (err) { console.warn('[contract/write cron] customer sheet write-back failed:', err.message); }
    try { await sheetIO.writeSheetJson('Contract', result.contractRows, contractModifiedTime); }
    catch (err) { console.warn('[contract/write cron] Contract sheet write-back failed:', err.message); }

    sendJson(res, 200, { success: true, stats: result.stats });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
}

const postHandler = withDrive(async function handler(req, res, { drive, folderId, session }) {
  try {
    const body = await readJsonBody(req);
    const action = body && body.action;
    if (!action || typeof action !== 'string') {
      sendJson(res, 400, { success: false, error: 'Request body must include an "action".' });
      return;
    }

    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const sheetIO = createSheetIO(drive, effectiveFolderId, session);
    const writes = createContractWrites(sheetIO, { drive, folderId: effectiveFolderId, session });

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

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.cron === 'dailySweep') {
    return handleDailySweepCron(req, res);
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }
  return postHandler(req, res);
};
