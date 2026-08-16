// ---- Server-side accounts.html write layer (2026-08-16). ----
//
// This is the second half of the perf work described in the big PROGRESS.md
// entry from 2026-08-15/16 ("safe wins" -- fire-and-forget logging, merged
// notes writes, cash-write threading). Those cut the NUMBER of Drive round
// trips accounts.html's "add expense" flow needed, but production logs
// (pulled via the Vercel MCP connector, 2026-08-16) showed the real cost was
// never the Drive-side work itself -- it was that every one of those ~9
// remaining round trips was a SEPARATE browser<->Vercel<->Drive<->browser
// hop, each paying full transcontinental latency (Anton is in Thailand;
// Drive/Vercel are not) on top of the actual read/write. property-app's own
// architecture (see its api/data/route.ts comment) does the equivalent
// business logic server-side in ONE request; this file is that same move
// applied to accounts.html specifically, per Anton's explicit go-ahead
// ("Let's plan it out for accounts HTML... go ahead and build it").
//
// This is a byte-for-byte port of accounts.html's own client-side write
// layer (the block between "==== Monthly ... cascade ====" and "end WRITE
// layer" comments there) -- SAME business rules, SAME edge cases, SAME
// warnings, ported mechanically, not redesigned. The only two real changes
// from the browser version:
//   1. Every `fetchSheetWithMeta`/`writeSheetJson` call now goes straight to
//      Drive via `sheetIO` (built from readJsonFile/writeJsonFile in
//      lib/googleDrive.js) instead of a `fetch('/api/data/...')` round trip
//      back through the browser -- see createSheetIO in api/accounts/write.js
//      for what backs `sheetIO` here.
//   2. logTransactionB is no longer fire-and-forget. The 15/08/2026 perf
//      pass deliberately dropped its `await` because awaiting it cost a
//      whole extra browser<->Drive round trip (~1-2s) for a write that had
//      already succeeded. That specific cost doesn't exist here -- this
//      whole file runs in ONE Vercel function invocation, so awaiting the
//      log write only adds Drive-side latency (small), not another ocean
//      crossing. Awaiting it also means a request genuinely doesn't finish
//      until logging has (succeeded or safely given up), which is strictly
//      safer than the fire-and-forget version's "might get cut off by a
//      navigation" tradeoff -- see logTransactionB's own comment below.
//
// NOT ported: shiftNotesForInsertedRowFromJson -- confirmed dead code in the
// browser version (defined but never called; applyMonthNotesEditsFromJson's
// own shiftInsertedRow option superseded it, see that function's comment).
// Leaving out code with zero call sites rather than porting-then-never-
// calling it here too.
//
// Exports one factory, createAccountsWrites(sheetIO), rather than bare
// functions -- every write function below closes over `sheetIO` (via the
// `const { fetchSheetWithMeta, writeSheetJson } = sheetIO;` destructure
// right below) instead of each one needing sheetIO threaded through as an
// explicit parameter. This is also exactly why the ~2000 lines below are
// otherwise UNCHANGED from accounts.html's own copy -- every internal call
// like `fetchSheetWithMeta(monthName, year)` still reads exactly the same,
// it's just resolving to the Drive-backed closure instead of the browser's
// fetch-based one.
const { readJsonFile, writeJsonFile, ensureYearFolder, ConflictError } = require('./googleDrive');

// ---- Builds the `sheetIO` every function below reads/writes sheets
// through -- the direct-Drive equivalent of accounts.html's own
// fetchSheetWithMeta/writeSheetJson (which went through `fetch('/api/data/
// <sheet>?year=...')`). Mirrors api/data/[sheet].js's own resolveYearFolderId
// + filename logic EXACTLY (year ? `${sheet}_${year}.json` in a per-year
// subfolder : `${sheet}.json` in the app root) so a sheet written here and
// one written through the existing /api/data/<sheet> route (e.g. by a page
// other than accounts.html, or by a manual Drive edit) always land on the
// very same file -- there is deliberately no separate storage convention
// for "written via this new endpoint" vs. "written the old way".
//
// `session`, if passed, gets the exact same driveYearFolders/driveFileIds
// caching benefit api/data/[sheet].js already relies on (see that file's
// resolveYearFolderId comment, and resolveFileMeta in this module's own
// googleDrive.js) -- this just doesn't ALSO call setSessionCookie itself
// (unlike that route's own resolveYearFolderId) since the caller
// (api/accounts/write.js) sets the cookie once at the end of the whole
// request instead of per-sheet-touch; a single write action here can touch
// 6+ different sheets/files in one request, so setting it after every one
// would be redundant, not incorrect.
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

function createAccountsWrites(sheetIO) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // ---- PERF (16/08/2026) instrumentation -- lightweight Date.now() diffs,
  // logged via console.log so Vercel's runtime logs (which have no
  // built-in per-request duration breakdown) show real per-step numbers on
  // the next test click. Never throws, never affects control flow -- purely
  // observational. See PROGRESS.md for the full "why" behind this pass. ----
  function nowMs() { return Date.now(); }
  function logStep(label, startMs) {
    console.log('[accountsWrites] ' + label + ': ' + (Date.now() - startMs) + 'ms');
  }

  // PERF (16/08/2026) correctness note, found by this pass's own fake-Drive
  // regression suite: logTransactionB's retry-on-ConflictError loop below
  // only protects against a race where "transactionLog" already EXISTS --
  // writeJsonFile's conflict check is `if (expectedModifiedTime && ...)`,
  // which is skipped entirely when the file doesn't exist yet
  // (modifiedTime is null on a brand-new file). Now that several lanes can
  // call logTransactionB concurrently within the same request (e.g. a cash
  // append's own internal log call racing the top-level log call, or a
  // deposit-total write's internal log call racing either of those), if
  // "transactionLog" happens to not exist yet at all (the very first log
  // entry ever), two concurrent callers can both see "doesn't exist", both
  // create it, and Drive allows two files with the same name in the same
  // folder -- one of the two entries silently lands in an orphaned
  // duplicate file that no later read will ever see again. This never
  // happened in the old sequential code (there was only ever one
  // logTransactionB in flight at a time). The queue below serializes just
  // the actual log read-modify-write across every caller in THIS request
  // (createAccountsWrites is instantiated fresh per request -- see
  // api/accounts/write.js -- so this queue never leaks across requests)
  // without blocking any of the surrounding lane's OTHER, unrelated work.
  let logQueue = Promise.resolve();
  function logTransactionB(entry) {
    const run = () => logTransactionBInner(entry);
    const next = logQueue.then(run, run);
    logQueue = next.catch(() => {});
    return next;
  }

  // ---- Transaction log (see accounts.html's original comment for the full
  // "why" -- unchanged here). Still best-effort/additive-only and still
  // retries a couple of times on a write conflict (a pure append, so
  // re-reading and re-appending is always safe here, unlike a real
  // business write where a conflict has to be surfaced instead). The ONE
  // behavior change from the browser version: every call site below now
  // `await`s this instead of firing it and moving on -- see the file-level
  // comment above for why that trade-off flips server-side. ----
  async function logTransactionBInner(entry) {
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
          if (writeErr instanceof ConflictError || writeErr.isConflict) continue; // someone else logged in between -- retry
          throw writeErr;
        }
      }
    } catch (e) {
      console.warn('Transaction log write failed (non-critical):', e && e.message);
    }
  }

// ---- extracted accounts.html lines 480-481 ----
const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

// ---- extracted accounts.html lines 578-580 ----
const ACCOUNTS_MONTH_FILES = {
  0: 'January', 1: 'February', 2: 'march', 3: 'april', 4: 'may', 5: 'June', 6: 'July', 7: 'August'
};

// ---- extracted accounts.html lines 941-945 ----
const DEPOSIT_CATEGORIES_B = [
  { key: 'bank',    label: 'Bank',    header: 'deposit scan',    dateCol: 15, amountCol: 16, nameCol: 17 },
  { key: 'wise',    label: 'Wise',    header: 'deposit wise',    dateCol: 18, amountCol: 19, nameCol: 20 },
  { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24 }
];

// ---- extracted accounts.html lines 2910-2918 ----
// Mirrors EXPENSE_TYPE_COLORS in Code.gs, so the in-app list gives the same
// at-a-glance color cue as the spreadsheet's expense description cell.
const EXPENSE_TYPE_COLORS = {
  business: null,
  personal: '#cfe2f3',
  wages: '#f6b26b',
  transfer: '#ffeb3b',
  transferComplete: '#00e676'
};

// ---- extracted accounts.html lines 622-635 ----
// ---- Ported from Code.gs looksLikeSummaryLabel -- flags a label as a
// summary/totals line so the real data rows stop being read the moment
// either side hits one. ----
function looksLikeSummaryLabel(raw) {
  const t = (raw || '').toString().trim().toLowerCase();
  if (!t) return false;
  if (t.indexOf('total') === 0) return true;
  const phrases = [
    'income for month', 'income for the month', 'income less',
    'bussiness expense', 'business expense', 'personal expense',
    'wages and bike', 'net profit', 'actual profit', '% of'
  ];
  return phrases.some(p => t.indexOf(p) !== -1);
}

// ---- extracted accounts.html lines 637-657 ----
// ---- Ported from Code.gs parseExpenseBikeSplitsNote. ----
function parseExpenseBikeSplitsNote(note, fallbackAmount) {
  const trimmed = (note || '').toString().trim();
  if (!trimmed) return [];
  function cleanAmount(raw) {
    return (raw === '' || raw === null || raw === undefined || isNaN(Number(raw))) ? '' : Number(raw);
  }
  if (trimmed.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(s => ({ bike: ((s && s.bike) || '').toString().trim(), amount: cleanAmount(s && s.amount) }))
        .filter(s => s.bike && s.amount !== '');
    } catch (e) {
      return [];
    }
  }
  const fallback = cleanAmount(fallbackAmount);
  return fallback === '' ? [] : [{ bike: trimmed, amount: fallback }];
}

// ---- extracted accounts.html lines 659-669 ----
// dd/mm/yyyy is what the rest of this page's date logic (dmyToIso etc.)
// expects. JSON dates come through as "YYYY-MM-DD..." (see export_to_json.py's
// encoding convention) -- take just the date part, regardless of any time
// component, same as Code.gs's cellToString formatting a Date to dd/MM/yyyy.
function jsonCellToDmy(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = v.toString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

// ---- extracted accounts.html lines 671-701 ----
// ---- Ported from Code.gs's ACCOUNTS_SUMMARY_ITEMS -- "row" is only a
// starting guess (real row positions drift sheet to sheet; findSummaryRow
// below always re-locates the label before trusting it). `percent` marks
// the 2 (of 15) items that are a percentage rather than a currency figure,
// confirmed against the workbook's own number formats ([$฿]#,##0.00 vs
// 0.00%). ----
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

// ---- extracted accounts.html lines 703-791 ----
function summaryNorm(s) { return (s || '').toString().trim().toLowerCase(); }

// ---- Same "check the expected row first, else scan the whole column"
// self-healing lookup as Code.gs's readAccountsSummaryItemBatched_ /
// findDepositRow -- confirmed necessary here too: this workbook's actual
// row positions have drifted 1-2 rows off ACCOUNTS_SUMMARY_ITEMS' hardcoded
// expectations (e.g. July's "total expenses" sits at row 145, not 146).
// `rows` is 0-indexed (rows[0] is sheet row 1).
function findSummaryRow(rows, item) {
  const target = summaryNorm(item.expectedLabel);
  const expectedRow = rows[item.row - 1];
  if (expectedRow && summaryNorm(expectedRow[item.labelCol - 1]) === target) return item.row;
  for (let r = 0; r < rows.length; r++) {
    if (rows[r] && summaryNorm(rows[r][item.labelCol - 1]) === target) return r + 1;
  }
  return null;
}

// JSON holds the raw underlying number (openpyxl's data_only value), not
// the sheet's formatted display string -- so unlike Code.gs's
// getDisplayValue() call, formatting has to happen here instead. Percent
// cells store a plain fraction (e.g. 0.4568 for "45.68%").
function formatSummaryValue(raw, isPercent) {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (isNaN(num)) return null;
  return isPercent
    ? (num * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'
    : money(num);
}

// ---- The "personal expenses total"/"wages and bike purchase" cells (see
// updateExpenseTypeTotalRefFromJson below) are the one summary figure this
// port can keep genuinely live after a write, because Code.gs itself
// maintains THEM as a plain "=C29+C50+C55"-style chain of cell references
// (not a SUM range) -- so writing that same literal formula STRING into the
// JSON cell and evaluating it here (summing whatever each referenced cell
// currently holds) reproduces Code.gs's own mechanism exactly, no live
// recalc engine required. This does NOT extend to the sheet's other
// summary cells ("total expenses", "income for month", "net profit", the
// deposit "total" row, etc.) -- those are genuine SUM-range/cross-sheet
// formulas in the live workbook that only Sheets' own recalculation keeps
// current; this JSON port has no equivalent engine for those, so (same as
// every other read-only figure on this page) they reflect whatever was
// true at the last export and will drift after writes. That's a real,
// known limitation of the read-only summary strip, not something this
// write-layer pass attempts to solve -- the transactional data underneath
// (expense/income rows, cash sheet, deposit totals, bikes-sheet running
// totals) is what's actually kept correct. ----
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
      // A real cell reference (e.g. "C55") -- look up whatever that cell
      // currently holds.
      const col = columnLetterToIndexJson(m[1]);
      const row = Number(m[2]);
      const v = rows[row - 1] ? rows[row - 1][col - 1] : undefined;
      const n = Number(v);
      if (!isNaN(n)) total += n;
      return;
    }
    // A plain numeric literal -- updateExpenseTypeTotalRefFromJson seeds
    // the term list with the cell's OWN prior numeric value (as a string)
    // the first time it converts a plain-number cell into a formula, same
    // as Code.gs's updateExpenseTypeTotalRef does -- that literal has to
    // be added as-is, not looked up as a cell reference.
    const n = Number(t);
    if (!isNaN(n)) total += n;
  });
  return total;
}
function readSummaryItem(rows, item, warnings, sheetLabel) {
  const row = findSummaryRow(rows, item);
  if (row === null) {
    warnings.push('Could not find "' + item.expectedLabel + '" in "' + sheetLabel + '" -- "' + item.displayLabel + '" is not shown.');
    return { label: item.displayLabel, value: null };
  }
  let rawVal = rows[row - 1][item.valueCol - 1];
  if (typeof rawVal === 'string' && rawVal.charAt(0) === '=') rawVal = evalSummaryFormulaJson(rows, rawVal);
  return { label: item.displayLabel, value: formatSummaryValue(rawVal, !!item.percent) };
}

// ---- extracted accounts.html lines 1131-1134 ----
function fmtMoneyB(n) {
  const v = Number(n);
  return '฿' + (isNaN(v) ? '0' : v.toLocaleString('en-US'));
}

// ---- extracted accounts.html lines 1135-1135 ----
function pad2Json(n) { return String(n).padStart(2, '0'); }

// ---- extracted accounts.html lines 1136-1140 ----
function isoDateInputToSheetValue(isoDate) {
  const m = String(isoDate || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
}

// ---- extracted accounts.html lines 1141-1141 ----
function accountsCurrentYear() { return new Date().getFullYear(); }

// ---- extracted accounts.html lines 1143-1171 ----
// FIFTH bike-name matcher in this codebase (see add-bikes.html's comment
// on the four others) -- mirrors Code.gs's bikeNamesMatchForRentalLog.
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
  // KNOWN QUIRK (inherited from Code.gs -- see customers.html's identical
  // comment): a garbled bike name containing "total" as a raw prefix can
  // wrongly match the income table's own "total" label row.
  return na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

// ---- extracted accounts.html lines 1172-1179 ----
function findBikesSheetMonthColIdxB(headerRow, monthName) {
  const targetShort = monthName.toString().trim().toLowerCase().slice(0, 3);
  for (let c = 0; c < headerRow.length; c++) {
    const h = (headerRow[c] || '').toString().trim().toLowerCase();
    if (h && h.slice(0, 3) === targetShort) return c;
  }
  return -1;
}

// ---- extracted accounts.html lines 1180-1192 ----
// BIKES_EXPENSE_SECTION_START_ROW (Code.gs) = 52 (1-indexed sheet row) =
// array index 51 -- the "bikes" sheet has two separate blocks of bike-name
// rows sharing the same header/month columns: an INCOME block starting at
// row 2 (array idx 1, the default) and an EXPENSE block starting at row 52
// (array idx 51). sectionStartIdx below is that 0-indexed array offset.
const BIKES_EXPENSE_SECTION_START_IDX_B = 51;
// A bike's income row and its expense row always sit exactly this many
// array rows apart (BIKES_EXPENSE_SECTION_START_IDX_B - 1, the income
// block's own start idx) -- mirrors the fixed +50 row offset the original
// spreadsheet's formulas hard-coded directly into cell references (e.g.
// Zoomer X's income row 46 "expenses" column literally read "=P96", not a
// bike-name lookup). See recomputeBikeRowTotalsB below.
const BIKES_EXPENSE_SECTION_ROW_OFFSET_B = 50;

// ---- extracted accounts.html lines 1194-1201 ----
function findBikesHeaderColIdxB(headerRow, label) {
  const target = label.toString().trim().toLowerCase();
  for (let c = 0; c < headerRow.length; c++) {
    const h = (headerRow[c] || '').toString().trim().toLowerCase();
    if (h === target) return c;
  }
  return -1;
}

// ---- extracted accounts.html lines 1203-1284 ----
// Ported 14/08/2026 to fix a real bug: adding/editing an expense or income
// entry split onto a bike updated that bike's single month cell on the
// "bikes" sheet but left Expenses/Profit/Net profit frozen on bike-
// income.html, because those columns used to be LIVE FORMULAS in the real
// spreadsheet (confirmed against a formula-intact copy Anton supplied --
// see PROGRESS.md "Reference materials", 2026-08-14) that auto-recalculated
// whenever the underlying month cells changed:
//   expense row's  total (P)      = SUM of that row's own month cells B:O
//     e.g. Zoomer X's expense row 96: "=SUM(B96:O96)"
//   income row's   total (P)      = SUM of that row's own month cells C:O
//     e.g. Zoomer X's income row 46: "=sum(C46:O46)"
//   income row's   expenses (Q)   = expense row's total (P), 50 rows down
//     e.g. Zoomer X's income row 46: "=P96"
//   income row's   profit (R)     = income row's total (P) - expenses (Q)
//     e.g. "=P46-Q46"
//   income row's   net profit (S) = profit (R) - cost (B)
//     e.g. "=R46-B46"
// The JSON model has no formula engine, so this cascade has to be done
// explicitly every time either row's month cells change. Mutates `rows`
// in place (both the income row and the expense row) -- caller still owns
// writing it back. Throws (does not mutate `rows`) if the expected paired
// row can't be found/matched or a required header is missing, so the
// caller can surface that as a non-fatal warning without losing the
// underlying month-cell write that already happened.
function recomputeBikeRowTotalsB(rows, header, incomeRowIdx, expenseRowIdx, bikeNameTrimmed) {
  const incomeRow = rows[incomeRowIdx];
  const expenseRow = rows[expenseRowIdx];
  if (!incomeRow || !expenseRow) {
    throw new Error('expected a paired row at array index ' + incomeRowIdx + '/' + expenseRowIdx + ' but one does not exist');
  }
  const incomeName = (incomeRow[0] || '').toString().trim();
  const expenseName = (expenseRow[0] || '').toString().trim();
  if (!bikeNamesMatchForRentalLogB(incomeName, bikeNameTrimmed) || !bikeNamesMatchForRentalLogB(expenseName, bikeNameTrimmed)) {
    throw new Error('expected the paired row to also be "' + bikeNameTrimmed + '" but found "' + incomeName + '" / "' + expenseName + '"');
  }

  const totalCol = findBikesHeaderColIdxB(header, 'total');
  const expensesCol = findBikesHeaderColIdxB(header, 'expenses');
  const profitCol = findBikesHeaderColIdxB(header, 'profit');
  const netProfitCol = findBikesHeaderColIdxB(header, 'net profit');
  const costCol = findBikesHeaderColIdxB(header, 'cost');
  const missing = [];
  if (totalCol === -1) missing.push('total');
  if (expensesCol === -1) missing.push('expenses');
  if (profitCol === -1) missing.push('profit');
  if (netProfitCol === -1) missing.push('net profit');
  if (costCol === -1) missing.push('cost');
  if (missing.length) throw new Error('could not find the "' + missing.join('", "') + '" column header(s) on the "bikes" sheet');

  // Column 2 ("C", the year-baseline col) through column 14 ("O", dec) --
  // matches the SUM ranges in the real formulas above exactly.
  const MONTHS_LAST_COL_B = 14;
  function sumMonths(row, startCol) {
    let s = 0;
    for (let c = startCol; c <= MONTHS_LAST_COL_B; c++) {
      const v = row[c];
      const n = Number(v);
      if (v !== '' && v !== null && v !== undefined && !isNaN(n)) s += n;
    }
    return s;
  }

  const newIncomeRow = incomeRow.slice();
  const newExpenseRow = expenseRow.slice();
  const maxCol = Math.max(totalCol, expensesCol, profitCol, netProfitCol, costCol);
  while (newIncomeRow.length <= maxCol) newIncomeRow.push('');
  while (newExpenseRow.length <= totalCol) newExpenseRow.push('');

  const expenseTotal = sumMonths(newExpenseRow, 1);  // expense row: SUM(B:O), matches "=SUM(B96:O96)"
  const incomeTotal = sumMonths(newIncomeRow, 2);    // income row: SUM(C:O), matches "=sum(C46:O46)"
  const cost = Number(newIncomeRow[costCol]) || 0;
  const profit = incomeTotal - expenseTotal;

  newExpenseRow[totalCol] = expenseTotal;
  newIncomeRow[totalCol] = incomeTotal;
  newIncomeRow[expensesCol] = expenseTotal;
  newIncomeRow[profitCol] = profit;
  newIncomeRow[netProfitCol] = profit - cost;

  rows[incomeRowIdx] = newIncomeRow;
  rows[expenseRowIdx] = newExpenseRow;
}

// ---- extracted accounts.html lines 1286-1340 ----
// Found live 14/08/2026: the income block has two pseudo-bike catch-all
// rows -- "extras" (income's implicit default when no real bike is picked)
// and "deposit" -- that sit BEFORE the income block's own "totals" row and
// have NO matching row in the expense block 50 rows down (real bikes fill
// idx 1..45 there before the expense block's own "total" row -- "extras"/
// "deposit" were never part of that list). In the original spreadsheet
// these rows' expenses/profit/net-profit columns were never "=P<row+50>"
// formulas at all -- confirmed against exported data: "extras"/"deposit"
// always have an EMPTY expenses cell, with profit/net-profit just mirroring
// total (i.e. profit = total - 0, net profit = profit - cost). This does
// the same self-only recompute for a row that has no real paired row,
// instead of reaching 50 rows down into whatever happens to be there.
function recomputeBikeRowSoloTotalsB(rows, header, rowIdx, isExpenseSection) {
  const row = rows[rowIdx];
  if (!row) throw new Error('expected a row at array index ' + rowIdx + ' but it does not exist');
  const totalCol = findBikesHeaderColIdxB(header, 'total');
  if (totalCol === -1) throw new Error('could not find the "total" column header on the "bikes" sheet');
  const MONTHS_LAST_COL_B = 14;
  function sumMonths(r, startCol) {
    let s = 0;
    for (let c = startCol; c <= MONTHS_LAST_COL_B; c++) {
      const v = r[c];
      const n = Number(v);
      if (v !== '' && v !== null && v !== undefined && !isNaN(n)) s += n;
    }
    return s;
  }
  const newRow = row.slice();
  while (newRow.length <= totalCol) newRow.push('');
  if (isExpenseSection) {
    // Expense-section rows only ever carry their own "total" (=SUM(B:O)) --
    // expenses/profit/net-profit are income-row-only columns.
    newRow[totalCol] = sumMonths(newRow, 1);
  } else {
    const expensesCol = findBikesHeaderColIdxB(header, 'expenses');
    const profitCol = findBikesHeaderColIdxB(header, 'profit');
    const netProfitCol = findBikesHeaderColIdxB(header, 'net profit');
    const costCol = findBikesHeaderColIdxB(header, 'cost');
    const missing = [];
    if (expensesCol === -1) missing.push('expenses');
    if (profitCol === -1) missing.push('profit');
    if (netProfitCol === -1) missing.push('net profit');
    if (costCol === -1) missing.push('cost');
    if (missing.length) throw new Error('could not find the "' + missing.join('", "') + '" column header(s) on the "bikes" sheet');
    const maxCol = Math.max(totalCol, expensesCol, profitCol, netProfitCol, costCol);
    while (newRow.length <= maxCol) newRow.push('');
    const total = sumMonths(newRow, 2);
    const existingExpenses = Number(newRow[expensesCol]) || 0;
    const cost = Number(newRow[costCol]) || 0;
    newRow[totalCol] = total;
    newRow[profitCol] = total - existingExpenses;
    newRow[netProfitCol] = (total - existingExpenses) - cost;
  }
  rows[rowIdx] = newRow;
}

// ---- extracted accounts.html lines 1342-1399 ----
async function addRentalAmountToBikesSheetFromJson(bikeModel, rawAmount, monthName, sectionStartIdx) {
  const amount = Number(rawAmount);
  if (rawAmount === '' || rawAmount === null || rawAmount === undefined || isNaN(amount) || amount === 0) return;
  const bikeNameTrimmed = (bikeModel || '').toString().trim();
  if (!bikeNameTrimmed) throw new Error('No bike name given -- bike monthly total was NOT updated.');
  const { rows, modifiedTime } = await fetchSheetWithMeta('bikes');
  const header = rows[0] || [];
  const startIdx = sectionStartIdx || 1;
  let rowIdx = -1;
  for (let i = startIdx; i < rows.length; i++) {
    const name = (rows[i][0] || '').toString().trim();
    if (name && bikeNamesMatchForRentalLogB(name, bikeNameTrimmed)) { rowIdx = i; break; }
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

  // Recompute the income/expenses/profit/net-profit cascade for this bike
  // (see recomputeBikeRowTotalsB above). Best-effort: if it can't be done
  // (unexpected sheet shape), the month-cell write above still happens and
  // still gets saved -- we just surface a warning afterward rather than
  // losing that write entirely.
  const isExpenseSection = startIdx === BIKES_EXPENSE_SECTION_START_IDX_B;
  const pairedRowIdx = isExpenseSection ? (rowIdx - BIKES_EXPENSE_SECTION_ROW_OFFSET_B) : (rowIdx + BIKES_EXPENSE_SECTION_ROW_OFFSET_B);
  const incomeRowIdx = isExpenseSection ? pairedRowIdx : rowIdx;
  const expenseRowIdx = isExpenseSection ? rowIdx : pairedRowIdx;
  let cascadeWarning = null;
  try {
    const pairedRow = newRows[pairedRowIdx];
    const pairedName = ((pairedRow && pairedRow[0]) || '').toString().trim();
    const hasRealPair = !!pairedRow && bikeNamesMatchForRentalLogB(pairedName, bikeNameTrimmed);
    if (hasRealPair) {
      recomputeBikeRowTotalsB(newRows, header, incomeRowIdx, expenseRowIdx, bikeNameTrimmed);
    } else {
      // No paired row 50 rows away actually matches this name (e.g. the
      // "extras"/"deposit" catch-all rows -- see recomputeBikeRowSoloTotalsB
      // above) -- recompute this row's own total (and, on the income side,
      // profit/net-profit) instead of reaching for a paired row that isn't
      // really this bike's counterpart.
      recomputeBikeRowSoloTotalsB(newRows, header, rowIdx, isExpenseSection);
    }
  } catch (e) {
    cascadeWarning = 'Totals cascade (expenses/profit/net profit) NOT recalculated for "' + bikeNameTrimmed + '": ' + e.message;
  }

  await writeSheetJson('bikes', newRows, modifiedTime);
  if (cascadeWarning) throw new Error(cascadeWarning);
}

// ---- extracted accounts.html lines 1401-1428 ----
// Wise/Revolut running deposit total (L11/M11 wise, L12/M12 revolut on
// whichever month sheet is being edited -- accounts.html can edit a past
// month via the month selector, so (unlike every other page's copy of this
// helper) monthName/year are explicit params here, not always "now").
async function processDepositForPaymentFromJson(paidByLower, rawAmount, monthName, year) {
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  if (!rows || !rows.length) throw new Error('No sheet found for "' + monthName + '" -- could not update the ' + paidByLower + ' deposit total.');
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
  await logTransactionB({
    page: 'accounts.html', action: 'processDepositForPaymentFromJson', reversible: true,
    summary: (delta >= 0 ? 'Deposit total +' : 'Deposit total ') + fmtMoneyB(delta) + ' — ' + paidByLower + ' (' + monthName + ' ' + year + ')',
    writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] }]
  });
}

// ---- extracted accounts.html lines 1430-1477 ----
// JSON port of consumeDeposit (see deposits.html's identical copy for the
// full comment) -- used only by addIncomeRow's "paid from an existing
// deposit" checkbox, never on edit (Code.gs never touches deposit balances
// on editIncome either).
async function consumeDepositFromJson(cat, depositRow, deductAmount, monthName, year) {
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  const norm = s => (s || '').toString().trim().toLowerCase();
  const headerRaw = rows[0] ? rows[0][cat.dateCol - 1] : undefined;
  if (norm(headerRaw) !== cat.header) {
    throw new Error('"' + monthName + '" sheet: expected "' + cat.header + '" in column ' + cat.dateCol + ', row 1 but found "' + (headerRaw || '(blank)') + '" -- the deposit was NOT updated.');
  }
  const rowIdx = depositRow - 1;
  const row = rows[rowIdx] || [];
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
    throw new Error('That ' + cat.label + ' deposit no longer exists (it may have already been used) -- please refresh and pick again.');
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
    newRow[cat.dateCol - 1] = ''; newRow[cat.amountCol - 1] = ''; newRow[cat.nameCol - 1] = '';
  } else {
    newRow[cat.amountCol - 1] = remaining;
  }
  newRows[rowIdx] = newRow;
  await writeSheetJson(monthName, newRows, modifiedTime, year);
  await logTransactionB({
    page: 'accounts.html', action: 'consumeDepositFromJson', reversible: true,
    summary: 'Spent ' + fmtMoneyB(deductAmount) + ' of ' + cat.label + ' deposit' + (nameVal ? (' — ' + nameVal) : '') + ' (' + monthName + ' ' + year + ')',
    writes: [{ sheet: monthName, year: year, row: rowIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol], before: [dateVal, amtVal, nameVal], after: [newRow[cat.dateCol - 1], newRow[cat.amountCol - 1], newRow[cat.nameCol - 1]] }]
  });
}

// ---- extracted accounts.html lines 1479-1495 ----
// ---- "cash" sheet helpers -- a single running ledger (not month-scoped),
// income logged in columns A-C, expenses in columns E-G (column D is an
// unused manual-highlight spacer). Mirrors resolveCashRow/findCashCandidates/
// cashRowStillMatches/updateCashRow/deleteCashRow/appendCashSheetRowText/
// appendCashExpenseRowText from Code.gs exactly. ----
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

// ---- extracted accounts.html lines 1496-1522 ----
async function appendCashSheetRowFromJson(incomeText, rawAmount) {
  const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
  if (!rows || !rows.length) throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
  const newRows = rows.map(r => r.slice());
  const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [1, 2, 3]);
  while (newRows.length <= targetIdx) newRows.push([]);
  const row = newRows[targetIdx].slice();
  while (row.length < 3) row.push('');
  const amountValue = (rawAmount !== '' && rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) ? Number(rawAmount) : '';
  row[0] = isoDateInputToSheetValue(accountsTodayIso());
  row[1] = incomeText;
  row[2] = amountValue;
  newRows[targetIdx] = row;
  const writeRes = await writeSheetJson('cash', newRows, modifiedTime);
  await logTransactionB({
    page: 'accounts.html', action: 'appendCashSheetRowFromJson', reversible: true,
    summary: 'Cash income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)'),
    writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [1, 2, 3], before: ['', '', ''], after: [row[0], row[1], row[2]] }]
  });
  // PERF (15/08/2026): rows/modifiedTime let a caller that's about to
  // recompute cash totals anyway skip re-reading "cash" from scratch --
  // see recomputeCashSheetTotalsB's comment. `row` (the 1-based sheet row
  // number) is kept as the top-level return shape callers already relied
  // on before this change (none currently capture the return value at
  // all, so this is purely additive).
  return { row: targetIdx + 1, rows: newRows, modifiedTime: writeRes.modifiedTime };
}

// ---- extracted accounts.html lines 1523-1544 ----
async function appendCashExpenseRowFromJson(expenseText, rawAmount) {
  const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
  if (!rows || !rows.length) throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
  const newRows = rows.map(r => r.slice());
  const targetIdx = findFullyEmptyRowIdxJson(newRows, 1, [5, 6, 7]);
  while (newRows.length <= targetIdx) newRows.push([]);
  const row = newRows[targetIdx].slice();
  while (row.length < 7) row.push('');
  const amountValue = (rawAmount !== '' && rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) ? Number(rawAmount) : '';
  row[4] = isoDateInputToSheetValue(accountsTodayIso());
  row[5] = expenseText;
  row[6] = amountValue;
  newRows[targetIdx] = row;
  const writeRes = await writeSheetJson('cash', newRows, modifiedTime);
  await logTransactionB({
    page: 'accounts.html', action: 'appendCashExpenseRowFromJson', reversible: true,
    summary: 'Cash expense ' + fmtMoneyB(amountValue) + ' — ' + (expenseText || '(no description)'),
    writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [5, 6, 7], before: ['', '', ''], after: [row[4], row[5], row[6]] }]
  });
  // PERF (15/08/2026): see the matching comment in appendCashSheetRowFromJson.
  return { row: targetIdx + 1, rows: newRows, modifiedTime: writeRes.modifiedTime };
}

// ---- extracted accounts.html lines 1545-1548 ----
function accountsTodayIso() {
  const now = new Date();
  return now.getFullYear() + '-' + pad2Json(now.getMonth() + 1) + '-' + pad2Json(now.getDate());
}

// ---- extracted accounts.html lines 1549-1568 ----
async function findCashCandidatesFromJson(side, text, amount) {
  const { rows } = await fetchSheetWithMeta('cash');
  const dateColIdx = side === 'expense' ? 4 : 0; // 0-indexed: E=4 or A=0
  const expectedText = (text || '').toString().trim();
  const expectedAmountNum = (amount === '' || amount === null || amount === undefined || isNaN(Number(amount))) ? null : Number(amount);
  const candidates = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const rowLabel = (r[dateColIdx + 1] || '').toString().trim();
    const rowAmountRaw = r[dateColIdx + 2];
    const rowAmountNum = (rowAmountRaw === '' || rowAmountRaw === null || rowAmountRaw === undefined || isNaN(Number(rowAmountRaw))) ? null : Number(rowAmountRaw);
    const amountMatches = (rowAmountNum === null && expectedAmountNum === null) ||
      (rowAmountNum !== null && expectedAmountNum !== null && rowAmountNum === expectedAmountNum);
    if (rowLabel === expectedText && amountMatches) {
      const rawDate = r[dateColIdx];
      candidates.push({ row: i + 1, date: jsonCellToDmy(rawDate), text: rowLabel, amount: rowAmountNum === null ? '' : rowAmountNum });
    }
  }
  return candidates;
}

// ---- extracted accounts.html lines 1569-1575 ----
async function resolveCashRowFromJson(side, cashRowChoice, text, amount) {
  if (cashRowChoice) return { row: Math.round(Number(cashRowChoice)) };
  const candidates = await findCashCandidatesFromJson(side, text, amount);
  if (candidates.length === 0) return { row: null };
  if (candidates.length === 1) return { row: candidates[0].row };
  return { needsDisambiguation: true, candidates };
}

// ---- extracted accounts.html lines 1576-1587 ----
async function cashRowStillMatchesFromJson(rows, cashRow, labelColIdx, amountColIdx, expectedText, expectedAmount) {
  if (!cashRow || cashRow < 2) return false;
  const r = rows[cashRow - 1];
  if (!r) return false;
  const actualText = (r[labelColIdx] || '').toString().trim();
  const actualAmountRaw = r[amountColIdx];
  const expectedAmountNum = (expectedAmount === '' || expectedAmount === null || expectedAmount === undefined) ? null : Number(expectedAmount);
  const actualAmountNum = (actualAmountRaw === '' || actualAmountRaw === null || actualAmountRaw === undefined || isNaN(Number(actualAmountRaw))) ? null : Number(actualAmountRaw);
  const amountMatches = (actualAmountNum === null && expectedAmountNum === null) ||
    (actualAmountNum !== null && expectedAmountNum !== null && actualAmountNum === expectedAmountNum);
  return actualText === (expectedText || '').toString().trim() && amountMatches;
}

// ---- extracted accounts.html lines 1588-1604 ----
async function updateCashRowFromJson(cashRow, side, expectedOldText, expectedOldAmount, newText, newAmount) {
  const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
  const labelColIdx = side === 'expense' ? 5 : 1;
  const amountColIdx = side === 'expense' ? 6 : 2;
  if (!(await cashRowStillMatchesFromJson(rows, cashRow, labelColIdx, amountColIdx, expectedOldText, expectedOldAmount))) {
    throw new Error('Could not confirm "cash" sheet row ' + cashRow + ' still matches this entry -- it was NOT updated. Please check/update it manually if needed.');
  }
  const newRows = rows.map(r => r.slice());
  const row = newRows[cashRow - 1].slice();
  while (row.length <= amountColIdx) row.push('');
  row[labelColIdx] = newText;
  row[amountColIdx] = (newAmount === '' || newAmount === undefined || newAmount === null || isNaN(Number(newAmount))) ? '' : Number(newAmount);
  newRows[cashRow - 1] = row;
  const writeRes = await writeSheetJson('cash', newRows, modifiedTime);
  // PERF (15/08/2026): see the matching comment in appendCashSheetRowFromJson.
  return { rows: newRows, modifiedTime: writeRes.modifiedTime };
}

// ---- extracted accounts.html lines 1605-1634 ----
async function deleteCashRowFromJson(cashRow, side, expectedText, expectedAmount) {
  const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
  const dateColIdx = side === 'expense' ? 4 : 0;
  const labelColIdx = dateColIdx + 1, amountColIdx = dateColIdx + 2;
  if (!(await cashRowStillMatchesFromJson(rows, cashRow, labelColIdx, amountColIdx, expectedText, expectedAmount))) {
    throw new Error('Could not confirm "cash" sheet row ' + cashRow + ' still matches this entry -- it was NOT removed. Please check/remove it manually if needed.');
  }
  // Deletes just the 3 cells (date/label/amount) and shifts everything
  // below THOSE 3 COLUMNS up by one -- the other side (income vs expense)
  // of the same physical rows is untouched, same as the live version's
  // deleteCells(ROWS) scoped to a 1x3 range.
  const newRows = rows.map(r => r.slice());
  for (let i = cashRow - 1; i < newRows.length - 1; i++) {
    const src = newRows[i + 1] || [];
    const row = newRows[i].slice();
    row[dateColIdx] = src[dateColIdx] !== undefined ? src[dateColIdx] : '';
    row[labelColIdx] = src[labelColIdx] !== undefined ? src[labelColIdx] : '';
    row[amountColIdx] = src[amountColIdx] !== undefined ? src[amountColIdx] : '';
    newRows[i] = row;
  }
  const lastIdx = newRows.length - 1;
  if (newRows[lastIdx]) {
    const row = newRows[lastIdx].slice();
    row[dateColIdx] = ''; row[labelColIdx] = ''; row[amountColIdx] = '';
    newRows[lastIdx] = row;
  }
  const writeRes = await writeSheetJson('cash', newRows, modifiedTime);
  // PERF (15/08/2026): see the matching comment in appendCashSheetRowFromJson.
  return { rows: newRows, modifiedTime: writeRes.modifiedTime };
}

// ---- extracted accounts.html lines 1636-1655 ----
// ---- Accounts free-row finder (JSON port of getAccountsFreeRow) -- finds
// a row safe to write a new Expense OR Income entry into, packing new
// entries alongside the other side rather than always adding a new row. If
// every row runs straight into a "total ..." summary row with no gap, a
// blank row is spliced in directly above it (same as insertRowBefore on
// the live version), so it lands inside whatever range the sheet's own
// SUM-style formulas already cover. ----
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

// ---- extracted accounts.html lines 1656-1671 ----
function findAccountsFreeRowIdxJson(rows2D, side) {
  for (let idx = 1; idx < rows2D.length; idx++) {
    const r = rows2D[idx] || [];
    const expenseLabel = (r[1] || '').toString().trim();
    const incomeLabel = (r[6] || '').toString().trim();
    if (looksLikeSummaryLabel(expenseLabel) || looksLikeSummaryLabel(incomeLabel)) {
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

// ---- extracted accounts.html lines 1694-1706 ----
// ---- Bike-split notes (setExpenseBikeSplits -> column B(2); setIncomeBikeSplits
// -> column G(7)) -- <monthName>_notes sidecar, same [row, col, note] shape
// used everywhere else. ----
async function setBikeSplitsNoteFromJson(monthName, year, row, colIdx1, splits) {
  const clean = (splits || [])
    .map(s => ({ bike: (s.bike || '').toString().trim(), amount: (s.amount !== '' && s.amount !== null && s.amount !== undefined && !isNaN(Number(s.amount))) ? Number(s.amount) : '' }))
    .filter(s => s.bike && s.amount !== '');
  const notesSheet = monthName + '_notes';
  const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta(notesSheet, year);
  const filtered = (noteRows || []).filter(n => !(n[0] === row && n[1] === colIdx1));
  if (clean.length) filtered.push([row, colIdx1, JSON.stringify(clean)]);
  await writeSheetJson(notesSheet, filtered, modifiedTime, year);
}

// ---- extracted accounts.html lines 1707-1714 ----
function resolveIncomeBikeSplitsB(rawSplits, amount) {
  const clean = (Array.isArray(rawSplits) ? rawSplits : [])
    .map(s => ({ bike: (s.bike || '').toString().trim(), amount: (s.amount !== '' && !isNaN(Number(s.amount))) ? Number(s.amount) : '' }))
    .filter(s => s.bike && s.amount !== '');
  if (clean.length) return clean;
  const amt = (amount === '' || amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) === 0) ? '' : Number(amount);
  return amt === '' ? [] : [{ bike: 'extras', amount: amt }];
}

// ---- extracted accounts.html lines 1715-1723 ----
function expenseBikeSplitsUnchangedB(oldSplits, newSplits) {
  function normalize(list) {
    return (list || []).map(s => (s.bike || '').toString().trim().toLowerCase() + '|' + Number(s.amount)).sort();
  }
  const a = normalize(oldSplits), b = normalize(newSplits);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

// ---- extracted accounts.html lines 1724-1729 ----
// Mirrors Code.gs's extractBikeNameFromRentalIncomeText -- detects an
// auto-generated "<bike> rent N days"/"<bike> extend N days" income line.
function extractBikeNameFromRentalIncomeTextB(text) {
  const m = /^(.*?)\s+(rent|extend)\b/i.exec((text || '').toString());
  return m ? m[1].trim() : '';
}

// ---- extracted accounts.html lines 1731-1745 ----
// ---- Personal/Wages running-total (formula-string chain-of-refs -- see
// the big comment above readSummaryItem for why this specific total is
// kept genuinely live while the sheet's other summary totals are not).
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

// ---- extracted accounts.html lines 1746-1771 ----
async function updateExpenseTypeTotalRefFromJson(monthName, year, type, refRow, add) {
  const def = EXPENSE_TYPE_TOTAL_LABELS_B[type];
  if (!def) return; // business/transfer/transferComplete -- not totalled this way
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  const row = locateExpenseTypeTotalRowFromJson(rows, type);
  if (row === null) throw new Error('Could not find the "' + def.label + '" row in column B of "' + monthName + '" -- the ' + type + ' total was NOT updated.');
  const actualLabel = (rows[row - 1][1] || '').toString().trim().toLowerCase();
  if (actualLabel !== def.label) throw new Error('Safety check failed: ' + monthName + '!B' + row + ' does not say "' + def.label + '" (found "' + (rows[row - 1][1] || '') + '" instead) -- the ' + type + ' total was NOT updated. The row may have moved again.');
  const ref = 'C' + refRow;
  const cellVal = rows[row - 1][2];
  let terms;
  if (typeof cellVal === 'string' && cellVal.charAt(0) === '=') {
    terms = cellVal.slice(1).split('+').map(t => t.trim()).filter(Boolean);
  } else {
    const num = Number(cellVal);
    terms = (cellVal !== '' && cellVal !== null && cellVal !== undefined && !isNaN(num) && num !== 0) ? [String(num)] : [];
  }
  if (add) { if (terms.indexOf(ref) === -1) terms.push(ref); }
  else { terms = terms.filter(t => t !== ref); }
  const newRows = rows.map(r => r.slice());
  const newRow = newRows[row - 1].slice();
  while (newRow.length < 3) newRow.push('');
  newRow[2] = terms.length ? ('=' + terms.join('+')) : '';
  newRows[row - 1] = newRow;
  await writeSheetJson(monthName, newRows, modifiedTime, year);
}

// ---- extracted accounts.html lines 1773-1804 ----
// ---- Expense-type persistence (design decision -- NOT explicitly approved
// by Anton, flagged for his review). Code.gs stores an expense's type
// (business/personal/wages/transfer/transferComplete) as a CELL BACKGROUND
// COLOR on column B of the monthly sheet -- something with no equivalent in
// the JSON export (Anton's own scoping call: "just plain colors is fine,
// just the data"). Every expense read back from getAccountsDataFromJson
// used to hardcode type:'business' as a result, which meant: (1) an edit
// could only ADD a row to the personal/wages running total, never remove
// one, and (2) bulkSetExpenseType (the "Complete Transfers" / "Transfer
// Completed" buttons) couldn't be ported at all, since it fundamentally
// depends on reading back each row's CURRENT type.
//
// This closes that gap with a new notes-sidecar marker on column E(5) of
// the row -- the one column getAccountsDataFromJson's own read loop never
// touches at all (A-D/1-4 are the expense date/label/amount/payment
// fields, F-J/6-10 are the income fields; column E/5 is the untouched gap
// between them), so this new marker can't collide with any real cell value
// OR with the existing bike-splits notes (column B(2)/G(7)). 'business'
// (the default/no-fill case in Code.gs) stores NO note at all, same sparse
// convention as bike-splits, so every pre-existing un-migrated row still
// reads back correctly as 'business' automatically. This is a genuinely
// new mechanism, not a mechanical translation -- Anton should confirm it's
// an acceptable stand-in for real cell colors when he's back.
const EXPENSE_TYPE_NOTE_COL_B = 5;
function normalizeExpenseTypeKeyB(raw) {
  const s = (raw || '').toString().trim();
  if (!s) return 'business';
  const lower = s.toLowerCase();
  const keys = Object.keys(EXPENSE_TYPE_COLORS);
  for (const k of keys) { if (k.toLowerCase() === lower) return k; }
  return 'business';
}

// ---- extracted accounts.html lines 1805-1812 ----
async function setExpenseTypeNoteFromJson(monthName, year, row, typeKeyRaw) {
  const typeKey = normalizeExpenseTypeKeyB(typeKeyRaw);
  const notesSheet = monthName + '_notes';
  const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta(notesSheet, year);
  const filtered = (noteRows || []).filter(n => !(n[0] === row && n[1] === EXPENSE_TYPE_NOTE_COL_B));
  if (typeKey !== 'business') filtered.push([row, EXPENSE_TYPE_NOTE_COL_B, typeKey]);
  await writeSheetJson(notesSheet, filtered, modifiedTime, year);
}

// ---- extracted accounts.html lines 1814-1880 ----
// PERF (15/08/2026): combines any number of edits to the SAME
// <monthName>_notes sidecar file into ONE read + N in-memory edits + ONE
// write, instead of each edit type (shiftNotesForInsertedRowFromJson /
// setBikeSplitsNoteFromJson / setExpenseTypeNoteFromJson above) doing its
// own independent read-modify-write against the same file back-to-back.
// addExpenseRowFromJson/addIncomeRowFromJson used to do up to 3 of these
// in a row (6 HTTP calls) for what is, in the end, one small JSON file --
// this cuts that to 2 calls (1 read + 1 write) total.
//
// Safe because every edit here touches either a disjoint (row, col) key
// or, for the shift, a disjoint SLICE of rows (everything >= a given row
// number) -- applying them in-memory in the same order the separate calls
// used to run in (shift first, since a freshly-inserted row's own new
// notes must NOT themselves get caught by that shift) produces an
// identical final result to running them as separate round trips. As a
// side effect this also makes the combined edit atomic (all land or none
// do) instead of independently fallible -- strictly safer than the old
// partial-success possibility, not a behavior change worth worrying about.
//
// opts (all optional):
//   shiftInsertedRow: { insertedRowNum } -- ports shiftNotesForInsertedRowFromJson.
//     Applied FIRST, before any of this call's own new notes are written.
//   bikeSplits: { row, colIdx1, splits } -- ports setBikeSplitsNoteFromJson.
//   typeNote: { row, typeKeyRaw } -- ports setExpenseTypeNoteFromJson.
//
// Returns { oldNoteRows } -- the notes as they stood immediately after any
// insert-shift but BEFORE this call's own bikeSplits/typeNote edits. NOT
// intended as a substitute for a caller's own dedicated "read the OLD
// state before I overwrite it" fetch (see editExpenseRowFromJson/
// editIncomeRowFromJson, which read old notes state separately, on
// purpose) -- if this combined write itself fails, the caller only gets
// the fallback empty array below, which would silently discard a
// successfully-read old state. That tradeoff is fine for callers (like
// addExpense/addIncome) that don't need the pre-edit state for anything,
// but would NOT be fine for edit's old-vs-new comparisons, which is why
// those keep their own separate, unmerged read.
async function applyMonthNotesEditsFromJson(monthName, year, opts) {
  const notesSheet = monthName + '_notes';
  const { rows: noteRows, modifiedTime } = await fetchSheetWithMeta(notesSheet, year);
  let working = noteRows || [];

  if (opts && opts.shiftInsertedRow) {
    const insertedRowNum = opts.shiftInsertedRow.insertedRowNum;
    working = working.map(n => (n[0] >= insertedRowNum) ? [n[0] + 1, n[1], n[2]] : n);
  }

  const oldNoteRows = working;

  if (opts && opts.bikeSplits) {
    const { row, colIdx1, splits } = opts.bikeSplits;
    const clean = (splits || [])
      .map(s => ({ bike: (s.bike || '').toString().trim(), amount: (s.amount !== '' && s.amount !== null && s.amount !== undefined && !isNaN(Number(s.amount))) ? Number(s.amount) : '' }))
      .filter(s => s.bike && s.amount !== '');
    working = working.filter(n => !(n[0] === row && n[1] === colIdx1));
    if (clean.length) working = working.concat([[row, colIdx1, JSON.stringify(clean)]]);
  }

  if (opts && opts.typeNote) {
    const { row, typeKeyRaw } = opts.typeNote;
    const typeKey = normalizeExpenseTypeKeyB(typeKeyRaw);
    working = working.filter(n => !(n[0] === row && n[1] === EXPENSE_TYPE_NOTE_COL_B));
    if (typeKey !== 'business') working = working.concat([[row, EXPENSE_TYPE_NOTE_COL_B, typeKey]]);
  }

  // IDEMPOTENCY (16/08/2026) -- see findExistingAddTxnRowFromJson's comment
  // just below for the full "why". Records the client-generated id for a
  // just-created add, in the same [row, col, note] shape as everything
  // else here, under a col number (900/901) reserved for this and nothing
  // else so it can never collide with a real bike-splits/type-note entry.
  if (opts && opts.txnMarker) {
    const { row, col, value } = opts.txnMarker;
    working = working.filter(n => !(n[0] === row && n[1] === col));
    if (value) working = working.concat([[row, col, value]]);
  }

  await writeSheetJson(notesSheet, working, modifiedTime, year);
  return { oldNoteRows };
}

// ---- Idempotency guard for add operations (16/08/2026) ----
// A client "Failed to fetch" only means the BROWSER lost the connection --
// it does NOT mean the server never got the request, or didn't finish it.
// Anton hit this live: wifi dropped mid-save, the client showed "Failed to
// add", but the row had actually already been written to Drive; when he
// hit Retry after wifi came back, that retry was a brand-new HTTP request
// with no memory of the first one, so it happily wrote a genuine second
// "twse" row.
//
// Fix: accounts.html now generates ONE random id per logical add (see
// `_clientTxnId` in accounts.html) when the user first submits, and keeps
// reusing that SAME id on every retry of that same attempt (it's kept on
// the retained payload object, which survives both in-memory retries and a
// full page reload via the failed-saves localStorage cache). The server
// records that id against the row it creates (see applyMonthNotesEditsFromJson's
// txnMarker opt above) as part of the SAME notes-sidecar write the add
// already does for bike-splits/type notes -- no extra round trip on the
// success path. Before creating a NEW row, it checks whether that id has
// already been recorded; if so, this is a replay of an add that already
// landed, so it skips writing a second row and just reports the original
// one as a success (responsePayload.duplicate === true, purely
// informational -- the client treats it exactly like any other success).
//
// Deliberately scoped to ADD only: an edit retried twice just reapplies the
// same field values to the same known row, which is already harmless
// (naturally idempotent) without any of this. A delete-of-an-already-
// -deleted row is a separate, much lower-frequency risk (accounts.html's
// optInFlight guard already prevents the same click from firing it twice)
// not addressed here.
//
// clientTxnId is optional/backward-compatible: if it's missing (an older
// cached client, or some future caller that doesn't send one), this is a
// pure no-op and behavior is exactly what it was before this change.
const ADD_TXN_ID_NOTE_COL_EXPENSE = 900;
const ADD_TXN_ID_NOTE_COL_INCOME = 901;
async function findExistingAddTxnRowFromJson(monthName, year, col, clientTxnId) {
  if (!clientTxnId) return null;
  const notesSheet = monthName + '_notes';
  let noteRows;
  try {
    ({ rows: noteRows } = await fetchSheetWithMeta(notesSheet, year));
  } catch (e) {
    return null; // notes sidecar unreadable -- fail open, same as every other best-effort notes read in this file
  }
  const hit = (noteRows || []).find(n => n[1] === col && n[2] === clientTxnId);
  return hit ? hit[0] : null;
}

// ---- extracted accounts.html lines 1882-1887 ----
function accountsMonthNameFor(monthIndexRaw) {
  const monthIndex = Math.max(0, Math.min(11, Math.round(Number(monthIndexRaw))));
  const monthName = ACCOUNTS_MONTH_FILES[monthIndex];
  if (!monthName) throw new Error('No sheet found matching "' + (MONTH_NAMES[monthIndex] || monthIndex) + '".');
  return monthName;
}

// ---- extracted accounts.html lines 1889-1943 ----
// ==== Monthly "Bank" balance / cash / deposit-log recompute cascade ====
// FIX (14/08/2026): confirmed live by Anton -- adding a "Bank"-paid expense
// (or any expense/income) left the Expenses/Income/Profit/Cash & Deposits
// summary strip completely frozen. Root cause matches the already-fixed
// "bikes" sheet cascade bug exactly: every write function above updates a
// formula's SOURCE cell (a single expense/income row) but nothing ever
// recomputes the formula's TARGET cells, so the summary strip just shows
// whatever was true at the last JSON export forever.
//
// These formulas were pulled directly from the real workbook (August tab,
// data_only=False) as ground truth, not guessed:
//   I<TER-1> = sum(I2:I<TER-2>)                 "income for month"
//   C<TER>   = sum(C2:C<TER-1>)                 "total expenses"
//   I<TER>   = I<TER-1>                         "income less investment"
//   K<TER>   = I<TER-1> - C<TER>                "net profit"
//   C<TER+1> = C<TER> - C<personal> - C<wages>  "bussiness expenses"
//   I<TER+1> = C<TER+1> / I<TER-1>               "% bussiness exp vs income"
//   K<TER+1> = I<TER> - C<TER+1>                 "actual profit"
//   I<TER+2> = (C<TER> - C<wages>) / I<TER-1>    "% total exp vs income"
//   P15/S15/W15 = sum(<col>2:<col>14)            deposit-log column totals
//   S16 = M11 + S15, W16 = M12 + W15             deposit-log "total wise/revolut"
//   M5 "deposits all"       = P15 + S15 + W15
//   M3 "cash"                = cash!G374 (this file's own recomputed total)
//   M6 "bank"                = (K<TER> + M2) - (M3 - M4) + P15 - M11 - M12
//   M7 "bank less deposit"   = M6 - P15
//   M9 "total (cash+bank+wise)" = M3 + M6 + M11 + M12
// "personal expenses total"/"wages and bike purchase" (C<personal>/C<wages>)
// and M11/M12 (wise/revolut running totals) are DELIBERATELY read-only here
// -- those are already kept genuinely live by updateExpenseTypeTotalRefFromJson
// and processDepositForPaymentFromJson respectively (see the big comment
// above readSummaryItem). M2/M4/M10 (prior-month snapshots, "bike bank")
// are plain literals, not formulas -- correctly static intra-month, only
// touched at month rollover (a separate, not-yet-scoped task).
//
// Best-effort by design, same convention as every other cascade in this
// file: called LAST from every add/edit/delete expense/income function,
// after every other write (cash sheet, deposit totals, bike splits) has
// already landed, so it always reads the freshest values. A failure here
// is caught by the caller and surfaced as a warning -- it never blocks the
// base transaction write that triggered it.
const ACCOUNTS_CASCADE_EXTRA_ITEMS_B = {
  depositsAll:   { row: 5,  labelCol: 12, valueCol: 13, expectedLabel: 'deposits all' },
  bankLessDep:   { row: 7,  labelCol: 12, valueCol: 13, expectedLabel: 'bank less deposit' },
  cashPrevious:  { row: 4,  labelCol: 12, valueCol: 13, expectedLabel: 'cash previous' },
  bankPrevious:  { row: 2,  labelCol: 12, valueCol: 13, expectedLabel: 'bank previous less deposit + wise + rev' }
};
const DEPOSIT_LOG_TOTAL_ITEMS_B = [
  { key: 'scan',    dataCol: 16, row: 15, labelCol: 15, valueCol: 16, expectedLabel: 'total' },    // O/P
  { key: 'wise',    dataCol: 19, row: 15, labelCol: 18, valueCol: 19, expectedLabel: 'total' },    // R/S
  { key: 'revolut', dataCol: 23, row: 15, labelCol: 22, valueCol: 23, expectedLabel: 'total' }     // V/W
];
const DEPOSIT_LOG_SUBTOTAL_ITEMS_B = [
  { key: 'wise',    row: 16, labelCol: 18, valueCol: 19, expectedLabel: 'total wise' },    // R16/S16
  { key: 'revolut', row: 16, labelCol: 22, valueCol: 23, expectedLabel: 'total revolut' }  // V16/W16
];

// ---- extracted accounts.html lines 1944-1966 ----
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

// ---- extracted accounts.html lines 1967-2014 ----
// ---- Recomputes cash sheet's income/expenses/total-cash cells
// (C370/G372/G374 in the real workbook -- self-heals off the "income"
// label since this is a single, non-monthly, ever-growing ledger). Returns
// the newly-computed "total cash" figure so the monthly cascade below can
// use it for M3 without a second fetch.
//
// PERF (15/08/2026): optionally accepts `knownCash` -- {rows, modifiedTime}
// already known to be the CURRENT state of "cash", e.g. because the
// caller's own appendCash*/update/deleteCashRowFromJson call just wrote it
// moments ago in this same request, with nothing else touching "cash" in
// between. When passed, this skips the read entirely instead of doing a
// second independent read+write against a file that was, until this
// point, ALWAYS re-read from scratch right after something else had just
// written it -- one of the two full extra "cash" round trips behind the
// "add expense" slowness Anton flagged (append + recompute each doing
// their own read+write back-to-back). Omit (or pass null/undefined) to
// always read fresh, exactly the old behavior -- fully backward
// compatible. If the caller doesn't know cash was touched (or the write
// that would have told it failed), it naturally omits this and a normal
// fresh read happens, same as before this change existed. ----
async function recomputeCashSheetTotalsB(knownCash) {
  const { rows, modifiedTime } = (knownCash && knownCash.rows) ? knownCash : await fetchSheetWithMeta('cash');
  if (!rows || !rows.length) throw new Error('no tab named "cash" was found -- cash totals were NOT recomputed.');
  const norm = s => (s || '').toString().trim().toLowerCase();
  // Starts at row 2 (idx 1) deliberately -- row 1 is the header row, and
  // this sheet's own column B header text is ALSO literally "income" (see
  // "B1: 'income'" in the real workbook), which would otherwise match
  // first and be mistaken for the totals-row label further down.
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

// ---- extracted accounts.html lines 2015-2102 ----
// ---- Recomputes every derived cell on a monthly sheet's Expenses/Income/
// Profit/Cash & Deposits summary block, plus the deposit-log column
// totals at the top of the same sheet. See the big comment above this
// block for the exact formulas and which cells are deliberately excluded.
//
// PERF (15/08/2026): optional trailing `knownCash` is passed straight
// through to recomputeCashSheetTotalsB -- see that function's comment. ----
async function recomputeMonthlySummaryCascadeB(monthName, year, knownCash) {
  const cashTotal = await recomputeCashSheetTotalsB(knownCash);
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  if (!rows || !rows.length) throw new Error('No sheet found for "' + monthName + '" -- summary totals were NOT recomputed.');
  const newRows = rows.map(r => r.slice());

  const terRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.expense[0]);       // "total expenses"
  const berRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.expense[1]);       // "bussiness expenses"
  const incRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[0]);        // "income for month"
  const iliRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[1]);        // "income less investment"
  const pctBerRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[2]);     // "% bussiness exp vs income"
  const pctTotRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.income[3]);     // "% total exp vs income"
  const netProfitRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.profit[0]);  // "net profit"
  const actProfitRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.profit[1]);  // "actual profit"
  const cashRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[0]);      // "cash"
  const bankRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[1]);      // "bank"
  const wiseRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[2]);      // "wise(less deposit)"
  const revolutRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[3]);   // "revolut(less deposit)"
  const totalRow = findSummaryRow(newRows, ACCOUNTS_SUMMARY_ITEMS.deposit[4]);     // "total (cash+bank+wise)"
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

  // -- Deposit-log column totals (top of sheet) --
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

  // -- Expenses / Income / Profit block --
  const incomeTotal = sumColumnRangeB(newRows, 9, 2, incRow - 1);
  writeCellB(newRows, incRow, 9, incomeTotal);
  const expenseTotal = sumColumnRangeB(newRows, 3, 2, terRow - 1);
  writeCellB(newRows, terRow, 3, expenseTotal);
  writeCellB(newRows, iliRow, 9, incomeTotal); // "income less investment" = income for month
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

  // -- Cash & Deposits block --
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

// ---- extracted accounts.html lines 2104-2197 ----
// ---- action:'addExpense' port. ----
async function addExpenseRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();

  // IDEMPOTENCY (16/08/2026) -- see findExistingAddTxnRowFromJson's comment
  // for the full "why". If this exact add already landed under this id
  // (a retry of a save the client thought failed but Drive actually got),
  // don't write a second row -- just report the original one as done.
  if (data.clientTxnId) {
    const existingRow = await findExistingAddTxnRowFromJson(monthName, year, ADD_TXN_ID_NOTE_COL_EXPENSE, data.clientTxnId);
    if (existingRow) {
      logStep('addExpenseRowFromJson TOTAL (idempotent replay, no write)', actionStart);
      return { success: true, row: existingRow, shifted: false, duplicate: true };
    }
  }

  const t0 = nowMs();
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  logStep('addExpense: read month sheet', t0);
  const free = findAccountsFreeRowIdxJson(rows, 'expense');
  const newRows = free.rows;
  const row = free.rowNum;
  const rowIdx = row - 1;
  while (newRows.length <= rowIdx) newRows.push([]);
  const r = (newRows[rowIdx] || []).slice();
  while (r.length < 4) r.push('');
  r[0] = data.date ? isoDateInputToSheetValue(data.date) : '';
  r[1] = data.expense || '';
  const amountVal = (data.amount === '' || data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) ? '' : Number(data.amount);
  r[2] = amountVal;
  r[3] = data.payment || '';
  newRows[rowIdx] = r;
  const t1 = nowMs();
  await writeSheetJson(monthName, newRows, modifiedTime, year);
  logStep('addExpense: write row', t1);

  const warnings = [];
  const expenseBikeSplits = Array.isArray(data.expenseBikeSplits) ? data.expenseBikeSplits : [];
  const paymentLower = (data.payment || '').toString().trim().toLowerCase();
  const expenseTypeKey = normalizeExpenseTypeKeyB(data.expenseType);

  // PERF (16/08/2026): the four lanes below each touch a DIFFERENT Drive
  // file (notes sidecar / cash / bikes / month sheet-again for deposit and
  // expense-type totals) and none of them read anything one of the others
  // writes -- see PROGRESS.md's entry on this pass for the full dependency
  // analysis. They used to run one at a time (up to ~9 sequential round
  // trips); now they run together via Promise.all. The row write above
  // deliberately stays solitary and un-parallelized: if it fails, none of
  // these best-effort side effects should fire for a row that was never
  // actually saved. Each lane keeps its own try/catch exactly as before
  // (same warning messages, same best-effort semantics), so this
  // Promise.all itself can never reject -- only the awaits inside each
  // lane can throw, and each one catches its own.
  let knownCash = null;
  const notesLane = (async () => {
    const t = nowMs();
    // PERF (15/08/2026): the insert-shift, bike-splits note, and
    // expense-type note used to each be their own independent
    // read-modify-write against the SAME <monthName>_notes file. See
    // applyMonthNotesEditsFromJson's own comment for why combining them
    // into one read+write is safe. Failure is only surfaced as a warning
    // when a shift was involved (free.inserted) -- matching the old
    // shift-specific warning; without an insert, failure stays
    // silent/best-effort, matching the old bike-splits/type-note behavior.
    try {
      await applyMonthNotesEditsFromJson(monthName, year, {
        shiftInsertedRow: free.inserted ? { insertedRowNum: row } : null,
        bikeSplits: { row, colIdx1: 2, splits: expenseBikeSplits },
        typeNote: { row, typeKeyRaw: data.expenseType },
        txnMarker: data.clientTxnId ? { row, col: ADD_TXN_ID_NOTE_COL_EXPENSE, value: data.clientTxnId } : null
      });
    } catch (e) {
      if (free.inserted) warnings.push('Notes sidecar: ' + e.message);
    }
    logStep('addExpense: notes lane', t);
  })();

  const cashLane = (async () => {
    const t = nowMs();
    try {
      if (paymentLower === 'cash') knownCash = await appendCashExpenseRowFromJson(data.expense || '', data.amount);
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }
    logStep('addExpense: cash lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    const bikeWarnings = [];
    for (const s of expenseBikeSplits) {
      const bike = (s && s.bike || '').toString().trim();
      const amt = Number(s && s.amount);
      if (!bike || s.amount === '' || isNaN(amt)) continue;
      try { await addRentalAmountToBikesSheetFromJson(bike, amt, monthName, 51); }
      catch (bikeErr) { bikeWarnings.push(bikeErr.message); }
    }
    if (bikeWarnings.length) warnings.push('Bikes sheet (expense): ' + bikeWarnings.join(' '));
    logStep('addExpense: bikes lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    // Both of these hit `monthName` again (deposit total / expense-type
    // total ref) -- kept sequential relative to EACH OTHER since they're
    // the same file, but the pair as a whole is its own independent lane.
    try {
      if (paymentLower === 'wise' || paymentLower === 'revolut') {
        const expenseAmountNum = Number(data.amount);
        if (!isNaN(expenseAmountNum) && expenseAmountNum !== 0) {
          await processDepositForPaymentFromJson(paymentLower, -expenseAmountNum, monthName, year);
        }
      }
    } catch (depositErr) { warnings.push('Deposit total: ' + depositErr.message); }

    try {
      if (expenseTypeKey === 'personal' || expenseTypeKey === 'wages') {
        await updateExpenseTypeTotalRefFromJson(monthName, year, expenseTypeKey, row, true);
      }
    } catch (typeErr) { warnings.push('Expense type total: ' + typeErr.message); }
    logStep('addExpense: month-sheet-again lane (deposit+type total)', t);
  })();

  const t2 = nowMs();
  await Promise.all([notesLane, cashLane, bikesLane, monthAgainLane]);
  logStep('addExpense: parallel lanes (notes+cash+bikes+monthAgain) TOTAL', t2);

  // PERF (16/08/2026): the summary cascade and the transaction log write
  // are independent of each other too (the log doesn't read anything the
  // cascade computes) -- run them together instead of back-to-back.
  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('addExpense: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'addExpenseRowFromJson', reversible: true,
      summary: 'Expense ' + fmtMoneyB(amountVal) + ' — ' + (data.expense || '(no description)') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [1, 2, 3, 4], before: ['', '', '', ''], after: [r[0], r[1], r[2], r[3]] }]
    });
    logStep('addExpense: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('addExpense: parallel lanes (cascade+log) TOTAL', t3);

  logStep('addExpenseRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true, row, shifted: free.inserted };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2199-2278 ----
// ---- action:'addIncome' port. ----
async function addIncomeRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();

  // IDEMPOTENCY (16/08/2026) -- see findExistingAddTxnRowFromJson's comment
  // (above applyMonthNotesEditsFromJson) for the full "why". This is the
  // exact scenario Anton hit live with the "twse" income row.
  if (data.clientTxnId) {
    const existingRow = await findExistingAddTxnRowFromJson(monthName, year, ADD_TXN_ID_NOTE_COL_INCOME, data.clientTxnId);
    if (existingRow) {
      logStep('addIncomeRowFromJson TOTAL (idempotent replay, no write)', actionStart);
      return { success: true, row: existingRow, shifted: false, duplicate: true };
    }
  }

  const t0 = nowMs();
  const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
  logStep('addIncome: read month sheet', t0);
  const free = findAccountsFreeRowIdxJson(rows, 'income');
  const newRows = free.rows;
  const row = free.rowNum;
  const rowIdx = row - 1;
  while (newRows.length <= rowIdx) newRows.push([]);
  const r = (newRows[rowIdx] || []).slice();
  while (r.length < 10) r.push('');
  r[5] = data.date ? isoDateInputToSheetValue(data.date) : '';
  r[6] = data.income || '';
  r[7] = data.name || '';
  const amountVal = (data.amount === '' || data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) ? '' : Number(data.amount);
  r[8] = amountVal;
  r[9] = data.paidBy || '';
  newRows[rowIdx] = r;
  const t1 = nowMs();
  await writeSheetJson(monthName, newRows, modifiedTime, year);
  logStep('addIncome: write row', t1);

  const warnings = [];
  const incomeBikeSplits = resolveIncomeBikeSplitsB(data.incomeBikeSplits, data.amount);
  const paidByLower = (data.paidBy || '').toString().trim().toLowerCase();

  // PERF (16/08/2026): see the matching comment in addExpenseRowFromJson --
  // same 4-independent-lane restructure (notes sidecar / cash / bikes /
  // month sheet-again for deposit total + deposit spend), run together via
  // Promise.all instead of one at a time. The row write above stays
  // solitary, unchanged.
  let knownCash = null;
  const notesLane = (async () => {
    const t = nowMs();
    // PERF (15/08/2026): see applyMonthNotesEditsFromJson's comment /
    // the matching change in addExpenseRowFromJson -- same insert-shift +
    // bike-splits-note merge. No type-note concept on the income side.
    try {
      await applyMonthNotesEditsFromJson(monthName, year, {
        shiftInsertedRow: free.inserted ? { insertedRowNum: row } : null,
        bikeSplits: { row, colIdx1: 7, splits: incomeBikeSplits },
        txnMarker: data.clientTxnId ? { row, col: ADD_TXN_ID_NOTE_COL_INCOME, value: data.clientTxnId } : null
      });
    } catch (e) {
      if (free.inserted) warnings.push('Notes sidecar: ' + e.message);
    }
    logStep('addIncome: notes lane', t);
  })();

  const cashLane = (async () => {
    const t = nowMs();
    try {
      if (paidByLower === 'cash') knownCash = await appendCashSheetRowFromJson((data.income || '').toString().trim(), data.amount);
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }
    logStep('addIncome: cash lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    const bikeWarnings = [];
    for (const s of incomeBikeSplits) {
      try { await addRentalAmountToBikesSheetFromJson(s.bike, s.amount, monthName, 1); }
      catch (bikeErr) { bikeWarnings.push(bikeErr.message); }
    }
    if (bikeWarnings.length) warnings.push('Bikes sheet (income): ' + bikeWarnings.join(' '));
    logStep('addIncome: bikes lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    // Both of these can touch `monthName` again (deposit total / deposit
    // log consumption) -- kept sequential relative to EACH OTHER (same
    // file, same order as before), but the pair as a whole is its own
    // independent lane.
    try {
      if (paidByLower === 'wise' || paidByLower === 'revolut') {
        await processDepositForPaymentFromJson(paidByLower, data.amount, monthName, year);
      }
    } catch (depositErr) { warnings.push('Deposit total: ' + depositErr.message); }

    try {
      if (data.paidFromDeposit) {
        const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === data.depositCategory);
        if (!cat) throw new Error('Unrecognized deposit category "' + data.depositCategory + '".');
        await consumeDepositFromJson(cat, Number(data.depositRow), Number(data.amount), monthName, year);
      }
    } catch (depErr) { warnings.push('Deposit spend: ' + depErr.message); }
    logStep('addIncome: month-sheet-again lane (deposit total+spend)', t);
  })();

  const t2 = nowMs();
  await Promise.all([notesLane, cashLane, bikesLane, monthAgainLane]);
  logStep('addIncome: parallel lanes (notes+cash+bikes+monthAgain) TOTAL', t2);

  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('addIncome: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'addIncomeRowFromJson', reversible: true,
      summary: 'Income ' + fmtMoneyB(amountVal) + ' — ' + (data.income || '(no description)') + (data.name ? (' from ' + data.name) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [r[5], r[6], r[7], r[8], r[9]] }]
    });
    logStep('addIncome: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('addIncome: parallel lanes (cascade+log) TOTAL', t3);

  logStep('addIncomeRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true, row, shifted: free.inserted };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2280-2434 ----
// ---- action:'editExpense' port. Cash-row reconciliation with a
// disambiguation round-trip (see resolveCashRowFromJson) -- nothing is
// written at all if the old cash row can't be uniquely resolved and the
// client hasn't yet resubmitted with cashRowChoice. ----
async function editExpenseRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();
  const row = Math.round(Number(data.row));
  if (!row || row < 2) throw new Error('Invalid row.');
  const notesSheet = monthName + '_notes';

  // PERF (16/08/2026): the month-sheet read (for `existing`) and the notes
  // sidecar read (for `oldNoteRows`) are two different files and neither
  // depends on the other's result -- read them together instead of one
  // after the other.
  const t0 = nowMs();
  const [{ rows, modifiedTime }, oldNoteRowsResult] = await Promise.all([
    fetchSheetWithMeta(monthName, year),
    fetchSheetWithMeta(notesSheet, year).then(res => ({ ok: true, rows: res.rows })).catch(() => ({ ok: false, rows: [] }))
  ]);
  logStep('editExpense: read month sheet + notes sidecar', t0);
  const existing = rows[row - 1];
  if (!existing) throw new Error('Could not find row ' + row + ' on "' + monthName + '" -- it may have moved. Please reload and try again.');

  const oldExpense = (existing[1] || '').toString().trim();
  const oldAmountRaw = existing[2];
  const oldAmount = (oldAmountRaw === '' || oldAmountRaw === null || oldAmountRaw === undefined || isNaN(Number(oldAmountRaw))) ? '' : Number(oldAmountRaw);
  const oldPaymentLower = (existing[3] || '').toString().trim().toLowerCase();
  // 13/08/2026: old type is now read back from the column-A(1) notes-sidecar
  // marker (see normalizeExpenseTypeKeyB/setExpenseTypeNoteFromJson above)
  // instead of being hardcoded to 'business' -- this closes the previous
  // KNOWN GAP where an edit could only ADD a row to the personal/wages
  // running total, never remove one.
  const oldNoteRows = oldNoteRowsResult.rows;
  const oldTypeNoteEntry = (oldNoteRows || []).find(n => n[0] === row && n[1] === EXPENSE_TYPE_NOTE_COL_B);
  const oldTypeKey = normalizeExpenseTypeKeyB(oldTypeNoteEntry ? oldTypeNoteEntry[2] : '');
  const oldNoteEntry = (oldNoteRows || []).find(n => n[0] === row && n[1] === 2);
  const oldBikeSplits = parseExpenseBikeSplitsNote(oldNoteEntry ? oldNoteEntry[2] : '', oldAmount);

  const newAmount = (data.amount === '' || data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) ? '' : Number(data.amount);
  const newPaymentLower = (data.payment || '').toString().trim().toLowerCase();
  const newExpenseText = (data.expense || '').toString().trim();
  const newBikeSplits = Array.isArray(data.expenseBikeSplits) ? data.expenseBikeSplits : [];
  const newTypeKey = normalizeExpenseTypeKeyB(data.expenseType);

  const wasCash = oldPaymentLower === 'cash';
  const isCash = newPaymentLower === 'cash';

  let resolvedOldCashRow = null;
  if (wasCash) {
    const resolution = await resolveCashRowFromJson('expense', data.cashRowChoice, oldExpense, oldAmount);
    if (resolution.needsDisambiguation) {
      return { success: false, needsDisambiguation: true, candidates: resolution.candidates };
    }
    resolvedOldCashRow = resolution.row;
  }

  const newRows = rows.map(r => r.slice());
  const r = newRows[row - 1].slice();
  while (r.length < 4) r.push('');
  r[0] = data.date ? isoDateInputToSheetValue(data.date) : '';
  r[1] = newExpenseText;
  r[2] = newAmount;
  r[3] = data.payment || '';
  newRows[row - 1] = r;
  const t1 = nowMs();
  await writeSheetJson(monthName, newRows, modifiedTime, year);
  logStep('editExpense: write row', t1);

  const warnings = [];

  // PERF (16/08/2026): same 4-independent-lane restructure as
  // addExpenseRowFromJson (notes sidecar / bikes / cash / month
  // sheet-again for type-total + deposit totals), run together via
  // Promise.all. The row write above stays solitary, unchanged.
  let knownCash = null;
  const notesLane = (async () => {
    const t = nowMs();
    // PERF (15/08/2026): merges these two independent read-modify-writes
    // against the same <monthName>_notes file into one -- see
    // applyMonthNotesEditsFromJson's comment. Deliberately does NOT fold
    // in this function's OWN earlier "read old notes state" fetch above
    // (oldNoteRows) -- that read feeds oldTypeKey/oldBikeSplits, which
    // downstream financial logic (personal/wages total, bike-sheet
    // reversal) depends on being correct even if THIS write fails; keeping
    // it a separate, always-independently-successful read preserves that
    // guarantee exactly as before.
    try {
      await applyMonthNotesEditsFromJson(monthName, year, {
        bikeSplits: { row, colIdx1: 2, splits: newBikeSplits },
        typeNote: { row, typeKeyRaw: data.expenseType }
      });
    } catch (e) { /* best-effort */ }
    logStep('editExpense: notes lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    if (!expenseBikeSplitsUnchangedB(oldBikeSplits, newBikeSplits)) {
      const removeWarnings = [];
      for (const s of oldBikeSplits) {
        try { await addRentalAmountToBikesSheetFromJson(s.bike, -s.amount, monthName, 51); }
        catch (e) { removeWarnings.push(e.message); }
      }
      if (removeWarnings.length) warnings.push('Bikes sheet (removing old expense): ' + removeWarnings.join(' '));
      const addWarnings = [];
      for (const s of newBikeSplits) {
        const bike = (s && s.bike || '').toString().trim();
        const amt = Number(s && s.amount);
        if (!bike || s.amount === '' || isNaN(amt)) continue;
        try { await addRentalAmountToBikesSheetFromJson(bike, amt, monthName, 51); }
        catch (e) { addWarnings.push(e.message); }
      }
      if (addWarnings.length) warnings.push('Bikes sheet (adding new expense): ' + addWarnings.join(' '));
    }
    logStep('editExpense: bikes lane', t);
  })();

  const cashLane = (async () => {
    const t = nowMs();
    // PERF (15/08/2026): captures whichever cash-sheet write actually ran
    // (at most one of these three branches touches "cash") so
    // recomputeMonthlySummaryCascadeB below can skip re-reading it -- see
    // recomputeCashSheetTotalsB's comment. Stays null if no branch touched
    // cash, or if the one that did failed.
    try {
      if (wasCash && isCash) {
        if (resolvedOldCashRow) {
          knownCash = await updateCashRowFromJson(resolvedOldCashRow, 'expense', oldExpense, oldAmount, newExpenseText, newAmount);
        } else {
          knownCash = await appendCashExpenseRowFromJson(newExpenseText, newAmount);
          warnings.push('Could not find a matching "cash" sheet row for this entry -- a NEW cash row was added for the updated amount instead. Please check the "cash" sheet for a possible duplicate.');
        }
      } else if (wasCash && !isCash) {
        if (resolvedOldCashRow) {
          knownCash = await deleteCashRowFromJson(resolvedOldCashRow, 'expense', oldExpense, oldAmount);
        } else {
          warnings.push('Could not find a matching "cash" sheet row for this entry -- if it logged one, please remove it manually.');
        }
      } else if (!wasCash && isCash) {
        knownCash = await appendCashExpenseRowFromJson(newExpenseText, newAmount);
      }
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }
    logStep('editExpense: cash lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    // These four all touch `monthName` again (type-total old/new,
    // deposit-total old/new) -- kept sequential relative to EACH OTHER
    // (same file, same order as before), but the group as a whole is its
    // own independent lane.
    if (oldTypeKey !== newTypeKey) {
      if (oldTypeKey === 'personal' || oldTypeKey === 'wages') {
        try { await updateExpenseTypeTotalRefFromJson(monthName, year, oldTypeKey, row, false); }
        catch (e) { warnings.push('Expense type total: ' + e.message); }
      }
      if (newTypeKey === 'personal' || newTypeKey === 'wages') {
        try { await updateExpenseTypeTotalRefFromJson(monthName, year, newTypeKey, row, true); }
        catch (e) { warnings.push('Expense type total: ' + e.message); }
      }
    }
    try {
      if (oldPaymentLower === 'wise' || oldPaymentLower === 'revolut') {
        await processDepositForPaymentFromJson(oldPaymentLower, oldAmount === '' ? 0 : oldAmount, monthName, year);
      }
    } catch (e) { warnings.push('Deposit total (reversing old): ' + e.message); }
    try {
      if (newPaymentLower === 'wise' || newPaymentLower === 'revolut') {
        await processDepositForPaymentFromJson(newPaymentLower, -(newAmount === '' ? 0 : newAmount), monthName, year);
      }
    } catch (e) { warnings.push('Deposit total (applying new): ' + e.message); }
    logStep('editExpense: month-sheet-again lane (type-total+deposit)', t);
  })();

  const t2 = nowMs();
  await Promise.all([notesLane, bikesLane, cashLane, monthAgainLane]);
  logStep('editExpense: parallel lanes (notes+bikes+cash+monthAgain) TOTAL', t2);

  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('editExpense: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'editExpenseRowFromJson', reversible: true,
      summary: 'Edited expense ' + fmtMoneyB(oldAmount) + ' → ' + fmtMoneyB(newAmount) + ' — ' + (newExpenseText || oldExpense || '(no description)') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [1, 2, 3, 4], before: [existing[0], existing[1], existing[2], existing[3]], after: [r[0], r[1], r[2], r[3]] }]
    });
    logStep('editExpense: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('editExpense: parallel lanes (cascade+log) TOTAL', t3);

  logStep('editExpenseRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true, row };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2436-2567 ----
// ---- action:'editIncome' port. Differs from editExpense: bike-split note
// on column G(7) not B(2); no expense-type total concept; Wise/Revolut
// sign is the mirror image (income adds, expense subtracts); TWO
// bikes-sheet reconciliation paths (auto-detected rental-line text via
// extractBikeNameFromRentalIncomeTextB, PLUS manual splits -- mutually
// exclusive per edit since newBikeSplits is forced empty whenever the new
// text still looks like a rental line); never touches deposit consumption
// (Code.gs: "editing an existing income entry doesn't touch deposit
// balances"). ----
async function editIncomeRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();
  const row = Math.round(Number(data.row));
  if (!row || row < 2) throw new Error('Invalid row.');
  const notesSheet = monthName + '_notes';

  // PERF (16/08/2026): see the matching comment in editExpenseRowFromJson --
  // the month-sheet read and the notes sidecar read are independent files.
  const t0 = nowMs();
  const [{ rows, modifiedTime }, oldNoteRowsResult] = await Promise.all([
    fetchSheetWithMeta(monthName, year),
    fetchSheetWithMeta(notesSheet, year).then(res => ({ ok: true, rows: res.rows })).catch(() => ({ ok: false, rows: [] }))
  ]);
  logStep('editIncome: read month sheet + notes sidecar', t0);
  const existing = rows[row - 1];
  if (!existing) throw new Error('Could not find row ' + row + ' on "' + monthName + '" -- it may have moved. Please reload and try again.');

  const oldIncome = (existing[6] || '').toString().trim();
  const oldAmountRaw = existing[8];
  const oldAmount = (oldAmountRaw === '' || oldAmountRaw === null || oldAmountRaw === undefined || isNaN(Number(oldAmountRaw))) ? '' : Number(oldAmountRaw);
  const oldPaidByLower = (existing[9] || '').toString().trim().toLowerCase();

  const oldNoteRows = oldNoteRowsResult.rows;
  const oldNoteEntry = (oldNoteRows || []).find(n => n[0] === row && n[1] === 7);
  const oldBikeSplits = parseExpenseBikeSplitsNote(oldNoteEntry ? oldNoteEntry[2] : '', '');

  const oldRentalBikeName = extractBikeNameFromRentalIncomeTextB(oldIncome);
  const newRentalBikeName = extractBikeNameFromRentalIncomeTextB(data.income);

  const newAmount = (data.amount === '' || data.amount === undefined || data.amount === null || isNaN(Number(data.amount))) ? '' : Number(data.amount);
  const newPaidByLower = (data.paidBy || '').toString().trim().toLowerCase();
  const newIncomeText = (data.income || '').toString().trim();
  const newBikeSplits = newRentalBikeName ? [] : resolveIncomeBikeSplitsB(data.incomeBikeSplits, newAmount);

  const wasCash = oldPaidByLower === 'cash';
  const isCash = newPaidByLower === 'cash';

  let resolvedOldCashRow = null;
  if (wasCash) {
    const resolution = await resolveCashRowFromJson('income', data.cashRowChoice, oldIncome, oldAmount);
    if (resolution.needsDisambiguation) {
      return { success: false, needsDisambiguation: true, candidates: resolution.candidates };
    }
    resolvedOldCashRow = resolution.row;
  }

  const newRows = rows.map(r => r.slice());
  const r = newRows[row - 1].slice();
  while (r.length < 10) r.push('');
  r[5] = data.date ? isoDateInputToSheetValue(data.date) : '';
  r[6] = newIncomeText;
  r[7] = data.name || '';
  r[8] = newAmount;
  r[9] = data.paidBy || '';
  newRows[row - 1] = r;
  const t1 = nowMs();
  await writeSheetJson(monthName, newRows, modifiedTime, year);
  logStep('editIncome: write row', t1);

  const warnings = [];

  // PERF (16/08/2026): same 4-independent-lane restructure as
  // editExpenseRowFromJson (notes sidecar / bikes / cash / month
  // sheet-again for deposit totals), run together via Promise.all.
  let knownCash = null;
  const notesLane = (async () => {
    const t = nowMs();
    try { await setBikeSplitsNoteFromJson(monthName, year, row, 7, newBikeSplits); } catch (e) { /* best-effort */ }
    logStep('editIncome: notes lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    try {
      if (oldRentalBikeName && oldAmount !== '') await addRentalAmountToBikesSheetFromJson(oldRentalBikeName, -oldAmount, monthName, 1);
    } catch (e) { warnings.push('Bikes sheet (removing old rental line): ' + e.message); }
    try {
      if (newRentalBikeName && newAmount !== '') await addRentalAmountToBikesSheetFromJson(newRentalBikeName, newAmount, monthName, 1);
    } catch (e) { warnings.push('Bikes sheet (adding new rental line): ' + e.message); }

    if (!expenseBikeSplitsUnchangedB(oldBikeSplits, newBikeSplits)) {
      const removeWarnings = [];
      for (const s of oldBikeSplits) {
        try { await addRentalAmountToBikesSheetFromJson(s.bike, -s.amount, monthName, 1); }
        catch (e) { removeWarnings.push(e.message); }
      }
      if (removeWarnings.length) warnings.push('Bikes sheet (removing old income split): ' + removeWarnings.join(' '));
      const addWarnings = [];
      for (const s of newBikeSplits) {
        try { await addRentalAmountToBikesSheetFromJson(s.bike, s.amount, monthName, 1); }
        catch (e) { addWarnings.push(e.message); }
      }
      if (addWarnings.length) warnings.push('Bikes sheet (adding new income split): ' + addWarnings.join(' '));
    }
    logStep('editIncome: bikes lane', t);
  })();

  const cashLane = (async () => {
    const t = nowMs();
    // PERF (15/08/2026): see the matching comment in editExpenseRowFromJson.
    try {
      if (wasCash && isCash) {
        if (resolvedOldCashRow) {
          knownCash = await updateCashRowFromJson(resolvedOldCashRow, 'income', oldIncome, oldAmount, newIncomeText, newAmount);
        } else {
          knownCash = await appendCashSheetRowFromJson(newIncomeText, newAmount);
          warnings.push('Could not find a matching "cash" sheet row for this entry -- a NEW cash row was added for the updated amount instead. Please check the "cash" sheet for a possible duplicate.');
        }
      } else if (wasCash && !isCash) {
        if (resolvedOldCashRow) {
          knownCash = await deleteCashRowFromJson(resolvedOldCashRow, 'income', oldIncome, oldAmount);
        } else {
          warnings.push('Could not find a matching "cash" sheet row for this entry -- if it logged one, please remove it manually.');
        }
      } else if (!wasCash && isCash) {
        knownCash = await appendCashSheetRowFromJson(newIncomeText, newAmount);
      }
    } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }
    logStep('editIncome: cash lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    try {
      if (oldPaidByLower === 'wise' || oldPaidByLower === 'revolut') {
        await processDepositForPaymentFromJson(oldPaidByLower, -(oldAmount === '' ? 0 : oldAmount), monthName, year);
      }
    } catch (e) { warnings.push('Deposit total (reversing old): ' + e.message); }
    try {
      if (newPaidByLower === 'wise' || newPaidByLower === 'revolut') {
        await processDepositForPaymentFromJson(newPaidByLower, (newAmount === '' ? 0 : newAmount), monthName, year);
      }
    } catch (e) { warnings.push('Deposit total (applying new): ' + e.message); }
    logStep('editIncome: month-sheet-again lane (deposit)', t);
  })();

  const t2 = nowMs();
  await Promise.all([notesLane, bikesLane, cashLane, monthAgainLane]);
  logStep('editIncome: parallel lanes (notes+bikes+cash+monthAgain) TOTAL', t2);

  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('editIncome: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'editIncomeRowFromJson', reversible: true,
      summary: 'Edited income ' + fmtMoneyB(oldAmount) + ' → ' + fmtMoneyB(newAmount) + ' — ' + (newIncomeText || oldIncome || '(no description)') + (data.name ? (' from ' + data.name) : '') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [6, 7, 8, 9, 10], before: [existing[5], existing[6], existing[7], existing[8], existing[9]], after: [r[5], r[6], r[7], r[8], r[9]] }]
    });
    logStep('editIncome: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('editIncome: parallel lanes (cascade+log) TOTAL', t3);

  logStep('editIncomeRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true, row };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2569-2683 ----
// ---- action:'deleteExpense' port. Deletes ONLY columns A:D (4 cols),
// shifting everything below in those columns up by one -- the income side
// (F-J) of the same physical rows is untouched. All reversal steps happen
// BEFORE the physical deletion (type-total ref and bike splits need the
// row's own number, which is stale afterward). ----
async function deleteExpenseRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();
  const row = Math.round(Number(data.row));
  if (!row || row < 2) throw new Error('Invalid row.');
  const notesSheet = monthName + '_notes';

  // PERF (16/08/2026): see the matching comment in editExpenseRowFromJson --
  // the month-sheet read and the notes sidecar read are independent files.
  const t0 = nowMs();
  const [{ rows }, noteRowsResult] = await Promise.all([
    fetchSheetWithMeta(monthName, year),
    fetchSheetWithMeta(notesSheet, year).then(res => ({ ok: true, rows: res.rows })).catch(() => ({ ok: false, rows: [] }))
  ]);
  logStep('deleteExpense: read month sheet + notes sidecar', t0);
  const existing = rows[row - 1];
  if (!existing) throw new Error('Could not find row ' + row + ' on "' + monthName + '" -- it may have moved. Please reload and try again.');

  const expense = (existing[1] || '').toString().trim();
  const amountRaw = existing[2];
  const amount = (amountRaw === '' || amountRaw === null || amountRaw === undefined || isNaN(Number(amountRaw))) ? '' : Number(amountRaw);
  const paymentLower = (existing[3] || '').toString().trim().toLowerCase();

  const noteRows = noteRowsResult.rows;
  const typeNoteEntry = (noteRows || []).find(n => n[0] === row && n[1] === EXPENSE_TYPE_NOTE_COL_B);
  const typeKey = normalizeExpenseTypeKeyB(typeNoteEntry ? typeNoteEntry[2] : '');
  const noteEntry = (noteRows || []).find(n => n[0] === row && n[1] === 2);
  const expenseBikeSplits = parseExpenseBikeSplitsNote(noteEntry ? noteEntry[2] : '', amount);

  let resolvedCashRow = null;
  if (paymentLower === 'cash') {
    const resolution = await resolveCashRowFromJson('expense', data.cashRowChoice, expense, amount);
    if (resolution.needsDisambiguation) {
      return { success: false, needsDisambiguation: true, candidates: resolution.candidates };
    }
    resolvedCashRow = resolution.row;
  }

  const warnings = [];
  // PERF (16/08/2026): 4 independent lanes -- cash sheet delete, bikes
  // sheet reversal, notes-sidecar row-shift cleanup, and the month
  // sheet-again reversals (deposit total + expense-type total) -- run
  // together via Promise.all. Note the notes-shift step (dropping this
  // row's own notes + decrementing every later note's row number) doesn't
  // actually need to wait for the physical row-shift write below: it only
  // needs to know WHICH row number is being deleted, which was already
  // known before any of this started -- so it's safe to run concurrently
  // with everything else here, not just after the shift-write like the
  // original code happened to sequence it.
  let knownCash = null;
  const cashLane = (async () => {
    const t = nowMs();
    try {
      if (paymentLower === 'cash') {
        if (resolvedCashRow) knownCash = await deleteCashRowFromJson(resolvedCashRow, 'expense', expense, amount);
        else warnings.push('Could not find a matching "cash" sheet row for this entry -- if it logged one, please remove it manually.');
      }
    } catch (e) { warnings.push('Cash sheet: ' + e.message); }
    logStep('deleteExpense: cash lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    const bikeWarnings = [];
    for (const s of expenseBikeSplits) {
      try { await addRentalAmountToBikesSheetFromJson(s.bike, -s.amount, monthName, 51); }
      catch (e) { bikeWarnings.push(e.message); }
    }
    if (bikeWarnings.length) warnings.push('Bikes sheet (expense): ' + bikeWarnings.join(' '));
    logStep('deleteExpense: bikes lane', t);
  })();

  const notesShiftLane = (async () => {
    const t = nowMs();
    // The notes sidecar is a SEPARATE file keyed by [row, col] -- unlike a
    // real spreadsheet, deleting a row here does NOT automatically shift
    // its cell notes along with it, so that has to be done explicitly:
    // drop this row's own notes, and decrement every later col-5
    // (expense-type, see EXPENSE_TYPE_NOTE_COL_B) and col-2 (expense side
    // bike-splits) note's row number by one to match the data that's about
    // to shift up on the month sheet.
    try {
      const { rows: nr, modifiedTime: nmt } = await fetchSheetWithMeta(notesSheet, year);
      const isExpenseCol = c => c === EXPENSE_TYPE_NOTE_COL_B || c === 2;
      const shifted = (nr || [])
        .filter(n => !(isExpenseCol(n[1]) && n[0] === row))
        .map(n => (isExpenseCol(n[1]) && n[0] > row) ? [n[0] - 1, n[1], n[2]] : n);
      await writeSheetJson(notesSheet, shifted, nmt, year);
    } catch (e) { /* best-effort */ }
    logStep('deleteExpense: notes-shift lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    // Both of these touch `monthName` -- kept sequential relative to EACH
    // OTHER (same file, same order as before), but the pair as a whole is
    // its own independent lane. Must finish before the fresh-read +
    // shift-write below, which is why it's still awaited as part of this
    // same parallel batch rather than fired off separately.
    try {
      if (paymentLower === 'wise' || paymentLower === 'revolut') {
        await processDepositForPaymentFromJson(paymentLower, amount === '' ? 0 : amount, monthName, year);
      }
    } catch (e) { warnings.push('Deposit total: ' + e.message); }
    try {
      if (typeKey === 'personal' || typeKey === 'wages') {
        await updateExpenseTypeTotalRefFromJson(monthName, year, typeKey, row, false);
      }
    } catch (e) { warnings.push('Expense type total: ' + e.message); }
    logStep('deleteExpense: month-sheet-again lane (deposit+type total)', t);
  })();

  const t1 = nowMs();
  await Promise.all([cashLane, bikesLane, notesShiftLane, monthAgainLane]);
  logStep('deleteExpense: parallel lanes (cash+bikes+notesShift+monthAgain) TOTAL', t1);

  // Solitary, sequential, unchanged in spirit from before: re-read
  // `monthName` fresh (to pick up monthAgainLane's reversal writes) and
  // apply the physical row-shift. Stays alone on purpose -- cascade below
  // needs this to have landed first.
  const t2 = nowMs();
  const { rows: freshRows, modifiedTime: freshModifiedTime } = await fetchSheetWithMeta(monthName, year);
  const newRows = freshRows.map(r => r.slice());
  for (let i = row - 1; i < newRows.length - 1; i++) {
    const src = newRows[i + 1] || [];
    const r2 = newRows[i].slice();
    for (let c = 0; c < 4; c++) r2[c] = src[c] !== undefined ? src[c] : '';
    newRows[i] = r2;
  }
  const lastIdx = newRows.length - 1;
  if (newRows[lastIdx]) {
    const r2 = newRows[lastIdx].slice();
    for (let c = 0; c < 4; c++) r2[c] = '';
    newRows[lastIdx] = r2;
  }
  await writeSheetJson(monthName, newRows, freshModifiedTime, year);
  logStep('deleteExpense: fresh-read + shift-write', t2);

  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('deleteExpense: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'deleteExpenseRowFromJson', reversible: false,
      summary: 'Deleted expense ' + fmtMoneyB(amount) + ' — ' + (expense || '(no description)') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [1, 2, 3, 4], before: [existing[0], existing[1], existing[2], existing[3]], after: ['', '', '', ''], note: 'Row was removed with a shift-up of everything below it -- not auto-reversible yet. Before-values kept here for manual reference.' }]
    });
    logStep('deleteExpense: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('deleteExpense: parallel lanes (cascade+log) TOTAL', t3);

  logStep('deleteExpenseRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2685-2784 ----
// ---- action:'deleteIncome' port. Deletes columns F:K (6 cols, not just
// F:J) -- the extra K column keeps the Net-profit/Actual-profit label
// (column J) and its figure (column K) shifting in lockstep, same reason
// Code.gs's own comment gives (a bug seen 31/07/2026 from a narrower
// range). Expense side (A:D) of the same physical rows is untouched. ----
async function deleteIncomeRowFromJson(data) {
  const actionStart = nowMs();
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();
  const row = Math.round(Number(data.row));
  if (!row || row < 2) throw new Error('Invalid row.');
  const notesSheet = monthName + '_notes';

  // PERF (16/08/2026): see the matching comment in deleteExpenseRowFromJson.
  const t0 = nowMs();
  const [{ rows }, noteRowsResult] = await Promise.all([
    fetchSheetWithMeta(monthName, year),
    fetchSheetWithMeta(notesSheet, year).then(res => ({ ok: true, rows: res.rows })).catch(() => ({ ok: false, rows: [] }))
  ]);
  logStep('deleteIncome: read month sheet + notes sidecar', t0);
  const existing = rows[row - 1];
  if (!existing) throw new Error('Could not find row ' + row + ' on "' + monthName + '" -- it may have moved. Please reload and try again.');

  const income = (existing[6] || '').toString().trim();
  const amountRaw = existing[8];
  const amount = (amountRaw === '' || amountRaw === null || amountRaw === undefined || isNaN(Number(amountRaw))) ? '' : Number(amountRaw);
  const paidByLower = (existing[9] || '').toString().trim().toLowerCase();

  const noteRows = noteRowsResult.rows;
  const noteEntry = (noteRows || []).find(n => n[0] === row && n[1] === 7);
  const incomeBikeSplits = parseExpenseBikeSplitsNote(noteEntry ? noteEntry[2] : '', '');

  let resolvedCashRow = null;
  if (paidByLower === 'cash') {
    const resolution = await resolveCashRowFromJson('income', data.cashRowChoice, income, amount);
    if (resolution.needsDisambiguation) {
      return { success: false, needsDisambiguation: true, candidates: resolution.candidates };
    }
    resolvedCashRow = resolution.row;
  }

  const warnings = [];
  // PERF (16/08/2026): see the matching comment in deleteExpenseRowFromJson
  // -- 4 independent lanes run together via Promise.all.
  let knownCash = null;
  const cashLane = (async () => {
    const t = nowMs();
    try {
      if (paidByLower === 'cash') {
        if (resolvedCashRow) knownCash = await deleteCashRowFromJson(resolvedCashRow, 'income', income, amount);
        else warnings.push('Could not find a matching "cash" sheet row for this entry -- if it logged one, please remove it manually.');
      }
    } catch (e) { warnings.push('Cash sheet: ' + e.message); }
    logStep('deleteIncome: cash lane', t);
  })();

  const bikesLane = (async () => {
    const t = nowMs();
    const deletedBikeName = extractBikeNameFromRentalIncomeTextB(income);
    try {
      if (deletedBikeName && amount !== '') await addRentalAmountToBikesSheetFromJson(deletedBikeName, -amount, monthName, 1);
    } catch (e) { warnings.push('Bikes sheet (rental line): ' + e.message); }

    const bikeWarnings = [];
    for (const s of incomeBikeSplits) {
      try { await addRentalAmountToBikesSheetFromJson(s.bike, -s.amount, monthName, 1); }
      catch (e) { bikeWarnings.push(e.message); }
    }
    if (bikeWarnings.length) warnings.push('Bikes sheet (income split): ' + bikeWarnings.join(' '));
    logStep('deleteIncome: bikes lane', t);
  })();

  const notesShiftLane = (async () => {
    const t = nowMs();
    try {
      const { rows: nr, modifiedTime: nmt } = await fetchSheetWithMeta(notesSheet, year);
      const shifted = (nr || [])
        .filter(n => !(n[1] === 7 && n[0] === row))
        .map(n => (n[1] === 7 && n[0] > row) ? [n[0] - 1, n[1], n[2]] : n);
      await writeSheetJson(notesSheet, shifted, nmt, year);
    } catch (e) { /* best-effort */ }
    logStep('deleteIncome: notes-shift lane', t);
  })();

  const monthAgainLane = (async () => {
    const t = nowMs();
    try {
      if (paidByLower === 'wise' || paidByLower === 'revolut') {
        await processDepositForPaymentFromJson(paidByLower, -(amount === '' ? 0 : amount), monthName, year);
      }
    } catch (e) { warnings.push('Deposit total: ' + e.message); }
    logStep('deleteIncome: month-sheet-again lane (deposit)', t);
  })();

  const t1 = nowMs();
  await Promise.all([cashLane, bikesLane, notesShiftLane, monthAgainLane]);
  logStep('deleteIncome: parallel lanes (cash+bikes+notesShift+monthAgain) TOTAL', t1);

  // Solitary, sequential: re-read `monthName` fresh (to pick up
  // monthAgainLane's deposit reversal) and apply the physical row-shift.
  const t2 = nowMs();
  const { rows: freshRows, modifiedTime: freshModifiedTime } = await fetchSheetWithMeta(monthName, year);
  const newRows = freshRows.map(r => r.slice());
  for (let i = row - 1; i < newRows.length - 1; i++) {
    const src = newRows[i + 1] || [];
    const r2 = newRows[i].slice();
    for (let c = 5; c <= 10; c++) r2[c] = src[c] !== undefined ? src[c] : '';
    newRows[i] = r2;
  }
  const lastIdx = newRows.length - 1;
  if (newRows[lastIdx]) {
    const r2 = newRows[lastIdx].slice();
    for (let c = 5; c <= 10; c++) r2[c] = '';
    newRows[lastIdx] = r2;
  }
  await writeSheetJson(monthName, newRows, freshModifiedTime, year);
  logStep('deleteIncome: fresh-read + shift-write', t2);

  const cascadeLane = (async () => {
    const t = nowMs();
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
    logStep('deleteIncome: cascade lane', t);
  })();
  const logLane = (async () => {
    const t = nowMs();
    await logTransactionB({
      page: 'accounts.html', action: 'deleteIncomeRowFromJson', reversible: false,
      summary: 'Deleted income ' + fmtMoneyB(amount) + ' — ' + (income || '(no description)') + ' (' + monthName + ' ' + year + ')',
      writes: [{ sheet: monthName, year: year, row: row, cols: [6, 7, 8, 9, 10, 11], before: [existing[5], existing[6], existing[7], existing[8], existing[9], existing[10]], after: ['', '', '', '', '', ''], note: 'Row was removed with a shift-up of everything below it -- not auto-reversible yet. Before-values kept here for manual reference.' }]
    });
    logStep('deleteIncome: log lane', t);
  })();
  const t3 = nowMs();
  await Promise.all([cascadeLane, logLane]);
  logStep('deleteIncome: parallel lanes (cascade+log) TOTAL', t3);

  logStep('deleteIncomeRowFromJson TOTAL', actionStart);
  const responsePayload = { success: true };
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2786-2834 ----
// ---- action:'bulkSetExpenseType' port (13/08/2026 -- the "Complete
// Transfers"/"Transfer Completed" buttons). Byte-for-byte port of Code.gs's
// bulkSetExpenseType, made possible now that expense type has a real
// stored equivalent (see normalizeExpenseTypeKeyB/setExpenseTypeNoteFromJson
// above). fromType/toType are validated with the SAME case-sensitive
// EXPENSE_TYPE_COLORS.hasOwnProperty check Code.gs uses (the client always
// sends canonically-cased keys, e.g. 'transferComplete', so this is safe).
// Each row's CURRENT type is re-read fresh from the notes sidecar right
// before deciding whether to touch it -- not trusting the client's
// possibly-stale list -- so a row whose type changed elsewhere in the
// meantime is skipped rather than blindly overwritten, same as Code.gs's
// own getRange(row,2).getBackground() re-check.
async function bulkSetExpenseTypeFromJson(data) {
  const monthName = accountsMonthNameFor(data.monthIndex);
  const year = accountsCurrentYear();

  const fromType = (data.fromType || '').toString().trim();
  const toType = (data.toType || '').toString().trim();
  if (!Object.prototype.hasOwnProperty.call(EXPENSE_TYPE_COLORS, fromType) ||
      !Object.prototype.hasOwnProperty.call(EXPENSE_TYPE_COLORS, toType)) {
    throw new Error('Unrecognized expense type -- nothing was changed.');
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const changed = [];
  const skipped = [];

  for (const rawRow of rows) {
    const row = parseInt(rawRow, 10);
    if (!row || row < 2) { skipped.push(rawRow); continue; }
    let currentType = 'business';
    try {
      const notesSheet = monthName + '_notes';
      const { rows: noteRows } = await fetchSheetWithMeta(notesSheet, year);
      const entry = (noteRows || []).find(n => n[0] === row && n[1] === EXPENSE_TYPE_NOTE_COL_B);
      currentType = normalizeExpenseTypeKeyB(entry ? entry[2] : '');
    } catch (e) { skipped.push(row); continue; }
    if (currentType !== fromType) { skipped.push(row); continue; }
    try { await setExpenseTypeNoteFromJson(monthName, year, row, toType); }
    catch (e) { skipped.push(row); continue; }
    changed.push(row);
  }

  const responsePayload = { success: true, changed: changed.length, changedRows: changed, skippedRows: skipped };
  if (skipped.length) {
    responsePayload.warning = skipped.length + ' row(s) were skipped because their type had already changed since the list was loaded -- please refresh and try again if needed.';
  }
  return responsePayload;
}

// ---- extracted accounts.html lines 2852-2902 ----
// ---- action:'transferToBank' port. Wise/Revolut: draws straight down
// from that method's running deposit total, no expense/income row. Cash:
// logs a single "Deposit to Bank" row on the "cash" sheet's EXPENSE side
// only (never the monthly accounts sheet) -- same as the live version. ----
async function transferToBankFromJson(data) {
  const source = (data.source || '').toString().trim().toLowerCase();
  if (source !== 'wise' && source !== 'revolut' && source !== 'cash') {
    throw new Error('Unrecognized transfer source "' + data.source + '".');
  }
  const amount = Number(data.amount);
  if (isNaN(amount) || amount <= 0) throw new Error('Enter a valid amount to transfer.');

  const monthIndex = new Date().getMonth();
  const monthName = ACCOUNTS_MONTH_FILES[monthIndex];
  const year = accountsCurrentYear();

  const warnings = [];
  // PERF (15/08/2026): see the matching comment in editExpenseRowFromJson.
  let knownCash = null;
  if (source === 'cash') {
    try { knownCash = await appendCashExpenseRowFromJson('Deposit to Bank', amount); }
    catch (e) { warnings.push('Cash sheet: ' + e.message); }
  } else {
    try { await processDepositForPaymentFromJson(source, -amount, monthName, year); }
    catch (e) { warnings.push('Deposit total: ' + e.message); }
  }

  // Same summary-cascade gap as add/edit/delete expense/income -- this
  // draws down cash/wise/revolut, which M6 ("bank")/M9 ("total") both
  // depend on, so the balance readback just below would otherwise still
  // show a frozen figure even though the underlying transfer succeeded.
  if (monthName) {
    try { await recomputeMonthlySummaryCascadeB(monthName, year, knownCash); }
    catch (cascadeErr) { warnings.push('Summary totals: ' + cascadeErr.message); }
  }

  let balance = null;
  if (monthName) {
    try {
      const { rows } = await fetchSheetWithMeta(monthName, year);
      const expectedLabel = source === 'wise' ? 'wise(less deposit)' : source === 'revolut' ? 'revolut(less deposit)' : 'cash';
      const itemDef = ACCOUNTS_SUMMARY_ITEMS.deposit.find(it => it.expectedLabel === expectedLabel);
      if (itemDef) balance = readSummaryItem(rows, itemDef, warnings, monthName);
    } catch (e) { /* best-effort readback -- the transfer itself already succeeded above */ }
  }

  const responsePayload = { success: true };
  if (balance) responsePayload.balance = balance;
  if (warnings.length) responsePayload.warning = warnings.join(' ');
  return responsePayload;
}

// ---- extracted accounts.html lines 2836-2850 ----
// ---- Single dispatcher for runPendingPayload's save/delete click --
// matches the live scriptUrl's single-endpoint-many-actions shape so the
// call site below only needs a one-line swap. ----
//
// PORT NOTE (2026-08-16): accounts.html's own client-side copy of this
// dispatcher never had a 'transferToBank' case -- transferToBankFromJson
// was called directly from the Transfer-to-Bank modal's own click handler,
// a completely separate code path from this add/edit/delete dispatcher
// (see accounts.html's transferModalSaveBtn listener). Now that this is the
// SINGLE server-side entry point for every accounts.html write action (the
// whole point of api/accounts/write.js -- one endpoint, one round trip, no
// matter which action), that split no longer makes sense: this case is
// added so the Transfer modal can go through the exact same endpoint as
// everything else, rather than needing its own separate route. The client
// side of this change updates accounts.html's transferModalSaveBtn handler
// to call accountsWriteDispatch({action:'transferToBank', ...}) instead of
// calling transferToBankFromJson directly -- see that file's own comment.
async function accountsWriteDispatch(payload) {
  switch (payload.action) {
    case 'addExpense': return addExpenseRowFromJson(payload);
    case 'editExpense': return editExpenseRowFromJson(payload);
    case 'addIncome': return addIncomeRowFromJson(payload);
    case 'editIncome': return editIncomeRowFromJson(payload);
    case 'deleteExpense': return deleteExpenseRowFromJson(payload);
    case 'deleteIncome': return deleteIncomeRowFromJson(payload);
    case 'bulkSetExpenseType': return bulkSetExpenseTypeFromJson(payload);
    case 'transferToBank': return transferToBankFromJson(payload);
    default: throw new Error('Unrecognized action "' + payload.action + '".');
  }
}

  return {
    accountsWriteDispatch,
    addExpenseRowFromJson,
    addIncomeRowFromJson,
    editExpenseRowFromJson,
    editIncomeRowFromJson,
    deleteExpenseRowFromJson,
    deleteIncomeRowFromJson,
    bulkSetExpenseTypeFromJson,
    transferToBankFromJson,
    // Exposed for the test harness (ports the same fake-Drive-based tests
    // /tmp/accountstest/ used for the browser version) -- not used by
    // api/accounts/write.js itself, which only ever calls
    // accountsWriteDispatch.
    recomputeMonthlySummaryCascadeB,
    recomputeCashSheetTotalsB
  };
}

module.exports = { createAccountsWrites, createSheetIO };
