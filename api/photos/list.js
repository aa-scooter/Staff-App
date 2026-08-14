// GET /api/photos/list?bike=<name> -- lists the photos in one bike's Drive
// folder, newest first. Returns an empty list (not an error) if that bike
// has never had a photo uploaded, since no folder existing yet is a normal,
// expected state -- not a failure.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ensureBikePhotosRootFolder, findNamedFolder, listImageFilesInFolder } = require('../../lib/googleDrive');

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
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const bike = ((req.query && req.query.bike) || url.searchParams.get('bike') || '').toString().trim();
  if (!bike) {
    sendJson(res, 400, { success: false, error: 'Missing "bike" name.' });
    return;
  }

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const rootId = await ensureBikePhotosRootFolder(drive, effectiveFolderId);
    // Look up (don't create) the bike's own folder -- listing photos should
    // never itself create an empty folder as a side effect.
    const bikeFolder = await findNamedFolder(drive, rootId, bike);
    if (!bikeFolder) {
      sendJson(res, 200, { success: true, photos: [] });
      return;
    }

    const images = await listImageFilesInFolder(drive, bikeFolder.id);
    const photos = images.map((f) => ({ id: f.id, url: `/api/photos/file/${encodeURIComponent(f.id)}` }));
    sendJson(res, 200, { success: true, photos });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
