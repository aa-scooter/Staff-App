// GET /api/photos/file/<fileId> -- streams one photo's raw bytes back,
// with the right Content-Type, so it can be used directly as an <img src>.
//
// Deliberately proxied through this app's own session rather than making
// each photo file public on Drive ("anyone with the link can view") and
// linking straight to Drive's own content URL -- this way every photo stays
// exactly as private as the rest of the app's data (same login-gated
// session everything else already requires, see nav.js's auth gate and
// every other /api route's withDrive), with no separate sharing setting to
// remember to keep in sync.
//
// Cached privately for an hour: once uploaded, a photo's bytes never
// change in place (this app only ever adds or deletes whole files, never
// edits one) -- deleting it just means this URL 404s on the next real
// fetch, not that stale cached bytes become actively wrong to show.
const { withDrive } = require('../../../lib/apiAuth');
const { getFileMetadata, getFileMediaBuffer } = require('../../../lib/googleDrive');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = withDrive(async function handler(req, res, { drive }) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }

  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const fileId = ((req.query && req.query.fileId) || url.pathname.split('/').pop() || '').toString().trim();
  if (!fileId) { sendJson(res, 400, { success: false, error: 'Missing file id.' }); return; }

  try {
    let meta;
    try {
      meta = await getFileMetadata(drive, fileId);
    } catch (e) {
      sendJson(res, 404, { success: false, error: 'Photo not found.' });
      return;
    }
    if (!meta || meta.trashed || !/^image\//.test(meta.mimeType || '')) {
      sendJson(res, 404, { success: false, error: 'Photo not found.' });
      return;
    }

    const buffer = await getFileMediaBuffer(drive, fileId);
    res.statusCode = 200;
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(buffer);
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
