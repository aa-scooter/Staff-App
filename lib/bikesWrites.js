// ---- Server-side bikes.html write layer -- Phase 2 of the optimistic/
// idempotent-save rollout (see PROGRESS.md's "NEXT UP" entry and the
// "Phase 2, bikes.html write layer: INVENTORY/DESIGN DONE" entry for the
// full plan and the traced action inventory).
//
// STATUS (2026-08-17): only ONE of bikes.html's 7 write actions is ported
// so far -- 'swapBike'. This is deliberate: per the plan's own recommended
// approach ("port ONE action at a time... do not wire ANY optimistic-UI
// frontend changes until every action is ported and passing its backend
// test"), swap was picked first because it's the most self-contained (a
// single request, no chained second call, unlike the return+deposit-clear
// pair or the close-then-intake long-extension pair). The other 6 actions
// (markReturned, earlyReturnBike, returnDeposit, updateReturnPickup,
// extendBike-short, extendBike-long) are NOT ported yet -- calling any
// action other than 'swapBike' through bikesWriteDispatch below throws
// clearly rather than silently doing nothing.
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

  // ---- NEW (server port only): idempotency guard for swapBikeFromJson --
  // see file header comment for the full "why". Scans customer_notes for a
  // row already tagged with this clientTxnId in IDEMPOTENCY_NOTE_COL_B;
  // returns that row's number if found, else null. ----
  async function findExistingSwapByTxnIdFromJson(clientTxnId) {
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
  async function markSwapTxnIdFromJson(newRowNumber, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('customer_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === newRowNumber && n[1] === IDEMPOTENCY_NOTE_COL_B));
      newNoteRows.push([newRowNumber, IDEMPOTENCY_NOTE_COL_B, clientTxnId]);
      await writeSheetJson('customer_notes', newNoteRows, modifiedTime);
    } catch (e) {
      // Best-effort -- if this fails, worst case a retry under the same
      // clientTxnId isn't caught and creates a genuine duplicate. Flagged,
      // not silently accepted: surfaced as a warning by the caller.
      console.warn('[bikesWrites] Could not record swap idempotency marker:', e.message);
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
      const existingRow = await findExistingSwapByTxnIdFromJson(clientTxnId);
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
      try { await markSwapTxnIdFromJson(newRowNumber, clientTxnId); }
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

  // ---- Single-dispatch entry point, mirrors accountsWriteDispatch's
  // shape (see lib/accountsWrites.js / api/accounts/write.js). Only
  // 'swapBike' is implemented so far -- see file header comment. ----
  async function bikesWriteDispatch(body) {
    switch (body && body.action) {
      case 'swapBike':
        return swapBikeFromJson(body);
      default:
        throw new Error(
          'Unknown or not-yet-ported bikes.html write action: "' + (body && body.action) + '". ' +
          'Only "swapBike" is ported so far -- see PROGRESS.md\'s bikes.html write-layer entries for the full inventory and status.'
        );
    }
  }

  return {
    bikesWriteDispatch,
    swapBikeFromJson,
    // Exposed for the fake-Drive test harness, not used by
    // api/bikes/write.js itself (which only ever calls bikesWriteDispatch).
    recomputeMonthlySummaryCascadeB,
    recomputeCashSheetTotalsB,
    findExistingSwapByTxnIdFromJson
  };
}

module.exports = { createSheetIO, createBikesWrites };
