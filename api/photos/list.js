// GET /api/photos/list?bike=<name> -- lists the photos in one bike's Drive
// folder(s), newest first. Returns an empty list (not an error) if that
// bike has never had a photo uploaded, since no folder existing yet is a
// normal, expected state -- not a failure.
//
// FIXED 15/08/2026: used to look up only the ONE folder whose name was an
// EXACT match to the bike name (findNamedFolder) -- but the coverage check
// on bikephotos.html (api/photos/folders.js + client-side bikeNamesMatch)
// already counts a bike as "has photos" off a FUZZY name match, since
// legacy hand-copied folders don't always spell a bike's name identically
// to the "Parts and Oil change" sheet (e.g. "Click red 1" vs "Click red").
// That mismatch meant a bike could show N photos in the coverage summary
// but "No photos yet" when actually opened -- the exact-match lookup here
// simply couldn't see the fuzzy-matching folder the coverage check found.
// Now uses the same fuzzy match (findBikePhotoFolders) and merges photos
// from every matching folder, so this always agrees with what the
// coverage check reported. ----
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ensureBikePhotosRootFolder, findBikePhotoFolders, listImageFilesInFolder } = require('../../lib/googleDrive');

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
    // Look up (don't create) every folder that fuzzily matches this bike --
    // listing photos should never itself create an empty folder as a side
    // effect, and a bike can legitimately have more than one matching
    // folder (see findBikePhotoFolders's comment).
    const bikeFolders = await findBikePhotoFolders(drive, rootId, bike);
    if (!bikeFolders.length) {
      sendJson(res, 200, { success: true, photos: [] });
      return;
    }

    const perFolderImages = await Promise.all(bikeFolders.map((f) => listImageFilesInFolder(drive, f.id)));
    const images = perFolderImages.flat().sort((a, b) => {
      const at = a.createdTime ? Date.parse(a.createdTime) : 0;
      const bt = b.createdTime ? Date.parse(b.createdTime) : 0;
      return bt - at; // newest first, matching listImageFilesInFolder's own ordering
    });
    const photos = images.map((f) => ({ id: f.id, url: `/api/photos/file/${encodeURIComponent(f.id)}` }));
    sendJson(res, 200, { success: true, photos });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
