// ---- Server-side deposits.html write layer -- Phase 2 port (same rollout
// this project has been doing page-by-page: bikes.html -> contract.html ->
// deposits.html -> add-bikes.html -> customers.html). See PROGRESS.md for
// the full inventory/decision trail.
//
// SCOPE: all 5 of deposits.html's write-shaped functions are ported here --
// addDeposit, editDeposit, deleteDeposit, deductDeposit, deductCashDeposit.
// Unlike contract.html (which had document-generation actions deliberately
// left out of scope), deposits.html has no such actions -- these 5 are the
// whole write surface.
//
// ARCHITECTURE NOTE -- why this does NOT get its own api/deposits/write.js:
// Vercel's Hobby plan caps a project at 12 serverless functions (see the
// git history: "Consolidate contracts API routes... (Vercel Hobby-plan
// 12-function cap)" and "Actually remove old photos/* route files (root
// cause of the exceeded-function-cap deploy failure)" -- this has already
// broken a deploy once). The api/ directory is EXACTLY at 12 files as of
// this port. A new api/deposits/write.js would be a 13th and break
// deployment the same way. Since deposits.html already duplicates several
// of accounts.html's own helpers (looksLikeSummaryLabelJson,
// findAccountsFreeRowIdxJson, appendIncomeRowFromJson-equivalent, the
// monthly summary recompute cascade -- both pages operate on the same
// Income/Expense monthly sheet), routing deposits' 5 actions through the
// EXISTING api/accounts/write.js endpoint (see that file's own updated
// comment) is both the lowest-risk option (accounts.html's own dispatch
// path is completely untouched) and the most natural pairing. This file
// itself stays fully independent -- its own module, own action names, own
// idempotency markers -- only the physical ROUTING is shared, forced by
// the function-count ceiling, not a design preference.
//
// IDEMPOTENCY, decided per-action (mirrors contract.html's own per-action
// reasoning in lib/contractWrites.js's header comment):
//   - 'addDeposit': clientTxnId guard. Finds the first free gap row above
//     the totals row and writes into it -- a naive retry after a
//     dropped-connection success would find a DIFFERENT free row (the
//     first one is no longer free) and create a genuine duplicate deposit
//     entry. Marker lives on the current month's own `<month>_notes`
//     sidecar, column DEPOSITS_ADD_IDEMPOTENCY_COL_B=90 (a sentinel value,
//     nowhere near this sidecar's real data columns -- appendIncomeRowFromJson
//     already uses column 7 there for bike-split notes) -- keyed to the
//     newly-written deposit row, same [row, col, clientTxnId] shape as
//     contract.html's addContract guard.
//   - 'editDeposit': NO guard -- unconditionally overwrites the same 3
//     cells (date/amount/name) with the same values every time, so a
//     retry converges to the same end state (same reasoning as
//     contract.html's editContract).
//   - 'deleteDeposit': NO guard -- clears the same 3 cells to null every
//     time; a retry after an already-cleared row just re-clears already-
//     null cells, a harmless no-op. Even simpler than contract.html's
//     cancelContract fix -- there's no "throws on retry" failure mode to
//     even guard against here, since this function never checked for
//     "already cleared" as an error case in the first place.
//   - 'deductDeposit': clientTxnId guard, HIGH PRIORITY -- this is the
//     deposits.html equivalent of contract.html's customerIntake
//     double-booking risk, except with REAL MONEY: a naive retry after a
//     dropped-connection success would call consumeDepositFromJson AGAIN
//     on the (already-reduced) balance, deducting a SECOND time, logging a
//     SECOND Income row, bumping the bikes-sheet earnings and the
//     Wise/Revolut running total a second time, and mirroring a second
//     deduction onto the Contract row -- a genuine double-charge across 5
//     different sheets. Marker lives on the current month's own
//     `<month>_notes` sidecar, column DEPOSITS_DEDUCT_IDEMPOTENCY_COL_B=91
//     (distinct from the add-guard's column 90, even though collision risk
//     between the two is low -- kept separate for clarity, matching this
//     project's convention of one column per distinct guard), keyed to the
//     deposit row being deducted from (known up front, unlike addContract's
//     not-yet-created row).
//   - 'deductCashDeposit': clientTxnId guard, HIGH PRIORITY, same
//     real-money reasoning as deductDeposit -- a retry would deduct AGAIN
//     from the Contract row's already-reduced deposit amount. Marker lives
//     on Contract_notes, column DEPOSITS_CASH_DEDUCT_IDEMPOTENCY_COL_B=4
//     (Contract_notes already has column 2 = Deal flag and column 3 =
//     contract.html's own addContract guard, both owned by contract.html --
//     column 15 is ALSO already in use, by THIS file's own
//     applyDepositDeductionToContractFromJson, for the human-readable
//     deduction ledger note text, not a machine marker -- column 4 is the
//     first free slot). Only the "applied:true" branch needs a guard --
//     the "no cash deposit on file" branch never writes anything, so it's
//     already safely re-runnable with no marker needed.
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Identical to lib/contractWrites.js's createSheetIO (itself identical
// to lib/bikesWrites.js's/lib/accountsWrites.js's) -- see that file's own
// comment for the full "why" this is duplicated per-file rather than
// shared. ----
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

function createDepositsWrites(sheetIO) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- Transaction log -- verbatim port, same as lib/contractWrites.js's
  // own copy (server-adapted: sheetIO instead of fetch, ConflictError
  // instead of a raw 409 check). ----
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
      console.warn('[depositsWrites] Transaction log write failed (non-critical):', e && e.message);
    }
  }

  function fmtMoneyB(n) {
    const v = Number(n);
    return '฿' + (isNaN(v) ? '0' : v.toLocaleString('en-US'));
  }
  function formatMoneyForLedgerB(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // ---- Small date/format utilities -- verbatim port of deposits.html's
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
  function isoDateInputToSheetValue(isoDate) {
    const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  }
  function todaySheetDateValue() {
    const now = new Date();
    return `${now.getFullYear()}-${pad2Json(now.getMonth() + 1)}-${pad2Json(now.getDate())}T00:00:00`;
  }

  // ---- Contract-sheet name/bike matching -- verbatim port of
  // deposits.html's own copies (used by the deduct actions' Contract-row
  // lookup). ----
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

  const DEPOSIT_CATEGORIES_B = [
    { key: 'bank', label: 'Bank', header: 'deposit scan', dateCol: 15, amountCol: 16, nameCol: 17 },
    { key: 'wise', label: 'Wise', header: 'deposit wise', dateCol: 18, amountCol: 19, nameCol: 20 },
    { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24 }
  ];
  const DEPOSITS_MONTH_NAMES = ['January', 'February', 'march', 'april', 'may', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  function currentDepositsMonthYear() {
    const now = new Date();
    return { monthName: DEPOSITS_MONTH_NAMES[now.getMonth()], year: now.getFullYear() };
  }
  function assertDepositHeader(rows2D, cat, monthName, failureNote) {
    const raw = rows2D[0] ? rows2D[0][cat.dateCol - 1] : undefined;
    const norm = (raw || '').toString().trim().toLowerCase();
    if (norm !== cat.header) {
      throw new Error('"' + monthName + '" sheet: expected "' + cat.header + '" in column ' + cat.dateCol +
        ', row 1 but found "' + (raw || '(blank)') + '" -- ' + failureNote + '.');
    }
  }

  // ==== Monthly "Bank" balance / cash / deposit-log recompute cascade ====
  // Verbatim port of deposits.html's own copy (itself, per that file's own
  // comment, ported from accounts.html's copy) -- byte-identical to
  // lib/contractWrites.js's copy of the same cascade, confirmed during this
  // port. See lib/accountsWrites.js for the full formula derivation. ----
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
    catch (e) { console.warn('[depositsWrites] Summary totals recompute failed:', e.message); }
  }
  // ================== end recompute cascade ==================

  // ---- Idempotency marker helpers -- same [row, col, clientTxnId]
  // technique as contract.html's addContract/customerIntake guards, on two
  // DIFFERENT sidecars (see file header comment for why each action uses
  // which one and which column). ----
  const DEPOSITS_ADD_IDEMPOTENCY_COL_B = 90;    // <month>_notes -- addDeposit guard
  const DEPOSITS_DEDUCT_IDEMPOTENCY_COL_B = 91; // <month>_notes -- deductDeposit guard
  const DEPOSITS_CASH_DEDUCT_IDEMPOTENCY_COL_B = 4; // Contract_notes -- deductCashDeposit guard

  async function findExistingMonthNotesTxnMarkerFromJson(monthName, year, col, clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta(monthName + '_notes', year));
    } catch (e) {
      return null; // sidecar unreadable -- fail open, same convention as contract.html's guards
    }
    const hit = (noteRows || []).find(n => n[1] === col && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markMonthNotesTxnIdFromJson(monthName, year, col, row, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta(monthName + '_notes', year);
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === row && n[1] === col));
      newNoteRows.push([row, col, clientTxnId]);
      await writeSheetJson(monthName + '_notes', newNoteRows, modifiedTime, year);
    } catch (e) {
      console.warn('[depositsWrites] Could not record idempotency marker:', e.message);
      throw e;
    }
  }
  async function findExistingContractNotesTxnMarkerFromJson(col, clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('Contract_notes'));
    } catch (e) {
      return null;
    }
    const hit = (noteRows || []).find(n => n[1] === col && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markContractNotesTxnIdFromJson(col, row, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('Contract_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === row && n[1] === col));
      newNoteRows.push([row, col, clientTxnId]);
      await writeSheetJson('Contract_notes', newNoteRows, modifiedTime);
    } catch (e) {
      console.warn('[depositsWrites] Could not record idempotency marker:', e.message);
      throw e;
    }
  }

  // ---- action:'addDeposit' -- byte-for-byte port of deposits.html's own
  // addDepositEntryJson, PLUS a clientTxnId idempotency guard (see file
  // header comment for why). Finds the first free gap row above the
  // totals row and writes date/amount/name there -- nothing else on the
  // sheet is touched. ----
  async function addDepositEntryJson(data) {
    const { monthName, year } = currentDepositsMonthYear();
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingMonthNotesTxnMarkerFromJson(monthName, year, DEPOSITS_ADD_IDEMPOTENCY_COL_B, clientTxnId);
      if (existingRow) return { success: true, row: existingRow, idempotentReplay: true };
    }

    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.category);
    if (!cat) throw new Error('Unrecognized deposit category "' + data.category + '".');
    const amount = (data.amount === '' || data.amount === undefined || data.amount === null) ? NaN : Number(data.amount);
    if (isNaN(amount) || amount <= 0) throw new Error('Enter a valid deposit amount.');
    const name = (data.name || '').toString().trim();

    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    assertDepositHeader(rows, cat, monthName, 'the deposit was NOT added');

    let targetRow = null;
    for (let i = 1; i < rows.length; i++) {
      const dateRaw = rows[i][cat.dateCol - 1];
      if ((dateRaw || '').toString().trim().toLowerCase() === 'total') break;
      const dateEmpty = dateRaw === '' || dateRaw === null || dateRaw === undefined;
      const amtRaw = rows[i][cat.amountCol - 1];
      const amtEmpty = amtRaw === '' || amtRaw === null || amtRaw === undefined;
      const nameRaw = rows[i][cat.nameCol - 1];
      const nameEmpty = nameRaw === '' || nameRaw === null || nameRaw === undefined;
      if (dateEmpty && amtEmpty && nameEmpty) { targetRow = i + 1; break; }
    }
    if (!targetRow) {
      throw new Error('Could not find a free row above the totals row in the ' + cat.label +
        ' deposit section of "' + monthName + '" -- the deposit was NOT added.');
    }

    const newRows = rows.map(r => r.slice());
    const rowIdx = targetRow - 1;
    while (newRows.length <= rowIdx) newRows.push([]);
    newRows[rowIdx][cat.dateCol - 1] = data.date ? isoDateInputToSheetValue(data.date) : todaySheetDateValue();
    newRows[rowIdx][cat.amountCol - 1] = amount;
    newRows[rowIdx][cat.nameCol - 1] = name;

    await writeSheetJson(monthName, newRows, modifiedTime, year);

    const warnings = [];

    // PARALLELIZED 20/08/2026 -- see swapBikeFromJson in bikesWrites.js for
    // the full pattern writeup. The primary deposit write just above stays
    // sequential and BEFORE this block on purpose -- the cascade recompute
    // below re-fetches the "monthName" sheet fresh and needs to see the
    // just-added deposit row when it totals things up. Once that write has
    // landed, these three touch fully disjoint files (monthName_notes /
    // cash+monthName cascade / transactionLog) with no dependency on each
    // other, so they run concurrently.
    async function chainMarker() {
      if (clientTxnId) {
        try { await markMonthNotesTxnIdFromJson(monthName, year, DEPOSITS_ADD_IDEMPOTENCY_COL_B, targetRow, clientTxnId); }
        catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
      }
    }
    async function chainCascade() {
      await recomputeCurrentMonthSummaryCascadeB();
    }
    async function chainLog() {
      await logTransactionB({
        page: 'deposits.html', action: 'addDepositEntryJson', reversible: true,
        summary: cat.label + ' deposit ' + fmtMoneyB(amount) + (name ? (' — ' + name) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [{ sheet: monthName, year: year, row: targetRow, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: ['', '', ''], after: [newRows[rowIdx][cat.dateCol - 1], newRows[rowIdx][cat.amountCol - 1], newRows[rowIdx][cat.nameCol - 1]] }]
      });
    }

    await Promise.all([chainMarker(), chainCascade(), chainLog()]);

    const responsePayload = { success: true, row: targetRow };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- action:'editDeposit' -- byte-for-byte port of deposits.html's own
  // editDepositEntryJson. NO clientTxnId guard: unconditionally overwrites
  // the same 3 cells with the same values every time, so a retry converges
  // to the same end state (same reasoning as contract.html's editContract).
  // data: { category, row, date, name, amount }. ----
  async function editDepositEntryJson(data) {
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.category);
    if (!cat) throw new Error('Unrecognized deposit category "' + data.category + '".');
    const row = Math.round(Number(data.row));
    if (!row || row < 2) throw new Error('Invalid deposit row.');

    const { monthName, year } = currentDepositsMonthYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    assertDepositHeader(rows, cat, monthName, 'the deposit was NOT changed');

    const rowIdx = row - 1;
    const existingDate = rows[rowIdx] ? rows[rowIdx][cat.dateCol - 1] : undefined;
    if ((existingDate || '').toString().trim().toLowerCase() === 'total') {
      throw new Error('That row is the "' + cat.label + '" totals row, not a deposit -- it was NOT changed.');
    }

    const newAmount = (data.amount === '' || data.amount === undefined || data.amount === null) ? null : Number(data.amount);
    if (newAmount !== null && isNaN(newAmount)) throw new Error('Invalid amount.');
    const newName = (data.name || '').toString().trim();
    const newDate = data.date ? isoDateInputToSheetValue(data.date) : null;

    const beforeAmount = rows[rowIdx] ? rows[rowIdx][cat.amountCol - 1] : '';
    const beforeName = rows[rowIdx] ? rows[rowIdx][cat.nameCol - 1] : '';

    const newRows = rows.map(r => r.slice());
    newRows[rowIdx][cat.dateCol - 1] = newDate;
    newRows[rowIdx][cat.amountCol - 1] = newAmount;
    newRows[rowIdx][cat.nameCol - 1] = newName;

    await writeSheetJson(monthName, newRows, modifiedTime, year);

    // PARALLELIZED 20/08/2026 -- see addDepositEntryJson's own comment just
    // above for the full reasoning (same shape, minus the idempotency
    // marker this action doesn't have). Cascade recompute (cash+monthName)
    // and the transaction log write touch disjoint files with no
    // dependency on each other, so they run concurrently once the primary
    // edit write above has landed.
    await Promise.all([
      recomputeCurrentMonthSummaryCascadeB(),
      logTransactionB({
        page: 'deposits.html', action: 'editDepositEntryJson', reversible: true,
        summary: 'Edited ' + cat.label + ' deposit ' + fmtMoneyB(beforeAmount) + ' → ' + fmtMoneyB(newAmount) + (newName || beforeName ? (' — ' + (newName || beforeName)) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [{ sheet: monthName, year: year, row: row, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [existingDate, beforeAmount, beforeName], after: [newDate, newAmount, newName] }]
      })
    ]);
    return { success: true };
  }

  // ---- action:'deleteDeposit' -- byte-for-byte port of deposits.html's
  // own deleteDepositEntryJson. NO clientTxnId guard: clears the same 3
  // cells to null every time -- a retry re-clears already-null cells, a
  // harmless no-op. data: { category, row }. ----
  async function deleteDepositEntryJson(data) {
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.category);
    if (!cat) throw new Error('Unrecognized deposit category "' + data.category + '".');
    const row = Math.round(Number(data.row));
    if (!row || row < 2) throw new Error('Invalid deposit row.');

    const { monthName, year } = currentDepositsMonthYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    assertDepositHeader(rows, cat, monthName, 'the deposit was NOT removed');

    const rowIdx = row - 1;
    const existingDate = rows[rowIdx] ? rows[rowIdx][cat.dateCol - 1] : undefined;
    if ((existingDate || '').toString().trim().toLowerCase() === 'total') {
      throw new Error('That row is the "' + cat.label + '" totals row, not a deposit -- it was NOT removed.');
    }

    const clearedAmount = rows[rowIdx] ? rows[rowIdx][cat.amountCol - 1] : '';
    const clearedName = rows[rowIdx] ? rows[rowIdx][cat.nameCol - 1] : '';

    const newRows = rows.map(r => r.slice());
    newRows[rowIdx][cat.dateCol - 1] = null;
    newRows[rowIdx][cat.amountCol - 1] = null;
    newRows[rowIdx][cat.nameCol - 1] = null;

    await writeSheetJson(monthName, newRows, modifiedTime, year);

    // PARALLELIZED 20/08/2026 -- see addDepositEntryJson's own comment
    // above for the full reasoning (same shape as editDepositEntryJson's
    // own fix just above -- no idempotency marker for this action either).
    await Promise.all([
      recomputeCurrentMonthSummaryCascadeB(),
      logTransactionB({
        page: 'deposits.html', action: 'deleteDepositEntryJson', reversible: true,
        summary: 'Deleted ' + cat.label + ' deposit ' + fmtMoneyB(clearedAmount) + (clearedName ? (' — ' + clearedName) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [{ sheet: monthName, year: year, row: row, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [existingDate, clearedAmount, clearedName], after: [null, null, null] }]
      })
    ]);
    return { success: true };
  }

  // ================== WRITE layer: deductDeposit / deductCashDeposit ==================
  // Both mirror deposits.html's own client-side copies exactly, including
  // their deliberately different write scopes: deductDeposit touches the
  // deposit tracking row, an Income row, the Wise/Revolut running total,
  // the bikes-sheet monthly earnings, AND best-effort mirrors onto the
  // matching Contract row's deposit amount; deductCashDeposit writes ONLY
  // the Contract row (per Anton: cash deposits are never logged as their
  // own row anywhere else, the Contract cell IS the record).

  const DEPOSIT_CATEGORY_PAID_BY_B = { bank: 'Scan', wise: 'Wise', revolut: 'Revolut' };

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
  async function addRentalAmountToBikesSheetFromJson(bikeModel, rawAmount) {
    const amount = Number(rawAmount);
    if (rawAmount === '' || rawAmount === null || rawAmount === undefined || isNaN(amount) || amount === 0) return;
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
    await logTransactionB({
      page: 'deposits.html', action: 'processDepositForPaymentFromJson', reversible: true,
      summary: (delta >= 0 ? 'Deposit total +' : 'Deposit total ') + fmtMoneyB(delta) + ' — ' + paidByLower + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] }]
    });
  }
  async function consumeDepositFromJson(cat, depositRow, deductAmount, monthName, year) {
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    assertDepositHeader(rows, cat, monthName, 'the deposit was NOT updated');

    const rowIdx = depositRow - 1;
    const row = rows[rowIdx] || [];
    const norm = s => (s || '').toString().trim().toLowerCase();
    const dateVal = row[cat.dateCol - 1];
    const amtVal = row[cat.amountCol - 1];
    const nameVal = row[cat.nameCol - 1];
    if (norm(dateVal) === 'total') {
      throw new Error('That row is the "' + cat.label + '" totals row, not a deposit -- the deposit was NOT updated.');
    }
    const rowEmpty = (dateVal === '' || dateVal === null || dateVal === undefined) &&
      (amtVal === '' || amtVal === null || amtVal === undefined) &&
      (nameVal === '' || nameVal === null || nameVal === undefined);
    if (rowEmpty) {
      throw new Error('That ' + cat.label + ' deposit no longer exists (it may have already been used) -- please refresh the deposit list and pick again.');
    }

    const currentAmount = (amtVal === '' || amtVal === null || amtVal === undefined || isNaN(Number(amtVal))) ? 0 : Number(amtVal);
    const EPSILON = 0.005;
    const remaining = currentAmount - deductAmount;
    if (remaining < -EPSILON) {
      throw new Error('This income (' + deductAmount.toFixed(2) + ') is more than what\'s left in this ' + cat.label +
        ' deposit (' + currentAmount.toFixed(2) + ') -- the deposit was NOT updated. Pick a different deposit or fix the amount.');
    }

    const newRows = rows.map(r => r.slice());
    const newRow = (newRows[rowIdx] || []).slice();
    while (newRow.length < cat.nameCol) newRow.push('');
    if (remaining <= EPSILON) {
      newRow[cat.dateCol - 1] = '';
      newRow[cat.amountCol - 1] = '';
      newRow[cat.nameCol - 1] = '';
    } else {
      newRow[cat.amountCol - 1] = remaining;
    }
    newRows[rowIdx] = newRow;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'deposits.html', action: 'consumeDepositFromJson', reversible: true,
      summary: 'Spent ' + fmtMoneyB(deductAmount) + ' of ' + cat.label + ' deposit' + (nameVal ? (' — ' + nameVal) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [dateVal, amtVal, nameVal], after: [newRow[cat.dateCol - 1], newRow[cat.amountCol - 1], newRow[cat.nameCol - 1]] }]
    });
  }

  function looksLikeSummaryLabelJson(raw) {
    const t = (raw || '').toString().trim().toLowerCase();
    if (!t) return false;
    if (t.indexOf('total') === 0) return true;
    const phrases = ['income for month', 'income for the month', 'income less',
      'bussiness expense', 'business expense', 'personal expense',
      'wages and bike', 'net profit', 'actual profit', '% of'];
    for (const p of phrases) { if (t.indexOf(p) !== -1) return true; }
    return false;
  }
  function isAccountsSideEmptyJson(r, side) {
    if (side === 'expense') {
      const eDateEmpty = (r[0] === '' || r[0] === null || r[0] === undefined);
      const expenseLabel = (r[1] || '').toString().trim();
      const eAmountEmpty = (r[2] === '' || r[2] === null || r[2] === undefined);
      return eDateEmpty && !expenseLabel && eAmountEmpty;
    }
    const iDateEmpty = (r[5] === '' || r[5] === null || r[5] === undefined);
    const incomeLabel = (r[6] || '').toString().trim();
    const nameEmpty = !(r[7] || '').toString().trim();
    const iAmountEmpty = (r[8] === '' || r[8] === null || r[8] === undefined);
    return iDateEmpty && !incomeLabel && nameEmpty && iAmountEmpty;
  }
  function findAccountsFreeRowIdxJson(rows2D, side) {
    for (let idx = 1; idx < rows2D.length; idx++) {
      const r = rows2D[idx] || [];
      const expenseLabel = (r[1] || '').toString().trim();
      const incomeLabel = (r[6] || '').toString().trim();
      if (looksLikeSummaryLabelJson(expenseLabel) || looksLikeSummaryLabelJson(incomeLabel)) {
        const newRows = rows2D.slice();
        newRows.splice(idx, 0, []);
        return { rows: newRows, rowNum: idx + 1, inserted: true };
      }
      if (isAccountsSideEmptyJson(r, side)) {
        return { rows: rows2D.slice(), rowNum: idx + 1, inserted: false };
      }
    }
    return { rows: rows2D.slice(), rowNum: rows2D.length + 1, inserted: false };
  }
  async function appendIncomeRowFromJson(opts) {
    const { rows, modifiedTime } = await fetchSheetWithMeta(opts.monthName, opts.year);
    const free = findAccountsFreeRowIdxJson(rows, 'income');
    const newRows = free.rows;
    const rowIdx = free.rowNum - 1;
    while (newRows.length <= rowIdx) newRows.push([]);
    const row = (newRows[rowIdx] || []).slice();
    while (row.length < 10) row.push('');
    row[5] = opts.date;
    row[6] = opts.description;
    row[7] = opts.name || '';
    row[8] = opts.amount;
    row[9] = opts.paidBy;
    newRows[rowIdx] = row;
    await writeSheetJson(opts.monthName, newRows, modifiedTime, opts.year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'deposits.html', action: 'appendIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(opts.amount) + ' — ' + (opts.description || '(no description)') + (opts.name ? (' from ' + opts.name) : '') + ' (' + opts.monthName + ' ' + opts.year + ')',
      writes: [{ sheet: opts.monthName, year: opts.year, row: rowIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });

    try {
      const cleanSplits = (opts.bikeSplits || [])
        .map(s => ({
          bike: (s.bike || '').toString().trim(),
          amount: (s.amount !== '' && s.amount !== null && s.amount !== undefined && !isNaN(Number(s.amount))) ? Number(s.amount) : ''
        }))
        .filter(s => s.bike && s.amount !== '');
      const notesSheet = opts.monthName + '_notes';
      const { rows: noteRows, modifiedTime: noteModifiedTime } = await fetchSheetWithMeta(notesSheet, opts.year);
      const filteredNotes = (noteRows || []).filter(n => !(n[0] === free.rowNum && n[1] === 7));
      if (cleanSplits.length) filteredNotes.push([free.rowNum, 7, JSON.stringify(cleanSplits)]);
      await writeSheetJson(notesSheet, filteredNotes, noteModifiedTime, opts.year);
    } catch (noteErr) { /* best-effort, same as the live setIncomeBikeSplits call */ }
    return free.rowNum;
  }

  // FIXED 24/08/2026 -- findRentedContractRowForDeductionFromJson now hands
  // back the exact Contract rows/modifiedTime it just fetched (as
  // contractRows/contractModifiedTime on the match) so the caller can pass
  // them straight into applyDepositDeductionToContractFromJson below
  // instead of that function re-downloading the same 306KB Contract.json a
  // few lines later. Both deductDepositEntryFromJson and
  // deductCashDepositFromJson call these two functions back-to-back with no
  // other write to Contract.json in between, so reusing the data here
  // doesn't introduce any real staleness -- the write's own modifiedTime
  // check still catches a genuine concurrent edit exactly as before.
  async function findRentedContractRowForDeductionFromJson(name, bikeModel) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    const nameTarget = normalizeNameForContractMatch(name);
    if (!nameTarget) return null;
    const bikeTarget = (bikeModel || '').toString().trim();
    for (let i = rows.length - 1; i >= 1; i--) {
      const row = rows[i];
      if (!row) continue;
      const status = (row[16] || '').toString().trim().toLowerCase();
      if (status !== 'rented') continue;
      const rowName = normalizeNameForContractMatch(row[3]);
      if (rowName !== nameTarget) continue;
      const rowBike = (row[6] || '').toString().trim();
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      return {
        rowNumber: i + 1, deposit: row[13], depositAmount: row[14], name: row[3], bikeModel: row[6],
        contractRows: rows, contractModifiedTime: modifiedTime
      };
    }
    return null;
  }
  // preloadedContract (added 24/08/2026): optional {rows, modifiedTime} --
  // when the caller already has a fresh Contract.json in hand (from
  // findRentedContractRowForDeductionFromJson immediately above), pass it
  // here instead of paying for a second fetch. Falls back to a live fetch
  // when omitted so any other/future caller without preloaded data still
  // works unchanged.
  async function applyDepositDeductionToContractFromJson(contractRowNumber, currentAmount, deductedAmount, reasonText, methodLabel, preloadedContract) {
    const { rows, modifiedTime } = preloadedContract || await fetchSheetWithMeta('Contract');
    const idx = contractRowNumber - 1;
    if (!rows[idx]) throw new Error('Contract row ' + contractRowNumber + ' not found -- the Contract deposit amount was NOT updated.');
    const newAmount = currentAmount - deductedAmount;
    const newRows = rows.map(r => r.slice());
    const row = newRows[idx].slice();
    while (row.length < 15) row.push('');
    row[14] = newAmount;
    newRows[idx] = row;
    await writeSheetJson('Contract', newRows, modifiedTime);

    const { rows: noteRows, modifiedTime: noteModifiedTime } = await fetchSheetWithMeta('Contract_notes');
    const existingEntry = (noteRows || []).find(n => n[0] === contractRowNumber && n[1] === 15);
    const existingNote = existingEntry ? (existingEntry[2] || '') : '';
    const todayDmy = formatDmyJson(new Date());
    const newLine = todayDmy + ' -- deducted ฿' + formatMoneyForLedgerB(deductedAmount) + ' (' + methodLabel + '): ' +
      reasonText + '. New balance: ฿' + formatMoneyForLedgerB(newAmount) + '.';
    const newNote = existingNote ? (existingNote + '\n' + newLine) : newLine;
    const newNoteRows = (noteRows || []).filter(n => !(n[0] === contractRowNumber && n[1] === 15));
    newNoteRows.push([contractRowNumber, 15, newNote]);
    await writeSheetJson('Contract_notes', newNoteRows, noteModifiedTime);

    return newAmount;
  }

  // ---- action:'deductDeposit', PLUS a clientTxnId idempotency guard (see
  // file header comment -- this is the highest-priority guard in this
  // file, a real double-charge risk). Order matters and is NOT
  // transactional, faithfully matching the live version: the deposit's own
  // balance is reduced FIRST (throws, writes nothing, if the deduction is
  // bigger than what's left); only once that's succeeded is the Income row
  // logged, followed by the Wise/Revolut running total, the bikes-sheet
  // earnings bump, and a best-effort Contract-side mirror -- each of those
  // last three is independently best-effort (folded into `warning`, never
  // blocking) exactly like the live version. data: { category, row,
  // deductionAmount, reason, customerName, bikeModel, clientTxnId }. ----
  async function deductDepositEntryFromJson(data) {
    const { monthName, year } = currentDepositsMonthYear();
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    const row = Math.round(Number(data.row));
    if (clientTxnId) {
      const existingRow = await findExistingMonthNotesTxnMarkerFromJson(monthName, year, DEPOSITS_DEDUCT_IDEMPOTENCY_COL_B, clientTxnId);
      if (existingRow) return { success: true, row: existingRow, idempotentReplay: true };
    }

    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.category);
    if (!cat) throw new Error('Unrecognized deposit category "' + data.category + '".');
    if (!row || row < 2) throw new Error('Invalid deposit row.');
    const deduction = Number(data.deductionAmount);
    if (isNaN(deduction) || deduction <= 0) throw new Error('Enter a valid deduction amount.');
    const reasonText = (data.reason || '').toString().trim();
    if (!reasonText) throw new Error('Enter a reason for the deduction.');

    // 1. Reduce the deposit's own balance first.
    await consumeDepositFromJson(cat, row, deduction, monthName, year);

    // Mark idempotency IMMEDIATELY after the balance reduction succeeds --
    // before any of the best-effort steps below, so a resubmit after a
    // dropped connection on ANY of those later steps still short-circuits
    // to idempotentReplay instead of re-touching the deposit balance
    // again. This mirrors contract.html's customerIntake ordering (marks
    // right after the one step that MUST NOT double-run).
    const warnings = [];
    if (clientTxnId) {
      try { await markMonthNotesTxnIdFromJson(monthName, year, DEPOSITS_DEDUCT_IDEMPOTENCY_COL_B, row, clientTxnId); }
      catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could double-deduct.'); }
    }

    const paidByLabel = DEPOSIT_CATEGORY_PAID_BY_B[data.category] || cat.label;
    const bikeNameForDescription = (data.bikeModel || '').toString().trim();
    const description = (bikeNameForDescription ? bikeNameForDescription + ', ' : '') + 'Deposit deduction for ' + reasonText;

    // 2. Only now, log the deduction as a normal Income entry. The deposit
    // balance has ALREADY been reduced at this point -- if this step fails,
    // that's surfaced as a hard error (not a warning) since staff need to
    // know the income row needs adding by hand, same asymmetry the live
    // version has (no rollback of step 1 either way).
    let incomeRowNum;
    try {
      incomeRowNum = await appendIncomeRowFromJson({
        monthName, year, date: todaySheetDateValue(), description,
        name: data.customerName || '', amount: deduction, paidBy: paidByLabel,
        bikeSplits: [{ bike: bikeNameForDescription || 'extras', amount: deduction }]
      });
    } catch (incomeErr) {
      throw new Error('The deposit balance was reduced, but the income row could NOT be logged: ' + incomeErr.message + ' Please add it by hand.');
    }

    const paidByLower = paidByLabel.toString().trim().toLowerCase();
    try {
      if (paidByLower === 'wise' || paidByLower === 'revolut') {
        await processDepositForPaymentFromJson(paidByLower, deduction);
      }
    } catch (depErr) { warnings.push('Deposit total: ' + depErr.message); }

    try {
      await addRentalAmountToBikesSheetFromJson(bikeNameForDescription || 'extras', deduction);
    } catch (bikeErr) { warnings.push('Bikes sheet (income): ' + bikeErr.message); }

    // 3. Best-effort mirror onto the matching "Rented" Contract row's own
    // deposit amount.
    try {
      const match = await findRentedContractRowForDeductionFromJson(data.customerName, bikeNameForDescription);
      if (match && !isNaN(Number(match.depositAmount)) && Number(match.depositAmount) > 0) {
        const contractDepositBefore = Number(match.depositAmount);
        const newContractAmount = await applyDepositDeductionToContractFromJson(match.rowNumber, contractDepositBefore, deduction, reasonText, cat.label,
          { rows: match.contractRows, modifiedTime: match.contractModifiedTime });
        // FIXED 25/08/2026 (Anton: "if I'm reversing a transaction, is it
        // going to put the money back in the deposit... update it on the
        // contract" -- this Contract-row mirror write was never logged
        // anywhere, so reversing the deposit-table deduction above (step 1,
        // consumeDepositFromJson's own separate log entry) left this
        // Contract amount permanently stuck at the reduced value, out of
        // sync with the restored deposit balance). Logged as its own
        // separate reversible entry -- same pattern as
        // consumeDepositFromJson/appendIncomeRowFromJson above, so staff
        // can undo this half too if needed.
        try {
          await logTransactionB({
            page: 'deposits.html', action: 'applyDepositDeductionToContractFromJson', reversible: true,
            summary: 'Contract deposit reduced by ' + fmtMoneyB(deduction) + (data.customerName ? (' — ' + data.customerName) : '') + ' (Contract row ' + match.rowNumber + ')',
            writes: [{ sheet: 'Contract', row: match.rowNumber, cols: [15], before: [contractDepositBefore], after: [newContractAmount] }]
          });
        } catch (logErr) { warnings.push('Contract deposit amount: reversal record could not be saved -- ' + logErr.message); }
      }
    } catch (contractErr) { warnings.push('Contract deposit amount: ' + contractErr.message); }

    const responsePayload = { success: true, incomeRow: incomeRowNum, row };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- action:'deductCashDeposit', PLUS a clientTxnId idempotency guard
  // (see file header comment). Writes ONLY to the Contract sheet -- no
  // income row, no monthly sheet, no bikes-sheet earnings update. Only the
  // "applied:true" branch (the one that actually writes) needs a guard --
  // "no cash deposit on file" never writes anything, so it's already
  // safely re-runnable. data: { customerName, bikeModel (optional),
  // deductionAmount, reason, clientTxnId }. ----
  async function deductCashDepositFromJson(data) {
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const existingRow = await findExistingContractNotesTxnMarkerFromJson(DEPOSITS_CASH_DEDUCT_IDEMPOTENCY_COL_B, clientTxnId);
      if (existingRow) return { success: true, applied: true, contractRow: existingRow, idempotentReplay: true };
    }

    const customerName = (data.customerName || '').toString().trim();
    if (!customerName) throw new Error('Enter a customer name.');
    const deduction = Number(data.deductionAmount);
    if (isNaN(deduction) || deduction <= 0) throw new Error('Enter a valid deduction amount.');
    const reasonText = (data.reason || '').toString().trim();
    if (!reasonText) throw new Error('Enter a reason for the deduction.');

    const match = await findRentedContractRowForDeductionFromJson(customerName, data.bikeModel);
    const hasCashDeposit = match &&
      (match.deposit || '').toString().trim().toLowerCase() === 'cash' &&
      !isNaN(Number(match.depositAmount)) && Number(match.depositAmount) > 0;

    if (!hasCashDeposit) {
      return {
        success: true, applied: false,
        message: 'No cash deposit on file for "' + customerName + '" -- nothing was deducted.'
      };
    }

    const contractDepositBefore = Number(match.depositAmount);
    const newAmount = await applyDepositDeductionToContractFromJson(
      match.rowNumber, contractDepositBefore, deduction, reasonText, 'Cash',
      { rows: match.contractRows, modifiedTime: match.contractModifiedTime });

    // FIXED 25/08/2026 -- this Contract write used to not be logged
    // anywhere at all, so it never even showed up in the transaction log --
    // there was nothing staff could click "Reverse" on to undo a mistaken
    // cash deposit deduction (Anton: "if I'm reversing a transaction, is it
    // going to put the money back in the deposit... update it on the
    // contract -- I want that check added across anytime"). Same fix +
    // pattern as deductDepositEntryFromJson's Contract mirror above.
    const warnings = [];
    try {
      await logTransactionB({
        page: 'deposits.html', action: 'deductCashDepositFromJson', reversible: true,
        summary: 'Cash deposit reduced by ' + fmtMoneyB(deduction) + (customerName ? (' — ' + customerName) : '') + ' (Contract row ' + match.rowNumber + ')',
        writes: [{ sheet: 'Contract', row: match.rowNumber, cols: [15], before: [contractDepositBefore], after: [newAmount] }]
      });
    } catch (logErr) { warnings.push('Reversal record could not be saved: ' + logErr.message); }

    if (clientTxnId) {
      try { await markContractNotesTxnIdFromJson(DEPOSITS_CASH_DEDUCT_IDEMPOTENCY_COL_B, match.rowNumber, clientTxnId); }
      catch (markErr) { console.warn('[depositsWrites] Could not record deductCashDeposit idempotency marker:', markErr.message); }
    }

    const responsePayload = { success: true, applied: true, newAmount, contractRow: match.rowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }
  // ================== end WRITE layer: deductDeposit / deductCashDeposit ==================

  async function depositsWriteDispatch(payload) {
    switch (payload.action) {
      case 'addDeposit': return addDepositEntryJson(payload);
      case 'editDeposit': return editDepositEntryJson(payload);
      case 'deleteDeposit': return deleteDepositEntryJson(payload);
      case 'deductDeposit': return deductDepositEntryFromJson(payload);
      case 'deductCashDeposit': return deductCashDepositFromJson(payload);
      default:
        throw new Error(
          'Unknown or out-of-scope deposits.html write action: "' + (payload && payload.action) + '". ' +
          'Ported: addDeposit, editDeposit, deleteDeposit, deductDeposit, deductCashDeposit.'
        );
    }
  }

  return {
    depositsWriteDispatch,
    addDepositEntryJson,
    editDepositEntryJson,
    deleteDepositEntryJson,
    deductDepositEntryFromJson,
    deductCashDepositFromJson,
    // Exposed for the fake-Drive test harness, not used by the dispatch
    // path itself -- same convention as lib/contractWrites.js.
    recomputeCurrentMonthSummaryCascadeB,
    findRentedContractRowForDeductionFromJson
  };
}

module.exports = { createSheetIO, createDepositsWrites };
