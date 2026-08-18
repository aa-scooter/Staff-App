// ---- Server-side customers.html write layer -- final page of the
// page-by-page rollout (bikes.html -> contract.html -> deposits.html ->
// add-bikes.html -> customers.html). See PROGRESS.md for the full
// inventory/decision trail.
//
// SCOPE: customers.html has exactly ONE write action -- action:'customerIntake'
// (customerIntakeFromJson) -- an 8-sub-write cascade against the customer,
// customer_notes, the current month's income sheet, cash, bikes, and
// Contract sheets. Every sub-write past the first (the customer row insert
// itself) is independently try/catch'd into a `warning` string rather than
// failing the whole request -- verbatim port of that structure, not a
// change introduced by this port.
//
// ARCHITECTURE NOTE -- why this does NOT get its own api/customers/write.js:
// same Vercel Hobby-plan 12-serverless-function cap as every other page in
// this rollout (see lib/depositsWrites.js's/lib/addBikesWrites.js's own
// header comments for the fuller history). Routed through the EXISTING
// api/accounts/write.js instead (already hosts deposits.html's actions
// alongside accounts.html's own) via a new CUSTOMERS_ACTIONS Set --
// 'customerIntake' doesn't collide with anything already routed there.
//
// IDEMPOTENCY -- the one genuinely new thing this port adds (customers.html
// had NO clientTxnId guard at all before this, unlike bikes.html's/
// contract.html's own customerIntake variants elsewhere in this project,
// which already had one -- this was a real, live gap):
//   - clientTxnId guard on the customer-row insert ONLY, not the full
//     8-sub-write cascade. Marker lives on a `customer_notes` sidecar,
//     column CUSTOMER_INTAKE_IDEMPOTENCY_COL_B=90 (same [row, col,
//     clientTxnId] shape as every other guard in this project), keyed to
//     the newly-inserted customer row, written IMMEDIATELY after that row
//     insert succeeds (before the cascade runs). A retry with a matching
//     clientTxnId short-circuits with { success:true, idempotentReplay:true
//     } WITHOUT re-running the cascade.
//
//     This is a deliberate, documented scope limit, not an oversight: a
//     retry that DID re-run the cascade after a crash mid-cascade would
//     double-log income/cash/ledger entries, which is worse than the
//     "duplicate customer row" bug this guard exists to prevent. True
//     whole-cascade atomicity (resume-from-where-it-crashed, or a two-phase
//     started/completed marker) is a genuinely harder problem this project
//     has never solved anywhere, including in the original Code.gs (a
//     network drop between any two of its sequential SpreadsheetApp calls
//     left exactly the same kind of partial state, with no retry mechanism
//     at all). Guarding the single critical row-creating write is a strict
//     improvement over the previous "no guard anywhere" state without
//     overclaiming a fix for the harder problem. Matches addBikeFromJson's
//     own precedent in lib/addBikesWrites.js -- that guard likewise only
//     covers the critical Parts_and_Oil_change insert, not its own
//     warnings-wrapped Operation/bikes/Bike_Tax fan-out.
//
//   - The "Extend" flow's `paidFromDeposit` (drawing down an existing
//     deposit-log row) is NOT ported -- was already explicitly deferred in
//     customers.html's own client-side comments before this port, carried
//     forward unchanged (still surfaces as a `warning` telling the user to
//     adjust the deposit log by hand).
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Identical to lib/bikesWrites.js's/lib/depositsWrites.js's/
// lib/addBikesWrites.js's own createSheetIO -- see any of those files' own
// comment for the full "why" (mirrors api/data/[sheet].js's
// resolveYearFolderId + filename logic exactly). Not shared via a common
// module -- this project's explicit per-file convention. ----
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

function createCustomersWrites(sheetIO) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- Small date/format utilities -- verbatim port of customers.html's
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
  function formatDmyJson(date) {
    if (!date) return '';
    return pad2Json(date.getDate()) + '/' + pad2Json(date.getMonth() + 1) + '/' + date.getFullYear();
  }
  function isoDateInputToCustomerValue(isoDate) {
    const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  }
  function timeInputToCustomerValue(hhmm) {
    const m = String(hhmm || '').trim().match(/^(\d{2}):(\d{2})$/);
    if (!m) return '';
    return `${m[1]}:${m[2]}:00`;
  }
  function isoYmdNowB() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2Json(d.getMonth() + 1) + '-' + pad2Json(d.getDate());
  }
  // Mirrors Code.gs's stripBikeNameBrackets -- unwraps (doesn't delete)
  // parens so brackets never reach the sheets in the first place.
  function stripBikeNameBracketsB(s) {
    return (s || '').toString().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---- Name/bike matchers -- verbatim ports of customers.html's own
  // copies. bikeNamesMatchForTaxLookup is the general-purpose one used for
  // Contract-row matching; bikeNamesMatchForRentalLogB is the SEPARATE
  // ("fifth bike-name matcher in this codebase", per that file's own
  // comment -- deliberately never merged with the others) one used only
  // for finding a bike's row on the "bikes" sheet. ----
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

  // ---- Ledger-note text helpers -- verbatim ports, mirror Code.gs's
  // formatMoneyForLedger_/stripLedgerTotalLine_/stripAllTrailingParensAndDeal_
  // exactly. ----
  const LEDGER_CONTACT_COL_B = 2;
  function parseLedgerTotal(noteText) {
    const m = (noteText || '').toString().match(/Total:\s*([\d.]+)\s*days?,\s*฿\s*([\d,]+(?:\.\d+)?)\s*$/i);
    if (!m) return { days: 0, amount: 0 };
    return { days: Number(m[1]) || 0, amount: Number(m[2].replace(/,/g, '')) || 0 };
  }
  function formatMoneyForLedgerB(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
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
  function buildRentalIncomeTextB(data, dayCount) {
    const bikeName = (data.bikeModel || '').toString().trim();
    const isExtendSource = (data.source || '').toString().trim().toLowerCase() === 'extend';
    const verb = isExtendSource ? 'extend' : 'rent';
    let text = bikeName;
    text += (dayCount !== null && dayCount !== undefined && !isNaN(dayCount))
      ? (' ' + verb + ' ' + dayCount + (dayCount === 1 ? ' day' : ' days'))
      : (' ' + verb);
    // Note: Code.gs also appends ", extended from deposit (...)" here when
    // data.paidFromDeposit is set -- not reproduced, since paidFromDeposit
    // itself is one of the deferred pieces (see this file's own header
    // comment).
    return text;
  }
  // Generic version of Code.gs's findFullyEmptyRow -- verbatim port.
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

  const DEPOSIT_CATEGORIES_B = [
    { key: 'bank', label: 'Bank', header: 'deposit scan', dateCol: 15, amountCol: 16, nameCol: 17 },
    { key: 'wise', label: 'Wise', header: 'deposit wise', dateCol: 18, amountCol: 19, nameCol: 20 },
    { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24 }
  ];
  // NOTE: lowercase 'march'/'april'/'may' is verbatim from customers.html's
  // own copy (must match the real sheet tab names exactly) -- not a typo
  // introduced by this port.
  const DEPOSITS_MONTH_NAMES = ['January', 'February', 'march', 'april', 'may', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // ---- Transaction log -- verbatim port of customers.html's own
  // logTransactionB, adapted to sheetIO's fetchSheetWithMeta/writeSheetJson
  // instead of raw fetch(). Best-effort, additive-only -- must never fail
  // or delay the write it's describing. ----
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
        } catch (e) {
          if (e instanceof ConflictError || e.isConflict) continue;
          throw e;
        }
      }
    } catch (e) {
      console.warn('[customersWrites] Transaction log write failed (non-critical):', e && e.message);
    }
  }
  function fmtMoneyB(n) {
    const v = Number(n);
    return '฿' + (isNaN(v) ? '0' : v.toLocaleString('en-US'));
  }

  // ==== Monthly "Bank" balance / cash / deposit-log recompute cascade ====
  // Verbatim port of customers.html's own copy (itself ported verbatim from
  // accounts.html's -- same per-file convention as every duplicated helper
  // in this codebase). See accounts.html's copy for the full formula
  // derivation.
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
    catch (e) { console.warn('[customersWrites] Summary totals recompute failed:', e.message); }
  }

  // ---- Idempotency guard on the customer-row insert -- see this file's
  // own header comment for the full reasoning on why this covers only the
  // row insert, not the whole 8-sub-write cascade. ----
  const CUSTOMER_INTAKE_IDEMPOTENCY_COL_B = 90;
  async function findExistingCustomerNotesTxnMarkerFromJson(clientTxnId) {
    if (!clientTxnId) return null;
    let noteRows;
    try {
      ({ rows: noteRows } = await fetchSheetWithMeta('customer_notes'));
    } catch (e) {
      return null; // sidecar unreadable -- fail open, same convention as every other guard in this project
    }
    const hit = (noteRows || []).find(n => n[1] === CUSTOMER_INTAKE_IDEMPOTENCY_COL_B && n[2] === clientTxnId);
    return hit ? hit[0] : null;
  }
  async function markCustomerNotesTxnIdFromJson(row, clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta('customer_notes');
      const newNoteRows = (noteRows || []).filter(n => !(n[0] === row && n[1] === CUSTOMER_INTAKE_IDEMPOTENCY_COL_B));
      newNoteRows.push([row, CUSTOMER_INTAKE_IDEMPOTENCY_COL_B, clientTxnId]);
      await writeSheetJson('customer_notes', newNoteRows, modifiedTime);
    } catch (e) {
      console.warn('[customersWrites] Could not record idempotency marker:', e.message);
      // Deliberately swallowed, not rethrown -- unlike addBike's own marker
      // write (which surfaces a warning to the user since a missed marker
      // there risks a confusing "already exists" error on retry), a missed
      // marker here just means a genuinely-dropped retry could create a
      // second customer row -- the SAME risk this whole gap already had
      // before this port. Not worse than before; not silently claiming to
      // be better than it is either (see header comment).
    }
  }

  // ---- Sub-write 1: the ledger note (a NOTE + a bracket appended to the
  // VALUE) on the customer row's own contact cell (column B,
  // LEDGER_CONTACT_COL_B). Operates on 'customer' + 'customer_notes'
  // independently (two separate writes), mirroring Code.gs's own
  // cell.setNote() + cell.setValue() pair. Returns { totalDays, totalAmount
  // } (the customer's new running total). ----
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

  // ---- Sub-write 2: the current month's income sheet, columns F-J. ----
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
    row[5] = isoDateInputToCustomerValue(isoYmdNowB()); // F: date
    row[6] = incomeText;                                // G: income
    row[7] = data.name || '';                           // H: PAX name
    row[8] = amountValue;                                // I: amount
    row[9] = paidDisplay;                                // J: paid by
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'customers.html', action: 'appendMonthlyIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)') + (data.name ? (' from ' + data.name) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] }]
    });
  }

  // ---- Sub-write 3: the "cash" sheet's income side (columns A-C), only
  // when paidBy is Cash. ----
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
    row[0] = isoDateInputToCustomerValue(isoYmdNowB());
    row[1] = incomeText;
    row[2] = amountValue;
    newRows[targetIdx] = row;
    await writeSheetJson('cash', newRows, modifiedTime);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'customers.html', action: 'appendCashSheetRowFromJson', reversible: true,
      summary: 'Cash income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)'),
      writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [1, 2, 3], before: ['', '', ''], after: [row[0], row[1], row[2]] }]
    });
  }

  // ---- Sub-write 4: the "bikes" sheet's monthly running total. ----
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

  // ---- Sub-write 5: the Wise/Revolut running PAYMENT total. ----
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
    else {
      for (let i = 0; i < rows.length; i++) { if (rows[i] && norm(rows[i][11]) === expectedLabel) { rowIdx = i; break; } }
    }
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
      page: 'customers.html', action: 'processDepositForPaymentFromJson', reversible: true,
      summary: (delta >= 0 ? 'Deposit total +' : 'Deposit total ') + fmtMoneyB(delta) + ' — ' + paidByLower + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] }]
    });
  }

  // ---- Sub-write 6: the Scan/Wise/Revolut SECURITY deposit log table. ----
  async function logSecurityDepositFromJson(methodLower, rawAmount, customerName) {
    const categoryKey = methodLower === 'scan' ? 'bank' : methodLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) return; // Cash/Passport/unrecognized -- nothing to log, matches Code.gs.

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
    const maxCol = Math.max(cat.dateCol, cat.amountCol, cat.nameCol);
    while (row.length < maxCol) row.push('');
    row[cat.dateCol - 1] = isoDateInputToCustomerValue(isoYmdNowB());
    row[cat.amountCol - 1] = (Number(rawAmount) || rawAmount || '');
    row[cat.nameCol - 1] = customerName || '';
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    await logTransactionB({
      page: 'customers.html', action: 'logSecurityDepositFromJson', reversible: true,
      summary: cat.label + ' deposit ' + fmtMoneyB(row[cat.amountCol - 1]) + (customerName ? (' — ' + customerName) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: targetIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: ['', '', ''], after: [row[cat.dateCol - 1], row[cat.amountCol - 1], row[cat.nameCol - 1]] }]
    });
  }

  // ---- Sub-write 7: flips the matching "Pending" Contract row to
  // "Rented" (bottom-up, most recent match by name + fuzzy bike name). ----
  async function markMatchingContractAsRentedFromJson(name, bikeModel) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return { found: false };
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return { found: false };
    for (let i = rows.length - 1; i >= 1; i--) {
      const rowName = normalizeNameForContractMatch(rows[i][3]);
      const rowBike = (rows[i][6] || '').toString().trim();
      const rowStatus = (rows[i][16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'pending') continue;
      if (rowName !== nameTarget) continue;
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      const newRows = rows.map(r => r.slice());
      const row = newRows[i].slice();
      while (row.length < 17) row.push('');
      row[16] = 'Rented';
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- Used just before syncContractRowTotalsFromJson, to apply the same
  // "never shrink the Contract row's total price" failsafe Code.gs has. ----
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

  // ---- Sub-write 8: syncs the matching "Rented" Contract row's return
  // date (column I) and/or total price (column L). ----
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
      if (returnDateIso) row[8] = isoDateInputToCustomerValue(returnDateIso);
      if (totalAmount !== null && totalAmount !== undefined) row[11] = totalAmount;
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- The cascade itself. data: see customers.html's Add form's payload
  // (also called directly by contract.html's doRent() with the same
  // shape). NEW in this port: the clientTxnId idempotency guard on the
  // customer-row insert (see this file's own header comment). ----
  async function customerIntakeFromJson(data) {
    const name = (data.name || '').toString().trim();
    if (!name) throw new Error('Name is required.');
    data.bikeModel = stripBikeNameBracketsB(data.bikeModel);
    const isExtendSource = (data.source || '').toString().trim().toLowerCase() === 'extend';

    const clientTxnId = (data.clientTxnId || '').toString().trim() || null;
    if (clientTxnId) {
      const existingRow = await findExistingCustomerNotesTxnMarkerFromJson(clientTxnId);
      if (existingRow) return { success: true, row: existingRow, idempotentReplay: true };
    }

    const { rows: custRows, modifiedTime: custModifiedTime } = await fetchSheetWithMeta('customer');
    const newRows = (custRows || []).map(r => r.slice());
    const newRow = new Array(16).fill('');
    newRow[0] = isoDateInputToCustomerValue(isoYmdNowB());
    newRow[1] = data.contact || '';
    newRow[2] = name;
    newRow[3] = data.nationality || '';
    newRow[4] = data.passport || '';
    newRow[5] = data.bikeModel || '';
    newRow[6] = '';
    newRow[7] = isoDateInputToCustomerValue(data.rentingDateFrom);
    newRow[8] = isoDateInputToCustomerValue(data.returnDate);
    newRow[9] = timeInputToCustomerValue(data.returnTime);
    newRow[10] = data.deliverToHotel || '';
    newRow[11] = data.totalPrice || '';
    newRow[12] = data.paidBy || '';
    newRow[13] = '';
    newRow[14] = data.deposit || '';
    newRow[15] = isExtendSource ? 'Extend' : 'Direct';
    newRows.push(newRow);
    const newRowNumber = newRows.length;
    await writeSheetJson('customer', newRows, custModifiedTime);

    // Mark the idempotency guard IMMEDIATELY after the row insert succeeds,
    // before the cascade -- see this file's header comment for why a retry
    // short-circuits here rather than re-running the (already best-effort)
    // cascade below.
    if (clientTxnId) await markCustomerNotesTxnIdFromJson(newRowNumber, clientTxnId);

    let dayCount = null;
    if (data.rentingDateFrom && data.returnDate) {
      const from = new Date(data.rentingDateFrom + 'T00:00:00');
      const to = new Date(data.returnDate + 'T00:00:00');
      if (!isNaN(from) && !isNaN(to)) dayCount = Math.round((to - from) / (1000 * 60 * 60 * 24));
    }

    const warnings = [];
    let ledgerTotals = null;
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

    try { await appendMonthlyIncomeRowFromJson(data, dayCount); }
    catch (incomeErr) { warnings.push('Income sheet: ' + incomeErr.message); }

    try {
      if ((data.paidBy || '').toString().trim().toLowerCase() === 'cash') {
        await appendCashSheetRowFromJson(buildRentalIncomeTextB(data, dayCount), data.totalPrice);
      }
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }

    try { await addRentalAmountToBikesSheetFromJson(data.bikeModel, data.totalPrice); }
    catch (bikesErr) { warnings.push(bikesErr.message); }

    try {
      const paidByLower = (data.paidBy || '').toString().trim().toLowerCase();
      if (paidByLower === 'wise' || paidByLower === 'revolut') {
        await processDepositForPaymentFromJson(paidByLower, data.totalPrice);
      }
    } catch (depositErr) { warnings.push(depositErr.message); }

    try {
      const depositMethodLower = (data.deposit || '').toString().trim().toLowerCase();
      if (!isExtendSource && (depositMethodLower === 'scan' || depositMethodLower === 'wise' || depositMethodLower === 'revolut')) {
        await logSecurityDepositFromJson(depositMethodLower, data.depositAmount, name);
      }
    } catch (secDepErr) { warnings.push(secDepErr.message); }

    if (isExtendSource && data.paidFromDeposit) {
      warnings.push('This extension was marked as paid from an existing deposit, but drawing that down automatically is not ported yet -- please adjust the deposit log by hand.');
    }

    try { await markMatchingContractAsRentedFromJson(name, data.bikeModel); }
    catch (contractStatusErr) { warnings.push('Contract status update: ' + contractStatusErr.message); }

    try {
      if (ledgerTotals) {
        const newContractTotal = ledgerTotals.totalAmount;
        const existingMatch = await findRentedContractRowForBackfillFromJson(name, data.bikeModel);
        if (existingMatch && newContractTotal < existingMatch.totalPrice) {
          await syncContractRowTotalsFromJson(name, data.bikeModel, data.returnDate, null);
          warnings.push('Contract totals sync: computed running total (฿' + newContractTotal +
            ') is LESS than Contract row ' + existingMatch.row + '\'s current total price (฿' + existingMatch.totalPrice +
            ') -- skipped overwriting the total price to avoid shrinking it. Please check this customer\'s ledger note by hand.');
        } else {
          await syncContractRowTotalsFromJson(name, data.bikeModel, data.returnDate, newContractTotal);
        }
      }
    } catch (contractSyncErr) { warnings.push('Contract totals sync: ' + contractSyncErr.message); }

    const responsePayload = { success: true, row: newRowNumber };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }

  // ---- Single-dispatch entry point, mirrors bikesWriteDispatch's/
  // depositsWriteDispatch's/addBikesWriteDispatch's shape. ----
  async function customersWriteDispatch(body) {
    switch (body && body.action) {
      case 'customerIntake':
        return customerIntakeFromJson(body);
      default:
        throw new Error('Unknown customers action: ' + (body && body.action));
    }
  }

  return { customerIntakeFromJson, customersWriteDispatch };
}

module.exports = { createSheetIO, createCustomersWrites };
