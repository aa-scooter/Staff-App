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
const { createBackup, listBackups, ensureDailyBackup, restoreBackup } = require('../../lib/backups');

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

module.exports = withDrive(async function handler(req, res, ctx) {
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
    await handleBackupAction(req, res, ctx, action, body);
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
