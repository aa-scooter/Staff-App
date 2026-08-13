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
const { writeJsonFile, ensureAppFolder } = require('../../lib/googleDrive');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

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

    const results = [];
    for (const filename of files) {
      const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf8');
      const data = JSON.parse(raw);
      // No expectedModifiedTime here -- this action is an explicit,
      // deliberate "yes, overwrite whatever's there" from a human, not a
      // routine save, so the usual conflict guard doesn't apply.
      await writeJsonFile(drive, effectiveFolderId, filename, data);
      results.push(filename);
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
