// GET /api/contracts/documents?name=&phone= -- finds the customer's
// contract-document subfolder (see lib/googleDrive.js's block comment on
// the "AA Scooters Contracts" folder Anton hand-copied in) and lists
// whatever's actually inside it: passport photo, PDFs, screenshots,
// whatever's there -- not just a single "passport photo" slot.
//
// Resolution order:
//  1. contract_docs.json sidecar -- a remembered match from an earlier
//     confident auto-match or a manual pick (see confirmMatch.js). Fast
//     path, and the ONLY way a low-confidence manual pick is ever reused
//     without re-showing the picker.
//  2. If nothing remembered (or the remembered folder no longer resolves
//     -- deleted/moved), do a live fuzzy search. A confident result
//     (name AND phone both match) is used immediately AND saved to the
//     sidecar so the next lookup skips straight to step 1.
//  3. Anything less than confident comes back as `candidates` for the
//     client to show a picker (see confirmMatch.js) instead of guessing.
const { withDrive } = require('../../lib/apiAuth');
const {
  ensureAppFolder, ensureContractsRootFolder, readJsonFile, writeJsonFile,
  buildContractMatchKey, findContractFolderMatches, listAllFilesInFolder, getFileMetadata
} = require('../../lib/googleDrive');

const SIDECAR_FILENAME = 'contract_docs.json';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function toFileSummary(f) {
  return { id: f.id, name: f.name, mimeType: f.mimeType };
}

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, error: 'Method not allowed.' });
    return;
  }
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const name = ((req.query && req.query.name) || url.searchParams.get('name') || '').toString().trim();
  const phone = ((req.query && req.query.phone) || url.searchParams.get('phone') || '').toString().trim();
  if (!name) {
    sendJson(res, 400, { success: false, error: 'Missing "name".' });
    return;
  }

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
    const matchKey = buildContractMatchKey(name, phone);

    const { data: sidecarRows } = await readJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME);
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
            });
            return;
          }
        } catch (e) {
          // Stale/deleted folder reference -- fall through to a live search.
        }
      }
    }

    const { confident, candidates } = await findContractFolderMatches(drive, contractsRootId, name, phone);
    if (confident) {
      const newRows = rows.filter((r) => r[0] !== matchKey);
      newRows.push([matchKey, JSON.stringify({ folderId: confident.id, folderName: confident.name })]);
      try { await writeJsonFile(drive, effectiveFolderId, SIDECAR_FILENAME, newRows, null); }
      catch (e) { /* best-effort remember -- a failed write here just means next load re-searches */ }

      const files = await listAllFilesInFolder(drive, confident.id);
      sendJson(res, 200, {
        success: true, matched: true, confident: true, remembered: false,
        folderId: confident.id, folderName: confident.name,
        files: files.map(toFileSummary)
      });
      return;
    }

    sendJson(res, 200, { success: true, matched: false, candidates });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
