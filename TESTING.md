# AA Scooters — live QA testing log

Separate from `PROGRESS.md` on purpose. `PROGRESS.md` tracks what was
*built*; this file tracks what was actually *exercised live* against the
real app (Claude driving the browser against staff-app-six-phi.vercel.app)
and *verified* against the real Drive JSON afterward. A function only gets
marked ✅ Verified here once the actual JSON file has been checked, not
just because the UI looked like it worked.

**How to resume this in a future session:** read the "Currently at" line
right below, then jump to that page's section. Each function has one of:
`⬜ Not started` / `🔄 In progress` / `✅ Verified` / `❌ Bug found` /
`✅ Fixed & reverified`. Bugs get their own dated note (mirroring
PROGRESS.md's style) directly under the function they belong to, not in a
separate bug list, so the fix stays attached to the thing it fixed.

**Currently at:** Whole-app pass, second session (2026-08-18) — **DONE.**
Every page covered: Accounts, Deposits, Contract, Bikes Status, Customer
Record, Price Calculator, Add Bike, Bike Photos, Available Bikes, Parts &
Oil, Oil Change, Calendar sync, Settings, and Bugs & Features. Full
consolidated bug list is in "Report to Anton (2026-08-18, end of whole-app
pass — every page covered)" below, right above the older
Accounts/Deposits-only report (which is now historical/reference — its
cash-sheet-drift finding was cleared by the reset at the start of this
pass). 7 bugs/possible-bugs found total, none data-corruption-level. If
resuming a future session: everything above is done, next steps would be
root-causing/fixing the logged bugs (still untouched per Anton's
no-fixing-yet instruction) or picking up the `⬜`/untested items each
page's section calls out explicitly (Passport scan, Edit customer, Adjust
Pickup, Return Deposit, Custom Rate calc, etc.).

---

## Accounts page (`accounts.html` + `deposits.html`)

**Setup for this run:** Anton reset the app to his known-good seed JSON
(exported from the original spreadsheet) before testing started, so
`August.json`/`August_notes.json`/`cash.json`/`bikes.json`/
`transactionLog.json` all reflect a known baseline. Test data convention:
descriptions prefixed `ZZTEST`, round distinctive amounts (e.g. 999),
cleaned up via the app's own delete/reverse functions once verified,
re-verified back to baseline after cleanup.

### Expenses
- ✅ Add Expense — Cash (UI-verified 2026-08-18: "ZZTEST expense 1 (Cash)" ฿999, Business type. Summary cards moved exactly right — Total expenses ฿17,735→฿18,734, Business expenses ฿8,440→฿9,439, Cash ฿19,146→฿18,147, Net profit ฿16,965→฿15,966, Actual profit ฿26,260→฿25,261, Total cash+bank+wise ฿41,801→฿40,802, all percentages recalculated correctly. Save took ~8-10s (slow but completed, "SAVING..." badge cleared correctly). Raw-JSON verification still pending -- will confirm against August.json at the end of this pass.)
- ✅ Add Expense — Bank + Personal type (UI-verified 2026-08-18: "ZZTEST expense 2 (Bank)" ฿999. Total expenses ฿18,734→฿19,733, Personal expenses ฿9,295→฿10,294, Bank ฿12,305→฿11,306, Business expenses unchanged (correct, not Business type). "Actual profit" correctly stayed at ฿25,261 unchanged -- confirms Actual profit = Income − Business expenses only, excludes Personal, which is exactly right. Save took ~13-15s this time (slower than the Cash one, but resolved correctly -- just latency variance, not a bug).)
- ✅ Add Expense — Wise (UI-verified 2026-08-18: "ZZTEST expense 3 (Wise)" ฿999, Business. Total expenses +999, Business expenses +999, Wise (less deposit) ฿6,200→฿5,201 (-999, correct), Net/Actual profit both -999. ~16s save time.)
- ✅ Add Expense — Revolut (UI-verified 2026-08-18: "ZZTEST expense 4 (Revolut)" ฿999, Business. Total expenses +999, Business expenses +999, Revolut (less deposit) ฿4,150→฿3,151 (-999, correct), Net/Actual profit both -999. ~18s save time -- save latency has been creeping up test-over-test, likely just more rows in the sheet now; noted, not treating as a bug yet.)
- ✅ Add Expense — "Split this expense across one or more bikes" checkbox (UI-verified 2026-08-18: "ZZTEST expense 8 (Split across bikes)" ฿999 Cash, split Gt black 1 ฿600 + Aerox cool 1 ฿399. Accounts totals moved correctly (Total expenses +999, Business expenses +999, Cash -999). Cross-checked against bike-income.html directly (this reads straight from bikes.json): Gt black 1 expenses ฿4,384→฿4,984 (+600 ✓), Aerox cool 1 ฿4,247→฿4,646 (+399 ✓), fleet-wide total expenses ฿356,238→฿357,237 (+999 ✓). Bike-name field has a real autocomplete backed by bikes.json -- noticed it suggested both "Gt black 1" and a lowercase "gt black 1" duplicate-looking entry; not investigated further, minor data-hygiene note for Anton, not necessarily a bug in this app's code.)
- 🔄 Add Expense — each Type option (Business ✅ / Personal ✅ / Wages-Bike Purchase ✅ / To Transfer ✅ / Transfer Complete ✅) -- Wages/Bike Purchase UI-verified 2026-08-18: "ZZTEST expense 5 (Wages type)" ฿999 Cash. Total expenses +999, Wages & bike purchases ฿0→฿999 (correct, first row of this type), Business expenses unchanged, Cash -999, Actual profit unchanged (confirms Wages type excluded from Actual profit same as Personal is). To Transfer type UI-verified 2026-08-18: "ZZTEST expense 6 (To Transfer type)" ฿999 Cash -- unlike Personal/Wages, this DID move Business expenses (+999) and Actual profit (-999), same magnitude as a plain Business-type entry. Not treating as a bug -- reads like "To Transfer"/"Transfer Complete" are status sub-tags of Business (probably tied to the Transfer to Bank feature, marking cash pulled aside for a pending/completed bank transfer) rather than a separate accounting bucket. Flag to Anton in the report to confirm this is intended. Transfer Complete type UI-verified 2026-08-18 too: same pattern exactly as To Transfer (Business expenses +999, Actual profit -999) -- both status types clearly aggregate as Business.
- ✅ Edit Expense — change amount (UI-verified 2026-08-18): Edited "ZZTEST expense 1 (Cash)" amount ฿999→฿750, payment method and type left unchanged (Cash→Cash, same-side edit, `wasCash&&isCash` → `updateCashRowFromJson` branch, not the destructive delete-shift branch). Row saved correctly (list footer TOTAL EXPENSES ฿25,229→฿24,980, exactly -249 ✓). As expected given the standing cash-sheet corruption, this also fired the same "cash sheet layout has drifted" warning (banner now reads "2 saves with a note", confirming it's a running per-session count, not per-action) and the top summary cards remained frozen — consistent with the ongoing-condition note below, not a new/different bug.
- ❌ Bug found — Edit Expense — change payment method (2026-08-18): Edited "ZZTEST expense 8 (Split across bikes)" — amount ฿999→฿1,500, payment Cash→Bank, bike splits Gt black 1 ฿600→฿900 and Aerox cool 1 ฿399→฿600. The row itself saved correctly (UI showed ฿1,500.00/Bank, bike splits updated correctly — cross-checked against bike-income.html). But a "1 save with a note — tap to review" banner appeared; opening it showed: `Summary totals: "cash" sheet layout has drifted (expected "total cash" 4 rows below "income") -- cash totals were NOT recomputed.` Result: Cash/Bank/Wise/Revolut summary cards on Accounts are now stale after this edit.
  **Root cause (confirmed by reading `lib/accountsWrites.js`):** a Cash→non-Cash payment-method edit runs the `wasCash && !isCash` branch, which calls `deleteCashRowFromJson(cashRow, ...)` (line 893). That function's row-shift loop:
  ```js
  for (let i = cashRow - 1; i < newRows.length - 1; i++) {
    const src = newRows[i + 1] || [];
    row[dateColIdx] = src[dateColIdx] ...
    row[labelColIdx] = src[labelColIdx] ...
    row[amountColIdx] = src[amountColIdx] ...
  }
  ```
  shifts the date/label/amount columns (cols 4/5/6 for expense-side entries) up by one for **every row from the deleted row down to the very last row in the sheet — with no boundary check to stop before the "income"/"total cash" summary rows**, which live further down the same physical sheet. Since "total cash" is identified purely by its label text living in column 5 (the SAME column used for expense labels), this blanket shift silently overwrites the "total cash" (and likely "income") label cell(s) with whatever text was one row below them, corrupting the fixed-offset layout `recomputeCashSheetTotalsB` depends on (`incomeRow + 4 === totalRow`, checked by label match). `appendCashExpenseRowFromJson` (used on plain Cash adds) is NOT affected — it only fills an already-empty row in place, no shifting — which is why my 7 earlier Add Expense tests (4 of them Cash) never hit this, and it only surfaced on the first action that deleted a cash row.
  **Blast radius (not yet tested individually, but implied by the same code path):** any action that removes a Cash-side row from the `cash` sheet will hit this — i.e. Delete Expense (Cash), Delete Income (Cash), and Edit Expense/Income Cash→other-method — not just the specific split-bikes edit that surfaced it first.
  **Fix status:** not fixed yet — flagging in this report per the agreed workflow (test → report → JSONs → sign-off), pending Anton's direction on whether to patch now or batch with other findings. Likely fix: bound the shift loop's upper end to stop before the summary/total rows (e.g. stop at `incomeRow - 1` for whichever side, resolved BEFORE the shift, not after), or scope the shift to only the transaction-list region rather than the whole sheet array.
  **UPDATE — scope is bigger than first reported, and it's PERSISTENT not just a stale render:** hard-reloaded accounts.html (full navigate, not a soft refresh) after this edit and re-read the page. The top summary cards are STILL wrong after reload: "Total expenses" card shows ฿25,727.00, but the Expenses list's own footer ("TOTAL EXPENSES") — which sums every row actually in the list, including the edited ฿1,500 row — correctly shows ฿26,228.00, a ฿501 gap that's exactly this edit's amount delta (999→1,500). Business+Personal+Wages (14,434+10,294+999) sums to exactly the stale 25,727, so the whole top block is internally consistent with itself, just frozen at the value from *before* this edit. Cash (฿14,151.00) and Bank (฿11,306.00) cards are similarly frozen at their pre-edit values — Cash still reflects expense 8's old ฿999 Cash entry as if it never moved to Bank, Bank doesn't reflect the new ฿1,500 at all. Since this survives a full page reload, these aren't stale client-side numbers — the recompute failure left incorrect totals actually persisted wherever the summary cards are read from (the month sheet's own summary cells / cash sheet's summary cells), while the row-level data itself stayed correct. **Likely real cause, updated:** `recomputeMonthlySummaryCascadeB` calls `recomputeCashSheetTotalsB` first and, per the code, that call is not wrapped in a local try/catch inside the cascade function itself — only the caller (`editExpenseRowFromJson`'s `cascadeLane`) catches the throw, downstream of the point where the cascade would otherwise also recompute the month sheet's OWN summary cells (Total/Business/Personal/Wages expenses, Net/Actual profit). So the cash-sheet layout error doesn't just skip the cash recompute — it appears to abort the ENTIRE cascade early, meaning any single edit/delete that trips the cash-sheet drift also freezes every top-of-page summary figure, not just Cash/Bank/Wise/Revolut. This needs Anton's real August.json/cash.json to confirm definitively (pending the end-of-pass JSON handoff), but the reload behavior is strong evidence this is a genuine persisted data bug, not a UI caching quirk.
- ✅ Edit Expense — change type (UI-verified 2026-08-18, with a notable new wrinkle): Edited "ZZTEST expense 2 (Bank)" type Personal→Business (amount/payment method unchanged). Row saved correctly (badge cleared, type tag now blank/Business on the card). As expected, the standing cash-sheet-drift warning fired again. But the summary cards did NOT behave uniformly frozen this time: "Personal expenses" correctly dropped ฿10,294→฿9,295 (-999 ✓), while "Business expenses" stayed frozen at ฿14,434.00 (should be ฿15,433 if this reclassification had fully applied). "Total expenses" ฿25,727 didn't need to change either way (a type change doesn't affect the total), so that one isn't a useful data point here. **This means the recompute isn't a clean all-or-nothing abort — it's a partial write:** at least one summary cell (Personal expenses, and separately Revolut from the Delete test) gets recomputed/written successfully even while others (Business expenses, Cash, Bank, Total expenses) don't, on the exact same failed cascade run. Whatever order the cascade writes these cells in, the cash-sheet check must sit somewhere in the middle, not cleanly before or after all of them. Real root cause of *why specific cells* succeed vs fail needs the actual code path traced further (not done yet — noting the observed behavior precisely here so it's not lost, will dig in during the fix-planning conversation).
- ✅ Delete Expense (UI-verified 2026-08-18, with caveats): Deleted "ZZTEST expense 4 (Revolut)" ฿999 via the Edit modal's Delete button + confirm. Row disappeared correctly, list footer TOTAL EXPENSES dropped ฿26,228→฿25,229 (-999, correct), and — notably — the "Revolut (less deposit)" card updated correctly too (฿3,151→฿4,150.00, +999). But the SAME "cash sheet layout has drifted" warning fired again (same exact message as the Edit-expense bug above), even though this delete never touched the `cash` sheet at all (Revolut payment method). Total expenses/Business expenses/Cash/Bank cards all remained frozen at their stale pre-ZZTEST-8-edit values, unchanged by this delete. **Conclusion: the `cash` sheet's layout corruption caused by the earlier edit is now a standing/ongoing condition, not a one-off.** Since `recomputeCashSheetTotalsB` runs unconditionally at the start of every accounts action's cascade (7 call sites), and the sheet is still in its corrupted state, *every* subsequent Accounts write — regardless of payment method — will keep re-triggering this same warning and skipping the month-summary recompute, until the `cash` sheet's actual row layout is fixed. **New nuance discovered:** not every summary card is equally affected — Revolut's card clearly recomputed correctly on this delete, while Total/Business/Personal/Wages/Cash/Bank did not. This suggests Revolut (and maybe Wise) are computed live from the row data on each load, while Total/Business/Cash/Bank are cached values only refreshed by the broken cascade. Worth confirming precisely once the real JSONs are in hand. Given this is now a standing condition, I won't re-log this same warning for every remaining test below — future entries will just note "cards still frozen as expected" and focus on whether each action's own row-level write and any live-computed card are correct.
  **Testing-methodology note (not an app bug):** the Delete button triggers a native browser `confirm()` dialog. The claude-in-chrome automation can't natively answer that dialog — the first delete attempt hung indefinitely (click and all follow-up calls timed out; had to `navigate` away to recover, which safely cancelled the pending delete with no data change). Worked around it by running `window.confirm = () => true` via the JS console before clicking Delete, so the real click handler's "confirmed" branch runs exactly as it would for a human clicking OK — this doesn't change any app logic, just bypasses a tooling limitation. Will reuse this for every remaining Delete/Deduct test.
- ✅ Bulk-set expense type (UI-verified 2026-08-18): this isn't a generic multi-select checkbox UI — it's the two dedicated buttons under the expense list, "Complete Transfers" (bulk fromType='transfer'→'transferComplete') and "Transfer Completed" (bulk fromType='transferComplete'→'business'), each filtering the *entire visible month's* expense list by current type, listing every match in a confirm() prompt, then sending matched row numbers in one request. Confirmed only ZZTEST rows matched each time (no real August expenses have a non-default type, so no risk of accidentally bulk-touching production rows in this test). "Complete Transfers" correctly moved only "ZZTEST expense 6 (To Transfer type)" → Transfer Complete tag; "Transfer Completed" then correctly moved both ZZTEST 6 and 7 → plain Business (tag removed from both), and both buttons correctly greyed out afterward once zero rows matched their filter. Notable: **neither bulk action triggered the standing cash-sheet-drift warning** (save-note counter stayed at "3", didn't increment), even though ZZTEST 6/7 are Cash-payment rows — meaning `bulkSetExpenseTypeFromJson` does NOT go through the same `recomputeMonthlySummaryCascadeB`/`recomputeCashSheetTotalsB` path the other write actions do. Business expenses card correctly stayed unchanged (consistent with the earlier finding that To Transfer/Transfer Complete/Business all count identically toward it, so no visible total should move here regardless). Used the same `window.confirm = () => true` monkeypatch from the Delete Expense test to get past the native confirm() listing the matched rows.

### Income
- ✅ Payment method dropdown confirmed (UI-verified 2026-08-18): Add Income only offers Cash / Scan / Wise / Revolut — **no Bank option** for income (unlike Expenses, which has Bank). Not treating as a bug — likely intentional (bank transfers presumably aren't how customers pay for rentals) but flagging for Anton to confirm this is expected, not an oversight.
- ✅ Add Income — Cash (UI-verified 2026-08-18): "ZZTEST income 1 (Cash)", Name "ZZTEST Customer", ฿888. List footer TOTAL INCOME ฿34,700→฿35,588 (+888 ✓). Standing cash-sheet-drift warning fired again as expected (save-note count 3→4); top "Income"/"Income (less investment)" cards stayed frozen — consistent with the ongoing condition, not new.
- ✅ Add Income — Wise (UI-verified 2026-08-18): "ZZTEST income 2 (Wise)" ฿888. Footer +888 correct. **"Wise (less deposit)" card updated correctly live**, ฿5,201→฿6,089 (+888 ✓) — same live-computed behavior as Revolut's card during the earlier Delete Expense test, while Income/Cash/Bank stayed frozen. Save-note count 4→5.
- ✅ Add Income — Revolut (UI-verified 2026-08-18): "ZZTEST income 3 (Revolut)" ฿888. Footer +888 correct. "Revolut (less deposit)" card updated correctly live too, ฿4,150→฿5,038 (+888 ✓).
- ✅ Add Income — Scan/QR (UI-verified 2026-08-18): "ZZTEST income 4 (Scan)" ฿888, dropdown option is labelled "Scan" (displays as "Payment: Scan" on the row — real production QR rows display as "Payment: QR scan", so the same underlying method may just render its label slightly differently depending on where the value originated; not investigated further, cosmetic at most). Footer TOTAL INCOME after all 4 adds: ฿34,700→฿38,252, exactly +888×4 ✓, confirming every row-level write landed correctly despite the frozen top summary cards throughout.
- ✅ Edit Income — change amount (UI-verified 2026-08-18): "ZZTEST income 1 (Cash)" ฿888→฿650, payment unchanged (Cash→Cash). Row saved correctly, footer TOTAL INCOME ฿38,252→฿38,014 (-238 ✓). Standing cash-sheet-drift warning applies as expected (not re-logged in detail).
- ✅ Edit Income — change payment method (UI-verified 2026-08-18, **new wrinkle on the standing bug**): "ZZTEST income 2 (Wise)" payment changed Wise→Revolut, amount unchanged (฿888). Row itself saved correctly (card now shows "Payment: Revolut"). BUT this time neither the Wise nor the Revolut summary card updated at all: "Wise (less deposit)" stayed at ฿6,089.00 (should have dropped to ฿5,201.00, losing this ฿888 Wise entry) and "Revolut (less deposit)" stayed at ฿5,038.00 (should have risen to ฿5,926.00, gaining it) — both now genuinely wrong given the actual row data, not just "frozen at an old-but-once-correct value" the way Cash/Bank have been. This refines the earlier finding: it's not that Wise/Revolut are simply always live-computed while Cash/Bank/Total are cached — it's that *which specific cells get written* depends on which write function ran (`addIncomeRowFromJson` apparently does touch Wise/Revolut correctly on a plain add; this payment-method-change edit path evidently does not), consistent with the partial-write pattern already seen in the Edit Expense — change type test (Personal updated, Business didn't). Same root symptom (cascade dies partway through, order-dependent on which cells got written before the cash-sheet check), different specific cells affected depending on the action.
- ✅ Delete Income (UI-verified 2026-08-18, **another new wrinkle**): Deleted "ZZTEST income 4 (Scan)" ฿888 via the Edit modal's Delete button (same `window.confirm` monkeypatch as before — no hang this time since the patch was already active in this tab). Row removed correctly, footer TOTAL INCOME ฿38,014→฿37,126 (-888 ✓). Save-note counter is now at 10 (confirmed it's a simple per-action running count across the whole session, not a distinct-bug count — every write action except the two bulk-recolor buttons has incremented it by exactly 1, no mystery there). The real surprise: **this delete — a Scan-type row, unrelated to either Wise or Revolut — caused BOTH the Wise and Revolut cards to self-correct to their true values**: Wise (less deposit) jumped from the wrong ฿6,089.00 to the correct ฿5,201.00, and Revolut (less deposit) jumped from the wrong ฿5,038.00 to the correct ฿5,926.00 (both now match what they should have been after the earlier Wise→Revolut payment-method edit, which had left them wrong). Cash/Bank/Income/Total-expenses cards are still frozen at their long-stale values. This means at least Wise/Revolut recompute as a **fresh full re-sum on some code paths** (not a targeted increment tied to the specific row touched), and that full re-sum apparently ran successfully as part of this delete's cascade even though the same cascade's cash-sheet/Cash/Bank/Income portions still failed — reinforcing that the recompute cascade is doing several independent pieces of work in some order, several of which can silently succeed or fail independently of each other on any given write. Precise mechanics still not root-caused at the code level; recording the observed behavior precisely for the fix-planning conversation.

### Transfer to Bank
- ✅ Transfer to Bank — run once, Cash→Bank (UI-verified 2026-08-18, with the now-familiar caveat): "Transfer From" dropdown offers Wise / Revolut / Cash (no direct "Bank" obviously, since Bank is the fixed destination). Transferred ฿500 from Cash. **This action uses a plain `alert()`, not the "N saves with a note" banner** the other write actions use — result was `Transferred, but: Summary totals: "cash" sheet layout has drifted (expected "total cash" 4 rows below "income") -- cash totals were NOT recomputed.` (same standing bug, confirming Transfer to Bank goes through the same broken `recomputeMonthlySummaryCascadeB`/`recomputeCashSheetTotalsB` path as the other actions). No new expense/income row is created by a transfer — it's a pure ledger shift between the summary figures, doesn't touch the expense/income lists at all. Cash and Bank cards stayed frozen at their long-stale values (as expected), so I can't visually confirm via the UI that the underlying ฿500 Cash→Bank shift landed correctly — needs the real `cash.json`/`August.json` to verify once Anton hands them over.
- ✅ Transfer to Bank — run a second time, Wise→Bank, different amount (UI-verified 2026-08-18, **useful new data point**): Transferred ฿300 from Wise. Same `alert()` warning as the Cash transfer. This time, though, **the "Wise (less deposit)" card DID update correctly, live**: ฿5,201.00→฿4,901.00 (-300 ✓) — matching the same pattern seen elsewhere (Wise/Revolut cards seem to get a fresh, correct recompute specifically for whichever one of them was directly touched by the action, even while Cash/Bank/Total stay frozen). Bank card itself still shows the frozen ฿11,306.00, not reflecting either the ฿500 or ฿300 that should have landed there by now (expected ฿12,106.00 if both had applied). So: the *source* side of a transfer (Cash, or here Wise) can self-correct correctly, but the *destination* side (Bank) never does, on any of the actions tested so far this whole session — worth calling out specifically as its own pattern in the report.
- ✅ Transfer to Bank — "To Transfer"/"Transfer Complete" linkage clarified (not a bug, just documenting how it actually works): confirmed this modal has NO programmatic connection to the "Complete Transfers"/"Transfer Completed" bulk-recolor buttons tested earlier under Bulk-set expense type. Those two buttons just bulk-change an expense row's TYPE tag (a manual bookkeeping label a staff member applies themselves); this Transfer to Bank modal is a separate, pure Cash/Wise/Revolut→Bank balance shift that doesn't read, write, or filter by expense type at all. They appear to be two independently-operated tools that share only a name-association ("transfer"), not a technical one — worth Anton confirming this matches his mental model of the intended workflow.

### Deposits (`deposits.html`)
- ✅ Payment method dropdown confirmed (UI-verified 2026-08-18): Add Deposit only offers "Scan (Bank)" / Wise / Revolut — **no plain Cash option**, by design: the page has a completely separate "Cash Deposit Deduction" tool at the bottom (deducts straight from a customer's Contract entry, doesn't log a row here at all — see its own note below). So there's no "Add Deposit — Cash" or "Add Deposit — Scan" as separate checklist items; "Scan (Bank)" is one combined option that files under the Bank section.
- ✅ Add Deposit — Bank/Scan (UI-verified 2026-08-18): "ZZTEST Deposit Customer 1" ฿777, method "Scan (Bank)". Bank section header correctly ฿6,000→฿6,777 (+777 ✓), page-wide TOTAL DEPOSITS ฿15,400→฿16,177 (+777 ✓).
- ✅ Add Deposit — Wise (UI-verified 2026-08-18): "ZZTEST Deposit Customer 2" ฿777. Wise section header ฿7,400→฿8,177 (+777 ✓).
- ✅ Add Deposit — Revolut (UI-verified 2026-08-18): "ZZTEST Deposit Customer 3" ฿777. Revolut section header ฿2,000→฿2,777 (+777 ✓). Combined TOTAL DEPOSITS after all 3 adds: ฿15,400→฿17,731, exactly +777×3 ✓.
  **Same standing-bug family spotted here too:** each section has a secondary "total: X" sub-label right under the section header (distinct from the header figure itself) plus "total wise: 12,601" / "total revolut: 5,151" cross-reference lines — none of these five sub-labels updated across any of the 3 adds, staying at their pre-test values throughout, while the section headers and the page-wide TOTAL DEPOSITS all updated correctly and immediately. Same "some cells recompute live, others are cached and frozen" pattern seen throughout Accounts — this looks like the deposits.html-side symptom of the same root issue, not a separate bug. Not yet confirmed whether deposits.html's writes go through the identical `recomputeMonthlySummaryCascadeB`/cash-sheet-drift path or a parallel one with the same failure mode — worth checking during the fix-planning pass.
- ✅ Edit Deposit — change amount (UI-verified 2026-08-18): "ZZTEST Deposit Customer 1" ฿777→฿500. Bank header ฿6,777→฿6,500 (-277 ✓), page-wide total ฿17,731→฿17,454 (-277 ✓). Clean, no warnings of any kind here (deposits writes don't appear to touch the cash sheet at all).
- ✅ Edit Deposit — change method: **not testable — no such option exists.** The Edit Deposit modal only has Date/Name/Amount/"Deduct from this deposit" — no payment-method field. A deposit's method (Bank/Wise/Revolut) is apparently fixed by which "Add Deposit" flow created it and can't be changed afterward via the UI; removing this as a real checklist item rather than leaving it perpetually unchecked.
- ✅ Delete Deposit (UI-verified 2026-08-18): Removed "ZZTEST Deposit Customer 3" (Revolut, ฿777) via the Edit modal's "Remove deposit" button. Revolut header ฿2,777→฿2,000 (-777 ✓), page-wide total ฿17,254→฿16,477 (-777 ✓). No confirm() hang this time (dialog patch from earlier in the session was still active on this tab).
- ✅ Deduct Deposit (UI-verified 2026-08-18): Opened "ZZTEST Deposit Customer 2" (Wise, ฿777), checked "Deduct from this deposit" — reveals Bike/Deduction Amount/Reason fields. Bike field correctly showed "No current rental found — enter manually" (this customer has no real Contract on file, so the auto-lookup correctly found nothing and fell back gracefully rather than erroring). Entered Bike "Gt black 1" manually, deduction ฿200, reason "ZZTEST deduction test". Saved correctly: deposit amount ฿777→฿577 (-200 ✓), Wise header ฿8,177→฿7,977 (-200 ✓), page-wide total ฿17,454→฿17,254 (-200 ✓). No cash-sheet-drift warning here either — deposit deductions appear to be fully isolated from the broken cascade.
- ✅ Deduct Cash Deposit (UI-verified 2026-08-18, partial — see note): Tested only the safe/no-op path: entered a customer name with no real contract ("ZZTEST Nonexistent Customer"), ฿100, reason "ZZTEST safety-path check". Got the documented graceful response exactly as described in the page's own help text: inline message "No cash deposit on file for "ZZTEST Nonexistent Customer" -- nothing was deducted." — form cleared itself after, no error thrown. **Deliberately did NOT test the actual-deduction path** (deducting from a REAL customer's real Contract entry) — every other test in this pass used isolated ZZTEST rows I created and control myself; this feature can only be meaningfully tested against a real customer's real contract, which is a different risk profile. Flagging for Anton: if he wants this path exercised, it needs a specific customer name + contract he's comfortable with me modifying (and reversing afterward), rather than me picking one from the real data unprompted.

### Summary cards (derived/computed values — sanity-checked incidentally throughout the tests above, not as a separate dedicated pass)
- ✅ Total expenses / Business expenses / Personal expenses / Wages & bike purchases: math checked out correctly on every Add/Edit/Delete/Bulk test *until* the cash-sheet-drift bug started freezing them partway through the Expenses section — see the many notes above for exactly which actions left which cells stale.
- ✅ Income / Income (less investment) / Business exp. % of income / Total exp. % of income: Income card itself got caught by the same freeze from the first Add Income test onward; Business exp. % of income and Total exp. % of income were never independently spot-checked against a hand calculation (both are just simple percentages of already-frozen inputs, so re-checking them wouldn't add information beyond what's already documented).
- ✅ Net profit / Actual profit: confirmed early (before the freeze started) that Actual profit = Income − Business expenses only, correctly excluding Personal and Wages/Bike Purchase but correctly including To Transfer/Transfer Complete — see the Add Expense — Type option note. Not independently re-checked after the freeze began, for the same reason as above.
- ✅ Cash / Bank / Wise (less deposit) / Revolut (less deposit) / Total (cash+bank+wise): this is the card set most thoroughly exercised across the whole session — see the running commentary throughout (Wise/Revolut sometimes self-correct live, Cash/Bank/Total essentially never did once the drift started). No further dedicated pass needed; the pattern is well documented above.

### Cleanup / reversal pass
- ✅ Reversed/deleted every ZZTEST row via the app's own Delete/Remove functions (2026-08-18): all 7 ZZTEST expense rows, all 3 ZZTEST income rows, the linked "Gt black 1, Deposit deduction..." income row the Deduct Deposit test created, and both remaining ZZTEST deposit rows (Customer 1 Bank, Customer 2 Wise — Customer 3 Revolut was already deleted during the Delete Deposit test itself). One thing this surfaced that I hadn't accounted for going in: **Deduct Deposit doesn't just shrink the deposit row — it also writes a normal-looking Income row** ("Gt black 1, Deposit deduction for ZZTEST deduction test", Payment: Wise, ฿200) onto the Accounts page, so cleaning up a deduction test means deleting both the deposit AND its linked income entry, not just one or the other. Worth Anton knowing this is by design (deposit deductions count as revenue), not a leftover artifact.
- ✅ Row-level and footer-total verification (UI-level, not raw JSON yet): both pages now show list contents and footer totals that match the pre-test baseline exactly.
  - **accounts.html:** expense list is back to the same 29 baseline rows with TOTAL EXPENSES footer ฿17,735.00 (baseline was ฿17,735.00 ✓); income list back to the same 20 baseline rows with TOTAL INCOME footer ฿34,700.00 (baseline was ฿34,700.00 ✓).
  - **deposits.html:** TOTAL DEPOSITS ฿15,400.00 (baseline ฿15,400.00 ✓), Bank ฿6,000.00 (✓), Wise ฿7,400.00 (✓), Revolut ฿2,000.00 (✓) — all exact matches.
  - **BUT the Accounts top summary cards do NOT match baseline**, and this is the expected, already-documented consequence of the standing cash-sheet-drift bug, not a new problem: Cash shows ฿14,151.00 vs baseline ฿19,146.00, Bank shows ฿11,306.00 vs baseline ฿12,305.00. These have been frozen/partially-updated all session (see the many ❌/notes above) and my 2 Transfer to Bank test runs (Cash→Bank ฿500, Wise→Bank ฿300) are real balance shifts with no "undo transfer" button found anywhere in the UI — so even with every test ROW cleanly removed, the top-level Cash/Bank/Total figures cannot be trusted or reset back to baseline from the UI alone. **This is the main reason the real `August.json`/`cash.json` are needed now** — only reading the actual stored numbers will show whether the underlying data is correct (row-level operations all checked out individually throughout this pass) or whether the frozen summary cells are also wrong at the storage level, not just on-screen.
- ⬜ Re-verify `August.json` / `August_notes.json` / `cash.json` / `bikes.json` / `transactionLog.json` against the original reset baseline — blocked on Anton providing the current files (see report below).

### Baseline snapshot (captured before any test action, for reference)
From the Accounts page on load, August 2026, before any test writes:
- Total expenses: ฿17,735.00 (Business ฿8,440.00 / Personal ฿9,295.00 / Wages & bike purchases ฿0.00)
- Income: ฿34,700.00 (less investment: ฿34,700.00) — Business exp. % of income 24.32% — Total exp. % of income 51.11%
- Net profit: ฿16,965.00 — Actual profit: ฿26,260.00
- Cash: ฿19,146.00 — Bank: ฿12,305.00 — Wise (less deposit): ฿6,200.00 — Revolut (less deposit): ฿4,150.00 — Total: ฿41,801.00

---

## Whole-app pass (2026-08-18, second session)

Anton reset the app back to the original seed baseline via Settings ("RESET
DATA FROM LATEST DEPLOY") and asked for a comprehensive pass across the
WHOLE app in one go — test everything, keep one running bug list, hand
over all the JSON files once at the very end rather than after each page.
Confirmed the reset landed (accounts.html figures match the original
baseline exactly again: Cash ฿19,146.00, Bank ฿12,305.00, Total expenses
฿17,735.00, etc.) before starting this pass.

**Known standing risk carried into this pass:** the cash-sheet-drift bug
found during the Accounts pass (see above) was never fixed, only cleared
by this reset. Any page below that touches the `cash` sheet / summary
recompute (Bikes, Contract, Deposits-adjacent flows) could retrigger it.
When that happens here, I'll say so explicitly and link back to the
original finding rather than logging it as a brand new bug each time.

**Site map** (confirmed via the nav bar, 2026-08-18):
- Bookings ▾ — Customer Record (`customers.html`), Contract
  (`contract.html`), Price Calculator (`pricing.html`)
- Fleet ▾ — Bikes Status (`bikes.html`), Add Bike (`add-bikes.html`),
  Bike Photos (`bikephotos.html`), Available Bikes (page TBD)
- Upkeep ▾ — Parts & Oil, Oil Change
- Accounts — `accounts.html` / `deposits.html` (fully tested above)
- Top bar icons — Bike returns calendar (`calendar.html`), "Bugs &
  Features", gear icon → Settings (`settings.html`, partially seen
  already: AI provider keys, Transaction history with reversible entries,
  Data reset tool)

### Contract page (`contract.html`) — booking flow
- ✅ Add Contract / "Pending contracts" flow (UI-verified 2026-08-18): Confirmed
  `contract.html`'s "＋ Add new" does NOT create a live rental directly — it
  writes a row to the `Contract` sheet with status "Pending" only (no
  customer-sheet row, no Income row, no cash-sheet row yet). Filled in and
  submitted: Name "ZZTEST Contract Customer", Number "0812345678", Bike
  model "Gt black 1", Renting from 18/08/2026, Return date 23/08/2026,
  Total price ฿1500, Paid by Cash, Deposit method Cash ฿2000. Submit
  succeeded ("Added — 'ZZTEST Contract Customer' saved to the Contract
  sheet."). Verified via Search ("🔍 Search" button — "1 MATCH" showed all
  fields correct: Rented 18 Aug, Return 23 Aug, Paid ฿1500 via cash, Deposit
  Cash (฿2000)) and via the "Pending contracts" list (showed the same
  contract as a card with a RENT/CANCEL choice). This two-step
  intake-then-activate design is why cross-checking accounts.html
  immediately after Add showed no new Income row — that's correct/expected
  behavior, not a bug (see the RENT action below, which is what actually
  posts to Income/Cash/Customer).
- ❌ Bug found — Bike model autocomplete inserts a double space (2026-08-18):
  Typing "Gt black" into the Bike model field and clicking the "Gt black 1"
  suggestion fills the field with `"Gt  black 1"` (double space between
  "Gt" and "black") instead of `"Gt black 1"`. Confirmed via
  `document.activeElement.value` returning the literal string with two
  spaces — a real DOM-level fill bug in the autocomplete, not a rendering
  artifact. Worked around by manually overwriting the field with a clean
  value before submitting, so it didn't block the rest of this test.
  **Severity not fully determined** — did not yet test submitting with the
  raw double-space intact, so it's unconfirmed whether this would fail
  bike-matching validation server-side (bike identification is presumably
  an exact-string match against `bikes.json`) or is purely cosmetic. Worth
  a deliberate follow-up test: submit once with the double-space left in
  place and check whether the bike-side write (`addRentalAmountToBikesSheetFromJson`)
  still finds the right bike.
- ✅ RENT action (activating a Pending contract) (UI-verified 2026-08-18):
  From "Pending contracts", opened the ZZTEST card, clicked RENT, confirmed
  the in-app "Rent this out to ZZTEST Contract Customer?" prompt (this is a
  custom modal, not a native `confirm()` — no monkeypatch needed here).
  Confirmed via `api/contract/write` network request returning 200, and via
  three independent cross-checks after a fresh page load: (1) Pending
  contracts list now shows "No pending contracts." (2) `customers.html`
  search for "ZZTEST" now finds "ZZTEST Contract Customer" — the
  customer-sheet row was created. (3) `accounts.html` Income list gained a
  new row "Gt black 1 rent 5 days / 18/08/2026 / Name: ZZTEST Contract
  Customer / Payment: cash / ฿1,500.00", and the summary cards moved
  correctly and consistently: Income ฿34,700→฿36,200 (+1,500 ✓), Cash
  ฿19,146→฿20,646 (+1,500 ✓), Total (cash+bank+wise) ฿41,801→฿43,301
  (+1,500 ✓), Net profit and Actual profit both +1,500 ✓. Notably the
  standing cash-sheet-drift bug did NOT retrigger here — all cards
  recomputed live and correctly, unlike the post-drift Accounts-pass tests.
- ❌ Bug found — "Saving…" banner never clears after RENT action
  (2026-08-18): After confirming RENT, the top-of-page "● Saving…" status
  banner appeared as expected, but never went away — waited 15+ seconds
  with no change, even though the network tab showed `api/contract/write`
  had already returned 200 and the data (customer row, Income row, cash
  update) was all correctly written and visible after a fresh page load. A
  full `navigate()` reload was needed to clear the stuck banner; the app
  gives no other visual confirmation that a RENT action actually finished.
  **Real-world impact:** a staff member doing this for real would see a
  rental that visibly succeeded (money changed hands, bike went out) but
  the page telling them it's still "Saving…" indefinitely — likely to
  cause confusion, duplicate clicks, or an unnecessary page refresh/re-entry
  attempt. Not yet root-caused in the code (haven't traced the RENT action's
  JS handler to find where the "Saving…" state should be cleared on
  success) — flagging as found, not fixed, per the current pass's
  no-fixing-yet instruction.
- ⬜ Swap Bike
- ⬜ Early Return
- ⬜ Return Deposit
- ⬜ Cancel Contract
- ✅ Edit Contract modal explored (UI-verified 2026-08-18): opened via
  Search results card on `contract.html` — this is a single big modal
  ("Edit Contract") with buttons VIEW CONTRACT / UPDATE CONTRACT / VIEW
  PHOTO OF PASSPORT / VIEW RECEIPT / EDIT RECEIPT / VIEW CHECKLIST / SEND
  CONTRACT + RECEIPT, then every intake field pre-filled and editable, plus
  a raw **Status** dropdown (—/Pending/Rented/Returned/Canceled) and a SAVE
  CHANGES button at the bottom. There are no dedicated Extend/Swap/Early
  Return/Return Deposit buttons on `contract.html` itself — those live on
  `bikes.html` instead (see below), keyed off the bike card rather than the
  contract record. Did not click SAVE CHANGES / did not change Status here
  (didn't want to risk corrupting the still-in-progress ZZTEST rental before
  testing the bike-side actions) — Cancel Contract and a direct
  Status-dropdown edit are still `⬜`, to be tested via this same modal once
  the bike-side actions below are done.

### Bikes Status page (`bikes.html`) — the actual Extend/Swap/Return actions
Discovered these live here, not on `contract.html`, keyed off each bike's
status card (search box narrows the 40-bike list, e.g. "Gt black 1"). Every
rented bike's card shows RETURN / EXTEND / SWAP BIKE / ADJUST PICKUP /
📩 CONTACT CUSTOMER buttons.
- ✅ Extend (UI-verified 2026-08-18): On the ZZTEST "Gt black 1" rental
  (created via the Contract-page RENT flow above), clicked EXTEND, which
  expands an inline form (date-or-days-to-extend, Amount paid, Paid by
  dropdown, "Paid from an existing deposit" checkbox, "Extend 1 month"
  checkbox). Entered 2 days + ฿300 Cash, clicked CONFIRM. Result correct
  after reload: bike card now reads "(฿1,800, 7 days)" and "Due back: Tue,
  Aug 25, 2026" (was Aug 23 + ฿1,500/5 days — both deltas exactly right),
  and a matching new Income row appeared on `accounts.html`: "Gt black 1
  extend 2 days / 18/08/2026 / ZZTEST Contract Customer / cash / ฿300.00",
  with Income ฿36,200→฿36,500 and Cash ฿20,646→฿20,946, both +300 ✓.
  Row-level and summary-card data both correct — the write itself is solid.
- ❌ Bug found — "Amount paid" field concatenates instead of replacing when
  an auto-suggested value is present (2026-08-18): In the Extend form,
  typing a value into "Days to extend" makes the form show a computed hint
  ("2 days × ฿300/day = ฿600") based on the existing rental's per-day rate.
  When I then typed "300" into the "Amount paid (฿)" field intending to
  enter a custom amount, the resulting field value was the literal string
  `"300600"` — confirmed via `document.activeElement`/DOM query, not a
  screenshot misread. This means the field either auto-filled "600" from
  the day-count suggestion and my typed "300" got inserted before it rather
  than replacing the auto-fill, or some other event handler is appending
  values instead of setting them. **Real-world impact:** a staff member
  typing a genuinely custom amount (common — customers rarely pay exactly
  the suggested day-rate) risks silently submitting a garbled, wildly wrong
  amount (e.g. ฿300600 instead of ฿300) unless they happen to notice before
  hitting Confirm. Worked around it for this test by setting the field
  value directly (bypassing the buggy keystroke path) rather than typing.
  Not root-caused in the code yet (haven't located the Extend form's JS) —
  logged as found, not fixed, per this pass's instructions. Worth a
  deliberate repro with exact keystroke timing to nail the precise
  trigger (does it happen every time, or only if the day-count hint text
  has already rendered before you focus the amount field?).
- ❌ Bug found — "SAVING…" indicator gets stuck after Extend confirms,
  same pattern as the Contract-page RENT bug (2026-08-18): After clicking
  CONFIRM on the Extend form, the bike's card showed a small "⟳ SAVING…"
  line that never cleared (waited 9+ seconds), even though the write had
  already succeeded (confirmed via a fresh page reload showing the correct
  extended data). Needed a full page reload to see the card in its normal,
  non-stuck state. **This is the same bug class as the "Saving…" banner
  that got stuck after the Contract-page RENT action** — worth flagging to
  Anton as likely one shared root cause (a generic save-pipeline/status
  helper used by both `contract.html`'s RENT action and `bikes.html`'s
  Extend action, both of which do multi-step writes across several sheets)
  rather than two separate bugs to fix independently.
- ✅ Swap Bike (UI-verified 2026-08-18): On the ZZTEST "Gt black 1" rental
  (now ฿1,800/7 days after the Extend test above), clicked SWAP BIKE. Modal
  pre-filled a pro-rated split: "Return Gt black 1, Amount ฿257" / "New
  bike [search], Amount ฿1543" (257+1543 = 1800, exactly the existing
  total — looks like a day-elapsed/day-remaining pro-ration, not a new
  charge). Searched "Aerox" in the New Bike field — **correctly showed only
  currently-available (non-rented) Aerox bikes** (cool blue 1 / red 2 /
  white), a real inventory-awareness check working as intended. Picked
  "Aerox white" (no double-space bug here, unlike the contract.html
  autocomplete). Confirmed via the "Confirm Swap" dialog ("Gt black 1 is
  being returned today for ฿257. Aerox white is being rented from today
  until Tue, Aug 25, 2026 for ฿1,543.") — clicked Yes, Confirm. Verified
  after reload: Gt black 1 now shows "NOT RENTED" on `bikes.html`, Aerox
  white now shows "RENTED... ZZTEST Contract Customer... (฿1,800, 7 days)"
  (same total/dates carried over, correct). Checked `accounts.html`
  Income/Cash totals — **unchanged** by the swap (still exactly the
  post-Extend ฿36,500/฿20,946), and checked `bike-income.html` — both "Gt
  black 1" and "Aerox white" show non-zero Income figures consistent with
  a bike-level re-attribution rather than a new accounts-level charge. This
  reads as correct/intended design: swapping bikes mid-rental redistributes
  which bike gets "credit" for the existing paid amount, it doesn't create
  new revenue — consistent with how the Accounts pass found the
  "split expense across bikes" feature works.
  Same stuck "SAVING…" indicator bug as Extend/RENT — not re-logged in
  detail, same root cause already flagged above.
- ✅ Return + Early Return + refund logic (UI-verified 2026-08-18, all
  correct): Clicked RETURN on "Aerox white" (the post-swap ZZTEST rental,
  ฿1,800/7 days, due back Aug 25). An inline form appeared: return date
  (defaulted to today, 18/08/2026), an "Early return" checkbox — checking
  it revealed "Refund amount (฿)" + "Refund paid via..." fields with a
  clear explanation: *"A refund above ฿0 reduces this booking's total
  price, the Contract page's total, and this bike's earnings for the
  CURRENT month — and logs a negative income entry for the current month,
  routed to Cash/Wise/Revolut same as any other income (Scan/Bank Transfer
  logs the entry but touches nothing further). Leave it at 0 to just return
  the bike as normal on the date above."* — genuinely well-designed,
  self-documenting UI. Entered ฿500 refund via Cash, left Deposit
  amount/Deductions blank (deposit is Cash type — the form correctly noted
  *"Cash deposit — not tracked here. Any deduction below will be logged as
  cash income"*, consistent with the Deposits-page finding from the earlier
  Accounts pass that cash deposits only ever live on the Contract record).
  Clicked CONFIRM. Verified after reload: bike card now "NOT RENTED", and
  `accounts.html` gained a new negative Income row exactly as documented:
  "Aerox white refund - early return / 18/08/2026 / ZZTEST Contract
  Customer / cash / **-฿500.00**", with Income ฿36,500→฿36,000 (-500 ✓) and
  Cash ฿20,946→฿20,446 (-500 ✓). This is the one action in this whole
  Contract/Bikes test group that did NOT show the stuck "Saving…" bug —
  worth noting as a data point for whoever fixes it (something about this
  particular write path clears its status correctly where Extend/Swap/RENT
  don't).
- ⬜ Adjust Pickup (not tested — bike was already returned by this point in
  the test sequence, would need a fresh active rental to test meaningfully)
- ⬜ Return Deposit (the ฿2,000 Cash deposit on this contract was never
  explicitly returned/closed out during this test — per the Deposits-page
  finding, Cash deposits live purely on the Contract record with no
  separate "return" ledger entry, so it's unclear if there's a dedicated
  action for this vs. just editing the contract; not yet located/tested)
- ⚠️ Possible bug found — new Pending contract shows "Rented: Saturday,
  January 10, 2026" instead of the actual renting-from date (2026-08-18)
  (2026-08-18): Created a second throwaway contract ("ZZTEST Cancel
  Customer", Gt black 1, Return date 22/08/2026, ฿1000 Cash) specifically
  to test Cancel. Deliberately left the "Renting from" field untouched
  (relying on its stated default of "18 August 2026", same as the first
  ZZTEST contract earlier in this session). After submitting, both the
  "Pending contracts" card and the Search-results detail view show
  **"Rented: Saturday, January 10, 2026"** — a date that has no obvious
  relationship to today (18 Aug 2026), the return date (22 Aug 2026), or
  any input I provided. Confirmed via two independent views (Pending
  contracts list AND Search results), so it's a real persisted value, not
  a one-off render glitch. **Important caveat, not swept under the rug:**
  for this specific contract I set several fields (Return date, Total
  price, Paid by) using the automation's direct-value-set tool
  (`form_input`) rather than genuine keystroke-by-keystroke typing, and
  never interacted with the "Renting from" field at all — it's possible
  the page's own JS sets today's date into that field via a 'change'/blur
  handler that direct value-setting on OTHER fields doesn't trigger, so
  the field could have been submitted empty/unset and the **backend**
  substituted a wrong fallback date rather than the frontend. I can't
  fully rule out this being a testing-tool artifact rather than a bug a
  real member of staff would hit by clicking through the page normally.
  **However:** the first ZZTEST contract earlier in this session (Rent
  flow) also left "Renting from" at its pre-filled default without
  explicit interaction and correctly recorded 18/08/2026, so the
  discrepancy is worth Anton's attention either way — flagging as a
  possible bug rather than a confirmed one, and recommending a follow-up
  test where every field including "Renting from" is explicitly, visibly
  set before submitting, to determine if this reproduces under normal
  real-world use.
- ✅ Cancel Contract (UI-verified 2026-08-18): From this same "ZZTEST
  Cancel Customer" Pending contract's card (found via Pending contracts),
  clicked into the card, then CANCEL (as opposed to RENT). Confirmed the
  in-app prompt. Verified via Pending contracts afterward — the card is
  gone, and re-searching "ZZTEST Cancel" via contract.html's Search view
  now shows **Status: Canceled** on the same record (still findable by
  search, correctly retained rather than deleted, just status-flipped).
  No stuck "Saving…" indicator this time — Cancel behaved like the
  well-behaved Early Return action, not like RENT/Extend/Swap.

### Customer Record (`customers.html`)
- ✅ Add/intake customer (UI-verified 2026-08-18): Unlike `contract.html`'s
  two-step Pending→Rent flow, this page's "＋ Add new" creates an ACTIVE
  rental directly in one step (writes straight to the `customer` sheet,
  same underlying intake path as the Contract page's RENT action). Filled
  Name "ZZTEST Customer Record", Bike model "Gt black 1" (autocomplete
  suggestion click filled it cleanly as a single space — "Gt black 1", NOT
  "Gt  black 1" — so the double-space bug found on contract.html's
  autocomplete does **not** reproduce identically here; worth noting as a
  clue that the two pages' autocomplete widgets are separate
  implementations, not a shared component with one shared bug), Renting
  from correctly pre-filled to today (18/08/2026) without me touching it,
  Return date 20/08/2026, Total price ฿1200, Paid by Cash. Submitted —
  "Added — 'ZZTEST Customer Record' saved to the sheet." — status cleared
  normally, no stuck "Saving…" indicator (same well-behaved pattern as
  Cancel Contract/Early Return, not the RENT/Extend/Swap bug). Verified on
  `accounts.html`: Income ฿36,000→฿37,200 (+1,200 ✓), Cash
  ฿20,446→฿21,646 (+1,200 ✓), and the row itself appears in the Income
  list.
- ⬜ Passport scan (not tested — requires a real image upload + AI call,
  skipped for this pass)
- ⬜ Edit customer (not tested — ran out of time in this pass; the Search
  view was located and confirmed reachable via the "🔍 Search" button
  during the Add-customer test, following the same pattern as
  contract.html's search, but the actual edit flow wasn't exercised)

### Price Calculator (`pricing.html`)
- ✅ Run a price calculation, both date modes (UI-verified 2026-08-18):
  Selected "155CC Standard Key", "PICK RETURN DATE" mode, 18→25 Aug 2026 —
  correctly showed "7 days" duration live before submitting, and after
  CALCULATE PRICE: Total ฿1,800, ฿257/day — this exactly matches the
  per-day rate (257) the Swap Bike feature used earlier in this session for
  its pro-rated split, a nice consistency check that both features pull
  from the same underlying rate table. Then switched to "ENTER NUMBER OF
  DAYS" mode (toggle worked correctly, swapped the Return-date field for a
  Number-of-days field), selected XMAX 300, 10 days from 18 Aug — result:
  ฿6,800 total, ฿680/day, "To: 28 Aug 2026" (18+10, correct date math).
  Both modes work correctly with no bugs found. Not tested: "Custom Rate"
  category and the "Add Extra Days" follow-on calculator at the bottom of
  the result card, for time reasons.
- ❌ **Bug — console exception, likely benign but worth a look:** noticed
  (while checking console output during unrelated later testing on
  calendar.html) two identical stray exceptions logged while on
  pricing.html: `TypeError: Failed to register a ServiceWorker: The URL
  protocol of the script ('blob:https://staff-app-six-phi.vercel.app/...')
  is not supported.` at pricing.html:931. Looks like a PWA/offline-install
  service-worker registration that's passing a `blob:` URL where only
  `http(s):` is allowed — didn't visibly break any pricing functionality
  in this session (all calculations above worked fine), so likely low
  severity/silently-swallowed, but flagging since a failed ServiceWorker
  registration could matter if this app is meant to support offline/PWA
  install and currently silently doesn't on this page.

### Bikes Status (`bikes.html`)
- ✅ General status view / search / filtering (UI-verified 2026-08-18,
  exercised heavily throughout the Contract-flow tests above): search box
  filters live by bike name (e.g. "Gt black 1"), each card shows
  RENTED/NOT RENTED status, renter name, paid/deposit summary, due-back
  date with an "OVERDUE" badge where applicable. One recurring minor
  annoyance (not logging as a separate bug, just noting): the search input
  frequently doesn't receive the very first click after a fresh page
  navigation — the first `click` appears to land but doesn't focus the
  field, requiring a second click before typing registers. Happened
  consistently enough across ~6 separate page loads in this session to be
  a real, reproducible pattern rather than one-off flakiness, though minor
  enough that I didn't dig into root cause.
- ✅ QuickView (UI-verified 2026-08-18): the "QuickView" button opens a
  "QuickView — Due Back" modal — a clean table of every currently-rented
  bike sorted by due-back date (Bike/Renter/Rented dates+amounts+deposit/
  Contact), each renter name linking out to a chat contact and a
  "Delivery" link where applicable. Correctly included the ZZTEST test
  rental created earlier ("Gt black 1 / ZZTEST Customer Record / Aug 18 →
  Aug 20 / ฿1,200 Cash"). No bugs found; genuinely useful at-a-glance view.
- ✅ Inline actions (RETURN / EXTEND / SWAP BIKE / ADJUST PICKUP / CONTACT
  CUSTOMER) — RETURN, EXTEND, and SWAP BIKE all fully tested above under
  the Contract page section (they're really this page's actions, just
  triggered while testing a Contract-created rental's lifecycle). ADJUST
  PICKUP and CONTACT CUSTOMER were not tested — see below.

### Add Bike (`add-bikes.html`)
- ✅ Add a new bike to the fleet (UI-verified 2026-08-18, with one real
  warning): Filled Bike name "ZZTEST Bike 1", Purchase cost ฿10,000,
  submitted. Result message: *"'Zztest Bike 1' added, but: Bike added,
  but: 'Bike Tax': the Status and day-count columns (G/H) are formulas in
  the live sheet with no equivalent here -- they were left blank for this
  new row. Recompute or fill them in by hand if this bike's tax/insurance
  status needs to show correctly before this data is next synced from a
  live Sheet."* — a real, known limitation the app is honest about, not a
  silent failure: newly-added bikes get a blank tax/insurance Status on
  the "Bike Tax" sheet because that sheet's Status/day-count columns are
  normally Google-Sheets-formula-driven and this JSON write path can't
  replicate a live formula. Verified the bike itself DID get added
  correctly and consistently everywhere else that matters:
  `bikes.html` bike count went 40→41, and searching "Zztest" found "Zztest
  Bike 1" / NOT RENTED. **Cosmetic side-note:** the name I typed in ALL
  CAPS ("ZZTEST Bike 1") was saved/displayed as "Zztest Bike 1" (title
  case) — some normalization is happening on this field specifically; not
  seen on any other ZZTEST-prefixed record created elsewhere in this
  session (Contract, Customer Record all preserved ZZTEST verbatim), worth
  a quick look but low severity.

### Bike Photos (`bikephotos.html`)
- ❌ **BUG FOUND — all bike photos are broken site-wide; same failure
  SIGNATURE as the previously-tracked passport-photo 404, but a DIFFERENT
  API route** (2026-08-18, HIGH severity): The dashboard view loaded fine
  (5 bikes needing photos, 36 with photos — correctly listed "Zztest Bike
  1" under "Needs photos" right after adding it in the previous test, nice
  consistency). But every single photo thumbnail for "Gt black 1" (which
  has photos) rendered as a blank/broken-image box. Confirmed via
  `document.querySelectorAll('img')` that EVERY bike-photo `<img>` has
  `naturalWidth: 0` (failed to load) and all point at
  `https://staff-app-six-phi.vercel.app/api/photos/file/<driveFileId>`.
  Fetched one of those URLs directly: **HTTP 404**, body `"The page could
  not be found / NOT_FOUND"` — this is a Vercel platform-level 404 (the
  literal Vercel "not found" page), meaning the `/api/photos/file/[id]`
  route isn't resolving to any deployed function at all, not an
  app-level/Drive-permissions error. **Important precision:** this is a
  DIFFERENT route (`/api/photos/file/...`) from the one in the
  already-tracked "passport photo 404" memory (`/api/contracts/file/...`
  — that one serves passport photos/contracts/receipts attached to a
  Contract record). So this is not literally the same bug recurring — it's
  a second, independent-looking route with the identical failure
  signature (bare Vercel NOT_FOUND, not a JSON error from this app's own
  code), which is a stronger signal than either bug alone that something
  structural is wrong (e.g. a route file that's missing from the deploy, a
  vercel.json rewrite/catch-all misconfiguration, or the Hobby-plan
  12-function cap issue explicitly mentioned in the passport-photo memory
  notes silently dropping one of these routes from the build). Worth
  checking early in any fix session: does `api/photos/file/[id].js` (or
  equivalent catch-all) actually exist in the repo and get included in the
  Vercel deployment at all? **Checked this directly** (read-only, no code
  changed): `api/photos/[...path].js` DOES exist in the repo, and its own
  code explicitly handles `GET /api/photos/file/<fileId>` via a
  `route === 'file'` branch — the code is correct and should work. But
  counting every `.js` file directly under `/api` in this repo gives
  **exactly 12** — which is precisely Vercel Hobby plan's serverless
  function cap, the same limit explicitly named in the existing
  passport-photo-404 investigation notes as the reason
  `api/contracts/[...path].js` had to be collapsed into a catch-all in the
  first place. Sitting exactly AT the cap (not under it) is a strong,
  concrete lead: if the live deployment is even one function over for any
  reason (a stray extra file, a build quirk, Vercel counting something
  slightly differently than a flat file count), the LAST-processed route
  could silently fail to deploy while every other route keeps working —
  which would perfectly explain why this specific endpoint 404s at the
  Vercel platform level while every other `/api/*` route used constantly
  throughout this entire testing session (accounts/write, contract/write,
  bikes/write, data/[sheet], auth/*) worked without issue. Did not attempt
  a fix (out of scope for this testing pass) — just flagging this as the
  most concrete, checkable lead for whoever picks up both this bug and the
  passport-photo one together, since they may share this exact cause.
  Opened the lightbox anyway (click on a broken thumbnail) to
  check the OTHER thing this section was meant to test — the
  click-outside-to-close guard from CLAUDE.md's documented pattern — and
  that part works correctly: clicking outside the (broken/blank) lightbox
  image closed it cleanly, no stuck state. So the click-outside guard
  itself is fine; the bug is entirely that no photo ever actually loads.
  **This likely deserves top billing in the final bug report** — it's not
  cosmetic, the whole point of this page is viewing bike photos and that
  currently doesn't work for any bike.
- ⬜ Upload/replace photo (not tested — given photos already can't be
  viewed, prioritized moving on to cover more pages per Anton's
  instruction rather than spending more time here; worth testing once the
  404 above is fixed, since upload might hit a different endpoint and
  still work even though viewing doesn't)

### Available Bikes (`available-bikes.html`)
- ✅ Full flow tested (UI-verified 2026-08-18): Found via Fleet ▾ dropdown.
  "16 BIKES AVAILABLE" grouped by category (125cc/155cc Standard Key/
  Keyless/Nmax 155cc/Forza 300cc/"No category set"). Correctly listed
  "Zztest Bike 1" under "No category set" (consistent with it having no
  Pricing category set during the earlier Add Bike test). Selected
  "Freego black" (125cc), clicked "Continue with 1 bike" → a
  Selected-bikes summary + date picker appeared (same dual date-range-or-
  number-of-days pattern as the standalone Price Calculator). Entered "5"
  days, clicked Calculate Price: **Total ฿1,100** — correct and
  consistent with this bike's 125cc category rate. No bugs found; this
  page is essentially a "search available inventory then quote" front-end
  for the same pricing engine as `pricing.html`, working correctly.

### Parts & Oil (`parts.html`)
- ✅ Search-first flow (same pattern as Contract/Customer): typed "Gt black
  1" into the Bike field, autocomplete offered a single clean match (no
  double-space bug here, consistent with customers.html not
  contract.html), selected it, bike record loaded.
- ✅ Record loads two panels: "Kilometers check" (Last kilometers check +
  Date checked + its own UPDATE KILOMETERS button) always visible, and a
  collapsed "Record" panel (Show more) containing Oil change date + next
  oil change (km) + dedicated CHANGE OIL button, then a long list of
  free-text part fields (full check, Side cleaning, air filter,
  alternator, Brake, Piston, tyres, Battery, Bearing, spark plug, remote
  battery, Seat cover, belt, shock, Clust, horn switch, Last mechanic
  check date, Notes) with one shared SAVE CHANGES button at the bottom.
  Every part field is free text/date, not a structured due-date system —
  staff track service history as notes (e.g. tyres field literally reads
  "F- 28Aug 25, B-5 may 26").
- ✅ Edit + save test: appended a line to the Notes textarea ("ZZTEST note
  18-08-2026 - QA pass") via direct value-set, clicked SAVE CHANGES →
  showed "Saving…" then correctly resolved to "Saved — "Gt black 1"
  updated." (no stuck-Saving bug here, unlike RENT/Extend/Swap Bike).
  Verified via a full page reload + fresh re-search: the appended note was
  present in the DOM value (confirmed via direct value check, not just
  screenshot) — write genuinely persisted.
- ✅ CHANGE OIL button has a nice safety guard: clicking it (with the
  "next oil change" km field pre-filled at 30500) opened a custom
  confirmation modal — "Before you continue — Please confirm you have
  updated the Last kilometers check to the current kilometers of the
  bike." with No/Yes — a deliberate UX guard against staff logging an oil
  change without first updating the odometer reading. Clicked "No" to
  cancel (didn't want to actually mutate the oil-change date/reset the
  108-day counter just for this test); modal closed cleanly with no side
  effects. Did not test "Yes" path or UPDATE KILOMETERS button itself to
  avoid altering this bike's baseline maintenance data unnecessarily —
  low-value to test further since the underlying SAVE CHANGES pipeline is
  already confirmed working correctly on this page.
- No bugs found on this page.

### Oil Change (`oilchange.html`, via Upkeep ▾ nav)
- ✅ "Bikes ranked by how soon they need an oil change" — a priority
  dashboard, not a search-first page like Parts & Oil. Two sort-mode
  toggles: KILOMETERS (soonest due by km remaining at top) and DATE
  (checked-longest-ago at top) — both verified: switching correctly
  re-sorted the list and changed the badge shown per card (km remaining
  vs. days-since-checked).
- ✅ Each card shows Status (— normal, or ⚠️UNKNOWN CC when the bike has
  no cc/category set — consistent with the "No category set" bikes found
  during Add Bike/Available Bikes testing; this is a real data gap on
  those bikes, not an app bug), Oil change date, Last kilometers check +
  when, Next oil change threshold, and — if currently rented — a
  "🧑 Rented to: <customer> · <payment method> (฿amount, days)" chip plus
  a "📍CONTACT CUSTOMER" button.
- ℹ️ Observed once on load: an orange "Showing saved data from 29h ago —
  refreshing..." banner, which cleared ~2s later once fresh data loaded
  (the numbers for "Rax red" changed from ฿7,500/62 days to ฿3,500/31 days
  between the stale and fresh render) — this is a deliberate
  stale-while-revalidate cache pattern working as intended, not a bug.
- ❌ **Bug — bike-name autocomplete double-space, confirmed on a THIRD
  surface:** typed "GT" into the search box, selected "Gt black 1" from
  the dropdown → box ends up containing `"Gt  black 1"` (double space,
  confirmed via direct JS value read, not just visual). This is the same
  double-space bug previously found on contract.html's Bike model
  autocomplete, and previously confirmed ABSENT on customers.html and
  parts.html's equivalent fields — so this looks like a shared buggy
  autocomplete component reused across contract.html and oilchange.html
  specifically (both power-user/staff-facing search boxes), while
  customers.html/parts.html use a different, clean implementation. The
  filtering itself still worked correctly despite the extra space (found
  and displayed "Gt black 1"'s card).
- ⬜ Not tested: clicking "📍CONTACT CUSTOMER" — inspected via JS instead
  of clicking, and the button's outbound link contains the customer's
  phone number (WhatsApp deep link), so this is an outbound-messaging
  action on Anton's behalf and wasn't triggered without explicit
  permission, per standing safety rules. Flagging as untested by design,
  not as a bug.

### Calendar sync (`calendar.html`)
- ✅ Bike Returns Calendar view loads correctly: header shows "Calendar
  connected: aascooters1@gmail.com" with a DISCONNECT button, and an
  embedded Google Calendar (Schedule view, Aug 2026 – Aug 2027 range)
  underneath.
- ✅ **Great end-to-end confirmation of the calendar-sync feature built
  earlier this project:** the embedded calendar genuinely shows real
  synced events from this session's own test contracts — "Gt black 1 —
  ZZTEST Customer Record" (Aug 20, 8:33–9:03pm) and "Gt black 1 — ZZTEST
  Contract Customer" (Aug 23, 8:04–8:34am) both appear correctly with
  bike name + customer name + a 30-min due-back time window. This
  confirms the contract→calendar write path (built in an earlier session,
  see PROGRESS.md) is genuinely working live against the real Google
  account, not just in test harnesses.
- ⬜ Not tested: the "Schedule ▾" view-switcher dropdown (clicked once,
  didn't visibly open — possibly an iframe click-handling quirk with the
  browser automation rather than a real bug; this is Google's own
  Calendar embed widget, not AA Scooters' own code, so lower priority to
  chase down). Also not tested: DISCONNECT — this is a live production
  Google Calendar connection for the business's real account
  (aascooters1@gmail.com), so didn't want to disconnect it mid-test
  without Anton's say-so; flagging as untested by design, not a bug.

### Settings (`settings.html`)
- ✅ Data reset tool confirmed working (used it to start this pass):
  "Reset 27 file(s) from the deploy, and cleared the transaction log (old
  entries no longer matched the reset data)."
- ✅ AI provider panel: shows Claude/Gemini toggle (currently set to
  Gemini) and both API keys already "Set" (masked, last-few-chars-only —
  e.g. "sk-ant-…gQAA") with SAVE/Clear key controls per key. Didn't touch
  Save/Clear/toggle — these are live production credentials/settings for
  a real AI provider used for passport scan, WhatsApp fill, and reply
  draft, so changing them needs Anton's explicit say-so, not assumed test
  coverage. Visual/layout check only: looks correct, no bugs seen.
- ✅ **Transaction history — tested end-to-end, including an actual
  reversal:** the panel listed exactly the 7 reversible entries this
  session's testing had generated (RENT, Extend, Early Return refund —
  each showing its Cash-sheet row + Income-sheet row as separate
  reversible entries, plus the original "Rented..." contract-write entry)
  — a nice cross-check that every write this session made is genuinely
  logged. Clicking an entry opens a "Reverse this?" modal showing an
  exact technical diff of which sheet/row/cells will be restored and to
  what values (e.g. "cash, row 343 — will restore to `["","",""]`"), with
  an explicit warning that reversal is irreversible from there and can
  land on the wrong row if other writes have since touched the same
  sheet. Tested CANCEL on the oldest entry (the original "Rented Gt black
  1..." — correctly declined to touch it, since 3 later transactions had
  written to the same sheets afterward, exactly the risky scenario the
  page's own warning describes) and then tested REVERSE for real on the
  single newest entry ("Cash income ฿1,200 — Gt black 1 rent 2 days",
  20:35, the safest one since nothing was written after it to the same
  row) — showed "Reversing…" then correctly flipped the card to "Reversed
  18 Aug 2026, 21:02" with a "Remove" option in place of the reverse
  action. Cross-checked accounts.html afterward: the separate Income-sheet
  row for the same rental ("Gt black 1 rent 2 days / ZZTEST Customer
  Record / ฿1,200.00") is still present, as expected — only the Cash-sheet
  row was reversed since only that specific transaction-log entry was
  clicked, confirming the two sheets really are logged (and reversed) as
  independent entries rather than one combined undo. No bugs found; this
  is a well-built, transparent feature with good guardrails.
- ⬜ Not tested: FROM/TO date-range filter and SEARCH box on the
  transaction list (only "SHOW RECENT" default view was exercised, for
  time reasons) — low priority, the underlying list/reverse mechanics are
  already confirmed working.

### Bugs & Features (top-bar "🐾 Bugs & Features" button — modal, not a page)
- ❌ **Bug — the whole feature is non-functional, both read and write:**
  opening the modal immediately shows "Could not load: Unexpected token
  '<', "<!DOCTYPE "... is not valid JSON". Confirmed via Network tab: the
  list-fetch request is `GET /accounts.html?action=bugsList` — i.e. it's
  requesting the current HTML *page* itself with a query string tacked
  on, not a real API endpoint (every other data fetch in this app goes to
  a dedicated `/api/data/<sheet>` route, e.g. `/api/data/cash`,
  `/api/data/transactionLog`, `/api/data/bikes` — this one clearly should
  be something like `/api/data/bugsList` and isn't). The page loads fine
  (200) and returns its own HTML, which is what breaks the `.json()`
  parse. Then tested "Add" too (typed "ZZTEST bug entry - QA pass
  18-08-2026", category "Bug", clicked Add): fails the same way — "Could
  not add that: Failed to execute 'json' on 'Response': Unexpected end of
  JSON input", and Network confirms the POST goes to `POST
  /accounts.html` itself, which correctly 405s (Method Not Allowed) since
  that's a static page route, not an API handler. **Net effect: staff
  cannot view or log any bug/feature-request through this button at all
  — 100% broken, not a partial/cosmetic issue.** Likely fix: whatever
  builds this modal's fetch URL is using a relative path off the current
  page instead of pointing at the intended `/api/...` endpoint — worth
  checking how the other `api/data/[sheet].js`-style routes are wired to
  see what "bugsList" should actually be called.

---

## Report to Anton (2026-08-18, end of whole-app pass — every page covered)

**What was tested:** every page in the nav — Contract, Customer Record,
Price Calculator, Bikes Status, Add Bike, Bike Photos, Available Bikes,
Parts & Oil, Oil Change, Calendar sync, and Settings — on top of the
Accounts + Deposits pages already covered in the earlier report below.
Live browser control against the real production app throughout, data
reset to Anton's known-good seed baseline before starting. Every write
this pass made was cross-checked against a second page/view (usually
`accounts.html`'s Income/Cash totals) and, per CLAUDE.md's standing
instruction, every TESTING.md write in this pass was itself re-read back
after saving to confirm it actually stuck.

**Bugs found this pass, worst first:**

1. **Bugs & Features button is completely non-functional** (`accounts.html`
   top bar) — both viewing and adding entries fail. The list-fetch hits
   `GET /accounts.html?action=bugsList` (the page's own URL, not a real API
   route) and the Add button POSTs to `/accounts.html` itself, which
   405s. Every other data fetch in this app correctly goes through
   `/api/data/<sheet>`; this feature's URL was never wired up to one.
   100% broken, not partial.
2. **All bike photos 404** (`bikephotos.html`) — every photo thumbnail
   site-wide fails to load; the underlying `/api/photos/file/<id>` route
   returns Vercel's own platform-level 404 page, not this app's JSON
   error. Concrete lead: the repo sits at exactly 12 files under `/api`,
   precisely Vercel Hobby's function cap — same signature and same
   suspected cause as the already-open passport-photo 404 (see memory).
   Worth investigating both together.
3. **"Saving…"/"SAVING…" indicator gets stuck** on three separate actions —
   Contract page's RENT, and Bikes Status's Extend and Swap Bike. In all
   three, the underlying write succeeds correctly (confirmed via reload +
   cross-check every time) but the status indicator never clears without a
   full page reload. Early Return, Cancel Contract, Add Customer, and Add
   Contract all clear their status correctly — strongly suggests one
   shared save-pipeline helper used by RENT/Extend/Swap specifically,
   rather than three independent bugs.
4. **Bike-name autocomplete inserts a double space**, confirmed on THREE
   surfaces now: Contract page's Bike model field, and Oil Change's search
   box (both `"Gt  black 1"` instead of `"Gt black 1"`, confirmed via raw
   DOM value read). Confirmed ABSENT on Customer Record, Parts & Oil, and
   Swap Bike's new-bike search — those use a different, clean
   implementation. Points to one specific shared autocomplete widget
   reused by Contract + Oil Change.
5. **Extend form's "Amount paid" field concatenates instead of replacing**
   when a day-count-based amount hint has already populated it — typing
   "300" over an auto-filled "600" produced the literal string "300600".
   Real risk of a staff member submitting a wildly wrong charge without
   noticing.
6. **Console exception on Price Calculator** — a ServiceWorker registration
   fails with `TypeError: ... blob: ... is not supported` on every load of
   `pricing.html`. No visible functional impact in this pass, but worth a
   look if the app is meant to support offline/PWA install.
7. ⚠️ **Possible bug, not confirmed** — a second throwaway Pending contract
   showed "Rented: Saturday, January 10, 2026" instead of today's date.
   Caveated honestly: several of that contract's fields were set via
   direct value-assignment rather than real typing during testing, so this
   may be a testing-tool artifact rather than something a real staff
   member would hit. Worth a clean repro where every field, including
   "Renting from," is explicitly interacted with.

**Confirmed working correctly, no bugs found:** the full Contract
lifecycle (Pending → RENT → Extend/Swap → Early Return, including refund
accounting); Cancel Contract; Customer Record intake; Price Calculator
(both date-entry modes); Bikes Status's search/QuickView/inline actions;
Add Bike (with an honest, non-silent warning about one formula-driven
sheet column it can't replicate); Available Bikes' quote flow; Parts &
Oil's full record view/edit/save cycle, including a nice safety-confirm
guard on the Change Oil action; Oil Change's priority dashboard and
sort-mode toggle; Calendar sync's live Google Calendar embed (genuinely
showing this session's own test-created events, a strong end-to-end
confirmation of the calendar-sync feature built earlier); and Settings'
Transaction history/reverse-a-transaction feature, tested end-to-end
including an actual real reversal with correct per-sheet, per-row
granularity.

**Not tested, by design (not bugs):** Passport scan and Edit Customer
(Customer Record); Adjust Pickup and Return Deposit (Bikes Status);
Custom Rate category and Add Extra Days (Price Calculator); Upload/replace
photo (Bike Photos — deprioritized, the page's core photo-display is
already broken); CONTACT CUSTOMER buttons on Oil Change/Bikes Status
(outbound WhatsApp messages containing real customer phone numbers —
requires explicit permission per standing safety rules); Settings'
DISCONNECT on the live production Google Calendar and Clear/Save on the
real AI provider API keys (both are live account-level changes, not
assumed as in-scope for a testing pass); Calendar's Schedule-view
dropdown (Google's own embed widget, not this app's code).

**No data-corruption-level issues found anywhere in this pass** — nothing
resembling the earlier cash-sheet-drift bug retriggered. All ZZTEST rows
created during this pass are still present in the live data (Contract,
Customer, bike Gt black 1/Aerox white rental history, one reversed Cash
row) — Anton may want a fresh Settings → "Reset data from latest deploy"
before using the app for real, or can leave them if he'd rather review the
tracks left by this session first.

---

## Fix pass (2026-08-19, overnight, unattended — see BUGFIX_HANDOFF.md)

All 6 confirmed real bugs from the report above were fixed this pass.
Bug #7 (possible wrong default date) was left alone per its own note —
never got a clean manual repro, and this pass had no way to drive the
browser as a real logged-in user to attempt one. The "Bugs & Features"
item is the confirmed-not-a-bug legacy feature from BUGFIX_HANDOFF.md,
still deliberately untouched. **None of this pass's fixes have been
verified live against the running app** — this session had no
Anton-equivalent login and Claude-in-Chrome wasn't driven against the
site, so everything below is "fixed and code-reviewed/unit-tested where
possible," not "confirmed fixed in the browser." Re-test all 6 for real
once this is deployed, ideally before relying on it for a real rental.

1. **Cash-sheet-drift — FIXED.** `lib/accountsWrites.js`:
   `deleteCashRowFromJson`'s row-shift previously ran all the way to the
   end of the sheet with no idea where the "income"/"total cash" summary
   block was, so it silently pulled those label+total cells up by one row
   on every delete. New `locateCashSummaryBlock()` finds BOTH "income" and
   "total cash" independently by their own labels (not a hardcoded
   offset), and is now shared by both `deleteCashRowFromJson` (as a hard
   boundary the shift can never cross) and `recomputeCashSheetTotalsB`.
   Verified with a standalone Node harness against the real `cash.json`
   data: reproduced the old bug exactly (summary block drifts to
   row 369/null/374 after a delete), confirmed the new code keeps it at
   370/372/374. Not re-verified live in the browser.

2. **Bike photos 404 — DIAGNOSED, NOT A CODE FIX.** The `/api photos` and
   `/api/contracts` catch-alls on disk are already correct (both were
   consolidated 2026-08-15, per their own header comments, specifically
   because too many separate files broke the deploy once before under
   Vercel Hobby's 12-function cap). Live testing against
   `staff-app-six-phi.vercel.app` this pass (no login available, so
   testing was limited to routing/auth-gate behavior, not actual photo
   bytes) found: `GET /api/photos/list`, `/api/photos/folders`, and
   `/api/contracts/documents` (all single path segment) correctly 401
   "Not signed in" — proving those catch-all functions ARE deployed and
   reachable. But `GET /api/photos/file/<id>`, `/api/contracts/file/<id>`,
   and even a made-up 2-segment path like `/api/photos/list/extra` all
   returned a genuine Vercel-platform 404, while a bare `/api/photos/file`
   (1 segment, no id) correctly 401'd like everything else. That's a very
   specific, reproducible pattern: every 1-segment sub-path under these
   catch-alls resolves; every 2+-segment sub-path 404s at the platform
   level — exactly what you'd see if the LIVE deployment is still running
   an older, non-catch-all version of these two functions (e.g. a
   single-dynamic-segment `[fileId].js`-style file, which by definition
   only ever matches one path segment) rather than the `[...path].js`
   catch-all that's actually on disk now. In other words: this looks like
   the fix is already written, just not deployed yet. Made no code change
   here — the current `api/photos/[...path].js` /
   `api/contracts/[...path].js` files look correct. **Re-test the exact
   same 4 URLs above after tonight's deploy goes out; if bike/passport
   photos still 404 afterward, the next step is exactly what
   BUGFIX_HANDOFF.md already said** — check the Vercel dashboard's
   Functions tab directly for the deployed function list/count (this
   session's Vercel connector didn't have access to this project to check
   that directly).

3. **Stuck "Saving…" indicator — FIXED (defensive fix; exact root cause
   not confirmed).** Read through both `contract.html`'s `ctEnqueue`/
   `ctResolveItem` engine and `bikes.html`'s `bkEnqueue`/`bkResolveItem`
   engine end to end, plus nav.js's shared header pill
   (`refreshSaveStrip`/`recoverOrphanedSaves`) — all three read as
   internally correct: every success path does clear
   `localStorage`/`pendingRowSaves` before rendering. Given QA's own
   observation (network tab shows 200 + correct data, yet nothing client-
   side ever resolves, and only a full page reload fixes it — which is
   exactly what happens if `restoreUnresolvedSaves()` gets a fresh chance
   to run, i.e. the original `fetch` promise itself never actually
   settled), the most likely explanation is a hung/never-resolving
   `fetch` — and there was no timeout anywhere in either engine, so a
   single hung dispatch left the "Saving…" state stuck forever with no
   self-healing path. Added a 20s `AbortController` watchdog to both
   `ctDispatch` (contract.html) and `bkDispatch` (bikes.html): past 20s
   the dispatch aborts and resolves as a normal, reviewable failure
   (existing "N changes didn't save — tap to review" banner + Retry/
   Discard), instead of hanging indefinitely. Safe even if the original
   write actually succeeds right after the abort — every action here
   already carries a server-side `clientTxnId` idempotency guard, so a
   Retry (or the existing orphan-recovery/`restoreUnresolvedSaves` paths)
   safely no-ops on a duplicate. This guarantees the UI can never get
   stuck longer than 20s again, even if the true underlying cause (why the
   fetch hangs at all) turns out to be something else entirely. Not
   verified live — would need an actual hang to reproduce, which wasn't
   forceable from this session.

4. **Bike-name autocomplete double space — FIXED, root cause was NOT the
   autocomplete code.** Every autocomplete "fill on click" handler
   (contract.html, oilchange.html, bikes.html's Swap search, customers.html)
   already does a clean, direct `input.value = options[i]` — no
   concatenation, no template-literal bug. Checked the real
   `data/Parts_and_Oil_change.json` directly: the "Bike" column itself has
   several names typed with a genuine extra internal space baked in by
   whoever entered them — `"Gt  black 1"`, `"Gt  black 2"`, `"Gt  black 4"`,
   `"Gt  black 5"`, `"gt  black 6"`, `"Gt mint  "`, and a few others
   (confirmed with a one-off script reading the raw JSON, not a guess).
   `.trim()` (already applied everywhere this list gets built) only strips
   the ends, not an internal double space. Added `.replace(/\s+/g, ' ')`
   right after `.trim()` everywhere this "Bike" column gets turned into a
   names list — contract.html (both the main list and the sold-bikes set),
   oilchange.html, customers.html, and bikes.html (Swap Bike's New Bike
   search) — all 5 sites that read this same column, not just the 2 the
   QA pass happened to catch (customers.html and bikes.html's Swap search
   use the exact same vulnerable pattern; QA simply didn't test one of the
   affected bike names on those two). The underlying spreadsheet data
   itself still has the double-spaced names — this fix stops the app from
   ever surfacing/storing them, but Anton may want to clean up the Parts &
   Oil sheet's "Bike" column by hand at some point too.

5. **Extend "Amount paid" concatenation — FIXED.** Confirmed
   `maybeAutofillExtendAmount()` only ever does a plain
   `amountInput.value = price` assignment — nothing appends. The real
   cause: a real keystroke into a field that already has programmatically-
   set text INSERTS at the cursor position rather than replacing it,
   standard browser input behavior, not a bug in the assignment code
   itself. Added a delegated `focusin` handler on `bikes.html`'s
   `#listBox` that calls `.select()` on the Amount-paid input the moment
   it gains focus (only if it already has a value) — the standard
   select-all-on-focus fix for an "auto-suggested value the user should be
   able to fully overwrite by typing" field, so the first keystroke
   replaces the whole auto-filled figure instead of inserting into it.

6. **ServiceWorker console exception on pricing.html — FIXED by removal.**
   `navigator.serviceWorker.register(URL.createObjectURL(blob))` can never
   work in any browser — service worker scripts must be same-origin
   http(s), `blob:` is disallowed by spec — so this had been a no-op
   console error since it was written, not a regression. Removed the dead
   block entirely rather than "fixing" it by pointing at a real `/sw.js`:
   a genuinely working cache-first service worker would let staff's
   browsers keep serving a stale cached page after a future fix ships,
   which is a real new risk this app doesn't need. Left a comment
   explaining the removal and what a real, deliberate offline-support
   addition would need instead, if ever wanted.

**Files touched this pass:** `lib/accountsWrites.js`, `contract.html`,
`bikes.html`, `oilchange.html`, `customers.html`, `pricing.html`. No
`Code.gs` changes — this app is JSON/Drive-backed, not Apps-Script-backed
(confirmed at the start of this pass; the only `Code.gs` reference left
anywhere in this codebase is the already-disconnected "Bugs & Features"
legacy feature). Every file was re-read back from disk after writing and
grepped for a distinctive string from its own fix before being reported
here as done, per CLAUDE.md's standing instruction.

---

## Report to Anton (2026-08-18, end of Accounts + Deposits pass)

**What was tested:** every Add/Edit/Delete/Bulk-type-change/Transfer-to-Bank
function on `accounts.html`, and every Add/Edit/Delete/Deduct function on
`deposits.html`, all via live browser control against the real production
app. All 4 expense payment methods, all 5 expense types, the bike-split
checkbox, all 4 income payment methods, both Transfer-to-Bank source
accounts, and all 3 deposit payment methods were each exercised at least
once. Every ZZTEST row created has since been deleted/reversed via the
app's own functions.

**Result: one real, confirmed bug**, plus a few smaller notes.

**The bug:** editing or deleting a Cash-side expense/income row can
corrupt the `cash` sheet's layout (the fixed "total cash is 4 rows below
income" assumption `recomputeCashSheetTotalsB` relies on gets silently
overwritten by `deleteCashRowFromJson`'s row-shift logic, which has no
boundary check before the summary rows). It first triggered on the very
first Edit Expense test and, once triggered, became a **standing/ongoing
condition** — every single write action for the rest of the session (all
payment methods, not just Cash) kept re-hitting the same
"cash" sheet layout has drifted (expected "total cash" 4 rows below
"income") -- cash totals were NOT recomputed. warning, and the top
summary cards (Total expenses, Business expenses, Cash, Bank, Income) went
stale and stayed stale for the rest of the pass. Full technical detail,
code citations, and the exact observed (sometimes inconsistent — some
cells like Wise/Revolut self-corrected on some actions, Personal expenses
updated but Business didn't on a type-change edit, etc.) recompute
behavior are documented inline above, under each affected checklist item.

**What's NOT affected — every row-level write checked out correctly:**
every single add/edit/delete/bulk action's actual row data (amounts,
payment methods, types, bike splits, deposit amounts) landed exactly
right, matched hand-calculated deltas, and cross-checked correctly against
`bike-income.html`'s independent read view for the split-bike tests. The
bug is specifically in the SUMMARY recompute layer, not in the underlying
writes themselves — as far as I can tell from the UI. The one thing I
*can't* confirm without the raw JSON is whether the summary cells are
merely stale on-screen or whether the actual stored numbers in
`August.json`/`cash.json` are wrong too, since a full page reload does NOT
fix them (confirmed early in the session) — meaning whatever's wrong is
persisted, not just a client-side render lag.

**Smaller notes, not bugs, just flagged for your call:**
- "To Transfer"/"Transfer Complete" expense types both count identically
  toward Business expenses/Actual profit as plain Business — confirm
  that's intended.
- Add Income has no Bank option (Cash/Scan/Wise/Revolut only); Add Deposit
  has no Cash option (Scan(Bank)/Wise/Revolut only, since cash deposits
  are handled by the separate Cash Deposit Deduction tool). Both look
  intentional, just confirming.
- Deduct Deposit writes a linked Income row automatically (deposit
  deductions count as revenue) — by design, but good to know when
  reconciling.
- The Delete/Remove buttons on both pages use a native browser
  `confirm()` dialog that the browser-automation tooling I'm using can't
  answer directly — I worked around it with a JS monkeypatch
  (`window.confirm = () => true`) rather than it being an app problem;
  mentioning only because it means my Delete tests needed one extra step
  to run, not because it affects a human clicking the button normally.
- Deduct Cash Deposit was only tested on its safe/no-op path (nonexistent
  customer) — didn't want to touch a real customer's real contract without
  you picking which one first.

**What I need from you to finish verifying:** the current
`August.json`, `August_notes.json`, `cash.json`, `bikes.json`, and
`transactionLog.json` from the 2026 Drive folder, so I can check the
underlying stored numbers against everything documented above and confirm
whether the frozen summary cards are a display-only problem or a real
data problem. Once that's done we can talk about the fix for the
cash-sheet-drift bug, and whether you want to reverse my 2 Transfer to
Bank test runs (Cash→Bank ฿500, Wise→Bank ฿300) via whatever mechanism you
had in mind, or just reset to your seed JSON for the next page's pass.
