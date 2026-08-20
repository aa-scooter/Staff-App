// Single catch-all function for every /api/contracts/* route --
// /documents, /confirmMatch, /upload, /generate, /generateReceipt,
// /generateChecklist, and /file/<fileId> -- dispatched by path + method
// below, instead of one file per route (see git history for the original
// 4-file version). Collapsed 2026-08-15: Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions total, and having these as
// separate files pushed this project over the cap and broke the deploy
// (errorCode "exceeded_serverless_functions_per_deployment"). A catch-all
// dynamic segment ([...path].js) still matches every one of these exact
// URLs with NO client-side change needed beyond the fetch() URL itself --
// Vercel's file-system router treats `/api/contracts/documents`,
// `/api/contracts/confirmMatch`, `/api/contracts/upload`,
// `/api/contracts/generate`, `/api/contracts/generateReceipt`,
// `/api/contracts/generateChecklist`, and `/api/contracts/file/<id>` as
// all landing on this one function, with the matched segments available
// as req.query.path (an array). `generate` (added 2026-08-20) and
// `generateReceipt`/`generateChecklist` (added later the same day) all
// follow this same pattern deliberately -- a brand-new file for any of
// these would have pushed the count right back over the cap.
//
// Each route's own business logic below is otherwise UNCHANGED from its
// original single-file version -- see each section's own comment for what
// it does and why.
const { withDrive } = require('../../lib/apiAuth');
const {
  ensureAppFolder, ensureContractsRootFolder, ensureContractCustomerFolder,
  readJsonFile, writeJsonFile, buildContractMatchKey, findContractFolderMatches,
  listAllFilesInFolder, getFileMetadata, getFileMediaBuffer, createImageFile
} = require('../../lib/googleDrive');
const { setSessionCookie } = require('../../lib/session');
const {
  generateContractDocumentFromJson, generateReceiptDocumentFromJson, generateChecklistDocumentFromJson
} = require('../../lib/contractDocGen');

const SIDECAR_FILENAME = 'contract_docs.json';

// `session`, if passed, is persisted back onto the response BEFORE writing
// the JSON body -- same "the moment something changes, re-set the cookie"
// pattern api/data/[sheet].js uses, needed here because readJsonFile/
// writeJsonFile below now cache each resolved contract_docs.json file id
// onto the session in memory (see resolveFileMeta in lib/googleDrive.js,
// 2026-08-15 perf pass) and that cache is worthless if it never makes it
// back into the browser's cookie. ----
function sendJson(res, status, body, session) {
  if (session && !res.headersSent) setSessionCookie(res, session);
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

function toFileSummary(f) {
  return { id: f.id, name: f.name, mimeType: f.mimeType };
}

function extFromMimeType(mimeType) {
  const m = (mimeType || '').toLowerCase();
  if (m.indexOf('png') !== -1) return '.png';
  if (m.indexOf('webp') !== -1) return '.webp';
  if (m.indexOf('heic') !== -1) return '.heic';
  if (m.indexOf('gif') !== -1) return '.gif';
  return '.jpg';
}

function isServableType(mimeType) {
  return /^image\//.test(mimeType || '') || mimeType === 'application/pdf';
}

// ---- GET /api/contracts/documents?name=&phone= -- see the original
// documents.js's comment: sidecar-first lookup, live fuzzy search fallback
// (auto-remembering a confident match), candidates list otherwise. ----
async function handleDocuments(req, res, { drive, folderId, session }, url) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const name = ((req.query && req.query.name) || url.searchParams.get('name') || '').toString().trim();
  const phone = ((req.query && req.query.phone) || url.searchParams.get('phone') || '').toString().trim();
  if (!name) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
  const matchKey = buildContractMatchKey(name, phone);

  const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, session);
  const rows = sidecarRows || [];
  const existing = rows.find((r) => r[0] === matchKey);

  if (existing) {
    let entry = null;
    try { entry = JSON.parse(existing[1]); } catch (e) { entry = null; }
    if (entry && entry.folderId) {
      try {
        const meta = await getFileMetadata(drive, entry.folderId);
        if (meta && !meta.trashed) {
          const files = await listAllFilesInFolder(drive, entry.folderId);
          sendJson(res, 200, {
            success: true, matched: true, confident: true, remembered: true,
            folderId: entry.folderId, folderName: entry.folderName || meta.name,
            files: files.map(toFileSummary)
          }, session);
          return;
        }
      } catch (e) { /* stale/deleted folder reference -- fall through to a live search */ }
    }
  }

  const { confident, candidates } = await findContractFolderMatches(drive, contractsRootId, name, phone);
  if (confident) {
    const newRows = rows.filter((r) => r[0] !== matchKey);
    newRows.push([matchKey, JSON.stringify({ folderId: confident.id, folderName: confident.name })]);
    try { await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, newRows, null, false, session); }
    catch (e) { /* best-effort remember */ }

    const files = await listAllFilesInFolder(drive, confident.id);
    sendJson(res, 200, {
      success: true, matched: true, confident: true, remembered: false,
      folderId: confident.id, folderName: confident.name,
      files: files.map(toFileSummary)
    }, session);
    return;
  }

  sendJson(res, 200, { success: true, matched: false, candidates }, session);
}

// ---- POST /api/contracts/confirmMatch -- body { name, phone, folderId }.
// Manual picker confirmation; see the original confirmMatch.js's comment. ----
async function handleConfirmMatch(req, res, { drive, folderId, session }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  const name = (body.name || '').toString().trim();
  const phone = (body.phone || '').toString().trim();
  const pickedFolderId = (body.folderId || '').toString().trim();
  if (!name) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }
  if (!pickedFolderId) { sendJson(res, 400, { success: false, error: 'Missing "folderId".' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);

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
  const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, session);
  const rows = (sidecarRows || []).filter((r) => r[0] !== matchKey);
  rows.push([matchKey, JSON.stringify({ folderId: pickedFolderId, folderName: meta.name })]);
  await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, rows, null, false, session);

  const files = await listAllFilesInFolder(drive, pickedFolderId);
  sendJson(res, 200, {
    success: true, folderId: pickedFolderId, folderName: meta.name,
    files: files.map(toFileSummary)
  }, session);
}

// ---- POST /api/contracts/upload -- body { name, phone, dateStr, filename,
// mimeType, base64 }. See the original upload.js's comment: resolves/
// creates the customer's folder (sidecar-first, else fuzzy-search-or-
// create), refuses a duplicate same-customer+same-date upload. ----
async function handleUpload(req, res, { drive, folderId, session }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
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

  const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, session);
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
    }, session);
    return;
  }

  const filename = expectedPrefix + extFromMimeType(mimeType);
  const created = await createImageFile(drive, targetFolderId, filename, mimeType, buffer);

  if (sidecarNeedsWrite) {
    const newRows = rows.filter((r) => r[0] !== matchKey);
    newRows.push([matchKey, JSON.stringify({ folderId: targetFolderId, folderName: targetFolderName })]);
    try { await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, newRows, null, false, session); }
    catch (e) { /* best-effort remember -- the file itself is already saved either way */ }
  }

  sendJson(res, 200, { success: true, file: { id: created.id, name: created.name, mimeType: created.mimeType } }, session);
}

// ---- POST /api/contracts/generate -- body is the SAME shape
// contract.html's buildRegenerateContractPayload already sends (name,
// nationality, passport, number, bikeModel, rentingDateFrom, returnDate,
// returnTime, deliverToHotel, totalPrice, deposit, depositAmount,
// depositCurrency, deliveryFeeApplies, deliveryFee, helmet fields). Added
// 2026-08-20, replacing contract.html's "View Contract"/"Update Contract"
// buttons' old call to the now-decommissioned Code.gs Apps Script Web App
// (`scriptUrl`, action 'regenerateContract') -- see lib/contractDocGen.js's
// header comment for the full story. Deliberately returns just the new
// PDF's file id, NOT a public "anyone with the link" Drive URL the way
// Code.gs did -- the client opens it the same private way it already opens
// a passport photo, via GET /api/contracts/file/<id> above, so a generated
// contract never needs public link-sharing turned on at all. ----
async function handleGenerate(req, res, ctx) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  if (!(body && body.name)) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }

  const result = await generateContractDocumentFromJson(ctx, body);
  sendJson(res, 200, result, ctx.session);
}

// ---- POST /api/contracts/generateReceipt -- body is the SAME shape
// contract.html's receiptConfirmBtn handler already sends (rowNumber,
// number, rentingDateFrom, receiptNo, receiptDate, name, bikeModel, cc,
// rentalPeriodFrom, rentalPeriodTo, rentalFee, deliveryFee, otherLabel,
// otherAmount, totalPaid, paymentMethod, otherMethodText, receivedBy).
// Added 2026-08-20, replacing the old scriptUrl call (action
// 'generateReceipt') to the now-decommissioned Code.gs Apps Script Web
// App -- see lib/contractDocGen.js's generateReceiptDocumentFromJson for
// the full story. Same private-proxy pattern as 'generate' above:
// returns just the new PDF's file id (plus the assigned receiptNo), opened
// via GET /api/contracts/file/<id>. ----
async function handleGenerateReceipt(req, res, ctx) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  if (!(body && body.name)) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }

  const result = await generateReceiptDocumentFromJson(ctx, body);
  sendJson(res, 200, result, ctx.session);
}

// ---- POST /api/contracts/generateChecklist -- body: { rowNumber, name,
// number, rentingDateFrom }. Same replacement as handleGenerateReceipt
// above, for the old scriptUrl action 'generateChecklist' /
// 'findChecklistDocument' (the latter is now just a client-side filename
// search against GET /api/contracts/documents, same as "View Contract"
// already does -- no separate find route needed here). ----
async function handleGenerateChecklist(req, res, ctx) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  if (!(body && body.name)) { sendJson(res, 400, { success: false, error: 'Missing "name".' }); return; }

  const result = await generateChecklistDocumentFromJson(ctx, body);
  sendJson(res, 200, result, ctx.session);
}

// ---- GET /api/contracts/file/<fileId> -- private-proxy stream, images +
// PDFs. See the original file/[fileId].js's comment. ----
async function handleFile(req, res, { drive }, fileId, url) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  if (!fileId) { sendJson(res, 400, { success: false, error: 'Missing file id.' }); return; }

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
  // REVERTED 2026-08-20 (Anton): PDFs used to always force-download here
  // (Content-Disposition: attachment) so they'd hand off to a native PDF
  // app instead of Chrome's inline viewer. Anton changed his mind the same
  // day -- "View Contract"/"View Receipt"/"View Checklist" should now open
  // via a real Google Drive link instead (see contract.html's
  // driveViewUrl()), which never even reaches this route anymore for those
  // buttons. This route stays plain `inline` (the default -- no header) by
  // default so it still works for anything that DOES still hit it directly
  // (e.g. "View Photo of Passport"). Forced download is now opt-in via
  // ?download=1, used only by "Send Contract + Receipt" (downloadContractFile_
  // in contract.html) so both files land in Downloads instead of opening tabs.
  const wantsDownload = (req.query && req.query.download === '1') || (url && url.searchParams.get('download') === '1');
  if (wantsDownload) {
    const safeName = (meta.name || 'document.pdf').replace(/[\r\n"]/g, '');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' + safeName + '"; filename*=UTF-8\'\'' + encodeURIComponent(safeName)
    );
  }
  res.end(buffer);
}

module.exports = withDrive(async function handler(req, res, ctx) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  // req.query.path is normally the catch-all segment array Vercel's Node
  // runtime gives us (e.g. ['documents'], ['file', 'abc123']). 2026-08-19:
  // added an explicit vercel.json rewrite (/api/contracts/:path* -> /api/
  // contracts/[...path]) to fix multi-segment URLs (e.g. file/<id>) 404ing
  // at the platform routing layer before ever reaching this function --
  // automatic bracket-catch-all matching was only resolving exactly one
  // path segment (same bug, same fix, as api/photos/[...path].js). That
  // rewrite's ":path*" wildcard may hand this function a joined STRING
  // ("file/abc123") instead of an array, so normalize either shape here.
  // Falls back to parsing the URL path directly for a plain Node test
  // harness, same belt-and-suspenders pattern every other route already uses.
  let pathParts = req.query && req.query.path;
  if (Array.isArray(pathParts)) {
    // already an array of segments -- normal automatic catch-all shape
  } else if (typeof pathParts === 'string' && pathParts) {
    pathParts = pathParts.split('/').filter(Boolean);
  } else {
    pathParts = url.pathname.replace(/^\/api\/contracts\//, '').split('/').filter(Boolean);
  }
  const route = pathParts[0] || '';

  try {
    if (route === 'documents') { await handleDocuments(req, res, ctx, url); return; }
    if (route === 'confirmMatch') { await handleConfirmMatch(req, res, ctx); return; }
    if (route === 'upload') { await handleUpload(req, res, ctx); return; }
    if (route === 'generate') { await handleGenerate(req, res, ctx); return; }
    if (route === 'generateReceipt') { await handleGenerateReceipt(req, res, ctx); return; }
    if (route === 'generateChecklist') { await handleGenerateChecklist(req, res, ctx); return; }
    if (route === 'file') { await handleFile(req, res, ctx, pathParts[1], url); return; }
    sendJson(res, 404, { success: false, error: 'Not found.' });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
