// POST /api/photos/upload -- body { bike, filename, mimeType, base64 }.
// Ensures that bike's photo folder exists (creating it on first-ever
// upload for that bike), decodes the base64 payload, and uploads it as a
// new Drive file. Returns { success, photo: { id, url } }.
//
// NOTE on size: Vercel Functions cap the request body at 4.5 MB total
// (see https://vercel.com/docs/functions/limitations#request-body-size),
// and base64 inflates binary size by ~33% -- so the ORIGINAL photo needs
// to stay well under ~3 MB for this to succeed. bikephotos.html resizes/
// re-compresses every photo client-side before it ever reaches this
// endpoint (see resizeImageForUploadB there) specifically so this limit is
// rarely if ever hit in practice; a request that's still too large gets
// rejected by Vercel itself with a 413 before this handler even runs.
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, ensureBikePhotosRootFolder, ensureBikeFolder, createImageFile } = require('../../lib/googleDrive');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw.length ? JSON.parse(raw) : {}); }
      catch (err) { reject(new Error('Invalid JSON body: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const bike = (body.bike || '').toString().trim();
    const filename = (body.filename || '').toString().trim() || ('photo-' + Date.now() + '.jpg');
    const mimeType = (body.mimeType || '').toString().trim() || 'image/jpeg';
    const base64 = (body.base64 || '').toString();

    if (!bike) { sendJson(res, 400, { success: false, error: 'Missing "bike" name.' }); return; }
    if (!base64) { sendJson(res, 400, { success: false, error: 'Missing photo data.' }); return; }
    if (!/^image\//.test(mimeType)) { sendJson(res, 400, { success: false, error: 'Only image files can be uploaded here.' }); return; }

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      sendJson(res, 400, { success: false, error: 'Photo data was not valid base64.' });
      return;
    }
    if (!buffer.length) { sendJson(res, 400, { success: false, error: 'Photo data was empty.' }); return; }

    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const rootId = await ensureBikePhotosRootFolder(drive, effectiveFolderId);
    const bikeFolderId = await ensureBikeFolder(drive, rootId, bike);
    const file = await createImageFile(drive, bikeFolderId, filename, mimeType, buffer);

    sendJson(res, 200, { success: true, photo: { id: file.id, url: `/api/photos/file/${encodeURIComponent(file.id)}` } });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
