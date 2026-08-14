# AA Scooters — JSON-parity rewrite progress tracker

Last updated: 2026-08-14 (full repo-wide re-audit — see below). Keep this
file current — whenever a page's write layer gets ported/tested/pushed,
update its row below in the same commit. This exists because work on this
project gets picked up across multiple Claude sessions/accounts with no
shared memory between them — this file is the handoff.

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
| bikes.html | Done | Done | markReturned/updateReturnPickup, short-extension, swapBike, earlyReturnBike, returnDeposit, long-extension (30+ day) all ported+tested. `fetch(scriptUrl` sweep: 0 real calls (2 comment mentions only). |
| accounts.html | Done | Done | addExpense/editExpense/deleteExpense/addIncome/editIncome/deleteIncome/transferToBank, plus expense-type persistence + bulkSetExpenseType. New design decision made unilaterally: expense type is now stored as a notes-sidecar marker on column E (`EXPENSE_TYPE_NOTE_COL_B`) since real cell colors have no JSON equivalent — **not explicitly approved by Anton, flagged for review.** `fetch(scriptUrl` sweep: 0 real calls. |
| contract.html | Done | Done (Create/Edit/Cancel) | Drive-file actions (findContractDocument, uploadPassportPhoto, generateReceipt, generateChecklist, getFilesForShare, regenerateContract) still hit the old scriptUrl by design — these need a live Drive/PDF backend regardless of the JSON migration, not in scope for this effort. 13 real calls remain, all confirmed Drive-file ops. |
| customers.html | Done | Done (intake) | Customer-intake write cascade ported, shared with contract.html's doRent path. `fetch(scriptUrl` sweep (2026-08-14): 0 real calls (2 comment mentions only) — the "2 sites not yet audited" note from before was stale, there's nothing left here. |
| deposits.html | Done | Done | deductDeposit/deductCashDeposit AND addDeposit/editDeposit/deleteDeposit (`addDepositEntryJson`/`editDepositEntryJson`/`deleteDepositEntryJson`) are ALL already ported and already committed+pushed (commit `1dba35c`, whose message only mentioned deductDeposit/deductCashDeposit — misleading, but the diff shows all five). **Confirmed via `fetch(scriptUrl` sweep (2026-08-14): 0 real calls left, and md5 of the container's copy matches the Mac's committed copy exactly.** This row was wrongly marked "Partial" before — no work was actually needed here. |
| add-bikes.html | Done | Done | editBike/addBike/sellBike/unsellBike all ported+tested (see git log `f1b170c`). `fetch(scriptUrl` sweep: 0 real calls. Two purely cosmetic, documented gaps remain (nothing downstream reads either back): sold-row strikethrough styling, and Bike Tax's Status/day-count (G/H) columns for a newly-added bike. |
| available-bikes.html | Done | n/a (read-only page) | |
| bike-income.html | Done | n/a (read-only page) | |
| bikephotos.html | Done | Out of scope | uploadPhoto/deletePhoto are Drive file operations — need a live backend regardless of JSON migration. 4 real calls remain, confirmed Drive-file ops. |
| oilchange.html | Done | Done | |
| parts.html | Done | Done | Turned out ALREADY PORTED in the cloud sandbox (dated 13/08/2026 in its own code comment) but never pushed — the exact bikes.html near-miss pattern, again. `getPartsDataFromJson`/`updateBikeRowJson` were already fully written and wired to the UI (`saveFields`/`performQuickSave`/`performSave`). Tested via `/tmp/parts_write_test.js` (existing thin test extended 2026-08-14 with: date/numeric/text/blank value-type coercion checks, clearing a field to blank actually clears it, an unknown field name is silently ignored rather than crashing, categoryRows/rates are populated from real Bike_Tax/rates_per_day data, and a malformed rates sheet reports a warning rather than throwing) — all pass. `readOdometerWithAI` correctly stays on the old disconnected path (AI vision call, no backend integration exists for this). Pushed to Mac, confirmed via md5 match (`b451b8a...`). |
| reply-assistant.html | Done | Done | `addContact` (`addContactFromJson`) is already ported and wired (line ~1212) — the "not yet audited" note was stale. `fetch(scriptUrl` sweep: 2 real calls remain, both confirmed AI-assist (`generateReplyDraft`, `readWhatsAppContactWithAI`) — correctly out of scope. |
| bike-name-audit.html | Done | Done | `fetch(scriptUrl` sweep (2026-08-14): 0 real calls (1 comment mention only) — the "1 site not yet audited" note was stale, nothing left here. |
| index.html | n/a | Out of scope (confirmed) | `createMonthSheetFromTemplate` (line ~243) is a TEMP/TEST button that creates a whole new monthly SHEET from a template — structural/month-rotation, not a row-level write against an existing sheet's data, genuinely a different concern from this migration. Recommend leaving as-is; flag to Anton for explicit confirmation before ever touching. |
| pricing.html | **NOT DONE** | n/a (read-only page) | Confirmed real gap (2026-08-14 sweep): `loadLiveRates()` still does a bare `fetch(scriptUrl + '?action=rates')` (line ~589). Low severity by design — the page already works fully offline against `RATES_FALLBACK` and this call fails silently into a "showing last-known rates" message, so nothing is actually broken for staff, but the rate table can never actually refresh from real data until this is ported. Small, low-risk task. |
| login.html | n/a | n/a | No scriptUrl at all. |
| calendar.html | n/a | Isolated (by design) | Wired to a real but ISOLATED test Google account (`aascooters1@gmail.com`) via a standalone `TestCalendarScript.gs` deployment — NOT a JSON port, and shouldn't be; reminders/calendar events aren't spreadsheet data. Live `aascooterchiangmai@gmail.com` calendar untouched. There was a task (#27) to "assess and port the delivery-link + auto-sync gap" — re-clarify with Anton what specifically was meant here, since the rest of calendar.html is intentionally NOT going through the JSON path. |

## Immediate next task

parts.html is done (see table above). Waiting on Anton to confirm the git
push before picking the next task, per the step-by-step workflow.

## Next task once Anton gives the go-ahead

1. **pricing.html**: port `loadLiveRates()`'s `action=rates` read. Small,
   low-risk (already degrades gracefully to `RATES_FALLBACK` when it fails).
   Only genuinely-unfinished item left in the whole app as of 2026-08-14's
   full re-audit.
2. Re-confirm with Anton what task #27 ("calendar.html delivery-link +
   auto-sync gap") was actually supposed to cover, since calendar.html's
   core reminder actions are intentionally NOT part of the JSON migration.
3. Re-confirm with Anton whether index.html's `createMonthSheetFromTemplate`
   should stay out of scope (current recommendation: yes, it's structural
   month-rotation, not a row-level write).
4. Final regression sweep across every ported page + wrap-up summary,
   including flagging the accounts.html expense-type-persistence design
   decision for Anton's explicit sign-off.

## Design decisions made without explicit sign-off (flag for review)

- **accounts.html expense-type persistence** (2026-08-14): a new
  notes-sidecar marker (column E of each expense row, `_notes` sidecar file)
  stores expense type (business/personal/wages/transfer/transferComplete),
  since real Google Sheets cell background colors have no JSON equivalent.
  'business' (the default) stores no note, so pre-existing rows read back
  correctly automatically. Needs Anton's confirmation this is an acceptable
  stand-in.

## Process notes / lessons learned

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
