// ---- Server-side contract.html write layer -- Phase 2 of the optimistic/
// idempotent-save rollout (see PROGRESS.md's "Phase 2, contract.html write
// layer: INVENTORY/DESIGN DONE" entry for the full plan and the traced
// action inventory).
//
// SCOPE: only 4 of contract.html's write-shaped functions are genuinely
// JSON-backed Drive writes (the only kind this file ports): 'addContract',
// 'editContract', 'cancelContract', and 'customerIntake' (the same
// customer-intake write bikes.html's long-extend and customers.html's Add
// form use, duplicated here per this project's per-file convention).
// Contract.html has several OTHER write-shaped functions
// (regenerateContract, findContractDocument, generateReceipt,
// getFilesForShare, findChecklistDocument, generateChecklist) that all hit
// `fetch(scriptUrl, ...)` where scriptUrl is a literal empty string --
// Google Docs/PDF-template document-generation features that were never
// part of the Drive-JSON migration and are a fundamentally different kind
// of work. DELIBERATELY NOT PORTED HERE, same as bikes.html's calendar
// sync was ruled out of scope for that page -- see the PROGRESS.md
// inventory entry for the full reasoning.
//
// STATUS (2026-08-17): all 4 in-scope actions ported.
//
// contract.html's OWN client-side script is completely UNCHANGED and
// UNAWARE this file exists -- nothing here is wired into the live page
// yet. This file and api/contract/write.js are net-new, unreferenced by
// anything else, so their mere existence changes nothing about how
// contract.html behaves today.
//
// This is a byte-for-byte port of contract.html's own client-side write
// functions, SAME business rules, SAME edge cases, SAME warnings --
// ported mechanically, not redesigned, with the same two differences
// from the browser version documented in lib/bikesWrites.js's own header
// comment (sheetIO instead of fetch('/api/data/...'), logTransactionB
// awaited synchronously). ONE wrinkle addContractFromJson has that no
// bikes.html action did: a best-effort passport-photo upload POSTed to
// /api/contracts/upload (a real, already-connected endpoint, NOT a
// scriptUrl legacy path) after the Contract row itself saves. That upload
// takes a base64 image payload unrelated to the sheetIO/Drive-JSON write
// path, so it stays a CLIENT-SIDE follow-up step (same shape as
// bikes.html's returnDeposit follow-up after markReturned) rather than
// being folded into this server-side action -- addContractFromJson here
// only handles the Contract-sheet write + Deal note.
//
// IMPORTANT: contract.html's customerIntakeFromJson is NOT the same
// version as bikes.html's copy -- it's a newer design (dated 15/08/2026 in
// its own inline comments) where every helper it calls
// (appendMonthlyIncomeRowFromJson, appendCashSheetRowFromJson,
// addRentalAmountToBikesSheetFromJson, processDepositForPaymentFromJson,
// logSecurityDepositFromJson, markMatchingContractAsRentedFromJson,
// syncContractRowTotalsFromJson) returns a {write: {...}} descriptor
// instead of independently calling logTransactionB, and
// customerIntakeFromJson collects them all into ONE combined,
// one-click-reversible transaction-log entry -- fixing a real bug where
// reversing a rental left the bike's Contract status stuck on "Rented"
// forever because that one write was never logged. This file ports THAT
// version, not bikes.html's.
//
// IDEMPOTENCY, decided per-action (see PROGRESS.md inventory entry):
//   - 'customerIntake': clientTxnId guard, same marker technique as
//     bikes.html's (customer_notes, column IDEMPOTENCY_NOTE_COL_B=3) --
//     doRent()'s own client-side comment describes a REAL double-booking
//     Anton hit from exactly this kind of dropped-connection retry.
//   - 'addContract': clientTxnId guard too -- also always appends a brand
//     new Contract row, same double-submit risk class as customerIntake/
//     swapBike. Marker lives on Contract_notes (a SEPARATE sidecar from
//     customer_notes), column CONTRACT_IDEMPOTENCY_NOTE_COL_B=3 -- chosen
//     to not collide with column 2, already used there for the Deal flag.
//   - 'editContract': NO guard -- unconditionally overwrites the same 16+11
//     columns with the same values every time, so a retry converges to the
//     same end state (same reasoning as bikes.html's updateReturnPickup).
//   - 'cancelContract': no clientTxnId marker sidecar (still judged not
//     worth a third one for this pass), but as of 2026-08-17 it DOES
//     short-circuit to a no-op success if the row is ALREADY "Canceled" --
//     see cancelContractFromJson below. Originally this threw on ANY
//     non-Pending status, on the reasoning that the worst case was "just a
//     confusing error message on retry, not a duplicate row or double-
//     charge" -- true as far as it went, but live use on contract.html's
//     save-pipeline engine rewiring surfaced the actual UX failure mode
//     that reasoning missed: restoreUnresolvedSaves() resubmitting a
//     leftover localStorage entry (e.g. after a page reload mid-flight,
//     same class of event bikes.html's own crash/nav recovery exists for)
//     lands on an already-succeeded cancel, throws this same error, and
//     the record permanently sits in the failed-saves review panel with a
//     Retry button that can NEVER succeed -- since the row genuinely is
//     already Canceled, every retry re-throws the identical error forever.
//     Fix: if currentStatus is already 'canceled', treat it as the
//     idempotent no-op it actually is (return success) instead of
//     throwing. Still throws for any OTHER non-Pending status (e.g.
//     "Rented") -- that case is a real conflict (the record was actioned
//     DIFFERENTLY than this cancel intended) and should still surface.
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Identical to lib/bikesWrites.js's createSheetIO (itself identical to
// lib/accountsWrites.js's) -- see that file's own comment for the full
// "why". Not shared via a common module -- this project's explicit
// per-file convention extends to this new server-side layer too. ----
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

// calendarCtx (added 18/08/2026, optional -- see lib/customersWrites.js's
// own createCustomersWrites comment for the full "why"/shape) is {drive,
// folderId, session} from the STAFF Drive session -- used to sync the 🏨
// delivery event whenever this file adds/edits/cancels a Contract row.
function createContractWrites(sheetIO, calendarCtx) {
  // Wrapped so a calendar problem never blocks the contract write it's
  // piggybacking on, exactly Code.gs's own posture. Returns null (skip
  // quietly) if calendar isn't connected/configured or calendarCtx wasn't
  // passed at all (old call sites/tests).
  async function getCalendarClient() {
    if (!calendarCtx || !calendarCtx.drive) return null;
    try {
      const { calendarClientFromStoredAuth } = require('./googleCalendarAuth');
      const calAuth = await calendarClientFromStoredAuth(calendarCtx.drive, calendarCtx.folderId, calendarCtx.session);
      return calAuth ? calAuth.calendar : null;
    } catch (err) {
      console.warn('[contractWrites] calendar context unavailable (non-blocking):', err && err.message);
      return null;
    }
  }
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- Transaction log -- verbatim port of contract.html's own copy
  // (lines 1424-1449 there), server-adapted the same way
  // lib/bikesWrites.js's logTransactionB was (sheetIO instead of
  // fetch('/api/data/...'), ConflictError instead of a raw 409 check).
  // Only ever called ONCE per request here (customerIntakeFromJson's
  // combined entry, awaited sequentially after every other write) --
  // never concurrently within one request, so no promise-queue
  // serialization needed, same reasoning as bikes.html's copy. ----
  async function logTransactionB(entry) {
    try {
      entry.id = 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      entry.ts = new Date().toISOString();
      entry.reversed = false;
      entry.reversedAt = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let rows, modifiedTime;
        try {
          const res = await fetchSheetWithMeta('transactionLog');
          rows = Array.isArray(res.rows) ? res.rows : [];
          modifiedTime = res.modifiedTime || null;
        } catch (e) { rows = []; modifiedTime = null; }
        const newRows = rows.concat([entry]);
        try {
          await writeSheetJson('transactionLog', newRows, modifiedTime);
          return;
        } catch (writeErr) {
          if (writeErr instanceof ConflictError || writeErr.isConflict) continue;
          throw writeErr;
        }
      }
    } catch (e) {
      console.warn('[contractWrites] Transaction log write failed (non-critical):', e && e.message);
    }
  }

  function fmtMoneyB(n) {
    const v = Number(n);
    return '฿' + (isNaN(v) ? '0' : v.toLocaleString('en-US'));
  }

  // ---- Small date/format utilities -- verbatim port of contract.html's
  // own copies. ----
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
  function pad2Json(n) { return String(n).padStart(2, '0'); }
  function formatDmyJson(date) {
    if (!date) return '';
    return pad2Json(date.getDate()) + '/' + pad2Json(date.getMonth() + 1) + '/' + date.getFullYear();
  }
  function isoDateInputToContractValue(isoDate) {
    const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  }
  // HTML time input gives "HH:MM" -- the sheet stores a bare "HH:MM:SS"
  // time-of-day string.
  function timeInputToContractValue(hhmm) {
    const m = String(hhmm || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!m) return '';
    return `${m[1]}:${m[2]}:00`;
  }
  function isoYmdNowB() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2Json(d.getMonth() + 1) + '-' + pad2Json(d.getDate());
  }

  // ---- Contract-sheet name/bike matching -- verbatim port of
  // contract.html's own copies. ----
  function normalizeNameForContractMatch(name) {
    return (name || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
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
  function bikeNamesMatchForTaxLookup(a, b) {
    const na = normalizeBikeNameForTaxLookup(a);
    const nb = normalizeBikeNameForTaxLookup(b);
    if (na && nb) {
      if (na === nb) return true;
      const paddedA = ' ' + na + ' ', paddedB = ' ' + nb + ' ';
      if (paddedA.indexOf(paddedB) !== -1 || paddedB.indexOf(paddedA) !== -1) return true;
    }
    const ca = normalizeBikeNameCore(a), cb = normalizeBikeNameCore(b);
    if (!ca || !cb) return false;
    if (ca === cb) return true;
    const paddedCa = ' ' + ca + ' ', paddedCb = ' ' + cb + ' ';
    return paddedCa.indexOf(paddedCb) !== -1 || paddedCb.indexOf(paddedCa) !== -1;
  }

  const HEADER_ROWS_B = 1;        // customer/Contract sheets: row 1 is the header
  const LEDGER_CONTACT_COL_B = 2; // column B -- ledger note (customer sheet) / Deal flag (Contract sheet)
  // NEW (server port only, same pattern as lib/bikesWrites.js): reserved
  // marker columns for the two idempotency guards this file adds.
  // customer_notes column 2 is already the ledger note; Contract_notes
  // column 2 is already the Deal flag -- both guards use column 3 on
  // their respective sidecar sheet instead, so neither collides with an
  // existing marker.
  const IDEMPOTENCY_NOTE_COL_B = 3;          // customer_notes -- customerIntake guard
  const CONTRACT_IDEMPOTENCY_NOTE_COL_B = 3; // Contract_notes -- addContract guard

  // ---- Ledger-note helpers -- verbatim port of contract.html's own
  // copies. ----
  function parseLedgerTotal(noteText) {
    const m = (noteText || '').toString().match(/Total:\s*([\d.]+)\s*days?,\s*฿\s*([\d,]+(?:\.\d+)?)\s*$/i);
    if (!m) return { days: 0, amount: 0 };
    return { days: Number(m[1]) || 0, amount: Number(m[2].replace(/,/g, '')) || 0 };
  }
  function stripLedgerTotalLineB(noteText) {
    return (noteText || '').toString().replace(/\n?Total:[^\n]*$/i, '').replace(/\n+$/, '');
  }
  function stripAllTrailingParensAndDealB(contact) {
    let result = (contact || '').toString().trim();
    let prev;
    do {
      prev = result;
      result = result.replace(/\s*\([^()]*\)(?:\s*Deal)?\s*$/i, '').replace(/\s*Deal\s*$/i, '').trim();
    } while (result !== prev);
    return result;
  }
  function formatMoneyForLedgerB(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function findFullyEmptyRowIdxJson(rows2D, startRowIdx, cols) {
    for (let i = startRowIdx; i < rows2D.length; i++) {
      const row = rows2D[i] || [];
      let allBlank = true;
      for (const c of cols) {
        const v = row[c - 1];
        if (v !== '' && v !== null && v !== undefined) { allBlank = false; break; }
      }
      if (allBlank) return i;
    }
    return rows2D.length;
  }
  function normalizeBikeNameForRentalLogB(s) {
    return (s || '').toString().toLowerCase().replace(/[()]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }
  const RENTAL_LOG_DISTINGUISHING_SUFFIXES_B = {
    one: 1, two: 1, three: 1, four: 1, five: 1, six: 1, seven: 1, eight: 1, nine: 1, ten: 1,
    i: 1, ii: 1, iii: 1, iv: 1, v: 1, vi: 1, vii: 1, viii: 1, ix: 1, x: 1,
    '1': 1, '2': 1, '3': 1, '4': 1, '5': 1, '6': 1, '7': 1, '8': 1, '9': 1, '10': 1
  };
  function bikeNamesMatchForRentalLogB(a, b) {
    const na = normalizeBikeNameForRentalLogB(a), nb = normalizeBikeNameForRentalLogB(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const ta = na.split(' '), tb = nb.split(' ');
    const shorter = ta.length <= tb.length ? ta : tb;
    const longer = ta.length <= tb.length ? tb : ta;
    let isPrefix = true;
    for (let i = 0; i < shorter.length; i++) { if (shorter[i] !== longer[i]) { isPrefix = false; break; } }
    if (isPrefix) {
      const extra = longer.slice(shorter.length);
      for (let j = 0; j < extra.length; j++) { if (RENTAL_LOG_DISTINGUISHING_SUFFIXES_B[extra[j]]) return false; }
      return true;
    }
    return na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
  }
  function findBikesSheetMonthColIdxB(headerRow, monthName) {
    const targetShort = monthName.toString().trim().toLowerCase().slice(0, 3);
    for (let c = 0; c < headerRow.length; c++) {
      const h = (headerRow[c] || '').toString().trim().toLowerCase();
      if (h && h.slice(0, 3) === targetShort) return c;
    }
    return -1;
  }
  // contractRowCol added 24/08/2026 -- columns 26/27/28 are genuinely free
  // real estate (confirmed against the live August.json/template.json data:
  // nothing on this sheet has ever used column 26 or later), grouped
  // together rather than squeezed between the existing tables since bank's
  // own table (15-17) butts straight up against wise's dateCol (18) with no
  // gap at all. See logSecurityDepositFromJson's own comment for what this
  // column is for.
  const DEPOSIT_CATEGORIES_B = [
    { key: 'bank', label: 'Bank', header: 'deposit scan', dateCol: 15, amountCol: 16, nameCol: 17, contractRowCol: 26 },
    { key: 'wise', label: 'Wise', header: 'deposit wise', dateCol: 18, amountCol: 19, nameCol: 20, contractRowCol: 27 },
    { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24, contractRowCol: 28 }
  ];
  const DEPOSITS_MONTH_NAMES = ['January', 'February', 'march', 'april', 'may', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // ==== Monthly "Bank" balance / cash / deposit-log recompute cascade ====
  // Verbatim port of contract.html's own copy, itself (per that file's own
  // comment) ported verbatim from accounts.html's copy -- confirmed
  // byte-identical to lib/bikesWrites.js's copy of the same cascade during
  // this port. See lib/accountsWrites.js for the full formula derivation. ----
  const ACCOUNTS_SUMMARY_ITEMS = {
    expense: [
      { row: 146, labelCol: 2, valueCol: 3, expectedLabel: 'total expenses', displayLabel: 'Total expenses' },
      { row: 147, labelCol: 2, valueCol: 3, expectedLabel: 'bussiness expenses', displayLabel: 'Business expenses' },
      { row: 148, labelCol: 2, valueCol: 3, expectedLabel: 'personal expenses total', displayLabel: 'Personal expenses' },
      { row: 149, labelCol: 2, valueCol: 3, expectedLabel: 'wages and bike purchase', displayLabel: 'Wages & bike purchases' }
    ],
    income: [
      { row: 146, labelCol: 7, valueCol: 9, expectedLabel: 'income for month', displayLabel: 'Income' },
      { row: 147, labelCol: 7, valueCol: 9, expectedLabel: 'income less invesment', displayLabel: 'Income (less investment)' },
      { row: 148, labelCol: 7, valueCol: 9, expectedLabel: '% of bussiness expenses vs income', displayLabel: 'Business exp. % of income', percent: true },
      { row: 149, labelCol: 7, valueCol: 9, expectedLabel: '% of total busniness and personal vs income', displayLabel: 'Total exp. % of income', percent: true }
    ],
    profit: [
      { row: 147, labelCol: 10, valueCol: 11, expectedLabel: 'net profit', displayLabel: 'Net profit' },
      { row: 148, labelCol: 10, valueCol: 11, expectedLabel: 'actual profit', displayLabel: 'Actual profit' }
    ],
    deposit: [
      { row: 3,  labelCol: 12, valueCol: 13, expectedLabel: 'cash', displayLabel: 'Cash' },
      { row: 6,  labelCol: 12, valueCol: 13, expectedLabel: 'bank', displayLabel: 'Bank' },
      { row: 11, labelCol: 12, valueCol: 13, expectedLabel: 'wise(less deposit)', displayLabel: 'Wise (less deposit)' },
      { row: 12, labelCol: 12, valueCol: 13, expectedLabel: 'revolut(less deposit)', displayLabel: 'Revolut (less deposit)' },
      { row: 9,  labelCol: 12, valueCol: 13, expectedLabel: 'total (cash + bank+wise)', displayLabel: 'Total (cash + bank + wise)' }
    ]
  };
  function summaryNorm(s) { return (s || '').toString().trim().toLowerCase(); }
  function findSummaryRow(rows, item) {
    const target = summaryNorm(item.expectedLabel);
    const expectedRow = rows[item.row - 1];
    if (expectedRow && summaryNorm(expectedRow[item.labelCol - 1]) === target) return item.row;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r] && summaryNorm(rows[r][item.labelCol - 1]) === target) return r + 1;
    }
    return null;
  }
  function columnLetterToIndexJson(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }
  function evalSummaryFormulaJson(rows, formulaStr) {
    const terms = formulaStr.slice(1).split('+').map(t => t.trim()).filter(Boolean);
    let total = 0;
    terms.forEach(t => {
      const m = /^([A-Z]+)(\d+)$/.exec(t);
      if (m) {
        const col = columnLetterToIndexJson(m[1]);
        const row = Number(m[2]);
        const v = rows[row - 1] ? rows[row - 1][col - 1] : undefined;
        const n = Number(v);
        if (!isNaN(n)) total += n;
        return;
      }
      const n = Number(t);
      if (!isNaN(n)) total += n;
    });
    return total;
  }
  const EXPENSE_TYPE_TOTAL_LABELS_B = {
    personal: { row: 149, label: 'personal expenses total' },
    wages: { row: 150, label: 'wages and bike purchase' }
  };
  function locateExpenseTypeTotalRowFromJson(rows, type) {
    const def = EXPENSE_TYPE_TOTAL_LABELS_B[type];
    if (!def) return null;
    const norm = s => (s || '').toString().trim().toLowerCase();
    if (rows[def.row - 1] && norm(rows[def.row - 1][1]) === def.label) return def.row;
    for (let r = 0; r < rows.length; r++) { if (rows[r] && norm(rows[r][1]) === def.label) return r + 1; }
    return null;
  }
  const ACCOUNTS_CASCADE_EXTRA_ITEMS_B = {
    depositsAll:   { row: 5,  labelCol: 12, valueCol: 13, expectedLabel: 'deposits all' },
    bankLessDep:   { row: 7,  labelCol: 12, valueCol: 13, expectedLabel: 'bank less deposit' },
    cashPrevious:  { row: 4,  labelCol: 12, valueCol: 13, expectedLabel: 'cash previous' },
    bankPrevious:  { row: 2,  labelCol: 12, valueCol: 13, expectedLabel: 'bank previous less deposit + wise + rev' }
  };
  const DEPOSIT_LOG_TOTAL_ITEMS_B = [
    { key: 'scan',    dataCol: 16, row: 15, labelCol: 15, valueCol: 16, expectedLabel: 'total' },
    { key: 'wise',    dataCol: 19, row: 15, labelCol: 18, valueCol: 19, expectedLabel: 'total' },
    { key: 'revolut', dataCol: 23, row: 15, labelCol: 22, valueCol: 23, expectedLabel: 'total' }
  ];
  const DEPOSIT_LOG_SUBTOTAL_ITEMS_B = [
    { key: 'wise',    row: 16, labelCol: 18, valueCol: 19, expectedLabel: 'total wise' },
    { key: 'revolut', row: 16, labelCol: 22, valueCol: 23, expectedLabel: 'total revolut' }
  ];
  function readCellNumB(rows, row, col) {
    if (!row || !rows[row - 1]) return 0;
    let v = rows[row - 1][col - 1];
    if (typeof v === 'string' && v.charAt(0) === '=') v = evalSummaryFormulaJson(rows, v);
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  function writeCellB(rows, row, col, val) {
    if (!row) return;
    if (!rows[row - 1]) rows[row - 1] = [];
    while (rows[row - 1].length < col) rows[row - 1].push('');
    rows[row - 1][col - 1] = val;
  }
  function sumColumnRangeB(rows, col, fromRow, toRow) {
    let total = 0;
    for (let r = fromRow; r <= toRow; r++) {
      const v = rows[r - 1] ? rows[r - 1][col - 1] : undefined;
      if (v === '' || v === null || v === undefined) continue;
      const n = Number(v);
      if (!isNaN(n)) total += n;
    }
    return total;
  }
  async function recomputeCashSheetTotalsB() {
    const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
    if (!rows || !rows.length) throw new Error('no tab named "cash" was found -- cash totals were NOT recomputed.');
    const norm = s => (s || '').toString().trim().toLowerCase();
    let incomeRow = -1;
    for (let r = 1; r < rows.length; r++) {
      if (rows[r] && norm(rows[r][1]) === 'income') { incomeRow = r + 1; break; }
    }
    if (incomeRow === -1) throw new Error('Could not find the "income" total row (column B) on "cash" -- cash totals were NOT recomputed.');
    const expensesRow = incomeRow + 2;
    const totalRow = incomeRow + 4;
    if (!rows[totalRow - 1] || norm(rows[totalRow - 1][5]) !== 'total cash') {
      throw new Error('"cash" sheet layout has drifted (expected "total cash" 4 rows below "income") -- cash totals were NOT recomputed.');
    }
    const newRows = rows.map(r => r.slice());
    const incomeTotal = sumColumnRangeB(newRows, 3, 2, incomeRow - 1);
    const expensesTotal = sumColumnRangeB(newRows, 7, 2, expensesRow - 1);
    const totalCash = incomeTotal - expensesTotal;
    writeCellB(newRows, incomeRow, 3, incomeTotal);
    writeCellB(newRows, expensesRow, 7, expensesTotal);
    writeCellB(newRows, totalRow, 7, totalCash);
    await writeSheetJson('cash', newRows, modifiedTime);
    return totalCash;
  }
  async function recomputeMonthlySummaryCascadeB(monthName, year) {
    const cashTotal = await recomputeCashSheetTotalsB();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) throw new Error('No sheet found for "' + monthName + '" -- summary totals were NOT recomputed.');
    const newRows = rows.map(r => r.slice());

    const terRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.expense[0]);
    const berRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.expense[1]);
    const incRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[0]);
    const iliRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[1]);
    const pctBerRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[2]);
    const pctTotRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[3]);
    const netProfitRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.profit[0]);
    const actProfitRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.profit[1]);
    const cashRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[0]);
    const bankRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[1]);
    const wiseRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[2]);
    const revolutRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[3]);
    const totalRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[4]);
    const personalRow = locateExpenseTypeTotalRowFromJson(newRows, 'personal');
    const wagesRow = locateExpenseTypeTotalRowFromJson(newRows, 'wages');
    const depositsAllRow = findSummaryRow(newRows, ACCOUNTS_CASCADE_EXTRA_ITEMS_B.depositsAll);
    const bankLessDepRow = findSummaryRow(newRows, ACCOUNTS_CASCADE_EXTRA_ITEMS_B.bankLessDep);

    const missing = [];
    [['total expenses', terRow], ['bussiness expenses', berRow], ['income for month', incRow],
     ['income less investment', iliRow], ['net profit', netProfitRow], ['actual profit', actProfitRow],
     ['cash', cashRow], ['bank', bankRow], ['wise(less deposit)', wiseRow], ['revolut(less deposit)', revolutRow],
     ['total (cash+bank+wise)', totalRow], ['personal expenses total', personalRow], ['wages and bike purchase', wagesRow]
    ].forEach(([label, row]) => { if (!row) missing.push(label); });
    if (missing.length) throw new Error('Could not find: ' + missing.join(', ') + ' on "' + monthName + '" -- summary totals were NOT recomputed.');

    DEPOSIT_LOG_TOTAL_ITEMS_B.forEach(item => {
      const row = findSummaryRow(newRows, item) || item.row;
      const total = sumColumnRangeB(newRows, item.dataCol, 2, 14);
      writeCellB(newRows, row, item.valueCol, total);
    });
    const p15 = readCellNumB(newRows, DEPOSIT_LOG_TOTAL_ITEMS_B[0].row, DEPOSIT_LOG_TOTAL_ITEMS_B[0].valueCol);
    const s15 = readCellNumB(newRows, DEPOSIT_LOG_TOTAL_ITEMS_B[1].row, DEPOSIT_LOG_TOTAL_ITEMS_B[1].valueCol);
    const w15 = readCellNumB(newRows, DEPOSIT_LOG_TOTAL_ITEMS_B[2].row, DEPOSIT_LOG_TOTAL_ITEMS_B[2].valueCol);
    const m11 = readCellNumB(newRows, wiseRow, 13);
    const m12 = readCellNumB(newRows, revolutRow, 13);
    DEPOSIT_LOG_SUBTOTAL_ITEMS_B.forEach(item => {
      const row = findSummaryRow(newRows, item) || item.row;
      const base = item.key === 'wise' ? m11 : m12;
      const colTotal = item.key === 'wise' ? s15 : w15;
      writeCellB(newRows, row, item.valueCol, base + colTotal);
    });

    const incomeTotal = sumColumnRangeB(newRows, 9, 2, incRow - 1);
    writeCellB(newRows, incRow, 9, incomeTotal);
    const expenseTotal = sumColumnRangeB(newRows, 3, 2, terRow - 1);
    writeCellB(newRows, terRow, 3, expenseTotal);
    writeCellB(newRows, iliRow, 9, incomeTotal);
    const netProfit = incomeTotal - expenseTotal;
    writeCellB(newRows, netProfitRow, 11, netProfit);

    const personalTotal = readCellNumB(newRows, personalRow, 3);
    const wagesTotal = readCellNumB(newRows, wagesRow, 3);
    const businessExpenses = expenseTotal - personalTotal - wagesTotal;
    writeCellB(newRows, berRow, 3, businessExpenses);
    if (pctBerRow) writeCellB(newRows, pctBerRow, 9, incomeTotal ? (businessExpenses / incomeTotal) : 0);
    const actualProfit = incomeTotal - businessExpenses;
    writeCellB(newRows, actProfitRow, 11, actualProfit);
    if (pctTotRow) writeCellB(newRows, pctTotRow, 9, incomeTotal ? ((expenseTotal - wagesTotal) / incomeTotal) : 0);

    writeCellB(newRows, cashRow, 13, cashTotal);
    const m2 = readCellNumB(newRows, ACCOUNTS_CASCADE_EXTRA_ITEMS_B.bankPrevious.row, 13);
    const m4 = readCellNumB(newRows, ACCOUNTS_CASCADE_EXTRA_ITEMS_B.cashPrevious.row, 13);
    const bank = (netProfit + m2) - (cashTotal - m4) + p15 - m11 - m12;
    writeCellB(newRows, bankRow, 13, bank);
    if (depositsAllRow) writeCellB(newRows, depositsAllRow, 13, p15 + s15 + w15);
    if (bankLessDepRow) writeCellB(newRows, bankLessDepRow, 13, bank - p15);
    const totalCashBankWise = cashTotal + bank + m11 + m12;
    writeCellB(newRows, totalRow, 13, totalCashBankWise);

    await writeSheetJson(monthName, newRows, modifiedTime, year);
  }
  async function recomputeCurrentMonthSummaryCascadeB() {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    try { await recomputeMonthlySummaryCascadeB(monthName, year); }
    catch (e) { console.warn('[contractWrites] Summary totals recompute failed:', e.message); }
  }

  // ---- Column layout matches getContractRowsFromJson's own `keys` array
  // (index i <-> column i+1) -- verbatim port of contract.html's own
  // CONTRACT_KEYS_B. ----
  const CONTRACT_KEYS_B = ['date', 'contact', 'number', 'name', 'nationality', 'passport', 'bikeModel',
    'rentingDateFrom', 'returnDate', 'returnTime', 'deliverToHotel',
    'totalPrice', 'paidBy', 'deposit', 'depositAmount', 'deliveryFee', 'status',
    'contractDocUrl', 'contractPdfUrl', 'passportPhotoUrl', 'receiptPdfUrl',
    'deliveryTime', 'calendarEventId', 'deliveryLink', 'checklistPdfUrl', 'chatName',
    'depositCurrency',
    'helmetHalfSizeQty', 'helmetFullSizeS', 'helmetFullSizeM', 'helmetFullSizeL', 'helmetFullSizeXL',
    'helmetKidsQty', 'helmetFullFaceQty', 'helmetNone', 'messengerId'];

  // ---- Builds the 16-value [contact..status] block shared by both
  // addContract's new row (columns B..Q) and editContract's row overwrite
  // (same columns) -- verbatim port of contract.html's own
  // buildContractCoreFieldsB. ----
  function buildContractCoreFieldsB(data, statusValue) {
    const bikeModel = (data.bikeModel || '').toString().trim();
    const depositMethod = (data.deposit || '').toString().trim();
    const depositNeedsAmount = depositMethod !== '' && depositMethod.toLowerCase() !== 'passport';
    const depositAmount = depositNeedsAmount ? (data.depositAmount || '') : '';
    const deliveryFee = data.deliveryFeeApplies ? (data.deliveryFee || '') : '';
    return [
      data.contact || '',
      data.number || '',
      data.name || '',
      data.nationality || '',
      data.passport || '',
      bikeModel,
      isoDateInputToContractValue(data.rentingDateFrom),
      isoDateInputToContractValue(data.returnDate),
      timeInputToContractValue(data.returnTime),
      data.deliverToHotel || '',
      data.totalPrice || '',
      data.paidBy || '',
      depositMethod,
      depositAmount,
      deliveryFee,
      statusValue
    ];
  }
  // Builds the 11-value [chatName..messengerId] block (columns Z..AJ),
  // shared by add and edit exactly as contract.html shares it (both write
  // all 11 unconditionally, in full, every time).
  function buildContractTailFieldsB(data) {
    const isDelivery = (data.deliverToHotel || '').toString().trim().toLowerCase() === 'yes';
    return {
      deliveryTime: isDelivery ? timeInputToContractValue(data.returnTime) : '',
      deliveryLink: isDelivery ? (data.deliveryLink || '') : '',
      chatName: data.chatName || '',
      depositCurrency: data.depositCurrency || '',
      helmets: [
        data.helmetHalfSizeQty || 0, data.helmetFullSizeS || 0, data.helmetFullSizeM || 0,
        data.helmetFullSizeL || 0, data.helmetFullSizeXL || 0, data.helmetKidsQty || 0,
        data.helmetFullFaceQty || 0, data.helmetNone ? 'TRUE' : ''
      ],
      messengerId: (data.messengerId || '').toString().trim()
    };
  }

  // ---- Deal flag: a NOTE on Contract_notes column 2, not a cell value --
  // verbatim port of contract.html's own syncContractDealNoteB. ----
  async function syncContractDealNoteB(rowNumber, wantDeal) {
    const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('Contract_notes');
    const existing = (noteRows || []).find(n => n[0] === rowNumber && n[1] === 2);
    const existingText = existing ? (existing[2] || '') : '';
    const wantText = wantDeal ? 'Deal' : '';
    if (existingText === wantText) return;
    const filtered = (noteRows || []).filter(n => !(n[0] === rowNumber && n[1] === 2));
    if (wantDeal) filtered.push([rowNumber, 2, 'Deal']);
    await writeSheetJson('Contract_notes', filtered, modifiedTime);
  }

  // ---- Idempotency marker helpers for 'addContract' -- same technique as
  // bikes.html's swap guard, but on Contract_notes (column
  // CONTRACT_IDEMPOTENCY_NOTE_COL_B=3) instead of customer_notes, since
  // addContract creates a Contract row, not a customer row. ----
  async function findExistingContractTxnMarkerFromJson(clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('Contract_notes'));
    } catch (e) {
      return null; // notes sidecar unreadable -- fail open, same convention as bikes.html
    }
    const hit = (noteRows || []).find(n => n[1] === CONTRACT_IDEMPOTENCY_NOTE_COL_B && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markContractTxnIdFromJson(rowNumber, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('Contract_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === rowNumber && n[1] === CONTRACT_IDEMPOTENCY_NOTE_COL_B));
      newNoteRows.push([rowNumber, CONTRACT_IDEMPOTENCY_NOTE_COL_B, clientTxnId]);
      await writeSheetJson('Contract_notes', newNoteRows, modifiedTime);
    } catch (e) {
      console.warn('[contractWrites] Could not record addContract idempotency marker:', e.message);
      throw e;
    }
  }

  // ==== action:'addContract' -- byte-for-byte port of contract.html's own
  // addContractFromJson, MINUS the passport-photo upload (stays a
  // client-side follow-up, see file header comment), PLUS a clientTxnId
  // idempotency guard (see file header comment for why). ====
  async function addContractFromJson(data) {
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingContractTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, row: existingRow, idempotentReplay: true };
      }
    }

    const name = (data.name || '').toString().trim();
    if (!name) throw new Error('Name is required.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    const newRows = (rows || []).map(r => r.slice());
    if (!newRows.length) newRows.push(CONTRACT_KEYS_B.map(k => k === 'date' ? 'Date' : ''));

    const core = buildContractCoreFieldsB(data, 'Pending');
    const tail = buildContractTailFieldsB(data);
    const newRow = new Array(CONTRACT_KEYS_B.length).fill('');
    newRow[0] = isoDateInputToContractValue(isoYmdNowB());
    for (let i = 0; i < core.length; i++) newRow[1 + i] = core[i]; // columns B..Q (1..16)
    // Columns R..U (17..20, contractDocUrl/contractPdfUrl/passportPhotoUrl/
    // receiptPdfUrl) and W (22, calendarEventId) stay blank -- Doc/PDF/photo
    // generation and calendar sync are both out of scope (see file header).
    newRow[21] = tail.deliveryTime;
    newRow[23] = tail.deliveryLink;
    newRow[25] = tail.chatName;
    newRow[26] = tail.depositCurrency;
    for (let i = 0; i < tail.helmets.length; i++) newRow[27 + i] = tail.helmets[i];
    newRow[35] = tail.messengerId;

    const warnings = [];

    // ---- Calendar sync (added 18/08/2026) -- creates the 🏨 delivery event
    // for this new Pending contract (if it calls for hotel delivery) before
    // the row is written, so the calendarEventId lands in the same single
    // Drive write. See file header's calendarCtx comment for the full "why".
    let finalNewRow = newRow;
    const calAdd = await getCalendarClient();
    if (calAdd) {
      try {
        const { syncDeliveryEventForContractRow } = require('./googleCalendarSync');
        const { row: syncedRow } = await syncDeliveryEventForContractRow(calAdd, newRow);
        finalNewRow = syncedRow;
      } catch (calErr) {
        warnings.push('Calendar sync did not complete -- the contract itself saved fine. (' + calErr.message + ')');
      }
    }
    newRows.push(finalNewRow);
    const newRowNumber = newRows.length;

    await writeSheetJson('Contract', newRows, modifiedTime);

    if (clientTxnId) {
      try { await markContractTxnIdFromJson(newRowNumber, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
    }

    if (data.isDeal) {
      try {
        await syncContractDealNoteB(newRowNumber, true);
      } catch (noteErr) {
        warnings.push('Deal flag note: ' + noteErr.message);
      }
    }

    const responsePayload = { success: true, row: newRowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ==== action:'editContract' -- byte-for-byte port of contract.html's own
  // editContractFromJson. No clientTxnId guard: unconditionally overwrites
  // the same columns with the same values every time, so a retry converges
  // to the same end state (see file header comment). ====
  async function editContractFromJson(data) {
    const rowNumber = Math.round(Number(data.rowNumber));
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid contract row number.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rowNumber > rows.length) throw new Error('That contract row no longer exists on the sheet.');
    const newRows = rows.map(r => r.slice());
    const editedRow = newRows[rowNumber - 1].slice();
    while (editedRow.length < CONTRACT_KEYS_B.length) editedRow.push('');

    const status = (data.status || '').toString().trim() || 'Pending';
    const core = buildContractCoreFieldsB(data, status);
    const tail = buildContractTailFieldsB(data);
    for (let i = 0; i < core.length; i++) editedRow[1 + i] = core[i]; // columns B..Q (1..16) -- column A (date) is left untouched
    // Columns R..U (17..20) and W (22) stay whatever they already were.
    editedRow[21] = tail.deliveryTime;
    editedRow[23] = tail.deliveryLink;
    editedRow[25] = tail.chatName;
    editedRow[26] = tail.depositCurrency;
    for (let i = 0; i < tail.helmets.length; i++) editedRow[27 + i] = tail.helmets[i];
    editedRow[35] = tail.messengerId;

    const warnings = [];

    // ---- Security-deposit ledger sync (rewritten 21/08/2026 to use a
    // direct per-contract reference on this row's own spare 37th column
    // instead of removeSecurityDepositByNameAndAmountFromJson's best-effort
    // name+amount matching -- see buildDepositRefB's comment above for the
    // full "why" a common name or a typo made that matching a real risk.
    // Runs BEFORE the Contract row write below so the resulting reference
    // lands in the SAME write as everything else this edit changes, rather
    // than a second one. Staff change a booking's SECURITY deposit method
    // (this row's "Deposit" field -- not "Paid by") after the fact -- most
    // commonly Wise/Scan/Revolut back to Cash once a deposit is actually
    // handed back, but any method -> any other method is possible.
    //   - Passport/Cash -> Passport/Cash: nothing tracked either side,
    //     nothing to do.
    //   - Passport/Cash -> Scan/Wise/Revolut: log a fresh ledger row, same
    //     as intake would have, and store ITS reference on this row.
    //   - Scan/Wise/Revolut -> Passport/Cash: clear the old ledger row --
    //     via this row's stored reference if it still checks out (points at
    //     the current month, right category, and the name there still
    //     matches this contract's customer); otherwise this NEVER guesses
    //     and NEVER blocks the save -- it just warns, and the edit screen's
    //     "pick the right deposit" picker (action:'resolveDepositLedgerPick',
    //     a deliberately SEPARATE action -- see that function's comment for
    //     why it isn't just a re-submit of this one) is the follow-up fix.
    //     Reference is cleared to '' once the old entry is confirmed gone.
    //   - Scan/Wise/Revolut -> a DIFFERENT one of the three: both of the
    //     above.
    // Only runs when the method actually changed (data.originalDeposit,
    // sent by the edit form from the pre-edit record) -- editing anything
    // else, including just the deposit AMOUNT with the method unchanged,
    // leaves the reference (and the ledger) exactly as it was.
    const oldDepositLower = (data.originalDeposit || '').toString().trim().toLowerCase();
    const newDepositLower = (data.deposit || '').toString().trim().toLowerCase();
    if (oldDepositLower !== newDepositLower) {
      const DEPOSIT_METHOD_TO_LEDGER_CATEGORY = { scan: 'bank', wise: 'wise', revolut: 'revolut' };
      const oldLedgerCategory = DEPOSIT_METHOD_TO_LEDGER_CATEGORY[oldDepositLower];
      const newLedgerCategory = DEPOSIT_METHOD_TO_LEDGER_CATEGORY[newDepositLower];
      const priorRef = (editedRow[36] || '').toString().trim();

      // oldSideResolved tracks whether the OLD ledger entry actually got
      // cleared via the reference -- ONLY then is it safe to blank the
      // reference below. If it didn't resolve (a stale/missing ref), the
      // reference is left exactly as it was: it's the only breadcrumb
      // pointing at whatever entry is still sitting out there
      // un-reconciled, and silently discarding it just because the NEW
      // method happens not to be ledger-tracked would make that entry
      // harder to ever find again, not easier. The picker's own follow-up
      // action (resolveDepositLedgerPickFromJson) clears its own reference
      // separately once staff resolve it, so this function never needs to
      // know about a pick at all.
      let oldSideResolved = !oldLedgerCategory; // nothing to resolve if the old method wasn't tracked at all

      if (oldLedgerCategory) {
        try {
          const refResult = await clearSecurityDepositByRefFromJson(priorRef, oldLedgerCategory, data.name);
          if (refResult.cleared) {
            oldSideResolved = true;
          } else {
            warnings.push('Security deposit method changed (' + (data.originalDeposit || '(none)') + ' -> ' + (data.deposit || '(none)') +
              '), but the old ' + oldLedgerCategory + ' ledger entry could not be matched automatically (' + refResult.reason +
              ') -- please clear it by hand on the Deposits page, or reopen this edit to pick it from the list.');
          }
        } catch (removeDepErr) {
          warnings.push(removeDepErr.message);
        }
      }

      const newDepositAmount = core[13];
      if (newLedgerCategory && newDepositAmount !== '' && Number(newDepositAmount) > 0) {
        try {
          const logResult = await logSecurityDepositFromJson(newDepositLower, newDepositAmount, data.name, rowNumber);
          if (logResult && logResult.write) {
            // A fresh deposit is now the operative one for this contract --
            // this replaces whatever the reference held before regardless
            // of oldSideResolved (the old entry, if still unresolved, keeps
            // existing on the ledger as its own orphaned row; it's just no
            // longer this contract's problem to track).
            editedRow[36] = buildDepositRefB(logResult.monthName, logResult.year, newLedgerCategory, logResult.write.row);
          }
        } catch (logDepErr) {
          warnings.push(logDepErr.message);
        }
      } else if (!newLedgerCategory && oldSideResolved) {
        editedRow[36] = ''; // new method isn't ledger-tracked, AND the old entry is confirmed gone -- no active reference
      }
    }

    // ---- Calendar sync (added 18/08/2026) -- creates/updates/removes the
    // 🏨 delivery event to match this edit (status/delivery/date/time can
    // all change here) before the row is written. See addContractFromJson's
    // identical comment above for the full "why".
    let finalEditedRow = editedRow;
    const calEdit = await getCalendarClient();
    if (calEdit) {
      try {
        const { syncDeliveryEventForContractRow } = require('./googleCalendarSync');
        const { row: syncedRow } = await syncDeliveryEventForContractRow(calEdit, editedRow);
        finalEditedRow = syncedRow;
      } catch (calErr) {
        warnings.push('Calendar sync did not complete -- the contract itself saved fine. (' + calErr.message + ')');
      }
    }
    newRows[rowNumber - 1] = finalEditedRow;

    await writeSheetJson('Contract', newRows, modifiedTime);

    try {
      await syncContractDealNoteB(rowNumber, !!data.isDeal);
    } catch (noteErr) {
      warnings.push('Deal flag note: ' + noteErr.message);
    }

    const responsePayload = { success: true, row: rowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ==== action:'cancelContract' -- byte-for-byte port of contract.html's
  // own cancelContractFromJson, PLUS the 2026-08-17 idempotent-replay fix
  // -- see file header comment for the full "why" (a resubmit of an
  // already-succeeded cancel, e.g. from restoreUnresolvedSaves() recovering
  // a leftover localStorage entry after a page reload mid-flight, used to
  // throw and land the row in the failed-saves panel with a Retry button
  // that could never succeed -- since the row really was already Canceled,
  // every retry just re-threw the same error forever). ====
  async function cancelContractFromJson(data) {
    const rowNumber = Math.round(Number(data.rowNumber));
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid contract row number.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rowNumber > rows.length) throw new Error('That contract row no longer exists on the sheet.');
    const currentStatus = (rows[rowNumber - 1][16] || '').toString().trim().toLowerCase();
    // Already canceled -- this IS the outcome cancelContract exists to
    // produce, so a retry that finds it already done is a no-op success,
    // not a failure. Only genuinely DIFFERENT non-Pending statuses (e.g.
    // "Rented" -- the record was actioned some other way in the meantime)
    // are still a real conflict worth throwing on.
    if (currentStatus === 'canceled') {
      return { success: true, row: rowNumber, idempotentReplay: true };
    }
    if (currentStatus !== 'pending') {
      throw new Error('This contract is no longer Pending (current status: "' +
        (currentStatus || '(blank)') + '") -- it may have already been actioned. Refresh the list and try again.');
    }
    const newRows = rows.map(r => r.slice());
    let editedRow = newRows[rowNumber - 1].slice();
    while (editedRow.length < 17) editedRow.push('');
    editedRow[16] = 'Canceled';
    // ---- Calendar sync (added 18/08/2026) -- removes this row's 🏨
    // delivery event now that it's no longer Pending, mirroring Code.gs's
    // own syncDeliveryCalendarForContractRow call on the same status flip.
    const calCancel = await getCalendarClient();
    if (calCancel) {
      try {
        const { syncDeliveryEventForContractRow } = require('./googleCalendarSync');
        const { row: syncedRow } = await syncDeliveryEventForContractRow(calCancel, editedRow);
        editedRow = syncedRow;
      } catch (calErr) {
        console.warn('[contractWrites] cancelContract calendar sync failed (non-blocking):', calErr && calErr.message);
      }
    }
    newRows[rowNumber - 1] = editedRow;
    await writeSheetJson('Contract', newRows, modifiedTime);
    return { success: true, row: rowNumber };
  }

  // ================== WRITE layer 2: customer intake (doRent) ==================
  // Ports contract.html's own client-side customer-intake write (the SAME
  // write bikes.html's long-extend and customers.html's Add form use) --
  // see file header comment for why THIS version (not bikes.html's) is the
  // one duplicated here: every helper below returns a {write: {...}}
  // descriptor instead of independently logging, so customerIntakeFromJson
  // can fold everything into ONE combined, one-click-reversible
  // transaction-log entry.

  function stripBikeNameBracketsB2(s) {
    return (s || '').toString().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function buildRentalIncomeTextB(data, dayCount) {
    const bikeName = (data.bikeModel || '').toString().trim();
    const isExtendSource = (data.source || '').toString().trim().toLowerCase() === 'extend';
    const verb = isExtendSource ? 'extend' : 'rent';
    let text = bikeName;
    text += (dayCount !== null && dayCount !== undefined && !isNaN(dayCount))
      ? (' ' + verb + ' ' + dayCount + (dayCount === 1 ? ' day' : ' days'))
      : (' ' + verb);
    return text;
  }

  async function appendLedgerEntryFromJson(rowNumber, bikeModel, fromDmy, toDmy, lineDays, lineAmount, deltaDays, deltaAmount, previousNoteText, isDeal) {
    const { rows: noteRows, modifiedTime: noteModifiedTime } = await fetchSheetWithMeta('customer_notes');
    const existingNoteEntry = (noteRows || []).find(n => n[0] === rowNumber && n[1] === LEDGER_CONTACT_COL_B);
    const seedNote = (previousNoteText !== null && previousNoteText !== undefined)
      ? previousNoteText
      : (existingNoteEntry ? (existingNoteEntry[2] || '') : '');
    const priorTotal = parseLedgerTotal(seedNote);
    const body = stripLedgerTotalLineB(seedNote);
    const safeDays = Number(lineDays) || 0;
    const line = (bikeModel || 'Bike') + ' — ' + fromDmy + ' to ' + toDmy +
      ' (' + safeDays + (safeDays === 1 ? ' day' : ' days') + ') — ฿' + formatMoneyForLedgerB(lineAmount);
    const newTotalDays = priorTotal.days + (Number(deltaDays) || 0);
    const newTotalAmount = priorTotal.amount + (Number(deltaAmount) || 0);
    const targetNote = (body ? body + '\n' : '') + line + '\n' + 'Total: ' + newTotalDays + ' days, ฿' + formatMoneyForLedgerB(newTotalAmount);

    // Preserve any OTHER marker rows for this same customer row (e.g. the
    // idempotency marker below, column IDEMPOTENCY_NOTE_COL_B) -- only
    // replace the ledger-note row (column LEDGER_CONTACT_COL_B).
    const newNoteRows = (noteRows || []).filter(n => !(n[0] === rowNumber && n[1] === LEDGER_CONTACT_COL_B));
    newNoteRows.push([rowNumber, LEDGER_CONTACT_COL_B, targetNote]);
    await writeSheetJson('customer_notes', newNoteRows, noteModifiedTime);

    const { rows: custRows, modifiedTime: custModifiedTime } = await fetchSheetWithMeta('customer');
    const newCustRows = custRows.map(r => r.slice());
    const targetRow = newCustRows[rowNumber - 1];
    while (targetRow.length <= LEDGER_CONTACT_COL_B - 1) targetRow.push('');
    const currentContact = (targetRow[LEDGER_CONTACT_COL_B - 1] || '').toString();
    const baseContact = stripAllTrailingParensAndDealB(currentContact);
    const targetBracket = ' (฿' + formatMoneyForLedgerB(newTotalAmount) + ', ' + newTotalDays + ' days)';
    const targetContact = baseContact + targetBracket + (isDeal ? ' Deal' : '');
    targetRow[LEDGER_CONTACT_COL_B - 1] = targetContact;
    await writeSheetJson('customer', newCustRows, custModifiedTime);

    return { totalDays: newTotalDays, totalAmount: newTotalAmount };
  }

  async function appendMonthlyIncomeRowFromJson(data, dayCount) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) {
      throw new Error('no tab named "' + monthName + '" was found, so this entry was NOT logged on the monthly income sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [6, 7, 8, 9, 10]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 10) row.push('');
    const incomeText = buildRentalIncomeTextB(data, dayCount);
    const paidByRaw = (data.paidBy || '').toString().trim().toLowerCase();
    const paidDisplay = paidByRaw === 'scan' ? 'QR scan' : paidByRaw;
    const amountValue = (data.totalPrice !== '' && data.totalPrice !== undefined && !isNaN(Number(data.totalPrice))) ? Number(data.totalPrice) : '';
    row[5] = isoDateInputToContractValue(isoYmdNowB());
    row[6] = incomeText;
    row[7] = data.name || '';
    row[8] = amountValue;
    row[9] = paidDisplay;
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      incomeText, amountValue, monthName, year,
      write: { sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }
    };
  }
  async function appendCashSheetRowFromJson(incomeText, rawAmount) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
    if (!rows || !rows.length) {
      throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [1, 2, 3]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 3) row.push('');
    const amountValue = (rawAmount !== '' && rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) ? Number(rawAmount) : '';
    row[0] = isoDateInputToContractValue(isoYmdNowB());
    row[1] = incomeText;
    row[2] = amountValue;
    newRows[targetIdx] = row;
    await writeSheetJson('cash', newRows, modifiedTime);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      amountValue,
      write: { sheet: 'cash', year: null, row: targetIdx + 1, cols: [1, 2, 3], before: ['', '', ''], after: [row[0], row[1], row[2]] }
    };
  }
  async function addRentalAmountToBikesSheetFromJson(bikeModel, rawAmount) {
    const amount = Number(rawAmount);
    if (rawAmount === '' || rawAmount === null || rawAmount === undefined || isNaN(amount) || amount === 0) return null;
    const bikeNameTrimmed = (bikeModel || '').toString().trim();
    if (!bikeNameTrimmed) throw new Error('No bike name given -- bike monthly total was NOT updated.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
    const header = rows[0] || [];
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      const name = (rows[i][0] || '').toString().trim();
      if (name && bikeNamesMatchForRentalLogB(name, bikeNameTrimmed)) { rowIdx = i; break; }
    }
    if (rowIdx === -1) {
      throw new Error('Could not find a row for "' + bikeNameTrimmed + '" on the "bikes" sheet -- its monthly total was NOT updated.');
    }
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const colIdx = findBikesSheetMonthColIdxB(header, monthName);
    if (colIdx === -1) {
      throw new Error('Could not find a "' + monthName + '" column on the "bikes" sheet -- "' + bikeNameTrimmed + '"\'s monthly total was NOT updated.');
    }
    const newRows = rows.map(r => r.slice());
    const targetRow = newRows[rowIdx].slice();
    while (targetRow.length <= colIdx) targetRow.push('');
    const current = Number(targetRow[colIdx]);
    targetRow[colIdx] = (isNaN(current) ? 0 : current) + amount;
    newRows[rowIdx] = targetRow;
    await writeSheetJson('bikes', newRows, modifiedTime);
    return { write: { sheet: 'bikes', year: null, row: rowIdx + 1, cols: [colIdx + 1], before: [isNaN(current) ? 0 : current], after: [targetRow[colIdx]] } };
  }
  async function processDepositForPaymentFromJson(paidByLower, rawAmount) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) throw new Error('No sheet found for the current month -- could not update the ' + paidByLower + ' deposit total.');
    const expectedRow = paidByLower === 'wise' ? 11 : 12;
    const expectedLabel = paidByLower === 'wise' ? 'wise(less deposit)' : 'revolut(less deposit)';
    const norm = s => (s || '').toString().trim().toLowerCase();
    let rowIdx = -1;
    if (rows[expectedRow - 1] && norm(rows[expectedRow - 1][11]) === expectedLabel) rowIdx = expectedRow - 1;
    else { for (let i = 0; i < rows.length; i++) { if (rows[i] && norm(rows[i][11]) === expectedLabel) { rowIdx = i; break; } } }
    if (rowIdx === -1) throw new Error('Could not find a "' + expectedLabel + '" row in column L of the "' + monthName + '" sheet -- the ' + paidByLower + ' deposit total was NOT updated.');
    const newRows = rows.map(r => r.slice());
    const targetRow = newRows[rowIdx].slice();
    while (targetRow.length < 13) targetRow.push('');
    const current = Number(targetRow[12]);
    const delta = Number(rawAmount) || 0;
    targetRow[12] = (isNaN(current) ? 0 : current) + delta;
    newRows[rowIdx] = targetRow;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      write: { sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] }
    };
  }
  // contractRowNumber (added 24/08/2026, optional): the matching Contract
  // row this deposit belongs to, if known -- stamped into contractRowCol
  // (see DEPOSIT_CATEGORIES_B just above) so a future feature (drawing this
  // exact deposit down automatically -- e.g. an extension paid from an
  // existing Wise/Revolut deposit, today just a "not ported yet" warning
  // just below) can find the RIGHT row by a stable link instead of matching
  // on customer name alone, which breaks down for repeat customers or
  // anyone sharing a name. Carried forward at month-end by
  // lib/monthRollover.js's copyDepositCategoryRows alongside date/amount/
  // name -- see that function's own updated comment; this MUST stay in
  // sync with that copy or a deposit that survives a month boundary loses
  // its link silently. Pass null/omit when there's no known matching
  // Contract row yet -- degrades to exactly today's behavior (name-only, no
  // link) for that one deposit, same as every deposit already on the books
  // before this change. customerIntakeFromJson below gets this from
  // markMatchingContractAsRentedFromJson's own return value -- see that
  // call site's comment for why this is free (reuses a Contract.json read
  // that already has to happen, rather than a second one).
  async function logSecurityDepositFromJson(methodLower, rawAmount, customerName, contractRowNumber) {
    const categoryKey = methodLower === 'scan' ? 'bank' : methodLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) return;
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) throw new Error('No sheet found for the current month -- could not log the ' + methodLower + ' deposit.');
    let targetIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const dateRaw = row[cat.dateCol - 1];
      const dateLabel = (dateRaw || '').toString().trim().toLowerCase();
      if (dateLabel === 'total') break;
      const amtRaw = row[cat.amountCol - 1];
      const nameRaw = row[cat.nameCol - 1];
      const dateEmpty = dateRaw === '' || dateRaw === null || dateRaw === undefined;
      const amtEmpty = amtRaw === '' || amtRaw === null || amtRaw === undefined;
      const nameEmpty = nameRaw === '' || nameRaw === null || nameRaw === undefined;
      if (dateEmpty && amtEmpty && nameEmpty) { targetIdx = i; break; }
    }
    if (targetIdx === -1) {
      throw new Error('Could not find a free row above the totals row in the ' + methodLower + ' deposit section of "' + monthName + '" -- the deposit was NOT logged.');
    }
    const newRows = rows.map(r => r.slice());
    const row = newRows[targetIdx].slice();
    const maxCol = Math.max(cat.dateCol, cat.amountCol, cat.nameCol, cat.contractRowCol);
    while (row.length < maxCol) row.push('');
    row[cat.dateCol - 1] = isoDateInputToContractValue(isoYmdNowB());
    row[cat.amountCol - 1] = (Number(rawAmount) || rawAmount || '');
    row[cat.nameCol - 1] = customerName || '';
    row[cat.contractRowCol - 1] = contractRowNumber || '';
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      catLabel: cat.label, monthName, year, amountValue: row[cat.amountCol - 1],
      write: { sheet: monthName, year: year, row: targetIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol, cat.contractRowCol], before: ['', '', '', ''], after: [row[cat.dateCol - 1], row[cat.amountCol - 1], row[cat.nameCol - 1], row[cat.contractRowCol - 1]] }
    };
  }
  // ---- Shared by editContractFromJson's deposit-method-change ledger sync
  // below -- finds and clears the one security-deposit ledger row (see
  // logSecurityDepositFromJson just above) in the given category that best
  // matches customerName on the CURRENT month's sheet only (same
  // "current month only" scope every other ledger lookup here already
  // uses). Byte-for-byte port of Code.gs's removeSecurityDepositByNameAndAmount_
  // (added 21/08/2026 -- see that function's comment for the full "why",
  // including the best-effort name+amount matching this inherits: a
  // Contract row has no stored link back to its own ledger row, unlike
  // consumeDeposit's explicit row picker). If more than one row matches the
  // name, picks whichever has the closest amount to expectedAmount to
  // disambiguate; with only one name match, amount is ignored. Throws if
  // the name isn't found at all, so the caller can surface that as a
  // warning instead of silently clearing the wrong customer's deposit. ----
  async function removeSecurityDepositByNameAndAmountFromJson(methodLower, customerName, expectedAmount) {
    const categoryKey = methodLower === 'scan' ? 'bank' : methodLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) throw new Error('Unrecognized deposit ledger category "' + categoryKey + '".');

    const nameTrimmed = (customerName || '').toString().trim().toLowerCase();
    if (!nameTrimmed) {
      throw new Error('No customer name to match against the ' + cat.label + ' deposit ledger -- the old entry was NOT removed.');
    }

    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) throw new Error('No sheet found for the current month -- the ' + cat.label + ' deposit was NOT removed.');

    const expectedNum = Number(expectedAmount);
    const hasExpectedAmount = expectedAmount !== '' && expectedAmount !== undefined && expectedAmount !== null && !isNaN(expectedNum);

    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const dateLabel = (row[cat.dateCol - 1] || '').toString().trim().toLowerCase();
      if (dateLabel === 'total') break; // never match into/past the totals row

      const rowName = (row[cat.nameCol - 1] || '').toString().trim().toLowerCase();
      if (!rowName || rowName !== nameTrimmed) continue;

      if (!hasExpectedAmount) { bestIdx = i; break; } // first name match is good enough with nothing to disambiguate by
      const rowAmount = Number(row[cat.amountCol - 1]);
      const diff = isNaN(rowAmount) ? Infinity : Math.abs(rowAmount - expectedNum);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }

    if (bestIdx === -1) {
      throw new Error('Could not find a matching ' + cat.label + ' deposit entry for "' + customerName +
        '" on the ' + monthName + ' sheet -- the old entry was NOT removed. It may need clearing by hand on the Deposits page.');
    }

    const clearedDate = rows[bestIdx][cat.dateCol - 1];
    const clearedAmount = rows[bestIdx][cat.amountCol - 1];
    const clearedName = rows[bestIdx][cat.nameCol - 1];

    const newRows = rows.map(r => r.slice());
    const row = newRows[bestIdx].slice();
    row[cat.dateCol - 1] = null;
    row[cat.amountCol - 1] = null;
    row[cat.nameCol - 1] = null;
    newRows[bestIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      catLabel: cat.label, monthName, year,
      write: { sheet: monthName, year: year, row: bestIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [clearedDate, clearedAmount, clearedName], after: [null, null, null] }
    };
  }

  // ==== Deposit-ledger reference helpers (added 21/08/2026) ====
  // removeSecurityDepositByNameAndAmountFromJson just above is a real risk
  // in practice: a common customer name, or a typo, could clear the wrong
  // person's deposit with nothing to catch it. These let a Contract row
  // store a DIRECT pointer to its own ledger entry -- "monthName|year|
  // categoryKey|row" -- on the sheet's spare 37th column (index 36,
  // confirmed completely unused across every existing Contract row before
  // this was added, so no migration needed). editContractFromJson uses
  // this instead of the name/amount matcher above; that older function is
  // left in place, unused by the automatic path, in case it's ever useful
  // as a manual fallback. Deposit-ledger rows never get removed or
  // reshuffled on this sheet -- a delete just blanks the 3 cells in place
  // (see depositsWrites.js's deleteDepositEntryJson) -- so a row number
  // stays a stable pointer for as long as the reference lives.
  function buildDepositRefB(monthName, year, categoryKey, row) {
    return [monthName, year, categoryKey, row].join('|');
  }
  function parseDepositRefB(ref) {
    const s = (ref || '').toString().trim();
    if (!s) return null;
    const parts = s.split('|');
    if (parts.length !== 4) return null;
    const row = Math.round(Number(parts[3]));
    if (!row || row < 2) return null;
    const year = Number(parts[1]);
    if (!parts[0] || isNaN(year)) return null;
    return { monthName: parts[0], year, categoryKey: parts[2], row };
  }

  // ---- Lists this category's currently-open (non-empty) entries on the
  // CURRENT month's ledger sheet -- the data source for the edit screen's
  // "pick the right deposit" fallback, shown when a contract has no stored
  // reference yet (every contract that predates this feature) or its
  // reference didn't check out (see clearSecurityDepositByRefFromJson). ----
  async function listOpenSecurityDepositsFromJson(categoryLower) {
    const categoryKey = categoryLower === 'scan' ? 'bank' : categoryLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) throw new Error('Unrecognized deposit ledger category "' + categoryLower + '".');
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows } = await fetchSheetWithMeta(monthName, year);
    const entries = [];
    for (let i = 1; i < (rows || []).length; i++) {
      const row = rows[i] || [];
      const dateRaw = row[cat.dateCol - 1];
      const dateLabel = (dateRaw || '').toString().trim().toLowerCase();
      if (dateLabel === 'total') break; // never list into/past the totals row
      const amtRaw = row[cat.amountCol - 1];
      const nameRaw = row[cat.nameCol - 1];
      const isEmpty = (dateRaw === '' || dateRaw === null || dateRaw === undefined)
        && (amtRaw === '' || amtRaw === null || amtRaw === undefined)
        && (nameRaw === '' || nameRaw === null || nameRaw === undefined);
      if (isEmpty) continue;
      entries.push({ row: i + 1, date: dateRaw, amount: amtRaw, name: nameRaw });
    }
    return { catLabel: cat.label, monthName, year, entries };
  }

  // ---- Clears one ledger entry by explicit category+row -- no name
  // matching, no disambiguation: used once a row has already been pinned
  // down, either by a reference that passed its name-match check (see
  // clearSecurityDepositByRefFromJson) or by staff explicitly picking it
  // from listOpenSecurityDepositsFromJson's list. Idempotent -- clearing an
  // already-blank row is a silent success, not an error, so a retried
  // request converges safely instead of erroring on the second try. ----
  async function clearSecurityDepositAtRowFromJson(categoryLower, monthName, year, row) {
    const categoryKey = categoryLower === 'scan' ? 'bank' : categoryLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) throw new Error('Unrecognized deposit ledger category "' + categoryLower + '".');
    const rowNum = Math.round(Number(row));
    if (!rowNum || rowNum < 2) throw new Error('Invalid deposit row.');
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || rowNum > rows.length) return { alreadyClear: true };
    const rowIdx = rowNum - 1;
    const existing = rows[rowIdx] || [];
    const clearedDate = existing[cat.dateCol - 1];
    const clearedAmount = existing[cat.amountCol - 1];
    const clearedName = existing[cat.nameCol - 1];
    const alreadyEmpty = (clearedDate === '' || clearedDate === null || clearedDate === undefined)
      && (clearedAmount === '' || clearedAmount === null || clearedAmount === undefined)
      && (clearedName === '' || clearedName === null || clearedName === undefined);
    if (alreadyEmpty) return { alreadyClear: true };

    const newRows = rows.map(r => r.slice());
    const newRow = newRows[rowIdx].slice();
    newRow[cat.dateCol - 1] = null;
    newRow[cat.amountCol - 1] = null;
    newRow[cat.nameCol - 1] = null;
    newRows[rowIdx] = newRow;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    return {
      write: { sheet: monthName, year: year, row: rowNum, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [clearedDate, clearedAmount, clearedName], after: [null, null, null] }
    };
  }

  // ---- Ref-based clear: parses the stored reference, requires it to point
  // at the CURRENT month's sheet (same conservative scope every other
  // ledger lookup here uses -- a past, closed-out month is never touched
  // automatically) and the right category, and requires the name still
  // sitting at that row to match the contract's own customer name before
  // clearing anything -- a cheap sanity check against a reference gone
  // stale because the row was independently edited/cleared from the
  // Deposits page after the reference was written. Never throws for a
  // reference that doesn't check out -- returns {cleared:false, reason}
  // instead, so the caller can fall back to the manual picker rather than
  // treating a stale reference as a hard error. ----
  async function clearSecurityDepositByRefFromJson(ref, expectedCategoryKey, expectedCustomerName) {
    const parsed = parseDepositRefB(ref);
    if (!parsed) return { cleared: false, reason: 'no reference stored on this contract' };
    if (parsed.categoryKey !== expectedCategoryKey) return { cleared: false, reason: 'stored reference is for a different deposit category' };

    const now = new Date();
    const currentMonthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const currentYear = now.getFullYear();
    if (parsed.monthName !== currentMonthName || parsed.year !== currentYear) {
      return { cleared: false, reason: 'stored reference points at a previous month\'s (closed-out) sheet' };
    }

    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === parsed.categoryKey);
    if (!cat) return { cleared: false, reason: 'stored reference has an unrecognized category' };
    const { rows } = await fetchSheetWithMeta(parsed.monthName, parsed.year);
    const rowAtRef = (rows && rows[parsed.row - 1]) || [];
    const nameAtRef = (rowAtRef[cat.nameCol - 1] || '').toString().trim().toLowerCase();
    const expectedNameLower = (expectedCustomerName || '').toString().trim().toLowerCase();
    if (!nameAtRef || !expectedNameLower || nameAtRef !== expectedNameLower) {
      return { cleared: false, reason: 'the name at the referenced row no longer matches this contract\'s customer' };
    }

    const result = await clearSecurityDepositAtRowFromJson(parsed.categoryKey, parsed.monthName, parsed.year, parsed.row);
    return Object.assign({ cleared: true }, result);
  }

  // ==== action:'resolveDepositLedgerPick' -- the edit screen's "pick the
  // right deposit" fallback modal calls this once staff click an entry,
  // added 21/08/2026. Deliberately narrow and separate from re-submitting
  // 'editContract': editContractFromJson's "new side" (logging a fresh
  // ledger entry for whatever the deposit method changed TO) may have
  // already succeeded on the FIRST save even though the "old side" (this
  // pick is resolving) didn't -- re-running the whole edit again would
  // call logSecurityDepositFromJson a second time and log a genuine
  // duplicate entry. This action does ONLY the one thing the picker is
  // for: clear the exact row staff pointed at (no name check needed --
  // they already confirmed it visually), then update this contract's
  // reference IF it still points at the entry just being resolved (or was
  // empty) -- but leave it alone if it already holds a DIFFERENT
  // reference, which would mean the "new side" already logged a newer
  // entry for this same contract and this resolve must not clobber that.
  // data: { rowNumber, category, row }. ----
  async function resolveDepositLedgerPickFromJson(data) {
    const rowNumber = Math.round(Number(data.rowNumber));
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid contract row number.');
    const category = (data.category || '').toString().trim().toLowerCase();
    if (!DEPOSIT_CATEGORIES_B.find(c => c.key === category)) throw new Error('Unrecognized deposit ledger category "' + data.category + '".');
    const row = Math.round(Number(data.row));
    if (!row || row < 2) throw new Error('Invalid deposit row.');

    const now = new Date();
    const currentMonthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const currentYear = now.getFullYear();

    await clearSecurityDepositAtRowFromJson(category, currentMonthName, currentYear, row);

    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (rows && rowNumber <= rows.length) {
      const existingRef = (rows[rowNumber - 1][36] || '').toString().trim();
      const parsedExisting = parseDepositRefB(existingRef);
      const staleOrEmpty = !parsedExisting || (parsedExisting.categoryKey === category && parsedExisting.row === row);
      if (staleOrEmpty && existingRef !== '') {
        const newRows = rows.map(r => r.slice());
        const patchedRow = newRows[rowNumber - 1].slice();
        while (patchedRow.length < 37) patchedRow.push('');
        patchedRow[36] = '';
        newRows[rowNumber - 1] = patchedRow;
        try {
          await writeSheetJson('Contract', newRows, modifiedTime);
        } catch (refClearErr) {
          // The ledger entry is already cleared either way -- a failure to
          // also blank this contract's stale reference just means it'll
          // fail its name-check next time (the row's now empty) and fall
          // back to the picker again, not silently clear something wrong.
          console.warn('[contractWrites] resolveDepositLedgerPick: could not clear the contract\'s own stale reference (non-blocking):', refClearErr.message);
        }
      }
    }

    return { success: true };
  }

  async function markMatchingContractAsRentedFromJson(name, bikeModel) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    // TEMP DIAGNOSTIC LOGGING (added 18/08/2026, remove once confirmed
    // fixed -- see googleCalendarSync.js's syncDeliveryEventForContractRow
    // comment for the full "why"): a silent miss here (no matching Pending
    // row found) would explain a stale 🏨 delivery event just as well as a
    // bug in the delete logic itself, and this loop previously had NO
    // logging at all for that case.
    let matchedAnyPendingRow = false;
    for (let i = rows.length - 1; i >= 1; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'pending') continue;
      if (rowName !== nameTarget) continue;
      matchedAnyPendingRow = true;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) {
        console.warn(`[contractWrites] markMatchingContractAsRented: found a Pending row for name="${name}" but bike didn't match (row bike="${rowBike}" vs target="${bikeTarget}") -- skipped, delivery event (if any) left untouched.`);
        continue;
      }
      const priorStatusRaw = rows[i][16]; // capture BEFORE overwriting, for the combined reversal entry below
      const newRows = rows.map(r => r.slice());
      let row = newRows[i].slice();
      while (row.length < 17) row.push('');
      row[16] = 'Rented';
      // ---- Calendar sync (added 18/08/2026) -- removes this row's 🏨
      // delivery event now that it's no longer Pending, mirroring Code.gs's
      // own syncDeliveryCalendarForContractRow call on this exact flip
      // (Contract -> Rented).
      const calRent = await getCalendarClient();
      if (calRent) {
        try {
          const { syncDeliveryEventForContractRow } = require('./googleCalendarSync');
          const { row: syncedRow } = await syncDeliveryEventForContractRow(calRent, row);
          row = syncedRow;
        } catch (calErr) {
          console.warn('[contractWrites] markMatchingContractAsRented calendar sync failed (non-blocking):', calErr && calErr.message);
        }
      } else {
        console.warn('[contractWrites] markMatchingContractAsRented: getCalendarClient() returned null (not connected from this request\'s perspective) -- delivery event, if any, was left untouched.');
      }
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1, write: { sheet: 'Contract', year: null, row: i + 1, cols: [17], before: [priorStatusRaw], after: ['Rented'] } };
    }
    if (!matchedAnyPendingRow) {
      console.warn(`[contractWrites] markMatchingContractAsRented: no Pending Contract row at all matched name="${name}" -- nothing flipped to Rented, delivery event (if any) left untouched.`);
    }
    return { found: false };
  }
  async function findRentedContractRowForBackfillFromJson(name, bikeModel) {
    const { rows } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return null;
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return null;
    for (let i = rows.length - 1; i >= 1; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      let totalPrice = Number(rows[i][11]);
      if (isNaN(totalPrice)) totalPrice = 0;
      return { row: i + 1, totalPrice };
    }
    return null;
  }
  async function syncContractRowTotalsFromJson(name, bikeModel, returnDateIso, totalAmount) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= 1; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      const row = newRows[i].slice();
      while (row.length < 17) row.push('');
      const changedCols = [], before = [], after = [];
      if (returnDateIso) {
        before.push(row[8]); changedCols.push(9);
        row[8] = isoDateInputToContractValue(returnDateIso);
        after.push(row[8]);
      }
      if (totalAmount !== null && totalAmount !== undefined) {
        before.push(row[11]); changedCols.push(12);
        row[11] = totalAmount;
        after.push(row[11]);
      }
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1, write: changedCols.length ? { sheet: 'Contract', year: null, row: i + 1, cols: changedCols, before, after } : null };
    }
    return { found: false };
  }

  // ---- Idempotency marker helpers for 'customerIntake' -- same technique
  // (and same customer_notes sidecar) as bikes.html's version. ----
  async function findExistingTxnMarkerFromJson(clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('customer_notes'));
    } catch (e) {
      return null;
    }
    const hit = (noteRows || []).find(n => n[1] === IDEMPOTENCY_NOTE_COL_B && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markTxnIdFromJson(rowNumber, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('customer_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === rowNumber && n[1] === IDEMPOTENCY_NOTE_COL_B));
      newNoteRows.push([rowNumber, IDEMPOTENCY_NOTE_COL_B, clientTxnId]);
      await writeSheetJson('customer_notes', newNoteRows, modifiedTime);
    } catch (e) {
      console.warn('[contractWrites] Could not record customerIntake idempotency marker:', e.message);
      throw e;
    }
  }

  // ==== action:'customerIntake' (doRent) -- byte-for-byte port of
  // contract.html's own (NEWER, combined-log) customerIntakeFromJson, PLUS
  // a clientTxnId idempotency guard using the new-row-marker technique
  // (same as bikes.html's swap/customerIntake) -- doRent()'s own
  // client-side comment describes a REAL double-booking Anton hit from
  // exactly this kind of dropped-connection retry. ====
  async function customerIntakeFromJson(data) {
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, row: existingRow, idempotentReplay: true };
      }
    }

    const name = (data.name || '').toString().trim();
    if (!name) throw new Error('Name is required.');
    data.bikeModel = stripBikeNameBracketsB2(data.bikeModel);
    const isExtendSource = (data.source || '').toString().trim().toLowerCase() === 'extend';

    const { rows: custRows, modifiedTime: custModifiedTime } = await fetchSheetWithMeta('customer');
    const newRows = (custRows || []).map(r => r.slice());
    let newRow = new Array(16).fill('');
    newRow[0] = isoDateInputToContractValue(isoYmdNowB());
    newRow[1] = data.contact || '';
    newRow[2] = name;
    newRow[3] = data.nationality || '';
    newRow[4] = data.passport || '';
    newRow[5] = data.bikeModel || '';
    newRow[6] = '';
    newRow[7] = isoDateInputToContractValue(data.rentingDateFrom);
    newRow[8] = isoDateInputToContractValue(data.returnDate);
    newRow[9] = timeInputToContractValue(data.returnTime);
    newRow[10] = data.deliverToHotel || '';
    newRow[11] = data.totalPrice || '';
    newRow[12] = data.paidBy || '';
    newRow[13] = '';
    newRow[14] = data.deposit || '';
    newRow[15] = isExtendSource ? 'Extend' : 'Direct';

    const warnings = [];

    // ---- Calendar sync (added 18/08/2026, FIXED 18/08/2026 -- this
    // function was missed in the first pass; addContractFromJson/
    // editContractFromJson/cancelContractFromJson/
    // markMatchingContractAsRentedFromJson all got the hook, but THIS
    // customerIntakeFromJson -- the actual "Rent" action contract.html
    // calls, which is what creates the customer-sheet row a 🛵 due-back
    // event needs -- did not. Creates the due-back event before the row is
    // written, same pattern as lib/customersWrites.js's own
    // customerIntakeFromJson.
    const calIntake = await getCalendarClient();
    if (calIntake) {
      try {
        const { syncDueBackEventForCustomerRow, buildContractLookup } = require('./googleCalendarSync');
        const { rows: contractRowsForCal } = await fetchSheetWithMeta('Contract');
        const contractLookup = buildContractLookup(contractRowsForCal);
        const paddedRow = newRow.slice();
        while (paddedRow.length < 22) paddedRow.push('');
        const { row: syncedRow } = await syncDueBackEventForCustomerRow(calIntake, paddedRow, contractLookup);
        newRow = syncedRow;
      } catch (calErr) {
        warnings.push('Calendar sync did not complete -- the booking itself saved fine. (' + calErr.message + ')');
      }
    }

    newRows.push(newRow);
    const newRowNumber = newRows.length;
    await writeSheetJson('customer', newRows, custModifiedTime);

    const combinedWrites = [
      { sheet: 'customer', year: null, row: newRowNumber, cols: newRow.map((_, i) => i + 1), before: newRow.map(() => ''), after: newRow.slice() }
    ];

    let dayCount = null;
    if (data.rentingDateFrom && data.returnDate) {
      const from = new Date(data.rentingDateFrom + 'T00:00:00');
      const to = new Date(data.returnDate + 'T00:00:00');
      if (!isNaN(from) && !isNaN(to)) dayCount = Math.round((to - from) / (1000 * 60 * 60 * 24));
    }

    // PARALLELIZED 20/08/2026 (customerIntakeFromJson was the single
    // heaviest write path in the app -- ~15 sequential Drive round trips,
    // routinely tripping contract.html's 20s client-side save watchdog even
    // though every write always landed -- see that watchdog's own comment
    // in contract.html for the incident this came from). Below runs the
    // four steps that follow as CONCURRENT chains instead of one long
    // sequential list, each chain kept internally sequential where it must
    // be. This is safe ONLY because each chain touches a DISJOINT set of
    // Drive files -- writeSheetJson does optimistic-concurrency conflict
    // detection (see googleDrive.js's writeJsonFile: throws ConflictError
    // on a modifiedTime mismatch, never blind-overwrites), so two chains
    // racing on the SAME file would either throw or silently drop one
    // side's change -- neither acceptable for booking/money data. Mapped
    // out by file before writing this:
    //   - chain A (marker + ledger): customer_notes, then customer again
    //   - chain B (money sheets):    the current month's sheet + cash --
    //     appendMonthlyIncomeRowFromJson/appendCashSheetRowFromJson/
    //     processDepositForPaymentFromJson/logSecurityDepositFromJson ALL
    //     call recomputeCurrentMonthSummaryCascadeB() after their own
    //     write, which itself re-reads/rewrites BOTH the month sheet and
    //     'cash' -- so these four stay sequential WITHIN this chain (same
    //     as before), just as a unit that now overlaps the others
    //   - chain C (bikes):           'bikes' only, single write, no cascade
    //   - chain D (contract status): 'Contract' only (the Rented flip) --
    //     does NOT touch ledgerTotals, so it doesn't need to wait on chain A
    // No two chains above share a file, so no ConflictError risk between
    // them. What CANNOT move into this parallel block: the contract-totals
    // backfill/sync step below still runs AFTER all four chains settle,
    // because it has a genuine data dependency on TWO of them finishing
    // first -- it needs chain A's ledgerTotals number, and it only finds a
    // match at all once chain D has already flipped that Contract row's
    // status to "Rented" (findRentedContractRowForBackfillFromJson/
    // syncContractRowTotalsFromJson both filter on status === 'rented').
    // logTransactionB stays last for the same reason it always was: it
    // logs whatever combinedWrites ended up containing from everything
    // above.
    let ledgerTotals = null;
    // contractStatusResult (hoisted to outer scope 25/08/2026 -- see the
    // sequential step after this function's Promise.all, which reads it):
    // see chainContractStatus's own comment below for why this moved.
    let contractStatusResult = null;
    let totalAmountForSummary = 0;

    async function chainMarkerAndLedger() {
      if (clientTxnId) {
        try { await markTxnIdFromJson(newRowNumber, clientTxnId); }
        catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
      }
      try {
        let carriedNote = null;
        if (isExtendSource && data.previousRowNumber) {
          const previousRowNumber = parseInt(data.previousRowNumber, 10);
          if (previousRowNumber && previousRowNumber >= 2) {
            const { rows: prevNoteRows } = await fetchSheetWithMeta('customer_notes');
            const prevEntry = (prevNoteRows || []).find(n => n[0] === previousRowNumber && n[1] === LEDGER_CONTACT_COL_B);
            carriedNote = prevEntry ? (prevEntry[2] || '') : '';
          }
        }
        const ledgerFromDmy = formatDmyJson(decodeSheetDate(newRow[7])) || '';
        const ledgerToDmy = formatDmyJson(decodeSheetDate(newRow[8])) || '';
        const ledgerDays = dayCount != null ? dayCount : 0;
        const ledgerAmount = Number(data.totalPrice) || 0;
        ledgerTotals = await appendLedgerEntryFromJson(newRowNumber, data.bikeModel, ledgerFromDmy, ledgerToDmy, ledgerDays, ledgerAmount, ledgerDays, ledgerAmount, carriedNote, !!data.isDeal);
      } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }
    }

    async function chainMoneySheets() {
      try {
        const incomeResult = await appendMonthlyIncomeRowFromJson(data, dayCount);
        if (incomeResult && incomeResult.write) combinedWrites.push(incomeResult.write);
        if (incomeResult && typeof incomeResult.amountValue === 'number') totalAmountForSummary = incomeResult.amountValue;
      } catch (incomeErr) { warnings.push('Income sheet: ' + incomeErr.message); }

      try {
        if ((data.paidBy || '').toString().trim().toLowerCase() === 'cash') {
          const cashResult = await appendCashSheetRowFromJson(buildRentalIncomeTextB(data, dayCount), data.totalPrice);
          if (cashResult && cashResult.write) combinedWrites.push(cashResult.write);
        }
      } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }

      try {
        const paidByLower = (data.paidBy || '').toString().trim().toLowerCase();
        if (paidByLower === 'wise' || paidByLower === 'revolut') {
          const depositResult = await processDepositForPaymentFromJson(paidByLower, data.totalPrice);
          if (depositResult && depositResult.write) combinedWrites.push(depositResult.write);
        }
      } catch (depositErr) { warnings.push(depositErr.message); }

      if (isExtendSource && data.paidFromDeposit) {
        warnings.push('This extension was marked as paid from an existing deposit, but drawing that down automatically is not ported yet -- please adjust the deposit log by hand.');
      }
    }

    async function chainBikes() {
      try {
        const bikesResult = await addRentalAmountToBikesSheetFromJson(data.bikeModel, data.totalPrice);
        if (bikesResult && bikesResult.write) combinedWrites.push(bikesResult.write);
      } catch (bikesErr) { warnings.push(bikesErr.message); }
    }

    async function chainContractStatus() {
      // contractStatusResult (hoisted to outer scope 25/08/2026) captured
      // so the security-deposit-log step AFTER this function's Promise.all
      // can reuse the Contract row number THIS call already found, instead
      // of needing its own separate Contract.json search -- see
      // logSecurityDepositFromJson's own comment on its contractRowNumber
      // parameter for the full "why".
      //
      // RACE FIX 25/08/2026: the security-deposit-log step used to live
      // right here, in this chain. It's been moved to a sequential step
      // after this function's Promise.all instead -- it writes to the
      // current month sheet, which chainMoneySheets ALSO writes to
      // concurrently with this chain (Promise.all just below). Two
      // concurrent writers to the same file can both pass writeSheetJson's
      // "has this file changed" check before either write actually lands
      // (see googleDrive.js's writeJsonFile -- check-then-write, not
      // atomic), so whichever write hits Drive last silently overwrites
      // the other's change, no ConflictError, no warning. Confirmed live
      // in bikesWrites.js's identical copy of this pattern (Anton hit the
      // sibling bug in the Wise/Revolut/bank deposit draw-down there within
      // hours of it shipping) -- fixed here the same way before it could
      // bite a brand-new deposit log on this page too. This chain now only
      // does the status flip, which touches ONLY Contract.json -- safe,
      // since chainMoneySheets never writes there.
      try {
        contractStatusResult = await markMatchingContractAsRentedFromJson(name, data.bikeModel);
        if (contractStatusResult && contractStatusResult.write) combinedWrites.push(contractStatusResult.write);
      } catch (contractStatusErr) { warnings.push('Contract status update: ' + contractStatusErr.message); }
    }

    await Promise.all([chainMarkerAndLedger(), chainMoneySheets(), chainBikes(), chainContractStatus()]);

    // ---- New security-deposit logging (RACE FIX 25/08/2026) -- see
    // chainContractStatus's own comment above for the full "why" this
    // moved here: it writes to the current month sheet, the same file
    // chainMoneySheets writes to, so it can't safely run concurrently with
    // it. Sequential here, strictly AFTER the Promise.all above, so
    // chainMoneySheets has already finished every write of its own to the
    // month sheet -- nothing else touches it concurrently anymore. ----
    try {
      const depositMethodLower = (data.deposit || '').toString().trim().toLowerCase();
      if (!isExtendSource && (depositMethodLower === 'scan' || depositMethodLower === 'wise' || depositMethodLower === 'revolut')) {
        const contractRowNumber = (contractStatusResult && contractStatusResult.found) ? contractStatusResult.row : null;
        const secDepResult = await logSecurityDepositFromJson(depositMethodLower, data.depositAmount, name, contractRowNumber);
        if (secDepResult && secDepResult.write) combinedWrites.push(secDepResult.write);
      }
    } catch (secDepErr) { warnings.push(secDepErr.message); }

    try {
      if (ledgerTotals) {
        const newContractTotal = ledgerTotals.totalAmount;
        const existingMatch = await findRentedContractRowForBackfillFromJson(name, data.bikeModel);
        if (existingMatch && newContractTotal < existingMatch.totalPrice) {
          const syncResult = await syncContractRowTotalsFromJson(name, data.bikeModel, data.returnDate, null);
          if (syncResult && syncResult.write) combinedWrites.push(syncResult.write);
          warnings.push('Contract totals sync: computed running total (฿' + newContractTotal +
            ') is LESS than Contract row ' + existingMatch.row + '\'s current total price (฿' + existingMatch.totalPrice +
            ') -- skipped overwriting the total price to avoid shrinking it. Please check this customer\'s ledger note by hand.');
        } else {
          const syncResult = await syncContractRowTotalsFromJson(name, data.bikeModel, data.returnDate, newContractTotal);
          if (syncResult && syncResult.write) combinedWrites.push(syncResult.write);
        }
      }
    } catch (contractSyncErr) { warnings.push('Contract totals sync: ' + contractSyncErr.message); }

    if (combinedWrites.length) {
      await logTransactionB({
        page: 'contract.html', action: 'customerIntakeFromJson', reversible: true,
        summary: (isExtendSource ? 'Extended ' : 'Rented ') + (data.bikeModel || 'bike') + ' to ' + name +
          ' — ' + fmtMoneyB(totalAmountForSummary) +
          (dayCount !== null ? (' (' + dayCount + (dayCount === 1 ? ' day' : ' days') + ')') : ''),
        writes: combinedWrites
      });
    }

    const responsePayload = { success: true, row: newRowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }
  // ================== end WRITE layer 2 ==================

  // ================== calendar.html actions (added 18/08/2026) ==================
  // Routed through THIS file's dispatch (not a new api/*.js file -- the app
  // is already at the 12-function Vercel Hobby cap, see api/contracts/
  // [...path].js's own comment on that) since calendar.html's own actions
  // are all about the Contract/customer sheets' delivery/pickup data, the
  // closest existing home. calendar.html's frontend previously called these
  // via GET against a separate Apps Script deployment (scriptUrl) -- ported
  // here as POST actions instead, since this endpoint is POST-only and
  // there's no budget left for a new GET-capable route either.
  function requireCalendarClient() {
    return getCalendarClient().then((cal) => {
      if (!cal) throw new Error('Calendar is not connected yet. Use "Connect Calendar" on this page first.');
      return cal;
    });
  }

  async function addCalendarReminderFromJson(data) {
    const cal = await requireCalendarClient();
    const { addReminder } = require('./googleCalendarSync');
    return Object.assign({ success: true }, await addReminder(cal, data));
  }

  async function editCalendarReminderFromJson(data) {
    const cal = await requireCalendarClient();
    const { editReminder } = require('./googleCalendarSync');
    await editReminder(cal, data);
    return { success: true };
  }

  // Also clears a matching customer row's contact-reminder columns (U/V) if
  // this reminder happens to be one of createContactCustomerReminders'
  // automated ones -- mirrors Code.gs's clearContactReminderColumnsForEventId_
  // (see lib/googleCalendarSync.js's completeReminder comment for why that
  // half lives here instead of in the pure calendar module).
  async function completeCalendarReminderFromJson(data) {
    const cal = await requireCalendarClient();
    const { completeReminder, CUST } = require('./googleCalendarSync');
    const { eventId } = await completeReminder(cal, data);
    try {
      const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
      const idx = (rows || []).findIndex((r) => Array.isArray(r) && (r[CUST.CONTACT_REMINDER_EVENT_ID] || '').toString().trim() === eventId);
      if (idx !== -1) {
        const newRows = rows.map((r) => r.slice());
        const row = newRows[idx].slice();
        while (row.length <= CUST.CONTACT_REMINDER_FOR_DATE) row.push('');
        row[CUST.CONTACT_REMINDER_EVENT_ID] = '';
        row[CUST.CONTACT_REMINDER_FOR_DATE] = '';
        newRows[idx] = row;
        await writeSheetJson('customer', newRows, modifiedTime);
      }
    } catch (clearErr) {
      console.warn('[contractWrites] could not clear contact-reminder columns for completed reminder:', clearErr && clearErr.message);
    }
    return { success: true };
  }

  async function listCalendarRemindersFromJson() {
    const cal = await requireCalendarClient();
    const { listReminders } = require('./googleCalendarSync');
    return { success: true, reminders: await listReminders(cal) };
  }

  async function listDeliveryPickupLinksFromJson() {
    const { listDeliveryPickupLinks } = require('./googleCalendarSync');
    const { rows: custRows } = await fetchSheetWithMeta('customer');
    const { rows: contractRows } = await fetchSheetWithMeta('Contract');
    return { success: true, entries: listDeliveryPickupLinks(custRows, contractRows) };
  }

  async function setDeliveryPickupLinkFromJson(data) {
    const type = (data.type || '').toString().trim().toLowerCase();
    const rowIndex = Math.round(Number(data.rowIndex));
    const link = (data.link || '').toString().trim();
    if (!Number.isInteger(rowIndex) || rowIndex < 0) throw new Error('Invalid row.');
    const { syncDeliveryEventForContractRow, syncDueBackEventForCustomerRow, buildContractLookup, CT, CUST } = require('./googleCalendarSync');
    const cal = await getCalendarClient(); // optional here -- link still saves even if calendar isn't connected

    if (type === 'delivery') {
      const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
      if (!rows || rowIndex >= rows.length) throw new Error('That contract row no longer exists.');
      const newRows = rows.map((r) => r.slice());
      let row = newRows[rowIndex].slice();
      while (row.length <= CT.DELIVERY_LINK) row.push('');
      row[CT.DELIVERY_LINK] = link;
      if (cal) { try { ({ row } = await syncDeliveryEventForContractRow(cal, row)); } catch (e) { /* link still saves */ } }
      newRows[rowIndex] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
    } else if (type === 'pickup') {
      const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
      if (!rows || rowIndex >= rows.length) throw new Error('That customer row no longer exists.');
      const newRows = rows.map((r) => r.slice());
      let row = newRows[rowIndex].slice();
      while (row.length <= CUST.PICKUP_LINK) row.push('');
      row[CUST.PICKUP_LINK] = link;
      if (cal) {
        try {
          const { rows: contractRowsForCal } = await fetchSheetWithMeta('Contract');
          ({ row } = await syncDueBackEventForCustomerRow(cal, row, buildContractLookup(contractRowsForCal)));
        } catch (e) { /* link still saves */ }
      }
      newRows[rowIndex] = row;
      await writeSheetJson('customer', newRows, modifiedTime);
    } else {
      throw new Error('Unknown link type.');
    }
    return { success: true };
  }

  async function calendarConnectionStatusFromJson() {
    if (!calendarCtx || !calendarCtx.drive) return { success: true, connected: false, email: null };
    const { getCalendarConnectionStatus } = require('./googleCalendarAuth');
    const status = await getCalendarConnectionStatus(calendarCtx.drive, calendarCtx.folderId, calendarCtx.session);
    return Object.assign({ success: true }, status);
  }

  async function disconnectCalendarFromJson() {
    if (!calendarCtx || !calendarCtx.drive) return { success: true };
    const { disconnectCalendar } = require('./googleCalendarAuth');
    await disconnectCalendar(calendarCtx.drive, calendarCtx.folderId, calendarCtx.session);
    return { success: true };
  }
  // ================== end calendar.html actions ==================

  // ---- Single-dispatch entry point, mirrors bikesWriteDispatch's shape
  // (see lib/bikesWrites.js / api/bikes/write.js). All 4 in-scope
  // contract.html actions are implemented -- see file header comment for
  // the full inventory and scope decision on the 6 document-generation
  // actions NOT ported. calendar.html's 8 actions (added 18/08/2026) are
  // listed separately below. ----
  async function contractWriteDispatch(body) {
    switch (body && body.action) {
      case 'addContract':
        return addContractFromJson(body);
      case 'editContract':
        return editContractFromJson(body);
      case 'cancelContract':
        return cancelContractFromJson(body);
      case 'customerIntake':
        return customerIntakeFromJson(body);
      case 'listOpenSecurityDeposits':
        // Data source for the edit screen's "pick the right deposit"
        // fallback (added 21/08/2026 alongside the deposit-ledger
        // reference feature -- see clearSecurityDepositByRefFromJson's
        // comment). body: { category: 'scan'|'wise'|'revolut' }.
        return listOpenSecurityDepositsFromJson(body.category);
      case 'resolveDepositLedgerPick':
        // The picker's follow-up once staff click an entry -- see
        // resolveDepositLedgerPickFromJson's own comment for why this is a
        // separate action rather than a re-submit of 'editContract'.
        // body: { rowNumber, category, row }.
        return resolveDepositLedgerPickFromJson(body);
      case 'addCalendarReminder':
        return addCalendarReminderFromJson(body);
      case 'editCalendarReminder':
        return editCalendarReminderFromJson(body);
      case 'completeCalendarReminder':
        return completeCalendarReminderFromJson(body);
      case 'listCalendarReminders':
        return listCalendarRemindersFromJson();
      case 'listDeliveryPickupLinks':
        return listDeliveryPickupLinksFromJson();
      case 'setDeliveryPickupLink':
        return setDeliveryPickupLinkFromJson(body);
      case 'calendarConnectionStatus':
        return calendarConnectionStatusFromJson();
      case 'disconnectCalendar':
        return disconnectCalendarFromJson();
      default:
        throw new Error(
          'Unknown or out-of-scope contract.html write action: "' + (body && body.action) + '". ' +
          'Ported: addContract, editContract, cancelContract, customerIntake, listOpenSecurityDeposits, resolveDepositLedgerPick, plus 8 calendar.html actions. ' +
          'regenerateContract/findContractDocument/generateReceipt/getFilesForShare/findChecklistDocument/generateChecklist ' +
          'are document-generation features deliberately out of scope for this rollout -- see PROGRESS.md\'s ' +
          'contract.html write-layer inventory entry.'
        );
    }
  }

  return {
    contractWriteDispatch,
    addContractFromJson,
    editContractFromJson,
    cancelContractFromJson,
    customerIntakeFromJson,
    listOpenSecurityDepositsFromJson,
    resolveDepositLedgerPickFromJson,
    // Exposed for the fake-Drive test harness, not used by
    // api/contract/write.js itself (which only ever calls contractWriteDispatch).
    recomputeMonthlySummaryCascadeB,
    recomputeCashSheetTotalsB,
    findExistingTxnMarkerFromJson,
    findExistingContractTxnMarkerFromJson
  };
}

module.exports = { createSheetIO, createContractWrites };
