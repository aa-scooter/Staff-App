// ---- Persists the outcome of every month-rollover check -- both the
// nightly Vercel Cron tick (lib/monthRollover.js's checkForMonthEndRolloverJson,
// via api/admin/reset.js's handleMonthRolloverCron) and the manual "Create
// Next Month Sheet" button (handleMonthRolloverAction) -- to one small JSON
// file on Drive, so a problem that would otherwise just be a quiet 200 in a
// Vercel log nobody watches instead shows up as a banner on the home page
// (index.html) next time Anton opens the app.
//
// Added 24/08/2026 -- Anton's own account of the risk this closes: the
// nightly cron piggybacks on the SAME Calendar automation credentials as
// calendar sync (see lib/googleCalendarAuth.js), and if that credential
// ever isn't set, or the app's Drive folder isn't (still) shared with that
// automation account, handleMonthRolloverCron returns a plain 200
// {success:true, skipped:true, reason:...} -- correct behavior for THAT
// request, but invisible to a human, since nobody is watching Vercel's
// function logs day to day. This file makes that state visible instead of
// just logged.
//
// Deliberately NOT sheet-shaped (no rows/modifiedTime array dance) -- this
// is one small status object, not tabular data, so it goes straight through
// readJsonFile/writeJsonFile rather than through a sheetIO wrapper.
//
// severity meanings (checked by index.html to decide whether to show a
// banner, and how alarming to make it):
//   'ok'      -- nothing to report: either an ordinary non-rollover-night
//                check (the expected 364-nights-a-year case), or a rollover
//                that completed with no warnings. No banner.
//   'warning' -- a rollover happened but carryForwardMonthFigures reported
//                a problem with one or more figures/tables (see
//                lib/monthRollover.js) -- the new month's sheet exists and
//                is usable, but something on it may need a manual check.
//   'blocked' -- the automatic path COULDN'T EVEN ATTEMPT a rollover
//                tonight (missing automation credential, or the app's Drive
//                folder isn't shared with that account) -- harmless on an
//                ordinary night, but means the actual rollover night will
//                also silently fail to run unless this gets fixed first.
//   'error'   -- an actual thrown exception, or an explicit
//                {success:false} from createNextMonthSheetFromJson (e.g.
//                next month's sheet already exists, or the Template sheet
//                is missing).
const { readJsonFile, writeJsonFile } = require('./googleDrive');

const ROLLOVER_STATUS_FILENAME = 'rollover_status.json';

// Best-effort by design: a problem WRITING this status must never be what
// makes the underlying rollover check itself look like it failed, so this
// never throws -- it just warns to the server log and moves on.
async function writeRolloverStatus(drive, folderId, { severity, message, source }) {
  try {
    await writeJsonFile(drive, folderId, ROLLOVER_STATUS_FILENAME, {
      severity: severity || 'ok',
      message: message || '',
      source: source || 'unknown', // 'cron' | 'manual' -- which path produced this
      checkedAt: new Date().toISOString()
    }, null, false);
  } catch (err) {
    console.warn('[rolloverStatus] Could not persist status (non-blocking):', err.message);
  }
}

// Returns null (not a thrown error) if the file doesn't exist yet (e.g.
// brand new install, before the cron has ever ticked) or can't be read --
// callers should treat null the same as {severity:'ok'} (nothing to show).
async function readRolloverStatus(drive, folderId) {
  try {
    const { data } = await readJsonFile(drive, folderId, ROLLOVER_STATUS_FILENAME);
    return data || null;
  } catch (err) {
    return null;
  }
}

module.exports = { writeRolloverStatus, readRolloverStatus, ROLLOVER_STATUS_FILENAME };
