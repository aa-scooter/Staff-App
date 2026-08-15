// POST /api/contracts/confirmMatch -- body { name, phone, folderId }.
// Staff manually picking the right folder from documents.js's `candidates`
// list when nothing could be confidently auto-matched (messy legacy folder
// naming -- see lib/googleDrive.js's block comment). Remembers the choice
// in the contract_docs.json sidecar (same one documents.js's auto-match
// path writes to) so this contract never shows the picker again, and
// returns that folder's file list immediately so the client can render
// without a second round trip.
const { withDrive } = require('../../lib/apiAuth');
const {
  ensureAppFolder, ensureContractsRootFolder, readJsonFile, writeJsonFile,
  buildContractMatchKey, listAllFilesInFolder, getFileMetadata
} = require('../../lib/googleDrive');

const SIDECAR_FILENAME = 'contract_docs.json';

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
    const name = (body.name || '').toString().trim();
    const phone = (body.phone || '').toString().trim();
    const pickedFolderId = (body.folderId || '').toString().trim();
    if (!name) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }
    if (!pickedFolderId) { sendJson(res, 400, { success: false, error: 'Missing "folderId".' }); return; }

    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);

    // Defensive check: the picked folder must actually be a direct child of
    // the contracts root -- documents.js only ever offers real subfolders
    // of it as candidates, but this guards against a stale/tampered
    // request naming some unrelated folder.
    let meta;
    try {
      meta = await getFileMetadata(drive, pickedFolderId);
    } catch (e) {
      sendJson(res, 404, { success: false, error: 'That folder could not be found.' });
      return;
    }
    const parents = meta && meta.parents ? meta.parents : [];
    if (!meta || meta.trashed || parents.indexOf(contractsRootId) === -1) {
      sendJson(res, 400, { success: false, error: 'That folder is not a valid contracts folder.' });
      return;
    }

    const matchKey = buildContractMatchKey(name, phone);
    const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME);
    const rows = (sidecarRows || []).filter((r) => r[0] !== matchKey);
    rows.push([matchKey, JSON.stringify({ folderId: pickedFolderId, folderName: meta.name })]);
    await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, rows, null);

    const files = await listAllFilesInFolder(drive, pickedFolderId);
    sendJson(res, 200, {
      success: true, folderId: pickedFolderId, folderName: meta.name,
      files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType }))
    });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
