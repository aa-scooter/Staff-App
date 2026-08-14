# AA Scooters — JSON-parity rewrite progress tracker

Last updated: 2026-08-14 (full repo-wide re-audit — see below). Keep this
file current — whenever a page's write layer gets ported/tested/pushed,
update its row below in the same commit. This exists because work on this
project gets picked up across multiple Claude sessions/accounts with no
shared memory between them — this file is the handoff.

## ✅ DONE, tested, awaiting Anton's push — Reverse Transactions UI
## (2026-08-14, phase 2 of the "reverse transactions" feature — the panel
## itself, on top of phase 1's write-logging instrumentation above)

**What Anton asked for:** a Settings-page panel showing the last 10 writes
across the app, with the ability to search further back, and click-to-
reverse with a confirmation dialog. When asked where it should live, Anton
asked for a new dedicated `settings.html` page (reached via the gear icon)
that also absorbs what used to be a small dropdown widget baked into
`nav.js` (AI provider toggle, "Reset data from latest deploy", sign out) —
rather than cramming the new panel into that small dropdown.

**New file: `settings.html`.** Four sections: AI provider, Transaction
history (the new panel), Data (testing)/reset, Account/sign out. The AI
provider toggle, reset-data button, and sign-out button are moved here
byte-for-byte in behavior from nav.js's old dropdown (including that the AI
provider toggle is still hitting `BUGS_SCRIPT_URL = ''`, i.e. still
disconnected — pre-existing state, not something this pass touched).

**`nav.js` change:** the gear icon is no longer a dropdown-opening button —
it's now a plain `<a href="settings.html">` link, with `.active` styling
when already on that page (same pattern every other nav link uses). All of
the old dropdown's CSS/JS (`.settings-wrap`/`.settings-dropdown`/
`.settings-pill`/etc., `initSettingsWidget`/`loadSettingsProvider`/
`setSettingsProvider`/`initDataResetWidget`/`initSignOutWidget`/
`closeSettingsDropdown`) was removed from nav.js — it's the one shared file
across every page (UI chrome only, no business logic per this project's
convention), so moving the AI-provider/reset/sign-out logic out to
settings.html's own page-private copy (matching how every other page does
it) was part of this move, not just an add.

**Transaction history panel — how it works:**
- Fetches the whole `transactionLog.json` (via the existing generic
  `/api/data/transactionLog` endpoint from phase 1 — no new API route).
  Sorted newest-first client-side, showing the last 10 by default with a
  "Show more" button (loads more from what's already fetched, no extra
  round-trip) and a From/To date search that filters the full loaded set.
- Each entry shows as a card: summary, timestamp, page/action, and a
  badge — "Reversible", "Not reversible" (with its `note` shown, e.g. the
  row-shift-delete explanation from phase 1), or "Reversed &lt;when&gt;".
  Only reversible-and-not-yet-reversed entries are clickable.
- Clicking one opens a confirm modal (same modal-backdrop/sheet pattern
  used everywhere else in the app) showing the summary plus a "Technical
  detail" block listing exactly which sheet/row/columns will be restored
  to what values, and a standing warning that a restore targets a specific
  row number — if other rows were added/removed on that sheet since the
  original write, a very-stale reversal could land on the wrong row.
- Confirming re-fetches the transaction log fresh (so two people clicking
  "Reverse" on the same entry can't both run it — the second sees "already
  reversed"), applies each write's `before` values back to its exact
  sheet/row/cols via the same generic `fetchSheetWithMeta`/`writeSheetJson`
  every page already uses, then marks the log entry `reversed:true` with a
  retry-on-409 loop (same pattern as phase 1's append), and finally logs
  the reversal itself as a new `reversible:false` audit entry (via this
  page's own copy of `logTransactionB`) so there's a record of who/when
  undid what. Partial failure (some writes restore, others error) still
  marks the entry reversed and surfaces exactly which sheet/row had a
  problem, rather than leaving a "Reverse" button that would retry forever.

**Tested end-to-end in a real headless browser (Playwright, 17/17 checks),
not just at the function level** — served the actual `accounts.html`,
`nav.js`, and `settings.html` from a static file server against a mocked
backend (in-memory fake Drive store seeded with realistic log entries and
a real "August" sheet), then drove real clicks/navigation/form fills in
headless Chromium:
gear icon on accounts.html is a real link to settings.html and navigating
there works; the settings page's own gear shows active; entries render
newest-first with correct summaries; reversible/not-reversible badges are
correct; a not-reversible entry isn't clickable; clicking a reversible
entry opens the confirm modal with the correct summary and technical
detail; confirming actually restores the target sheet row's real cell
values (verified against the mock backend's in-memory state, not just a
UI checkmark); the log entry is marked reversed with a timestamp; a new
audit-trail entry for the reversal itself gets created; after a page
reload the "Reversed" badge and non-clickable state persist; clicking an
already-reversed row is a no-op (doesn't reopen the modal); and the
date-range search correctly narrows/empties/resets the list. Also
confirmed no stray references to the removed dropdown CSS/JS remain
anywhere else in the app, and that `login.html` (which opts out of the
shared topbar) still loads cleanly against the updated nav.js.

**Known limitations, deliberately not solved in this pass (matches the
original feasibility discussion):**
- Only writes that were instrumented in phase 1 are in the log — e.g. the
  secondary "bikes" sheet cascade write from a bike-split income/expense
  entry isn't separately logged, so reversing the main ledger line won't
  undo a linked bike-split adjustment. Pre-existing phase-1 scope, not new.
- Row-based restore has no protection against a sheet's rows having
  shifted since the original write (see the in-modal warning above) — this
  was flagged as a known tradeoff in the original feasibility discussion,
  not something this UI pass could fully close given the JSON model has no
  stable row IDs, only positions.
- The full log is fetched in one request with no pagination — fine at
  current data volumes, but worth revisiting if the log grows very large
  over time (also flagged in the original feasibility discussion).

## ✅ FIXED, tested, awaiting Anton's push — accounts.html:
## "extras"/"deposit" income entries threw a bogus "Totals cascade NOT
## recalculated" warning (2026-08-14, found live by Anton right after the
## transaction-log push above)

**The bug (Anton hit this live on staff-app-six-phi.vercel.app):** adding
an income entry with no bike split checked (e.g. Income="twse", Amount=100,
no bike) alerted `Saved, but: Bikes sheet (income): Totals cascade
(expenses/profit/net profit) NOT recalculated for "extras": expected the
paired row to also be "extras" but found "extras" / "total"`. The write
itself still succeeded (the alert is non-fatal by design), but the
income/expenses/profit/net-profit cascade added earlier today (see the
"bike income/expense summary columns" section further down) silently
failed for this case every time.

**Root cause:** when no bike is picked, `resolveIncomeBikeSplitsB` (accounts.html
~line 1610) defaults to a synthetic pseudo-bike `{bike: 'extras', amount}` —
a catch-all bucket, not a real bike. `addRentalAmountToBikesSheetFromJson`
then calls `recomputeBikeRowTotalsB`, which assumes every income row has a
matching expense row exactly 50 array-rows down (true for all 45 real
bikes — confirmed against `data/bikes.json`: income rows at array idx 1-45
pair with expense rows at idx 51-95, an exact 50-row offset). But `extras`
(idx 46) and `deposit` (idx 47) sit in the income block only, right before
that block's own "totals" row (idx 48) — they were never part of the real
bike list, so they have no row at all in the expense block. idx46+50=96,
which lands on the *expense* block's own "total" summary row instead of a
real paired row — hence "expected... "extras" but found "extras" / "total"".
Confirmed against real exported data that in the original spreadsheet
these two rows' "expenses" column was always blank (never a
`=P<row+50>` formula) — their profit/net-profit just mirrored total
(profit = total - 0, net profit = profit - cost).

**The fix (accounts.html only — bikes.html's copy of `addRentalAmountToBikesSheetFromJson`
predates the cascade feature entirely and has no cascade logic, so it isn't
affected; contract.html/customers.html/deposits.html don't touch the bikes
sheet at all):**
- Added `recomputeBikeRowSoloTotalsB(rows, header, rowIdx, isExpenseSection)`
  right after `recomputeBikeRowTotalsB` — recomputes only the row's own
  `total` (and, for income-section rows, `profit`/`net profit` derived from
  whatever's already in its `expenses` cell) instead of reaching for a
  paired row.
- `addRentalAmountToBikesSheetFromJson`'s cascade block now checks whether
  the row 50 away *actually matches this bike's name* before calling the
  full paired recompute. If it does (every real bike — unchanged, still
  gets the full income+expense pairing), behavior is identical to before.
  If it doesn't (extras/deposit/any future non-bike catch-all), it falls
  back to the solo recompute instead of throwing.
- Unmatched/genuinely-unknown bike names still throw their original
  "Could not find a row..." error — unchanged.

**Tested:** new standalone vm-harness test (`test_bikes_cascade.js`, 20/20
checks) built directly against real `data/bikes.json`, covering: real-bike
income-side full cascade (regression, unchanged), real-bike expense-side
full cascade (regression, unchanged), the exact "extras" repro from Anton's
screenshot (no throw, correct solo recompute, expense block's "total" row
verified completely untouched), the same for "deposit", and an unrelated
genuinely-unknown bike name still throwing its original error. Also
re-ran the existing 33-check `test_accounts2.js` suite — still 33/33, no
regression from this edit. Syntax-checked via `node --check` on the
extracted `<script>` block.

**Not yet done:** independent verification on Anton's live dev deployment
(add an unsplit income entry and confirm no alert) — first thing to do
after this gets pushed.

## ✅ DONE, tested, awaiting Anton's push — transaction log write
## instrumentation (2026-08-14, phase 1 of the "reverse transactions"
## feature Anton asked for)

**What Anton asked for:** a Settings-page "reverse transactions" panel
showing the last 10 writes across the app (bike rentals, expenses, income,
deposits, etc.), with the option to look further back, and a click-to-
reverse flow with a confirmation dialog. He explicitly asked to discuss
feasibility/difficulty/performance before any implementation, then said
"let's just do that" and to build the transaction log first.

**Design (agreed with Anton):** every physical row write across the app's
5 write-heavy pages now logs a small entry to a new `data/transactionLog.json`
(via the same generic `/api/data/<sheet>` endpoint every other page already
uses — no new API route needed) right after that write succeeds. Each entry
captures: `page`, `action`, a human-readable `summary`, `reversible`
(true/false), and a `writes` array with enough surgical detail per touched
sheet — `sheet`, `year`, `row`, `cols` (1-based), `before` values, `after`
values — for a FUTURE generic reversal executor to restore just that one
physical write, without needing any page-specific business logic. Logging
is best-effort and additive-only: it retries a couple of times on a write
conflict (another page logging at the same moment), and never throws or
delays the write it's describing (wrapped so a logging hiccup can never
turn an already-successful save into a reported error).

Multi-sheet logical actions (e.g. a bike rental touching Contract, customer,
monthly accounts, bikes, cash) are NOT logged as one bundled "transaction" —
each physical row write gets its own independent, independently-reversible
log entry. This was a deliberate simplification agreed as part of the
feasibility discussion: it avoids having to hand-write a "reversal recipe"
per action type, at the cost of the UI eventually needing to show related
writes grouped together and let staff reverse more than one if a whole
logical action needs undoing.

Row-shift deletes (accounts.html's `deleteExpenseRowFromJson`/
`deleteIncomeRowFromJson`, which shift every row below up by one rather than
just clearing cells) are logged with `reversible: false` — the before-values
are still captured for manual reference, but a generic cell-restore
executor can't safely undo a shift, so these are flagged rather than
offered as a broken "Reverse" button later.

**Instrumented (35 log call sites total):**
- `accounts.html` (10): `addExpenseRowFromJson`, `addIncomeRowFromJson`,
  `editExpenseRowFromJson`, `editIncomeRowFromJson`,
  `deleteExpenseRowFromJson` (reversible:false), `deleteIncomeRowFromJson`
  (reversible:false), `appendCashSheetRowFromJson`,
  `appendCashExpenseRowFromJson`, `processDepositForPaymentFromJson`,
  `consumeDepositFromJson`. `transferToBankFromJson` deliberately has no
  direct call — it delegates entirely to `appendCashExpenseRowFromJson`/
  `processDepositForPaymentFromJson`, both instrumented, so its writes are
  covered automatically without double-logging.
- `bikes.html` (11): `appendMonthlyIncomeRowFromJson`,
  `appendCashSheetRowFromJson`, `processDepositForPaymentFromJson`,
  `appendSwapUpgradeIncomeRowFromJson`,
  `appendEarlyReturnRefundIncomeRowFromJson`, `appendCashExpenseRowFromJson`,
  `writeDepositTransferIncomeRowFromJson`,
  `writeDepositTransferExpenseRowFromJson`, `logSecurityDepositFromJson`,
  and both `returnDepositFromJson` write blocks (clearing the deposit entry,
  logging the deduction income). The clear-step required adding a new
  `clearedBefore` capture (the existing code overwrote its row variable in
  place before the log point) — same fix pattern as deposits.html below.
- `contract.html` (4) / `customers.html` (4): `appendMonthlyIncomeRowFromJson`,
  `appendCashSheetRowFromJson`, `processDepositForPaymentFromJson`,
  `logSecurityDepositFromJson` — identical shape in both files per this
  project's per-file convention.
- `deposits.html` (6): `addDepositEntryJson`, `editDepositEntryJson`,
  `deleteDepositEntryJson`, `processDepositForPaymentFromJson`,
  `consumeDepositFromJson`, `appendIncomeRowFromJson`. `editDepositEntryJson`
  and `deleteDepositEntryJson` previously threw away the deposit row's old
  amount/name the moment they overwrote it — neither one had ever captured
  a "before" snapshot for anything other than the totals-row guard check.
  Added explicit `beforeAmount`/`beforeName` (edit) and `clearedAmount`/
  `clearedName` (delete) reads from the untouched `rows` array (proven safe
  since `newRows = rows.map(r => r.slice())` never mutates `rows` itself)
  right before the overwrite, so the log entry has real values instead of
  blanks.

**Bug caught during testing (fixed before delivery):** every one of the 35
`logTransactionB(...)` calls was originally written WITHOUT `await` —
fire-and-forget. Since `logTransactionB` does its own internal `fetch`
calls, the enclosing write function could return (and the page could move
on/reload data) before the log entry actually finished saving, silently
dropping entries under real-world timing. Fixed by prefixing all 35 calls
with `await` (`await logTransactionB({...})`) — confirmed via a dedicated
test that it still never throws even on a write conflict (retries
internally, matching the design).

**Tested against real August.json/cash.json data:**
`accounts.html` — 33/33 checks (add/edit/delete expense, add/edit/delete
income, cash income/expense, deposit-total edit, deposit consumption, plus
`logTransactionB`'s own retry-on-409 behavior). `deposits.html` — 20/20
checks, specifically targeting the new before-capture fix (confirmed the
logged "before" values are the REAL pre-edit numbers off the real sheet,
not blank/undefined, for both edit and delete). `bikes.html`,
`contract.html`, `customers.html` were code-reviewed against the same
verified pattern (identical `logTransactionB`/`writeSheetJson` shape,
confirmed via direct file reads of each call site) but not independently
re-run through the vm test harness in this pass — flagged here so a future
session knows the exact test coverage line if anything looks off.

**Deliberately NOT built yet (next task, pending Anton's go-ahead):** the
Settings-page "Reverse Transactions" panel itself (closeable box, last-10
list, search further back by date) and the actual reversal execution/
confirmation flow. The design above (self-describing `writes[]` entries)
means the reversal executor can be generic and page-agnostic once built —
it doesn't need to be duplicated per page the way the write-side logging
does.

## ✅ DONE, tested, awaiting Anton's push — monthly "Bank"/cash/deposit
## totals cascade, accounts.html (2026-08-14, item #2 from the audit below)

**Bug reported live by Anton:** added a ฿10,000 expense paid "Bank" through
accounts.html — the "Bank" figure on the summary strip (and every other
summary total) didn't move at all. This is exactly the audit's item #1/#2/#3
("Monthly ledger 'Bank' balance and its whole upstream chain") confirmed
live, not just theoretical.

**Root cause, confirmed against the real workbook (`data_only=False`, not
guessed):** `accounts.html`'s summary strip (`renderSummary`, fed by
`ACCOUNTS_SUMMARY_ITEMS`/`readSummaryItem`) reads six chained formula cells
off the monthly sheet — `I<TER-1>` (income for month), `C<TER>` (total
expenses), `I<TER>` (income less investment), `K<TER>` (net profit),
`C<TER+1>` (business expenses), `K<TER+1>` (actual profit) — plus the
Cash & Deposits block's `M3` (`=cash!G374`), `M6` ("bank" —
`=(K<TER>+M2)-(M3-M4)+P15-M11-M12`), `M9` (total), and the deposit-log's
own `P15/S15/W15/S16/W16` column totals. **None of these were ever
recomputed after a write** — same bug class as the already-fixed
bikes-sheet cascade, just on a much longer chain. Only M11/M12 (wise/
revolut running totals, via `processDepositForPaymentFromJson`) and the
personal/wages expense-type subtotals (via `updateExpenseTypeTotalRefFromJson`)
were already correctly kept live — everything else was frozen at
JSON-export time forever, including the cash sheet's own `C370`/`G372`/
`G374` totals that `M3` cross-references.

**Fix:** added `recomputeCashSheetTotalsB()` and
`recomputeMonthlySummaryCascadeB(monthName, year)` to accounts.html
(inserted just before `addExpenseRowFromJson`, ~line 1658 pre-insert).
Both use the file's existing self-healing row-lookup (`findSummaryRow`/
`ACCOUNTS_SUMMARY_ITEMS`, the same mechanism that already handles
month-to-month row drift) rather than hardcoded row numbers, so they don't
break the next time a month's layout drifts by a row or two. Called
best-effort (try/catch → pushed to `warnings`, never blocks the base
write) from the END of all 7 write actions that can move money through
this chain: `addExpenseRowFromJson`, `editExpenseRowFromJson`,
`deleteExpenseRowFromJson`, `addIncomeRowFromJson`, `editIncomeRowFromJson`,
`deleteIncomeRowFromJson`, and `transferToBankFromJson` (the last one was
an extra gap found while implementing this — draws down cash/wise/revolut
but never recomputed the bank/total figures that depend on them either).
Deliberately leaves alone: M11/M12 and the personal/wages subtotals
(already correctly live, see above), and M2/M4/M10 (prior-month snapshots,
correctly static intra-month — only touched at month rollover, a separate
not-yet-scoped task, see item #6 in the audit below).

**Found and fixed one bug in my own first draft during testing:** the cash
sheet's income-total row lookup searched from row 1 and matched the
column-B HEADER text ("income", row 1) instead of the actual totals-row
label further down (row 370) — both cells literally say "income". Fixed by
starting the search at row 2 (confirmed via the real `cash.json` that row 1
is always the header).

**Tested** via a vm harness running the REAL extracted function source
(not a re-typed copy) against real `August.json`/`cash.json` data, 26/26
passing: cash-sheet totals match an independently-computed sum; a
simulated ฿10,000 Bank expense (Anton's exact repro) correctly moves total
expenses/net profit/bank/total, while already-live cells (M11/M12,
personal/wages subtotals, M2/M4/M10) are provably left untouched; deposit-
log column totals and their wise/revolut subtotals recompute correctly;
running the cascade twice in a row is idempotent; a corrupted/missing
summary label throws instead of silently writing wrong numbers. Full-file
`node --check` also passes.

**UPDATE (same session, later) — ported to every other write path too.**
Anton's own reasoning nailed the right architecture: no matter which page
triggers a write, the money only ever lands in the monthly account sheet
and/or the cash sheet, so the "recompute after every write, not just when
Accounts happens to be open" approach is correct — the underlying data
should always be self-consistent, not just correct-when-someone-looks. The
gap was that bikes.html/contract.html/customers.html/deposits.html each
have their OWN separate, copy-pasted write functions (no shared JS between
pages, by design), so accounts.html's fix didn't cover them automatically.
Ported the identical `recomputeCashSheetTotalsB`/`recomputeMonthlySummaryCascadeB`
block into all four remaining files, plus a `recomputeCurrentMonthSummaryCascadeB()`
convenience wrapper in each (every write on these pages is always to the
CURRENT month, unlike accounts.html's user-selectable month), and called it
after every write that touches the monthly sheet or cash sheet:

- **bikes.html** (11 call sites): `appendMonthlyIncomeRowFromJson`,
  `appendCashSheetRowFromJson`, `processDepositForPaymentFromJson`,
  `appendSwapUpgradeIncomeRowFromJson`, `appendEarlyReturnRefundIncomeRowFromJson`,
  `appendCashExpenseRowFromJson`, `writeDepositTransferIncomeRowFromJson`,
  `writeDepositTransferExpenseRowFromJson`, `logSecurityDepositFromJson`,
  and both inline write blocks inside `returnDepositFromJson` (clearing a
  deposit entry, logging the deduction income). Tested via a vm harness
  simulating a bike-swap upgrade charge against real August/cash data:
  income/bank move correctly, wrapper never throws even with a corrupted
  summary row. 8/8 passing.
- **contract.html** and **customers.html** (4 call sites each):
  `appendMonthlyIncomeRowFromJson`, `appendCashSheetRowFromJson`,
  `processDepositForPaymentFromJson`, `logSecurityDepositFromJson`. Tested
  identically (simulated rental income write, cash-sheet recompute,
  best-effort error swallowing) against real data for both files. 10/10
  passing combined.
- **deposits.html** (6 call sites): `addDepositEntryJson`,
  `editDepositEntryJson`, `deleteDepositEntryJson`,
  `processDepositForPaymentFromJson`, `consumeDepositFromJson`,
  `appendIncomeRowFromJson`. This page owns the actual deposit-log P15/
  S15/W15/S16/W16 totals (audit item #2), so it got the most targeted
  test: adding a Wise deposit correctly moves S15/S16 but correctly
  LEAVES M6 ("bank") unchanged (confirmed against the real workbook
  formula: `M6 = (K145+M2)-(M3-M4)+P15-M11-M12` only references P15, not
  S15/W15 — Wise/Revolut's actual contribution to Bank comes through the
  separately-live M11/M12 running totals, not this log); adding a Bank/
  scan deposit DOES correctly move M6 (the one deposit-log input M6
  actually has); clearing/deducting a deposit correctly moves P15 back
  down, not just up. 11/11 passing. `deductDepositEntryFromJson`/
  `deductCashDepositFromJson` didn't need their own call — the former
  already routes through `consumeDepositFromJson`/`appendIncomeRowFromJson`/
  `processDepositForPaymentFromJson` (all three now fixed), and the latter
  only ever writes to the Contract sheet (never monthly/cash, per Anton's
  own "we don't record cash there" design note), correctly out of scope.

Every file's full inline `<script>` block passes `node --check` after the
change. **This closes out audit items #1 and #2 completely** — every
known write path that can move money now keeps the Bank/cash/deposit
summary chain self-consistent, regardless of which page the write came
from.

## ✅ RESOLVED (2026-08-14, later session) — pricing.html push confirmed landed

The commit/push described below (`f879031`, "Push completed pricing.html
live-rate refresh that never actually landed") **is confirmed committed AND
pushed** — verified via `git status` (clean), `git show --stat f879031`
(shows exactly `PROGRESS.md` + `pricing.html` changed), and the
`refs/remotes/origin/main` reflog on the Mac showing `update by push` at
that same commit hash, matching local `HEAD` exactly. Nothing left to do
here. Leaving the original text below for the historical record, but a new
session does NOT need to re-run anything in it.

## ✅ DONE, tested, awaiting Anton's push — Add/Edit Expense/Income modal
## silently saved with required fields left blank (2026-08-14)

**Bug reported by Anton:** saved a test expense with Payment method left at
"— Select —" and no warning appeared (screenshot showed it saved and
appears in the ledger with no payment method).

**Investigated before touching anything** (per Anton's "confirm your
understanding before coding" request): checked whether this was a
migration regression by comparing against BOTH references --
`upload to hostgator/accounts.html` (the real, currently-live production
frontend -- confirmed by its `scriptUrl` pointing at a real
`script.google.com/macros/.../exec` deployment, not a placeholder) and
Code.gs's `addExpenseRow`/`addIncomeRow` handlers. **Neither the live
app's client-side JS nor the server ever actually required Payment
method (or Date, or Amount) to be filled in** -- `modalSaveBtn`'s click
handler in the live hostgator copy has line-for-line identical validation
to what the JSON port had. So this was NOT something the migration broke;
it appears to have simply never been enforced, in either version. Told
Anton this plainly rather than assuming he was right that "it was there
before" -- but he wants it enforced regardless, so this is a genuine new
feature, not a restore.

**Fix implemented (accounts.html, `modalSaveBtn` click handler, ~line
3110):** Date, description (Expense/Income text), Amount, and Payment
method (`fExpensePayment` / `fPaidBy`) are now all required before the
modal will proceed to save -- each shows a specific `setModalError(...)`
message and returns early, exactly like the pre-existing description/
amount-format checks already did. "Name" on the Income side deliberately
stays OPTIONAL, matching both references above (neither required it).

**Tested** via a real Playwright/headless-Chromium run against the actual
page (not a DOM mock) -- served the real `accounts.html` statically (no
live backend needed since validation runs entirely before any `fetch`
call) and drove the real `#modalSaveBtn` button. 6/6 passed: blank payment
method blocks save with a payment-specific error (Anton's exact repro);
filling every required field proceeds past validation; blank date blocks
save; blank amount blocks save; Income's blank payment method blocks
save; Income with Name left blank still passes (confirms Name truly
stays optional, not accidentally required too).

## ✅ DONE, tested, awaiting Anton's push — bike income/expense summary
## columns don't recalculate after a JSON-model write (2026-08-14)

**Bug reported by Anton:** added a test expense on accounts.html (split
onto bike "Zoomer X", ฿3,180, dated 14/08/2026), it saved fine and shows in
the ledger list, but bike-income.html's Zoomer X row (Expenses/Profit/Net
profit) never changed.

**Root cause, confirmed against both Code.gs and a real formula-intact copy
of the original spreadsheet (see "Reference materials" below):** the
"bikes" sheet has two blocks of rows per bike — an INCOME block (starting
row 2) and an EXPENSE block (same bike, offset exactly +50 rows, i.e.
`BIKES_EXPENSE_SECTION_START_ROW = 52`). In the original spreadsheet these
were formula-linked:
- Expense-block row's `total` column (P) = `SUM` of that row's own month
  cells (e.g. `=SUM(B96:O96)` for Zoomer X's expense row 96).
- Income-block row's `expenses` column (Q) = `=P` of the matching
  expense-block row 50 rows down (e.g. Zoomer X income row 46's `Q46 =
  =P96`).
- Income-block row's `profit` column (R) = `=P-Q` (income total minus
  expenses).
- Income-block row's `net profit` column (S) = `=R-B` (profit minus cost).
- Income-block row's own `total` column (P) = `SUM` of ITS OWN month cells
  too (e.g. `=SUM(C46:O46)`) — so this same problem also applies on the
  INCOME side, not just expenses: adding income via `addRentalAmountToBikes
  SheetFromJson(..., sectionStartIdx=1)` has the identical gap.

The JSON port's `addRentalAmountToBikesSheetFromJson()` (accounts.html,
~line 1122) only ever writes the ONE month cell being changed. Because the
JSON model has no formula engine, nothing recalculates the four downstream
columns (expense-row `total`, income-row `expenses`/`profit`/`net profit`)
afterward — so they stay frozen at whatever they were the moment the JSON
was last exported, regardless of how many expenses/income entries get
added or edited after that. This affects every caller of
`addRentalAmountToBikesSheetFromJson` across accounts.html (add/edit/delete
expense, add/edit/delete income, bike splits on both).

**Fix implemented and tested (2026-08-14):** `addRentalAmountToBikesSheetFromJson()`
(accounts.html, ~line 1122) now recomputes the full cascade after every
month-cell write -- new helper `recomputeBikeRowTotalsB()` re-derives the
expense row's `total` (sum of its own month cells), then the income row's
`total`/`expenses`/`profit`/`net profit` from that, mirroring the real
formulas exactly (see "Reference materials" below). Both rows get written
back together in the same `writeSheetJson('bikes', ...)` call the function
already made, so this didn't add a second round-trip.

Two new constants added alongside it: `BIKES_EXPENSE_SECTION_START_IDX_B`
(=51, the array index of `BIKES_EXPENSE_SECTION_START_ROW`) and
`BIKES_EXPENSE_SECTION_ROW_OFFSET_B` (=50, the fixed row gap between a
bike's income row and its expense row -- confirmed against real data for
three different bikes, and matches the xlsx's hard-coded cell references
like `=P96` exactly).

Failure handling: if the header labels or the paired row can't be found/
matched (defensive -- shouldn't happen with real data, but the sheet could
theoretically get out of sync), the cascade recompute is skipped and a
clear warning is thrown AFTER the base month-cell write already succeeded
-- so a structural surprise degrades to "the raw number saved, but the
summary columns need a manual look" rather than losing the write entirely
or silently displaying wrong numbers.

**Tested** via a Node vm harness (`/tmp/work/bikes_cascade_test.js` in that
session's cloud sandbox -- won't persist to a new session, see the /tmp/
note at the bottom of this file) running the real extracted function source
against real exported `bikes.json` data (not a re-typed copy). 7/7 passed:
add-expense split (Anton's exact repro: Zoomer X, ฿3,180, August) cascades
correctly; add-income also cascades its own total/profit/net-profit;
negative deltas (used by editExpense/deleteExpense to remove an old amount
before applying a new one) cascade correctly too; an unknown bike name
still throws before any write, unchanged from before; a broken row-pairing
falls back to the base write + warning instead of crashing or losing data;
a missing "profit" header does the same; a zero/blank amount remains a
true no-op.

**Not yet covered by this fix, flagged for later:** this only recomputes
totals when `addRentalAmountToBikesSheetFromJson` itself runs (i.e. any
income/expense add/edit/delete that touches a bike split). If Anton ever
finds another path that edits the "bikes" sheet's month cells directly
without going through that function, it would need the same treatment --
but a full-file grep on 2026-08-14 confirms `writeSheetJson('bikes', ...)`
only appears at this one call site in accounts.html, so there's currently
nothing else to check.

## ✅ AUDIT COMPLETE, awaiting Anton's prioritization -- full app-wide
## formula-cascade sanity check (2026-08-14)

Anton asked for a full sweep: cross-reference every ported page's writes
against BOTH `Code.gs` (control flow reference) and the xlsx (live-formula
reference) to find every other place with the same bug class as the
bikes-sheet cascade fix above. **Full findings report:**
`FORMULA_CASCADE_AUDIT_2026-08-14.md` (project root on the Mac, alongside
this file) -- read that file in full before starting any of the items
below, it has exact formulas, exact file/line references, and severity
reasoning for each. Per Anton's explicit instruction, **nothing in that
report has been fixed yet** -- it's a findings list only, to be
prioritized before any code changes.

**Summary of what needs fixing, in the report's suggested order:**
1. **Operation sheet Current KM/Remaining/Status** (parts.html's
   `updateBikeRowJson`, add-bikes.html's `editBikeFromJson`) -- highest
   severity, feeds oilchange.html's daily-use status badge directly, most
   contained fix.
2. **Monthly ledger "Bank" balance + deposit-log totals + cash-sheet
   totals** (accounts.html, deposits.html, and every file that appends to
   the cash sheet) -- this is Anton's originally-described concern
   exactly. Three sheets, one shared recompute-after-write pattern
   (same shape as the bikes-sheet fix, just chained further).
   **DONE 2026-08-14, all five files** (accounts.html, bikes.html,
   contract.html, customers.html, deposits.html — see sections near the
   top of this file). Every write path that can move money now recomputes
   the Bank/cash/deposit summary chain.
3. **Bike Tax staleness on EDIT** (not just add, which was already known)
   -- add-bikes.html's `editBikeFromJson`; low severity today (nothing
   reads it back yet) but corrects a misleading existing code comment.
4. **Month-rollover mechanism** -- not ported at all (`index.html`'s
   button is a disconnected placeholder); bigger/structural, needs
   Anton's explicit scoping decision, already flagged pre-audit
   (see "Immediate next task" list below) but now confirmed directly
   relevant to item 2's "Bank" figure.

**Confirmed harmless, no fix needed** (also detailed in the report):
customer sheet's Status column (dead field, nothing reads it), customer
sheet's L/O columns (not real formulas), Parts_and_Oil_change's Status/
days-since columns (both already computed live by the pages that read
them, by design), cash sheet's I9/C278 (nothing writes to their sources),
Operation's rental-projection columns (nothing writes to them at all,
different problem than this audit's scope), Bike Tax G/H on new-bike-add
specifically (already known, confirmed accurate, low severity).

Also corrected in this pass: `oilchange.html`'s status-table row below
previously claimed "Writes (JSON): Done" -- it's actually a pure
read-only dashboard, always has been, zero write calls, no `oilChange`
action in Code.gs either. Documentation error only, not a functional gap.

## Reference materials (ground truth for how the original app behaved)

- **`Code.gs`** (project root on the Mac) — the actual Apps Script backend
  that ran against the real Sheets for years. Still the reference for
  business logic/control flow.
- **`upload to hostgator/`** (project root on the Mac) — the REAL, currently-
  live production frontend (confirmed via its `scriptUrl` pointing at a
  real `script.google.com/macros/.../exec` deployment). Useful as a
  second, independent reference alongside Code.gs for exactly what the
  client used to do (e.g. what was/wasn't validated) -- checked for the
  modal-validation bug above.
- **`AA Scooter Account 2026.xlsx`** (project root on the Mac, added
  2026-08-14) — a real, formula-intact copy of the original spreadsheet
  Anton supplied specifically as a reference for reconstructing exactly how
  cross-sheet/cross-column calculations (like the bikes-sheet cascade
  above) used to work, since the live JSON export has no formulas at all —
  just the last-computed static values. When a ported JSON write doesn't
  seem to "flow through" the way the old live spreadsheet did, open this
  file (`data_only=False` in openpyxl to see formulas, not just cached
  values) and check the relevant sheet/column before guessing.

## ⚠️ ACTION NEEDED (historical, already resolved above) — pricing.html
## commit/push

As of the original writing below, **`pricing.html` and this `PROGRESS.md`
file were sitting on Anton's Mac, written to disk, but NOT YET COMMITTED TO
GIT** — Anton ran out of weekly usage on this account before he could run
the commands below. The very first thing a new session should do is run
`git status` in `/Users/anton/AA-Scooters-Project Database/vercel-site` on
the Mac (via the device bridge) to check whether these commands have been
run yet:

```
cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
rm -f .git/index.lock
git add pricing.html PROGRESS.md
git commit -m "Push completed pricing.html live-rate refresh that never actually landed

Was fully ported and tested in an earlier session but sat unpushed in the
cloud sandbox -- same pattern as bikes.html and parts.html. Wrote a new
test file since none existed: real-data success path, simulated fetch
failure, missing/never-written-file handling, a too-sparse rate table, and
isValidRatesTable's rejection of every malformed shape. All pass."
git push
```

If `git status` still shows `pricing.html`/`PROGRESS.md` as modified (not
committed), the commands above still need to run — do NOT re-do the
pricing.html work, it's already complete and tested (see its row below and
`/tmp/pricing_write_test.js` if that cloud sandbox is still around, though
a fresh session will likely be a NEW sandbox with none of `/tmp/` intact --
see the note on that at the bottom of this file). If `git status` is clean
and `git log -1` shows a pricing.html commit, this step is done — update
this section to say so and move on to the "Immediate next task" section
below, which covers the process/cleanup work that was queued up next.

**This file has been wrong about what's "left" three separate times now**
(bikes.html sat unpushed; add-bikes.html's editBike was already done;
deposits.html's addDeposit/editDeposit/deleteDeposit were already done and
already pushed under a misleading commit message). So on 2026-08-14 this
row-by-row table was thrown out and rebuilt from a fresh, direct
`grep -c "fetch(scriptUrl" *.html` sweep of the Mac's actual committed repo
(not memory, not this file's own prior claims) — every non-zero count was
then individually inspected to confirm whether it's a real remaining call
or just a comment mentioning `fetch(scriptUrl)`. Trust that sweep over
anything below it says "not yet audited" from before 2026-08-14.

**Workflow reminder:** step-by-step, one task at a time, per Anton
(2026-08-14). Finish a task, test it rigorously, deliver + push, hand
Anton exact git commands, then STOP and wait for his go-ahead — do not
start the next task automatically, even if this file lists one as "next."

**Rule of thumb for "done":** ported + tested against real exported data
(via a `node --check`'d, vm-run test harness) + actually pushed to GitHub
(not just sitting in a cloud sandbox — that was the bikes.html near-miss on
2026-08-14, see below). Don't mark a row done until `git log` on the Mac
confirms it landed.

## Status by page

| Page | Reads (JSON) | Writes (JSON) | Notes |
|---|---|---|---|
| bikes.html | Done | Done | markReturned/updateReturnPickup, short-extension, swapBike, earlyReturnBike, returnDeposit, long-extension (30+ day) all ported+tested. `fetch(scriptUrl` sweep: 0 real calls (2 comment mentions only). **2026-08-14 fix:** Bank/cash/deposit summary cascade (see "DONE, tested, awaiting Anton's push" section near top) now recomputed after all 11 of this page's write points that touch the monthly or cash sheet — was previously frozen at JSON-export time. |
| accounts.html | Done | Done | addExpense/editExpense/deleteExpense/addIncome/editIncome/deleteIncome/transferToBank, plus expense-type persistence + bulkSetExpenseType. New design decision made unilaterally: expense type is now stored as a notes-sidecar marker on column E (`EXPENSE_TYPE_NOTE_COL_B`) since real cell colors have no JSON equivalent — **not explicitly approved by Anton, flagged for review.** `fetch(scriptUrl` sweep: 0 real calls. **2026-08-14 fix 1:** bike-sheet income/expenses/profit/net-profit cascade now recomputed on every bike-split write (see "DONE, tested, awaiting Anton's push" section above) — was previously frozen at JSON-export time. **2026-08-14 fix 2:** Add/Edit Expense/Income modal now requires Date/description/Amount/Payment method before saving (previously saved silently with any of these left blank — confirmed via the live production app + Code.gs that this was never actually enforced anywhere, not a migration regression, but Anton wants it enforced going forward). **2026-08-14 fix 3:** the whole "Bank"/cash/deposit summary-strip chain now recomputes after every add/edit/delete expense/income and after `transferToBankFromJson` (see "DONE, tested, awaiting Anton's push" section near the top of this file) — was previously frozen at JSON-export time, confirmed live by Anton via a ฿10,000 Bank expense that didn't move any total. |
| contract.html | Done | Done (Create/Edit/Cancel) | Drive-file actions (findContractDocument, uploadPassportPhoto, generateReceipt, generateChecklist, getFilesForShare, regenerateContract) still hit the old scriptUrl by design — these need a live Drive/PDF backend regardless of the JSON migration, not in scope for this effort. 13 real calls remain, all confirmed Drive-file ops. **2026-08-14 fix:** Bank/cash/deposit summary cascade now recomputed after all 4 of this page's write points that touch the monthly or cash sheet. |
| customers.html | Done | Done (intake) | Customer-intake write cascade ported, shared with contract.html's doRent path. `fetch(scriptUrl` sweep (2026-08-14): 0 real calls (2 comment mentions only) — the "2 sites not yet audited" note from before was stale, there's nothing left here. **2026-08-14 fix:** Bank/cash/deposit summary cascade now recomputed after all 4 of this page's write points that touch the monthly or cash sheet. |
| deposits.html | Done | Done | deductDeposit/deductCashDeposit AND addDeposit/editDeposit/deleteDeposit (`addDepositEntryJson`/`editDepositEntryJson`/`deleteDepositEntryJson`) are ALL already ported and already committed+pushed (commit `1dba35c`, whose message only mentioned deductDeposit/deductCashDeposit — misleading, but the diff shows all five). **Confirmed via `fetch(scriptUrl` sweep (2026-08-14): 0 real calls left, and md5 of the container's copy matches the Mac's committed copy exactly.** This row was wrongly marked "Partial" before — no work was actually needed here. **2026-08-14 fix:** Bank/cash/deposit summary cascade (including the P15/S15/W15/S16/W16 deposit-log totals this page itself owns — audit item #2) now recomputed after all 6 of this page's write points. |
| add-bikes.html | Done | Done | editBike/addBike/sellBike/unsellBike all ported+tested (see git log `f1b170c`). `fetch(scriptUrl` sweep: 0 real calls. Two purely cosmetic, documented gaps remain (nothing downstream reads either back): sold-row strikethrough styling, and Bike Tax's Status/day-count (G/H) columns for a newly-added bike. |
| available-bikes.html | Done | n/a (read-only page) | |
| bike-income.html | Done | n/a (read-only page) | |
| bikephotos.html | Done | Out of scope | uploadPhoto/deletePhoto are Drive file operations — need a live backend regardless of JSON migration. 4 real calls remain, confirmed Drive-file ops. |
| oilchange.html | Done | n/a (read-only page) | **Corrected 2026-08-14:** this row previously (wrongly) said "Writes: Done" — a full grep found ZERO `writeSheetJson(` calls anywhere in this file, and Code.gs has no `oilChange`-named write action either. It's a pure read-only dashboard (`getPartsDataFromJson`/`getBikeRentalStatusFromJson`, both reads) and always has been — there was never a write to port here. Documentation error only, not a functional gap. |
| parts.html | Done | Done | Turned out ALREADY PORTED in the cloud sandbox (dated 13/08/2026 in its own code comment) but never pushed — the exact bikes.html near-miss pattern, again. `getPartsDataFromJson`/`updateBikeRowJson` were already fully written and wired to the UI (`saveFields`/`performQuickSave`/`performSave`). Tested via `/tmp/parts_write_test.js` (existing thin test extended 2026-08-14 with: date/numeric/text/blank value-type coercion checks, clearing a field to blank actually clears it, an unknown field name is silently ignored rather than crashing, categoryRows/rates are populated from real Bike_Tax/rates_per_day data, and a malformed rates sheet reports a warning rather than throwing) — all pass. `readOdometerWithAI` correctly stays on the old disconnected path (AI vision call, no backend integration exists for this). Pushed to Mac, confirmed via md5 match (`b451b8a...`). |
| reply-assistant.html | Done | Done | `addContact` (`addContactFromJson`) is already ported and wired (line ~1212) — the "not yet audited" note was stale. `fetch(scriptUrl` sweep: 2 real calls remain, both confirmed AI-assist (`generateReplyDraft`, `readWhatsAppContactWithAI`) — correctly out of scope. |
| bike-name-audit.html | Done | Done | `fetch(scriptUrl` sweep (2026-08-14): 0 real calls (1 comment mention only) — the "1 site not yet audited" note was stale, nothing left here. |
| index.html | n/a | Out of scope (confirmed) | `createMonthSheetFromTemplate` (line ~243) is a TEMP/TEST button that creates a whole new monthly SHEET from a template — structural/month-rotation, not a row-level write against an existing sheet's data, genuinely a different concern from this migration. Recommend leaving as-is; flag to Anton for explicit confirmation before ever touching. |
| pricing.html | Done | n/a (read-only page) | Turned out ALREADY PORTED in the cloud sandbox (dated 13/08/2026 in its own code comment) but never pushed — same near-miss pattern as bikes.html/parts.html. `loadLiveRates()`/`getRatesDataFromJson()` were already fully written and wired up. Tested via new `/tmp/pricing_write_test.js`: real-data success path, fetch-failure path (confirmed `getRatesDataFromJson`'s internal try/catch means it never actually rejects, so loadLiveRates()'s outer `.catch` "Offline" text is effectively dead code in practice — the real failure message comes through the `.then()` branch instead; not a bug, just documented), the missing/never-written-file case (`rows: null`/`[]` reports a graceful warning, not a throw), a too-sparse rates block, and `isValidRatesTable`'s rejection of every malformed shape (missing day, wrong category count, NaN, string-typed number). All pass. Pushed to Mac, confirmed via md5 match (`1543d97...`). |
| login.html | n/a | n/a | No scriptUrl at all. |
| calendar.html | n/a | Isolated (by design) | Wired to a real but ISOLATED test Google account (`aascooters1@gmail.com`) via a standalone `TestCalendarScript.gs` deployment — NOT a JSON port, and shouldn't be; reminders/calendar events aren't spreadsheet data. Live `aascooterchiangmai@gmail.com` calendar untouched. There was a task (#27) to "assess and port the delivery-link + auto-sync gap" — re-clarify with Anton what specifically was meant here, since the rest of calendar.html is intentionally NOT going through the JSON path. |

## Immediate next task

**Nothing left to PORT.** As of 2026-08-14, every page in the status table
above reads either Done, n/a, or Out of scope (confirmed) — pricing.html
was the last genuinely-unfinished item found in the full re-audit, and its
code is done and tested. **But see the ⚠️ ACTION NEEDED section at the very
top of this file first** — as of this writing pricing.html's commit/push
to git hadn't happened yet, so confirm that before treating this as fully
closed out. Once that's confirmed pushed, what remains is process/cleanup,
not new porting work:

1. Re-confirm with Anton what task #27 ("calendar.html delivery-link +
   auto-sync gap") was actually supposed to cover, since calendar.html's
   core reminder actions are intentionally NOT part of the JSON migration.
2. Re-confirm with Anton whether index.html's `createMonthSheetFromTemplate`
   should stay out of scope (current recommendation: yes, it's structural
   month-rotation, not a row-level write).
3. Final regression sweep across every ported page + wrap-up summary,
   including flagging the accounts.html expense-type-persistence design
   decision for Anton's explicit sign-off.
4. Worth one more full `fetch(scriptUrl` sweep after Anton confirms this
   push landed, just to be certain nothing else was quietly already-done-
   but-unpushed (this has now happened 3 times: bikes.html, add-bikes.html's
   editBike, deposits.html's three functions, parts.html, and pricing.html
   — worth treating as the default assumption rather than the exception at
   this point).

## Design decisions made without explicit sign-off (flag for review)

- **accounts.html expense-type persistence** (2026-08-14): a new
  notes-sidecar marker (column E of each expense row, `_notes` sidecar file)
  stores expense type (business/personal/wages/transfer/transferComplete),
  since real Google Sheets cell background colors have no JSON equivalent.
  'business' (the default) stores no note, so pre-existing rows read back
  correctly automatically. Needs Anton's confirmation this is an acceptable
  stand-in.

## Process notes / lessons learned

- **A new session = a brand-new cloud sandbox with an EMPTY `/tmp/`.**
  Every path mentioned in this file under `/tmp/` (test harnesses, extracted
  `*_recheck.js` files, `/tmp/vercel-site-disconnected/` itself) lived only
  in the specific cloud sandbox of the session that created it — none of it
  persists to a new session, even one on the same Claude account, let alone
  a different one. A new session needs to re-clone/re-stage the repo (via
  the device bridge from the Mac, or however this project's `CLAUDE.md`
  describes it) and, if it wants to re-run a test file mentioned here, will
  need to re-recreate it from this file's description of what it covers
  (or just trust that it already passed, per this file's own notes, and
  move on) rather than expecting to find it already on disk.
- **A "delivered via SendUserFile" file is NOT the same as "pushed."**
  bikes.html sat fully done and tested in the cloud sandbox from an earlier
  session until 2026-08-14, because the device bridge was disconnected the
  whole time it was being worked on. Before marking ANY page "done" in this
  table, verify with `git log`/`git status` on the Mac that it actually
  landed — don't trust delivery-message text from a previous session.
- Standing workflow (per Anton, 2026-08-14): step-by-step, one task at a
  time. After a task is fixed and tested, deliver it and hand over exact
  `git add`/`git commit`/`git push` commands, then STOP and wait for Anton
  to push and confirm before starting the next task. Do not keep going
  autonomously through the list.
- Every write action, especially money-handling code, needs a vm-run test
  harness seeded from real exported JSON (`/tmp/vercel-site-disconnected/data/`)
  before being considered done — this has caught real bugs before (see the
  accounts.html row-insert notes-shift bug above).
