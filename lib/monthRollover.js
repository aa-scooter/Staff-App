// ---- Month-end rollover (2026-08-21) ----
//
// Ports Code.gs's createMonthSheetFromTemplate() + carryForwardMonthFigures_()
// + checkForMonthEndRollover()/installMonthEndRolloverTrigger() -- the one
// piece of Code.gs's month-lifecycle machinery that had NO ported
// equivalent at all (flagged as finding #2 in CODE_GS_PARITY_AUDIT_2026-08-21.md
// and finding #6 in FORMULA_CASCADE_AUDIT_2026-08-14.md). Confirmed the
// actual impact by tracing the read/write path: a missing month file
// doesn't error on GET (readJsonFile just returns null), but every write
// function in accountsWrites.js that touches the monthly sheet explicitly
// guards with `if (!rows || !rows.length) throw new Error(...)` -- so
// without this, the FIRST expense/income/deposit/rental write in a new
// month throws "No sheet found for '<Month>'" and stays broken until a
// human manually creates that month's file. Built ~10 days before the
// September 2026 rollover this was found for.
//
// Row/column layout confirmed against the real `template.json` and
// `August.json` seed exports (2026-08-21), not just Code.gs's own
// comments -- every label/row/col below was cross-checked byte-for-byte
// against real data before this shipped. Duplicated here rather than
// imported from lib/accountsWrites.js (which doesn't export these
// internal constants) -- same tradeoff this project already makes for
// DEPOSITS_MONTH_NAMES, which is independently redefined in 8 different
// files rather than shared. If Template's own layout ever changes, all
// of those need updating together; this file is one more.
// NOTE: deliberately no direct require of ./googleDrive here -- every read/
// write below goes through the `sheetIO` the caller passes in (same
// {fetchSheetWithMeta, writeSheetJson} shape lib/accountsWrites.js's own
// createSheetIO produces), so this module has zero direct Drive/session
// plumbing of its own. Keeps it trivially unit-testable with a fake
// in-memory sheetIO, and means api/admin/reset.js (this module's only
// caller) can reuse whichever createSheetIO it already has on hand.
const { MONTH_SHEET_NAMES } = require('./monthSheets');

// ---- Fixed-cell figures on a monthly sheet's summary block, column L
// (label) / M (value) -- see ACCOUNTS_SUMMARY_ITEMS.deposit and
// ACCOUNTS_CASCADE_EXTRA_ITEMS_B in lib/accountsWrites.js for the reading/
// recompute side of this same block. Only the 5 items carryForwardMonthFigures_
// actually WRITES to are needed here (cash is read-only source, not written
// on the new sheet -- see step 1 below); "bank"/"bank less deposit"/
// "deposits all"/"total" are deliberately excluded, same as Code.gs -- those
// are formula-derived and self-heal the moment anything triggers
// recomputeMonthlySummaryCascadeB against the new sheet (its own first
// write, exactly like every other month already relies on). ----
const FIXED_CELL_ITEMS = {
  cash:         { row: 3,  labelCol: 12, valueCol: 13, expectedLabel: 'cash' },
  cashPrevious: { row: 4,  labelCol: 12, valueCol: 13, expectedLabel: 'cash previous' },
  bankLessDep:  { row: 7,  labelCol: 12, valueCol: 13, expectedLabel: 'bank less deposit' },
  bankPrevious: { row: 2,  labelCol: 12, valueCol: 13, expectedLabel: 'bank previous less deposit + wise + rev' },
  bikeBank:     { row: 10, labelCol: 12, valueCol: 13, expectedLabel: 'bike bank' },
  wise:         { row: 11, labelCol: 12, valueCol: 13, expectedLabel: 'wise(less deposit)' },
  revolut:      { row: 12, labelCol: 12, valueCol: 13, expectedLabel: 'revolut(less deposit)' }
};

// ---- The 3 still-open-security-deposit tables at the top of every monthly
// sheet -- same columns as DEPOSIT_CATEGORIES_B in lib/accountsWrites.js
// and DEPOSIT_CATEGORIES in Code.gs. Data rows run 2..14, terminated by a
// "total" row at 15 (confirmed against real August.json: row 15 col O/R/V
// all hold the literal text "total"). ----
const DEPOSIT_CATEGORIES = [
  { key: 'bank',    dateCol: 15, amountCol: 16, nameCol: 17 },
  { key: 'wise',    dateCol: 18, amountCol: 19, nameCol: 20 },
  { key: 'revolut', dateCol: 22, amountCol: 23, nameCol: 24 }
];

// ---- The 2 rows just above the deposit tables: row 15's "total" (per
// category, summing that category's own amount column over rows 2-14) and
// row 16's "total wise"/"total revolut" (that category's fixed-cell balance
// -- FIXED_CELL_ITEMS.wise/revolut -- plus its own row-15 total; bank/scan
// has no row-16 equivalent). These were live SUM-range formulas in the
// original spreadsheet; lib/accountsWrites.js's recomputeMonthlySummaryCascadeB
// already recomputes them from scratch on every write during the month (see
// DEPOSIT_LOG_TOTAL_ITEMS_B/DEPOSIT_LOG_SUBTOTAL_ITEMS_B there -- same rows/
// cols). Without computing them here too, a freshly-rolled-over sheet would
// show 0 in both rows until that first write happened to fix them --
// correct eventually, but wrong-looking (and alarming, for real-money
// figures) in the meantime. Computed here so the new sheet is right the
// moment it's created, not just eventually. ----
const DEPOSIT_TOTAL_ROW = 15;
const DEPOSIT_SUBTOTAL_ROW = 16;

function norm(s) { return (s || '').toString().trim().toLowerCase(); }

// Same "check the expected row first, else scan the whole column" self-
// healing lookup as findSummaryRow in lib/accountsWrites.js -- kept
// independent (not imported) for the same reason the constants above are.
function findLabelRow(rows, item) {
  const target = norm(item.expectedLabel);
  const expectedRow = rows[item.row - 1];
  if (expectedRow && norm(expectedRow[item.labelCol - 1]) === target) return item.row;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r] && norm(rows[r][item.labelCol - 1]) === target) return r + 1;
  }
  return null;
}

function readCell(rows, row, col) {
  if (!row || !rows[row - 1]) return null;
  const v = rows[row - 1][col - 1];
  return v === undefined ? null : v;
}

function writeCell(rows, row, col, val) {
  if (!row) return;
  if (!rows[row - 1]) rows[row - 1] = [];
  while (rows[row - 1].length < col) rows[row - 1].push(null);
  rows[row - 1][col - 1] = val;
}

function sumColumnRange(rows, col, startRow, endRow) {
  let sum = 0;
  for (let r = startRow; r <= endRow; r++) {
    const v = Number(readCell(rows, r, col));
    if (!isNaN(v)) sum += v;
  }
  return sum;
}

// ---- Recomputes the row-15/row-16 deposit-log totals described above.
// `wiseBalance`/`revolutBalance` are the SAME already-carried-forward fixed-
// cell figures carryForwardMonthFigures just wrote (passed in rather than
// re-read from newRows, so this can't disagree with what's actually on the
// sheet even if one of those writes hit a warning/fallback earlier). ----
function recomputeDepositLogTotals(newRows, wiseBalance, revolutBalance) {
  const totals = {};
  DEPOSIT_CATEGORIES.forEach((cat) => {
    const total = sumColumnRange(newRows, cat.amountCol, 2, 14);
    writeCell(newRows, DEPOSIT_TOTAL_ROW, cat.amountCol, total);
    totals[cat.key] = total;
  });
  const wiseCat = DEPOSIT_CATEGORIES.find((c) => c.key === 'wise');
  const revolutCat = DEPOSIT_CATEGORIES.find((c) => c.key === 'revolut');
  writeCell(newRows, DEPOSIT_SUBTOTAL_ROW, wiseCat.amountCol, (Number(wiseBalance) || 0) + (totals.wise || 0));
  writeCell(newRows, DEPOSIT_SUBTOTAL_ROW, revolutCat.amountCol, (Number(revolutBalance) || 0) + (totals.revolut || 0));
}

// ---- Copies one deposit-category table's still-populated rows from the
// source sheet to the new sheet, starting at row 2. Ported 1:1 from
// Code.gs's copyDepositCategoryRows_, INCLUDING its compaction behavior: a
// fully-blank row (all 3 columns empty) is skipped rather than copied as a
// gap, so a real row further down shifts up to fill it -- this is the
// original's own behavior, not something introduced here (confirmed
// against Code.gs's own `continue` on a blank row, then a sequential
// `setValues` write starting at row 2). Scanning stops at the first row
// whose date column reads "total" (case/whitespace-insensitive), same as
// the original. Returns the number of rows copied. ----
function copyDepositCategoryRows(sourceRows, newRows, cat) {
  const collected = [];
  for (let r = 2; r <= sourceRows.length; r++) {
    const row = sourceRows[r - 1] || [];
    const dateRaw = row[cat.dateCol - 1];
    if (norm(dateRaw) === 'total') break;
    const dateEmpty = dateRaw === '' || dateRaw === null || dateRaw === undefined;
    const amtRaw = row[cat.amountCol - 1];
    const amtEmpty = amtRaw === '' || amtRaw === null || amtRaw === undefined;
    const nameRaw = row[cat.nameCol - 1];
    const nameEmpty = nameRaw === '' || nameRaw === null || nameRaw === undefined;
    if (dateEmpty && amtEmpty && nameEmpty) continue; // gap row -- skip, keep scanning down
    collected.push([dateRaw, amtRaw, nameRaw]);
  }
  collected.forEach((triple, i) => {
    const destRow = i + 2;
    writeCell(newRows, destRow, cat.dateCol, triple[0]);
    writeCell(newRows, destRow, cat.amountCol, triple[1]);
    writeCell(newRows, destRow, cat.nameCol, triple[2]);
  });
  return collected.length;
}

// ---- Step 2 -- carries the handful of fixed-cell figures and the 3
// still-open-deposit tables forward from the outgoing month's rows into the
// brand-new month's rows (already a copy of Template's own rows at this
// point). Mutates `newRows` in place. Returns an array of warning strings
// (empty if everything moved cleanly) rather than throwing on the first
// problem -- same as Code.gs, so e.g. a missing wise balance doesn't stop
// the cash figure (already written by that point) from landing.
//
// ONE deliberate difference from Code.gs: "bank previous less deposit +
// wise + rev" was written there as an actual spreadsheet FORMULA
// (`=x+y+z`) so the 3 components stayed visible/checkable in the cell.
// JSON has no live-formula concept -- every other cascade this project has
// already ported (see FORMULA_CASCADE_AUDIT_2026-08-14.md) made the same
// trade and writes a plain computed number instead. Same trade made here,
// noted rather than silently dropped. ----
function carryForwardMonthFigures(sourceRows, newRows) {
  const warnings = [];

  // 1) "cash" (source, read-only) -> "cash previous" (new). Code.gs also
  // freezes the source's own "cash" formula into a plain number in place --
  // a no-op here, since M3 on an already-live monthly sheet is already a
  // plain number by the time this runs (recomputeMonthlySummaryCascadeB
  // keeps it that way on every write during the month).
  try {
    const cashRow = findLabelRow(sourceRows, FIXED_CELL_ITEMS.cash);
    if (cashRow === null) throw new Error('Could not find "cash" in column L of the outgoing month sheet.');
    const frozenCash = readCell(sourceRows, cashRow, 13);
    const cpRow = findLabelRow(newRows, FIXED_CELL_ITEMS.cashPrevious);
    if (cpRow === null) throw new Error('Could not find "cash previous" on the Template sheet.');
    writeCell(newRows, cpRow, 13, frozenCash);
  } catch (err) {
    warnings.push('Cash: ' + err.message);
  }

  // 2), 3) & 4) Bank/wise/revolut. Read all three independently so a
  // problem reading one doesn't stop the other two -- same as Code.gs.
  let bankLessDeposit = 0, wiseBalance = 0, revolutBalance = 0;

  try {
    const row = findLabelRow(sourceRows, FIXED_CELL_ITEMS.bankLessDep);
    if (row === null) throw new Error('Could not find "bank less deposit" in column L of the outgoing month sheet.');
    bankLessDeposit = Number(readCell(sourceRows, row, 13)) || 0;
  } catch (err) {
    warnings.push('Bank (read): ' + err.message);
  }

  try {
    const row = findLabelRow(sourceRows, FIXED_CELL_ITEMS.wise);
    if (row === null) throw new Error('Could not find "wise(less deposit)" in column L of the outgoing month sheet.');
    wiseBalance = Number(readCell(sourceRows, row, 13)) || 0;
    const destRow = findLabelRow(newRows, FIXED_CELL_ITEMS.wise);
    if (destRow === null) throw new Error('Could not find "wise(less deposit)" on the Template sheet.');
    writeCell(newRows, destRow, 13, wiseBalance);
  } catch (err) {
    warnings.push('Wise balance: ' + err.message);
  }

  try {
    const row = findLabelRow(sourceRows, FIXED_CELL_ITEMS.revolut);
    if (row === null) throw new Error('Could not find "revolut(less deposit)" in column L of the outgoing month sheet.');
    revolutBalance = Number(readCell(sourceRows, row, 13)) || 0;
    const destRow = findLabelRow(newRows, FIXED_CELL_ITEMS.revolut);
    if (destRow === null) throw new Error('Could not find "revolut(less deposit)" on the Template sheet.');
    writeCell(newRows, destRow, 13, revolutBalance);
  } catch (err) {
    warnings.push('Revolut balance: ' + err.message);
  }

  try {
    const destRow = findLabelRow(newRows, FIXED_CELL_ITEMS.bankPrevious);
    if (destRow === null) throw new Error('Could not find "bank previous less deposit + wise + rev" on the Template sheet.');
    writeCell(newRows, destRow, 13, bankLessDeposit + wiseBalance + revolutBalance);
  } catch (err) {
    warnings.push('Bank previous: ' + err.message);
  }

  // 5) "bike bank" -- straight copy, not folded into the bank-previous sum
  // above (Anton asked for this as its own separate figure -- see Code.gs's
  // own comment on carryForwardMonthFigures_).
  try {
    const row = findLabelRow(sourceRows, FIXED_CELL_ITEMS.bikeBank);
    if (row === null) throw new Error('Could not find "bike bank" in column L of the outgoing month sheet.');
    const bikeBank = Number(readCell(sourceRows, row, 13)) || 0;
    const destRow = findLabelRow(newRows, FIXED_CELL_ITEMS.bikeBank);
    if (destRow === null) throw new Error('Could not find "bike bank" on the Template sheet.');
    writeCell(newRows, destRow, 13, bikeBank);
  } catch (err) {
    warnings.push('Bike bank: ' + err.message);
  }

  // 6) Still-open security deposits -- each category wrapped independently
  // so one bad table doesn't stop the other two.
  DEPOSIT_CATEGORIES.forEach((cat) => {
    try {
      copyDepositCategoryRows(sourceRows, newRows, cat);
    } catch (err) {
      warnings.push(cat.key + ' deposits: ' + err.message);
    }
  });

  // 7) Deposit-log row 15/16 totals -- see recomputeDepositLogTotals' own
  // comment. Wrapped the same way as everything above: a problem here
  // shouldn't stop the sheet that was already successfully created and
  // carried-forward above it from being returned as a success.
  try {
    recomputeDepositLogTotals(newRows, wiseBalance, revolutBalance);
  } catch (err) {
    warnings.push('Deposit totals: ' + err.message);
  }

  return warnings;
}

// ---- Step 1 + 2 together -- Code.gs's own "one click does both steps".
// `sheetIO` here is the same shape lib/accountsWrites.js's createSheetIO
// produces ({fetchSheetWithMeta, writeSheetJson}), passed in by the caller
// so this module doesn't need its own Drive-session plumbing.
//
// `dryRun: true` previews exactly what would happen -- which sheet would be
// created and what warnings it would carry -- without writing anything.
// Not present in Code.gs's version; added here since this is a once-a-month,
// real-money-adjacent operation with no undo, same reasoning backfillLedgerNotes
// (the OTHER ported repair tool) already used its own dryRun for. ----
async function createNextMonthSheetFromJson(sheetIO, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const now = (opts && opts.now) || new Date(); // overridable for tests only

  const currentMonthIndex = now.getMonth();
  const currentYear = now.getFullYear();
  const targetMonthIndex = (currentMonthIndex + 1) % 12;
  const targetYear = currentMonthIndex === 11 ? currentYear + 1 : currentYear;
  const currentMonthName = MONTH_SHEET_NAMES[currentMonthIndex];
  const targetMonthName = MONTH_SHEET_NAMES[targetMonthIndex];

  const existingTarget = await sheetIO.fetchSheetWithMeta(targetMonthName, targetYear);
  if (existingTarget.rows && existingTarget.rows.length) {
    return {
      success: false,
      error: `A sheet for "${targetMonthName} ${targetYear}" already exists -- refusing to overwrite it. ` +
        'Delete or rename it first if you really want a fresh copy from Template.'
    };
  }

  const template = await sheetIO.fetchSheetWithMeta('template');
  if (!template.rows || !template.rows.length) {
    return { success: false, error: 'No "template" sheet found -- nothing to copy from.' };
  }
  const newRows = template.rows.map((r) => (Array.isArray(r) ? r.slice() : r));

  const warnings = [];
  const source = await sheetIO.fetchSheetWithMeta(currentMonthName, currentYear);
  if (!source.rows || !source.rows.length) {
    warnings.push(
      `Could not find a sheet for the current month ("${currentMonthName} ${currentYear}") -- ` +
      'new sheet created, but nothing was carried forward into it.'
    );
  } else {
    warnings.push(...carryForwardMonthFigures(source.rows, newRows));
  }

  const result = {
    success: true,
    sheetName: `${targetMonthName} ${targetYear}`,
    monthName: targetMonthName,
    year: targetYear,
    dryRun
  };
  if (warnings.length) result.warning = warnings.join(' ');

  if (dryRun) {
    result.preview = true;
    return result;
  }

  await sheetIO.writeSheetJson(targetMonthName, newRows, null, targetYear);
  return result;
}

// ---- The automatic-trigger equivalent (Code.gs's checkForMonthEndRollover,
// installed nightly via installMonthEndRolloverTrigger at ~10PM). Fires
// every day and does nothing most days -- only actually rolls over when
// TOMORROW is the 1st. This timing is deliberate and load-bearing, same
// reasoning as the original: createNextMonthSheetFromJson figures out its
// source/target months from TODAY's date, so it must run while the
// outgoing month is still current. Checking "is tomorrow the 1st" (rather
// than a fixed day-of-month) is what keeps this correct across 28/29/30/31
// day months without special-casing any of them.
//
// Timezone note: `now` should be whatever the caller's clock says at the
// moment this fires -- deliberately NOT converted to any particular
// timezone here, for consistency with every other "what month/day is it"
// check already in this codebase (bikesWrites.js/contractWrites.js/etc. all
// call plain `new Date()` server-side too). The Vercel Cron entry this is
// wired to fires at 15:00 UTC daily -- the same schedule the existing
// calendar dailySweep cron already uses, chosen there (and reused here) to
// land at 22:00 Bangkok time, mirroring Code.gs's own ~10PM trigger. ----
function isTomorrowTheFirst(now) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return tomorrow.getDate() === 1;
}

async function checkForMonthEndRolloverJson(sheetIO, opts) {
  const now = (opts && opts.now) || new Date();
  if (!isTomorrowTheFirst(now)) {
    return { success: true, skipped: true, reason: 'Tomorrow is not the 1st -- nothing to do.' };
  }
  return createNextMonthSheetFromJson(sheetIO, opts);
}

module.exports = {
  createNextMonthSheetFromJson,
  checkForMonthEndRolloverJson,
  isTomorrowTheFirst,
  // Exposed for the test harness only.
  carryForwardMonthFigures,
  copyDepositCategoryRows,
  recomputeDepositLogTotals,
  findLabelRow,
  FIXED_CELL_ITEMS,
  DEPOSIT_CATEGORIES,
  DEPOSIT_TOTAL_ROW,
  DEPOSIT_SUBTOTAL_ROW
};
