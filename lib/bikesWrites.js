// ---- Server-side bikes.html write layer -- Phase 2 of the optimistic/
// idempotent-save rollout (see PROGRESS.md's "NEXT UP" entry and the
// "Phase 2, bikes.html write layer: INVENTORY/DESIGN DONE" entry for the
// full plan and the traced action inventory).
//
// STATUS (2026-08-17): ALL 7 of bikes.html's write actions are now ported
// -- 'swapBike', 'markReturned', 'earlyReturnBike', 'returnDeposit',
// 'updateReturnPickup', 'extendBike' (short extension), and the
// long-extension pair, exposed as 'closeBikeForExtend' + 'customerIntake'
// (2 actions, matching bikes.html's own frontend which fires them as 2
// separate sequential requests rather than 1 combined one). This was
// deliberate, one-action-at-a-time work (per the plan's own recommended
// approach: "do not wire ANY optimistic-UI frontend changes until every
// action is ported and passing its backend test"), started with swap
// (most self-contained, single request), then the return family
// (markReturned/earlyReturnBike/returnDeposit -- grouped together since
// bikes.html's own confirmReturn() always fires markReturned OR
// earlyReturnBike, then separately fires returnDeposit as a best-effort
// follow-up when a security deposit was matched), then
// updateReturnPickup + extendBike (short), then finally the long-extension
// pair. bikesWriteDispatch below now handles every action bikes.html's
// frontend can fire -- calling anything else still throws clearly rather
// than silently doing nothing.
//
// UPDATE (2026-08-17, same day): 'returnDeposit' -- the one action left
// without a clientTxnId idempotency guard when this file was first
// completed -- now has one too (see its own block comment below for the
// mechanism, a flat clientTxnId sidecar rather than a row-keyed marker,
// since this action has no single customer row of its own to tag). Closes
// the last gap ahead of the frontend optimistic-UI + background-save work,
// which relies on every action being safe to blindly retry if its outcome
// is ever unclear (e.g. the page was navigated away from mid-save).
//
// NEXT UP: the frontend optimistic-UI + idempotency-submission layer
// itself (still nothing wired in yet -- see bikes.html's own DEAD CODE
// banner comment near its old write-action block).
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

// calendarCtx (added 18/08/2026, optional -- see lib/customersWrites.js's
// own createCustomersWrites comment for the full "why"/shape) is {drive,
// folderId, session} from the STAFF Drive session -- used to sync the 🛵
// due-back event whenever this file closes out or creates a customer row.
function createBikesWrites(sheetIO, calendarCtx) {
  const { fetchSheetWithMeta, writeSheetJson } = sheetIO;

  // Shared by every hook point below -- returns {calendar, contractLookup}
  // or null if calendar isn't connected/configured, so each call site can
  // just `if (!cal) return;`. Wrapped so a calendar problem never blocks the
  // bike-status write it's piggybacking on, exactly Code.gs's own posture.
  // calCtx.error added 24/08/2026 (Anton: "I just returned Rax blue and
  // it's still there... I've asked you to fix this four times now" -- the
  // 23/08/2026 fix (see syncDueBackEventForCustomerRow's own header
  // comment) only surfaces a failure that happens INSIDE an already-built
  // calendar client (the actual events.delete() call). This function is
  // one level up: if calendarClientFromStoredAuth or the Contract-sheet
  // fetch below throws for ANY reason -- a Drive/session hiccup, a
  // malformed calendar_auth.json, anything -- the catch below used to
  // return null exactly like the legitimate "nothing connected yet" case,
  // so every call site's `if (calCtx) {...}` just skipped quietly with no
  // warning at all. Now this returns `{error}` instead of null so callers
  // can tell "not configured" (still null, still silent -- correct) apart
  // from "configured but broke this request" (now surfaced the same way
  // the 23/08 fix already surfaces a delete failure).
  async function getCalendarSyncContext() {
    if (!calendarCtx || !calendarCtx.drive) return null;
    let calAuth;
    try {
      const { calendarClientFromStoredAuth } = require('./googleCalendarAuth');
      calAuth = await calendarClientFromStoredAuth(calendarCtx.drive, calendarCtx.folderId, calendarCtx.session);
    } catch (err) {
      console.warn('[bikesWrites] calendar context unavailable (non-blocking):', err && err.message);
      return { error: 'could not load the calendar connection (' + ((err && err.message) || 'unknown error') + ')' };
    }
    if (!calAuth) return null; // genuinely not connected yet -- skip quietly, unchanged
    try {
      const { buildContractLookup } = require('./googleCalendarSync');
      const { rows: contractRowsForCal } = await fetchSheetWithMeta('Contract');
      return { calendar: calAuth.calendar, contractLookup: buildContractLookup(contractRowsForCal) };
    } catch (err) {
      console.warn('[bikesWrites] calendar context unavailable (non-blocking):', err && err.message);
      return { error: 'could not prepare calendar sync (' + ((err && err.message) || 'unknown error') + ')' };
    }
  }

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

  // ---- locateCashSummaryBlock -- verbatim port of accountsWrites.js's copy
  // (see that file for the full "why"). Finds the "cash" sheet's summary
  // block (the "income" total row and the "total cash" row) by their own
  // labels rather than a fixed offset, so every copy of this file agrees on
  // where the block currently sits even after rows get inserted above it. ----
  function locateCashSummaryBlock(rows) {
    const norm = s => (s || '').toString().trim().toLowerCase();
    let incomeRow = -1, totalRow = -1;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (incomeRow === -1 && norm(row[1]) === 'income') incomeRow = r + 1;
      if (totalRow === -1 && norm(row[5]) === 'total cash') totalRow = r + 1;
      if (incomeRow !== -1 && totalRow !== -1) break;
    }
    if (incomeRow === -1 || totalRow === -1) return null;
    const gap = totalRow - incomeRow;
    const expensesRow = (gap === 4) ? incomeRow + 2 : null;
    return { incomeRow, expensesRow, totalRow };
  }

  // ---- makeRoomAboveCashSummaryJson (02/09/2026) -- THE actual cause of
  // the September figures not matching real life (confirmed against the
  // live "cash" sheet, not just test data) -- verbatim port of
  // accountsWrites.js's copy, see that file for the full "why".
  // findFullyEmptyRowIdxJson above has no idea the "cash" sheet has a
  // summary block a few rows down; once real transaction rows reach it,
  // it hands out rows that sit PAST it, which never get counted -- no
  // error, entry still shows up in the list, just silently excluded from
  // the total forever. If the next free row would land at or past the
  // block, this splices a fresh blank row in directly above it instead --
  // the whole block shifts down by one to make room, and the new entry
  // goes in the row that just opened up. Mirrors the identical "insert a
  // row before the total row" trick used on the monthly Accounts sheet. ----
  function makeRoomAboveCashSummaryJson(rows2D, targetIdx) {
    const block = locateCashSummaryBlock(rows2D);
    if (!block) return targetIdx; // block not found -- leave existing behavior alone rather than guess
    const boundaryIdx = block.incomeRow - 1; // 0-indexed row the "income" label sits on
    if (targetIdx < boundaryIdx) return targetIdx; // already safely above the block
    rows2D.splice(boundaryIdx, 0, []);
    return boundaryIdx;
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
  // ---- collector (added 22/08/2026, optional trailing arg): see the same
  // comment on bikes.html's own client-side copy of this function -- THIS
  // is the copy that's actually live (bikes.html's UI posts action:'extendBike'
  // /'swapBike' to /api/bikes/write, which runs THIS file's dispatch, not
  // bikes.html's own same-named functions -- confirmed live 22/08/2026 after
  // fixing the wrong copy first and the bug not going away). When a caller
  // passes an array here, this pushes its write descriptor onto it instead
  // of logging its own separate transaction entry, so extendBikeRowFromJson/
  // swapBikeFromJson below can fold every sub-write from one user-facing
  // action into ONE combined, one-click-reversible log entry. Omit the
  // argument (no other call site does) and this behaves exactly as before. ----
  async function appendCashSheetRowFromJson(incomeText, rawAmount, collector) {
    // RETRY-ON-CONFLICT (02/09/2026): see accountsWrites.js's copy of this
    // function for the full "why" -- same bug (a losing write here silently
    // dropped a cash income entry while the income itself still posted),
    // same fix. Safe to retry: re-reading always finds a fresh empty row.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
      if (!rows || !rows.length) {
        throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
      }
      const newRows = rows.map(r => r.slice());
      const targetIdx = makeRoomAboveCashSummaryJson(newRows, findFullyEmptyRowIdxJson(newRows, 1, [1, 2, 3]));
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
      try {
        await writeSheetJson('cash', newRows, modifiedTime);
      } catch (writeErr) {
        if (writeErr instanceof ConflictError || writeErr.isConflict) continue; // someone else wrote in between -- retry
        throw writeErr;
      }
      await recomputeCurrentMonthSummaryCascadeB();
      const writeDescriptor = { sheet: 'cash', year: null, row: targetIdx + 1, cols: [1, 2, 3], before: ['', '', ''], after: [row[0], row[1], row[2]] };
      if (collector) {
        collector.push(writeDescriptor);
      } else {
        await logTransactionB({
          page: 'bikes.html', action: 'appendCashSheetRowFromJson', reversible: true,
          summary: 'Cash income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)'),
          writes: [writeDescriptor]
        });
      }
      return;
    }
    throw new Error('Could not log this cash income after 3 attempts -- someone else kept changing the "cash" sheet at the same time. Please try again.');
  }

  // ---- processDepositForPaymentFromJson -- verbatim port of bikes.html's copy. ----
  async function processDepositForPaymentFromJson(paidByLower, rawAmount, collector) {
    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const expectedRow = paidByLower === 'wise' ? 11 : 12;
    const expectedLabel = paidByLower === 'wise' ? 'wise(less deposit)' : 'revolut(less deposit)';
    const norm = s => (s || '').toString().trim().toLowerCase();
    // RETRY-ON-CONFLICT (02/09/2026): see accountsWrites.js's copy of this
    // function for the full "why" -- same fix.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
      if (!rows || !rows.length) throw new Error('No sheet found for the current month -- could not update the ' + paidByLower + ' deposit total.');
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
      try {
        await writeSheetJson(monthName, newRows, modifiedTime, year);
      } catch (writeErr) {
        if (writeErr instanceof ConflictError || writeErr.isConflict) continue; // someone else wrote in between -- retry
        throw writeErr;
      }
      await recomputeCurrentMonthSummaryCascadeB();
      const writeDescriptor = { sheet: monthName, year: year, row: rowIdx + 1, cols: [13], before: [isNaN(current) ? 0 : current], after: [targetRow[12]] };
      if (collector) {
        collector.push(writeDescriptor);
      } else {
        await logTransactionB({
          page: 'bikes.html', action: 'processDepositForPaymentFromJson', reversible: true,
          summary: (delta >= 0 ? 'Deposit total +' : 'Deposit total ') + fmtMoneyB(delta) + ' — ' + paidByLower + ' (' + monthName + ' ' + year + ')',
          writes: [writeDescriptor]
        });
      }
      return;
    }
    throw new Error('Could not save the ' + paidByLower + ' deposit total after 3 attempts -- someone else kept changing the "' + monthName + '" sheet at the same time. Please try again.');
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
    // PARALLELIZED 24/08/2026 -- fetchSheetWithMeta('customer') (a ~330KB
    // file) and getCalendarSyncContext() (a Calendar OAuth round trip plus
    // its own ~300KB Contract.json fetch) are independent of each other --
    // neither needs the other's result until the row is mutated below --
    // but used to be awaited one after another, so their latencies stacked
    // instead of overlapping. getCalendarSyncContext() itself is
    // unchanged: it still skips its own Contract fetch entirely when the
    // calendar isn't connected or auth fails (see its own comment) --
    // this only removes the artificial wait between the two calls, not
    // any of the work either one does. Same fix applied to
    // earlyReturnBikeFromJson/swapBikeFromJson/customerIntakeFromJson
    // below -- closeBikeForExtendFromJson deliberately keeps its original
    // sequential order since it needs the customer row FIRST to decide
    // whether to short-circuit an already-closed retry before paying for
    // a calendar lookup at all.
    const [{ rows, modifiedTime }, calCtx] = await Promise.all([
      fetchSheetWithMeta('customer'),
      getCalendarSyncContext()
    ]);
    const idx = rowNumber - 1; // sheet row 1 = header = array index 0
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    let row = newRows[idx].slice();
    row[8] = isoDateInputToSheetValue(isoDate); // I returnDate
    row[13] = 'Returned';                        // N situation
    const nameForContract = row[2], bikeForContract = row[5];

    // ---- Calendar sync (added 22/08/2026, Anton: "I just returned Rex...
    // and the entry is still sitting in the calendar" -- this write flips
    // situation to Returned but, unlike closeBikeForExtendFromJson/
    // customerIntakeFromJson, never told the calendar about it, so the
    // 🛵 due-back event just sat there forever). Same hook, same place in
    // the sequence (before the write) as those two -- computeDueBackEventPlan
    // sees situation=Returned and deletes the event since the row is no
    // longer "still out".
    //
    // calSyncWarning added 23/08/2026: syncDueBackEventForCustomerRow never
    // throws (see its own header comment), so this try/catch never actually
    // fired -- a real Calendar API failure (expired auth, wrong calendar,
    // etc.) was landing one level down as a console.warn only, which is
    // exactly what Anton hit ("I returned both today and it didn't update
    // the calendar entry"). Stashed here (warnings[] isn't declared until
    // after the write below) and folded in once it is, so it reaches the
    // frontend's existing `alert('Saved, but: ' + result.warning)` instead
    // of vanishing into Vercel's logs. ----
    let calSyncWarning = null;
    if (calCtx && calCtx.error) {
      calSyncWarning = 'Calendar due-back event: ' + calCtx.error;
    } else if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedRow, error: calErrMsg } = await syncDueBackEventForCustomerRow(calCtx.calendar, row, calCtx.contractLookup);
        row = syncedRow;
        if (calErrMsg) calSyncWarning = 'Calendar due-back event: ' + calErrMsg;
      } catch (calErr) {
        console.warn('[bikesWrites] markReturned calendar sync failed (non-blocking):', calErr && calErr.message);
        calSyncWarning = 'Calendar due-back event: ' + ((calErr && calErr.message) || 'unknown error');
      }
    }
    newRows[idx] = row;

    const writeResult = await writeSheetJson('customer', newRows, modifiedTime);

    // PARALLELIZED 20/08/2026 -- modest but free: the idempotency marker
    // (customer_notes) and the Contract status flip (Contract) are on two
    // disjoint files with no dependency on each other, so no reason to make
    // one wait on the other. Same reasoning as swapBikeFromJson/
    // earlyReturnBikeFromJson/extendBikeRowFromJson/customerIntakeFromJson
    // above -- see swapBikeFromJson's own comment for the full pattern
    // writeup.
    const warnings = [];
    if (calSyncWarning) warnings.push(calSyncWarning);
    await Promise.all([
      (async () => {
        if (clientTxnId) {
          try { await markTxnIdFromJson(rowNumber, clientTxnId); }
          catch (markErr) { warnings.push('Idempotency marker: ' + markErr.message + ' -- a retry of this exact request could create a duplicate.'); }
        }
      })(),
      (async () => {
        try {
          await flipMatchingContractStatus(nameForContract, bikeForContract, 'rented', 'Returned');
        } catch (err) {
          warnings.push('Bike marked returned, but the matching Contract record could not be updated automatically: ' + err.message);
        }
      })()
    ]);
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

  // ---- Deposit-tracking constants -- verbatim port of bikes.html's copies.
  // contractRowCol added 24/08/2026 -- columns 26/27/28 are genuinely free
  // real estate (confirmed against the live August.json/template.json data:
  // nothing on this sheet has ever used column 26 or later) grouped
  // together rather than squeezed between the existing tables, since bank's
  // own table (15-17) butts straight up against wise's dateCol (18) with no
  // gap at all. See logSecurityDepositFromJson's own comment for what this
  // column is for. ----
  const DEPOSIT_CATEGORIES_B = [
    { key: 'bank', label: 'Bank', header: 'deposit scan', dateCol: 15, amountCol: 16, nameCol: 17, contractRowCol: 26 },
    { key: 'wise', label: 'Wise', header: 'deposit wise', dateCol: 18, amountCol: 19, nameCol: 20, contractRowCol: 27 },
    { key: 'revolut', label: 'Revolut', header: 'deposit revolut', dateCol: 22, amountCol: 23, nameCol: 24, contractRowCol: 28 }
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
  async function appendEarlyReturnRefundIncomeRowFromJson(bikeModel, customerName, negAmount, paidBy, collector) {
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
    const writeDescriptor = { sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] };
    if (collector) {
      collector.push(writeDescriptor);
    } else {
      await logTransactionB({
        page: 'bikes.html', action: 'appendEarlyReturnRefundIncomeRowFromJson', reversible: true,
        summary: 'Income ' + fmtMoneyB(row[8]) + ' — ' + description + (customerName ? (' from ' + customerName) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [writeDescriptor]
      });
    }
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

    // PARALLELIZED 24/08/2026 -- see performMarkReturned's identical
    // comment above for the full "why" (customer fetch + calendar context
    // are independent, used to be awaited sequentially).
    const [{ rows, modifiedTime }, calCtx] = await Promise.all([
      fetchSheetWithMeta('customer'),
      getCalendarSyncContext()
    ]);
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    let row = newRows[idx].slice();
    while (row.length < 14) row.push('');

    const customerName = row[2] || '';
    const bikeModel = row[5] || '';

    const origReturnDateRaw = row[8];   // I returnDate, before mutation -- for the combined reversible log entry
    const origSituation = row[13];      // N situation, before mutation -- for the combined reversible log entry

    row[8] = isoDateInputToSheetValue(returnIsoYmd); // I returnDate
    row[13] = 'Returned';                             // N situation

    let newTotalPrice = null;
    let oldTotalPriceForLog = null;
    if (refundAmount > 0) {
      let oldTotalPrice = Number(row[11]);
      if (isNaN(oldTotalPrice)) oldTotalPrice = 0;
      if (refundAmount > oldTotalPrice + 0.01) {
        throw new Error('Refund amount (' + refundAmount + ') cannot be more than this booking\'s current total price (' + oldTotalPrice + ').');
      }
      newTotalPrice = oldTotalPrice - refundAmount;
      oldTotalPriceForLog = oldTotalPrice;
      row[11] = newTotalPrice; // L totalPrice
    }

    // ---- Calendar sync (added 22/08/2026) -- same fix, same reasoning, as
    // performMarkReturned's own copy of this comment: situation flips to
    // Returned here too, but this write never told the calendar about it
    // either, so an early-returned bike's 🛵 due-back event was left
    // sitting there just the same as a normal return's was.
    //
    // calSyncWarning added 23/08/2026 -- see performMarkReturned's own
    // identical comment for the full "why": syncDueBackEventForCustomerRow
    // never actually threw here, so a real Calendar API failure was
    // invisible outside Vercel's own logs. ----
    let calSyncWarning = null;
    if (calCtx && calCtx.error) {
      calSyncWarning = 'Calendar due-back event: ' + calCtx.error;
    } else if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedRow, error: calErrMsg } = await syncDueBackEventForCustomerRow(calCtx.calendar, row, calCtx.contractLookup);
        row = syncedRow;
        if (calErrMsg) calSyncWarning = 'Calendar due-back event: ' + calErrMsg;
      } catch (calErr) {
        console.warn('[bikesWrites] earlyReturnBike calendar sync failed (non-blocking):', calErr && calErr.message);
        calSyncWarning = 'Calendar due-back event: ' + ((calErr && calErr.message) || 'unknown error');
      }
    }
    newRows[idx] = row;

    await writeSheetJson('customer', newRows, modifiedTime);

    // ---- Idempotency marker, hardened 28/08/2026 -- see
    // contractWrites.js's customerIntakeFromJson for the full "why" (same
    // fix, same root-cause writeup, confirmed live on extendBikeRowFromJson's
    // identical old pattern -- Nmax white, 25/08/2026 investigation): the
    // marker used to be written concurrently with the ledger/Contract/
    // bikes/income writes below (inside chainMarkerAndLedger, warning-only
    // on failure), so a retried early return could pass the guard-check at
    // the top of this function again before its own marker had landed.
    // Moved here -- sequential, awaited, BEFORE any ledger/Contract/bikes/
    // income writes -- and hardened to a hard failure: if it can't be
    // confirmed, stop now (only the customer row's date/status/price
    // update above has been written) rather than let a retry silently
    // duplicate everything else. ----
    if (clientTxnId) {
      try {
        await markTxnIdFromJson(rowNumber, clientTxnId);
      } catch (markErr) {
        throw new Error('This early return\'s customer-row update was saved, but it could not be safely marked as done (idempotency marker failed: ' + markErr.message + '). Stopping here before the refund/ledger writes, to avoid a duplicate on retry -- please check row ' + rowNumber + ' and retry carefully.');
      }
    }

    const warnings = [];
    if (calSyncWarning) warnings.push(calSyncWarning);
    const negRefundAmount = -refundAmount;

    // Combined write-descriptor collector (added 28/08/2026) -- so this
    // whole early return (customer-row date/status/price change, refund
    // income row, and whichever of cash/wise/revolut the refund actually
    // hit) folds into ONE reversible Settings transaction-history entry
    // instead of several separate ones. Same pattern as extendBikeRowFromJson's
    // own combined log call below.
    const earlyReturnCollector = [
      refundAmount > 0
        ? { sheet: 'customer', row: rowNumber, cols: [9, 12, 14], before: [origReturnDateRaw, oldTotalPriceForLog, origSituation], after: [row[8], row[11], row[13]] }
        : { sheet: 'customer', row: rowNumber, cols: [9, 14], before: [origReturnDateRaw, origSituation], after: [row[8], row[13]] }
    ];

    // PARALLELIZED 20/08/2026 -- same treatment as swapBikeFromJson just
    // above (see that function's own "PARALLELIZED 20/08/2026" comment for
    // the full pattern writeup). Four disjoint-file chains:
    //   - chain A (marker + ledger): customer_notes, then customer again
    //   - chain B (Contract): sync-return-date, then (refund>0) add-amount,
    //     then flip status -- ALWAYS in this exact original order (no
    //     business dependency between these three like swap's rename had,
    //     but same-file writes still can't run concurrently with each
    //     other, so the chain preserves the original sequence unchanged)
    //   - chain C (bikes): only when refundAmount > 0
    //   - chain D (refund income): only when refundAmount > 0
    // The original code special-cased an early return when
    // refundAmount <= 0 purely to skip building the bikes/income steps --
    // that early return produced the IDENTICAL {success, warning?} shape
    // as the normal end-of-function return, so it's dropped here: each
    // chain below just no-ops under its own `refundAmount > 0` guard
    // (matching the original's own guards exactly) and everything joins
    // back into one shared `warnings` array and one return path.
    async function chainMarkerAndLedger() {
      if (refundAmount > 0) {
        try {
          await appendEarlyReturnRefundToLedgerFromJson(rowNumber, returnDateValue, returnDmy, refundAmount, newTotalPrice);
        } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }
      }
    }

    async function chainContractSync() {
      try {
        await syncContractReturnDateOnlyFromJson(customerName, bikeModel, returnDateValue);
      } catch (contractDateErr) { warnings.push('Contract return date sync: ' + contractDateErr.message); }

      if (refundAmount > 0) {
        try {
          await addAmountToContractRowFromJson(customerName, bikeModel, -refundAmount);
        } catch (contractAmountErr) { warnings.push('Contract total price sync: ' + contractAmountErr.message); }
      }

      try {
        await flipMatchingContractStatus(customerName, bikeModel, 'rented', 'Returned');
      } catch (contractStatusErr) { warnings.push('Contract status update: ' + contractStatusErr.message); }
    }

    async function chainBikesSheet() {
      if (refundAmount > 0) {
        try {
          await addRentalAmountToBikesSheetFromJson(bikeModel, negRefundAmount);
        } catch (bikesErr) { warnings.push('Bikes sheet (' + bikeModel + '): ' + bikesErr.message); }
      }
    }

    async function chainRefundIncome() {
      if (refundAmount > 0) {
        try {
          const refundDescription = await appendEarlyReturnRefundIncomeRowFromJson(bikeModel, customerName, negRefundAmount, refundPaidBy, earlyReturnCollector);
          const refundPaidByLower = refundPaidBy.toLowerCase();
          try {
            if (refundPaidByLower === 'cash') {
              await appendCashSheetRowFromJson((customerName || '') + ' - ' + refundDescription, negRefundAmount, earlyReturnCollector);
            }
          } catch (refundCashErr) { warnings.push('Refund cash sheet: ' + refundCashErr.message); }
          try {
            if (refundPaidByLower === 'wise' || refundPaidByLower === 'revolut') {
              await processDepositForPaymentFromJson(refundPaidByLower, negRefundAmount, earlyReturnCollector);
            }
          } catch (refundDepositErr) { warnings.push('Refund deposit total: ' + refundDepositErr.message); }
        } catch (refundIncomeErr) { warnings.push('Refund income entry: ' + refundIncomeErr.message); }
      }
    }

    await Promise.all([chainMarkerAndLedger(), chainContractSync(), chainBikesSheet(), chainRefundIncome()]);

    try {
      await logTransactionB({
        page: 'bikes.html', action: 'earlyReturnBikeFromJson', reversible: true,
        summary: (bikeModel || '(unknown bike)') + ' early return' +
          (refundAmount > 0 ? (' — refund ' + fmtMoneyB(refundAmount)) : '') +
          (customerName ? (' — ' + customerName) : ''),
        writes: earlyReturnCollector
      });
    } catch (logErr) { warnings.push('Transaction log: ' + logErr.message + ' -- this early return succeeded, but it will NOT be reversible from settings.html.'); }

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
    // RETRY-ON-CONFLICT (02/09/2026): see accountsWrites.js's copy of this
    // function for the full "why" -- same fix.
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows, modifiedTime } = await fetchSheetWithMeta('cash');
      if (!rows || !rows.length) {
        throw new Error('no tab named "cash" was found, so this entry was NOT logged on the cash sheet.');
      }
      const newRows = rows.map(r => r.slice());
      const targetIdx = makeRoomAboveCashSummaryJson(newRows, findFullyEmptyRowIdxJson(newRows, 1, [5, 6, 7]));
      while (newRows.length <= targetIdx) newRows.push([]);
      const row = newRows[targetIdx].slice();
      while (row.length < 7) row.push('');
      const amountValue = (rawAmount !== '' && rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) ? Number(rawAmount) : '';
      row[4] = isoDateInputToSheetValue(todayIso());
      row[5] = expenseText;
      row[6] = amountValue;
      newRows[targetIdx] = row;
      try {
        await writeSheetJson('cash', newRows, modifiedTime);
      } catch (writeErr) {
        if (writeErr instanceof ConflictError || writeErr.isConflict) continue; // someone else wrote in between -- retry
        throw writeErr;
      }
      await recomputeCurrentMonthSummaryCascadeB();
      await logTransactionB({
        page: 'bikes.html', action: 'appendCashExpenseRowFromJson', reversible: true,
        summary: 'Cash expense ' + fmtMoneyB(amountValue) + ' — ' + (expenseText || '(no description)'),
        writes: [{ sheet: 'cash', year: null, row: targetIdx + 1, cols: [5, 6, 7], before: ['', '', ''], after: [row[4], row[5], row[6]] }]
      });
      return;
    }
    throw new Error('Could not log this cash expense after 3 attempts -- someone else kept changing the "cash" sheet at the same time. Please try again.');
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

  // ---- Idempotency marker helpers for 'returnDeposit' (added 2026-08-17,
  // closing the gap flagged in every earlier bikes.html PROGRESS.md entry
  // -- see that history for why this was left open originally). Unlike
  // markReturned/earlyReturnBike/swapBike/customerIntake, this action has
  // no single customer-sheet row of its own to tag a [row, col, value]
  // marker onto -- its payload carries a DEPOSIT row/category (or, for a
  // straight cash return, no row at all), not a customer row number. So
  // rather than force an ill-fitting row-based marker, this uses a plain
  // flat sidecar: a list of clientTxnIds already processed, with no row/
  // col addressing at all. Simpler than the row-keyed markers elsewhere,
  // and correct for every one of returnDeposit's paths (with or without a
  // deposit-tracking row) since it doesn't depend on there being one. ----
  async function findExistingDepositReturnTxnMarkerFromJson(clientTxnId) {
    if (!clientTxnId) return false;
    let rows;
    try {
      ({ rows } = await fetchSheetWithMeta('depositReturn_notes'));
    } catch (e) {
      return false; // sidecar unreadable -- fail open, same convention as every other marker check in this file
    }
    return (rows || []).some(r => Array.isArray(r) && r[0] === clientTxnId);
  }
  async function markDepositReturnTxnIdFromJson(clientTxnId) {
    if (!clientTxnId) return;
    try {
      const { rows, modifiedTime } = await fetchSheetWithMeta('depositReturn_notes');
      const newRows = (rows || []).concat([[clientTxnId, new Date().toISOString()]]);
      await writeSheetJson('depositReturn_notes', newRows, modifiedTime);
    } catch (e) {
      console.warn('[bikesWrites] Could not record returnDeposit idempotency marker:', e.message);
      throw e;
    }
  }

  // ==== action:'returnDeposit' -- the Return popup's deposit section.
  // Byte-for-byte port of bikes.html's returnDepositFromJson, PLUS (as of
  // 2026-08-17) the clientTxnId idempotency guard described above. THREE
  // independent, best-effort steps (a problem in one never undoes the
  // others) -- see bikes.html's own long comment for the full "worked out
  // with Anton on 2026-07-21" design reasoning:
  //   1. Clear the matched security-deposit entry (if any).
  //   2. Log a deduction (if any) as ordinary income, routed by payment
  //      method, with a bike-split note and a "bikes" sheet bump.
  //   3. Cross-method release+payout when the deposit is being handed back
  //      via a DIFFERENT method than it was held under.
  // The guard wraps the WHOLE function (checked once up front, marked once
  // at the end after all three steps have been attempted) rather than each
  // step individually -- a replay should skip the entire action, not just
  // whichever step it happens to re-reach, since steps 2/3 depend on the
  // request's own deductionAmount/returnedVia fields, not on re-reading
  // step 1's outcome. ====
  async function returnDepositFromJson(data) {
    const clientTxnId = data && data.clientTxnId ? String(data.clientTxnId) : null;
    if (clientTxnId) {
      const alreadyDone = await findExistingDepositReturnTxnMarkerFromJson(clientTxnId);
      if (alreadyDone) {
        return { success: true, idempotentReplay: true };
      }
      // ---- Idempotency marker, hardened 28/08/2026 -- moved here, to run
      // BEFORE any of the three money-moving steps below, and turned into
      // a hard failure instead of a warning written only at the very end
      // (after everything else had already happened). See
      // contractWrites.js's customerIntakeFromJson / extendBikeRowFromJson
      // above for the full "why" (same root-cause pattern, confirmed live
      // via extendBikeRowFromJson -- Nmax white, 25/08/2026 investigation):
      // a retried request only needs this marker to not have landed YET
      // when its own guard-check runs, not to have failed outright -- and
      // writing it dead last gave every retry the entire length of this
      // function as a race window. This action moves real money out the
      // door (deposit clear + deduction income + cross-method payout), so
      // nothing below should run at all until this is confirmed durable. ----
      try {
        await markDepositReturnTxnIdFromJson(clientTxnId);
      } catch (markErr) {
        throw new Error('This deposit return could not be safely marked as done (idempotency marker failed: ' + markErr.message + '). Stopping here before anything was cleared or paid out, to avoid a duplicate on retry -- please retry carefully.');
      }
    }

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

  // ---- appendSwapUpgradeIncomeRowFromJson -- verbatim port, PLUS the same
  // optional `collector` pattern as the other money-sheet writers above, so
  // swapBikeFromJson can fold this into its one combined transaction entry. ----
  async function appendSwapUpgradeIncomeRowFromJson(bikeModel, name, amount, paidBy, collector) {
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
    const writeDescriptor = { sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] };
    if (collector) {
      collector.push(writeDescriptor);
    } else {
      await logTransactionB({
        page: 'bikes.html', action: 'appendSwapUpgradeIncomeRowFromJson', reversible: true,
        summary: 'Income ' + fmtMoneyB(row[8]) + ' — ' + description + (name ? (' from ' + name) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [writeDescriptor]
      });
    }
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

    // PARALLELIZED 24/08/2026 -- see performMarkReturned's identical
    // comment above for the full "why" (customer fetch + calendar context
    // are independent, used to be awaited sequentially).
    const [{ rows, modifiedTime }, calCtx] = await Promise.all([
      fetchSheetWithMeta('customer'),
      getCalendarSyncContext()
    ]);
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    let oldRow = newRows[idx].slice();
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
    const origSituation = oldRow[13] || '';

    // ---- 1) Close out the old row ----
    oldRow[11] = returnAmount;                          // L totalPrice
    oldRow[8] = isoDateInputToSheetValue(todayIsoYmd);   // I returnDate
    oldRow[13] = 'Returned';                             // N situation

    // ---- Calendar sync -- old row (added 22/08/2026, Anton: "I swapped in
    // [a new bike] for [the old one] and [the old bike] is still sitting in
    // the calendar" -- same root cause as performMarkReturned/
    // earlyReturnBikeFromJson above: a swap closes out the old row
    // (situation -> Returned) but never told the calendar about it, so the
    // old bike's 🛵 due-back event just sat there unchanged. Same hook, same
    // place (before the single customer-sheet write below) as
    // closeBikeForExtendFromJson uses for the long-extension pair this
    // mirrors -- computeDueBackEventPlan deletes the event once it sees
    // situation=Returned.
    //
    // calSyncWarningOld/calSyncWarningNew added 23/08/2026 -- see
    // performMarkReturned's identical comment for the full "why":
    // syncDueBackEventForCustomerRow never actually threw here, so a real
    // Calendar API failure on either half of a swap was invisible outside
    // Vercel's own logs. warnings[] isn't declared until after both calendar
    // calls below, so these are stashed and folded in once it is. ----
    let calSyncWarningOld = null;
    let calSyncWarningNew = null;
    if (calCtx && calCtx.error) {
      calSyncWarningOld = 'Calendar due-back event (old bike): ' + calCtx.error;
    } else if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedOldRow, error: calErrMsg } = await syncDueBackEventForCustomerRow(calCtx.calendar, oldRow, calCtx.contractLookup);
        oldRow = syncedOldRow;
        if (calErrMsg) calSyncWarningOld = 'Calendar due-back event (old bike): ' + calErrMsg;
      } catch (calErr) {
        console.warn('[bikesWrites] swapBike calendar sync (old row) failed (non-blocking):', calErr && calErr.message);
        calSyncWarningOld = 'Calendar due-back event (old bike): ' + ((calErr && calErr.message) || 'unknown error');
      }
    }
    newRows[idx] = oldRow;

    // ---- 2) Append a brand-new row for the new bike ----
    const newRowTotalPrice = newBikeAmount + additionalAmount;
    let newRow = new Array(16).fill('');
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

    // ---- Calendar sync -- new row (added 22/08/2026) -- the new bike is a
    // brand-new active booking (same due date/time as the old row had) that
    // never got its own 🛵 due-back event created at all; this row has no
    // existingEventId yet, so computeDueBackEventPlan creates one, same as
    // customerIntakeFromJson does for its own brand-new row. ----
    if (calCtx && calCtx.error) {
      calSyncWarningNew = 'Calendar due-back event (new bike): ' + calCtx.error;
    } else if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedNewRow, error: calErrMsgNew } = await syncDueBackEventForCustomerRow(calCtx.calendar, newRow, calCtx.contractLookup);
        newRow = syncedNewRow;
        if (calErrMsgNew) calSyncWarningNew = 'Calendar due-back event (new bike): ' + calErrMsgNew;
      } catch (calErr) {
        console.warn('[bikesWrites] swapBike calendar sync (new row) failed (non-blocking):', calErr && calErr.message);
        calSyncWarningNew = 'Calendar due-back event (new bike): ' + ((calErr && calErr.message) || 'unknown error');
      }
    }
    newRows.push(newRow);
    const newRowNumber = newRows.length;

    await writeSheetJson('customer', newRows, modifiedTime);

    // ---- Idempotency marker, hardened 28/08/2026 -- this used to be
    // written concurrently with the Contract/bikes/upgrade-income writes
    // below (inside chainMarkerAndLedger, as part of the Promise.all
    // further down), on the theory that "if this fails, the write itself
    // is already safely done, so a retry would only rarely create a
    // genuine duplicate". That assumption broke in practice on this same
    // pattern elsewhere (confirmed live, Nmax white, 25/08/2026
    // investigation, via extendBikeRowFromJson): a retried request doesn't
    // need the marker write to literally fail to slip past the
    // guard-check at the top of this function, just to not have landed
    // YET when the retry's own check runs -- which a warning-only,
    // concurrent write does nothing to prevent. Moved here -- sequential,
    // awaited, BEFORE Contract/bikes/upgrade-income writes -- and hardened
    // to a hard failure: if it can't be confirmed, stop now (only the
    // customer-sheet close-out + new row above have been written) rather
    // than let a retry silently duplicate everything else. ----
    if (clientTxnId) {
      try {
        await markTxnIdFromJson(newRowNumber, clientTxnId);
      } catch (markErr) {
        throw new Error('This swap\'s customer-row changes were saved, but it could not be safely marked as done (idempotency marker failed: ' + markErr.message + '). Stopping here before the Contract/bikes/upgrade-income writes, to avoid a duplicate on retry -- please check rows ' + rowNumber + ' and ' + newRowNumber + ' and retry carefully.');
      }
    }

    // ---- Combined-transaction collector (added 22/08/2026) -- a swap used
    // to log NOTHING at all for its own core write (the old row's
    // close-out + the brand-new row it appends), and additionally logged a
    // SEPARATE entry for any upgrade income/cash/deposit -- meaning a plain
    // swap (no additional charge) had no reversible record whatsoever, and
    // an upgrading swap showed up as multiple disconnected entries in
    // settings.html's Transaction History. Fixed the same way
    // extendBikeRowFromJson/customerIntakeFromJson below now are: collect
    // every sheet write this action makes into one array and log ONE
    // combined, fully reversible transactionLog entry at the end covering
    // the old row, the new row, and (if any) the upgrade income/cash/
    // deposit writes -- settings.html's executeReversal() already replays
    // every item in a `writes[]` array, so no reverse-side change needed. ----
    const swapCollector = [
      { sheet: 'customer', row: rowNumber, cols: [9, 12, 14], before: [origReturnDateRaw, oldTotalPrice, origSituation], after: [oldRow[8], oldRow[11], oldRow[13]] },
      { sheet: 'customer', row: newRowNumber, cols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], before: new Array(16).fill(''), after: newRow.slice() }
    ];

    const warnings = [];
    if (calSyncWarningOld) warnings.push(calSyncWarningOld);
    if (calSyncWarningNew) warnings.push(calSyncWarningNew);

    const origReturnDateForDiff = decodeSheetDate(origReturnDateRaw) || parseDmyOrIsoToDateSwapB(origReturnDateRaw);
    const origReturnDmy = origReturnDateForDiff ? formatDmyJson(origReturnDateForDiff) : (origReturnDateRaw || '').toString().trim();
    const startDateForMonth = decodeSheetDate(origRentFromRaw) || parseDmyOrIsoToDateSwapB(origRentFromRaw);
    const origMonthName = startDateForMonth ? DEPOSITS_MONTH_NAMES[startDateForMonth.getMonth()] : null;
    const currentMonthName = DEPOSITS_MONTH_NAMES[new Date().getMonth()];

    // PARALLELIZED 20/08/2026 -- same treatment, same reasoning, as
    // contractWrites.js's customerIntakeFromJson (see that function's own
    // "PARALLELIZED 20/08/2026" comment for the full writeup this one
    // follows). Below runs the four steps that used to be one long
    // sequential list as CONCURRENT chains, each internally sequential
    // where it must be. Mapped out by file before writing this, same as
    // that fix:
    //   - chain A (marker + ledger): customer_notes, then customer again
    //   - chain B (Contract sync): 'Contract' only, but STRICT internal
    //     order -- renameContractBikeOnSwapFromJson matches the existing
    //     row by oldBikeModel and flips its bike field to newBikeModel;
    //     syncContractReturnDateOnlyFromJson and addAmountToContractRowFromJson
    //     BOTH match by newBikeModel, so they only find that row at all if
    //     the rename has already landed -- a real data dependency, not
    //     just a same-file one, so this trio stays sequential exactly as
    //     originally ordered
    //   - chain C (bikes sheet): 'bikes' only, 2-3 sequential writes (same
    //     file, no cross-write data dependency, just avoiding a same-file
    //     race)
    //   - chain D (upgrade income): the current month's income sheet, then
    //     (cash OR wise/revolut) cash/deposit -- only runs when
    //     additionalAmount > 0
    // No two chains share a file, so no ConflictError risk between them.
    // logTransactionB (called from inside several of these helpers, not
    // once at the end -- this file predates the "one combined log entry"
    // redesign contractWrites.js's customerIntakeFromJson got, see this
    // file's own header comment -- unchanged here, not this fix's job to
    // touch) already retries 3x on its own ConflictError internally
    // (see its definition above), specifically because it can be called
    // from more than one place -- safe under this new concurrency too.
    async function chainMarkerAndLedger() {
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
    }

    async function chainContractSync() {
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
    }

    async function chainBikesSheet() {
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
    }

    async function chainUpgradeIncome() {
      if (additionalAmount > 0) {
        try {
          const upgradeDescription = await appendSwapUpgradeIncomeRowFromJson(newBikeModel, name, additionalAmount, additionalPaidBy, swapCollector);
          const additionalPaidByLower = additionalPaidBy.toLowerCase();
          try {
            if (additionalPaidByLower === 'cash') {
              await appendCashSheetRowFromJson(upgradeDescription, additionalAmount, swapCollector);
            }
          } catch (upgradeCashErr) { warnings.push('Upgrade cash sheet: ' + upgradeCashErr.message); }
          try {
            if (additionalPaidByLower === 'wise' || additionalPaidByLower === 'revolut') {
              await processDepositForPaymentFromJson(additionalPaidByLower, additionalAmount, swapCollector);
            }
          } catch (upgradeDepositErr) { warnings.push('Upgrade deposit total: ' + upgradeDepositErr.message); }
        } catch (upgradeIncomeErr) { warnings.push('Upgrade income entry: ' + upgradeIncomeErr.message); }
      }
    }

    await Promise.all([chainMarkerAndLedger(), chainContractSync(), chainBikesSheet(), chainUpgradeIncome()]);

    // ---- One combined, reversible entry for the whole swap -- see
    // swapCollector's own comment above for why this replaced "log
    // nothing for the core swap, then log the upgrade separately". ----
    try {
      await logTransactionB({
        page: 'bikes.html', action: 'swapBikeFromJson', reversible: true,
        summary: (oldBikeModel || '(unknown bike)') + ' swapped to ' + newBikeModel + (name ? (' — ' + name) : '') +
          (additionalAmount > 0 ? (' (+ ' + fmtMoneyB(additionalAmount) + ' upgrade)') : ''),
        writes: swapCollector
      });
    } catch (logErr) { warnings.push('Transaction log: ' + logErr.message + ' -- the swap itself succeeded, but it will NOT be reversible from settings.html.'); }

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
  // ---- `collector`: same optional-array pattern as appendCashSheetRowFromJson/
  // processDepositForPaymentFromJson above -- when a caller passes an array,
  // this pushes its write descriptor onto it instead of logging its own
  // separate transactionLog entry, so a caller that touches several sheets
  // in one logical action (extend, swap, new intake) can combine them all
  // into ONE reversible entry instead of several. Omitted => unchanged
  // standalone-log behavior. ----
  async function appendMonthlyIncomeRowFromJson(data, dayCount, collector) {
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
    const writeDescriptor = { sheet: monthName, year: year, row: targetIdx + 1, cols: [6, 7, 8, 9, 10], before: ['', '', '', '', ''], after: [row[5], row[6], row[7], row[8], row[9]] };
    if (collector) {
      collector.push(writeDescriptor);
    } else {
      await logTransactionB({
        page: 'bikes.html', action: 'appendMonthlyIncomeRowFromJson', reversible: true,
        summary: 'Income ' + fmtMoneyB(amountValue) + ' — ' + (incomeText || '(no description)') + (data.name ? (' from ' + data.name) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [writeDescriptor]
      });
    }
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

    // PARALLELIZED 25/08/2026 -- same treatment as performMarkReturned/
    // earlyReturnBikeFromJson/customerIntakeFromJson above: the customer-
    // sheet fetch and getCalendarSyncContext() are independent of each
    // other, so run them together instead of one after another.
    const [{ rows, modifiedTime }, calCtx] = await Promise.all([
      fetchSheetWithMeta('customer'),
      getCalendarSyncContext()
    ]);
    const idx = rowNumber - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rowNumber + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    let row = newRows[idx].slice();
    while (row.length < 22) row.push('');

    let currentDate = decodeSheetDate(row[8]);
    if (!currentDate) {
      const m = String(row[8] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!m) throw new Error('Could not read the current return date to extend from.');
      currentDate = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    }
    const preExtendDueDate = new Date(currentDate.getTime());
    currentDate = new Date(currentDate.getTime());
    currentDate.setDate(currentDate.getDate() + daysToExtend);

    const origReturnDateRaw = row[8];
    const origTimeConfirmed = row[17];
    const origConfirmedReturnDate = row[18];
    const origPaidBy = row[12];
    const origCalEventId = row[16];
    const newDueIso = currentDate.getFullYear() + '-' + pad2Json(currentDate.getMonth() + 1) + '-' + pad2Json(currentDate.getDate());
    row[8] = isoDateInputToSheetValue(newDueIso); // I returnDate
    row[17] = false;                               // R timeConfirmed -- due date moved, so any prior pickup confirmation no longer applies
    row[18] = '';                                  // S confirmedReturnDate
    const currentPrice = Number(row[11]) || 0;
    row[11] = currentPrice + amountPaid;            // L totalPrice
    row[12] = paidBy;                               // M paidBy
    const bikeModel = row[5], custName = row[2];

    // ---- Calendar sync (added 25/08/2026, Anton: "I extended Nmax white...
    // it's not updating the calendar" -- unlike markReturned/earlyReturnBike/
    // closeBikeForExtend/customerIntake, this short-extend path (pushing the
    // due date on the SAME row, as opposed to the long-extension flow which
    // closes the row out and opens a new one) never called calendar sync at
    // all -- see this function's own end-of-section comment, which candidly
    // flagged this as "deliberately not ported" when the port was first
    // written and never got picked back up. Same hook, same place in the
    // sequence (before the write) as every other action on this page --
    // computeDueBackEventPlan sees the new due date above and moves the 🛵
    // event to match (or creates one if this row never had one). ----
    let calSyncWarning = null;
    if (calCtx && calCtx.error) {
      calSyncWarning = 'Calendar due-back event: ' + calCtx.error;
    } else if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedRow, error: calErrMsg } = await syncDueBackEventForCustomerRow(calCtx.calendar, row, calCtx.contractLookup);
        row = syncedRow;
        if (calErrMsg) calSyncWarning = 'Calendar due-back event: ' + calErrMsg;
      } catch (calErr) {
        console.warn('[bikesWrites] extendBikeRow calendar sync failed (non-blocking):', calErr && calErr.message);
        calSyncWarning = 'Calendar due-back event: ' + ((calErr && calErr.message) || 'unknown error');
      }
    }
    newRows[idx] = row;

    await writeSheetJson('customer', newRows, modifiedTime);

    // ---- Idempotency marker, hardened 28/08/2026 -- confirmed live as the
    // root cause of Nmax white's Aug bikes-sheet total being 4x its real
    // income (25/08/2026 investigation): this used to be written
    // concurrently with the ledger/Contract/bikes/income writes below
    // (inside chainMarkerAndLedger, as part of the Promise.all further
    // down), wrapped in a try/catch that only pushed a warning on failure.
    // That let a retried extend slip past the guard-check at the top of
    // this function before this attempt's own marker had actually landed,
    // re-running the whole write set -- bikes-sheet increments (low
    // contention, so they just kept succeeding on every retry) landing 4x
    // while the income-sheet row (heavily contended) only stuck once.
    // Moved here -- sequential, awaited, BEFORE any ledger/Contract/bikes/
    // income writes -- and turned into a hard failure instead of a
    // warning: if this can't be confirmed, stop now (only the customer
    // row's date/price update above has been written) rather than risk a
    // retry silently duplicating the bikes/income writes again. ----
    if (clientTxnId) {
      try {
        await markTxnIdFromJson(rowNumber, clientTxnId);
      } catch (markErr) {
        throw new Error('This extension\'s customer-row update was saved, but it could not be safely marked as done (idempotency marker failed: ' + markErr.message + '). Stopping here before the bikes/income writes, to avoid a duplicate on retry -- please check row ' + rowNumber + ' and retry carefully.');
      }
    }

    // ---- Combined-transaction collector (added 22/08/2026) -- same fix as
    // customerIntakeFromJson/swapBikeFromJson above: this core row mutation
    // used to log NOTHING at all, while chainIncome's own calls each logged
    // a separate entry -- fold everything into one combined, reversible
    // entry instead. Column 17 (calendarEventId) added 25/08/2026 alongside
    // the calendar sync fix above, so reversing an extend also restores the
    // row's old event-id pointer, not just the visible fields. ----
    const extendCollector = [
      { sheet: 'customer', row: rowNumber, cols: [9, 18, 19, 12, 13, 17], before: [origReturnDateRaw, origTimeConfirmed, origConfirmedReturnDate, currentPrice, origPaidBy, origCalEventId], after: [row[8], row[17], row[18], row[11], row[12], row[16]] }
    ];

    const warnings = [];
    if (calSyncWarning) warnings.push(calSyncWarning);
    const incomeData = { bikeModel: bikeModel || '', name: custName || '', totalPrice: amountPaid, paidBy, source: 'extend' };
    const depositCategoryLower = (data.depositCategory || '').toString().trim().toLowerCase();
    // depositRowNumber (added 25/08/2026): bikes.html's extend popup has
    // staff pick the exact deposit row for Wise/Revolut/bank from a
    // dropdown (populateExtendDepositSelect) and was already sending it as
    // data.depositRow -- see drawDownDepositLogEntryFromJson's own comment
    // below for why this is trusted as the pick and how it gets used.
    const depositRowNumberRaw = Math.round(Number(data.depositRow));
    const depositRowNumber = (data.depositRow !== '' && data.depositRow !== null && data.depositRow !== undefined && !isNaN(depositRowNumberRaw) && depositRowNumberRaw >= 2) ? depositRowNumberRaw : null;
    if (data.paidFromDeposit && depositCategoryLower !== 'cash' && !depositRowNumber) {
      warnings.push('This extension was marked as paid from an existing ' + (depositCategoryLower || 'deposit') + ' deposit, but no deposit row was picked -- please adjust the deposit log by hand.');
    }

    // PARALLELIZED 20/08/2026 -- same treatment as swapBikeFromJson/
    // earlyReturnBikeFromJson above (see swapBikeFromJson's own
    // "PARALLELIZED 20/08/2026" comment for the full pattern writeup).
    // Four disjoint-file chains: marker+ledger (customer_notes/customer),
    // Contract sync (return-date then total-price, no rename involved
    // this time so no ordering dependency beyond same-file safety), bikes
    // sheet, and income/cash/deposit.
    async function chainMarkerAndLedger() {
      try {
        const extendFromDmy = formatDmyJson(preExtendDueDate);
        const extendToDmy = formatDmyJson(currentDate);
        await appendLedgerEntryFromJson(rowNumber, bikeModel, extendFromDmy, extendToDmy, daysToExtend, amountPaid, daysToExtend, amountPaid, null, null);
      } catch (ledgerErr) { warnings.push('Ledger note: ' + ledgerErr.message); }
    }

    async function chainContractSync() {
      try { await syncContractReturnDateOnlyFromJson(custName, bikeModel, currentDate); }
      catch (contractDateErr) { warnings.push('Contract return date sync: ' + contractDateErr.message); }

      try { await addAmountToContractRowFromJson(custName, bikeModel, amountPaid); }
      catch (contractAmountErr) { warnings.push('Contract total price sync: ' + contractAmountErr.message); }

      // ---- Deposit-balance draw-down (added 22/08/2026, extended to
      // Wise/Revolut/bank 25/08/2026 -- see drawDownDepositLogEntryFromJson's
      // own comment for the full "why" of the non-cash branch below) -- see
      // findRentedContractRowForDepositDeductionFromJson's own comment
      // above for the full "why" of the lookup itself. Deliberately kept in
      // THIS chain -- it's the one of the four chains here that already
      // owns the 'Contract' sheet (see this function's own "PARALLELIZED"
      // comment above); a second, concurrent Contract read-modify-write
      // from a different chain running at the same time would race this
      // one and could silently lose whichever write landed first.
      // Wise/Revolut/bank draw-down does NOT run in this chain -- see the
      // sequential step after this function's Promise.all for why (it
      // writes to the current month sheet, which chainIncome below ALSO
      // writes to concurrently with this chain -- a same-file race).
      if (data.paidFromDeposit && depositCategoryLower === 'cash') {
        try {
          const match = await findRentedContractRowForDepositDeductionFromJson(custName, bikeModel);
          if (match && (match.deposit || '').toString().trim().toLowerCase() === 'cash' && !isNaN(Number(match.depositAmount))) {
            await applyDepositDeductionToContractFromJson(
              match.rowNumber, Number(match.depositAmount), amountPaid,
              'Extend ' + daysToExtend + (daysToExtend === 1 ? ' day' : ' days'), 'Cash', extendCollector);
          } else {
            warnings.push('Could not find a matching cash security deposit on the Contract sheet for ' + (custName || 'this customer') + ' -- the deposit balance was NOT reduced; please adjust it by hand.');
          }
        } catch (depDeductErr) { warnings.push('Deposit balance: ' + depDeductErr.message); }
      }
    }

    async function chainIncome() {
      try { await appendMonthlyIncomeRowFromJson(incomeData, daysToExtend, extendCollector); }
      catch (incomeErr) { warnings.push('Income sheet: ' + incomeErr.message); }

      try {
        if (paidBy.toLowerCase() === 'cash') {
          await appendCashSheetRowFromJson(buildRentalIncomeTextB(incomeData, daysToExtend), amountPaid, extendCollector);
        }
      } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }

      try {
        const paidByLower = paidBy.toLowerCase();
        if (paidByLower === 'wise' || paidByLower === 'revolut') {
          await processDepositForPaymentFromJson(paidByLower, amountPaid, extendCollector);
        }
      } catch (depositErr) { warnings.push('Deposit total: ' + depositErr.message); }
    }

    async function chainBikesSheet() {
      try { await addRentalAmountToBikesSheetFromJson(bikeModel, amountPaid); }
      catch (bikesErr) { warnings.push(bikesErr.message); }
    }

    await Promise.all([chainMarkerAndLedger(), chainContractSync(), chainIncome(), chainBikesSheet()]);

    // ---- Wise/Revolut/bank draw-down (added 25/08/2026, RACE FIX same
    // day) -- Anton hit this live within hours of shipping: extended a
    // booking from an existing Wise deposit, the extension charge itself
    // logged fine, but the deposit's own balance never moved AND no
    // warning appeared. Root cause: this step writes to the current month
    // sheet (the deposit-log row), and it used to run inside
    // chainContractSync above, which chainIncome ALSO runs concurrently
    // with (Promise.all just above) -- and chainIncome writes to that
    // SAME month sheet (income row, then the wise/revolut running total).
    // writeSheetJson's optimistic-concurrency check is check-then-write,
    // not atomic (see googleDrive.js's writeJsonFile) -- two concurrent
    // writers can BOTH pass the "has this file changed" check before
    // either one's write actually lands, so whichever write hits Drive
    // last silently overwrites the other's change with no ConflictError
    // and nothing to warn about. Moved here, strictly AFTER the Promise.all
    // above, so chainIncome has already finished every write of its own to
    // the month sheet by the time this runs -- nothing else touches it
    // concurrently anymore, so this is now safe. Small latency cost (this
    // step no longer overlaps the other chains) in exchange for actually
    // working -- same trade this codebase already makes elsewhere for
    // correctness over raw parallelism. ----
    if (data.paidFromDeposit && depositCategoryLower !== 'cash') {
      if (depositRowNumber) {
        try {
          const match = await findRentedContractRowForDepositDeductionFromJson(custName, bikeModel);
          const matchDepositLower = match ? (match.deposit || '').toString().trim().toLowerCase() : '';
          const matchCategoryKey = matchDepositLower === 'scan' ? 'bank' : matchDepositLower;
          if (match && matchCategoryKey === depositCategoryLower) {
            const reasonText = 'Extend ' + daysToExtend + (daysToExtend === 1 ? ' day' : ' days');
            const methodLabel = DEPOSIT_CATEGORY_PAID_BY_B[depositCategoryLower] || depositCategoryLower;
            const drawResult = await drawDownDepositLogEntryFromJson(
              depositCategoryLower, depositRowNumber, amountPaid, match.rowNumber, reasonText, methodLabel, extendCollector);
            if (drawResult && drawResult.warning) warnings.push(drawResult.warning);
            if (!isNaN(Number(match.depositAmount))) {
              await applyDepositDeductionToContractFromJson(
                match.rowNumber, Number(match.depositAmount), amountPaid, reasonText, methodLabel, extendCollector);
            }
          } else {
            warnings.push('Could not confirm a matching ' + (depositCategoryLower || 'deposit') + ' security deposit on the Contract sheet for ' + (custName || 'this customer') + ' -- the deposit balance was NOT reduced; please adjust it by hand.');
          }
        } catch (depDeductErr) { warnings.push('Deposit balance: ' + depDeductErr.message); }
      }
      // (depositRowNumber missing already warned about at the top of this
      // function, before any writes happened.)
    }

    try {
      await logTransactionB({
        page: 'bikes.html', action: 'extendBikeRowFromJson', reversible: true,
        summary: (bikeModel || '(unknown bike)') + ' extend ' + daysToExtend + (daysToExtend === 1 ? ' day' : ' days') + (custName ? (' — ' + custName) : ''),
        writes: extendCollector
      });
    } catch (logErr) { warnings.push('Transaction log: ' + logErr.message + ' -- this extension succeeded, but it will NOT be reversible from settings.html.'); }

    const responsePayload = { success: true };
    if (warnings.length) responsePayload.warning = warnings.join(' ');
    return responsePayload;
  }
  // ================== end extendBike (short extension) ==================

  // ================== long extension (closeBikeForExtend + customerIntake) ==================
  // A long extension (the "Extend 1 month" checkbox, or 30+ days typed in)
  // doesn't push the due date on the existing row the way a short
  // extension does -- it closes that booking out (using its current due
  // date, UNCHANGED, as the point it ended) and starts a brand-new
  // customer row for the extension period instead, carrying the ledger
  // note forward via previousRowNumber. bikes.html's own confirmExtend()
  // fires these as TWO SEPARATE sequential requests (closeBikeForExtend
  // first, then a plain customer-intake call once that succeeds) -- not
  // one atomic action -- so this port keeps that same shape as two
  // separate dispatch actions rather than inventing a combined wrapper
  // action bikes.html itself doesn't have. That resolves the "clientTxnId
  // across two sequential dependent writes" question flagged in earlier
  // PROGRESS.md entries more simply than expected: each of the two
  // actions gets its OWN independent idempotency treatment, exactly like
  // every other action on this page, rather than needing something new.
  //
  // customerIntakeFromJson below is a duplicate of customers.html's own
  // function of the same name (per this project's per-file convention --
  // no shared JS across pages), substituting this file's own
  // already-existing equivalents for a few small helpers.
  //
  // STALE NOTE, corrected 25/08/2026 -- this used to say calendar sync and
  // "paid from an existing deposit" were both deliberately not ported for
  // the long-extension flow. That's no longer true and hadn't been for a
  // while: calendar sync for BOTH halves (closeBikeForExtendFromJson's
  // close-out above, and customerIntakeFromJson's new row below) was added
  // 18/08/2026, and "paid from an existing deposit" was ported 22-25/08/2026
  // (see drawDownDepositLogEntryFromJson's own comment). Left this comment
  // here, corrected instead of deleted, because trusting it stale is
  // exactly how extendBikeRowFromJson's OWN calendar sync (the short,
  // same-row extend path just above this section) ended up missing for so
  // long without anyone noticing the gap in code review -- it never got its
  // own version of this note updated either. If you're reading this while
  // chasing a "calendar isn't syncing" report, verify the actual function in
  // question calls getCalendarSyncContext()/syncDueBackEventForCustomerRow
  // directly rather than trusting any comment (including this one) about
  // what "should" be wired up.

  function stripBikeNameBracketsB3(s) {
    return (s || '').toString().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---- action:'closeBikeForExtend' -- flips situation to "Returned" only.
  // Deliberately does NOT change the return date's value (unlike a normal
  // return) -- that date stays exactly where it was, since it's the point
  // this booking's original commitment ended; the extension period is a
  // whole new row. No clientTxnId guard: this write is naturally
  // idempotent -- it unconditionally sets situation to 'Returned'
  // regardless of the row's current value, so a retry converges to the
  // same end state rather than double-applying anything (same reasoning
  // as updateReturnPickup).
  //
  // groupId (added 22/08/2026): optional, passed through from bikes.html's
  // confirmExtend() -- the SAME id used as customerIntakeFromJson's own
  // clientTxnId for the matching intake half of this same long extension.
  // Tags this entry's transaction-log row so settings.html's Reverse
  // action can find and undo BOTH halves together (see that file's
  // executeReversal). Before this, the two entries were only individually
  // reversible -- Anton hit this live (22/08/2026): reversing just the
  // customerIntake entry left the old row stuck on "Returned" with no
  // active row for the bike at all ("it's no longer rented").
  //
  // No-op guard (added 22/08/2026): bikes.html retries this request up to
  // 3x on a transient Drive write-conflict (bkDispatchWithRetry) -- since
  // this write is idempotent in OUTCOME but wasn't idempotent in LOGGING,
  // a retry that landed after an earlier attempt had already succeeded
  // used to log a second (and sometimes third) "Closed out row..." entry
  // whose `before` value was already 'Returned' -- reversing one of THOSE
  // would wrongly flip an active row back to 'Returned'. Detecting the
  // no-op case up front and skipping the write+log entirely closes that
  // hole at the source instead of leaving duplicate traps in the log. ----
  async function closeBikeForExtendFromJson(rowNumber, groupId) {
    const rn = parseInt(rowNumber, 10);
    if (!rn || rn < 2) throw new Error('Invalid row number.');
    const { rows, modifiedTime } = await fetchSheetWithMeta('customer');
    const idx = rn - 1;
    if (!rows[idx]) throw new Error('Could not find row ' + rn + ' on the customer sheet -- it may have moved. Please reload and try again.');
    const newRows = rows.map(r => r.slice());
    let row = newRows[idx].slice();
    while (row.length < 14) row.push('');
    const origSituation = row[13] || '';
    if (origSituation === 'Returned') {
      // Already closed out by an earlier attempt (this is a retry after a
      // transient conflict, not a fresh close-out) -- nothing to change,
      // so skip the write and the log entry rather than create a
      // dangerous no-op "reverse -> Returned" trap.
      return { success: true, alreadyClosed: true };
    }
    row[13] = 'Returned'; // N situation
    // ---- Calendar sync (added 18/08/2026) -- removes this row's 🛵
    // due-back event now that it's closed out (extension continues on a
    // brand-new row instead -- see customerIntakeFromJson below in this same
    // file). Folded into the same write as the situation flip, same reason
    // lib/customersWrites.js's own hook does this before its write.
    const calCtx = await getCalendarSyncContext();
    if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const { row: syncedRow } = await syncDueBackEventForCustomerRow(calCtx.calendar, row, calCtx.contractLookup);
        row = syncedRow;
      } catch (calErr) {
        console.warn('[bikesWrites] closeBikeForExtend calendar sync failed (non-blocking):', calErr && calErr.message);
      }
    }
    newRows[idx] = row;
    await writeSheetJson('customer', newRows, modifiedTime);
    // ---- Log added 22/08/2026 -- this write used to be completely
    // unreversible (no logTransactionB call at all), so closing out a row
    // for a long extension could never be undone from settings.html even
    // once the matching customerIntakeFromJson entry was fixed. This IS
    // still a separate entry from that one (they're two independent HTTP
    // requests -- see this section's header comment on why bikes.html's
    // own confirmExtend() fires them sequentially rather than as one
    // atomic action), but each is now individually reversible -- AND (also
    // 22/08/2026) tagged with the shared groupId so settings.html reverses
    // both halves together instead of just this one. ----
    try {
      await logTransactionB({
        page: 'bikes.html', action: 'closeBikeForExtendFromJson', reversible: true,
        summary: 'Closed out row ' + rn + ' for a long extension (situation -> Returned)',
        groupId: groupId || undefined,
        writes: [{ sheet: 'customer', row: rn, cols: [14], before: [origSituation], after: ['Returned'] }]
      });
    } catch (logErr) {
      console.warn('[bikesWrites] closeBikeForExtend transaction log failed (non-blocking):', logErr && logErr.message);
    }
    return { success: true };
  }

  // ---- Used just before syncContractRowTotalsFromJson, to apply the
  // "never shrink the Contract row's total price" failsafe. ----
  async function findRentedContractRowForBackfillFromJson(name, bikeModel) {
    const { rows } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return null;
    const nameTarget = normalizeNameForContractMatch(name);
    const bikeTarget = (bikeModel || '').toString().trim();
    if (!nameTarget) return null;
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
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

  // ---- Syncs the matching "Rented" Contract row's return date (column I)
  // and/or total price (column L) -- either can be omitted (pass
  // null/undefined for totalAmount to leave it alone). DELIBERATELY
  // separate from addAmountToContractRowFromJson (which ADDS onto the
  // existing total, used by extendBike/swapBike) -- this one OVERWRITES
  // the total with whatever the caller computed, same as customer-intake's
  // own ledger-total sync, since a long extension's new row is itself a
  // fresh intake, not an incremental add. ----
  async function syncContractRowTotalsFromJson(name, bikeModel, returnDateIso, totalAmount) {
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
      while (row.length < 17) row.push('');
      if (returnDateIso) row[8] = isoDateInputToSheetValue(returnDateIso);
      if (totalAmount !== null && totalAmount !== undefined) row[11] = totalAmount;
      newRows[i] = row;
      await writeSheetJson('Contract', newRows, modifiedTime);
      return { found: true, row: i + 1 };
    }
    return { found: false };
  }

  // ---- Deposit-balance draw-down for "paid from an existing deposit" on
  // an extension (added 22/08/2026, Anton: the Extend flow's "paid from
  // cash deposit" checkbox was already charging the extension as a normal
  // transaction -- income row, cash sheet, the works -- that part worked
  // fine; the ONE missing piece was that it never actually reduced the
  // customer's deposit balance on their own Contract row, so the deposit
  // just sat at its original amount until staff caught the warning below
  // and fixed it by hand). Same Contract-row lookup/deduction
  // depositsWrites.js's own findRentedContractRowForDeductionFromJson /
  // applyDepositDeductionToContractFromJson use for deposits.html's
  // standalone "Deduct from cash deposit" tool, ported here (own copy,
  // project convention) so extendBikeRowFromJson/customerIntakeFromJson can
  // call it as one more step of an extension instead. Only wired up for the
  // 'cash' deposit category so far -- a bank/wise/revolut security deposit
  // lives in a completely different tracking table (the monthly sheet's
  // deposit log -- see DEPOSIT_CATEGORIES_B / logSecurityDepositFromJson
  // just below), and whether drawing THAT down should also skip the normal
  // cash/deposit-total lanes is a real open question (accounts.html's own
  // addIncomeRowFromJson doesn't skip them either) -- left as the same "not
  // ported yet" warning until that's resolved with Anton. ----
  async function findRentedContractRowForDepositDeductionFromJson(name, bikeModel) {
    const { rows } = await fetchSheetWithMeta('Contract');
    if (!rows || rows.length < 2) return null;
    const nameTarget = normalizeNameForContractMatch(name);
    if (!nameTarget) return null;
    const bikeTarget = (bikeModel || '').toString().trim();
    for (let i = rows.length - 1; i >= HEADER_ROWS_B; i--) {
      const row = rows[i];
      if (!row) continue;
      const rowStatus = (row[16] || '').toString().trim().toLowerCase();
      if (rowStatus !== 'rented') continue;
      const rowName = normalizeNameForContractMatch(row[3]);
      if (rowName !== nameTarget) continue;
      const rowBike = (row[6] || '').toString().trim();
      if (bikeTarget && rowBike && !bikeNamesMatchForTaxLookup(rowBike, bikeTarget)) continue;
      return { rowNumber: i + 1, deposit: row[13], depositAmount: row[14] };
    }
    return null;
  }

  // ---- Deducts `deductedAmount` from a Contract row's own deposit-amount
  // cell (column O, index 14) and appends a dated audit line to
  // Contract_notes column 15 -- verbatim logic port of depositsWrites.js's
  // applyDepositDeductionToContractFromJson, PLUS the optional `collector`
  // pattern used throughout this file (see appendCashSheetRowFromJson's own
  // comment) so this folds into the extension's one combined, reversible
  // transaction-log entry instead of going unlogged (the deposits.html
  // original never logs this at all -- fine there as a standalone tool, not
  // worth repeating here now that this runs as part of a bigger action that
  // already IS reversible). Only the deposit-amount CELL is captured for
  // reversal -- the Contract_notes append is a free-text audit trail, same
  // as every other ledger-note write in this file (see
  // appendLedgerEntryFromJson), not itself part of any write descriptor. ----
  async function applyDepositDeductionToContractFromJson(contractRowNumber, currentAmount, deductedAmount, reasonText, methodLabel, collector) {
    const { rows, modifiedTime } = await fetchSheetWithMeta('Contract');
    const idx = contractRowNumber - 1;
    if (!rows[idx]) throw new Error('Contract row ' + contractRowNumber + ' not found -- the Contract deposit amount was NOT updated.');
    const before = rows[idx][14];
    const newAmount = currentAmount - deductedAmount;
    const newRows = rows.map(r => r.slice());
    const row = newRows[idx].slice();
    while (row.length < 15) row.push('');
    row[14] = newAmount;
    newRows[idx] = row;
    await writeSheetJson('Contract', newRows, modifiedTime);

    const writeDescriptor = { sheet: 'Contract', row: contractRowNumber, cols: [15], before: [before], after: [newAmount] };
    if (collector) collector.push(writeDescriptor);

    try {
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
    } catch (noteErr) {
      console.warn('[bikesWrites] Could not append Contract deposit-deduction note (non-blocking):', noteErr.message);
    }

    return newAmount;
  }

  // ---- Deposit-balance draw-down for Wise/Revolut/bank ("Scan") deposits
  // on an extension (added 25/08/2026 -- item 3 of Anton's 24/08/2026
  // deposit-tracking plan; see applyDepositDeductionToContractFromJson just
  // above for the original cash-only version this completes). Unlike cash,
  // a Wise/Revolut/bank deposit isn't just a cell on the Contract row -- it
  // ALSO lives as its own row in the current month's deposit-log table
  // (DEPOSIT_CATEGORIES_B), and THAT row is the one staff actually look at
  // on deposits.html/accounts.html, so it's the one that has to be reduced.
  //
  // Which row: bikes.html's extend popup already had staff pick the exact
  // row from a dropdown (populateExtendDepositSelect, listing every open
  // deposit in that category by name+amount) and was already sending it as
  // data.depositRow -- built and working on the frontend well before this,
  // just never read server-side (extendBikeRowFromJson/customerIntakeFromJson
  // ignored it and always showed the "not ported yet" warning instead).
  // Trusted here as the primary source of truth, same precedent as
  // deposits.html's own deductDepositEntryFromJson/consumeDepositFromJson
  // and the Return flow's 'returnDeposit' action -- both also take a
  // staff-picked row rather than re-deriving one.
  //
  // contractRowNumber cross-check: the dropdown lists deposits by "name --
  // amount", so two customers sharing a name (or a customer picking the
  // wrong line by accident) could pick the wrong row. Where the row already
  // carries a contractRowCol link (stamped at intake or carried forward by
  // monthRollover.js -- see logSecurityDepositFromJson's own comment), a
  // mismatch against THIS booking's own Contract row produces a warning
  // instead of silently trusting the pick -- but doesn't block it, since a
  // deposit logged before this link existed has nothing to check against.
  //
  // Mirrors the reduction onto the Contract row's own deposit-amount cell
  // too, via applyDepositDeductionToContractFromJson above -- already
  // method-agnostic (just writes column 14), same as the cash path takes.
  async function drawDownDepositLogEntryFromJson(categoryKey, depositRowNumber, deductAmount, contractRowNumber, reasonText, methodLabel, collector) {
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === (categoryKey === 'scan' ? 'bank' : categoryKey));
    if (!cat) throw new Error('Unrecognized deposit category "' + categoryKey + '".');

    const now = new Date();
    const monthName = DEPOSITS_MONTH_NAMES[now.getMonth()];
    const year = now.getFullYear();
    const { rows, modifiedTime } = await fetchSheetWithMeta(monthName, year);
    if (!rows || !rows.length) throw new Error('No sheet found for the current month -- the deposit was NOT reduced.');

    const idx = depositRowNumber - 1;
    const row = rows[idx] || [];
    const norm = s => (s || '').toString().trim().toLowerCase();
    const dateVal = row[cat.dateCol - 1];
    const amtVal = row[cat.amountCol - 1];
    const nameVal = row[cat.nameCol - 1];
    const linkVal = row[cat.contractRowCol - 1];
    if (norm(dateVal) === 'total') {
      throw new Error('That row is the "' + cat.label + '" totals row, not a deposit -- the deposit was NOT reduced.');
    }
    const rowEmpty = (dateVal === '' || dateVal === null || dateVal === undefined) &&
      (amtVal === '' || amtVal === null || amtVal === undefined) &&
      (nameVal === '' || nameVal === null || nameVal === undefined);
    if (rowEmpty) {
      throw new Error('That ' + cat.label + ' deposit no longer exists (it may have already been used) -- please refresh and pick again.');
    }

    let linkWarning = null;
    if (linkVal !== '' && linkVal !== null && linkVal !== undefined && contractRowNumber && Number(linkVal) !== Number(contractRowNumber)) {
      linkWarning = 'The picked ' + cat.label + ' deposit row looks linked to a different booking (Contract row ' + linkVal + ', not ' + contractRowNumber + ') -- please double check this was the right customer\'s deposit.';
    }

    const currentAmount = (amtVal === '' || amtVal === null || amtVal === undefined || isNaN(Number(amtVal))) ? 0 : Number(amtVal);
    const EPSILON = 0.005;
    const remaining = currentAmount - deductAmount;
    if (remaining < -EPSILON) {
      throw new Error('This extension (' + deductAmount.toFixed(2) + ') is more than what\'s left in this ' + cat.label + ' deposit (' + currentAmount.toFixed(2) + ') -- the deposit was NOT reduced. Pick a different deposit or fix the amount.');
    }

    const newRows = rows.map(r => r.slice());
    const newRow = (newRows[idx] || []).slice();
    const maxCol = Math.max(cat.dateCol, cat.amountCol, cat.nameCol, cat.contractRowCol);
    while (newRow.length < maxCol) newRow.push('');
    if (remaining <= EPSILON) {
      // Fully consumed -- clear it out (including the link column) exactly
      // like consumeDepositFromJson does, so it reads as "available" again
      // and drops out of copyDepositCategoryRows' next carry-forward.
      newRow[cat.dateCol - 1] = '';
      newRow[cat.amountCol - 1] = '';
      newRow[cat.nameCol - 1] = '';
      newRow[cat.contractRowCol - 1] = '';
    } else {
      newRow[cat.amountCol - 1] = remaining;
    }
    newRows[idx] = newRow;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();

    const writeDescriptor = {
      sheet: monthName, year: year, row: depositRowNumber,
      cols: [cat.dateCol, cat.amountCol, cat.nameCol, cat.contractRowCol],
      before: [dateVal, amtVal, nameVal, linkVal],
      after: [newRow[cat.dateCol - 1], newRow[cat.amountCol - 1], newRow[cat.nameCol - 1], newRow[cat.contractRowCol - 1]]
    };
    if (collector) collector.push(writeDescriptor);

    // NOTE: this deliberately does NOT also mirror the reduction onto the
    // Contract row's own deposit-amount cell -- the caller already has its
    // own fresh findRentedContractRowForDepositDeductionFromJson result
    // (contractRowNumber came from it) and calls
    // applyDepositDeductionToContractFromJson itself with that match's OWN
    // depositAmount, exactly the same two-step shape the cash path already
    // uses just above. Doing it here too would mean a second, separate
    // Contract.json read-modify-write racing the caller's -- worse, not
    // safer.
    return { remaining, warning: linkWarning };
  }

  // ---- Logs a fresh security deposit onto the current month's tracking
  // table (bank/wise/revolut -- Cash/Passport/unrecognized are no-ops).
  // Skipped entirely for an extend-sourced intake (see
  // customerIntakeFromJson's own `!isExtendSource` guard below) -- an
  // extension never logs a brand-new deposit.
  //
  // contractRowNumber (added 24/08/2026, optional): the matching Contract
  // row this deposit belongs to, if known -- stamped into contractRowCol
  // (see DEPOSIT_CATEGORIES_B just above) so a future feature (drawing this
  // exact deposit down automatically -- e.g. an extension paid from an
  // existing Wise/Revolut deposit, today just a "please adjust by hand"
  // warning) can find the RIGHT row by a stable link instead of matching on
  // customer name alone, which breaks down for repeat customers or anyone
  // sharing a name. Carried forward at month-end by
  // lib/monthRollover.js's copyDepositCategoryRows alongside date/amount/
  // name -- see that function's own updated comment; this MUST stay in
  // sync with that copy or a deposit that survives a month boundary loses
  // its link silently. Pass null/omit when there's no known matching
  // Contract row yet -- degrades to exactly today's behavior (name-only,
  // no link) for that one deposit, same as every deposit already on the
  // books before this change. customerIntakeFromJson below gets this from
  // flipMatchingContractStatus's own return value -- see that call site's
  // comment for why this is free (reuses a Contract.json read that already
  // has to happen, rather than a second one). ----
  async function logSecurityDepositFromJson(methodLower, rawAmount, customerName, contractRowNumber, collector) {
    const categoryKey = methodLower === 'scan' ? 'bank' : methodLower;
    const cat = DEPOSIT_CATEGORIES_B.find(c => c.key === categoryKey);
    if (!cat) return; // Cash/Passport/unrecognized -- nothing to log.

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
    row[cat.dateCol - 1] = isoDateInputToSheetValue(todayIso());
    row[cat.amountCol - 1] = (Number(rawAmount) || rawAmount || '');
    row[cat.nameCol - 1] = customerName || '';
    row[cat.contractRowCol - 1] = contractRowNumber || '';
    newRows[targetIdx] = row;
    await writeSheetJson(monthName, newRows, modifiedTime, year);
    await recomputeCurrentMonthSummaryCascadeB();
    const writeDescriptor = { sheet: monthName, year: year, row: targetIdx + 1, cols: [cat.dateCol, cat.amountCol, cat.nameCol, cat.contractRowCol], before: ['', '', '', ''], after: [row[cat.dateCol - 1], row[cat.amountCol - 1], row[cat.nameCol - 1], row[cat.contractRowCol - 1]] };
    if (collector) {
      collector.push(writeDescriptor);
    } else {
      await logTransactionB({
        page: 'bikes.html', action: 'logSecurityDepositFromJson', reversible: true,
        summary: cat.label + ' deposit ' + fmtMoneyB(row[cat.amountCol - 1]) + (customerName ? (' — ' + customerName) : '') + ' (' + monthName + ' ' + year + ')',
        writes: [writeDescriptor]
      });
    }
  }

  // ---- action:'customerIntake' -- the SAME write path a brand-new
  // booking on customers.html's Add form hits. A long extension routes
  // through here too (data.source === 'extend', data.previousRowNumber
  // set) rather than through extendBikeRow's incremental-add path, exactly
  // mirroring bikes.html's own frontend (confirmExtend() calls this
  // straight after closeBikeForExtendFromJson succeeds). PLUS a
  // clientTxnId idempotency guard using the SAME new-row-marker technique
  // swapBikeFromJson uses (this action also always creates a brand-new
  // row), since a retried intake would otherwise double-book the
  // extension. ----
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
    data.bikeModel = stripBikeNameBracketsB3(data.bikeModel);
    const isExtendSource = (data.source || '').toString().trim().toLowerCase() === 'extend';

    // PARALLELIZED 24/08/2026 -- see performMarkReturned's identical
    // comment above for the full "why". newRow below is built entirely
    // from `data`, not from custRows, so the two fetches never depended
    // on each other -- only newRows.push(newRow) further down needs both.
    const [{ rows: custRows, modifiedTime: custModifiedTime }, calCtx] = await Promise.all([
      fetchSheetWithMeta('customer'),
      getCalendarSyncContext()
    ]);
    const newRows = (custRows || []).map(r => r.slice());
    let newRow = new Array(16).fill('');
    newRow[0] = isoDateInputToSheetValue(todayIso());
    newRow[1] = data.contact || '';
    newRow[2] = name;
    newRow[3] = data.nationality || '';
    newRow[4] = data.passport || '';
    newRow[5] = data.bikeModel || '';
    newRow[6] = '';
    newRow[7] = isoDateInputToSheetValue(data.rentingDateFrom);
    newRow[8] = isoDateInputToSheetValue(data.returnDate);
    newRow[9] = hhmmToSheetTimeValue(data.returnTime);
    newRow[10] = data.deliverToHotel || '';
    newRow[11] = data.totalPrice || '';
    newRow[12] = data.paidBy || '';
    newRow[13] = '';
    newRow[14] = data.deposit || '';
    newRow[15] = isExtendSource ? 'Extend' : 'Direct';

    // ---- Calendar sync (added 18/08/2026) -- creates the 🛵 due-back event
    // for this new (post-extend) booking before the row is written -- see
    // lib/customersWrites.js's own customerIntakeFromJson for the identical
    // pattern/reasoning (this file keeps its own copy per the project's
    // no-shared-JS convention).
    if (calCtx) {
      try {
        const { syncDueBackEventForCustomerRow } = require('./googleCalendarSync');
        const paddedRow = newRow.slice();
        while (paddedRow.length < 22) paddedRow.push('');
        const { row: syncedRow } = await syncDueBackEventForCustomerRow(calCtx.calendar, paddedRow, calCtx.contractLookup);
        newRow = syncedRow;
      } catch (calErr) {
        console.warn('[bikesWrites] customerIntake calendar sync failed (non-blocking):', calErr && calErr.message);
      }
    }

    newRows.push(newRow);
    const newRowNumber = newRows.length;
    await writeSheetJson('customer', newRows, custModifiedTime);

    // ---- Idempotency marker, hardened 28/08/2026 -- see
    // extendBikeRowFromJson above for the full "why" (same fix, same
    // root-cause writeup -- confirmed live via that function, Nmax white,
    // 25/08/2026 investigation): moved here -- sequential, awaited, BEFORE
    // any ledger/money/bikes/Contract writes -- and hardened to a hard
    // failure instead of a warning-only concurrent write, so a retry can't
    // slip past the guard-check at the top of this function before this
    // attempt's own marker has actually landed. ----
    if (clientTxnId) {
      try {
        await markTxnIdFromJson(newRowNumber, clientTxnId);
      } catch (markErr) {
        throw new Error('This booking\'s customer row was saved, but it could not be safely marked as done (idempotency marker failed: ' + markErr.message + '). Stopping here before any money was recorded, to avoid a duplicate on retry -- please check the customer sheet for row ' + newRowNumber + ' and retry carefully.');
      }
    }

    // ---- Combined-transaction collector (added 22/08/2026) -- this
    // function used to log NOTHING for its own new-row append, and let
    // chainMoneySheets' calls (income/cash/deposit/security-deposit) each
    // log their OWN separate entry -- meaning a single extend or new
    // booking could show up as 2+ disconnected rows in settings.html's
    // Transaction History, each reversed independently rather than as one
    // action. Now everything this function writes lands in ONE combined,
    // reversible entry. (For a long-extension intake specifically, this is
    // still a SEPARATE entry from closeBikeForExtendFromJson's own --
    // see that function's comment for why two independent HTTP requests
    // can't share one in-memory collector.) ----
    const intakeCollector = [
      { sheet: 'customer', row: newRowNumber, cols: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], before: new Array(16).fill(''), after: newRow.slice() }
    ];

    const warnings = [];
    let dayCount = null;
    if (data.rentingDateFrom && data.returnDate) {
      const from = new Date(data.rentingDateFrom + 'T00:00:00');
      const to = new Date(data.returnDate + 'T00:00:00');
      if (!isNaN(from) && !isNaN(to)) dayCount = Math.round((to - from) / (1000 * 60 * 60 * 24));
    }

    // PARALLELIZED 20/08/2026 -- same treatment, same reasoning, as
    // lib/contractWrites.js's customerIntakeFromJson (contract.html's
    // near-identical copy of this same function, fixed first -- see that
    // function's own "PARALLELIZED 20/08/2026" comment for the full
    // file-by-file writeup this one follows). Four disjoint-file chains:
    //   - chain A (marker + ledger): customer_notes, then customer again
    //   - chain B (money sheets): the current month's sheet + cash --
    //     income/cash/deposit/security-deposit all cascade onto both, so
    //     stay sequential within this chain, same as before
    //   - chain C (bikes): 'bikes' only
    //   - chain D (contract status): 'Contract' only (the pending->Rented
    //     flip) -- does NOT need ledgerTotals, so no need to wait on chain A
    // What still runs AFTER all four settle: the contract-totals backfill/
    // sync, because it genuinely needs chain A's ledgerTotals AND chain D's
    // "Rented" flip to have already landed (findRentedContractRowForBackfillFromJson/
    // syncContractRowTotalsFromJson both filter on status === 'rented').
    let ledgerTotals = null;
    // contractStatusResult (added 24/08/2026, hoisted out here 25/08/2026 as
    // part of the race fix below): captured outside chainContractStatus so
    // the sequential deposit-log step after this function's Promise.all can
    // read it too, not just code still inside that chain.
    let contractStatusResult = null;

    async function chainMarkerAndLedger() {
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
      try { await appendMonthlyIncomeRowFromJson(data, dayCount, intakeCollector); }
      catch (incomeErr) { warnings.push('Income sheet: ' + incomeErr.message); }

      try {
        if ((data.paidBy || '').toString().trim().toLowerCase() === 'cash') {
          await appendCashSheetRowFromJson(buildRentalIncomeTextB(data, dayCount), data.totalPrice, intakeCollector);
        }
      } catch (cashErr) { warnings.push('Cash sheet: ' + cashErr.message); }

      try {
        const paidByLower = (data.paidBy || '').toString().trim().toLowerCase();
        if (paidByLower === 'wise' || paidByLower === 'revolut') {
          await processDepositForPaymentFromJson(paidByLower, data.totalPrice, intakeCollector);
        }
      } catch (depositErr) { warnings.push(depositErr.message); }
    }

    async function chainBikesSheet() {
      try { await addRentalAmountToBikesSheetFromJson(data.bikeModel, data.totalPrice); }
      catch (bikesErr) { warnings.push(bikesErr.message); }
    }

    async function chainContractStatus() {
      // contractStatusResult (hoisted to outer scope 25/08/2026 -- see the
      // sequential step after this function's Promise.all, which reads it
      // too) captured so the security-deposit-log step there can reuse the
      // Contract row number THIS call already found, instead of needing
      // its own separate Contract.json search -- see
      // logSecurityDepositFromJson's own comment on its contractRowNumber
      // parameter for the full "why".
      //
      // Only the status flip lives in THIS chain now (RACE FIX 25/08/2026):
      // it's the only step here that's actually safe to run concurrently
      // with chainMoneySheets -- it touches ONLY Contract.json, which
      // chainMoneySheets never writes to. The new-deposit-log and
      // Wise/Revolut/bank draw-down steps that used to live here ALSO write
      // to the current month sheet, which chainMoneySheets DOES write to
      // concurrently in the same Promise.all just below -- see the
      // sequential step after it for the full "why" this was unsafe and
      // what changed.
      try { contractStatusResult = await flipMatchingContractStatus(name, data.bikeModel, 'pending', 'Rented'); }
      catch (contractStatusErr) { warnings.push('Contract status update: ' + contractStatusErr.message); }

      // Cash deposit draw-down on a long extension (added 22/08/2026) --
      // kept in THIS chain: it only touches Contract.json (via
      // applyDepositDeductionToContractFromJson), same file this chain
      // already exclusively owns among the 4 concurrent chains here, so
      // it's safe. The Wise/Revolut/bank equivalent is NOT safe here --
      // see the sequential step below for why.
      if (isExtendSource && data.paidFromDeposit) {
        const depositCategoryLower = (data.depositCategory || '').toString().trim().toLowerCase();
        if (depositCategoryLower === 'cash') {
          try {
            const match = await findRentedContractRowForDepositDeductionFromJson(name, data.bikeModel);
            if (match && (match.deposit || '').toString().trim().toLowerCase() === 'cash' && !isNaN(Number(match.depositAmount))) {
              await applyDepositDeductionToContractFromJson(
                match.rowNumber, Number(match.depositAmount), Number(data.totalPrice) || 0,
                'Extend ' + (dayCount != null ? (dayCount + (dayCount === 1 ? ' day' : ' days')) : ''), 'Cash', intakeCollector);
            } else {
              warnings.push('Could not find a matching cash security deposit on the Contract sheet for ' + (name || 'this customer') + ' -- the deposit balance was NOT reduced; please adjust it by hand.');
            }
          } catch (depDeductErr) { warnings.push('Deposit balance: ' + depDeductErr.message); }
        }
      }
    }

    await Promise.all([chainMarkerAndLedger(), chainMoneySheets(), chainBikesSheet(), chainContractStatus()]);

    // ---- Month-sheet deposit writes (RACE FIX 25/08/2026) -- new deposit
    // logging and Wise/Revolut/bank draw-down both write to the CURRENT
    // MONTH SHEET, the same file chainMoneySheets above also writes to.
    // These two used to run inside chainContractStatus, concurrently with
    // chainMoneySheets (the Promise.all just above) -- and Anton hit the
    // real consequence within hours of the draw-down shipping: an
    // extension paid from an existing Wise deposit logged its charge fine,
    // but the deposit's own balance never moved, and no warning appeared
    // either. Root cause: writeSheetJson's optimistic-concurrency check is
    // check-then-write, not atomic (see googleDrive.js's writeJsonFile) --
    // two concurrent writers to the same file can BOTH pass the "has this
    // changed" check before either one's write actually lands, so whichever
    // write hits Drive last silently overwrites the other's change, with no
    // ConflictError and nothing to warn about. Moved both here, strictly
    // AFTER the Promise.all above, so chainMoneySheets has already finished
    // every write of its own to the month sheet by the time these run --
    // nothing else touches it concurrently anymore. Small latency cost
    // (these two no longer overlap the other chains) for actually being
    // correct -- same trade this codebase already makes elsewhere. ----
    try {
      const depositMethodLower = (data.deposit || '').toString().trim().toLowerCase();
      if (!isExtendSource && (depositMethodLower === 'scan' || depositMethodLower === 'wise' || depositMethodLower === 'revolut')) {
        const contractRowNumber = (contractStatusResult && contractStatusResult.found) ? contractStatusResult.row : null;
        await logSecurityDepositFromJson(depositMethodLower, data.depositAmount, name, contractRowNumber, intakeCollector);
      }
    } catch (secDepErr) { warnings.push(secDepErr.message); }

    if (isExtendSource && data.paidFromDeposit) {
      const depositCategoryLower = (data.depositCategory || '').toString().trim().toLowerCase();
      if (depositCategoryLower !== 'cash') {
        const depositRowNumberRaw = Math.round(Number(data.depositRow));
        const depositRowNumber = (data.depositRow !== '' && data.depositRow !== null && data.depositRow !== undefined && !isNaN(depositRowNumberRaw) && depositRowNumberRaw >= 2) ? depositRowNumberRaw : null;
        if (depositRowNumber) {
          try {
            const match = await findRentedContractRowForDepositDeductionFromJson(name, data.bikeModel);
            const matchDepositLower = match ? (match.deposit || '').toString().trim().toLowerCase() : '';
            const matchCategoryKey = matchDepositLower === 'scan' ? 'bank' : matchDepositLower;
            if (match && matchCategoryKey === depositCategoryLower) {
              const reasonText = 'Extend ' + (dayCount != null ? (dayCount + (dayCount === 1 ? ' day' : ' days')) : '');
              const methodLabel = DEPOSIT_CATEGORY_PAID_BY_B[depositCategoryLower] || depositCategoryLower;
              const drawResult = await drawDownDepositLogEntryFromJson(
                depositCategoryLower, depositRowNumber, Number(data.totalPrice) || 0, match.rowNumber, reasonText, methodLabel, intakeCollector);
              if (drawResult && drawResult.warning) warnings.push(drawResult.warning);
              if (!isNaN(Number(match.depositAmount))) {
                await applyDepositDeductionToContractFromJson(
                  match.rowNumber, Number(match.depositAmount), Number(data.totalPrice) || 0, reasonText, methodLabel, intakeCollector);
              }
            } else {
              warnings.push('Could not confirm a matching ' + (depositCategoryLower || 'deposit') + ' security deposit on the Contract sheet for ' + (name || 'this customer') + ' -- the deposit balance was NOT reduced; please adjust it by hand.');
            }
          } catch (depDeductErr) { warnings.push('Deposit balance: ' + depDeductErr.message); }
        } else {
          warnings.push('This extension was marked as paid from an existing ' + (depositCategoryLower || 'deposit') + ' deposit, but no deposit row was picked -- please adjust the deposit log by hand.');
        }
      }
    }

    // ---- One combined, reversible entry for everything this intake wrote
    // -- see intakeCollector's own comment above. For a long extension
    // (isExtendSource), tagged with groupId = this same request's
    // clientTxnId -- bikes.html's confirmExtend() sends that SAME id as
    // the groupId on its paired closeBikeForExtend request, so
    // settings.html's Reverse action can find and undo both halves of one
    // long extension together (added 22/08/2026, see closeBikeForExtend-
    // FromJson's own comment for the bug this fixes). ----
    try {
      const introText = isExtendSource ? ('extend ' + (dayCount != null ? (dayCount + ' days') : '')) : 'new booking';
      await logTransactionB({
        page: 'bikes.html', action: 'customerIntakeFromJson', reversible: true,
        summary: (data.bikeModel || '(unknown bike)') + ' ' + introText + (name ? (' — ' + name) : ''),
        groupId: (isExtendSource && clientTxnId) ? clientTxnId : undefined,
        writes: intakeCollector
      });
    } catch (logErr) { warnings.push('Transaction log: ' + logErr.message + ' -- this booking succeeded, but it will NOT be reversible from settings.html.'); }

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
  // ================== end long extension ==================

  // ---- Single-dispatch entry point, mirrors accountsWriteDispatch's
  // shape (see lib/accountsWrites.js / api/accounts/write.js). All 7 of
  // bikes.html's write actions are implemented now (the long-extension
  // pair is exposed as 2 actions -- closeBikeForExtend + customerIntake --
  // matching bikes.html's own frontend, which fires them as 2 separate
  // sequential requests, not 1). See file header comment and PROGRESS.md
  // for the full inventory and status. ----
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
      case 'closeBikeForExtend':
        return closeBikeForExtendFromJson(body.rowNumber, body.groupId);
      case 'customerIntake':
        return customerIntakeFromJson(body);
      default:
        throw new Error(
          'Unknown or not-yet-ported bikes.html write action: "' + (body && body.action) + '". ' +
          'Ported so far: swapBike, markReturned, earlyReturnBike, returnDeposit, updateReturnPickup, extendBike, closeBikeForExtend, customerIntake -- see PROGRESS.md\'s bikes.html write-layer entries for the full inventory and status.'
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
    closeBikeForExtendFromJson,
    customerIntakeFromJson,
    // Exposed for the fake-Drive test harness, not used by
    // api/bikes/write.js itself (which only ever calls bikesWriteDispatch).
    recomputeMonthlySummaryCascadeB,
    recomputeCashSheetTotalsB,
    findExistingTxnMarkerFromJson,
    findExistingDepositReturnTxnMarkerFromJson,
    findRentedContractRowForDepositDeductionFromJson,
    applyDepositDeductionToContractFromJson
  };
}

module.exports = { createSheetIO, createBikesWrites };
