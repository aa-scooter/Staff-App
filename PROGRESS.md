# AA Scooters — JSON-parity rewrite progress tracker

Last updated: 2026-08-14. Keep this file current — whenever a page's write
layer gets ported/tested/pushed, update its row below in the same commit.
This exists because work on this project gets picked up across multiple
Claude sessions/accounts with no shared memory between them — this file is
the handoff.

**Rule of thumb for "done":** ported + tested against real exported data
(via a `node --check`'d, vm-run test harness) + actually pushed to GitHub
(not just sitting in a cloud sandbox — that was the bikes.html near-miss on
2026-08-14, see below). Don't mark a row done until `git log` on the Mac
confirms it landed.

## Status by page

| Page | Reads (JSON) | Writes (JSON) | Notes |
|---|---|---|---|
| bikes.html | Done | Done | markReturned/updateReturnPickup, short-extension, swapBike, earlyReturnBike, returnDeposit, long-extension (30+ day) all ported+tested. **Was completed but sat unpushed in the cloud sandbox until 2026-08-14** (device was disconnected during that whole work stretch) — now pushed. |
| accounts.html | Done | Done | addExpense/editExpense/deleteExpense/addIncome/editIncome/deleteIncome/transferToBank, plus (2026-08-14) expense-type persistence + bulkSetExpenseType. New design decision made unilaterally: expense type is now stored as a notes-sidecar marker on column E (`EXPENSE_TYPE_NOTE_COL_B`) since real cell colors have no JSON equivalent — **not explicitly approved by Anton, flagged for review.** Also fixed a real pre-existing bug: row-insert (`findAccountsFreeRowIdxJson` splicing a blank row) wasn't shifting the notes sidecar, silently misattributing bike-split notes. |
| contract.html | Done | Done (Create/Edit/Cancel) | Drive-file actions (findContractDocument, uploadPassportPhoto, generateReceipt, generateChecklist, getFilesForShare, regenerateContract) still hit the old scriptUrl by design — these need a live Drive/PDF backend regardless of the JSON migration, not in scope for this effort. |
| customers.html | Done | Done (intake) | Customer-intake write cascade ported, shared with contract.html's doRent path. 2 remaining scriptUrl call sites not yet audited this pass — check what they are before assuming they're all AI/Drive-related. |
| deposits.html | Done | Partial | deductDeposit/deductCashDeposit ported+tested. **addDeposit/editDeposit/deleteDeposit still hit the old disconnected scriptUrl — not yet ported.** Found during the 2026-08-14 audit, not previously tracked as a numbered task. |
| add-bikes.html | Done | **Not started** | addBike/editBike/sellBike/unsellBike all still hit the old scriptUrl. This is the next task (was #26). |
| available-bikes.html | Done | n/a (read-only page) | |
| bike-income.html | Done | n/a (read-only page) | |
| bikephotos.html | Done | Out of scope | uploadPhoto/deletePhoto are Drive file operations — need a live backend regardless of JSON migration. |
| oilchange.html | Done | Done | |
| parts.html | ? | ? | `updateBike` action not yet audited — unclear if this is a portable spreadsheet write or something else. `readOdometerWithAI` is AI-assist, out of scope. |
| reply-assistant.html | Done | ? | `addContact` not yet audited (possibly portable). `generateReplyDraft`/`readWhatsAppContactWithAI` are AI-assist, out of scope. |
| bike-name-audit.html | Done | ? | 1 remaining scriptUrl call site not yet audited. |
| index.html | ? | Out of scope (probably) | `createMonthSheetFromTemplate` is a structural/template action, likely a deliberately separate concern from row-level JSON writes — confirm before touching. |
| pricing.html | Done | n/a (read-only page) | |
| login.html | n/a | n/a | No scriptUrl at all. |
| calendar.html | n/a | Isolated (by design) | Wired to a real but ISOLATED test Google account (`aascooters1@gmail.com`) via a standalone `TestCalendarScript.gs` deployment — NOT a JSON port, and shouldn't be; reminders/calendar events aren't spreadsheet data. Live `aascooterchiangmai@gmail.com` calendar untouched. There was a task (#27) to "assess and port the delivery-link + auto-sync gap" — re-clarify with Anton what specifically was meant here, since the rest of calendar.html is intentionally NOT going through the JSON path. |

## Immediate next task

**add-bikes.html**: port `addBike`/`editBike`/`sellBike`/`unsellBike` writes
to the Drive-JSON model, same pattern as every other page (write the
`*FromJson` functions, rewire the UI call sites off `fetch(scriptUrl...)`,
build a vm-run test harness seeded from real exported data, test, deliver,
push).

## After that

1. **deposits.html**: port `addDeposit`/`editDeposit`/`deleteDeposit` (newly
   found gap, not in the original numbered list).
2. Quick audit of the "?" rows above (customers.html's 2 sites,
   bike-name-audit.html's 1 site, parts.html's `updateBike`,
   reply-assistant.html's `addContact`, index.html's
   `createMonthSheetFromTemplate`) — confirm each is either genuinely out of
   scope (AI/Drive/structural) or a real remaining gap.
3. Re-confirm with Anton what task #27 ("calendar.html delivery-link +
   auto-sync gap") was actually supposed to cover, since calendar.html's
   core reminder actions are intentionally NOT part of the JSON migration.
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
