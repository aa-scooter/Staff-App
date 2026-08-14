// POST /api/photos/delete -- body { fileId }. Trashes (soft-deletes) one
// photo file.
//
// Safety check before touching anything: fetches the file's own metadata
// and refuses unless its mimeType is actually an image. This app's Drive
// scope (drive.file) already means it can only ever touch files it created
// itself -- but every sheet's JSON file (accounts data, customer records,
// etc.) is ALSO a file this app created, so mimeType is the one cheap,
// meaningful guard against a bug elsewhere on this page (or a future page
// reusing this same fileId-based delete pattern) accidentally passing the
// wrong id and trashing real business data instead of a photo.
const { withDrive } = require('../../lib/apiAuth');
const { getFileMetadata, trashFile } = require('../../lib/googleDrive');

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

module.exports = withDrive(async function handler(req, res, { drive }) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const fileId = (body.fileId || '').toString().trim();
    if (!fileId) { sendJson(res, 400, { success: false, error: 'Missing "fileId".' }); return; }

    let meta;
    try {
      meta = await getFileMetadata(drive, fileId);
    } catch (e) {
      sendJson(res, 404, { success: false, error: 'That photo could not be found (it may already be deleted).' });
      return;
    }
    if (!meta || !/^image\//.test(meta.mimeType || '')) {
      sendJson(res, 400, { success: false, error: 'That file is not a photo -- refusing to delete it.' });
      return;
    }

    await trashFile(drive, fileId);
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
