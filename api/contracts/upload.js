// POST /api/contracts/upload -- body { name, phone, dateStr, filename,
// mimeType, base64 }. Uploads a passport photo into the customer's
// contract-document folder, resolving/creating that folder exactly the
// way Code.gs's getOrCreateCustomerContractFolder did: reuse the SAME
// folder for a returning customer's later contracts (matched by name+
// phone, remembered in the contract_docs.json sidecar once resolved) --
// never a brand-new folder for someone who already has one, and a fresh
// one dated to `dateStr` only when nobody matches at all.
//
// dateStr is the rental start date as dd-MM-yyyy (already formatted
// client-side, same as the legacy folder names use) -- both for naming a
// freshly-created folder and for the uploaded file's own name, so a
// returning customer's second visit gets its own dated file rather than
// silently overwriting their first one.
//
// Refuses a second upload for the SAME customer+date (mirrors Code.gs's
// savePassportPhoto): if a file with the expected name is already sitting
// in the resolved folder, this returns { success:false, alreadyExists:true,
// file } pointing at the existing one instead of uploading a duplicate.
const { withDrive } = require('../../lib/apiAuth');
const {
  ensureAppFolder, ensureContractsRootFolder, ensureContractCustomerFolder,
  readJsonFile, writeJsonFile, buildContractMatchKey, listAllFilesInFolder,
  getFileMetadata, createImageFile
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

function extFromMimeType(mimeType) {
  const m = (mimeType || '').toLowerCase();
  if (m.indexOf('png') !== -1) return '.png';
  if (m.indexOf('webp') !== -1) return '.webp';
  if (m.indexOf('heic') !== -1) return '.heic';
  if (m.indexOf('gif') !== -1) return '.gif';
  return '.jpg';
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
    const dateStr = (body.dateStr || '').toString().trim();
    const mimeType = (body.mimeType || 'image/jpeg').toString().trim();
    const base64 = (body.base64 || '').toString();

    if (!name) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }
    if (!dateStr) { sendJson(res, 400, { success: false, error: 'Missing "dateStr".' }); return; }
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
    const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
    const matchKey = buildContractMatchKey(name, phone);

    // Resolve the target folder -- sidecar first (fast path, and correctly
    // reuses a MANUALLY picked folder too, not just an auto-confident
    // one), falling back to the live search-or-create.
    const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME);
    const rows = sidecarRows || [];
    let targetFolderId = null;
    let targetFolderName = null;
    const existingEntry = rows.find((r) => r[0] === matchKey);
    if (existingEntry) {
      try {
        const parsed = JSON.parse(existingEntry[1]);
        if (parsed && parsed.folderId) {
          const meta = await getFileMetadata(drive, parsed.folderId);
          if (meta && !meta.trashed) { targetFolderId = parsed.folderId; targetFolderName = meta.name; }
        }
      } catch (e) { /* fall through to live resolution below */ }
    }

    let sidecarNeedsWrite = false;
    if (!targetFolderId) {
      targetFolderId = await ensureContractCustomerFolder(drive, contractsRootId, name, phone, dateStr);
      const meta = await getFileMetadata(drive, targetFolderId);
      targetFolderName = meta ? meta.name : null;
      sidecarNeedsWrite = true;
    }

    const expectedPrefix = 'Photo of Passport - ' + name + ' - ' + dateStr;
    const existingFiles = await listAllFilesInFolder(drive, targetFolderId);
    const dup = existingFiles.find((f) => f.name.indexOf(expectedPrefix) === 0);
    if (dup) {
      sendJson(res, 200, {
        success: false, alreadyExists: true,
        error: 'A photo of passport dated ' + dateStr + ' is already on file for this contract.',
        file: { id: dup.id, name: dup.name, mimeType: dup.mimeType }
      });
      return;
    }

    const filename = expectedPrefix + extFromMimeType(mimeType);
    const created = await createImageFile(drive, targetFolderId, filename, mimeType, buffer);

    if (sidecarNeedsWrite) {
      const newRows = rows.filter((r) => r[0] !== matchKey);
      newRows.push([matchKey, JSON.stringify({ folderId: targetFolderId, folderName: targetFolderName })]);
      try { await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, newRows, null); }
      catch (e) { /* best-effort remember -- the file itself is already saved either way */ }
    }

    sendJson(res, 200, { success: true, file: { id: created.id, name: created.name, mimeType: created.mimeType } });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
