// GET  /api/data/<sheet>            -- reads a global (year-independent)
//                                       sheet, e.g. /api/data/customer
// GET  /api/data/<sheet>?year=2026  -- reads a monthly (year-scoped) sheet,
//                                       e.g. /api/data/July?year=2026
// POST /api/data/<sheet>[?year=]    -- writes (replaces) the WHOLE sheet's
//                                       row array. Body: { rows, expectedModifiedTime }.
//
// This is what every page's data layer calls now instead of a bundled
// /data/*.json file, so what staff see always reflects whatever's actually
// been saved, not just whatever was true at the last `git push`.
//
// <sheet> matches the exact filenames the export pipeline already uses
// (see export_to_json.py) -- "July", "customer", "Contract", etc. -- plus
// an optional "_notes" suffix for the sparse cell-notes sidecar files.
//
// NOTE on why year is a QUERY PARAM here rather than its own nested route
// (e.g. api/data/[year]/[sheet].js): tried that first and it failed Vercel's
// build with "Two or more files have conflicting paths or names" -- Vercel's
// plain (non-framework) api/ function builder does not allow a dynamic FILE
// ([sheet].js) and a dynamic DIRECTORY ([year]/) as siblings in the same
// parent folder, even though the two route shapes don't actually overlap at
// request time. Renaming the nested route's own [sheet] param to
// [monthSheet] did NOT fix it either -- confirmed live, 13/08/2026, the
// build error explicitly named both "api/data/[year]/[monthSheet].js" and
// "api/data/[sheet].js" as conflicting. Folding year into a query string
// avoids adding any new dynamic path segment under api/data/ at all, so
// there's nothing for Vercel's router to conflict over.
//
// WHY A "WHOLE SHEET REPLACE" WRITE INSTEAD OF PER-ACTION ENDPOINTS: Code.gs
// had a bespoke server function per action (addExpense, editBike, sellBike,
// extendBike, ...) that each did its own row math against the live sheet.
// Porting every one of those as its own Vercel route would mean re-deriving
// the same "read -> find row -> mutate -> write" plumbing dozens of times.
// Instead, each page's client-side JS now does the SAME row mutation logic
// Code.gs used to do server-side (same business rules, ported 1:1), against
// the array it already fetched via GET, then POSTs the whole updated array
// back here. This endpoint's only job is the generic part: read the
// current file's modifiedTime, refuse to overwrite if it's moved since the
// client last read it (see ConflictError in lib/googleDrive.js), and write.
const { withDrive } = require('../../lib/apiAuth');
const { readJsonFile, writeJsonFile, ensureAppFolder, ensureYearFolder, ConflictError } = require('../../lib/googleDrive');

// Vercel's Node runtime auto-parses a JSON request body onto req.body for
// us -- but a plain Node test harness (or some other runtime) might not,
// so this falls back to reading+parsing the raw stream by hand, same
// belt-and-suspenders pattern as the sheet/year param fallbacks below.
function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    }
    return Promise.resolve(req.body); // already parsed (Buffer/object both handled below if needed)
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

function parseSheetAndYear(req, url) {
  // Vercel's [sheet].js dynamic route puts the matched segment on
  // req.query.sheet in the Node runtime; fall back to parsing the path
  // directly so this also works when invoked in a plain Node test harness.
  const sheetParam = (req.query && req.query.sheet) || url.pathname.split('/').pop();
  const sheet = decodeURIComponent(sheetParam || '').trim();

  // Optional -- present only for monthly (year-scoped) sheets. req.query.year
  // is what Vercel's Node runtime gives us; url.searchParams is the fallback
  // for a plain Node test harness, same pattern as the sheet param above.
  const yearParam = (req.query && req.query.year) || url.searchParams.get('year');
  const year = yearParam ? decodeURIComponent(String(yearParam)).trim() : '';

  return { sheet, year };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const { sheet, year } = parseSheetAndYear(req, url);

  if (!sheet || /[\\/]/.test(sheet)) {
    sendJson(res, 400, { success: false, error: 'Invalid sheet name.' });
    return;
  }
  if (year && !/^\d{4}$/.test(year)) {
    sendJson(res, 400, { success: false, error: 'Invalid year.' });
    return;
  }

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    // Resolves WHERE this sheet's file lives (year subfolder vs. app root)
    // and what its filename is -- shared by both GET and POST below so the
    // two can never disagree on the storage location.
    const targetFolderId = year
      ? await ensureYearFolder(drive, effectiveFolderId, year)
      : effectiveFolderId;
    const filename = year ? `${sheet}_${year}.json` : `${sheet}.json`;

    if (req.method === 'GET') {
      const { data, modifiedTime } = await readJsonFile(drive, targetFolderId, filename);
      sendJson(res, 200, { success: true, sheet, year: year || undefined, rows: data, modifiedTime });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.rows)) {
        sendJson(res, 400, { success: false, error: 'Request body must include a "rows" array.' });
        return;
      }
      try {
        const { fileId, modifiedTime } = await writeJsonFile(
          drive, targetFolderId, filename, body.rows, body.expectedModifiedTime || null, false
        );
        sendJson(res, 200, { success: true, sheet, year: year || undefined, fileId, modifiedTime });
      } catch (err) {
        if (err instanceof ConflictError || err.isConflict) {
          sendJson(res, 409, { success: false, error: err.message, isConflict: true });
          return;
        }
        throw err;
      }
      return;
    }

    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
