// POST /api/admin/reset -- the manual "Reset data from latest deploy"
// button on the Settings page (see project notes: deliberately NOT
// automatic on every load -- only when this is actually clicked). Pushes
// every JSON file bundled in THIS deploy's /data folder up to Drive,
// overwriting whatever's currently live there. Used during testing to
// recover from bad test data; the intent is to stop using this once the
// Drive copy is trusted as the real, live data.
const fs = require('fs');
const path = require('path');
const { withDrive } = require('../../lib/apiAuth');
const { writeJsonFile, ensureAppFolder, ensureYearFolder } = require('../../lib/googleDrive');
const { isMonthSheetName } = require('../../lib/monthSheets');

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

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
    return;
  }

  try {
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

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, filesReset: results.length, files: results }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});
