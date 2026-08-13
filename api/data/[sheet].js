// GET /api/data/<sheet> -- reads one sheet's current JSON straight from
// Drive (e.g. /api/data/July, /api/data/customer). This is what every
// page's data layer calls now instead of a bundled /data/*.json file, so
// what staff see always reflects whatever's actually been saved, not just
// whatever was true at the last `git push`.
//
// <sheet> matches the exact filenames the export pipeline already uses
// (see export_to_json.py) -- "July", "customer", "Contract", etc. -- plus
// an optional "_notes" suffix for the sparse cell-notes sidecar files.
const { withDrive } = require('../../lib/apiAuth');
const { readJsonFile, ensureAppFolder } = require('../../lib/googleDrive');

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

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const { data, modifiedTime } = await readJsonFile(drive, effectiveFolderId, sheet + '.json');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, sheet, rows: data, modifiedTime }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});
