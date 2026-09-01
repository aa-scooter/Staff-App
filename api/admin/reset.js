// POST /api/admin/reset -- the manual "Reset data from latest deploy"
// button on the Settings page (see project notes: deliberately NOT
// automatic on every load -- only when this is actually clicked). Pushes
// every JSON file bundled in THIS deploy's /data folder up to Drive,
// overwriting whatever's currently live there. Used during testing to
// recover from bad test data; the intent is to stop using this once the
// Drive copy is trusted as the real, live data.
//
// EXTENDED 2026-08-20 to also carry the new daily/manual JSON backup +
// restore feature (see lib/backups.js's own header comment for the full
// design/why), dispatched via an `action` field in the POST body:
//   - no body / {} (unchanged)         -> legacy "reset from deploy"
//   - { action: 'backupCreate' }       -> create a backup right now
//   - { action: 'backupEnsureDaily' }  -> create one only if it's been a
//                                          while since the last (any
//                                          trigger) -- the silent
//                                          page-load/hourly check
//   - { action: 'backupList' }         -> list backups, newest first
//   - { action: 'backupRestore',
//       backupId: '<id>' }             -> whole-dataset restore from one
//                                          backup (auto-snapshots the
//                                          current live data first)
//   - { action: 'backupDelete',
//       backupIds: ['<id>', ...] }     -> manual bulk-delete (checkboxes +
//                                          delete button on the Settings
//                                          backup list, Anton 20/08/2026)
//
// EXTENDED 2026-08-21 to also carry the month-end rollover (see
// lib/monthRollover.js's own header comment for the full design/why --
// ports Code.gs's createMonthSheetFromTemplate/carryForwardMonthFigures_/
// checkForMonthEndRollover, which had no Vercel equivalent at all until
// now, confirmed to actually break every accounts.html write the moment a
// new month's file doesn't exist):
//   - { action: 'createNextMonthSheet' }            -> manual trigger, same
//                                                       "one click does
//                                                       both steps" as the
//                                                       old index.html
//                                                       button, now wired
//                                                       to something real
//   - { action: 'createNextMonthSheet',
//       dryRun: true }                              -> preview only, writes
//                                                       nothing
// Also handles GET .../api/admin/reset?cron=monthRollover -- the automatic,
// unattended nightly check (see vercel.json's `crons` entry and
// lib/monthRollover.js's checkForMonthEndRolloverJson). Same CRON_SECRET
// bearer-token auth, and the same "no staff session -> borrow the calendar
// automation account's Drive access" trick api/contract/write.js's own
// `?cron=dailySweep` handler already established -- see that file's header
// comment and lib/googleCalendarAuth.js's automationClientsFromEnv for the
// full "why". Reusing it here means zero new setup for Anton IF the
// calendar automation is already connected+shared; if it isn't, this skips
// quietly (same as dailySweep does) rather than failing loudly -- the
// manual button above is the reliable fallback either way.
//
// EXTENDED 2026-08-24 to also carry rollover-health status tracking (see
// lib/rolloverStatus.js's own header comment for the full design/why --
// closes the gap where the cron's "quietly skipped" responses above were
// invisible to a human):
//   - { action: 'rolloverStatus' }                  -> returns the last
//                                                       recorded outcome of
//                                                       either the cron or
//                                                       the manual button
//                                                       above, for
//                                                       index.html's banner
//
// Deliberately NOT a new file/route: this project already hit Vercel
// Hobby's 12-Serverless-Function cap once (see PROGRESS.md/
// BUGFIX_HANDOFF.md's bike-photos-404 saga) consolidating routes into
// catch-alls to get back under it -- adding a brand-new file here would
// risk the exact same failure again for no real benefit, since this
// action already lives on its own dedicated POST endpoint with plenty of
// room to grow via the body instead of the path.
const fs = require('fs');
const path = require('path');
const { withDrive } = require('../../lib/apiAuth');
const { writeJsonFile, ensureAppFolder, ensureYearFolder } = require('../../lib/googleDrive');
const { isMonthSheetName } = require('../../lib/monthSheets');
const { createBackup, listBackups, ensureDailyBackup, deleteBackups, restoreBackup } = require('../../lib/backups');
const { createNextMonthSheetFromJson, checkForMonthEndRolloverJson, createCurrentMonthSheetFromJson } = require('../../lib/monthRollover');
const { createAccountsWrites } = require('../../lib/accountsWrites');
const { writeRolloverStatus, readRolloverStatus } = require('../../lib/rolloverStatus');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// The bundled /data/*.json snapshot (January.json ... August_notes.json etc)
// predates year-scoping -- it's all 2026 data (see project discussion,
// 13/08/2026), so that's the year these bare-named files get seeded into.
// Not derived from the current date on purpose: this seed data doesn't
// become "this year's" data just because a reset is clicked in a later year.
const SEED_YEAR_FOR_LEGACY_MONTH_FILES = 2026;

// A monthly file on disk is either the bare month name ("July.json") or
// that month's notes sidecar ("July_notes.json"). Both need to land in the
// year folder as <baseName>_<year>.json -- returns the month name to check
// against MONTH_SHEET_NAMES, or null if this isn't a monthly file at all.
function monthNameForFile(baseName) {
  if (isMonthSheetName(baseName)) return baseName;
  if (baseName.endsWith('_notes')) {
    const withoutNotes = baseName.slice(0, -'_notes'.length);
    if (isMonthSheetName(withoutNotes)) return withoutNotes;
  }
  return null;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      // A totally empty body (the existing "Reset data" button's fetch
      // call sends no body at all, no Content-Type) must resolve to {},
      // not throw -- that's the legacy-reset path below.
      try { resolve(raw.length ? JSON.parse(raw) : {}); }
      catch (err) { reject(new Error('Invalid JSON body: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

// ---- Legacy behavior, UNCHANGED from before 2026-08-20. ----
async function handleLegacyReset(req, res, { drive, folderId }) {
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== '_manifest.json');

  // Cache year-folder ids per year so a reset with many monthly files
  // (all the same seed year, today) only resolves/creates the folder
  // once instead of once per file.
  const yearFolderCache = {};
  async function getYearFolderId(year) {
    if (!yearFolderCache[year]) {
      yearFolderCache[year] = await ensureYearFolder(drive, effectiveFolderId, year);
    }
    return yearFolderCache[year];
  }

  const results = [];
  for (const filename of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
    const data = JSON.parse(raw);
    const baseName = filename.slice(0, -'.json'.length);
    const monthName = monthNameForFile(baseName);

    // No expectedModifiedTime here -- this action is an explicit,
    // deliberate "yes, overwrite whatever's there" from a human, not a
    // routine save, so the usual conflict guard doesn't apply.
    // skipExistenceRetry: true -- bulk-seeding ~26 files in a row here;
    // see writeJsonFile's comment on why the normal not-found retry
    // would just add dead time in this specific bulk case.
    if (monthName) {
      // Monthly (year-scoped) file -- goes into <year>/<baseName>_<year>.json
      // (see lib/monthSheets.js for the storage layout this mirrors).
      const yearFolderId = await getYearFolderId(SEED_YEAR_FOR_LEGACY_MONTH_FILES);
      const yearScopedFilename = `${baseName}_${SEED_YEAR_FOR_LEGACY_MONTH_FILES}.json`;
      await writeJsonFile(drive, yearFolderId, yearScopedFilename, data, null, true);
      results.push(`${SEED_YEAR_FOR_LEGACY_MONTH_FILES}/${yearScopedFilename}`);
    } else {
      // Global (year-independent) file -- unchanged, flat in the app
      // folder root, same as before this year-scoping change.
      await writeJsonFile(drive, effectiveFolderId, filename, data, null, true);
      results.push(filename);
    }
  }

  // ---- Also wipe the transaction log (added 2026-08-15, per Anton).
  // transactionLog.json isn't part of the bundled /data snapshot (it's
  // runtime-generated, not seed data), so the loop above never touches
  // it -- reset separately here. This has to happen on every reset: a
  // reversible entry's `writes` array records exact before/after cell
  // values from BEFORE the reset, which no longer match the freshly
  // reset data at all -- reversing one after a reset would silently
  // write stale, wrong values back over the reset data. Best-effort: if
  // this write fails, the rest of the reset has already succeeded and
  // shouldn't be reported as a failure over a stale log the settings
  // page can still be manually cleared from.
  let transactionLogCleared = false;
  try {
    await writeJsonFile(drive, effectiveFolderId, 'transactionLog.json', [], null, true);
    transactionLogCleared = true;
  } catch (logErr) {
    // swallow -- see comment above
  }

  sendJson(res, 200, { success: true, filesReset: results.length, files: results, transactionLogCleared });
}

// ---- New 2026-08-20 backup/restore actions. ----
async function handleBackupAction(req, res, { drive, folderId }, action, body) {
  const effectiveFolderId = folderId || await ensureAppFolder(drive);

  if (action === 'backupCreate') {
    const backup = await createBackup(drive, effectiveFolderId, 'manual');
    sendJson(res, 200, { success: true, backup });
    return;
  }

  if (action === 'backupEnsureDaily') {
    const result = await ensureDailyBackup(drive, effectiveFolderId);
    sendJson(res, 200, Object.assign({ success: true }, result));
    return;
  }

  if (action === 'backupList') {
    const backups = await listBackups(drive, effectiveFolderId);
    sendJson(res, 200, { success: true, backups });
    return;
  }

  if (action === 'backupDelete') {
    const backupIds = body && body.backupIds;
    if (!Array.isArray(backupIds) || !backupIds.length || !backupIds.every((id) => typeof id === 'string' && id)) {
      sendJson(res, 400, { success: false, error: 'Missing/invalid "backupIds" (expected a non-empty array of strings).' });
      return;
    }
    const result = await deleteBackups(drive, backupIds);
    sendJson(res, 200, Object.assign({ success: true }, result));
    return;
  }

  if (action === 'backupRestore') {
    const backupId = body && body.backupId;
    if (!backupId || typeof backupId !== 'string') {
      sendJson(res, 400, { success: false, error: 'Missing "backupId".' });
      return;
    }
    const result = await restoreBackup(drive, effectiveFolderId, backupId);
    sendJson(res, 200, Object.assign({ success: true }, result));
    return;
  }

  sendJson(res, 400, { success: false, error: `Unknown action "${action}".` });
}

// ---- Builds the {fetchSheetWithMeta, writeSheetJson} shape
// lib/monthRollover.js's functions expect -- same year-scoped filename
// convention as every other sheetIO in this project (accountsWrites.js's
// own createSheetIO, api/data/[sheet].js's resolveYearFolderId), just a
// local copy rather than an import (see monthRollover.js's own comment on
// why: same tradeoff this project already makes for DEPOSITS_MONTH_NAMES).
// No session-based folder-id caching here -- this only ever runs once per
// request (a button click or a once-a-day cron tick), so there's no
// repeat-call cost worth optimizing for, unlike accountsWrites.js's
// version which can touch 6+ sheets in one request. ----
function buildMonthSheetIO(drive, appFolderId) {
  const yearFolderCache = {};
  async function resolveFolderAndFilename(sheetName, year) {
    if (!year) return { folderId: appFolderId, filename: `${sheetName}.json` };
    const yearStr = String(year);
    if (!yearFolderCache[yearStr]) {
      yearFolderCache[yearStr] = await ensureYearFolder(drive, appFolderId, yearStr);
    }
    return { folderId: yearFolderCache[yearStr], filename: `${sheetName}_${yearStr}.json` };
  }
  return {
    async fetchSheetWithMeta(sheetName, year) {
      const { readJsonFile } = require('../../lib/googleDrive');
      const { folderId, filename } = await resolveFolderAndFilename(sheetName, year);
      const { data, modifiedTime } = await readJsonFile(drive, folderId, filename);
      return { rows: data || [], modifiedTime: modifiedTime || null };
    },
    async writeSheetJson(sheetName, rows, expectedModifiedTime, year) {
      const { folderId, filename } = await resolveFolderAndFilename(sheetName, year);
      const { modifiedTime } = await writeJsonFile(drive, folderId, filename, rows, expectedModifiedTime || null, false);
      return { modifiedTime };
    }
  };
}

// ---- New 2026-09-01 fix (see project notes: "the numbers are completely
// wrong" bug, diagnosed against real September_2026/August_2026/template
// Drive data). carryForwardMonthFigures (lib/monthRollover.js) deliberately
// leaves "cash"/"bank "/"bank less deposit"/"total (cash+bank+wise)" holding
// Template's own raw literal numbers on a freshly-created sheet -- by
// design, see FIXED_CELL_ITEMS's own comment there -- on the assumption
// that recomputeMonthlySummaryCascadeB (lib/accountsWrites.js) self-heals
// those 4 cells the moment any real expense/income/deposit write lands on
// the new sheet. That assumption held for every month before this one only
// because a transaction always got logged within moments of rollover; it
// broke for September 2026, which sat genuinely empty (the rollover itself
// had been missed -- see createCurrentMonthSheetFromJson's own header
// comment) so nothing ever triggered the self-heal, leaving Template's
// stale numbers (a real prior balance, not blank/0) on display looking
// like real -- but completely wrong -- money.
//
// Fix: run that exact same self-heal cascade ONCE, proactively, immediately
// after a real (non-dryRun) sheet actually gets created here -- covers all
// three callers (this manual button, the "generate current month" recovery
// action below, and the unattended cron) in one place, reusing the exact
// live formula every ordinary write already depends on rather than
// re-deriving a second copy of it here (which would risk drifting out of
// sync with it over time). Best-effort: a failure here does NOT undo or
// fail the sheet creation that already succeeded (every other
// carried-forward figure -- cash previous/bank previous/bike bank/wise/
// revolut/open deposits -- is already correct at that point) -- it's
// appended to result.warning instead, so it surfaces on the rollover-health
// banner / the manual button's own response rather than getting lost.
async function healFreshSheetSummary(sheetIO, result) {
  if (!result || !result.success || result.dryRun || result.skipped || !result.monthName || !result.year) return;
  try {
    const { recomputeMonthlySummaryCascadeB } = createAccountsWrites(sheetIO);
    await recomputeMonthlySummaryCascadeB(result.monthName, result.year);
  } catch (err) {
    const extra = 'Cash/Bank/Total summary recompute failed after creation: ' + err.message +
      ' -- the sheet was created and its carried-forward balances (cash previous, bank previous, bike bank, wise, revolut, open deposits) are correct, but Cash/Bank/Total may still show stale Template values until a real transaction is logged against it (or this recompute is retried, e.g. via {action:"recomputeSummary"} on /api/accounts/write).';
    result.warning = result.warning ? (result.warning + ' ' + extra) : extra;
  }
}

// ---- New 2026-08-21 month-rollover action (manual trigger). ----
// STATUS TRACKING (added 24/08/2026, see lib/rolloverStatus.js's own header
// comment): a dryRun preview never touches real data, so it's deliberately
// excluded from status tracking -- only a REAL createNextMonthSheet call
// (from this button, or from the cron below) updates the banner index.html
// shows, same reasoning `dryRun` already gets excluded from other
// side-effecting bookkeeping throughout lib/monthRollover.js.
async function handleMonthRolloverAction(req, res, { drive, folderId }, body) {
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const sheetIO = buildMonthSheetIO(drive, effectiveFolderId);
  const dryRun = !!(body && body.dryRun);
  const result = await createNextMonthSheetFromJson(sheetIO, { dryRun });
  await healFreshSheetSummary(sheetIO, result);
  if (!dryRun) {
    if (!result.success) {
      await writeRolloverStatus(drive, effectiveFolderId, { severity: 'error', message: result.error, source: 'manual' });
    } else if (result.warning) {
      await writeRolloverStatus(drive, effectiveFolderId, { severity: 'warning', message: `Created "${result.sheetName}", but: ${result.warning}`, source: 'manual' });
    } else {
      await writeRolloverStatus(drive, effectiveFolderId, { severity: 'ok', message: `Created "${result.sheetName}" cleanly.`, source: 'manual' });
    }
  }
  sendJson(res, result.success ? 200 : 400, result);
}

// ---- New 2026-09-01 action -- accounts.html's "no sheet found for the
// current month, generate it?" confirm flow (see lib/monthRollover.js's
// createCurrentMonthSheetFromJson header comment for the full "why" this
// is a separate function from the one above, not a parameter on it).
// Deliberately NOT status-tracked via writeRolloverStatus like the action
// above -- that banner is specifically about the STANDING nightly-rollover
// job's health (cron + this same manual "next month" button); this is a
// one-off recovery action a staff member triggers from inside accounts.html
// itself, where the result already surfaces directly in that page's own
// load-status line. Mixing the two would make the home-page banner harder
// to read (e.g. a real cron misconfiguration self-healing behind a
// coincidental successful recovery click here), not more useful.
async function handleCreateCurrentMonthSheetAction(req, res, { drive, folderId }, body) {
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const sheetIO = buildMonthSheetIO(drive, effectiveFolderId);
  const dryRun = !!(body && body.dryRun);
  const result = await createCurrentMonthSheetFromJson(sheetIO, { dryRun });
  await healFreshSheetSummary(sheetIO, result);
  sendJson(res, result.success ? 200 : 400, result);
}

// ---- GET .../api/admin/reset?cron=monthRollover (added 21/08/2026) --
// Vercel Cron's daily hit for the automatic month-end check. Handled BEFORE
// withDrive below, deliberately -- same reasoning as api/contract/write.js's
// own `?cron=dailySweep` handler: Vercel Cron has no browser, so there's no
// staff session cookie for withDrive to check. Authenticates itself instead
// by checking Vercel's own Authorization: Bearer <CRON_SECRET> header
// against the CRON_SECRET env var.
//
// STATUS TRACKING (added 24/08/2026, see lib/rolloverStatus.js's own header
// comment for the full "why"): every branch below now also persists what
// happened, so a problem that used to be just a quiet 200 in a Vercel log
// shows up as a banner on the home page instead. The "blocked" branches
// (missing automation credential / can't find the Drive folder) fire EVERY
// night regardless of whether tonight is actually a rollover night -- that's
// deliberate: those two are genuine standing misconfigurations that would
// also silently break the one night a month this actually matters, so
// they're worth surfacing immediately rather than waiting for the next
// month-end to discover it the hard way. The unauthorized-request return
// (bad/missing CRON_SECRET) is deliberately NOT status-tracked -- that's a
// request-auth problem, not a rollover-health problem, and would need a
// working drive/folderId to persist to anyway, which this branch doesn't have. ----
async function handleMonthRolloverCron(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers && req.headers['authorization']) || '';
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    sendJson(res, 401, { success: false, error: 'Unauthorized.' });
    return;
  }
  try {
    const { automationClientsFromEnv } = require('../../lib/googleCalendarAuth');
    const { findNamedFolderAnywhere, APP_FOLDER_NAME } = require('../../lib/googleDrive');
    const automation = automationClientsFromEnv();
    if (!automation) {
      const reason = 'CALENDAR_AUTOMATION_REFRESH_TOKEN is not set yet -- see lib/googleCalendarAuth.js. ' +
        'The "Create Next Month Sheet" button on the home page still works manually in the meantime.';
      // No drive client at all in this branch (that's the whole problem) --
      // nowhere to persist the status TO. Falls through unrecorded; the
      // very next successful check (once this is fixed) will self-heal the
      // banner by writing a fresh 'ok'/'warning'/'error' status.
      sendJson(res, 200, { success: true, skipped: true, reason });
      return;
    }
    // NOT ensureAppFolder here -- same gotcha api/contract/write.js's own
    // dailySweep already documents: the automation account doesn't OWN the
    // app's Drive folder, it only has it SHARED with it.
    const found = await findNamedFolderAnywhere(automation.drive, APP_FOLDER_NAME);
    if (!found) {
      // Same "nowhere to persist to" situation as above -- the whole point
      // of this check IS that the folder can't be located.
      sendJson(res, 200, {
        success: true, skipped: true,
        reason: `Could not find the "${APP_FOLDER_NAME}" Drive folder from the connected calendar account -- ` +
          'has it been shared (Viewer) with that account\'s email yet? See lib/googleCalendarAuth.js\'s header comment. ' +
          'The "Create Next Month Sheet" button on the home page still works manually in the meantime.'
      });
      return;
    }
    const sheetIO = buildMonthSheetIO(automation.drive, found.id);
    const result = await checkForMonthEndRolloverJson(sheetIO);
    await healFreshSheetSummary(sheetIO, result);
    // result.skipped === true here means the ordinary "tomorrow isn't the
    // 1st" no-op (see checkForMonthEndRolloverJson) -- the expected outcome
    // 364 nights a year, not a problem. Recording 'ok' on every one of
    // those nights (rather than only recording something on rollover
    // nights) is deliberate: it's what lets a previously-'blocked' status
    // self-heal to 'ok' automatically the very next night after the
    // underlying config problem gets fixed, with no separate "clear the
    // banner" step needed anywhere.
    if (result.skipped) {
      await writeRolloverStatus(automation.drive, found.id, { severity: 'ok', message: result.reason, source: 'cron' });
    } else if (!result.success) {
      await writeRolloverStatus(automation.drive, found.id, { severity: 'error', message: result.error, source: 'cron' });
    } else if (result.warning) {
      await writeRolloverStatus(automation.drive, found.id, { severity: 'warning', message: `Created "${result.sheetName}", but: ${result.warning}`, source: 'cron' });
    } else {
      await writeRolloverStatus(automation.drive, found.id, { severity: 'ok', message: `Created "${result.sheetName}" cleanly.`, source: 'cron' });
    }
    sendJson(res, 200, result);
  } catch (err) {
    // Best-effort status write -- if THIS also fails (e.g. the exception
    // was itself a Drive-access problem), writeRolloverStatus's own
    // try/catch swallows it rather than masking the real error below.
    try {
      const { automationClientsFromEnv } = require('../../lib/googleCalendarAuth');
      const { findNamedFolderAnywhere, APP_FOLDER_NAME } = require('../../lib/googleDrive');
      const automation = automationClientsFromEnv();
      if (automation) {
        const found = await findNamedFolderAnywhere(automation.drive, APP_FOLDER_NAME);
        if (found) await writeRolloverStatus(automation.drive, found.id, { severity: 'error', message: err.message, source: 'cron' });
      }
    } catch (statusErr) { /* swallow -- see comment above */ }
    sendJson(res, 500, { success: false, error: err.message });
  }
}

// ---- New 2026-08-24 action -- lets index.html ask "is anything wrong with
// month rollover?" on page load, using the staff member's own logged-in
// Drive session (same as every other page read in this app) rather than
// the cron's borrowed automation credentials -- both read/write the exact
// same rollover_status.json in the app's Drive folder, so it doesn't matter
// which identity last wrote it. ----
async function handleRolloverStatusAction(req, res, { drive, folderId }) {
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const status = await readRolloverStatus(drive, effectiveFolderId);
  sendJson(res, 200, { success: true, status });
}

// Same "define the withDrive-wrapped handler once at module scope" shape
// api/contract/write.js's own postHandler uses -- avoids rebuilding the
// wrapper closure on every request.
const postHandler = withDrive(async function handler(req, res, ctx) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const action = body && body.action;
    if (!action) {
      await handleLegacyReset(req, res, ctx);
      return;
    }
    if (action === 'createNextMonthSheet') {
      await handleMonthRolloverAction(req, res, ctx, body);
      return;
    }
    if (action === 'createCurrentMonthSheet') {
      await handleCreateCurrentMonthSheetAction(req, res, ctx, body);
      return;
    }
    if (action === 'rolloverStatus') {
      await handleRolloverStatusAction(req, res, ctx);
      return;
    }
    await handleBackupAction(req, res, ctx, action, body);
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.cron === 'monthRollover') {
    return handleMonthRolloverCron(req, res);
  }
  return postHandler(req, res);
};
