// ---- Server-side bikes.html write layer -- Phase 2 of the optimistic/
// idempotent-save rollout (see PROGRESS.md's "NEXT UP" entry and the
// "Phase 2, bikes.html write layer: INVENTORY/DESIGN DONE" entry for the
// full plan and the traced action inventory).
//
// STATUS (2026-08-17): 6 of bikes.html's 7 write actions are ported so
// far -- 'swapBike', 'markReturned', 'earlyReturnBike', 'returnDeposit',
// 'updateReturnPickup', 'extendBike' (short extension only, under 30
// days). This is deliberate, one-action-at-a-time work (per the plan's own
// recommended approach: "do not wire ANY optimistic-UI frontend changes
// until every action is ported and passing its backend test"), started
// with swap (most self-contained, single request), then the return family
// (markReturned/earlyReturnBike/returnDeposit -- grouped together since
// bikes.html's own confirmReturn() always fires markReturned OR
// earlyReturnBike, then separately fires returnDeposit as a best-effort
// follow-up when a security deposit was matched), then updateReturnPickup
// + extendBike (short). Remaining 1 (the long-extension pair --
// closeBikeForExtendFromJson + customerIntakeFromJson, a two-sequential-
// write action) is NOT ported yet -- calling any action other than these
// 6 through bikesWriteDispatch below throws clearly rather than silently
// doing nothing.
//
// bikes.html's OWN client-side script is completely UNCHANGED and UNAWARE
// this file exists -- nothing here is wired into the live page yet. This
// file and api/bikes/write.js are net-new, unreferenced by anything else,
// so their mere existence changes nothing about how bikes.html behaves
// today. Wiring the frontend (optimistic UI + idempotency submission) is a
// separate, later step once every action has a tested backend port.
//
// This is a byte-for-byte port of bikes.html's own client-side swapBike
// call graph (fetchSheetWithMeta('customer') -> ... -> swapBikeFromJson),
// SAME business rules, SAME edge cases, SAME warnings -- ported
// mechanically, not redesigned. The two differences from the browser
// version, same as accounts.html's own port documented in
// lib/accountsWrites.js:
//   1. Every fetchSheetWithMeta/writeSheetJson call goes straight to Drive
//      via `sheetIO` instead of a fetch('/api/data/...') round trip back
//      through the browser.
//   2. logTransactionB is awaited synchronously (this whole file runs in
//      ONE Vercel function invocation, so there's no "extra ocean
//      crossing" cost to awaiting it the way there was for the browser
//      version -- see accountsWrites.js's identical note).
//
// ONE genuinely NEW piece, not a mechanical copy: an idempotency guard for
// the swap action, keyed by an optional `clientTxnId` in the request body.
// bikes.html's own client-side swapBikeFromJson has no such guard (a
// double-fired click could in principle append the new customer row
// twice -- flagged as a known, accepted gap in bikes.html's own swapBike
// comment block, "no equivalent shared-lock cache exists across stateless
// serverless function calls"). Since this port is EXACTLY the frontend
// optimistic-save work's prerequisite (the whole point of clientTxnId is
// to let a frontend retry safely), the guard is added here now rather
// than ported-then-immediately-needing-a-second-pass. Implementation:
// mirrors accounts.html's own findExistingAddTxnRowFromJson technique
// (scan the relevant notes sidecar for a row already tagged with this
// clientTxnId before writing; if found, return the existing result
// instead of writing again) -- see findExistingSwapByTxnIdFromJson below.
// customer_notes already uses column B (LEDGER_CONTACT_COL_B=2) for the
// ledger note keyed by row number; the idempotency marker uses column C
// (IDEMPOTENCY_NOTE_COL_B=3), a brand-new reserved slot that nothing else
// on this sheet touches, so it can't collide with the ledger note.
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Identical to lib/accountsWrites.js's createSheetIO -- see that
// file's own comment for the full "why" (mirrors api/data/[sheet].js's
// resolveYearFolderId + filename logic exactly, so a sheet written here
// and one written through the existing /api/data/<sheet> route always
// land on the same file). Not shared via a common module -- this
// project's explicit per-file convention (see bikes.html's own repeated
// "duplicated here rather than shared, no module system" comments)
// extends to this new server-side layer too, for consistency. ----
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

function createBikesWrites(sheetIO) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- Transaction log -- ported from bikes.html's OWN client-side copy
  // (lines 881-906 there), which is a simpler 3-attempt retry loop with no
  // promise-queue serialization, UNLIKE accounts.html's server-side
  // version (lib/accountsWrites.js's logTransactionB/logTransactionBInner
  // split). That serialization was accounts.html's fix for concurrent
  // logTransactionB calls racing within one request -- verified this
  // does NOT apply to swapBikeFromJson: it calls logTransactionB at most
  // once per code path (via appendSwapUpgradeIncomeRowFromJson, only when
  // additionalAmount > 0), never concurrently with another logTransactionB
  // call in the same request. Porting bikes.html's actual (simpler)
  // client logic here rather than "helpfully" importing accounts.html's
  // extra machinery it doesn't need. ----
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
      console.warn('[bikesWrites] Transaction log write failed (non-critical):', e && e.message);
    }
  }

  function fmtMoneyB(n) {
    const v = Number(n);
    return '฿' + (isNaN(v) ? '0' : v.toLocaleString('en-US'));
  }

  // ---- Small date/format utilities -- verbatim port of bikes.html's own
  // copies (see that file's decodeSheetDate/pad2Json/formatDmyJson). ----
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
  function isoDateInputToSheetValue(isoDate) {
    const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  }
  // "HH:MM" (<input type=time>'s value) -> "HH:MM:SS" -- bare TIME
  // encoding, verbatim port of bikes.html's copy.
  function hhmmToSheetTimeValue(hhmm) {
    const m = String(hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return `${pad2Json(m[1])}:${m[2]}:00`;
  }

  // ---- Contract-sheet name/bike matching -- verbatim port of bikes.html's
  // own copies. ----
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
  const LEDGER_CONTACT_COL_B = 2; // column B -- ledger note lives on the Contact cell
  // NEW (server port only -- see file header comment): reserved marker
  // column for the swap idempotency guard. Never touched by the ledger
  // note logic above, which only ever reads/writes column B.
  const IDEMPOTENCY_NOTE_COL_B = 3;

  // ---- Reads the "Total: N days, ฿X" line off the end of a ledger note --
  // verbatim port of bikes.html's own copy. ----
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
  const DEPOSITS_MONTH_NAMES = ['January', 'February', 'march', 'april', 'may', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // ==== Monthly "Bank" balance / cash / deposit-log recompute cascade ====
  // Verbatim port of bikes.html's own copy, which is itself (per that
  // file's own comment) a verbatim port of accounts.html's copy -- see
  // lib/accountsWrites.js's identical block for the full formula
  // derivation (pulled from the real workbook, not guessed). Every write
  // this action makes always lands in the CURRENT month (no historical
  // month browsing on this page), so recomputeMonthlySummaryCascadeB is
  // always called with DEPOSITS_MONTH_NAMES[new Date().getMonth()] /
  // new Date().getFullYear() via the Current-month wrapper below. ----
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
    catch (e) { console.warn('[bikesWrites] Summary totals recompute failed:', e.message); }
  }

  // ---- appendLedgerEntryFromJson -- verbatim port of bikes.html's copy. ----
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

  // ---- appendCashSheetRowFromJson -- verbatim port of bikes.html's copy. ----
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
    const now = new Date();
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[0] = isoDateInputToSheetValue(nowIso);
    row[1] = incomeText;
    row[2] = amountValue;
    newRows[targetIdx] = row;
    await writeSheetJson('cash', newRows, modifiedTime);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'appendCashSheetRowFromJson', reversible: true,
      summary: 'Cash income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)'),
      writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [1, 2, 3], before: ['', '', ''], after: [row[0], row[1], row[2]] }]
    });
  }

  // ---- processDepositForPaymentFromJson -- verbatim port of bikes.html's copy. ----
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
    await logTransactionB({
      page: 'bikes.html', action: 'processDepositForPaymentFromJson', reversible: true,
      summary: (delta >= 0 ? 'Deposit total +' : 'Deposit total ') + fmtMoneyB(delta) + ' — ' + paidByLower + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] }]
    });
  }

  // ---- addAmountToContractRowFromJson -- verbatim port of bikes.html's copy. ----
  async function addAmountToContractRowFromJson(name, bikeModel, addAmount) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      const row = newRows[i].slice();
      while (row.length < 12) row.push('');
      const currentTotal = Number(row[11]) || 0;
      row[11] = currentTotal + (Number(addAmount) || 0);
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- syncContractReturnDateOnlyFromJson -- verbatim port of bikes.html's copy. ----
  async function syncContractReturnDateOnlyFromJson(name, bikeModel, returnDate) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      const row = newRows[i].slice();
      while (row.length < 9) row.push('');
      const isoYmd = returnDate.getFullYear() + '-' + pad2Json(returnDate.getMonth() + 1) + '-' + pad2Json(returnDate.getDate());
      row[8] = isoDateInputToSheetValue(isoYmd);
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- renameContractBikeOnSwapFromJson -- verbatim port of bikes.html's copy. ----
  async function renameContractBikeOnSwapFromJson(name, oldBikeModel, newBikeModel) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (oldBikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      const row = newRows[i].slice();
      while (row.length < 7) row.push('');
      row[6] = newBikeModel; // G bikeModel
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- parseDmyOrIsoToDateSwapB / shortenLastLedgerLineForSwapFromJson --
  // verbatim ports of bikes.html's copies. ----
  function parseDmyOrIsoToDateSwapB(raw) {
    const s = (raw || '').toString().trim();
    if (!s) return null;
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmy) return new Date(parseInt(dmy[3], 10), parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10));
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return null;
  }
  function shortenLastLedgerLineForSwapFromJson(noteText, todayValue, todayDmy, actualAmount) {
    const text = (noteText || '').toString();
    const unchanged = { note: text, newLineFromDmy: null, newLineDays: null, newLineAmount: null };

    const totalMatch = text.match(/\n?(Total:[^\n]*)$/i);
    const totalLine = totalMatch ? totalMatch[1] : null;
    const body = stripLedgerTotalLineB(text);
    if (!body) return unchanged;

    const lines = body.split('\n');
    const lastLine = lines[lines.length - 1];
    const m = lastLine.match(/^(.*?) — (\d{1,2}\/\d{1,2}\/\d{4}) to \d{1,2}\/\d{1,2}\/\d{4} \(([\d.]+) days?\) — ฿([\d,]+(?:\.\d+)?)$/);
    if (!m) return unchanged;

    const lineBikeModel = m[1];
    const lineFromDmy = m[2];
    const lineOriginalDays = Number(m[3]) || 0;
    const lineOriginalAmount = Number(m[4].replace(/,/g, '')) || 0;
    const lineFromDate = parseDmyOrIsoToDateSwapB(lineFromDmy);

    if (lineFromDate && lineFromDate.getTime() > todayValue.getTime()) {
      lines.pop();
      const droppedBody = lines.join('\n');
      return {
        note: totalLine ? (droppedBody ? droppedBody + '\n' + totalLine : totalLine) : droppedBody,
        newLineFromDmy: lineFromDmy,
        newLineDays: lineOriginalDays,
        newLineAmount: lineOriginalAmount
      };
    }

    const actualDays = lineFromDate
      ? Math.max(1, Math.round((todayValue - lineFromDate) / 86400000))
      : 1;

    lines[lines.length - 1] = lineBikeModel + ' — ' + lineFromDmy + ' to ' + todayDmy +
      ' (' + actualDays + (actualDays === 1 ? ' day' : ' days') + ') — ฿' + formatMoneyForLedgerB(actualAmount);

    const newBody = lines.join('\n');
    return {
      note: totalLine ? (newBody + '\n' + totalLine) : newBody,
      newLineFromDmy: null,
      newLineDays: null,
      newLineAmount: null
    };
  }

  // ---- addRentalAmountToBikesSheetForMonthFromJson -- verbatim port. ----
  async function addRentalAmountToBikesSheetForMonthFromJson(bikeModel, rawAmount, monthName) {
    const amount = Number(rawAmount);
    if (rawAmount === '' || rawAmount === null || rawAmount === undefined || isNaN(amount) || amount === 0) return;
    const bikeNameTrimmed = (bikeModel || '').toString().trim();
    if (!bikeNameTrimmed) throw new Error('No bike name given -- bike monthly total was NOT updated.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
    const header = rows[0] || [];
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      const nm = (rows[i][0] || '').toString().trim();
      if (nm && bikeNamesMatchForRentalLogB(nm, bikeNameTrimmed)) { rowIdx = i; break; }
    }
    if (rowIdx === -1) {
      throw new Error('Could not find a row for "' + bikeNameTrimmed + '" on the "bikes" sheet -- its monthly total was NOT updated.');
    }
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
  }

  // ---- addRentalAmountToBikesSheetFromJson -- verbatim port of bikes.html's
  // copy. Current-month sibling of addRentalAmountToBikesSheetForMonthFromJson
  // above (used by swap for the ORIGINAL rental's start month; this one is
  // used by earlyReturnBike's refund, which always lands in the CURRENT
  // month -- money moves in the month it actually moves, never
  // retroactively into the original start month). ----
  async function addRentalAmountToBikesSheetFromJson(bikeModel, rawAmount) {
    const amount = Number(rawAmount);
    if (rawAmount === '' || rawAmount === null || rawAmount === undefined || isNaN(amount) || amount === 0) return;
    const bikeNameTrimmed = (bikeModel || '').toString().trim();
    if (!bikeNameTrimmed) throw new Error('No bike name given -- bike monthly total was NOT updated.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
    const header = rows[0] || [];
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      const nm = (rows[i][0] || '').toString().trim();
      if (nm && bikeNamesMatchForRentalLogB(nm, bikeNameTrimmed)) { rowIdx = i; break; }
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
  }

  // ---- flipMatchingContractStatus -- verbatim port of bikes.html's copy.
  // Bottom-up name+bike match against whichever status the caller is
  // flipping FROM; best-effort, callers wrap this in try/catch. ----
  async function flipMatchingContractStatus(name, bikeModel, fromStatusLower, toStatus) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== fromStatusLower) continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      newRows[i][16] = toStatus;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ==== action:'markReturned' -- ordinary (non-early) return. Byte-for-
  // byte port of bikes.html's performMarkReturned, PLUS the same
  // clientTxnId idempotency guard swap got (see file header comment) --
  // here the marker tags the SAME row being modified, not a new one, since
  // this action never creates a row. ====
  async function performMarkReturned(rowNumber, isoDate, clientTxnId) {
    if (clientTxnId) {
      const existingRow = await findExistingTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, idempotentReplay: true };
      }
    }
    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rowNumber - 1; // sheet row 1 = header = array index 0
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    newRows[idx][8] = isoDateInputToSheetValue(isoDate); // I returnDate
    newRows[idx][13] = 'Returned';                        // N situation
    const nameForContract = newRows[idx][2], bikeForContract = newRows[idx][5];

    const writeResult = await writeSheetJson('customer', newRows, modifiedTime);

    const warnings = [];
    if (clientTxnId) {
      try { await markTxnIdFromJson(rowNumber, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
    }
    try {
      await flipMatchingContractStatus(nameForContract, bikeForContract, 'rented', 'Returned');
    } catch (err) {
      warnings.push('Bike marked returned, but the matching Contract record could not be updated automatically: ' + err.message);
    }
    return { success: true, warning: warnings.length ? warnings.join(' ') : null, modifiedTime: writeResult.modifiedTime };
  }

  // ---- performUpdateReturnPickup + its Contract-mirroring helper -- verbatim
  // port of bikes.html's copies (lines 1196-1264 in that file). ----
  async function mirrorDeliveryLinkToContract(name, bikeModel, deliveryLink) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      newRows[i][23] = deliveryLink; // X deliveryLink
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  async function performUpdateReturnPickup(rowNumber, isoDate, hhmm, deliveryLink) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    newRows[idx][9] = hhmmToSheetTimeValue(hhmm);          // J returnTime
    newRows[idx][18] = isoDateInputToSheetValue(isoDate);   // S confirmedReturnDate
    newRows[idx][17] = true;                                 // R timeConfirmed
    const deliveryLinkProvided = deliveryLink !== undefined && deliveryLink !== null;
    if (deliveryLinkProvided) newRows[idx][19] = deliveryLink; // T pickupLink
    const nameForContract = newRows[idx][2], bikeForContract = newRows[idx][5];

    const writeResult = await writeSheetJson('customer', newRows, modifiedTime);

    let warning = null;
    if (deliveryLinkProvided) {
      try {
        await mirrorDeliveryLinkToContract(nameForContract, bikeForContract, deliveryLink);
      } catch (err) {
        warning = 'Saved, but could not mirror the delivery link onto the matching Contract record: ' + err.message;
      }
    }
    return { success: true, warning, modifiedTime: writeResult.modifiedTime };
  }

  // ---- Deposit-tracking constants -- verbatim port of bikes.html's copies. ----
  const DEPOSIT_CATEGORIES_B = [
    { key: 'bank', label: 'Bank', header: 'deposit scan', dateCol: 15, amountCol: 16, nameCol: 17 },
    { key: 'wise', label: 'Wise', header: 'deposit wise', dateCol: 18, amountCol: 19, nameCol: 20 },
    { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24 }
  ];
  // Deposit category key -> the payment-method label used everywhere else
  // in the app -- NOT DEPOSIT_CATEGORIES_B's own .label, which is just
  // that tracking table's display heading. "bank" deposits are actually
  // paid via Scan/Thai QR, hence "Scan" here.
  const DEPOSIT_CATEGORY_PAID_BY_B = { bank: 'Scan', wise: 'Wise', revolut: 'Revolut' };
  function todayIso() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---- appendEarlyReturnRefundToLedgerFromJson -- verbatim port. ----
  async function appendEarlyReturnRefundToLedgerFromJson(rowNumber, returnDateValue, returnDmy, refundAmount, actualAmount) {
    const { rows: noteRows, modifiedTime: noteModifiedTime } = await fetchSheetWithMeta('customer_notes');
    const existingNoteEntry = (noteRows || []).find(n => n[0] === rowNumber && n[1] === LEDGER_CONTACT_COL_B);
    const noteText = existingNoteEntry ? (existingNoteEntry[2] || '') : '';
    const priorTotal = parseLedgerTotal(noteText);
    let body = stripLedgerTotalLineB(noteText);

    let dayDelta = 0;
    if (body) {
      const lines = body.split('\n');
      const lastLine = lines[lines.length - 1];
      const lm = lastLine.match(/^(.*?) — (\d{1,2}\/\d{1,2}\/\d{4}) to \d{1,2}\/\d{1,2}\/\d{4} \(([\d.]+) days?\) — ฿([\d,]+(?:\.\d+)?)$/);
      if (lm) {
        const lineBikeModel = lm[1];
        const lineFromDmy = lm[2];
        const lineOriginalDays = Number(lm[3]) || 0;
        const lineFromDate = parseDmyOrIsoToDateSwapB(lineFromDmy);
        if (lineFromDate && lineFromDate.getTime() <= returnDateValue.getTime()) {
          const actualDays = Math.max(1, Math.round((returnDateValue - lineFromDate) / 86400000));
          lines[lines.length - 1] = lineBikeModel + ' — ' + lineFromDmy + ' to ' + returnDmy +
            ' (' + actualDays + (actualDays === 1 ? ' day' : ' days') + ') — ฿' + formatMoneyForLedgerB(actualAmount);
          dayDelta = actualDays - lineOriginalDays;
          body = lines.join('\n');
        }
      }
    }

    const refundLine = 'Refund for early return ' + returnDmy + ' — -฿' + formatMoneyForLedgerB(refundAmount);
    const newBody = (body ? body + '\n' : '') + refundLine;

    const newTotalDays = priorTotal.days + dayDelta;
    const newTotalAmount = priorTotal.amount - refundAmount;
    const targetNote = newBody + '\nTotal: ' + newTotalDays + ' days, ฿' + formatMoneyForLedgerB(newTotalAmount);

    const newNoteRows = (noteRows || []).filter(n => !(n[0] === rowNumber && n[1] === LEDGER_CONTACT_COL_B));
    newNoteRows.push([rowNumber, LEDGER_CONTACT_COL_B, targetNote]);
    await writeSheetJson('customer_notes', newNoteRows, noteModifiedTime);

    const { rows: custRows, modifiedTime: custModifiedTime } = await fetchSheetWithMeta('customer');
    const newCustRows = custRows.map(r => r.slice());
    const targetRow = newCustRows[rowNumber - 1];
    while (targetRow.length <= LEDGER_CONTACT_COL_B - 1) targetRow.push('');
    const currentContact = (targetRow[LEDGER_CONTACT_COL_B - 1] || '').toString();
    const isDeal = /\bDeal\s*$/i.test(currentContact.trim());
    const baseContact = stripAllTrailingParensAndDealB(currentContact);
    const targetBracket = ' (฿' + formatMoneyForLedgerB(newTotalAmount) + ', ' + newTotalDays + ' days)';
    const targetContact = baseContact + targetBracket + (isDeal ? ' Deal' : '');
    targetRow[LEDGER_CONTACT_COL_B - 1] = targetContact;
    await writeSheetJson('customer', newCustRows, custModifiedTime);

    return { totalDays: newTotalDays, totalAmount: newTotalAmount };
  }

  // ---- appendEarlyReturnRefundIncomeRowFromJson -- verbatim port. KNOWN
  // QUIRK preserved: no 'scan'->'QR scan' conversion, refundPaidBy written
  // verbatim (same as appendSwapUpgradeIncomeRowFromJson above). ----
  async function appendEarlyReturnRefundIncomeRowFromJson(bikeModel, customerName, negAmount, paidBy) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) {
      throw new Error('no tab named "' + monthName + '" was found, so the refund was NOT logged on the monthly income sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [6, 7, 8, 9, 10]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 10) row.push('');
    const description = (bikeModel || '').toString().trim() + ' refund - early return';
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[5] = isoDateInputToSheetValue(nowIso);
    row[6] = description;
    row[7] = customerName || '';
    row[8] = Number(negAmount) || 0;
    row[9] = (paidBy || '').toString().trim();
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'appendEarlyReturnRefundIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(row[8]) + ' — ' + description + (customerName ? (' from ' + customerName) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });
    return description;
  }

  // ==== action:'earlyReturnBike' -- return with an optional refund for
  // unused days. Byte-for-byte port of bikes.html's earlyReturnBikeFromJson,
  // PLUS the clientTxnId idempotency guard (marker tags the row being
  // modified, same as markReturned above). ORDERING MATTERS (ported
  // faithfully, see bikes.html's own big comment on the Alex John Milne /
  // Aerox red bug this fixed, 21/07/2026): Contract return-date sync +
  // total-price subtraction must run WHILE status is still "rented" --
  // both only match a row in that state -- so they run BEFORE the status
  // flip to Returned, which is deliberately the LAST Contract write. ====
  async function earlyReturnBikeFromJson(data) {
    const rowNumber = parseInt(data.rowNumber, 10);
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid row number.');
    if (!data.returnDate) throw new Error('No return date given.');
    const refundAmount = Number(data.refundAmount);
    if (isNaN(refundAmount) || refundAmount < 0) throw new Error('Refund amount must be a number of 0 or more.');
    const refundPaidBy = (data.refundPaidBy || '').toString().trim();
    if (refundAmount > 0 && !refundPaidBy) {
      throw new Error('A refund amount was given but no payment type was selected for it.');
    }
    const dm = String(data.returnDate).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!dm) throw new Error('Return date must be in yyyy-MM-dd format.');

    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, idempotentReplay: true };
      }
    }

    const returnDateValue = new Date(parseInt(dm[1], 10), parseInt(dm[2], 10) - 1, parseInt(dm[3], 10));
    const returnDmy = formatDmyJson(returnDateValue);
    const returnIsoYmd = returnDateValue.getFullYear() + '-' + pad2Json(returnDateValue.getMonth() + 1) + '-' + pad2Json(returnDateValue.getDate());

    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    const row = newRows[idx].slice();
    while (row.length < 14) row.push('');

    const customerName = row[2] || '';
    const bikeModel = row[5] || '';

    row[8] = isoDateInputToSheetValue(returnIsoYmd); // I returnDate
    row[13] = 'Returned';                             // N situation

    let newTotalPrice = null;
    if (refundAmount > 0) {
      let oldTotalPrice = Number(row[11]);
      if (isNaN(oldTotalPrice)) oldTotalPrice = 0;
      if (refundAmount > oldTotalPrice + 0.01) {
        throw new Error('Refund amount (' + refundAmount + ') cannot be more than this booking\'s current total price (' + oldTotalPrice + ').');
      }
      newTotalPrice = oldTotalPrice - refundAmount;
      row[11] = newTotalPrice; // L totalPrice
    }
    newRows[idx] = row;

    await writeSheetJson('customer', newRows, modifiedTime);

    const warnings = [];
    if (clientTxnId) {
      try { await markTxnIdFromJson(rowNumber, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
    }

    try {
      await syncContractReturnDateOnlyFromJson(customerName, bikeModel, returnDateValue);
    } catch (contractDateErr) { warnings.push('Contract return date sync: ' + contractDateErr.message); }

    if (refundAmount > 0) {
      try {
        await addAmountToContractRowFromJson(customerName, bikeModel, -refundAmount);
      } catch (contractAmountErr) { warnings.push('Contract total price sync: ' + contractAmountErr.message); }

      try {
        await appendEarlyReturnRefundToLedgerFromJson(rowNumber, returnDateValue, returnDmy, refundAmount, newTotalPrice);
      } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }
    }

    try {
      await flipMatchingContractStatus(customerName, bikeModel, 'rented', 'Returned');
    } catch (contractStatusErr) { warnings.push('Contract status update: ' + contractStatusErr.message); }

    if (refundAmount <= 0) {
      const responsePayloadPlain = { success: true };
      if (warnings.length) responsePayloadPlain.warning = warnings.join(' ');
      return responsePayloadPlain;
    }

    const negRefundAmount = -refundAmount;
    try {
      await addRentalAmountToBikesSheetFromJson(bikeModel, negRefundAmount);
    } catch (bikesErr) { warnings.push('Bikes sheet (' + bikeModel + '): ' + bikesErr.message); }

    try {
      const refundDescription = await appendEarlyReturnRefundIncomeRowFromJson(bikeModel, customerName, negRefundAmount, refundPaidBy);
      const refundPaidByLower = refundPaidBy.toLowerCase();
      try {
        if (refundPaidByLower === 'cash') {
          await appendCashSheetRowFromJson((customerName || '') + ' - ' + refundDescription, negRefundAmount);
        }
      } catch (refundCashErr) { warnings.push('Refund cash sheet: ' + refundCashErr.message); }
      try {
        if (refundPaidByLower === 'wise' || refundPaidByLower === 'revolut') {
          await processDepositForPaymentFromJson(refundPaidByLower, negRefundAmount);
        }
      } catch (refundDepositErr) { warnings.push('Refund deposit total: ' + refundDepositErr.message); }
    } catch (refundIncomeErr) { warnings.push('Refund income entry: ' + refundIncomeErr.message); }

    const responsePayload = { success: true };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- setBikeSplitsNoteFromJsonB -- verbatim port. ----
  async function setBikeSplitsNoteFromJsonB(monthName, year, row, colIdx1, splits) {
    const clean = (splits || [])
      .map(s => ({ bike: (s.bike || '').toString().trim(), amount: (s.amount !== '' && s.amount !== null && s.amount !== undefined && !isNaN(Number(s.amount))) ? Number(s.amount) : '' }))
      .filter(s => s.bike && s.amount !== '');
    const notesSheet = monthName + '_notes';
    const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta(notesSheet, year);
    const filtered = (noteRows || []).filter(n => !(n[0] === row && n[1] === colIdx1));
    if (clean.length) filtered.push([row, colIdx1, JSON.stringify(clean)]);
    await writeSheetJson(notesSheet, filtered, modifiedTime, year);
  }

  // ---- appendCashExpenseRowFromJson -- verbatim port. ----
  async function appendCashExpenseRowFromJson(expenseText, rawAmount) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
    if (!rows || !rows.length) {
      throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [5, 6, 7]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 7) row.push('');
    const amountValue = (rawAmount !== '' && rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) ? Number(rawAmount) : '';
    row[4] = isoDateInputToSheetValue(todayIso());
    row[5] = expenseText;
    row[6] = amountValue;
    newRows[targetIdx] = row;
    await writeSheetJson('cash', newRows, modifiedTime);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'appendCashExpenseRowFromJson', reversible: true,
      summary: 'Cash expense ' + fmtMoneyB(amountValue) + ' — ' + (expenseText || '(no description)'),
      writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [5, 6, 7], before: ['', '', ''], after: [row[4], row[5], row[6]] }]
    });
  }

  // ---- writeDepositTransferIncomeRowFromJson / writeDepositTransferExpenseRowFromJson
  // -- verbatim ports, the "release"/"payout" halves of a cross-method
  // deposit return (see returnDepositFromJson's own block comment below). ----
  async function writeDepositTransferIncomeRowFromJson(paidByLabel, amount, customerName, description) {
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
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[5] = isoDateInputToSheetValue(nowIso);
    row[6] = description;
    row[7] = customerName || '';
    row[8] = Number(amount) || 0;
    row[9] = paidByLabel;
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'writeDepositTransferIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(row[8]) + ' — ' + (description || '(no description)') + (customerName ? (' from ' + customerName) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });

    const paidByLower = (paidByLabel || '').toString().trim().toLowerCase();
    if (paidByLower === 'cash') {
      await appendCashSheetRowFromJson(description, amount);
    }
  }
  async function writeDepositTransferExpenseRowFromJson(paidByLabel, amount, description) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) {
      throw new Error('no tab named "' + monthName + '" was found, so this entry was NOT logged on the monthly expense sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [1, 2, 3, 4]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 4) row.push('');
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[0] = isoDateInputToSheetValue(nowIso);
    row[1] = description;
    row[2] = Number(amount) || 0;
    row[3] = paidByLabel;
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'writeDepositTransferExpenseRowFromJson', reversible: true,
      summary: 'Expense ' + fmtMoneyB(row[2]) + ' — ' + (description || '(no description)') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [1, 2, 3, 4], before: ['', '', '', ''], after: [row[0], row[1], row[2], row[3]] }]
    });
    // KNOWN GAP (preserved from bikes.html): Code.gs also color-tags this
    // expense row 'business' here -- not ported, same as accounts.html's
    // identical documented gap.
    const paidByLower = (paidByLabel || '').toString().trim().toLowerCase();
    if (paidByLower === 'cash') {
      await appendCashExpenseRowFromJson(description, amount);
    }
  }
  async function releaseDepositIntoBucketFromJson(category, amount, customerName, bikeModel) {
    const paidByLabel = category === 'cash' ? 'Cash' : (DEPOSIT_CATEGORY_PAID_BY_B[category] || category);
    const bucketLabel = category === 'bank' ? 'Bank' : paidByLabel;
    const description = (bikeModel ? bikeModel + ', ' : '') + 'Deposit released (' + bucketLabel + ') for ' + (customerName || '');
    await writeDepositTransferIncomeRowFromJson(paidByLabel, amount, customerName, description);
    if (category === 'wise' || category === 'revolut') {
      await processDepositForPaymentFromJson(category, amount);
    }
  }
  async function payDepositOutOfBucketFromJson(method, amount, customerName, bikeModel) {
    const paidByLabel = method === 'cash' ? 'Cash' : (DEPOSIT_CATEGORY_PAID_BY_B[method] || method);
    const bucketLabel = method === 'bank' ? 'Bank' : paidByLabel;
    const description = (bikeModel ? bikeModel + ', ' : '') + 'Deposit paid out via ' + bucketLabel + ' for ' + (customerName || '');
    await writeDepositTransferExpenseRowFromJson(paidByLabel, amount, description);
    if (method === 'wise' || method === 'revolut') {
      await processDepositForPaymentFromJson(method, -amount);
    }
  }

  // ==== action:'returnDeposit' -- the Return popup's deposit section.
  // Byte-for-byte port of bikes.html's returnDepositFromJson. THREE
  // independent, best-effort steps (a problem in one never undoes the
  // others) -- see bikes.html's own long comment for the full "worked out
  // with Anton on 2026-07-21" design reasoning:
  //   1. Clear the matched security-deposit entry (if any).
  //   2. Log a deduction (if any) as ordinary income, routed by payment
  //      method, with a bike-split note and a "bikes" sheet bump.
  //   3. Cross-method release+payout when the deposit is being handed back
  //      via a DIFFERENT method than it was held under.
  //
  // NOT given a clientTxnId idempotency guard in this pass, unlike
  // markReturned/earlyReturnBike/swapBike above -- this action has no
  // customer-sheet row of its own to tag a marker onto (its payload only
  // carries a DEPOSIT row/category, never the customer row number), so the
  // same technique doesn't directly apply. Flagged as a genuine open
  // design question in PROGRESS.md's inventory entry (same "two chained-
  // call actions need an explicit decision" note) rather than silently
  // shipped without protection -- bikes.html's own client version has the
  // exact same gap today (no duplicate-submit guard at all), so this is
  // NOT a regression, just not yet an improvement either. ====
  async function returnDepositFromJson(data) {
    const isCash = (data.category || '').toString().trim().toLowerCase() === 'cash';
    let cat = null;
    if (!isCash) {
      cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.category);
      if (!cat) throw new Error('Unrecognized deposit category "' + data.category + '".');
    }

    const depositRowRaw = Math.round(Number(data.row));
    const hasRow = !isCash && data.row !== null && data.row !== undefined && data.row !== '' && !isNaN(depositRowRaw) && depositRowRaw >= 2;

    const warnings = [];

    if (hasRow) {
      try {
        const now = new Date();
        const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
        const year = now.getFullYear();
        const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
        if (!rows || !rows.length) throw new Error('no sheet found for the current month -- the deposit was NOT cleared.');
        const headerRaw = rows[0] ? rows[0][cat.dateCol - 1] : undefined;
        if ((headerRaw || '').toString().trim().toLowerCase() !== cat.header) {
          throw new Error('expected "' + cat.header + '" header on the "' + monthName + '" sheet -- the deposit was NOT cleared.');
        }
        const newRows = rows.map(r => r.slice());
        const targetRow = newRows[depositRowRaw - 1] ? newRows[depositRowRaw - 1].slice() : null;
        if (!targetRow) throw new Error('row ' + depositRowRaw + ' does not exist on the "' + monthName + '" sheet -- the deposit was NOT cleared.');
        while (targetRow.length < cat.nameCol) targetRow.push('');
        const clearedBefore = [targetRow[cat.dateCol - 1], targetRow[cat.amountCol - 1], targetRow[cat.nameCol - 1]];
        targetRow[cat.dateCol - 1] = '';
        targetRow[cat.amountCol - 1] = '';
        targetRow[cat.nameCol - 1] = '';
        newRows[depositRowRaw - 1] = targetRow;
        await writeSheetJson(monthName, newRows, modifiedTime, year);
        await logTransactionB({
          page: 'bikes.html', action: 'returnDepositFromJson:clear', reversible: true,
          summary: 'Cleared ' + cat.label + ' deposit' + (clearedBefore[2] ? (' — ' + clearedBefore[2]) : '') + ' (' + monthName + ' ' + year + ')',
          writes: [{ sheet: monthName, year: year, row: depositRowRaw, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: clearedBefore, after: ['', '', ''] }]
        });
      } catch (clearErr) { warnings.push('Clearing deposit: ' + clearErr.message); }
      await recomputeCurrentMonthSummaryCascadeB();
    }

    const deduction = Number(data.deductionAmount);
    let incomeRowNum = null;
    if (!isNaN(deduction) && deduction > 0) {
      try {
        const paidByLabel = isCash ? 'Cash' : (DEPOSIT_CATEGORY_PAID_BY_B[data.category] || cat.label);
        const now = new Date();
        const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
        const year = now.getFullYear();
        const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
        if (!rows || !rows.length) throw new Error('no tab named "' + monthName + '" was found, so this deduction was NOT logged on the monthly income sheet.');
        const newRows = rows.map(r => r.slice());
        const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [6, 7, 8, 9, 10]);
        while (newRows.length <= targetIdx) newRows.push([]);
        const row = newRows[targetIdx].slice();
        while (row.length < 10) row.push('');
        const reasonText = (data.reason || '').toString().trim();
        const bikeNameForDescription = (data.bikeModel || '').toString().trim();
        const description = (bikeNameForDescription ? bikeNameForDescription + ', ' : '') + 'Deposit returned for ' + reasonText;
        const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
        row[5] = isoDateInputToSheetValue(nowIso);
        row[6] = description;
        row[7] = data.customerName || '';
        row[8] = deduction;
        row[9] = paidByLabel;
        newRows[targetIdx] = row;
        incomeRowNum = targetIdx + 1;
        await writeSheetJson(monthName, newRows, modifiedTime, year);
        await logTransactionB({
          page: 'bikes.html', action: 'returnDepositFromJson:deductionIncome', reversible: true,
          summary: 'Income ' + fmtMoneyB(deduction) + ' — ' + description + (data.customerName ? (' from ' + data.customerName) : '') + ' (' + monthName + ' ' + year + ')',
          writes: [{ sheet: monthName, year: year, row: incomeRowNum, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
        });

        try {
          await setBikeSplitsNoteFromJsonB(monthName, year, incomeRowNum, 7, [{ bike: data.bikeModel || '', amount: deduction }]);
        } catch (splitErr) { /* best-effort, matches Code.gs's setIncomeBikeSplits which never throws */ }

        const paidByLower = paidByLabel.toString().trim().toLowerCase();
        try {
          if (paidByLower === 'cash') {
            await appendCashSheetRowFromJson(description, deduction);
          } else if (paidByLower === 'wise' || paidByLower === 'revolut') {
            await processDepositForPaymentFromJson(paidByLower, deduction);
          }
        } catch (depErr) { warnings.push((paidByLower === 'cash' ? 'Cash sheet: ' : 'Deposit total: ') + depErr.message); }

        try {
          await addRentalAmountToBikesSheetForMonthFromJson(data.bikeModel, deduction, monthName);
        } catch (bikeErr) { warnings.push('Bikes sheet (income): ' + bikeErr.message); }
      } catch (incomeErr) { warnings.push('Deduction income: ' + incomeErr.message); }
      await recomputeCurrentMonthSummaryCascadeB();
    }

    const originalCategory = isCash ? 'cash' : (data.category || '').toString().trim().toLowerCase();
    const returnedVia = (data.returnedVia || '').toString().trim().toLowerCase();
    const crossAmount = Number(data.returnedViaAmount);
    if (returnedVia && originalCategory && returnedVia !== originalCategory && !isNaN(crossAmount) && crossAmount > 0) {
      try {
        await releaseDepositIntoBucketFromJson(originalCategory, crossAmount, data.customerName || '', data.bikeModel || '');
      } catch (releaseErr) { warnings.push('Releasing ' + originalCategory + ' deposit: ' + releaseErr.message); }
      try {
        await payDepositOutOfBucketFromJson(returnedVia, crossAmount, data.customerName || '', data.bikeModel || '');
      } catch (payoutErr) { warnings.push('Paying out via ' + returnedVia + ': ' + payoutErr.message); }
    }

    const responsePayload = { success: true, incomeRow: incomeRowNum };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- appendSwapUpgradeIncomeRowFromJson -- verbatim port. ----
  async function appendSwapUpgradeIncomeRowFromJson(bikeModel, name, amount, paidBy) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) {
      throw new Error('no tab named "' + monthName + '" was found, so the upgrade charge was NOT logged on the monthly income sheet.');
    }
    const newRows = rows.map(r => r.slice());
    const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [6, 7, 8, 9, 10]);
    while (newRows.length <= targetIdx) newRows.push([]);
    const row = newRows[targetIdx].slice();
    while (row.length < 10) row.push('');
    const description = (bikeModel || '').toString().trim() + ' upgrade';
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[5] = isoDateInputToSheetValue(nowIso);
    row[6] = description;
    row[7] = name || '';
    row[8] = Number(amount) || 0;
    row[9] = (paidBy || '').toString().trim(); // verbatim -- KNOWN QUIRK, see bikes.html's own comment: no 'scan'->'QR scan' conversion here
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'appendSwapUpgradeIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(row[8]) + ' — ' + description + (name ? (' from ' + name) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });
    return description;
  }

  // ---- NEW (server port only): generic idempotency guard, shared by
  // every ported action that touches ONE customer-sheet row (swap tags
  // the brand-new row it creates; markReturned/earlyReturnBike tag the
  // SAME row they modify -- either way, "is there already a
  // customer_notes marker for this clientTxnId" is the same question).
  // See file header comment for the full "why". Scans customer_notes for
  // a row already tagged with this clientTxnId in IDEMPOTENCY_NOTE_COL_B;
  // returns that row's number if found, else null. ----
  async function findExistingTxnMarkerFromJson(clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('customer_notes'));
    } catch (e) {
      return null; // notes sidecar unreadable -- fail open, same convention as accounts.html's findExistingAddTxnRowFromJson
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
      // Best-effort -- if this fails, worst case a retry under the same
      // clientTxnId isn't caught and creates a genuine duplicate. Flagged,
      // not silently accepted: surfaced as a warning by the caller.
      console.warn('[bikesWrites] Could not record idempotency marker:', e.message);
      throw e;
    }
  }

  // ==== action:'swapBike' -- see PROGRESS.md's traced inventory for the
  // full picture. Byte-for-byte port of bikes.html's own swapBikeFromJson,
  // PLUS the idempotency check/mark wrapped around the core write (the one
  // genuinely new piece -- see file header comment). ====
  async function swapBikeFromJson(data) {
    // ---- Idempotency check FIRST, before any validation/writes -- a
    // retried request with the same clientTxnId should short-circuit to
    // the already-saved result even if, say, the amounts look "wrong" on
    // a replay due to something else having changed in the meantime; the
    // point is "did THIS request already happen", not "is this request
    // valid right now". ----
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, newRowNumber: existingRow, idempotentReplay: true };
      }
    }

    const rowNumber = parseInt(data.rowNumber, 10);
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid row number.');
    const newBikeModel = (data.newBikeModel || '').toString().trim();
    if (!newBikeModel) throw new Error('No new bike given.');
    const returnAmount = Number(data.returnAmount);
    const newBikeAmount = Number(data.newBikeAmount);
    if (isNaN(returnAmount) || returnAmount < 0 || isNaN(newBikeAmount) || newBikeAmount < 0) {
      throw new Error('Both amounts must be numbers of 0 or more.');
    }
    const additionalAmount = Number(data.additionalAmount) || 0;
    if (additionalAmount < 0) throw new Error('Additional amount must be 0 or more.');
    const additionalPaidBy = (data.additionalPaidBy || '').toString().trim();
    if (additionalAmount > 0 && !additionalPaidBy) {
      throw new Error('An additional amount was given but no payment type was selected for it.');
    }
    if (!data.returnDate) throw new Error('No return date given.');
    const dm = String(data.returnDate).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!dm) throw new Error('Return date must be in yyyy-MM-dd format.');
    const todayValue = new Date(parseInt(dm[1], 10), parseInt(dm[2], 10) - 1, parseInt(dm[3], 10));
    const todayDmy = formatDmyJson(todayValue);
    const todayIsoYmd = todayValue.getFullYear() + '-' + pad2Json(todayValue.getMonth() + 1) + '-' + pad2Json(todayValue.getDate());

    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    const oldRow = newRows[idx].slice();
    while (oldRow.length < 14) oldRow.push('');

    const oldBikeModel = (oldRow[5] || '').toString().trim();
    let oldTotalPrice = Number(oldRow[11]);
    if (isNaN(oldTotalPrice)) oldTotalPrice = 0;

    if (Math.abs((returnAmount + newBikeAmount) - oldTotalPrice) > 0.01) {
      throw new Error('Return amount (' + returnAmount + ') + new bike amount (' + newBikeAmount +
        ') must add up to this booking\'s current total price (' + oldTotalPrice + ').');
    }

    const origRentFromRaw = oldRow[7];
    const origReturnDateRaw = oldRow[8];
    const origReturnTimeRaw = oldRow[9];
    const contact = oldRow[1] || '';
    const name = oldRow[2] || '';
    const nationality = oldRow[3] || '';
    const passport = oldRow[4] || '';
    const deliverToHotel = oldRow[10] || '';
    const paidBy = oldRow[12] || '';

    // ---- 1) Close out the old row ----
    oldRow[11] = returnAmount;                          // L totalPrice
    oldRow[8] = isoDateInputToSheetValue(todayIsoYmd);   // I returnDate
    oldRow[13] = 'Returned';                             // N situation
    newRows[idx] = oldRow;

    // ---- 2) Append a brand-new row for the new bike ----
    const newRowTotalPrice = newBikeAmount + additionalAmount;
    const newRow = new Array(16).fill('');
    newRow[0] = isoDateInputToSheetValue(todayIsoYmd);
    newRow[1] = contact;
    newRow[2] = name;
    newRow[3] = nationality;
    newRow[4] = passport;
    newRow[5] = newBikeModel;
    newRow[6] = '';
    newRow[7] = isoDateInputToSheetValue(todayIsoYmd);
    newRow[8] = origReturnDateRaw;
    newRow[9] = origReturnTimeRaw;
    newRow[10] = deliverToHotel;
    newRow[11] = newRowTotalPrice;
    newRow[12] = paidBy;
    newRow[13] = '';
    newRow[14] = '';
    newRow[15] = '';
    newRows.push(newRow);
    const newRowNumber = newRows.length;

    await writeSheetJson('customer', newRows, modifiedTime);

    // ---- Idempotency marker, written right after the core write succeeds
    // -- if THIS fails, the write itself is already safely done; a retry
    // under the same clientTxnId would just fail to find the marker and
    // (rarely) create a genuine duplicate. Surfaced as part of `warnings`
    // rather than thrown, so it never looks like the swap itself failed. ----
    const warnings = [];
    if (clientTxnId) {
      try { await markTxnIdFromJson(newRowNumber, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
    }

    const origReturnDateForDiff = decodeSheetDate(origReturnDateRaw) || parseDmyOrIsoToDateSwapB(origReturnDateRaw);
    const origReturnDmy = origReturnDateForDiff ? formatDmyJson(origReturnDateForDiff) : (origReturnDateRaw || '').toString().trim();

    // ---- 3) Ledger note surgery ----
    try {
      const { rows: noteRows } = await fetchSheetWithMeta('customer_notes');
      const oldNoteEntry = (noteRows || []).find(n => n[0] === rowNumber && n[1] === LEDGER_CONTACT_COL_B);
      const swapOldNote = oldNoteEntry ? (oldNoteEntry[2] || '') : '';

      const noteFix = shortenLastLedgerLineForSwapFromJson(swapOldNote, todayValue, todayDmy, returnAmount);
      const correctedOldNote = noteFix.note;

      let swapLineFromDmy, swapLineDays, swapLineAmount;
      if (noteFix.newLineFromDmy) {
        swapLineFromDmy = noteFix.newLineFromDmy;
        swapLineDays = noteFix.newLineDays;
        swapLineAmount = noteFix.newLineAmount + additionalAmount;
      } else {
        swapLineFromDmy = todayDmy;
        swapLineDays = origReturnDateForDiff
          ? Math.max(1, Math.round((origReturnDateForDiff - todayValue) / 86400000))
          : 1;
        swapLineAmount = newBikeAmount + additionalAmount;
      }

      await appendLedgerEntryFromJson(newRowNumber, newBikeModel, swapLineFromDmy, origReturnDmy, swapLineDays, swapLineAmount, 0, additionalAmount, correctedOldNote, null);
    } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }

    try { await renameContractBikeOnSwapFromJson(name, oldBikeModel, newBikeModel); }
    catch (contractRenameErr) { warnings.push('Contract bike rename: ' + contractRenameErr.message); }

    try {
      if (origReturnDateForDiff) {
        await syncContractReturnDateOnlyFromJson(name, newBikeModel, origReturnDateForDiff);
      } else {
        warnings.push('Contract return date sync: could not read the original return date -- skipped, please check by hand.');
      }
    } catch (contractSyncErr) { warnings.push('Contract return date sync: ' + contractSyncErr.message); }

    try {
      if (additionalAmount > 0) {
        await addAmountToContractRowFromJson(name, newBikeModel, additionalAmount);
      }
    } catch (contractAmountErr) { warnings.push('Contract total price sync: ' + contractAmountErr.message); }

    // ---- "bikes" sheet ----
    const startDateForMonth = decodeSheetDate(origRentFromRaw) || parseDmyOrIsoToDateSwapB(origRentFromRaw);
    const origMonthName = startDateForMonth ? DEPOSITS_MONTH_NAMES[startDateForMonth.getMonth()] : null;
    const currentMonthName = DEPOSITS_MONTH_NAMES[new Date().getMonth()];

    if (!origMonthName) {
      warnings.push('Could not determine the original rental\'s start month -- the "bikes" sheet totals for "' +
        oldBikeModel + '" and "' + newBikeModel + '" were NOT adjusted for the redistributed remainder. Please adjust them by hand.');
    } else {
      try { await addRentalAmountToBikesSheetForMonthFromJson(oldBikeModel, -newBikeAmount, origMonthName); }
      catch (bikesErr1) { warnings.push('Bikes sheet (' + oldBikeModel + '): ' + bikesErr1.message); }
      try { await addRentalAmountToBikesSheetForMonthFromJson(newBikeModel, newBikeAmount, origMonthName); }
      catch (bikesErr2) { warnings.push('Bikes sheet (' + newBikeModel + '): ' + bikesErr2.message); }
    }

    if (additionalAmount > 0) {
      try { await addRentalAmountToBikesSheetForMonthFromJson(newBikeModel, additionalAmount, currentMonthName); }
      catch (bikesErr3) { warnings.push('Bikes sheet (' + newBikeModel + ' upgrade): ' + bikesErr3.message); }
    }

    // ---- 4) Upgrade income entry ----
    if (additionalAmount > 0) {
      try {
        const upgradeDescription = await appendSwapUpgradeIncomeRowFromJson(newBikeModel, name, additionalAmount, additionalPaidBy);
        const additionalPaidByLower = additionalPaidBy.toLowerCase();
        try {
          if (additionalPaidByLower === 'cash') {
            await appendCashSheetRowFromJson(upgradeDescription, additionalAmount);
          }
        } catch (upgradeCashErr) { warnings.push('Upgrade cash sheet: ' + upgradeCashErr.message); }
        try {
          if (additionalPaidByLower === 'wise' || additionalPaidByLower === 'revolut') {
            await processDepositForPaymentFromJson(additionalPaidByLower, additionalAmount);
          }
        } catch (upgradeDepositErr) { warnings.push('Upgrade deposit total: ' + upgradeDepositErr.message); }
      } catch (upgradeIncomeErr) { warnings.push('Upgrade income entry: ' + upgradeIncomeErr.message); }
    }

    const responsePayload = { success: true, newRowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- action:'updateReturnPickup' -- byte-for-byte port of
  // performUpdateReturnPickup, see its definition earlier in this file
  // (right after performMarkReturned). No clientTxnId guard: unlike
  // markReturned/earlyReturnBike/extendBike this action never adds money or
  // appends a row -- it's a plain field overwrite (time/date/link), so a
  // retry converges to the same end state rather than double-applying
  // anything. This mirrors the original bikes.html, which also has no
  // idempotency handling for this action. ----

  // ---- extendBike (short extension) dependencies -- verbatim ports of
  // bikes.html's copies (lines 1313-1322 and 1405-1436 respectively). ----
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
    const nowIso = now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
    row[5] = isoDateInputToSheetValue(nowIso);
    row[6] = incomeText;
    row[7] = data.name || '';
    row[8] = amountValue;
    row[9] = paidDisplay;
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'bikes.html', action: 'appendMonthlyIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)') + (data.name ? (' from ' + data.name) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });
  }

  // ==== action:'extendBike' (SHORT extension only -- under 30 days, "1
  // month" checkbox not ticked; see bikes.html's own big comment on the
  // long-extension pair, which is NOT ported here -- that's
  // closeBikeForExtendFromJson + customerIntakeFromJson, a separate
  // two-write action still pending). Byte-for-byte port of
  // extendBikeRowFromJson, PLUS a clientTxnId idempotency guard (same
  // same-row-marker technique as performMarkReturned) since a retried
  // extend would otherwise double-add amountPaid to the total price, the
  // ledger note, the income sheet, and the bikes-sheet monthly total. ====
  async function extendBikeRowFromJson(data) {
    const rowNumber = parseInt(data.rowNumber, 10);
    if (!rowNumber || rowNumber < 2) throw new Error('Invalid row number.');
    const daysToExtend = parseInt(data.daysToExtend, 10);
    if (!daysToExtend || daysToExtend <= 0) throw new Error('Days to extend must be a positive number.');
    const amountPaid = parseFloat(data.amountPaid);
    if (isNaN(amountPaid) || amountPaid < 0) throw new Error('Amount paid must be a number.');
    const paidBy = (data.paidBy || '').toString().trim();
    if (!paidBy) throw new Error('Paid by is required.');

    const clientTxnId = data.clientTxnId;
    if (clientTxnId) {
      const existingRow = await findExistingTxnMarkerFromJson(clientTxnId);
      if (existingRow) {
        return { success: true, idempotentReplay: true };
      }
    }

    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    const row = newRows[idx].slice();
    while (row.length < 19) row.push('');

    let currentDate = decodeSheetDate(row[8]);
    if (!currentDate) {
      const m = String(row[8] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!m) throw new Error('Could not read the current return date to extend from.');
      currentDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    }
    const preExtendDueDate = new Date(currentDate.getTime());
    currentDate = new Date(currentDate.getTime());
    currentDate.setDate(currentDate.getDate() + daysToExtend);

    const newDueIso = currentDate.getFullYear() + '-' + pad2Json(currentDate.getMonth() + 1) + '-' + pad2Json(currentDate.getDate());
    row[8] = isoDateInputToSheetValue(newDueIso); // I returnDate
    row[17] = false;                               // R timeConfirmed -- due date moved, so any prior pickup confirmation no longer applies
    row[18] = '';                                  // S confirmedReturnDate
    const currentPrice = Number(row[11]) || 0;
    row[11] = currentPrice + amountPaid;            // L totalPrice
    row[12] = paidBy;                               // M paidBy
    const bikeModel = row[5], custName = row[2];
    newRows[idx] = row;

    await writeSheetJson('customer', newRows, modifiedTime);

    const warnings = [];
    if (clientTxnId) {
      try { await markTxnIdFromJson(rowNumber, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
    }

    try {
      const extendFromDmy = formatDmyJson(preExtendDueDate);
      const extendToDmy = formatDmyJson(currentDate);
      await appendLedgerEntryFromJson(rowNumber, bikeModel, extendFromDmy, extendToDmy, daysToExtend, amountPaid, daysToExtend, amountPaid, null, null);
    } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }

    try { await syncContractReturnDateOnlyFromJson(custName, bikeModel, currentDate); }
    catch (contractDateErr) { warnings.push('Contract return date sync: ' + contractDateErr.message); }

    try { await addAmountToContractRowFromJson(custName, bikeModel, amountPaid); }
    catch (contractAmountErr) { warnings.push('Contract total price sync: ' + contractAmountErr.message); }

    const incomeData = { bikeModel: bikeModel || '', name: custName || '', totalPrice: amountPaid, paidBy, source: 'extend' };
    try { await appendMonthlyIncomeRowFromJson(incomeData, daysToExtend); }
    catch (incomeErr) { warnings.push('Income sheet: ' + incomeErr.message); }

    try {
      if (paidBy.toLowerCase() === 'cash') {
        await appendCashSheetRowFromJson(buildRentalIncomeTextB(incomeData, daysToExtend), amountPaid);
      }
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }

    try {
      const paidByLower = paidBy.toLowerCase();
      if (paidByLower === 'wise' || paidByLower === 'revolut') {
        await processDepositForPaymentFromJson(paidByLower, amountPaid);
      }
    } catch (depositErr) { warnings.push('Deposit total: ' + depositErr.message); }

    if (data.paidFromDeposit) {
      warnings.push('This extension was marked as paid from an existing deposit, but drawing that down automatically is not ported yet -- please adjust the deposit log by hand.');
    }

    try { await addRentalAmountToBikesSheetFromJson(bikeModel, amountPaid); }
    catch (bikesErr) { warnings.push(bikesErr.message); }

    const responsePayload = { success: true };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }
  // ================== end extendBike (short extension) ==================

  // ---- Single-dispatch entry point, mirrors accountsWriteDispatch's
  // shape (see lib/accountsWrites.js / api/accounts/write.js). 6 of
  // bikes.html's 7 actions are implemented so far -- see file header
  // comment and PROGRESS.md for the full inventory and status. ----
  async function bikesWriteDispatch(body) {
    switch (body && body.action) {
      case 'swapBike':
        return swapBikeFromJson(body);
      case 'markReturned':
        return performMarkReturned(parseInt(body.rowNumber, 10), body.returnDate, body.clientTxnId);
      case 'earlyReturnBike':
        return earlyReturnBikeFromJson(body);
      case 'returnDeposit':
        return returnDepositFromJson(body);
      case 'updateReturnPickup':
        return performUpdateReturnPickup(parseInt(body.rowNumber, 10), body.returnDate, body.returnTime, body.deliveryLink);
      case 'extendBike':
        return extendBikeRowFromJson(body);
      default:
        throw new Error(
          'Unknown or not-yet-ported bikes.html write action: "' + (body && body.action) + '". ' +
          'Ported so far: swapBike, markReturned, earlyReturnBike, returnDeposit, updateReturnPickup, extendBike -- see PROGRESS.md\'s bikes.html write-layer entries for the full inventory and status.'
        );
    }
  }

  return {
    bikesWriteDispatch,
    swapBikeFromJson,
    performMarkReturned,
    earlyReturnBikeFromJson,
    returnDepositFromJson,
    performUpdateReturnPickup,
    extendBikeRowFromJson,
    // Exposed for the fake-Drive test harness, not used by
    // api/bikes/write.js itself (which only ever calls bikesWriteDispatch).
    recomputeMonthlySummaryCascadeB,
    recomputeCashSheetTotalsB,
    findExistingTxnMarkerFromJson
  };
}

module.exports = { createSheetIO, createBikesWrites };
