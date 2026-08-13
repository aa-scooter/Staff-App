// GET /api/data/<sheet>            -- global (year-independent) sheet, e.g.
//                                      /api/data/customer, /api/data/cash
// GET /api/data/<sheet>?year=2026  -- monthly (year-scoped) sheet, e.g.
//                                      /api/data/July?year=2026
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
const { withDrive } = require('../../lib/apiAuth');
const { readJsonFile, ensureAppFolder, ensureYearFolder } = require('../../lib/googleDrive');

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
    return;
  }

  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  // Vercel's [sheet].js dynamic route puts the matched segment on
  // req.query.sheet in the Node runtime; fall back to parsing the path
  // directly so this also works when invoked in a plain Node test harness.
  const sheetParam = (req.query && req.query.sheet) || url.pathname.split('/').pop();
  const sheet = decodeURIComponent(sheetParam || '').trim();
  if (!sheet || /[\\/]/.test(sheet)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Invalid sheet name.' }));
    return;
  }

  // Optional -- present only for monthly (year-scoped) sheets. req.query.year
  // is what Vercel's Node runtime gives us; url.searchParams is the fallback
  // for a plain Node test harness, same pattern as the sheet param above.
  const yearParam = (req.query && req.query.year) || url.searchParams.get('year');
  const year = yearParam ? decodeURIComponent(String(yearParam)).trim() : '';
  if (year && !/^\d{4}$/.test(year)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Invalid year.' }));
    return;
  }

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    let result;
    if (year) {
      // Monthly sheet -- <app folder>/<year>/<sheet>_<year>.json (see
      // lib/monthSheets.js for the storage layout this mirrors).
      const yearFolderId = await ensureYearFolder(drive, effectiveFolderId, year);
      result = await readJsonFile(drive, yearFolderId, `${sheet}_${year}.json`);
    } else {
      // Global sheet -- unchanged, flat in the app folder root.
      result = await readJsonFile(drive, effectiveFolderId, sheet + '.json');
    }
    const { data, modifiedTime } = result;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, sheet, year: year || undefined, rows: data, modifiedTime }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});
