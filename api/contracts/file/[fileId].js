// GET /api/contracts/file/<fileId> -- streams one contract document's raw
// bytes back, with the right Content-Type. Same private-proxy pattern as
// api/photos/file/[fileId].js (see that file's comment for the reasoning),
// broadened to allow PDFs alongside images -- a customer's contract
// folder can hold the passport photo, a signed contract PDF, receipts,
// etc., not just images.
const { withDrive } = require('../../../lib/apiAuth');
const { getFileMetadata, getFileMediaBuffer } = require('../../../lib/googleDrive');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isServableType(mimeType) {
  return /^image\//.test(mimeType || '') || mimeType === 'application/pdf';
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
      sendJson(res, 404, { success: false, error: 'Document not found.' });
      return;
    }
    if (!meta || meta.trashed || !isServableType(meta.mimeType)) {
      sendJson(res, 404, { success: false, error: 'Document not found.' });
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
