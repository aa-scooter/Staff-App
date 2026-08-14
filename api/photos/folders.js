// GET /api/photos/folders -- lists every per-bike photo subfolder under
// the "Bike Photos" root, with how many photos each one has. Used only by
// bikephotos.html's coverage check (which bikes have photos vs. don't) --
// see lib/googleDrive.js's block comment on the Bike Photos folder layout.
//
// N+1 query shape (one files.list for the subfolders, then one more per
// subfolder to count its images) rather than a single flat query -- Drive's
// `in parents` only matches DIRECT children, so a bike's photos (one level
// deeper than the "Bike Photos" root) can't be found in one call scoped to
// that root. Acceptable here: this runs once per bikephotos.html page load
// (not in a hot loop), and the subfolder count is bounded by the number of
// bikes the shop actually has (a few dozen), not an unbounded list.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ensureBikePhotosRootFolder, listSubfolders, listImageFilesInFolder } = require('../../lib/googleDrive');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }
  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const rootId = await ensureBikePhotosRootFolder(drive, effectiveFolderId);
    const subfolders = await listSubfolders(drive, rootId);

    const folders = await Promise.all(subfolders.map(async (f) => {
      const images = await listImageFilesInFolder(drive, f.id);
      return { name: f.name, count: images.length };
    }));

    sendJson(res, 200, { success: true, folders });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
