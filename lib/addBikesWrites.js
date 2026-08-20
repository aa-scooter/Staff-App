// ---- Server-side add-bikes.html write layer -- Phase 2 port (same
// rollout this project has been doing page-by-page: bikes.html ->
// contract.html -> deposits.html -> add-bikes.html -> customers.html). See
// PROGRESS.md for the full inventory/decision trail.
//
// SCOPE: all 4 of add-bikes.html's write actions are ported here -- addBike,
// editBike, sellBike, unsellBike. The 3 read actions (bikeMakesModels,
// bikeDetails, bikeIncomeSummary) are NOT ported -- reads have no
// idempotency/atomicity concern, and per the deposits.html precedent, only
// writes move server-side. add-bikes.html's own client-side copies of those
// 3 reads are untouched.
//
// ARCHITECTURE NOTE -- why this does NOT get its own api/add-bikes/write.js:
// Vercel's Hobby plan caps a project at 12 serverless functions (see
// lib/depositsWrites.js's own header comment for the fuller history --
// this has already broken a deploy once before). The api/ directory is
// EXACTLY at 12 files. Rather than adding a 13th, this routes through the
// EXISTING api/bikes/write.js endpoint (see that file's own updated
// comment) -- a "bikes fleet management" action set is a natural enough
// pairing with bikes.html's own write endpoint, and the action names don't
// collide (bikes.html uses swapBike/markReturned/earlyReturnBike/
// returnDeposit/updateReturnPickup/extendBike/closeBikeForExtend/
// customerIntake; add-bikes.html uses addBike/editBike/sellBike/
// unsellBike). This file stays fully independent -- its own module, own
// action names, own idempotency markers -- only the physical ROUTING is
// shared, forced by the function-count ceiling, not a design preference.
//
// IDEMPOTENCY, decided per-action (mirrors contract.html's/deposits.html's
// own per-action reasoning in their own lib/*Writes.js header comments):
//   - 'addBike': clientTxnId guard. Inserts a brand-new row into
//     Parts_and_Oil_change (the master bike list every dropdown in the app
//     is built from) -- addBikeFromJson already has its OWN duplicate-name
//     guard (throws if a bike with that exact name already exists), so a
//     naive retry after a dropped-connection success would never actually
//     create a second bike -- but it WOULD throw a confusing "already
//     exists" error on an automatic background resubmit (restoreUnresolvedSaves
//     after a page crash/reload) even though the original request already
//     succeeded. Same "retry trap" bug CLASS as contract.html's
//     cancelContract (fixed earlier this session) -- closed proactively
//     here instead of reactively. Marker lives on a new
//     `Parts_and_Oil_change_notes` sidecar, column
//     ADD_BIKE_IDEMPOTENCY_COL_B=90 (same [row, col, clientTxnId] shape as
//     every other guard in this project), keyed to the newly-inserted row.
//   - 'editBike': NO guard -- unconditionally overwrites the same cells
//     with the same values every time, so a retry converges to the same
//     end state (same reasoning as contract.html's editContract /
//     deposits.html's editDeposit).
//   - 'sellBike': clientTxnId idempotent-replay guard. Without one, a
//     retry after an already-successful sell would hit sellBikeFromJson's
//     OWN "already appears to be marked sold" guard and throw -- again the
//     retry-trap class, not a double-charge (the "total" column bump only
//     ever happens once, gated behind that same throw). Fixed here by
//     recording `soldByTxnId` inside the SAME per-bike-name JSON note
//     `readBikeSoldNoteFromJson`/`writeBikeSoldNoteFromJson` already
//     read/write (see their own comment) -- a retry with a MATCHING
//     clientTxnId returns the original success response directly instead
//     of re-checking/re-throwing; a genuinely different sale attempt on an
//     already-sold bike still throws exactly as before.
//   - 'unsellBike': clientTxnId idempotent-replay guard, same reasoning as
//     sellBike but the reverse direction -- a retry after an already-
//     successful unsell would hit unsellBikeFromJson's "doesn't have a
//     valid recorded sale to reverse" guard and throw. Fixed by leaving a
//     TOMBSTONE note behind after a successful unsell (`unsoldByTxnId` +
//     the `reversedAmount` that was actually reversed) instead of wiping
//     the note back to null outright -- a retry with a matching
//     clientTxnId returns that same reversedAmount directly. The tombstone
//     has neither `soldAmount` nor `reason` set, so every OTHER reader of
//     this note (getBikeIncomeSummaryFromJson's `isSold` check, sellBike's
//     own "already sold" check) still correctly sees the bike as not sold. ----
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Identical to lib/bikesWrites.js's/lib/depositsWrites.js's own
// createSheetIO -- see either file's own comment for the full "why"
// (mirrors api/data/[sheet].js's resolveYearFolderId + filename logic
// exactly, so a sheet written here and one written through the existing
// /api/data/<sheet> route always land on the same file). Not shared via a
// common module -- this project's explicit per-file convention. ----
function createSheetIO(drive, appFolderId, session) {
  async function resolveFolderAndFilename(sheetName, year) {
    if (!year) return { folderId: appFolderId, filename: `${sheetName}.json` };
    const yearStr = String(year);
    let yearFolderId = session && session.driveYearFolders && session.driveYearFolders[yearStr];
    if (!yearFolderId) {
      yearFolderId = await ensureYearFolder(drive, appFolderId, yearStr);
      if (session) {
        session.driveYearFolders = session.driveYearFolders || {};
        session.driveYearFolders[yearStr] = yearFolderId;
      }
    }
    return { folderId: yearFolderId, filename: `${sheetName}_${yearStr}.json` };
  }

  async function fetchSheetWithMeta(sheetName, year) {
    const { folderId, filename } = await resolveFolderAndFilename(sheetName, year);
    const { data, modifiedTime } = await readJsonFile(drive, folderId, filename, session);
    return { rows: data || [], modifiedTime: modifiedTime || null };
  }

  async function writeSheetJson(sheetName, rows, expectedModifiedTime, year) {
    const { folderId, filename } = await resolveFolderAndFilename(sheetName, year);
    const { modifiedTime } = await writeJsonFile(drive, folderId, filename, rows, expectedModifiedTime || null, false, session);
    return { modifiedTime };
  }

  return { fetchSheetWithMeta, writeSheetJson };
}

function createAddBikesWrites(sheetIO) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- Small date/format utilities -- verbatim port of add-bikes.html's
  // own copies. ----
  function pad2Json(n) { return String(n).padStart(2, '0'); }
  function decodeSheetDate(val) {
    if (val === null || val === undefined) return null;
    if (typeof val !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const m = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      const m = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    }
    return null;
  }
  function isoYmd(date) {
    if (!date) return '';
    return date.getFullYear() + '-' + pad2Json(date.getMonth() + 1) + '-' + pad2Json(date.getDate());
  }
  function isoDateInputToSheetValue(isoDate) {
    const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  }
  function todayDmyJson() {
    const d = new Date();
    return pad2Json(d.getDate()) + '/' + pad2Json(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  // ---- Bike-name matching (strict identity check) -- verbatim port of
  // add-bikes.html's own copies, mirrors Code.gs's bikeNamesAreIdentical. ----
  function normalizeBikeNameForTaxLookup(s) {
    return (s || '').toString().toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  function normalizeBikeNameCore(s) {
    let t = (s || '').toString().toLowerCase();
    t = t.replace(/\(\s*\d{2,4}\s*cc?\s*\)/gi, ' ');
    t = t.replace(/\b\d{2,4}\s?cc\b/gi, ' ');
    t = t.replace(/[()]/g, ' ');
    t = t.replace(/\b(yamaha|honda|gpx)\b/gi, ' ');
    t = t.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    return t;
  }
  function bikeNamesAreIdenticalJson(a, b) {
    const na = normalizeBikeNameForTaxLookup(a);
    const nb = normalizeBikeNameForTaxLookup(b);
    if (na && nb && na === nb) return true;
    const ca = normalizeBikeNameCore(a), cb = normalizeBikeNameCore(b);
    return !!(ca && cb && ca === cb);
  }

  // ---- Generic bike-list helpers -- verbatim port of add-bikes.html's own
  // copies, mirroring Code.gs's findLastBikeRow / findBikeRowByName /
  // findRowByExactLabel, adapted to a flat 2D rows array with 0-based
  // row/column indices (row 0 = header). ----
  function findLastBikeRowIdxJson(rows2D, colIdx, stopKeywords, startRowIdx) {
    startRowIdx = startRowIdx === undefined ? 1 : startRowIdx;
    const stopSet = (stopKeywords || []).map(k => k.toString().trim().toLowerCase());
    let lastIdx = startRowIdx - 1;
    for (let i = startRowIdx; i < rows2D.length; i++) {
      const cell = (rows2D[i][colIdx] || '').toString().trim();
      if (!cell) break;
      if (stopSet.indexOf(cell.toLowerCase()) !== -1) break;
      lastIdx = i;
    }
    return lastIdx;
  }
  function findBikeRowIdxByNameJson(rows2D, colIdx, bikeName, stopKeywords, startRowIdx) {
    startRowIdx = startRowIdx === undefined ? 1 : startRowIdx;
    const lastIdx = findLastBikeRowIdxJson(rows2D, colIdx, stopKeywords, startRowIdx);
    if (lastIdx < startRowIdx) return -1;
    for (let i = startRowIdx; i <= lastIdx; i++) {
      const cell = (rows2D[i][colIdx] || '').toString().trim();
      if (cell && bikeNamesAreIdenticalJson(cell, bikeName)) return i;
    }
    return -1;
  }
  function findAlphaInsertIdxJson(rows2D, colIdx, stopKeywords, newName, startRowIdx) {
    startRowIdx = startRowIdx === undefined ? 1 : startRowIdx;
    const lastIdx = findLastBikeRowIdxJson(rows2D, colIdx, stopKeywords, startRowIdx);
    if (lastIdx < startRowIdx) return startRowIdx;
    const lowerNew = (newName || '').toString().trim().toLowerCase();
    for (let i = startRowIdx; i <= lastIdx; i++) {
      const cell = (rows2D[i][colIdx] || '').toString().trim().toLowerCase();
      if (cell && cell.localeCompare(lowerNew) > 0) return i;
    }
    return lastIdx + 1;
  }
  function findRowIdxByExactLabelJson(rows2D, colIdx, label, fromIdx, toIdx) {
    const target = label.toString().trim().toLowerCase();
    for (let i = fromIdx; i <= toIdx && i < rows2D.length; i++) {
      const cell = (rows2D[i][colIdx] || '').toString().trim().toLowerCase();
      if (cell === target) return i;
    }
    return -1;
  }
  function findHeaderColIdxJson(headerRow, exactLabel) {
    const target = exactLabel.toString().trim().toLowerCase();
    for (let c = 0; c < headerRow.length; c++) {
      const h = (headerRow[c] || '').toString().trim().toLowerCase();
      if (h === target) return c;
    }
    return -1;
  }
  function findOperationBikeColIdxJson(headerRow) {
    return findHeaderColIdxJson(headerRow, 'bike');
  }

  // ---- Idempotency marker helpers for 'addBike' -- same [row, col,
  // clientTxnId] technique as contract.html's/deposits.html's own guards
  // (see this file's header comment for why addBike specifically needs
  // one). Lives on a brand-new `Parts_and_Oil_change_notes` sidecar --
  // nothing else in this project writes to that sidecar yet. ----
  const ADD_BIKE_IDEMPOTENCY_COL_B = 90;
  async function findExistingPartsNotesTxnMarkerFromJson(col, clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('Parts_and_Oil_change_notes'));
    } catch (e) {
      return null; // sidecar unreadable -- fail open, same convention as every other guard in this project
    }
    const hit = (noteRows || []).find(n => n[1] === col && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markPartsNotesTxnIdFromJson(col, row, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('Parts_and_Oil_change_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === row && n[1] === col));
      newNoteRows.push([row, col, clientTxnId]);
      await writeSheetJson('Parts_and_Oil_change_notes', newNoteRows, modifiedTime);
    } catch (e) {
      console.warn('[addBikesWrites] Could not record idempotency marker:', e.message);
      throw e;
    }
  }

  // ---- sold/write-off note helpers -- ported from add-bikes.html's own
  // readBikeSoldNoteFromJson/writeBikeSoldNoteFromJson (see that file's own
  // block comment on why this is keyed by bike NAME, not row number: every
  // page that needs to know "is this bike sold" sources its bike list from
  // a different sheet with different row numbers, so a name-keyed note is
  // the only thing every page can check without an extra fetch+match).
  // EXTENDED here (2026-08-17, this port) to also carry `soldByTxnId` /
  // `unsoldByTxnId` fields for sellBike's/unsellBike's own idempotent-
  // replay guards -- see this file's header comment. Both are additive,
  // optional fields; nothing else that reads this note (isSold checks
  // elsewhere) is affected by their presence. ----
  const BIKE_WRITE_OFF_REASONS_B = ['Stolen', 'Lost', 'Destroyed'];
  async function readBikeSoldNoteFromJson(bikeName) {
    let noteRows = [];
    try { noteRows = (await fetchSheetWithMeta('bikes_notes')).rows; } catch (e) { noteRows = []; }
    const entry = (noteRows || []).find(n => bikeNamesAreIdenticalJson(n[0], bikeName));
    if (!entry) return null;
    try { return JSON.parse(entry[1]); } catch (e) { return null; }
  }
  async function writeBikeSoldNoteFromJson(bikeName, parsedOrNull) {
    const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('bikes_notes');
    const filtered = (noteRows || []).filter(n => !bikeNamesAreIdenticalJson(n[0], bikeName));
    if (parsedOrNull) filtered.push([bikeName, JSON.stringify(parsedOrNull)]);
    await writeSheetJson('bikes_notes', filtered, modifiedTime);
  }

  // ---- action:'editBike' -> editBikeFromJson. Byte-for-byte port of
  // add-bikes.html's own copy -- see that file's own comment for the full
  // per-sheet reasoning (Parts and Oil change is the critical write;
  // Operation/bikes/Bike Tax are each independently wrapped and reported
  // back as `warning`). NO clientTxnId guard -- see this file's header
  // comment for why. ----
  async function editBikeFromJson(data) {
    const originalBikeName = (data.originalBike || '').toString().trim();
    const bikeName = (data.bike || '').toString().trim();
    if (!originalBikeName) throw new Error('Original bike name is missing -- cannot tell which bike to edit.');
    if (!bikeName) throw new Error('Bike name is required.');

    const { rows: partsRows, modifiedTime: partsModifiedTime } = await fetchSheetWithMeta('Parts_and_Oil_change');
    const lastPartsBikeRowIdx = findLastBikeRowIdxJson(partsRows, 0, []);
    if (lastPartsBikeRowIdx < 1) throw new Error('No bikes found on the "Parts and Oil change" tab.');

    let partsRowIdx = -1;
    for (let i = 1; i <= lastPartsBikeRowIdx; i++) {
      const existingName = (partsRows[i][0] || '').toString().trim();
      if (existingName && bikeNamesAreIdenticalJson(existingName, originalBikeName)) { partsRowIdx = i; break; }
    }
    if (partsRowIdx === -1) {
      throw new Error('"' + originalBikeName + '" was not found on the "Parts and Oil change" tab -- bike was NOT edited.');
    }

    if (!bikeNamesAreIdenticalJson(originalBikeName, bikeName)) {
      for (let j = 1; j <= lastPartsBikeRowIdx; j++) {
        const otherName = (partsRows[j][0] || '').toString().trim();
        if (otherName && j !== partsRowIdx && bikeNamesAreIdenticalJson(otherName, bikeName)) {
          throw new Error('A bike named "' + otherName + '" already exists -- pick a different name.');
        }
      }
    }

    const newPartsRows = partsRows.map(r => r.slice());
    newPartsRows[partsRowIdx][0] = bikeName;
    await writeSheetJson('Parts_and_Oil_change', newPartsRows, partsModifiedTime);

    const warnings = [];

    // PARALLELIZED 20/08/2026 -- see swapBikeFromJson in bikesWrites.js for
    // the full pattern writeup. Same flat fan-out as addBikeFromJson just
    // above: Operation/bikes/Bike_Tax each look the row up independently BY
    // originalBikeName (not by anything the Parts_and_Oil_change write
    // above computed), and each touches its own single Drive file, so
    // there's no data dependency between them -- only the critical
    // Parts_and_Oil_change write (the validation + rename that must happen
    // before anything else, and whose own duplicate-name check has to run
    // first) stays before this Promise.all.
    async function chainOperation() {
      try {
        const { rows: opRows, modifiedTime: opModifiedTime } = await fetchSheetWithMeta('Operation');
        const opHeaderRow = opRows[0] || [];
        const opBikeCol = findOperationBikeColIdxJson(opHeaderRow);
        if (opBikeCol === -1) throw new Error('Could not find a "Bike" column header.');
        const opRowIdx = findBikeRowIdxByNameJson(opRows, opBikeCol, originalBikeName, [], 1);
        if (opRowIdx === -1) throw new Error('"' + originalBikeName + '" was not found on this tab.');

        const newOpRows = opRows.map(r => r.slice());
        newOpRows[opRowIdx][opBikeCol] = bikeName;

        const kmCol = findHeaderColIdxJson(opHeaderRow, 'current km');
        const hasCurrentKm = !(data.currentKm === '' || data.currentKm === undefined || data.currentKm === null || isNaN(Number(data.currentKm)));
        if (kmCol !== -1 && hasCurrentKm) {
          newOpRows[opRowIdx][kmCol] = Number(data.currentKm);
        }
        await writeSheetJson('Operation', newOpRows, opModifiedTime);
      } catch (opErr) {
        warnings.push('"Operation": ' + opErr.message);
      }
    }

    async function chainBikesSheet() {
      try {
        const { rows: bikesRows, modifiedTime: bikesModifiedTime } = await fetchSheetWithMeta('bikes');
        const bikesHeaderRow = bikesRows[0] || [];
        const bikesStopWords = ['total', 'totals', 'extras', 'deposit'];
        const costCol = findHeaderColIdxJson(bikesHeaderRow, 'cost');
        const incomeRowIdx = findBikeRowIdxByNameJson(bikesRows, 0, originalBikeName, bikesStopWords, 1);
        if (incomeRowIdx === -1) throw new Error('"' + originalBikeName + '" was not found in the income list.');

        const newBikesRows = bikesRows.map(r => r.slice());
        newBikesRows[incomeRowIdx][0] = bikeName;
        const hasCost = !(data.cost === '' || data.cost === undefined || data.cost === null || isNaN(Number(data.cost)));
        if (costCol !== -1 && hasCost) {
          newBikesRows[incomeRowIdx][costCol] = Number(data.cost);
        }

        let expensesWarning = null;
        const expensesHeaderRowIdx = findRowIdxByExactLabelJson(newBikesRows, 0, 'expenses', 0, newBikesRows.length - 1);
        if (expensesHeaderRowIdx !== -1) {
          const expensesRowIdx = findBikeRowIdxByNameJson(newBikesRows, 0, originalBikeName, bikesStopWords, expensesHeaderRowIdx + 1);
          if (expensesRowIdx !== -1) {
            newBikesRows[expensesRowIdx][0] = bikeName;
          } else {
            expensesWarning = '"bikes": "' + originalBikeName + '" was not found in the Expenses list -- its name there was NOT updated.';
          }
        }

        await writeSheetJson('bikes', newBikesRows, bikesModifiedTime);
        if (expensesWarning) warnings.push(expensesWarning);
      } catch (bikesErr) {
        warnings.push('"bikes": ' + bikesErr.message);
      }
    }

    async function chainBikeTax() {
      try {
        const { rows: taxRows, modifiedTime: taxModifiedTime } = await fetchSheetWithMeta('Bike_Tax');
        const taxRowIdx = findBikeRowIdxByNameJson(taxRows, 1, originalBikeName, [], 1);
        if (taxRowIdx === -1) throw new Error('"' + originalBikeName + '" was not found on this tab.');

        const hasModelYear = !(data.modelYear === '' || data.modelYear === undefined || data.modelYear === null || isNaN(Number(data.modelYear)));
        const hasDeposit = !(data.deposit === '' || data.deposit === undefined || data.deposit === null || isNaN(Number(data.deposit)));
        const porRorBorValue = data.porRorBorDate ? (isoDateInputToSheetValue(data.porRorBorDate) || '') : '';

        const newTaxRows = taxRows.map(r => r.slice());
        const row = newTaxRows[taxRowIdx];
        row[1] = bikeName;
        row[2] = hasModelYear ? Number(data.modelYear) : '';
        row[3] = data.plateNo || '';
        row[4] = porRorBorValue;
        row[9] = data.insurance || '';
        row[10] = data.category || '';
        row[11] = data.make || '';
        row[12] = data.model || '';
        row[13] = data.cc || '';
        row[14] = data.key || '';
        row[15] = data.abs || '';
        row[16] = data.tractionControl || '';
        row[17] = hasDeposit ? Number(data.deposit) : '';
        row[18] = data.box || '';

        await writeSheetJson('Bike_Tax', newTaxRows, taxModifiedTime);
      } catch (taxErr) {
        warnings.push('"Bike Tax": ' + taxErr.message);
      }
    }

    await Promise.all([chainOperation(), chainBikesSheet(), chainBikeTax()]);

    const responsePayload = { success: true, bike: bikeName };
    if (warnings.length) {
      responsePayload.warning = 'Bike updated, but: ' + warnings.join(' ');
    }
    return responsePayload;
  }

  // ---- action:'sellBike' -> sellBikeFromJson. Ported from add-bikes.html's
  // own copy, PLUS a clientTxnId idempotent-replay guard (see file header
  // comment for why). data: { bike, sellAmount, clientTxnId } for a normal
  // sale, or { bike, reason, clientTxnId } (Stolen/Lost/Destroyed) for a
  // write-off -- mutually exclusive, same as Code.gs. ----
  async function sellBikeFromJson(data) {
    const bikeName = (data.bike || '').toString().trim();
    if (!bikeName) throw new Error('Bike name is required.');
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;

    const rawReason = (data.reason || '').toString().trim();
    const reason = rawReason
      ? BIKE_WRITE_OFF_REASONS_B.filter(r => r.toLowerCase() === rawReason.toLowerCase())[0]
      : '';
    if (rawReason && !reason) {
      throw new Error('Unrecognized write-off reason "' + rawReason + '" -- must be Stolen, Lost, or Destroyed.');
    }
    let sellAmount = 0;
    if (!reason) {
      sellAmount = Number(data.sellAmount);
      if (isNaN(sellAmount) || sellAmount <= 0) throw new Error('Enter a valid sell amount.');
    }

    const bikesStopWords = ['total', 'totals', 'extras', 'deposit'];
    const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
    const incomeRowIdx = findBikeRowIdxByNameJson(rows, 0, bikeName, bikesStopWords, 1);
    if (incomeRowIdx === -1) {
      throw new Error('Bike "' + bikeName + '" not found on the "bikes" income list -- bike was NOT marked sold.');
    }
    const existing = await readBikeSoldNoteFromJson(bikeName);
    if (existing && clientTxnId && existing.soldByTxnId === clientTxnId) {
      // Idempotent replay -- this exact request already succeeded (e.g. a
      // crash/nav recovery resubmit). Return the same success shape without
      // touching the total column or note again.
      return { success: true };
    }
    if (existing && (existing.soldAmount || existing.reason)) {
      throw new Error('"' + bikeName + '" already appears to be marked sold (' +
        (existing.reason || Number(existing.soldAmount).toLocaleString('en-US')) +
        ') -- unsell it first if this is a mistake.');
    }

    if (!reason) {
      const headerRow = rows[0] || [];
      const totalCol = findHeaderColIdxJson(headerRow, 'total');
      if (totalCol === -1) throw new Error('Could not find a "total" column header on the "bikes" sheet -- bike was NOT marked sold.');
      const newRows = rows.map(r => r.slice());
      const targetRow = newRows[incomeRowIdx].slice();
      while (targetRow.length <= totalCol) targetRow.push('');
      const current = Number(targetRow[totalCol]);
      targetRow[totalCol] = (isNaN(current) ? 0 : current) + sellAmount;
      newRows[incomeRowIdx] = targetRow;
      await writeSheetJson('bikes', newRows, modifiedTime);
    }

    const soldNote = { soldAmount: sellAmount, soldDate: todayDmyJson(), reason: reason || null };
    if (clientTxnId) soldNote.soldByTxnId = clientTxnId;
    await writeBikeSoldNoteFromJson(bikeName, soldNote);

    return { success: true };
  }

  // ---- action:'unsellBike' -> unsellBikeFromJson. Ported from
  // add-bikes.html's own copy, PLUS a clientTxnId idempotent-replay guard
  // (see file header comment for why -- leaves a tombstone note behind
  // instead of clearing to null outright). Exact inverse of
  // sellBikeFromJson: reads the recorded sale/write-off back off the notes
  // sidecar, reverses the total column, and replaces the note with a
  // tombstone. ----
  async function unsellBikeFromJson(data) {
    const bikeName = (data.bike || '').toString().trim();
    if (!bikeName) throw new Error('Bike name is required.');
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;

    const bikesStopWords = ['total', 'totals', 'extras', 'deposit'];
    const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
    const incomeRowIdx = findBikeRowIdxByNameJson(rows, 0, bikeName, bikesStopWords, 1);
    if (incomeRowIdx === -1) {
      throw new Error('Bike "' + bikeName + '" not found on the "bikes" income list -- nothing was changed.');
    }
    const parsed = await readBikeSoldNoteFromJson(bikeName);
    if (parsed && clientTxnId && parsed.unsoldByTxnId === clientTxnId) {
      // Idempotent replay -- this exact unsell already succeeded.
      return { success: true, reversedAmount: parsed.reversedAmount || 0 };
    }
    const hasValidAmount = !!(parsed && !isNaN(Number(parsed.soldAmount)) && Number(parsed.soldAmount) > 0);
    const hasValidReason = !!(parsed && parsed.reason);
    if (!parsed || (!hasValidAmount && !hasValidReason)) {
      throw new Error('"' + bikeName + '" doesn\'t have a valid recorded sale (or write-off) to reverse -- nothing was changed. Fix this by hand on the "bikes" sheet if it really was sold.');
    }
    const soldAmount = hasValidAmount ? Number(parsed.soldAmount) : 0;

    if (soldAmount > 0) {
      const headerRow = rows[0] || [];
      const totalCol = findHeaderColIdxJson(headerRow, 'total');
      if (totalCol === -1) throw new Error('Could not find a "total" column header on the "bikes" sheet -- nothing was changed.');
      const newRows = rows.map(r => r.slice());
      const targetRow = newRows[incomeRowIdx].slice();
      while (targetRow.length <= totalCol) targetRow.push('');
      const current = Number(targetRow[totalCol]);
      targetRow[totalCol] = (isNaN(current) ? 0 : current) - soldAmount;
      newRows[incomeRowIdx] = targetRow;
      await writeSheetJson('bikes', newRows, modifiedTime);
    }

    // Tombstone, not a hard clear -- keeps `unsoldByTxnId`/`reversedAmount`
    // around so a retry of THIS exact request can be recognized (see file
    // header comment). Has neither soldAmount nor reason, so every reader
    // that checks `soldAmount || reason` (isSold, sellBike's own guard)
    // still correctly treats this bike as not sold.
    const tombstone = clientTxnId ? { soldAmount: null, soldDate: null, reason: null, unsoldByTxnId: clientTxnId, reversedAmount: soldAmount } : null;
    await writeBikeSoldNoteFromJson(bikeName, tombstone);

    return { success: true, reversedAmount: soldAmount };
  }

  // ---- action:'addBike' -> addBikeFromJson. Ported from add-bikes.html's
  // own copy, PLUS a clientTxnId idempotency guard (see file header
  // comment for why). Creates a brand-new bike across every tab that
  // keeps its own bike list, INSERTING a new row (alphabetically) instead
  // of overwriting an existing one. Parts and Oil change is the write this
  // can't function without; Operation/bikes/Bike Tax are each wrapped
  // independently and reported back as `warning`.
  //
  // KNOWN GAP (unchanged from add-bikes.html's own client-side version):
  // Bike Tax's Status (G) and day-count (H) columns are LIVE FORMULAS in
  // the real sheet with no equivalent here -- left genuinely blank,
  // surfaced as an explicit warning on every add. ----
  async function addBikeFromJson(data) {
    const bikeName = (data.bike || '').toString().trim();
    if (!bikeName) throw new Error('Bike name is required.');
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;

    if (clientTxnId) {
      const existingRow = await findExistingPartsNotesTxnMarkerFromJson(ADD_BIKE_IDEMPOTENCY_COL_B, clientTxnId);
      if (existingRow) return { success: true, bike: bikeName, idempotentReplay: true };
    }

    const { rows: partsRows, modifiedTime: partsModifiedTime } = await fetchSheetWithMeta('Parts_and_Oil_change');
    const lastPartsIdx = findLastBikeRowIdxJson(partsRows, 0, []);
    for (let i = 1; i <= lastPartsIdx; i++) {
      const existingName = (partsRows[i][0] || '').toString().trim();
      if (existingName && bikeNamesAreIdenticalJson(existingName, bikeName)) {
        throw new Error('A bike named "' + existingName + '" already exists on the "Parts and Oil change" tab -- pick a different name, or edit the existing bike instead of adding a new one.');
      }
    }
    const partsColCount = Math.max(1, (partsRows[0] || []).length);
    const partsInsertIdx = findAlphaInsertIdxJson(partsRows, 0, [], bikeName, 1);
    const newPartsRows = partsRows.map(r => r.slice());
    const partsNewRow = new Array(partsColCount).fill('');
    partsNewRow[0] = bikeName;
    newPartsRows.splice(partsInsertIdx, 0, partsNewRow);
    await writeSheetJson('Parts_and_Oil_change', newPartsRows, partsModifiedTime);

    // targetRow (1-based sheet row number) for the idempotency marker --
    // matches the splice index directly (row 0 = header = sheet row 1, so
    // array index N = sheet row N+1... but every other guard in this
    // project keys by whatever row number scheme its own sidecar uses
    // consistently; here it's simplest to just use the splice index
    // itself, since findExistingPartsNotesTxnMarkerFromJson only ever
        // compares clientTxnId, never the row number back to the caller.
    const insertedRowMarker = partsInsertIdx;

    const warnings = [];

    // PARALLELIZED 20/08/2026 -- see swapBikeFromJson in bikesWrites.js for
    // the full pattern writeup this follows. Simpler here than the
    // customerIntake-shaped functions: these four steps have no data
    // dependency on each other at all (nothing computed by one feeds
    // another), and each touches its own single Drive file --
    // 'Operation', 'bikes', 'Bike_Tax', and the idempotency marker's own
    // 'Parts_and_Oil_change_notes' sidecar -- so this is a flat 4-way
    // fan-out, no chain needs to be internally sequential.
    async function chainOperation() {
      try {
        const { rows: opRows, modifiedTime: opModifiedTime } = await fetchSheetWithMeta('Operation');
        const opHeaderRow = opRows[0] || [];
        const opBikeCol = findOperationBikeColIdxJson(opHeaderRow);
        if (opBikeCol === -1) throw new Error('Could not find a "Bike" column header.');
        const hasCurrentKm = !(data.currentKm === '' || data.currentKm === undefined || data.currentKm === null || isNaN(Number(data.currentKm)));
        const currentKm = hasCurrentKm ? Number(data.currentKm) : '';
        const kmCol = findHeaderColIdxJson(opHeaderRow, 'current km');
        const dateCheckCol = findHeaderColIdxJson(opHeaderRow, 'date check current km');
        const lastOilCol = findHeaderColIdxJson(opHeaderRow, 'last oil km');
        const statusCol = findHeaderColIdxJson(opHeaderRow, 'rental status');
        const opColCount = Math.max(1, opHeaderRow.length);
        const opInsertIdx = findAlphaInsertIdxJson(opRows, opBikeCol, [], bikeName, 1);
        const newOpRows = opRows.map(r => r.slice());
        const newOpRow = new Array(opColCount).fill('');
        newOpRow[opBikeCol] = bikeName;
        if (kmCol !== -1) newOpRow[kmCol] = currentKm;
        if (dateCheckCol !== -1 && hasCurrentKm) newOpRow[dateCheckCol] = isoDateInputToSheetValue(isoYmd(new Date()));
        if (lastOilCol !== -1) newOpRow[lastOilCol] = currentKm;
        if (statusCol !== -1) newOpRow[statusCol] = 'Home';
        newOpRows.splice(opInsertIdx, 0, newOpRow);
        await writeSheetJson('Operation', newOpRows, opModifiedTime);
      } catch (opErr) {
        warnings.push('"Operation": ' + opErr.message);
      }
    }

    async function chainBikesSheet() {
      try {
        const { rows: bikesRows, modifiedTime: bikesModifiedTime } = await fetchSheetWithMeta('bikes');
        const bikesHeaderRow = bikesRows[0] || [];
        const bikesStopWords = ['total', 'totals', 'extras', 'deposit'];
        const costCol = findHeaderColIdxJson(bikesHeaderRow, 'cost');
        const totalCol = findHeaderColIdxJson(bikesHeaderRow, 'total');
        const expensesCol = findHeaderColIdxJson(bikesHeaderRow, 'expenses');
        const profitCol = findHeaderColIdxJson(bikesHeaderRow, 'profit');
        const netProfitCol = findHeaderColIdxJson(bikesHeaderRow, 'net profit');
        const hasCost = !(data.cost === '' || data.cost === undefined || data.cost === null || isNaN(Number(data.cost)));
        const bikesColCount = Math.max(1, bikesHeaderRow.length);

        const incomeInsertIdx = findAlphaInsertIdxJson(bikesRows, 0, bikesStopWords, bikeName, 1);
        const newBikesRows = bikesRows.map(r => r.slice());
        const incomeRow = new Array(bikesColCount).fill('');
        incomeRow[0] = bikeName;
        if (costCol !== -1 && hasCost) incomeRow[costCol] = Number(data.cost);
        if (totalCol !== -1) incomeRow[totalCol] = 0;
        if (expensesCol !== -1) incomeRow[expensesCol] = 0;
        if (profitCol !== -1) incomeRow[profitCol] = 0;
        if (netProfitCol !== -1) incomeRow[netProfitCol] = hasCost ? -Number(data.cost) : 0;
        newBikesRows.splice(incomeInsertIdx, 0, incomeRow);

        let expensesWarning = null;
        const expensesHeaderIdx = findRowIdxByExactLabelJson(newBikesRows, 0, 'expenses', 0, newBikesRows.length - 1);
        if (expensesHeaderIdx === -1) {
          expensesWarning = 'Could not find a cell that says exactly "Expenses" in column A -- bike was added to the income list, but NOT to the Expenses list, so its expense total will be missing until that\'s done by hand.';
        } else {
          const expensesInsertIdx = findAlphaInsertIdxJson(newBikesRows, 0, bikesStopWords, bikeName, expensesHeaderIdx + 1);
          const expensesRow = new Array(bikesColCount).fill('');
          expensesRow[0] = bikeName;
          if (totalCol !== -1) expensesRow[totalCol] = 0;
          newBikesRows.splice(expensesInsertIdx, 0, expensesRow);
          if (expensesCol !== -1) newBikesRows[incomeInsertIdx][expensesCol] = 0;
        }

        await writeSheetJson('bikes', newBikesRows, bikesModifiedTime);
        if (expensesWarning) warnings.push('"bikes": ' + expensesWarning);
      } catch (bikesErr) {
        warnings.push('"bikes": ' + bikesErr.message);
      }
    }

    async function chainBikeTax() {
      try {
        const { rows: taxRows, modifiedTime: taxModifiedTime } = await fetchSheetWithMeta('Bike_Tax');
        const taxColCount = Math.max(19, (taxRows[0] || []).length);
        const hasModelYear = !(data.modelYear === '' || data.modelYear === undefined || data.modelYear === null || isNaN(Number(data.modelYear)));
        const hasDeposit = !(data.deposit === '' || data.deposit === undefined || data.deposit === null || isNaN(Number(data.deposit)));
        const porRorBorValue = data.porRorBorDate ? (isoDateInputToSheetValue(data.porRorBorDate) || '') : '';

        const taxInsertIdx = findAlphaInsertIdxJson(taxRows, 1, [], bikeName, 1);
        const newTaxRow = new Array(taxColCount).fill('');
        newTaxRow[1] = bikeName;
        newTaxRow[2] = hasModelYear ? Number(data.modelYear) : '';
        newTaxRow[3] = data.plateNo || '';
        newTaxRow[4] = porRorBorValue;
        newTaxRow[5] = '-';
        newTaxRow[9] = data.insurance || '';
        newTaxRow[10] = data.category || '';
        newTaxRow[11] = data.make || '';
        newTaxRow[12] = data.model || '';
        newTaxRow[13] = data.cc || '';
        newTaxRow[14] = data.key || '';
        newTaxRow[15] = data.abs || '';
        newTaxRow[16] = data.tractionControl || '';
        newTaxRow[17] = hasDeposit ? Number(data.deposit) : '';
        newTaxRow[18] = data.box || '';

        const newTaxRows = taxRows.map(r => r.slice());
        newTaxRows.splice(taxInsertIdx, 0, newTaxRow);

        const lastTaxIdx = findLastBikeRowIdxJson(newTaxRows, 1, [], 1);
        for (let i = 1, n = 1; i <= lastTaxIdx; i++, n++) {
          const r = newTaxRows[i].slice();
          r[0] = n;
          newTaxRows[i] = r;
        }

        await writeSheetJson('Bike_Tax', newTaxRows, taxModifiedTime);
        warnings.push('"Bike Tax": the Status and day-count columns (G/H) are formulas in the live sheet with no equivalent here -- they were left blank for this new row. Recompute or fill them in by hand if this bike\'s tax/insurance status needs to show correctly before this data is next synced from a live Sheet.');
      } catch (taxErr) {
        warnings.push('"Bike Tax": ' + taxErr.message);
      }
    }

    async function chainMarker() {
      if (clientTxnId) {
        try { await markPartsNotesTxnIdFromJson(ADD_BIKE_IDEMPOTENCY_COL_B, insertedRowMarker, clientTxnId); }
        catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could show a confusing "already exists" error even though the bike was added successfully.'); }
      }
    }

    await Promise.all([chainOperation(), chainBikesSheet(), chainBikeTax(), chainMarker()]);

    const responsePayload = { success: true, bike: bikeName };
    if (warnings.length) {
      responsePayload.warning = 'Bike added, but: ' + warnings.join(' ');
    }
    return responsePayload;
  }

  // ---- Single-dispatch entry point, mirrors bikesWriteDispatch's/
  // depositsWriteDispatch's shape. ----
  async function addBikesWriteDispatch(body) {
    switch (body && body.action) {
      case 'addBike':
        return addBikeFromJson(body);
      case 'editBike':
        return editBikeFromJson(body);
      case 'sellBike':
        return sellBikeFromJson(body);
      case 'unsellBike':
        return unsellBikeFromJson(body);
      default:
        throw new Error(
          'Unknown or not-yet-ported add-bikes.html write action: "' + (body && body.action) + '". ' +
          'Ported so far: addBike, editBike, sellBike, unsellBike.'
        );
    }
  }

  return {
    addBikesWriteDispatch,
    addBikeFromJson,
    editBikeFromJson,
    sellBikeFromJson,
    unsellBikeFromJson
  };
}

module.exports = { createSheetIO, createAddBikesWrites };
