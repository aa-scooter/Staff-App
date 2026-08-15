// Single catch-all function for every /api/photos/* route -- /list,
// /folders, /upload, /delete, and /file/<fileId> -- dispatched by path +
// method below, instead of one file per route. Collapsed 2026-08-15, same
// reason and same pattern as api/contracts/[...path].js (see that file's
// own comment): Vercel's Hobby plan caps a deployment at 12 Serverless
// Functions total. Consolidating this group (5 files -> 1) freed up
// headroom for future features without needing to touch api/auth/* (left
// alone deliberately -- see PROGRESS.md's note on why login/session code
// isn't worth the risk of merging for a marginal function-count saving).
// A catch-all dynamic segment ([...path].js) still matches every one of
// these exact URLs with NO client-side change needed in bikephotos.html --
// Vercel's file-system router treats `/api/photos/list`,
// `/api/photos/folders`, `/api/photos/upload`, `/api/photos/delete`, and
// `/api/photos/file/<id>` as all landing on this one function, with the
// matched segments available as req.query.path (an array).
//
// Each route's own business logic below is otherwise UNCHANGED from its
// original single-file version -- see each section's own comment for what
// it does and why.
const { withDrive } = require('../../lib/apiAuth');
const {
  ensureAppFolder, ensureBikePhotosRootFolder, ensureBikeFolder, findBikePhotoFolders,
  listImageFilesInFolder, listSubfolders, createImageFile, getFileMetadata,
  getFileMediaBuffer, trashFile
} = require('../../lib/googleDrive');

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

// ---- GET /api/photos/list?bike=<name> -- see the original list.js's
// comment: fuzzy-matches every Drive folder for this bike (not just an
// exact-name one) and merges photos from all of them, newest first. ----
async function handleList(req, res, { drive, folderId }, url) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const bike = ((req.query && req.query.bike) || url.searchParams.get('bike') || '').toString().trim();
  if (!bike) { sendJson(res, 400, { success: false, error: 'Missing "bike" name.' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const rootId = await ensureBikePhotosRootFolder(drive, effectiveFolderId);
  const bikeFolders = await findBikePhotoFolders(drive, rootId, bike);
  if (!bikeFolders.length) { sendJson(res, 200, { success: true, photos: [] }); return; }

  const perFolderImages = await Promise.all(bikeFolders.map((f) => listImageFilesInFolder(drive, f.id)));
  const images = perFolderImages.flat().sort((a, b) => {
    const at = a.createdTime ? Date.parse(a.createdTime) : 0;
    const bt = b.createdTime ? Date.parse(b.createdTime) : 0;
    return bt - at; // newest first, matching listImageFilesInFolder's own ordering
  });
  const photos = images.map((f) => ({ id: f.id, url: `/api/photos/file/${encodeURIComponent(f.id)}` }));
  sendJson(res, 200, { success: true, photos });
}

// ---- GET /api/photos/folders -- see the original folders.js's comment:
// bikephotos.html's coverage check, every per-bike photo subfolder with
// its image count. ----
async function handleFolders(req, res, { drive, folderId }) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const rootId = await ensureBikePhotosRootFolder(drive, effectiveFolderId);
  const subfolders = await listSubfolders(drive, rootId);

  const folders = await Promise.all(subfolders.map(async (f) => {
    const images = await listImageFilesInFolder(drive, f.id);
    return { name: f.name, count: images.length };
  }));

  sendJson(res, 200, { success: true, folders });
}

// ---- POST /api/photos/upload -- body { bike, filename, mimeType, base64
// }. See the original upload.js's comment: creates the bike's folder on
// first upload, ~3MB effective size ceiling from Vercel's 4.5MB request
// body cap (bikephotos.html already resizes client-side to stay under it).
// ----
async function handleUpload(req, res, { drive, folderId }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
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
}

// ---- POST /api/photos/delete -- body { fileId }. See the original
// delete.js's comment: mimeType-image guard before trashing, so a stray
// fileId can never trash a non-photo Drive file this app created. ----
async function handleDelete(req, res, { drive }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
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
}

// ---- GET /api/photos/file/<fileId> -- private-proxy stream. See the
// original file/[fileId].js's comment: images only (not PDFs -- that's the
// contracts route's job), 1h private cache since a photo's bytes never
// change in place once uploaded. ----
async function handleFile(req, res, { drive }, fileId) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  if (!fileId) { sendJson(res, 400, { success: false, error: 'Missing file id.' }); return; }

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
}

module.exports = withDrive(async function handler(req, res, ctx) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  // req.query.path is the catch-all segment array Vercel's Node runtime
  // gives us (e.g. ['list'], ['file', 'abc123']); fall back to parsing the
  // URL path directly for a plain Node test harness, same
  // belt-and-suspenders pattern api/contracts/[...path].js already uses.
  const pathParts = (req.query && req.query.path) ||
    url.pathname.replace(/^\/api\/photos\//, '').split('/').filter(Boolean);
  const route = pathParts[0] || '';

  try {
    if (route === 'list') { await handleList(req, res, ctx, url); return; }
    if (route === 'folders') { await handleFolders(req, res, ctx); return; }
    if (route === 'upload') { await handleUpload(req, res, ctx); return; }
    if (route === 'delete') { await handleDelete(req, res, ctx); return; }
    if (route === 'file') { await handleFile(req, res, ctx, pathParts[1]); return; }
    sendJson(res, 404, { success: false, error: 'Not found.' });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
