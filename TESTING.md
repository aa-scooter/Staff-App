# AA Scooters Staff App — Test Plan & Progress Log

Read `TESTING-METHODOLOGY.md` (same folder) first — this file is the actual
plan and running log built from it, not the methodology itself.

## 0. Handoff — read this first if picking up this testing session

---
### 🔴 LATEST HANDOFF -- 2026-09-04, mid-session login switch (READ THIS FIRST)

Anton is switching to another login because this one ran out of usage.
Picking-up session: do these in order.

**1. Push CONFIRMED successful -- just check the deploy finished.** I
fixed BUG-04, BUG-05, and CONC-01 this session and committed them locally
as `3c644fa` (the fix) and `734b9a3` (this file's own write-up of it) on
`main`, in `AA-Scooters-Project Database/vercel-site` on Anton's connected
machine. Git push is network-blocked from this cloud session, so Anton
pushed from his own machine -- he first ran it in the WRONG repo
(`~/property-app`), which got caught and corrected. Anton then sent a
screenshot of the Vercel dashboard (staff-app project, Deployments tab,
~2026-09-04 11:02am) showing commit `734b9a3` as the latest deployment,
status **"Building"**, Production, branch `main`, "2m ago" -- so the push
DID land on `origin/main` successfully. **First thing to do: check that
deployment's status has since flipped from Building to Ready** (Vercel
dashboard -> staff-app -> Deployments, top row) before retesting -- if
it's still Building/queued, just wait for it. Once Ready, move to step 2.

**IMPORTANT -- one more commit needs pushing:** AFTER that screenshot was
taken, I made one further commit, `b5b9d09` (adds this very handoff
section you're reading to TESTING.md), which is still LOCAL ONLY --
Anton's push happened before it existed. Someone needs to `git push origin
main` again from Anton's machine to get `b5b9d09` up (it's a docs-only
change, doesn't affect the app itself, so it's not urgent/blocking for
retesting the app, but push it when convenient so this file's own history
matches what's live in the repo).

**2. Retest BUG-04, BUG-05, and CONC-01 live**, exactly the same way
BUG-01/02/03 were retested earlier this session (see their entries in §6
for the pattern: reproduce the original repro steps against the LIVE
deployed app, confirm the bug no longer reproduces, update §6's Status
column for each from "Fix applied... pending retest" to "FIXED, verified
live [date]", and update this handoff section accordingly):
   - **BUG-04**: try to create/confirm TWO overlapping Rented bookings on
     the same `ZZTEST` bike again (same repro as the original: Contract
     rows 1299 + 1304 evidence in §6) -- confirm the second one is now
     either hard-blocked (direct edit path) or produces a warning and the
     Contract row stays Pending (customer-intake path) instead of
     silently succeeding as Rented.
   - **BUG-05**: post a fresh rental-income write to a `ZZTEST` bike (e.g.
     rent it out, or an extend/deposit-deduction that credits its month
     column) and confirm `bike-income.html`'s headline Income/Profit/Net
     Profit for that bike now matches a hand-sum of its month columns
     (previously it stayed frozen/stale -- see original BUG-05 repro
     using ZZTEST-Bike-01/02/03).
   - **CONC-01**: two-tab test on a test Expense row -- edit a DIFFERENT
     field in each tab, save A then B, confirm B's save no longer
     silently discards A's change (this is also §5.15's own CONC-01 test
     case, not yet browser-verified either way).

**3. Then continue the rest of the test plan** (see the "Next steps" list
a little further down in this section, and §7 for what's already been
run): 5.7/5.8 regression re-checks, and the remainder of §5.14 -- I was
IN THE MIDDLE of **PRICE-01** (`pricing.html`) when this handoff happened:
selected the "125CC" category, was trying to type a rental date range into
the native `dd/mm/yyyy` date inputs (plain `type` with slashes didn't
work -- the field stayed empty/placeholder after a "Calculate Price" click
reset the form; a native HTML date input needs digits typed directly into
its mm/dd/yyyy segments, no slashes, or use the "Enter number of days"
toggle instead of "Pick return date" if that's simpler) -- **no result
was ever produced, PRICE-01 is NOT done, start it fresh.** CAL-01, OIL-01,
REPLY-01, SET-01 (rest of §5.14) and §5.16's own exploratory pass haven't
been started at all yet.

**4. Keep updating this file as you go**, same standing instruction from
Anton all session: update TESTING.md whenever a bug is found AND whenever
a fix/retest lands, so any future handoff (usage runs out again, a new
login, whatever) can pick up from the file alone without needing this
conversation's history.

---


**Status as of 2026-09-03 (created today):** this file is brand new — a plan
only, nothing executed yet. Anton's explicit ask: build a comprehensive,
whole-app test plan (not a shallow page-by-page checklist), modeled
structurally on the sibling `property-app` project's testing setup but
researched and written fresh for this app, then wait for him to log in
before any live testing starts.

**What prompted this:** this session already found and fixed 4 real bugs in
this app through live investigation, not from a written plan — see §8. That
pattern (real bugs surfacing live faster than any plan catches them) is
exactly why Anton wants comprehensive, unassuming, actually-executed manual
testing going forward rather than relying on "it should work."

**Do this first, every time this file is picked up:**
1. Confirm the latest commit is actually deployed (Vercel dashboard,
   "Ready" against Anton's most recent push) — testing stale code wastes
   the whole session.
2. Re-read §0's "Progress so far" note below (once one exists) before
   picking an area to start on.
3. Set up test entities per §3 before touching anything — do not skip this.

**Progress so far (as of 2026-09-03, this session):** Substantial live
testing done on the ISOLATED TEST ACCOUNT (`anton.weiersmuller@gmail.com`,
NOT the real business login -- corrected 2026-09-03: this file previously said
`anton.voicemail@gmail.com`, which was wrong; Anton confirmed live that
`anton.weiersmuller@gmail.com` is the correct isolated test account), seeded via "Reset data from latest deploy"
with real Jan-Aug 2026 data, September created fresh. Full detail is in
§6 (bugs) and §7 (progress tracker, chronological) below -- read §7 top to
bottom, it's the real record. Quick-reference summary for whoever picks
this up next:

**Areas fully or substantially tested (see §7 for exact cases/results):**
5.1 Auth & login, 5.2 Contract-Create (all CTR-01..08, CTR-09 deferred to
5.9), 5.3 Multi-bike (all MBIKE-01..10, MBIKE-08 blocked by environment --
see below), 5.4/5.5 Search/Edit/Cancel + Pending flow (CTR-EDIT-01/02,
CTR-CANCEL-01, CTR-DEL-CASCADE-01, PEND-01..04), 5.6 Accounts Expenses/
Income CRUD (ACC-01..06; ACC-07 done separately, see below), 5.13 Add
Bike/Fleet (FLEET-01..03, AUDIT-01 partial).

**3 real bugs found in §6 -- ALL 3 NOW FIXED & VERIFIED (2026-09-03,
same session)**, per Anton's explicit instruction ("let's just fix all the
bugs, and then you can retest them as you go... continue on with your
testing plan"):
- **BUG-01** (High, FIXED): editing a RENTED contract's Total price,
  Paid-by, or Status (e.g. canceling it) never updated the Accounts
  income/cash ledger. Fixed via reference-based reconciliation (new
  income/cash ledger reference columns on the Contract sheet, written at
  Rent time, patched/cleared on edit) in `lib/contractWrites.js`.
  Retested live across 3 scenarios (price change, paid-by change, leaving
  Rented) -- all pass. Full detail in §6.
- **BUG-02** (Blocker, FIXED): editing a RENTED contract's Deposit method
  reported success but did not actually clear the old deposit ledger row.
  Fixed by adding a real reference-based clear (`writeContractRefColumnFromJson`)
  alongside the existing clear path. Retested live (Scan->Wise on a fresh
  Rented contract) -- old entry correctly cleared, new entry correctly
  created, reference correctly repointed. Full detail in §6.
- **BUG-03** (High, security, FIXED): the Accounts expense-description
  field (and 3 other render sites: income name/paidBy, save-review labels,
  cash disambiguation) rendered user text via unsafe `innerHTML`, allowing
  a real EXECUTING stored XSS. Fixed with a shared `escapeHtml()` helper
  in `accounts.html`. Retested live -- the same probe now renders inert.
  Full detail in §6.
All 3 fixes committed together as `7e81625` (pushed by Anton manually --
this environment's git push is network-egress-blocked, see below),
confirmed deployed on Vercel, and retested against the live deployed app
before resuming the broader test plan.

**UPDATED 2026-09-04 (later same day) -- BUG-04, BUG-05, and the CONC-01
finding are all FIX APPLIED, committed locally, NOT YET pushed/deployed/
retested (same git-push-is-network-blocked-in-this-environment situation
as BUG-01/02/03 -- see push commands below):**
- **BUG-04** (Blocker, bike double-booking): fixed by adding a shared
  `findConflictingRentedContractRowB` overlap check, wired into every
  place a Contract row becomes Rented across `lib/contractWrites.js`
  (`markMatchingContractAsRentedFromJson`, `editContractFromJson`),
  `lib/customersWrites.js`'s own duplicate of `markMatchingContractAsRentedFromJson`,
  and `lib/bikesWrites.js`'s `flipMatchingContractStatus`. Hard-blocks on
  the direct edit path; surfaces as a non-blocking warning (Contract row
  stays Pending) on the concurrent customer-intake chains, which already
  treat that flip as best-effort by design. See §6 for full detail.
- **BUG-05** (High, stale bike-income totals): fixed by porting the
  `recomputeBikeRowTotalsB` cascade (already correct in `accountsWrites.js`)
  into `lib/bikesWrites.js`, `lib/contractWrites.js`, `lib/customersWrites.js`,
  and `lib/depositsWrites.js`, wired into every one of those files' own
  `addRentalAmountToBikesSheetFromJson`/`addRentalAmountToBikesSheetForMonthFromJson`
  copies. A one-time repair pass for already-stale REAL bikes' totals is
  still outstanding (not part of this fix) -- see §6.
- **CONC-01** (High, Expense/Income edit race): fixed by adding the same
  retry-on-conflict + re-fetch-and-reapply pattern already used elsewhere
  in `accountsWrites.js` (cash sheet, notes sidecar, deposit totals) to
  `editExpenseRowFromJson`/`editIncomeRowFromJson`'s own core row write.

**Commit:** `3c644fa` on `main`, local only -- Anton needs to push from his
own machine (same network restriction as before): run `git push origin main`
in this folder, wait for the Vercel deploy to finish, then this session (or
whoever continues it) can retest all three live exactly like BUG-01/02/03
got retested. NONE of these three have been retested against the live
deployed app yet -- that's the very next step once pushed.

**Also flagged live to Anton (not filed as bugs, already accepted by
him for this test pass, do not re-raise unless he brings it up):** no
email/domain allowlist on login (`api/auth/callback.js`) -- any Google
account can sign in; and the isolated test account's data is a bundled
copy of real historical business data (by design, for cascade-testing --
Anton said "leave it alone, it's for testing").

**Real behavior findings worth Anton's attention, not bugs:** (1) every
contract created via the main form lands as status Pending, only hits the
cash/deposit ledgers once pulled through Pending->Rent -- confirm this
matches his mental model. (2) Total price = 0 is silently accepted
(comped rentals) -- confirm intended. (3) MBIKE-08 (View/Update Contract
PDF) is BLOCKED in this environment specifically -- fails with "Could not
find the contract template Doc... inside AA Scooters Contracts Drive
folder" because the isolated test account's Drive only got the 27 JSON
data files from "Reset from latest deploy", not the master template Doc
that lives directly in Drive. Not a code bug -- needs that template
copied into the test account's Drive folder to actually test PDF
generation, or accept as an out-of-scope gap.

**KNOWN LOOSE END -- fix or re-check first thing next session:** a test
expense row ("ZZTEST expense type persistence", ฿77, Cash, September
sheet row 2 per a direct API read) would not delete -- clicked Delete in
the UI three times across ~20+ seconds of waiting, modal closed each time
(optimistic UI), but a direct `/api/data/September?year=2026` re-fetch
confirmed the row is still there server-side. Every other delete this
session (5+ of them) worked within 5-8s, so this looks like a genuine,
reproducible one-off failure worth a real look, not just automation
flakiness -- but wasn't dug into further because the session was cut
short by usage limits. This is a small, contained ZZTEST-prefixed test
row on the isolated account -- harmless to leave as-is, but skews
September's Total expenses (฿77 too high) until cleared, so re-check
before trusting September's own expense total for anything.

**STATUS as of 2026-09-04 (continued testing pass):** 5.9 File uploads,
5.10 Deposits, 5.11 Customers, 5.12 Bikes Status, and 5.15 Concurrency are
now DONE (see §7's 2026-09-04 rows for full detail) -- this pass found 2
MORE real bugs (BUG-04 Blocker: no double-booking prevention at all;
BUG-05 High: bike-income.html's headline totals never recompute from real
rental activity) plus one unfiled finding (CONC-01: Expense/Income edits
have no conflict protection, silently lose a concurrent field change).

**STILL NOT YET STARTED:** 5.7/5.8 Accounts regression re-checks (code fix
already verified earlier this session per §8, just not re-run against
this file's own case IDs), the REST of 5.14 Read-only/secondary pages
(PRICE-01, CAL-01, OIL-01, REPLY-01, SET-01 -- AVAIL-01/INCOME-01 are
done), and 5.16's own dedicated unscripted exploratory pass (a good deal
of incidental exploratory-style testing happened while chasing BUG-04/05
live, but the charter's own 15-20-minute-per-area unscripted passes
haven't been run as their own thing).

**Test entities created this session, live on the isolated account right
now (cleanup NOT yet done -- Anton hasn't asked for it since this account
gets wiped for a second full testing round later anyway, but flagging so
nobody's surprised):** bikes ZZTEST-Bike-01/02/03; several ZZTEST-prefixed
contracts in various states (Pending/Rented/Canceled) on
ZZTEST-Bike-01/02/03; the one stuck ZZTEST expense above; plus, from the
2026-09-03 bug-fix retest pass, two more contracts -- "ZZTEST BugRetest
One" (Contract row 1299, Rented) and "ZZTEST BugRetest Two" (Contract row
1300, ended in status Returned after the retest's 3 edit scenarios) --
and their associated September-sheet income/cash/deposit ledger rows
(income+deposit rows around September rows 6-7, cash row 355 now blank
after the paid-by-change scenario cleared it).

**Next steps for whoever continues this:** 1) ~~Decide with Anton whether
to start fixing BUG-01/02/03~~ -- DONE, all 3 fixed and retested 2026-09-03,
see §6/§7. 2) ~~Re-check/resolve the stuck expense-delete loose end~~ --
DONE 2026-09-04: deleted directly via `/api/accounts/write` action
`deleteExpense` (no `needsDisambiguation` this time), confirmed gone via a
fresh server-side read; September's Total expenses is back to ฿0.00 as of
this session. 3) ~~Decide with Anton whether to fix BUG-04/BUG-05/CONC-01~~ -- DONE,
Anton said to fix and continue; all three fixed and committed locally
2026-09-04 (commit `3c644fa`), full detail in §0/§6. **NOT YET pushed,
deployed, or retested** -- Anton needs to `git push origin main` from his
own machine, then whoever continues this needs to retest all three live
exactly like BUG-01/02/03 got retested, and update §6/§7 accordingly.
4) Finish the rest of
§5.14 (PRICE-01, CAL-01, OIL-01, REPLY-01, SET-01) and §5.7/5.8's
regression re-checks -- the only scripted areas from the original plan not
yet touched. 5) Eventually clean up the (now quite large) set of ZZTEST
test entities created across both sessions -- not urgent, account gets
wiped for a second round later per earlier notes, but flagging that it's
grown substantially (contracts up to row ~1305, customer rows up to
~1327).

## 1. Purpose & scope

Whole-app manual test coverage for the AA Scooters staff app
(`staff-app-six-phi.vercel.app`), covering every page reachable from the
nav bar plus the handful of utility pages that aren't (bike-income,
bike-name-audit, reply-assistant) — see §4 for the full inventory. Excludes
`Code.gs` (the legacy Apps Script backend some older flows may still touch)
except where a page is confirmed to still route through it — flag and
confirm with Anton rather than assume either way.

### Testing approach (why this structure)

Same reasoning as `TESTING-METHODOLOGY.md` §1: this is one live business's
real data, not a disposable test tenant, so every section below opens with
its own test-data setup and closes with its own cleanup + balance
reconciliation check, rather than a single global setup step. Sections are
ordered roughly by financial risk first (accounts/cash — this is what broke
in the incident that started this whole session), then by how much of the
app depends on it (contracts, bikes), then by lower-risk/secondary areas
last, matching `property-app`'s own priority convention.

## 2. Test environment

- **URL:** `https://staff-app-six-phi.vercel.app` — the deployed app only,
  never local dev (see methodology §5).
- **Browser:** Chrome via `claude-in-chrome`, or the built-in browser pane
  as a fallback if the extension is offline — both usable interactively,
  Chrome preferred per this session's default.
- **Login:** Anton will provide a fresh login for this testing pass (his
  message: "I'll log in on the browser with the new login"). Confirm which
  staff account this is and whether it has full permissions before relying
  on any permission-gated action failing/succeeding as a real result.
- **Vercel dashboard access:** used to confirm deployment status before
  each session — via the browser, same as earlier this session.

## 3. Test data safety setup — read before writing anything

Per methodology §0. Before any write-testing session:

1. **Naming convention:** every test customer/description uses the prefix
   `ZZTEST-` (e.g. `ZZTEST-Alice Tester`), every test bike (if one needs to
   be created — normally avoid this, use an existing real bike only for
   read-only/status-check cases) uses `ZZTEST-Bike-01` style naming that
   cannot be confused with a real fleet bike.
2. **Balance snapshot:** before any `accounts.html`/`deposits.html`/
   `contract.html` (payment-related) case, record the current month's
   Cash / Bank / Wise / Revolut / Total figures from `accounts.html`'s
   summary card. Screenshot or note them.
3. **Test, then immediately reverse:** every test Contract/Expense/Income/
   Deposit row created gets deleted (or its bike un-rented/returned) before
   moving to the next case, not batched up for a big cleanup at the end —
   a crash or session cutoff mid-batch should never leave real books wrong.
4. **Re-check the balance snapshot** after cleanup for that section. If it
   doesn't match, stop and investigate before continuing to the next
   section — do not assume it will self-correct (this is literally how the
   September incident this session started with went unnoticed).
5. **Never test bulk/irreversible actions against real rows** — e.g.
   `bulkSetExpenseType` ("Complete Transfers") should only ever be tested
   against `ZZTEST-` rows created for that purpose, never run against a
   real month's real expenses to "see what happens."

## 4. Page & method inventory

Built by reading `nav.js` and every `lib/*Writes.js` dispatcher directly
(not guessed) — this is the actual, complete surface area as of 2026-09-03.

| Page | Purpose | Write layer | Actions (dispatch cases) |
|---|---|---|---|
| `login.html` | Staff sign-in | `api/auth/*` | login / logout / session |
| `index.html` | Tool picker | — (read-only) | — |
| `contract.html` | Create/search/edit/cancel rental contracts, pending-contract Rent/Cancel, calendar reminders | `contractWrites.js` | `addContract`, `editContract`, `cancelContract`, `customerIntake`, `resolveDepositLedgerPick`, `listOpenSecurityDeposits`, `setDeliveryPickupLink`, `listDeliveryPickupLinks`, `addCalendarReminder`, `editCalendarReminder`, `completeCalendarReminder`, `listCalendarReminders`, `manualCalendarSync`, `cleanupDuplicateCalendarEvents`, `calendarConnectionStatus`, `disconnectCalendar` |
| `accounts.html` | Monthly expenses/income, cash/bank/wise/revolut balances, transfer to bank | `accountsWrites.js` | `addExpense`, `editExpense`, `deleteExpense`, `addIncome`, `editIncome`, `deleteIncome`, `bulkSetExpenseType`, `transferToBank`, `recomputeSummary`, `repairOrphanedCashRows` (one-time, already used — do not re-run casually) |
| `deposits.html` | Deduct/log security deposits against a contract | `depositsWrites.js` | `addDeposit`, `editDeposit`, `deleteDeposit`, `deductDeposit`, `deductCashDeposit` |
| `customers.html` | Direct customer-record intake (separate from Contract) | `customersWrites.js` | `customerIntake`, `march` (name unconfirmed — investigate what this actually does before writing cases for it) |
| `bikes.html` | Fleet status, rent/return/extend/swap | `bikesWrites.js` | `customerIntake`, `markReturned`, `extendBike`, `closeBikeForExtend`, `earlyReturnBike`, `swapBike`, `updateReturnPickup`, `returnDeposit` |
| `add-bikes.html` | Add/edit/sell/unsell fleet bikes | `addBikesWrites.js` | `addBike`, `editBike`, `sellBike`, `unsellBike` |
| `available-bikes.html` | Multi-bike availability + quote picker | (read-mostly, feeds Contract) | — |
| `bike-income.html` | Per-bike income/expense/profit report | (read-only) | — |
| `bike-name-audit.html` | Cross-sheet bike-name consistency checker | (read-only) | — |
| `bikephotos.html` | Upload/view/delete bike photos | `api/photos/[...path].js` | upload, delete |
| `calendar.html` | Bike-return calendar (synced from customer sheet) | `googleCalendarSync.js` | (sync only, via contractWrites' calendar actions) |
| `oilchange.html` | Oil-change priority list | `bikesWrites.js`-adjacent | (read + edit via Parts & Oil) |
| `parts.html` | Parts & Oil per-bike record | `bikesWrites.js`-adjacent | edit |
| `pricing.html` | Price calculator | (read-only calc) | — |
| `reply-assistant.html` | AI WhatsApp reply generator | `api/ai/[...path].js` | AI call only, no sheet writes |
| `settings.html` | AI provider, transaction history, account options | `api/admin/reset.js`-adjacent | settings changes, possibly a reset action — confirm scope before testing |

## 5. Test areas & cases

Each area below: setup → scripted cases (happy path, boundary/negative,
cascade) → cleanup + balance re-check → a short exploratory pass. Case IDs
are stable — reference them from the bug log (§6) and progress tracker
(§7).

### 5.1 Auth & login (`login.html`)

- **AUTH-01** Valid login succeeds, lands on `index.html`.
- **AUTH-02** Wrong password — clear error, no partial session created.
- **AUTH-03** Session persists across a page reload; expires appropriately
  (check how long — don't assume, read `session.js`'s actual TTL first).
- **AUTH-04** Logout actually clears the session (back button after logout
  shouldn't show authenticated content).
- **AUTH-05** Direct navigation to any page while logged out redirects to
  login rather than rendering a broken/partial page.

### 5.2 Contract — Create (`contract.html`, single bike)

- **CTR-01** Full valid single-bike contract, every optional field filled
  (helmets, delivery, deposit with currency change, "Deal" checked) — saves,
  appears in Search, PDF generates correctly.
- **CTR-02** Minimum-required-only contract (name, bike, dates, total
  price, paid-by) — saves without the optional fields breaking anything.
- **CTR-03** Boundary: total price `0` (comped rental) — confirm intended
  behavior (accept or reject?) rather than assuming.
- **CTR-04** Negative: blank required field (name, bike model) — client-side
  validation blocks submit with a clear message, not a server 500.
- **CTR-05** Negative: bike model that doesn't match the fleet — picker/
  validation catches it (`validateBikeModelOrShowPicker`).
- **CTR-06** Adversarial: name/passport with XSS-shaped text, very long
  text, non-Latin script (real case for this business, not hypothetical).
- **CTR-07** Double-submit (click Create twice fast) — `clientTxnId`
  idempotency prevents a duplicate row.
- **CTR-08** Cascade: paid-by Cash → confirm it lands correctly on the
  "cash" sheet AND the monthly Cash balance moves by the right amount.
  Paid-by Wise/Revolut → confirm the deposit total updates.
- **CTR-09** Passport photo upload on create — see §5.9 file-upload cases,
  run at least one here specifically in the contract-create context.

### 5.3 Contract — Multi-bike, manual per-bike amounts (new today, 2026-09-03)

This is today's newest change — replaced the old even-split with manual
per-bike amounts, with forced validation. Not covered by any prior test
case anywhere; treat as a first-time pass, not a regression check.

- **MBIKE-01** Add a 2nd bike — confirm the per-bike amount box appears
  next to BOTH bikes (primary included), and Total price switches to
  read-only.
- **MBIKE-02** Enter different amounts per bike (e.g. 500 / 800) — confirm
  Total price live-updates to the exact sum (1300) as you type.
- **MBIKE-03** Leave one bike's amount blank, click "Create contract" —
  blocked with an error naming that specific bike, focus lands on its box,
  nothing saved.
- **MBIKE-04** Submit with both amounts filled — confirm TWO separate
  linked Contract rows are created (`linkedGroupId` shared,
  `linkedBikeIndex` 0/1), each with its OWN entered amount as its
  `totalPrice`, not an even split.
- **MBIKE-05** Remove the 2nd bike back down to 1 — confirm the amount box
  disappears and Total price becomes editable again, holding whatever value
  was last computed (or does it need clearing? — confirm intended UX, not
  assumed).
- **MBIKE-06** 3+ bikes with different amounts — confirm all save
  correctly, sum matches, no off-by-one on which amount maps to which bike.
- **MBIKE-07** Cascade: multi-bike contract paid by Cash — confirm the
  COMBINED total (not one bike's share) is what lands on the cash sheet
  (this exact class of bug — one bike's share used where the combined
  total should be — is what `property-app`'s own multi-bike PDF bug was;
  confirm this app's cash-sheet append doesn't have the same mistake).
- **MBIKE-08** View Contract / Update Contract on a multi-bike group —
  PDF shows every bike + the combined total (already fixed/verified this
  area earlier — re-confirm still correct after today's amount change).
- **MBIKE-09** Cross-entry-point: edit ONE bike's amount via Search → Edit
  contract → Total price → Save. Confirm only that one linked row changes,
  siblings and the group's combined total (as shown elsewhere) update
  correctly, nothing gets redistributed.
- **MBIKE-10** Form reset after a successful multi-bike save — confirm the
  amount boxes/extra bike lines are fully cleared, not carried into the
  next contract (this exact "stale carried-over field" shape of bug was
  `property-app`'s `BUG-13`/`BUG-12` chain — worth checking here too).

### 5.4 Contract — Search / Edit / Cancel

- **CTR-EDIT-01** Edit an existing (test) contract's every field, confirm
  each saves individually without touching unrelated fields.
- **CTR-EDIT-02** Change payment method on edit — confirm the OLD payment
  method's ledger impact is reversed and the NEW one applied, not both
  landing (this class of bug is explicitly what `originalDeposit`/
  `originalDepositAmount` in the edit payload exists to prevent — confirm
  it actually works, don't just trust the code comment).
- **CTR-CANCEL-01** Cancel a pending contract — status updates, no
  cash/deposit impact if it was never rented.
- **CTR-DEL-CASCADE-01** Cancel/delete a RENTED test contract — confirm
  cash-sheet entry and deposit total are correctly reversed, not left
  orphaned (methodology §2 CRUD matrix — Delete must undo what Create did).

### 5.5 Contract — Pending contracts / Rent / Cancel flow

- **PEND-01** Create a pending contract via Contract, then Rent it via the
  "Pending contracts" picker — confirm it becomes a real active rental with
  correct fields carried over.
- **PEND-02** Cancel a pending contract from the picker instead.
- **PEND-03** A multi-bike pending group — "Rent all"/"Cancel all" buttons
  act on every linked bike at once, not just the one clicked into.
- **PEND-04** Cross-entry-point: does renting via the Pending picker
  (`customerIntake` in `contractWrites.js`) hit the SAME cash-ledger append
  path as a direct Contract creation, or a different one? (Methodology §1
  cascade-verification concern — confirm, don't assume, given this app's
  documented pattern of duplicating the cash-append logic per file.)

### 5.6 Accounts — Expenses & Income CRUD

- **ACC-01** Add expense, every payment method (Bank/Cash/Wise/Revolut) —
  confirm each lands on the correct balance.
- **ACC-02** Add income, every "Paid by" method — same check.
- **ACC-03** Edit an expense/income's amount — monthly summary
  (Total expenses/income, Net profit) recalculates correctly.
- **ACC-04** Delete an expense/income — reverses cash/deposit impact
  cleanly (CRUD-matrix Delete check again).
- **ACC-05** Boundary: `0.00` amount — this app's own bug history
  (`BUG-01` in the sibling app was exactly a $0 crash) makes this worth
  checking explicitly here too, even though it's a different codebase.
- **ACC-06** Negative: description with XSS-shaped text, very long text.
- **ACC-07** Expense Type dropdown — every option (Business/Personal/
  Wages/To Transfer/Transfer Completed) sets the right color/tag and
  persists after a real page reload (see §5.7 — this exact case, on a
  different month, was a real bug found and fixed today).

### 5.7 Accounts — Expense-type/bike-split notes persistence (regression, fixed 2026-09-03)

Seeded directly from today's real bug — see §8 item 2. The root cause was
a hardcoded month whitelist that stopped the app from ever reading back
saved notes for any month past August.

- **NOTES-01** Set an expense to "To Transfer" on the CURRENT month, hard
  refresh the page (not just re-render) — confirm it's still yellow/tagged
  "To Transfer" after reload. This is the exact repro that was broken.
- **NOTES-02** Same check on a bike-split note (split an expense/income
  across two bikes), reload, confirm the split survived.
- **NOTES-03** Run the same check on next month once it rolls over — this
  bug's whole shape was "works for the two months that existed when the
  code was written, breaks for every month after" — an off-by-N version of
  this bug is a real risk if the fix itself has any hardcoded assumption
  left in it. Re-read `accounts.html`'s current notes-fetch code before
  marking this closed for good.

### 5.8 Accounts — Cash ledger summary-block boundary (regression, fixed 2026-09-03)

Seeded from today's real incident (the original bug that started this
whole session) — see §8 item 1.

- **CASH-01** Add income/expense with Cash as the payment method when the
  "cash" sheet's real data is already close to its own summary-block
  boundary (per the fix, this should now transparently insert room and
  keep working — but confirm live, don't just trust the standalone Node
  test already run this session, which used synthetic not real data).
- **CASH-02** Repeat CASH-01 through EVERY entry point that appends to the
  cash sheet — `accounts.html` add-expense/add-income, a bike rental paid
  in cash (`bikesWrites.js`), and a contract paid in cash
  (`contractWrites.js`) — per methodology §1's cascade-verification rule,
  since these are 3+ separately duplicated implementations of the same
  fix, not one shared one.
- **CASH-03** Confirm the monthly summary cascade (`recomputeMonthlySummaryCascadeB`)
  correctly re-sums after a boundary-crossing insert — the running total
  should include the new row, not just the row count.

### 5.9 File uploads (bike photos, passport photos, WhatsApp screenshots)

- **FILE-01** Valid JPG/PNG upload succeeds and displays correctly
  (including EXIF-rotated phone photos — a very real case for passport/
  bike photos taken on a phone).
- **FILE-02** Oversized file, 0-byte file, non-image file renamed with an
  image extension — clear rejection, no crash.
- **FILE-03** Delete an uploaded photo — confirm it's actually gone (not
  just hidden client-side) on a fresh reload.
- **FILE-04** WhatsApp "Fill from WhatsApp (AI)" and passport-photo AI
  auto-fill — a garbled/low-quality screenshot degrades gracefully (asks to
  enter by hand) rather than confidently filling in wrong data.

### 5.10 Deposits (`deposits.html`)

- **DEP-01** Deduct a deposit against a real (test) contract that has a
  deposit amount recorded — confirm it deducts the right amount from the
  right method.
- **DEP-02** Deduct against a customer with NO deposit recorded on their
  contract — per this page's own stated behavior ("nothing is deducted, no
  error") confirm that's actually true, not just documented.
- **DEP-03** Edit/delete a deposit entry — cascades correctly.
- **DEP-04** Cash deposit deduction specifically (`deductCashDeposit`) vs.
  the general `deductDeposit` — confirm both paths land on the correct
  balance, since these are separate actions/code paths per §4's inventory.

### 5.11 Customers (`customers.html`)

- **CUST-01** `customerIntake` — full valid record.
- **CUST-02** Investigate and document what the `march` action actually
  does (name gives no hint) before writing real cases for it — do not
  guess.
- **CUST-03** Cross-entry-point: does a customer created via Contract's own
  intake produce an equivalent record to one created directly here?

### 5.12 Bikes Status (`bikes.html`)

- **BIKE-01** `markReturned` — bike flips to available, return date/time
  recorded.
- **BIKE-02** `extendBike` — due-back date moves, price recalculates if
  applicable, calendar event updates.
- **BIKE-03** `earlyReturnBike` — confirm this correctly differs from a
  normal `markReturned` (presumably a refund/partial-charge implication —
  confirm by reading the code, don't assume it's identical).
- **BIKE-04** `swapBike` — customer keeps their contract but changes
  physical bike; confirm the OLD bike goes available and the NEW one goes
  rented, no state where both or neither show correctly.
- **BIKE-05** `closeBikeForExtend` / `updateReturnPickup` — confirm exact
  intended behavior by reading the code first (names are not fully
  self-explanatory), then test that behavior specifically.
- **BIKE-06** `returnDeposit` — same balance-impact checks as §5.10.

### 5.13 Add Bike / Fleet management (`add-bikes.html`)

- **FLEET-01** `addBike` — writes to every sheet it's supposed to (per this
  page's own description: Bike Tax, Parts and Oil change, Operation,
  bikes), shows up in every dropdown across the app immediately (Contract's
  bike picker, Available Bikes) without needing a hard refresh.
- **FLEET-02** `editBike`, `sellBike`, `unsellBike` — each reversible,
  `unsellBike` genuinely undoes `sellBike` with no residue.
- **FLEET-03** Cross-cutting: does a newly-added bike immediately appear
  correctly in `bike-name-audit.html`'s consistency check, or does that
  page have its own stale-cache risk?

### 5.14 Read-only / secondary pages

- **AVAIL-01** `available-bikes.html` — multi-bike date-range availability
  and pricing is correct against a known bike's real rate.
- **PRICE-01** `pricing.html` calculator matches a real contract's actual
  charged total for the same bike/dates (cross-check against §5.2).
- **INCOME-01** `bike-income.html` per-bike totals match a hand-sum of that
  bike's actual rows for the month.
- **AUDIT-01** `bike-name-audit.html` correctly flags a genuinely
  inconsistent name (create one deliberately with a `ZZTEST` bike, confirm
  it's flagged, then remove it).
- **CAL-01** `calendar.html` shows a test contract's real due-back date/
  time, updates when that contract is extended/returned.
- **OIL-01** `oilchange.html` priority ordering matches the real
  Parts & Oil data (spot-check 2-3 bikes by hand).
- **REPLY-01** `reply-assistant.html` — generates a reasonable reply for a
  test customer/bike selection; a nonsense/empty instruction degrades
  gracefully rather than crashing or sending nothing usable to WhatsApp
  (confirm it does NOT actually auto-send without a staff review step).
- **SET-01** `settings.html` — AI provider switch actually changes which
  provider subsequent AI calls use (verifiable via behavior, not just the
  UI state); transaction-history view matches real recent activity; any
  reset/admin action here is confirmed SAFE before ever running it for
  real (test against a throwaway state if at all possible).

### 5.15 Concurrency / multi-staff simultaneous use

Per methodology §1's manual two-tab technique — this app is used by
multiple staff at once in real life, and this session already found two
real classes of "looks saved, actually wasn't" bugs without any
concurrency involved at all, which raises the odds a genuine concurrent
scenario finds more.

- **CONC-01** Two tabs, same test expense open in both, edit different
  fields in each, save A then B — confirm B's save doesn't silently
  discard A's change (this is exactly what the retry-on-conflict fix
  added this session to `lib/*Writes.js` is supposed to prevent — confirm
  it live, the standalone code fix was never browser-verified this way).
- **CONC-02** Two tabs both marking the SAME test expense's type
  ("To Transfer" in one, "Personal" in the other) within a couple of
  seconds — confirm one wins cleanly and the other either retries onto the
  latest state or shows a clear conflict, never a silent last-loaded-wins
  data loss.
- **CONC-03** Two staff renting out the same bike from two tabs at nearly
  the same moment (using a `ZZTEST` bike, not a real one) — confirm the
  app prevents double-booking or at minimum surfaces it clearly, rather
  than silently creating two active rentals for one physical bike.

### 5.16 Cross-cutting exploratory charter

After the scripted cases above pass for a given area, a 15-20 minute
unscripted pass per methodology §1 — try to break it, not just confirm it
works. Particularly worth aiming at: the Contract multi-bike flow (newest,
least battle-tested), the cash-ledger append paths (highest financial
risk, most duplicated code), and anything involving the calendar sync
(external Google Calendar API, most likely to have timing/quota surprises
no scripted case would think to check).

## 6. Bug log

| ID | Area | Test case | Steps to reproduce | Expected | Actual | Severity | Status |
|----|------|-----------|---------------------|----------|--------|----------|--------|
| **BUG-05** | Bikes Status / Bike Income (`bike-income.html`, root cause spans `lib/bikesWrites.js`, `lib/contractWrites.js`, `lib/customersWrites.js`, `lib/depositsWrites.js`) | INCOME-01 | 1. Note any bike's current-month rental income landing correctly in its own month column on the "bikes" sheet (confirmed all session via direct API reads -- e.g. ZZTEST-Bike-01's "sept" column correctly accumulated to ฿7,000 across several real transactions: initial rent, a deposit deduction, `returnDeposit`). 2. Open `bike-income.html` (no need to expand "SHOW MONTHS") and look at that same bike's headline Income/Profit/Net Profit columns. | The headline Income/Profit/Net Profit figures should reflect the bike's actual accrued rental income, matching a hand-sum of its own month-column rows (per this test case's own stated goal) -- these are meant to be the same money, just displayed two ways (aggregate vs. per-month breakdown). | They do NOT match, confirmed live: ZZTEST-Bike-01 shows Income ฿0 / Profit ฿0 / Net Profit -฿35,000 on `bike-income.html`'s main table, despite genuinely having ฿7,000 of real September rental income sitting in its own "sept" column (independently confirmed via `/api/data/bikes` reads throughout this session) -- same for ZZTEST-Bike-02 and ZZTEST-Bike-03. Root cause fully traced by code read: `bike-income.html`'s main table reads its "Income" figure from the "bikes" sheet's own **`total`** column (a separate, distinct column from the per-month "sept"/"oct"/etc columns, only visible via the page's "SHOW MONTHS" toggle) -- and `total` (along with `expenses`/`profit`/`net profit`) is a pre-computed SUM that has to be explicitly recalculated any time a month cell changes, since the JSON data model has no live spreadsheet formulas. A real recompute function for exactly this (`recomputeBikeRowTotalsB`) DOES exist in the codebase -- but it is ONLY ever called from `accountsWrites.js`'s own "split an expense/income across one or more bikes" feature (the Accounts page's bike-split rows). EVERY rental-flow write path that credits a bike's month column via `addRentalAmountToBikesSheetFromJson`/`addRentalAmountToBikesSheetForMonthFromJson` (each file -- `bikesWrites.js`, `contractWrites.js`, `customersWrites.js`, `depositsWrites.js` -- has its own duplicated copy of this function) NEVER calls the recompute function afterward. Confirmed by grep across the whole codebase: `recomputeBikeRowTotalsB`'s only call site is inside `accountsWrites.js` itself. Real-world impact: for ANY bike (not just these ZZTEST ones) whose rental income comes through the normal Contract/Rent flow, deposit deductions, extensions, or early returns -- i.e. virtually every real rental transaction in this app -- `bike-income.html`'s main Income/Profit/Net Profit table silently understates or shows stale figures, and only the money that happened to also go through Accounts' manual "split across bikes" feature is reflected. Spot-checked one real, long-standing bike ("Aerox cool 1") for contrast: its `total` (฿64,550) currently DOES match a hand-sum of its own month cells -- but only because that bike happens to have had zero September activity yet (`total` = `2025` carryover + Σ Jan-Aug, and Sept/Oct/Nov/Dec are all still `null` for it); the moment it earns ANY rental income through the live app this month, its `total` will silently freeze and go stale exactly like the ZZTEST bikes already have. | High -- this is the app's core "how much has this bike earned" business metric silently going stale for essentially all real rental activity going forward, not just a display glitch on an obscure page; distinguished from Blocker only because the underlying month-by-month data IS correct and recoverable (visible via "SHOW MONTHS", and a fix can recompute `total`/`expenses`/`profit`/`net profit` from it at any time without any data loss). | **Fix applied 2026-09-04** (not yet pushed/deployed/retested -- see §0 handoff). Ported `findBikesHeaderColIdxB`/`recomputeBikeRowTotalsB`/`recomputeBikeRowSoloTotalsB` (plus a small shared `applyBikeRowTotalsCascadeB` wrapper) into `lib/bikesWrites.js`, `lib/contractWrites.js`, `lib/customersWrites.js`, and `lib/depositsWrites.js`, and wired the cascade into every one of those files' own `addRentalAmountToBikesSheetFromJson`/`addRentalAmountToBikesSheetForMonthFromJson` copies (best-effort -- a cascade failure surfaces as a warning after the month-cell write, exactly like `accountsWrites.js`'s own already-correct copy does). Committed (not pushed). NOT done: the one-time repair pass for already-stale real bikes' `total`/`profit`/`net profit` -- still worth doing once this fix is live, since existing real bikes' totals are stale until their next write. STILL NEEDS: push + deploy + live retest (re-check ZZTEST-Bike-01/02/03's headline Income on `bike-income.html` after a fresh rental-income write, confirm it now matches the month-column figure). |
| **BUG-04** | Contract — Create/Rent (`contract.html`, `addContractFromJson`/`editContractFromJson` in `lib/contractWrites.js`) | CONC-03 | 1. Confirm a bike has an active RENTED contract for specific dates (e.g. ZZTEST-Bike-01, Contract row 1299, "ZZTEST BugRetest One", Rented 2026-09-03 to 2026-09-05). 2. Create a SECOND, completely independent contract for a DIFFERENT customer on the SAME bike with FULLY OVERLAPPING dates (`addContract` then `editContract` to status Rented) -- no need for any special timing or two actual browser tabs; two plain SEQUENTIAL API calls a few seconds apart reproduce it every time. | The app should refuse, or at minimum warn, when a bike already has an active Rented booking for the requested dates -- physically, one scooter cannot be handed to two different customers on the same day. | Both contracts saved successfully as status Rented with `{success:true}` and NO warning of any kind -- confirmed live: Contract row 1299 ("ZZTEST BugRetest One", ZZTEST-Bike-01, Rented 2026-09-03..2026-09-05) and Contract row 1304 ("ZZTEST DoubleBookTest", ZZTEST-Bike-01, Rented 2026-09-03..2026-09-05) coexist right now, both fully Rented, for the identical bike and identical date range. Confirmed by code read that neither `addContractFromJson` nor `editContractFromJson` contains ANY bike-availability/date-overlap check at all -- this isn't a race-condition edge case, it's a complete absence of the validation in the first place. In real use this means: two staff (or the same staff member clicking through twice, or a UI page that hasn't refreshed) can both complete a full Create-then-Rent flow for the same physical bike on overlapping dates with zero pushback from the system -- the only thing that would catch it is a human noticing by eye before handing over keys. | Blocker -- this is a real operational/financial risk (a double-booked physical asset, not just a data-sync discrepancy), silent, and trivially reproducible with no special timing required. | **Found, not yet fixed** -- confirmed live against the deployed app on the isolated test account via direct API calls (bypassing no special UI trick -- the normal `addContract`+`editContract` flow contract.html itself uses). Test contracts (rows 1299, 1304) left in place as evidence/repro; not yet raised as a fix with Anton, flagging per his standing instruction to log bugs as found and keep testing. RECOMMENDATION for whoever picks this up: add an availability check (matching bikeModel + overlapping date range across other Rented/Pending Contract rows) to `addContractFromJson`/`editContractFromJson`, mirroring the kind of guard already proven out elsewhere in this codebase (e.g. the idempotency/conflict patterns in the same file) -- at minimum a clear warning, ideally a hard block with an override for legitimate same-day turnarounds. NUANCE found during 5.14 testing: `available-bikes.html` DOES correctly detect and exclude a bike with any active (non-Returned, not-yet-due) booking -- confirmed live, ZZTEST-Bike-01 and ZZTEST-Bike-02 both correctly did NOT appear in its "not rented right now" list while they had open bookings. So the protection that exists today is advisory-only: it only helps if staff happen to browse that separate page before creating a contract. The actual Create/Rent flow itself (`contract.html`'s main form, which is how staff normally book a bike -- especially a returning customer's usual named bike) performs NO check at all, so nothing stops a booking from going through even though the SAME data that would have flagged it on available-bikes.html was sitting right there in the Contract/customer sheets the whole time. | Blocker -- a real double-booked physical bike, not just a bookkeeping discrepancy. | **Fix applied 2026-09-04** (not yet pushed/deployed/retested -- see §0 handoff). Added a shared `findConflictingRentedContractRowB` overlap check, ported into `lib/contractWrites.js` (`markMatchingContractAsRentedFromJson`, `editContractFromJson`), `lib/customersWrites.js`'s own duplicate `markMatchingContractAsRentedFromJson`, and `lib/bikesWrites.js`'s `flipMatchingContractStatus`. `editContractFromJson`'s direct status-edit path now hard-blocks (throws) on a detected overlap; the concurrent customer-intake chains (which already treat the Rented flip as best-effort, wrapped in try/catch, per their own existing race-safety design) turn a detected overlap into a non-blocking warning instead -- the Contract row simply stays Pending rather than silently flipping to a double-booked Rented, with the reason surfaced to staff. Committed (not pushed -- see push commands in the handoff). STILL NEEDS: push + deploy + live retest exactly like BUG-01/02/03 got (re-attempt this same repro and confirm the second booking is now blocked/warned instead of silently succeeding). |
| **BUG-03** | Accounts — Expenses (`accounts.html`, expense-row rendering) | ACC-06 | 1. Accounts → September → Add Expense → description = `<img src=x onerror="window.zztestXssProbe()">ZZTEST XSS img-onerror test`, any amount/payment method → Save. 2. Reload/re-render the Expenses list (it re-renders automatically after save) and check whether the injected handler executed. | User-entered text (expense description) should be rendered as inert text no matter what it contains -- HTML/script content typed into a form field must never be interpreted as markup by the page that displays it back. | The injected `onerror` handler DID execute (confirmed via a harmless test probe function that set a flag when called) -- proof the expense-row renderer inserts this field via `innerHTML` (or equivalent) instead of `textContent`/`innerText`. A first probe with a literal `<script>alert(9)</script>` tag also confirmed a real (inert, non-executing per the `<script>`-via-innerHTML browser rule) `<script>` element was actually created in the live DOM, not just escaped text. Only the Expense description field was tested this way (time-boxed); the same free-text pattern likely exists on Income description/name and possibly other list-rendered fields on this and other pages -- worth a dedicated audit rather than assuming it's isolated to this one field. Real-world impact: any staff account (this app currently has no login allowlist -- already flagged separately) could plant a payload that runs in ANY other staff member's browser the next time they open Accounts for that month, e.g. to silently hit other API endpoints using that staff member's own session. | High -- genuine stored XSS with confirmed code execution, though it requires an already-authenticated staff account to plant (not exploitable by an outside member of the public), so not rated Blocker. | **FIXED & VERIFIED** (2026-09-03) -- root cause (unescaped `innerHTML` insertion of user-controlled text in `renderExpenses`/`renderIncome`/`openSaveReview`/`showCashDisambiguation` in `accounts.html`) fixed via a shared `escapeHtml()` helper applied to every affected field; deployed in commit `7e81625`. Retested live against the deployed app: the same `<img onerror>` XSS probe now renders as inert literal text (confirmed via DOM inspection -- no `<script>`/handler execution, no console errors), test row deleted afterward, balances confirmed back to baseline. Per Anton's instruction ("let's just fix all the bugs... retest them, and then continue"), fixed and retested in the same pass rather than left open. |
| **BUG-02** | Contract — Edit (`contract.html`, `editContractFromJson`'s deposit-ledger-sync block + `clearSecurityDepositAtRowFromJson` in `contractWrites.js`) | CTR-EDIT-02 | 1. Create+Rent a contract with Deposit = Scan, ฿3000 (e.g. ZZTEST Customer One / ZZTEST-Bike-01) -- confirm it appears on `deposits.html` under Bank for that customer, and the Contract row's own hidden deposit-ledger-reference column (col 37) holds a real reference string. 2. Search → open that contract → change Deposit from Scan to Cash → Save Changes. The app reports success (no error shown; in the live UI this reports via a suppressed native `alert()`, so I confirmed the actual outcome with a direct `editContract` API call instead, see below). 3. Re-check `deposits.html` and the Contract row's own deposit-ledger reference column. | Changing a Rented contract's Deposit method away from a ledger-tracked one (Scan/Wise/Revolut) to a non-tracked one (Cash) should clear the OLD ledger entry (this is exactly what the `oldDepositLower !== newDepositLower` sync block in `editContractFromJson` is FOR, per its own header comment) -- and only blank the contract's stored reference once that clear is confirmed to have actually happened. | The Contract row's deposit correctly shows "Cash" and its stored reference (col 37) was blanked to `''`, as if the old Bank entry had been successfully cleared -- but `deposits.html` still lists "ZZTEST Customer One -- ฿3,000.00" under Bank, and a direct fetch of the `September` sheet confirms that row is untouched (date/amount/name all still populated). So the clear silently did NOT happen, but the app believed it had and threw away the only breadcrumb (the reference) that would have let staff find and fix the orphaned entry later -- confirmed by then re-submitting the same edit a second time via the raw API: it now says *"could not be matched automatically (no reference stored on this contract)"*, i.e. the reference really is gone. Net effect: a customer's real security deposit can be silently double-counted forever (both stuck as an un-refundable-looking Bank ledger entry AND the contract itself now shows a different, untracked method), with no error or trace pointing anyone at the problem. Root cause not fully isolated (didn't dig into whether `clearSecurityDepositAtRowFromJson`'s `alreadyEmpty` pre-check is misreading the row, or the stored reference's row number was off from the start) -- flagging for a code-level look rather than guessing further. | Blocker -- this is a real, silent, un-traceable deposit-ledger discrepancy (money literally going untracked), on the exact class of financial figure this whole testing effort was commissioned to protect. | **FIXED & VERIFIED** (2026-09-03) -- root cause (`editContractFromJson`'s deposit-method-change block blanked the contract's own ledger reference without confirming the old ledger row was actually cleared) fixed by adding a real reference-based clear (`writeContractRefColumnFromJson` alongside the existing `clearSecurityDepositByRefFromJson` clear path), deployed in commit `7e81625`. Retested live end-to-end on a fresh Rented contract (Contract row 1300): changed Deposit method Scan->Wise -- confirmed via direct `/api/data/September` reads that the OLD Bank-category ledger row (row 7) was correctly blanked (date/amount/name all cleared) and a NEW Wise-category ledger row (row 6) was correctly created with the right name/amount/date, with the contract's own deposit-reference column updated to point at the new entry (`September|2026|wise|6`) -- no orphaned entry, no lost reference. |
| **BUG-01** | Contract — Edit (`contract.html`, `editContract`/`editContractFromJson` in `contractWrites.js`) | MBIKE-09 / CTR-EDIT-01 | 1. Create+Rent a contract paid by Cash (e.g. ZZTEST MultiBike Test / ZZTEST-Bike-01, ฿500, paid by cash) -- confirm September's Cash balance moves by ฿500. 2. Search → open that contract → change **Total price** only (500 → 700, payment method left as Cash) → Save Changes. 3. Re-check September's Cash balance and the income row on the `September` sheet. | Editing a Rented contract's total price (or paid-by method) should keep the Accounts income ledger in sync with the Contract sheet -- the two are meant to represent the same booking. | Contract sheet row correctly updates to 700 (confirmed via Search: "Paid: ฿700 via cash"), but the September sheet's income row (col G `ZZTEST-Bike-01 rent 2 days` / `ZZTEST MultiBike Test`) is untouched at the OLD amount (500), and the Accounts summary Cash/Income totals don't move at all. Root cause confirmed by code read: `editContractFromJson` (lib/contractWrites.js ~line 811) only re-syncs the **security deposit** ledger when the Deposit method changes (`oldDepositLower !== newDepositLower` block) -- there is no equivalent sync for the **income/cash ledger** anywhere in this function, for either a Total price change or a Paid-by change. The income row is only ever written once, at Rent time (`customerIntake`/`doRent`), and `editContract` never revisits it. Net effect: the Contract sheet and the Accounts sheet can silently disagree on how much a rental actually earned, with no warning to staff, indefinitely -- exactly the class of discrepancy this whole testing effort exists to catch. **CONFIRMED to also cover CTR-DEL-CASCADE-01** (canceling a RENTED contract, not just editing its price): set a separate clean Rented ฿800-cash contract (ZZTEST MultiBike Test / ZZTEST-Bike-02) straight to Status=Canceled via the same `editContract` action -- September's Cash balance did not move at all (stayed at ฿33,291 before and after), confirming a canceled-after-rented booking's income is never reversed either, same root cause (editContract's blanket lack of any income-ledger sync, regardless of which field changed). | High -- silent financial-figure mismatch, no error/warning shown, would require staff to manually notice and hand-fix the Accounts sheet. Not rated Blocker only because it needs a specific edit-after-rent action (not the default create/rent path, which IS correct per CTR-08/MBIKE-07 above) and doesn't lose or duplicate data, only leaves it stale. | **FIXED & VERIFIED** (2026-09-03) -- root cause (`editContractFromJson` had zero income/cash-ledger sync for a Rented contract's Total price, Paid-by, or Status changes) fixed by adding reference-based reconciliation (new income/cash ledger reference columns 40/41 on the Contract sheet, written at Rent time via `buildIncomeRefB`/`buildCashRefB`, patched or cleared on edit via `patchOrClearIncomeRowFromRefFromJson`/`patchOrClearCashRowFromRefFromJson`), deployed in commit `7e81625`. Retested live end-to-end on a fresh Rented cash contract (Contract row 1300, ZZTEST BugRetest Two) through 3 scenarios, each confirmed via direct `/api/data/<sheet>` reads AND cross-checked against the Accounts summary page: (1) **price-only change** (600->900, still Cash) -- income row amount patched 600->900, Accounts Cash balance moved by the exact +300 delta (฿34,314->฿34,614); (2) **paid-by change** (Cash->Wise, price unchanged) -- old Cash ledger row fully cleared, Wise running total incremented by the contract amount (+900, ฿6,200->฿7,100), Accounts Cash balance dropped back by 900 (฿34,614->฿33,714), income row's payment method patched to 'wise' with amount preserved; (3) **status leaving Rented** (Rented->Returned) -- income row fully cleared/blanked and its ledger reference removed, Wise running total correctly reversed by -900 back to its pre-rent baseline (฿7,100->฿6,200). All three scenarios also confirmed the deposit ledger (BUG-02's concern) was left untouched, correctly isolated from this income/cash sync. |

## 7. Progress tracker

| Date | Area tested | Cases run | Pass | Fail | Notes |
|------|-------------|-----------|------|------|-------|
| 2026-09-03 | Plan written (this file + `TESTING-METHODOLOGY.md`) | 0 | — | — | Plan only, per Anton's explicit request — no live testing yet. Waiting on a fresh login. |
| 2026-09-03 | 5.1 Auth & login (`login.html`) | AUTH-01, AUTH-03, AUTH-04, AUTH-05 | 4 | 0 | Tested on `anton.voicemail@gmail.com` (dedicated test account, NOT the live AA Scooters account — Anton's explicit instruction, see below) [corrected 2026-09-03: this account name was wrong -- the actual isolated test account is `anton.weiersmuller@gmail.com`, see §0]. AUTH-01: valid login lands on `index.html` — pass. AUTH-03: session cookie is `Max-Age=180 days` (`lib/session.js`) — long-lived by design, not tested to actual expiry (impractical). AUTH-04: Sign Out (settings.html) redirects cleanly to `login.html` — pass. AUTH-05: direct nav to `bikes.html` while logged out redirects to `login.html?next=%2Fbikes.html` (client-side redirect per `nav.js`'s auth-gate; real security boundary is server-side in every `/api/data`/`/api/write` route per `lib/apiAuth.js` — confirmed by code read, not separately re-tested here). AUTH-02 (wrong password) N/A as originally scoped — this app uses real Google Sign-In (`api/auth/callback.js`), there is no app-level password to get wrong; Google's own consent screen owns that. NOTE (not a bug, a real finding): `api/auth/callback.js` has NO email/domain allowlist — any Google account can sign in and get a full staff session. Flagged to Anton live; he said leave it for now (test-only concern for this pass). |
| 2026-09-03 | 5.13 Add Bike / Fleet (`add-bikes.html`) — addBike + `bike-name-audit.html` | FLEET-01, AUDIT-01 (partial) | 2 | 0 | FLEET-01: `addBike` on `ZZTEST-Bike-01` (Yamaha Aerox, 155CC Standard Key, ฿35,000/฿2,000/0km) — POST `/api/bikes/write` returned `{success:true}` with a real warning worth keeping: "Bike Tax: the Status and day-count columns (G/H) are formulas in the live sheet with no equivalent here -- left blank for this new row." New bike appeared instantly on add-bikes.html's own list (no reload) AND on bikes.html as "NOT RENTED" (fresh nav, not a hard reload) — pass. Contract-picker / Available-Bikes cross-check still pending. AUDIT-01: ran `bike-name-audit.html` against the real seeded Jan-Aug data (not a synthetic case yet) — tool correctly surfaced 15 real pre-existing inconsistencies (e.g. "Aerox Red" vs "Aerox red 1", "GT black 6" vs "Gt black 6", case-only diffs on "Nmax grey 1"/"Nmax Grey"). Confirms the detector genuinely works. NOT YET DONE: the deliberate-ZZTEST-mismatch case from the written plan (create one on purpose, confirm flagged, remove). FINDING (not yet a filed bug — needs a second look): bikes.html showed a bike as "Cbr" while add-bikes.html's own fleet list (sourced from Bike Tax) shows the same bike as "cbr 150" -- a real 3-way naming split between the "bikes"/Operation sheet and Bike Tax. `bike-name-audit.html` does NOT catch this class of mismatch at all -- it only cross-checks Bike Tax vs Parts & Oil vs Customer, never against the "bikes"/Operation sheet that bikes.html itself renders from. Worth deciding whether that's in-scope for the audit tool. |
| 2026-09-03 | 5.13 Add Bike / Fleet (`add-bikes.html`) — editBike + sellBike + unsellBike | FLEET-02 | 3 | 0 | All three verified via direct `/api/data/<sheet>` reads after each action (never trusting the UI success message alone, per methodology). **editBike**: changed ZZTEST-Bike-01's Model Year 2024→2025 and Purchase cost 35000→36000 — confirmed persisted on `Bike_Tax` (Model Year col) and `bikes` (cost col) — pass. **sellBike**: sold ZZTEST-Bike-01 for ฿15,000 — confirmed `bikes` sheet `total` column +15,000, `bikes_notes` sidecar recorded `{soldAmount:15000, soldDate, soldByTxnId}`, UI moved the bike into the SOLD section with "Sold for ฿15,000 on 03/09/2026" — pass. NOTE (not a bug, a resilience finding worth keeping): the single "Confirm sell" click fired **3** near-simultaneous `POST /api/bikes/write` requests (all 200) — likely the app's own retry-on-conflict logic reacting to a 409 from concurrent writes to the same Drive file. The `clientTxnId` idempotent-replay guard in `sellBikeFromJson` worked exactly as designed: the total was incremented exactly once (15000, not 45000) and only one sold-note was written. Confirms the idempotency guard is doing real, necessary work, not just decorative. **unsellBike**: reversed the same sale — `bikes` sheet `total` back to 0, `bikes_notes` sidecar replaced with a tombstone (`soldAmount:null, unsoldByTxnId, reversedAmount:15000`), UI moved the bike back out of the SOLD section into the active list — pass. |
| 2026-09-03 | 5.13 Add Bike / Fleet — FLEET-01 cross-entry-point follow-up | FLEET-01 (cross-check) | 1 | 0 | Confirmed ZZTEST-Bike-01 appears correctly in Contract's bike-model typeahead (`contract.html`, typed "ZZTEST" → suggested) and in `available-bikes.html`'s "Not rented right now" list, both on a fresh page load with no special cache-busting needed — closes out the pending cross-entry-point check from FLEET-01. |
| 2026-09-03 | 5.2 Contract — Create (`contract.html`, single bike) | CTR-01, CTR-02, CTR-03, CTR-04, CTR-05, CTR-06, CTR-07, CTR-08 | 8 | 0 | **CTR-01**: full contract (every optional field: nationality, passport, number, WhatsApp contact, deliver-to-hotel Yes + link, Deal checkbox, Scan deposit ฿3000, delivery fee ฿100) on ZZTEST-Bike-01 — saved as status "Pending" (NOT auto-Rented — see finding below), all fields confirmed byte-for-byte on the `Contract` sheet via direct API read. Took ~15s end-to-end (create → receipt → checklist) — slow but completed, worth knowing if a staff member is tempted to double-tap out of impatience (see CTR-07). **FINDING (not a bug, a real behavior worth flagging)**: every contract created via `contract.html`'s main form lands as status **Pending**, not Rented — it only becomes Rented (and only THEN hits the cash ledger / deposit ledger) once pulled through "Pending contracts" → Rent. Confirmed by watching September's Cash balance stay flat at a Pending save and jump by the exact total only after clicking "Yes, rent it". This is the correct, intended cascade (matches PEND-04's concern) but worth Anton knowing if he ever expected a Cash-paid walk-in contract to hit the ledger immediately on Create. **CTR-02** (minimal fields — name/bike/dates/price/paid-by only, everything else blank): saved cleanly, no errors from the blank optional fields — pass (reused the CTR-07 double-submit contract below as this case too, since it was minimal by design). **CTR-03** (total price ฿0): accepted without any rejection or warning — comped rentals ARE currently allowed through this form. Flagging for Anton to confirm this is the intended behavior, not filing as a bug since nothing crashed or corrupted data. **CTR-04** (blank required field — submitted with everything empty): correctly blocked client-side via native HTML5 `required` validation (`name` field's `validity.valid === false`, `"Please fill in this field."`) — confirmed via network log that NO request reached the server — pass. **CTR-05** (bike model not on the fleet, `"ZZTEST-Nonexistent-Bike-XYZ"`): correctly blocked with a clear on-page message ("...doesn't match any bike on the fleet list. Please pick a real bike from the suggestions..."), `validateBikeModelOrShowPicker` working as designed — pass. **CTR-06** (adversarial input — `<script>alert(1)</script>ZZTEST 测试テスト ทดสอบ" onmouseover=alert(2) //` as the name, `<img src=x onerror=alert(3)>` in passport, a 500-char nationality string): contract saved successfully with the raw text preserved as-is; checked the two highest-risk render surfaces — the create-success toast AND the Search results list — both display the payload as inert literal text, no script execution, no console errors, no alert dialogs fired. No XSS found — pass. **CTR-07** (double-submit — clicked "Create contract" 3x rapidly): only ONE success toast shown; confirmed via `/api/data/Contract` that exactly 1 row was created, not 3 — the idempotency/submit-lock protection works — pass. **CTR-08** (cascade, paid by Cash): covered as part of CTR-01's Pending→Rent flow above — Cash balance moved by exactly the contract total (฿2,500) only at the Rent step, and the Scan deposit (฿3,000) correctly appeared on `deposits.html` under the Bank table against the customer's name — pass. Wise/Revolut cascade not yet separately tested (still pending). CTR-09 (file upload in contract-create context) deferred to §5.9's dedicated file-upload pass. |
| 2026-09-03 | 5.3 Contract — Multi-bike manual amounts | MBIKE-01..04, MBIKE-07, MBIKE-09 | 6 | 1 | Added a second test bike (ZZTEST-Bike-02, Honda PCX) to have a real 2-bike case. **MBIKE-01**: "+ Add another bike" correctly shows a per-bike amount box for BOTH the primary AND the new bike, and Total price switches to a read-only, auto-calculated field — pass. **MBIKE-02**: entered 500 / 800 — Total price live-updated to exactly 1300 as typed — pass. **MBIKE-03**: submitted with the 2nd bike's amount blank — blocked with "Please enter an amount for 'ZZTEST-Bike-02'.", focus correctly landed on that exact box, nothing saved — pass. **MBIKE-04**: submitted with both filled (500/800) — confirmed via `/api/data/Contract` that exactly 2 rows were created sharing one `linkedGroupId`, `linkedBikeIndex` 0/1, each with its OWN amount as `totalPrice` (500 and 800, NOT an even 650/650 split) — pass. **MBIKE-07**: rented the linked pair via "Rent all 2" (took ~30s — noticeably slower than a single-bike rent's ~15s, worth knowing but not a failure) — September Cash moved by exactly ฿1,300 (the COMBINED total), not just one bike's share — confirms this app does NOT have the `property-app`-style "one bike's share used where the combined total should be" bug — pass. **MBIKE-09**: edited ONLY the ZZTEST-Bike-01 linked row's Total price (500→700) via Search → Edit → Save — confirmed via Search that only that one row changed to ฿700 and its sibling (ZZTEST-Bike-02, ฿800) was untouched, so the per-row edit isolation itself works correctly — pass on that specific point. **BUG-01 found via MBIKE-09** (see §6): that same edit does NOT update the Accounts income ledger — September's Cash balance and the underlying income row both stayed at the pre-edit ฿500 after the Contract sheet was correctly updated to ฿700. Confirmed via code read that `editContractFromJson` only syncs the security-deposit ledger on a method change, never the income/cash ledger, for either a Total price or Paid-by edit. Filed as **BUG-01**, severity High. NOT YET DONE: MBIKE-05 (remove 2nd bike back to 1), MBIKE-06 (3+ bikes), MBIKE-08 (PDF combined-total display), MBIKE-10 (form reset after multi-bike save — informally observed already reset correctly during MBIKE-04's flow, but not yet a dedicated check). |
| 2026-09-03 | 5.3 Contract — Multi-bike, remaining cases (MBIKE-05/06/08/10) | MBIKE-05, MBIKE-06, MBIKE-08 (blocked — env), MBIKE-10 | 3 | 0 (1 untestable in this env) | Added ZZTEST-Bike-03 (Yamaha Nmax) for a 3-bike case. **MBIKE-05**: removed the 2nd bike from a 2-bike draft — its amount box disappeared correctly and Total price became editable again, RETAINING the last computed sum (700) rather than clearing — this matches one of the two behaviors the plan explicitly allowed ("or does it need clearing? — confirm intended UX"); flagging for Anton to confirm this retained-value behavior is what he wants, not filing as a bug. **MBIKE-06**: 3-bike contract (ZZTEST-Bike-01/02/03 at 300/400/600, Total auto-summed to 1300) — confirmed via `/api/data/Contract` that all 3 linked rows saved with the correct amount mapped to the correct bike (no off-by-one), same shared `linkedGroupId`, sequential `linkedBikeIndex` 0/1/2 — pass. Also noted in passing: bike-line element IDs are never reused within a session (removing bikeLine_1 then adding two more produced bikeLine_2/bikeLine_3, not a reused _1) — harmless, just an implementation detail. **MBIKE-10**: confirmed directly (not just inferred) — immediately after clicking Create on the 3-bike contract, the form's bike-line inputs, name, and total price were all already cleared, before the background save even finished — no stale carried-over fields — pass. **MBIKE-08 — BLOCKED, environment gap, not an app bug**: "View Contract" → "Update Contract" (the actual rental-agreement PDF, distinct from the Receipt/Checklist PDFs which both work fine) fails with `POST /api/contracts/generate` → 500: *"Could not find the contract template Doc ('AA Scooter Rental Agreement - MASTER TEMPLATE (do not edit fields)') inside the 'AA Scooters Contracts' Drive folder."* This is because the isolated test account's Drive only has the 27 seeded JSON data files (from "Reset data from latest deploy") — the master template Doc itself lives directly in Drive, outside that JSON dataset, and was never copied over. Can't test MBIKE-08's actual PDF content (every bike + combined total) until either that template Doc is copied into the test account's "AA Scooters Contracts" folder, or this is accepted as an out-of-scope gap for this test pass. |
| 2026-09-03 | 5.4/5.5 Contract — Search/Edit/Cancel + Pending flow | CTR-EDIT-01, CTR-EDIT-02, CTR-CANCEL-01, CTR-DEL-CASCADE-01, PEND-01, PEND-02, PEND-04 | 5 | 2 | **CTR-EDIT-01**: edited a Rented contract's Total price individually (covered under BUG-01 above) — the field itself DOES save and only that row changes (per-row isolation confirmed via MBIKE-09), so the edit mechanism itself works; it's specifically the downstream ledger sync that's missing. **CTR-EDIT-02 → BUG-02** (see §6): changing a Rented contract's Deposit method (Scan→Cash) reported success but silently failed to clear the old Bank ledger entry AND discarded the only reference that could find it again — filed as Blocker. **CTR-CANCEL-01**: canceled a still-PENDING contract (ZZTEST DoubleSubmit Test) via the Pending-contracts picker's own Cancel flow — status correctly flipped to "Canceled", confirmed via API — pass (this path uses the separate, correctly-guarded `cancelContract` action, not `editContract`, and explicitly refuses anything not still Pending). **CTR-DEL-CASCADE-01 → folds into BUG-01** (see §6): setting an already-RENTED cash contract straight to Status=Canceled via edit does NOT reverse its cash-ledger entry either — same root cause as BUG-01 (editContract never touches the income ledger for any field). **PEND-01**: covered under CTR-01 above (create → Pending → Rent, fields carried over correctly). **PEND-02**: same as CTR-CANCEL-01 above — canceling a Pending contract from the picker works correctly. **PEND-04**: confirmed — renting via the Pending picker (`customerIntake`) DOES hit the same real cash-ledger append path as expected; the cash/deposit correctness already verified under CTR-08/MBIKE-07 all went through this exact path (there is no separate "direct Contract creation" path that skips Pending — every contract created via the main form lands as Pending first, per the CTR-01 finding). NOT YET DONE: PEND-03 (multi-bike group Cancel-all — only Rent-all was exercised via MBIKE-07/06; a dedicated Cancel-all check on a linked group is still open), a full field-by-field CTR-EDIT-01 sweep (name/nationality/dates/etc individually, not just price/deposit). |
| 2026-09-03 | 5.5 Pending contracts — PEND-03 | PEND-03 | 1 | 0 | "Cancel all 3" on the ZZTEST ThreeBike Test linked group — confirmation panel correctly showed all 3 bikes and the Combined total (฿1300) before confirming, and after confirming all 3 linked Contract rows flipped to "Canceled" together, not just the one clicked into — pass. |
| 2026-09-03 | 5.6 Accounts — Expenses & Income CRUD | ACC-01, ACC-02 (Scan only), ACC-03, ACC-04, ACC-05, ACC-06 | 6 | 1 (BUG-03) | **ACC-01**: added a Bank-paid business expense (฿250) — Bank correctly dropped ฿8,239→฿7,989, Total/Business expenses and Net profit all recalculated correctly — pass. **ACC-02**: added a Scan-paid income (฿150) — Bank correctly rose ฿8,239→฿8,389 (Scan income lands on Bank, same as Scan deposits do), Total income/Net profit recalculated correctly — pass on Scan; Wise/Revolut/Cash not separately re-tested here (Cash already proven via the Contract cash-cascade tests above, and the code path is shared/symmetric with expenses' 4 methods which all resolved to the right account). **ACC-03**: edited that same expense's amount 250→400 — Bank moved by exactly the ฿150 delta (not a duplicate or a flat overwrite), Total expenses and Net profit recalculated correctly — pass. Worth noting for contrast: THIS edit path (Accounts' own expense/income edit) correctly re-syncs the ledger on every change, unlike Contract's `editContract` (BUG-01) — the bug is specific to Contract editing, not a systemic gap in this app. **ACC-04**: deleted the same expense — Bank and every summary figure returned exactly to the pre-ACC-01 baseline — pass. **ACC-05** (฿0.00 amount): added and saved cleanly, no crash, no recurrence of the historical `money()` bug — pass. **ACC-06 → BUG-03** (see §6): a `<script>` tag typed into the expense description was actually inserted into the live DOM (confirmed via `document.querySelectorAll('script')`, not just displayed as text); a follow-up `<img onerror>` payload in the same field ACTUALLY EXECUTED (confirmed with a harmless test probe) — this is a real, working stored XSS, filed as Blocker-adjacent High. Both test rows deleted afterward, balances confirmed back to baseline. NOT YET DONE: ACC-07 (Expense Type dropdown persistence after a genuine full page reload, as opposed to the same-session recalculation checks above). |
| 2026-09-03 | 5.13 Add Bike / Fleet — FLEET-03 | FLEET-03 | 1 | 0 | Re-ran `bike-name-audit.html` after all the add/edit/sell/unsell activity on ZZTEST-Bike-01 — it does NOT appear in the mismatch output, confirming the audit tool picks up fresh data correctly (no stale cache) and that `addBike`/`editBike` wrote consistent names across `Parts_and_Oil_change`/`Bike_Tax`/`bikes` (no false positive introduced by testing). Closes out §5.13 — FLEET-01, FLEET-02, FLEET-03 and AUDIT-01 (partial, real-data pass) all done. |
| 2026-09-03 | Bug-fix pass: BUG-01, BUG-02, BUG-03 (per Anton's explicit instruction to fix all 3 then retest) | BUG-01 (3 scenarios), BUG-02, BUG-03 | 5 | 0 | Fixed all 3 previously-filed bugs in `lib/contractWrites.js`, `contract.html`, `accounts.html` (see §6 for full root-cause/fix detail on each), committed as `7e81625`, pushed to `origin/main` and confirmed deployed on Vercel. Retested every fix live against the deployed app using two fresh test contracts (ZZTEST BugRetest One row 1299, ZZTEST BugRetest Two row 1300) plus direct `/api/contract/write`/`/api/data/<sheet>` calls for precise before/after verification (not just UI reads). **BUG-03**: XSS probe re-run, confirmed inert (no execution) — pass. **BUG-02**: Deposit method changed Scan->Wise on a Rented contract — old Bank ledger row correctly cleared, new Wise ledger row correctly created, contract's stored reference correctly repointed — pass. **BUG-01**: three sub-scenarios all pass — price-only change (income row + Accounts Cash balance both moved by the exact delta), paid-by change while staying Rented (old Cash entry cleared, new Wise running total incremented, income row's payment method patched), and status leaving Rented i.e. Rented->Returned (income row fully cleared, Wise running total correctly reversed). All three bugs now marked FIXED & VERIFIED in §6. Also corrected this file's test-account identity (§0 and the AUTH-01 row above) from `anton.voicemail@gmail.com` to `anton.weiersmuller@gmail.com` per Anton's live correction. NOT yet cleaned up: the two new ZZTEST BugRetest contracts and their income/cash/deposit ledger rows created for this retest — left in place per this file's standing note that cleanup hasn't been requested since the account gets wiped for a second full round later. |
| 2026-09-04 | 5.10 Deposits (`deposits.html`) | DEP-01, DEP-02, DEP-03, DEP-04 | 4 | 0 | Tested via direct `/api/accounts/write` calls against real ZZTEST contracts (rows 1299/1300/1301), verified via direct `/api/data/<sheet>` reads before/after every call — code read first (`lib/depositsWrites.js`) to understand each action's exact write scope before testing it. **DEP-01**: `deductDeposit` tested both branches of its Contract-row mirror — (a) against a Rented contract (row 1299, Scan/Bank ฿3000 deposit): deposit-log balance correctly reduced 3000→2500, a new Income row correctly appended (amount/name/paidBy all correct), Contract row's own depositAmount correctly mirrored 3000→2500, and a Contract_notes reversal-audit line was correctly written — pass; (b) against a non-Rented (Returned) contract (row 1300, Wise ฿3000 deposit): deposit-log balance still correctly reduced 3000→2000 and Income row appended, but the Contract-row mirror was correctly SKIPPED (by design — `findRentedContractRowForDeductionFromJson` only matches status='Rented') with no warning thrown — confirms the mirror's Rented-only gate works exactly as coded, not a bug. **DEP-02**: `deductCashDeposit` against a customer whose deposit method is Scan (not Cash) correctly returned `{success:true, applied:false, message:'No cash deposit on file...'}` with NO write of any kind (verified the Contract row's depositAmount was untouched) — matches documented behavior exactly — pass. **DEP-04**: cross-checked `deductDeposit` (writes deposit-log + Income row + Wise/Revolut running total + bikes-sheet earnings + best-effort Contract mirror, confirmed above) against `deductCashDeposit`'s happy path (created a fresh Rented contract with a real Cash ฿1000 deposit, row 1301; deducted ฿300 — response `{applied:true, newAmount:700}`, Contract depositAmount correctly 1000→700, a Contract_notes line correctly written, and confirmed deductCashDeposit writes ONLY the Contract sheet, no Income row, no cash-ledger row, no bikes-sheet touch — exactly as its own header comment states) — both paths land on the correct balance via genuinely different code paths — pass. **DEP-03**: `editDeposit` (wise entry amount 2000→1800, name/date changed) and `deleteDeposit` (same entry, cleared) both correctly touched ONLY that category's 3 cells (date/amount/name), leaving the adjacent Bank category entry and the Income-side columns in the same physical row completely untouched — pass. No bugs found in this area. Also incidentally confirmed the earlier BUG-02 fix's "Bank" card formula behavior (P15 deposit-log sum feeding directly into the Bank summary figure) is pre-existing, correct, intentional app design, not a side effect of that fix — see code comment at `accounts.html` ~line 2082 (`M6 "bank" = ... + P15 - M11 - M12`). |
| 2026-09-04 | 5.11 Customers (`customers.html`) | CUST-01, CUST-02, CUST-03 | 3 | 0 | **CUST-01**: `customerIntake` (customers.html's own direct-entry copy, in `lib/customersWrites.js`) tested live via `/api/accounts/write` -- full valid record (name/contact/nationality/passport/bike/dates/price/paidBy/deposit) correctly appended as a new row on the `customer` sheet, row count incremented by exactly 1, every field landed correctly -- pass. Noted in passing (not a bug): the stored `contact` value gets an auto-appended annotation, e.g. `+66123456789 (฿600, 2 days)` -- confirmed intentional, this is `syncDueBackEventForCustomerRow`'s calendar-event-summary text, not data corruption. **CUST-02 resolved (was a documentation mystery, not a real action)**: grepped the entire codebase (`customersWrites.js`, `customers.html`, `Code.gs`) for `'march'` as a dispatch case/action name -- it does NOT exist. `DEPOSITS_MONTH_NAMES` is a plain array of month-sheet-tab names, and (per the code's own comment) the lowercase `'march'`/`'april'`/`'may'` entries are verbatim copies of the real spreadsheet's own idiosyncratically-lowercase tab names for those 3 months only (every other month is capitalized) -- a real, worth-knowing sheet-naming quirk, but not an action needing its own test case. Correcting this file's earlier framing: there is no `march` action to test. **CUST-03**: confirmed BOTH via code read AND live side-by-side test that Contract's own Rent-flow `customerIntake` (`lib/contractWrites.js`) and customers.html's direct `customerIntake` (`lib/customersWrites.js`) produce byte-for-byte equivalent `customer`-sheet records -- same 16-column field mapping in the same order, same auto-annotated contact format, same `source:'Direct'` default. Live test: created one customer through each entry point with matching input data (rows 1323 and 1324) -- output rows are identical apart from the input fields themselves. No bugs found in this area. |
| 2026-09-04 | 5.12 Bikes Status (`bikes.html`) | BIKE-01, BIKE-02, BIKE-03, BIKE-04, BIKE-05, BIKE-06 | 6 | 0 | All 6 write actions tested live via `/api/bikes/write`, code-read first (`lib/bikesWrites.js`) to understand exact write scope, verified via direct `/api/data/<sheet>` reads. Built matching Rented Contract-row + customer-row pairs for each test (ZZTEST bikes/contracts) since `bikes.html` operates on the `customer` sheet primarily and cross-syncs to `Contract`. **BIKE-01** `markReturned`: customer row's returnDate/situation correctly updated, AND the matching Rented Contract row's status correctly cascaded to Returned via `flipMatchingContractStatus` (name+bike match) -- pass. **BIKE-02** `extendBike`: due-back date correctly pushed forward by the given days on the customer row, total price correctly incremented by the extra amount paid, AND both correctly cascaded to the Contract row (return date + total price sync) and to the Cash ledger (+exact amount) and bikes-sheet monthly earnings -- pass, no stale-Contract-vs-customer-sheet drift found. **BIKE-03** `earlyReturnBike`: confirmed by code read AND live test that this genuinely differs from `markReturned` -- it supports an optional refund (reduces total price on both customer AND Contract rows by the refund amount, and pays it back out through the real Cash/Wise/Revolut ledger as a negative amount) in addition to the same Returned-status flip; live test refunded ฿100 of a ฿600 booking -- customer+Contract totalPrice both correctly dropped to ฿500, Cash correctly dropped by exactly ฿100 -- pass. **BIKE-04** `swapBike`: confirmed the old bike's customer row is correctly closed out (situation→Returned, price set to the given `returnAmount`) while a NEW customer row is correctly created for the new bike (carrying over the due date, priced at `newBikeAmount`) -- no state where both or neither show as rented. The Contract side does NOT create a duplicate row -- it RENAMES the existing Rented Contract row's bikeModel in place (`renameContractBikeOnSwapFromJson`), confirmed live (Contract row correctly flipped from ZZTEST-Bike-03 to ZZTEST-Bike-02, same row, same status) -- pass. **BIKE-05**: read the code for both undocumented-by-name actions before testing, per the plan's own instruction. `closeBikeForExtendFromJson` is the "long extension" half-step -- flips situation→Returned on the OLD row only (no price/refund logic at all), paired with a SEPARATE `customerIntake` call (source:'extend') that creates the continuation row -- bikes.html fires these as two sequential requests, not one atomic action (confirmed by the file's own comment). Has a safe idempotent "already closed" short-circuit. `updateReturnPickup` is a plain field overwrite for a CONFIRMED pickup/return time distinct from the originally scheduled return date -- writes returnTime (col J), a `timeConfirmed` flag, `confirmedReturnDate`, and `deliveryLink`, deliberately NOT the main returnDate column, and moves no money -- confirmed live (all 4 fields landed correctly). Minor observation, not filed as a bug: it accepted an update against an already-Returned row with no rejection -- harmless (pure metadata, no financial impact) but worth Anton knowing if he'd expect it locked. **BIKE-06** `returnDeposit`: confirmed it both clears the deposit-log entry (date/amount/name all blanked, same as `deleteDeposit`) AND optionally logs a kept-fee deduction as Income (same balance-impact mechanics as DEP-01's `deductDeposit`, §5.10) in one action -- live test (bank/Scan deposit, ฿200 damage-fee deduction) correctly cleared the old ฿2,500 entry and logged the ฿200 income; the Bank summary card's resulting -฿2,300 net change was hand-verified against its own formula (-฿2,500 deposit-log removal +฿200 new Scan income, per the `M6` formula documented in `accounts.html`) and confirmed correct, not a bug -- pass. No bugs found anywhere in this area. |
| 2026-09-04 | 5.15 Concurrency / multi-staff simultaneous use | CONC-01, CONC-02, CONC-03 | 1 | 2 | Tested via genuinely concurrent (`Promise.all`-fired) and back-to-back sequential API calls against the live deployed app, not simulated -- real race conditions against real Drive-backed JSON files. **CONC-01 → FAILS (silent data loss, not yet filed as its own bug -- see note below)**: two `editExpense` calls against the SAME expense row, each changing a DIFFERENT field (amount vs payment method) as if two staff had the same expense open in separate tabs -- both requests returned `{success:true}` with NO conflict/warning, but the final row only reflects the SECOND request's fields; the FIRST request's field change was silently discarded with no trace, reproduced twice in a row (100%). Root cause confirmed by code read: `editExpenseRowFromJson`'s core write (`lib/accountsWrites.js` ~line 2028) does a single unconditional `writeSheetJson` of all 4 columns (date/expense/amount/payment) using whatever the CALLING client submitted for every field -- there is no optimistic-concurrency retry AND no partial/field-level merge, so a client's stale copy of an untouched field silently overwrites a concurrent edit to just that field. This is the SAME class of bug as BUG-01/02 (silent financial-data loss, no error shown) but on the base Expense/Income edit path specifically, not Contract editing. NOT yet filed as its own BUG-0N number -- flagging here for Anton to decide whether this warrants the same treatment as BUG-01/02/03 (recommend it does, given the established severity bar this session). **CONC-02 → PASSES**: two `editExpense` calls racing a TYPE change (`expenseType`) on the same row -- correctly resolved to ONE consistent, clean value (no corruption, no duplicate entries, no silent total loss) via the `applyMonthNotesEditsFromJson` 3-attempt retry-on-conflict + patch-reapply pattern (the historical fix from §8 item 3) -- confirms that fix genuinely works under a real concurrent race, not just in isolation. **CONC-03 → FAILS, filed as BUG-04 (Blocker)**: attempted to book the same physical bike twice for overlapping dates -- succeeded on the FIRST try with plain sequential (non-racing) calls, no concurrency needed at all. See §6 BUG-04 for full detail: `addContractFromJson`/`editContractFromJson` have NO bike-availability/date-overlap check whatsoever. This is more severe than a race condition -- it's a complete absence of the validation. |
| 2026-09-04 | 5.9 File uploads (passport photos, bike photos, WhatsApp AI fill) | FILE-01, FILE-02, FILE-03, FILE-04 (partial) | 3 | 0 (1 minor finding) | Discovered mid-test that the passport-photo upload code visible earlier in `contract.html` (with the `passportPhotoBase64` field bundled into `addContract`) is `__deadCode_oldAddContractFromJson` -- explicitly dead, unreferenced client-side code kept only for comparison. The LIVE path uploads the photo as a genuinely separate follow-up call to `/api/contracts/upload` AFTER the Contract row save succeeds (confirmed by code comment: "deliberately NOT part of the queued request"). Tested that live endpoint directly, plus its bike-photos counterpart (`/api/photos/upload`+`/delete`, used by `bikephotos.html`, a different feature from `bikes.html`). **FILE-01**: valid PNG upload -- pass, file created in the correct per-customer Drive folder with the expected `Photo of Passport - <name> - <date>` naming convention. **FILE-02**: 0-byte upload correctly rejected (400, "Missing photo data."); a non-image mimeType (`application/pdf`) correctly rejected (400, "Only image files can be uploaded here.") -- both clean rejections, no crash, pass. Minor finding, not filed as a bug (plan asked for "clear rejection, no crash" -- this technically half-holds): garbage/invalid base64 text claiming `mimeType:'image/jpeg'` was NOT rejected -- Node's `Buffer.from(str,'base64')` silently strips invalid characters instead of throwing, so a corrupted or fake-extension file is silently accepted and stored as a `.jpg` that will show as broken/unreadable whenever anyone actually opens it. Low real-world severity (immediately visible to whoever opens it, not a silent financial-data issue like BUG-01/02/04) but worth Anton knowing -- true image-content validation (e.g. checking real magic bytes) is not happening anywhere in this upload path. **FILE-03**: tested via the bike-photos flow (passport photos have no delete capability in this app at all -- confirmed by code read, add-only by design, duplicate-detected rather than replaceable) -- uploaded, listed, deleted, and confirmed GENUINELY gone via a fresh server-side `/api/photos/list` re-fetch (not just hidden client-side) -- pass. **FILE-04 (partial -- code read only, not live-tested)**: confirmed by code read that "Fill from WhatsApp (AI)" is a pure form-autofill helper -- it reads name/phone off a screenshot into the Number/Chat-name fields for staff to review before saving, and explicitly never uploads, saves, or sends anything anywhere (confirmed via the feature's own code comment) -- the "does NOT auto-send" safety property the plan asked about is satisfied by the feature's basic design, not just a policy. The "garbled screenshot degrades gracefully" behavioral question was NOT live-tested (would need a real AI call with a deliberately bad image) -- left open for a future pass if Anton wants it. |
| 2026-09-04 | 5.14 Read-only / secondary pages (partial: AVAIL-01, INCOME-01) | AVAIL-01, INCOME-01 | 1 | 1 | **AVAIL-01 → PASSES**: `available-bikes.html` correctly excludes ZZTEST-Bike-01 and ZZTEST-Bike-02 from its "not rented right now" list (both have genuinely active, non-Returned bookings on the customer sheet -- confirmed by direct API cross-check) while correctly including ZZTEST-Bike-03 (returned via our earlier swap test). Confirms this page's availability derivation (scan `customer` sheet for situation != Returned AND returnDate in the future, matched by bike name) works correctly -- also directly relevant to BUG-04: this page WOULD have warned a staff member who checked it first, the protection gap is specifically that the Create/Rent flow itself never consults this same data. **INCOME-01 → FAILS, filed as BUG-05 (High)**: see §6 for full detail -- `bike-income.html`'s main Income/Profit/Net Profit table reads a separate `total`/`profit`/`net profit` column on the "bikes" sheet that is NEVER recomputed by any of the actual rental-income write paths (only by Accounts' own "split across bikes" feature) -- confirmed live (ZZTEST bikes show ฿0 Income despite verified real month-column income) and via full code-path trace (grepped every call site of the one function that DOES recompute it). The rest of §5.14 (PRICE-01, CAL-01, OIL-01, REPLY-01, SET-01) was NOT reached this pass -- session time/budget was prioritized toward Deposits/Customers/Bikes-Status/Concurrency per the plan's own emphasis on financial-risk areas, and toward chasing this and the BUG-04 double-booking finding once they surfaced live. Left for a future pass. |

## 8. Regression cases seeded from this app's own real incident history

Real, confirmed bugs found and fixed in THIS app earlier in this same
session, before this test plan existed — listed here so they're never lost
track of, per methodology §6.

1. **Cash-ledger entries silently excluded from the running total once the
   sheet reached its own summary-block boundary** — deterministic, not a
   race condition: `findFullyEmptyRowIdxJson` had no awareness of
   `locateCashSummaryBlock`'s boundary, so once the ledger's real data
   reached the "income" label row, new entries landed PAST it and were
   silently excluded from the total forever, no error. This is what caused
   the September Bank/Cash reconciliation to go wrong while August (which
   never reached the boundary) stayed fine. Fixed via
   `makeRoomAboveCashSummaryJson`, applied across `accountsWrites.js`,
   `bikesWrites.js`, `contractWrites.js`, `customersWrites.js`. Historical
   data recovered via a one-time repair (`repairOrphanedCashRows`),
   executed and confirmed live. → **`CASH-01`/`CASH-02`, §5.8.**
2. **Expense type / bike-split notes saved correctly to Drive but never
   read back for any month past August** — `accounts.html`'s
   `ACCOUNTS_MONTH_HAS_NOTES = { 6: true, 7: true }` gated whether the app
   even bothered fetching a month's notes sidecar file at all; the write
   side had no such gate, so a "To Transfer" tag would save successfully
   and then vanish on refresh for September onward. Fixed by removing the
   gate — every month's notes file is now always fetched (already safely
   falls back to empty on a genuinely missing file). → **`NOTES-01`/`02`/
   `03`, §5.7.**
3. **No retry-on-conflict on the notes-sidecar read-modify-write** —
   `setExpenseTypeNoteFromJson`/`applyMonthNotesEditsFromJson` in
   `accountsWrites.js` had the same unprotected single read-modify-write
   pattern the cash-ledger writes did, with failures on some call sites
   silently swallowed with no warning at all. Fixed with the same 3-attempt
   retry-on-conflict pattern used elsewhere in this codebase
   (`logTransactionBInner`'s established template). → **`CONC-01`/`CONC-02`,
   §5.15.**
4. **`formatSummaryValue` called an undefined `money()` helper** — crashed
   the one-time cash-repair probe with `"money is not defined"`; the bug
   had never surfaced before because its only other caller
   (`transferToBankFromJson`'s balance readback) silently swallowed the
   error. Fixed by using the file's own `fmtMoneyB` instead. No dedicated
   case needed — any case that reads the Accounts summary card exercises
   this code path.

## 9. Sources consulted

See `TESTING-METHODOLOGY.md` §7 for the full source list this file's
structure and technique choices were built from.
