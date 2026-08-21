# AA Scooters — JSON-parity rewrite progress tracker

Last updated: 2026-08-21. Keep this file current — whenever a page's write
layer gets ported/tested/pushed, update its row below in the same commit.
This exists because work on this project gets picked up across multiple
Claude sessions/accounts with no shared memory between them — this file is
the handoff.

## ✅ contract.html + lib/contractWrites.js: Revolut added as a Deposit
## option; deposit-method-change ledger sync ported from Code.gs — CODED,
## UNIT-TESTED (5/5 scenarios against a mocked sheetIO), NOT YET DEPLOYED
## (2026-08-21)

Two related fixes from the same session, requested by Anton:

1. **Revolut was missing from the security-deposit dropdown.** "Paid by"
   and the receipt's payment method already had Revolut; the "Deposit"
   field (what the customer's security deposit was actually taken in)
   only offered Scan/Cash/Wise/Passport. Added `<option value="Revolut">`
   to both `#deposit` (intake) and `#e_deposit` (edit) in `contract.html`.
   Also fixed a related bug in the edit form's `depositOptions` allow-list
   (used to decide whether to preserve a contract's existing deposit value
   when the edit modal opens) — it didn't include Revolut either, which
   would have silently blanked the field for any contract that already had
   one. No backend change needed for this half — `lib/contractWrites.js`
   already fully supported `revolut` at both creation and edit time.

2. **Changing a contract's deposit method on edit never touched the
   ledger.** `editContractFromJson` only pushed a "not ported yet, adjust
   by hand" warning whenever `data.originalDeposit !== data.deposit` --
   this was flagged in a comment as a known gap from the Code.gs -> Vercel
   port. Anton's main use case: staff switch a Wise/Scan/Revolut deposit
   back to Cash once it's actually handed back, and the monthly
   Bank/Wise/Revolut ledger sheet needs to follow. Ported
   `removeSecurityDepositByNameAndAmount_` from Code.gs as
   `removeSecurityDepositByNameAndAmountFromJson` (same best-effort
   name+amount match within the current month's sheet only -- a Contract
   row has no stored link back to its own ledger row) and wired it into
   `editContractFromJson` alongside the existing `logSecurityDepositFromJson`,
   mirroring Code.gs's four-case logic (Passport/Cash <-> Passport/Cash
   no-op; Passport/Cash -> Scan/Wise/Revolut logs a new row; Scan/Wise/
   Revolut -> Passport/Cash clears the old row; Scan/Wise/Revolut -> a
   different one of those three does both). Each half wrapped in its own
   try/catch so a failed match (e.g. no matching ledger row found) only
   ever produces a warning, never blocks the contract save.

   Tested against a mocked `sheetIO` (in-memory, no real Drive calls) --
   5/5 scenarios pass: no-op, Wise->Cash (clears), Passport->Revolut
   (logs), Wise->Revolut (both), and Wise->Cash with no matching ledger
   row (warns without touching unrelated data). NOT run against the real
   spreadsheet/Drive data -- worth a live smoke test after deploy (create
   a Wise-deposit contract, edit it to Cash, check the current month's
   Deposits page).

## ✅ contract.html: View Contract/Receipt/Checklist back to Drive links;
## Send Contract + Receipt fixed to actually download both files; Contract
## PDFs shared "anyone with the link" — DEPLOYED 2026-08-20 (commits
## db3f633, 72d4fa4)

Same-day follow-up to the "receipt + checklist auto-generation" entry
below, three more round trips with Anton, all live:

1. **PDFs forced-download, then un-forced.** First pass made every PDF
   served through `/api/contracts/file/<id>` force-download
   (`Content-Disposition: attachment`) so mobile Chrome would hand off to
   a native PDF app instead of its own inline viewer. Anton then asked to
   go back to opening View Contract/View Receipt/View Checklist "in Google
   Drive like before, because I know it works." Net result:
   `api/contracts/[...path].js`'s `handleFile` route no longer force-
   downloads by default — that's now opt-in via `?download=1` — and
   `contract.html` gained a `driveViewUrl(fileId)` helper so View
   Contract/Receipt/Checklist open a real `drive.google.com/file/d/<id>/view`
   link instead of the private proxy. `currentEditRecord` now tracks a
   parallel `*PdfFileId` (contractPdfFileId/receiptPdfFileId/
   checklistPdfFileId) alongside each `*PdfUrl`, since the raw Drive file
   id is still needed for downloads even though the URL shown/opened is
   now a Drive link, not the proxy.

2. **"Send Contract + Receipt" was only ever downloading the contract.**
   Root cause: that button still called `action:'getFilesForShare'` on the
   decommissioned Code.gs `scriptUrl` (always failed now), falling through
   to a tabs-fallback that called `window.open()` twice in a row inside an
   async handler — mobile/desktop browsers only honor the FIRST
   `window.open()` after an `await` as a genuine user gesture, silently
   blocking the second (the receipt) every time. Replaced the whole Web
   Share/scriptUrl path with `downloadContractFile_(fileId, filename)` —
   a temporary `<a download>` click against `/api/contracts/file/<id>?download=1`
   — called twice back-to-back; an anchor download isn't a popup, so both
   go through reliably now. No more WhatsApp share-sheet hand-off; staff
   attach both files from Downloads instead.

3. **Contract PDFs now shared "anyone with the link, view only."** Anton
   hit Drive's "you need permission, request access" screen viewing a
   contract from a Chrome profile signed into a different Google account
   than the file owner (`aascooterchiangmai@gmail.com`) — a direct
   consequence of #1 above switching View Contract to a real Drive link.
   New `ensureFilePubliclyViewable(drive, fileId)` in `lib/googleDrive.js`
   (checks existing permissions first so repeat calls don't pile up
   duplicate "anyone" grants) is called two ways: automatically at the end
   of `generateContractDocumentFromJson` (`lib/contractDocGen.js`) for
   every contract generated/regenerated from now on, and via a new
   `POST /api/contracts/makeContractPublic {fileId}` route that
   `contract.html`'s `viewContract()` calls as a backstop for contracts
   that already existed before this fix — fires it fire-and-forget (not
   awaited) on the already-cached-URL fast path to avoid re-introducing
   the popup-block issue from #2, but does await it on the two paths that
   already have a preceding `await` (search-fallback match, and generate-
   then-open) since those are the actual legacy-file case this exists for.
   **Deliberately NOT applied to receipts/checklists/passport photos** —
   Anton confirmed those already open fine, and passport photos in
   particular must stay private. `/api` is still exactly at Vercel's
   12-function cap (unaffected — `makeContractPublic` rides inside the
   existing `api/contracts/[...path].js` catch-all, no new file).

**Verification:** `node --check` on all 4 touched files
(`contract.html`'s 2 extracted `<script>` blocks, `api/contracts/[...path].js`,
`lib/googleDrive.js`, `lib/contractDocGen.js`) — all pass. Re-confirmed
each write held on the on-device copy 15s after writing (per this file's
own "verify a write actually stuck" standing caution). **Anton should do
one live test of each:** View Contract from a non-owner Google login (should
no longer prompt, or self-heal on a second click for an old contract);
Send Contract + Receipt (should download 2 files, not 1).

## ✅ bikes.html: page now auto-refreshes after Extend/Return/Swap/Adjust
## Pickup instead of needing a manual reload — DEPLOYED 2026-08-20

Anton reported: extended a bike, the save went through fine, but the page
kept showing the old (pre-extend) data until he manually refreshed the
browser.

**Root cause:** `bikesJsonCache` (declared near `fetchSheetJson`) caches
each sheet's fetch as a resolved PROMISE for the lifetime of one page
load — `fetchSheetJson('customer')` etc. only ever hits the network once,
then hands back the same cached result forever after. Every write action
here (Return/Extend/Swap/Adjust Pickup/discard-failed-retry) already
called `clearBikesCache(); loadData();` on success, but `clearBikesCache()`
only ever cleared the localStorage stale-while-revalidate snapshot
(`BIKES_CACHE_KEY`) — it never touched `bikesJsonCache`. So the follow-up
`loadData()` → `getCustomerRowsFromJson()`/`getPartsDataFromJson()` →
`fetchSheetJson(...)` kept finding e.g. `bikesJsonCache['customer']`
already populated from the very first page load and returned that stale
cached promise instead of re-fetching — exactly why nothing changed on
screen until a full manual reload (which resets `bikesJsonCache` to `{}`
along with everything else). Same class of bug `writeSheetJson()` already
guards against for its own direct callers (one
`delete bikesJsonCache[cacheKey]` per sheet just written, found earlier
during `markReturned`'s own write-then-readback testing) — just never
extended to the `bkEnqueue`/server-API write path, which is what
Return/Extend/Swap/Adjust Pickup actually use.

**Fix — `bikes.html`, `clearBikesCache()` (near `BIKES_CACHE_KEY`):** now
also wipes every entry out of `bikesJsonCache`, not just the localStorage
snapshot. Fixes all 6 existing `clearBikesCache(); loadData();` call sites
at once (Return, Adjust Pickup, long Extend, short Extend, Swap,
discard-failed-retry) with one centralized change rather than touching
each call site.

**Verification:** `node --check` on the file's 3 extracted `<script>`
blocks (all pass), re-confirmed against the freshly re-staged on-device
copy. **Anton should do one live test:** extend a bike and confirm the new
due date/amount shows up on the page immediately, with no manual refresh
needed.

## ✅ contract.html: receipt + checklist auto-generation, "View Receipt"/
## "View Checklist" now find existing documents after reload — DEPLOYED
## 2026-08-20

Anton reported two bugs: (1) creating a contract no longer auto-generates a
receipt or checklist the way the old system did; (2) "View Receipt" never
finds a previously-generated receipt after logging out/reloading — it
always offers to generate a new one.

**Root cause (both bugs, same event):** Anton decommissioned the legacy
Google Sheets spreadsheet that Code.gs (the old Apps Script backend) was
bound to. `contract.html` still had 3 live `fetch(scriptUrl, ...)` calls
left over from that system (`generateReceipt`, `findChecklistDocument`,
`generateChecklist`) — with the spreadsheet gone, all 3 now fail silently.
On top of that, bug #2 was ALSO present in the old system itself: Code.gs
named receipt PDFs `"Receipt - <name> - <today's date at generation
time>"`, which can never be reconstructed later, so a `findReceiptDocument`
action never existed even under Code.gs — "View Receipt" only ever worked
within the same browser session that generated it.

**Fix — `lib/contractDocGen.js` (extended, +389 lines):** ported Code.gs's
`generateReceiptDocument`/`generateChecklistDocument` (and their template
lookup/fallback-template-build/receipt-numbering logic) into
`generateReceiptDocumentFromJson`/`generateChecklistDocumentFromJson`,
following the same Drive/Docs API pattern already proven for the contract
PDF itself (copy template -> `batchUpdate` `replaceAllText` -> export PDF ->
trash the intermediate Doc copy). Receipt numbers now come from a new JSON
sidecar counter (`receipt_counter.json`, same optimistic-concurrency
retry-on-`ConflictError` pattern as `logTransactionB`), starting at 100000
since Code.gs's own counter (Script Properties) was lost with the
decommissioned spreadsheet — **correctable by hand if Anton has the real
last-issued number**.

**Deliberate deviation from Code.gs:** receipt PDF file names are now keyed
off `rentingDateFrom` (same immutable field the contract/checklist file
names already use) instead of "today's date at generation time" — this is
what makes "View Receipt" able to find a receipt again after a reload. The
`<<RECEIPT_DATE>>` token inside the document itself still shows the actual
generation/edit date.

**Template gap found:** neither
`'AA Scooter Rental Payment Receipt - MASTER TEMPLATE (do not edit
fields)'` nor `'AA Scooter Rental Checklist - MASTER TEMPLATE (do not edit
fields)'` actually exists in the "AA Scooters Contracts" Drive folder today
— Code.gs's own lookup always fell through to its bare-bones fallback
template too. Nicer, manually-designed versions of both exist elsewhere in
Anton's Drive but were never wired up at the expected name/location. Ported
Code.gs's own plain-text fallback-template-build behavior faithfully rather
than risk editing Anton's uploaded designs without asking. **Anton: if you
want your own designs used instead, either rename/move them to the exact
names above inside the "AA Scooters Contracts" folder (zero code changes
needed), or ask for the tokens to be added to a copy.**

**Routing — `api/contracts/[...path].js` (+42 lines):** two new routes,
`POST /api/contracts/generateReceipt` / `POST /api/contracts/generateChecklist`,
same catch-all-function pattern as every other route here (Hobby-plan
12-function cap).

**Frontend — `contract.html`:**
- Add-contract's `onAllSuccess` now calls both new generate routes as
  best-effort follow-ups (same placement/pattern as the existing
  passport-photo-upload follow-up) — never blocks the "Added" success
  message, only folds success/failure into it.
- New shared helper `findExistingContractFile(expectedName)` — same
  "search Drive via `GET /api/contracts/documents`, match by exact expected
  filename" pattern `viewContract()` already used, now reused by View
  Receipt, Edit Receipt, and View Checklist.
- `editViewReceiptBtn`/`editReceiptBtn`/`viewChecklist()` all now search
  first via `findExistingContractFile` before offering to generate.
- `receiptConfirmBtn` and `viewChecklist()`'s generate step re-pointed from
  the dead `scriptUrl` calls to the two new API routes.

**Verification:** `node --check` on all 3 files plus each of
`contract.html`'s 3 extracted `<script>` blocks (all pass). Payload shapes
double-checked by hand against the new functions' expected `data` fields —
no live-Drive test harness was built (would have meant hand-mocking most of
`lib/googleDrive.js`'s Drive/Docs API surface without much more confidence
than careful reading gives); **Anton should do one live test** — add a
throwaway test contract, confirm both a receipt and checklist appear, then
log out/in and confirm "View Receipt" finds the same receipt instead of
offering to generate a new one.

**Left alone (out of scope, flagged for awareness):** `editSendDocsBtn`'s
"Send Contract + Receipt" (Web Share) button still POSTs
`action:'getFilesForShare'` to the same dead `scriptUrl` — very likely
broken by the same spreadsheet decommissioning, not reported broken by
Anton yet, not touched here.

## ✅ customers.html: full port (backend + frontend) — LAST PAGE IN THE
## ROLLOUT — CODED, UNIT-TESTED (27/27 backend + 22/22 engine), NOT YET
## DEPLOYED (2026-08-17, overnight session)

This closes out the page-by-page save-pipeline rollout: bikes.html ->
contract.html -> deposits.html -> add-bikes.html -> **customers.html**.

**Backend — `lib/customersWrites.js` (new):** ports customers.html's one
write action, `customerIntake` (`customerIntakeFromJson`), an 8-sub-write
cascade against `customer`, `customer_notes`, the current month's income
sheet, `cash`, `bikes`, and `Contract`. Every sub-write past the row insert
itself is independently try/catch'd into a `warning` string rather than
failing the whole request — verbatim port of that structure, not new.

**Routing:** no new `api/customers/write.js` — same Hobby-plan
12-function-cap constraint as every other page this rollout. Routed
through the EXISTING `api/accounts/write.js` (already hosts deposits.html's
actions alongside accounts.html's own) via a new `CUSTOMERS_ACTIONS` Set
(`customerIntake`).

**Idempotency — the one genuinely new thing this port adds:**
customers.html had **NO clientTxnId guard at all** before this port
(unlike bikes.html's/contract.html's own customerIntake variants
elsewhere in this project, which already had one) — a real, live gap,
identified during this session's inventory pass. Added a clientTxnId guard
on the customer-row insert ONLY, not the full 8-sub-write cascade (marker
on a `customer_notes` sidecar, column `CUSTOMER_INTAKE_IDEMPOTENCY_COL_B
=90`, same `[row, col, clientTxnId]` shape as every other guard in this
project). This is a **deliberate, documented scope limit**: re-running the
whole cascade on retry would double-log income/cash/ledger entries, which
is worse than the duplicate-row bug the guard exists to prevent. See
`lib/customersWrites.js`'s own header comment for the full reasoning —
matches `addBikeFromJson`'s own precedent in `lib/addBikesWrites.js` (that
guard likewise only covers its own critical row-creating write, not its
warnings-wrapped fan-out).

The Extend flow's `paidFromDeposit` (drawing down an existing deposit-log
row) remains NOT ported — was already explicitly deferred in
customers.html's own comments before this port, carried forward unchanged.

**Frontend — `customers.html`:** new `cu`-prefixed save-pipeline engine
(same shape as `bk`/`ct`/`dp`/`ab`), POSTing to `/api/accounts/write`.
Only one write action and no persistent per-row list view to badge (every
customerIntake is a brand-new row, unlike bikes.html's/add-bikes.html's
row-keyed engines) — `rows` is always `[]`; `pendingRowSaves`/
`.opt-row-pending` are kept only for structural parity with every other
page's engine (nav.js's `PENDING_SAVE_SOURCES` table and the review
overlay both expect the same shape). The Add form's submit handler is now
optimistic: resets immediately and shows Saving…/Queued… in `statusBox`,
matching every other page's own addX handler in this rollout. The old
blanket `setAllButtonsDisabled(true)` lock is no longer called (the
engine's own `MAX_QUEUE` cap + `cuQueueFull()` guard covers the
double-submit risk instead) — left in place as dead code, not deleted, per
project convention. `restoreUnresolvedSaves()` called once, at the very
end of the script (same TDZ caution as every other page this rollout,
since it transitively touches `sheetRows`/`searchView`, declared much
further down the file).

**nav.js:** added a `customers.html` entry to the shared
`PENDING_SAVE_SOURCES` table (`pendingKey: aaCustomersPendingSaves`,
`failedKey: aaCustomersFailedSaves`, `endpoint: /api/accounts/write`).

**Testing:**
- Backend: hand-rolled in-memory fake `sheetIO` against
  `createCustomersWrites` (brace-extracted the same way as
  `addbikestest`, to dodge `googleapis`'s module-load-time require in the
  test sandbox) — covers basic successful intake (customer row + ledger
  note + income row + Contract row flipped Pending->Rented + total
  synced), clientTxnId idempotent replay (retry does NOT insert a second
  row or re-run the cascade), two different real customers both insert
  normally, Wise payment (running total bump + security deposit log
  entry), a missing monthly-income tab surfacing as a warning without
  failing the whole intake, the "never shrink Contract total" failsafe,
  missing-name throwing before any writes, and dispatch routing.
  **27/27 passing.**
- Frontend engine: same vm-sandbox pattern as `abenginetest` — covers
  immediate-run vs queued-behind-MAX_QUEUE, dispatch posts to the correct
  endpoint (`/api/accounts/write`), 409-conflict retry with backoff
  eventually succeeding, non-conflict failure going straight to
  `cuFailedItems`/`aaCustomersFailedSaves` with no retry, and
  `restoreUnresolvedSaves` correctly resubmitting an orphaned pending item
  AND restoring (without resubmitting) a previously-failed one. **22/22
  passing.**

**Files changed:** `lib/customersWrites.js` (new), `api/accounts/write.js`
(routing), `customers.html` (CSS/HTML/engine block + submit handler
rewire + restoreUnresolvedSaves call), `nav.js` (`PENDING_SAVE_SOURCES`
entry). All syntax-checked clean (`node --check`); all verified to hold on
disk (grep + 15s recheck).

**Still NOT deployed** — bundled with everything else from this overnight
session into one consolidated push, ready in the morning. This is the
LAST page in the rollout — once this is pushed and Anton has smoke-tested
it, the page-by-page save-pipeline migration (bikes.html -> contract.html
-> deposits.html -> add-bikes.html -> customers.html) is complete.

## ✅ add-bikes.html: frontend wired onto the ab-prefixed save-pipeline
## engine — CODED, UNIT-TESTED (24/24), NOT YET DEPLOYED (2026-08-17,
## overnight session)

**What changed:** all 4 of add-bikes.html's write-action call sites
(Add-bike form submit, Edit-bike modal Save, Sell confirm, Unsell confirm)
now route through the `ab`-prefixed save-pipeline engine (`abEnqueue` /
`abRun` / `abDispatchWithRetry`) instead of calling the old client-side
`addBikeFromJson`/`editBikeFromJson`/`sellBikeFromJson`/`unsellBikeFromJson`
functions directly. Those old functions are left in place as dead code
(not deleted, per project convention) — the new call sites hit
`/api/bikes/write` via the engine instead, which is what actually reaches
`lib/addBikesWrites.js` (see the backend-port entry below).

- **Add bike**: optimistic — form resets and shows Saving…/Queued… in
  `statusBox` immediately, matching contract.html's addContract/
  deposits.html's addDeposit pattern. `rows: []` since there's no existing
  bike row to badge.
- **Edit bike**: modal closes immediately, `rows: [originalBike]` badges
  that row Saving…/Queued… in the fleet list underneath.
- **Sell / Unsell**: `rows: [bikeName]` badges just that row. The old
  blanket `setFleetBusyUI(true)` lock (disabled the ENTIRE fleet list +
  the Add form for the whole request) is removed — the engine already caps
  true concurrency to 1 running request at a time (MAX_QUEUE=2 = 1 running
  + 1 queued) and retries 409 conflicts with backoff, which is exactly the
  "two writes fighting over the same rows" scenario the old lock existed to
  prevent. `setFleetBusyUI`/`fleetActionInFlight` are left in place as dead
  code (now permanently false) rather than deleted, per project convention.

**Row badges:** `fleetItemHtml` now checks `pendingRowSaves.get(bike.name)`
and renders an `.opt-row-badge` (Saving…/Queued…, spinner) next to that
bike's name, with its Sell/Unsell/Edit buttons disabled while its own save
is pending — unrelated rows and the Add form stay fully interactive. CSS
adapted from deposits.html's own "opt-" prefixed block (`.row` →
`.fleet-item`).

**Crash/nav recovery:** `restoreUnresolvedSaves()` is called once, at the
very end of the script (not right after the engine block) — same TDZ
caution as contract.html hit earlier this project, since it transitively
touches `fleetListLoaded`/`loadFleetList`, declared much further down the
file.

**nav.js:** added an `add-bikes.html` entry to the shared
`PENDING_SAVE_SOURCES` table (`pendingKey: aaAddBikesPendingSaves`,
`failedKey: aaAddBikesFailedSaves`, `endpoint: /api/bikes/write`) — closes
the loop on cross-page orphan-save recovery/the header "Saving…" strip for
this page too, one-line addition since that table is generic.

**Testing:** new Node vm-sandbox test harness
(`abenginetest/engine.js` + `run.js`, brace-extracted from add-bikes.html's
own inline `<script>`) drives `abEnqueue`/`abRun`/`abDispatchWithRetry`/
`restoreUnresolvedSaves` directly against a fake `fetch`/`localStorage` —
covers: immediate-run vs queued-behind-MAX_QUEUE, 409-conflict retry with
backoff eventually succeeding, non-conflict failure going straight to
`abFailedItems`/`aaAddBikesFailedSaves` with no retry, and
`restoreUnresolvedSaves` correctly resubmitting an orphaned pending item
AND restoring (without resubmitting) a previously-failed one. **24/24
passing.** (First pass had 3 spurious failures from the test's own fetch
mock missing `.ok: true` on 200 responses — abDispatch's
`if (!r.ok || ...) throw` was treating every mocked success as an HTTP
failure; fixed in the harness, not the engine.)

**Files changed:** `add-bikes.html` (CSS/HTML/engine block + 4 call sites
+ row badges + restoreUnresolvedSaves call), `nav.js`
(`PENDING_SAVE_SOURCES` entry). Both `node --check` clean; both verified to
hold on disk (grep + 15s recheck).

**Still NOT deployed** — bundled with the backend-port entry below and
customers.html's port into one consolidated push, ready in the morning.

## ✅ add-bikes.html: server-side write layer ported (4 actions) — CODED,
## UNIT-TESTED (40/40), NOT YET DEPLOYED (2026-08-17, overnight session)

**What changed:** add-bikes.html's 4 write actions (addBike, editBike,
sellBike, unsellBike) ported from their existing client-side JSON-backed
copies (already read/write straight against `/api/data/<sheet>`, just not
server-side atomic) into a new `lib/addBikesWrites.js`, following the same
`createSheetIO`/`create<Page>Writes` factory shape as
`lib/bikesWrites.js`/`lib/depositsWrites.js`.

**Routing:** no new `api/add-bikes/write.js` — `api/` is already at
Vercel's Hobby-plan 12-serverless-function cap. Routed through the
EXISTING `api/bikes/write.js` instead, via a new `ADD_BIKES_ACTIONS` Set
check (`addBike`/`editBike`/`sellBike`/`unsellBike`) alongside the
existing `bikesWriteDispatch` path — mirrors exactly how deposits.html's
actions got routed through `api/accounts/write.js` earlier this session.
The two dispatch paths (bikes.html's own actions vs add-bikes.html's) never
mix; bikes.html's own frontend is untouched.

**Idempotency, added as part of this port (none of these existed
client-side before):**
- `addBike`: clientTxnId guard on a new `Parts_and_Oil_change_notes`
  sidecar ([row, col, clientTxnId] shape, same convention as every other
  guard in this project). Without it, a crash/reload resubmit would hit
  `addBikeFromJson`'s own duplicate-name guard and throw a confusing
  "already exists" error even though the original add already succeeded —
  same "retry trap" bug class fixed for contract.html's cancelContract
  earlier this session, closed proactively here instead.
- `editBike`: no guard, by design — unconditional overwrite converges to
  the same end state on retry.
- `sellBike` / `unsellBike`: clientTxnId idempotent-replay guards, piggy-
  backed onto the SAME per-bike-name JSON note
  `readBikeSoldNoteFromJson`/`writeBikeSoldNoteFromJson` already
  read/write (new `soldByTxnId` field on sell; `unsellBike` now leaves a
  tombstone note behind — `unsoldByTxnId` + `reversedAmount`, no
  `soldAmount`/`reason` — instead of clearing to null outright, so a
  retry can be recognized without breaking every other reader's
  `soldAmount || reason` "is this sold" check).

**Testing:** `node --check` on `lib/addBikesWrites.js` and
`api/bikes/write.js` (both OK). 40/40 unit tests against a fake in-memory
Drive-backed sheetIO, covering: alphabetical insert across all 4 sheets on
addBike, the Bike Tax column-A renumber, the "no live formula engine"
warning on Bike Tax's Status/day-count columns, duplicate-name guards
(exact and fuzzy-matched), clientTxnId idempotent replay on
addBike/sellBike/unsellBike (confirmed NOT double-charging/double-
reversing the "total" column on replay), editBike's rename-collision
guard and partial-sheet-failure-as-warning behavior, sellBike's write-off
(reason) path leaving the total untouched, and unsellBike's "nothing to
reverse" guard.

**Files changed:** `vercel-site/lib/addBikesWrites.js` (new),
`vercel-site/api/bikes/write.js`.

**Not done in this entry:** the frontend (add-bikes.html itself) is not
yet wired onto a save-pipeline engine — that's the next entry, once
written.

---

## ↩️ contract.html: "Send Contract + Receipt" reverted back to Web Share —
## CODED, NOT YET DEPLOYED (2026-08-17)

**What happened:** the download+WhatsApp-Web rework of "Send Contract +
Receipt" (see this file's "Fixed 3 contract.html bugs" entry above) was
tested live and wasn't working reliably either -- passport photo still
404'd (separate, still-open issue -- see below) and the new flow itself
wasn't landing cleanly. Anton asked to revert this one piece back to how
it was before ("it was sort of working... just switch it back to the old
way... we'll deal with it later, it's not important") and deal with the
passport-photo problem separately.

**What changed, `contract.html` only:** `editSendDocsBtn`'s click handler
reverted to the Web Share flow -- POSTs `action:'getFilesForShare'` to the
(now-reconnected) `scriptUrl` with both PDF URLs, Code.gs reads each
file's real bytes off Drive server-side and returns them as base64
(`lib/googleDrive.js`/Code.gs's own `getFilesForShareEntry` was never
touched by the earlier rework -- still fully intact), the browser converts
each to a `File` via `base64ToFile_` and hands them to
`navigator.share`/`canShare({files})` so staff can pick WhatsApp from the
phone's native share sheet and send both as real attachments. Falls back
to `openDocsFallback_` (open both PDFs as plain tabs) if Web Share isn't
available/willing to share files on this device (most desktop browsers),
or if a real share attempt fails for a reason other than the user simply
cancelling it (AbortError -- not treated as an error). The
`triggerDriveDownload_`/`extractDriveFileId_`/download-then-open-WhatsApp-
Web code from the earlier rework is removed entirely, not left dead in
the file.

**Why this should behave better than it did before EITHER rework:** the
original flakiness this button had is believed to trace back to
`scriptUrl` being blank (see this file's own `scriptUrl` comment and the
"Fixed 3 contract.html bugs" entry's root-cause writeup) -- with a real
`scriptUrl` now wired up, `getFilesForShare` should actually succeed
server-side, which it never got the chance to before. Not independently
re-verified live as of this entry (Anton wants to move on to the passport-
photo problem first) -- worth a real test on both a phone and desktop
after this deploys.

**Note, exact original code:** this revert is a faithful reconstruction of
the described original behavior (Web Share primary path via
`getFilesForShare` + `File` objects, tab-opening fallback), built by
reading Code.gs's still-intact `getFilesForShareEntry` for the real
request/response contract, NOT a byte-for-byte restore of the literal
original source (git history wasn't consulted for this -- see this
project's CLAUDE.md rule against running `git` through Claude's own tools).
Functionally equivalent to the original per this file's own prior HTML
comment describing it, with a couple of small added touches (button
disabled + "Preparing…"/spinner while fetching, explicit AbortError
handling for a cancelled share) that weren't called out as removed in the
earlier rework's own PROGRESS.md entry, so shouldn't represent a real
behavior change from before.

**Testing:** `node --check` on both inline `<script>` blocks (both OK).
Grep confirmed no dangling references to the removed
`triggerDriveDownload_`/`extractDriveFileId_` functions. Not covered by a
fresh unit-test harness this pass (no test infrastructure existed for the
original Web Share version either) -- flagged above for a real live check
after deploy instead.

**Files changed:** `vercel-site/contract.html` only.

**Still open, separate issue (not touched this pass):** "View Photo of
Passport" still 404s for at least one contract even after the Drive
folder-location fix above -- Anton flagged this live right after this
revert. To investigate next.

---

## ✅ deposits.html: ported to the save-pipeline engine (5 actions) —
## CODED, UNIT-TESTED (27/27), NOT YET DEPLOYED (2026-08-17)

**What changed:** deposits.html's write layer replaced with the same
optimistic-UI "save-pipeline engine" pattern already shipped on bikes.html
(`bk`-prefixed) and contract.html (`ct`-prefixed) this project — here as
`dp`-prefixed. All 5 deposits actions (`addDeposit`, `editDeposit`,
`deleteDeposit`, `deductDeposit`, `deductCashDeposit`) now route through
`dpEnqueue` → POST to `/api/accounts/write` (the existing endpoint —
deposits actions are dispatched there via `lib/depositsWrites.js`'s
`depositsWriteDispatch`, NOT a new dedicated endpoint, to stay under
Vercel Hobby's 12-serverless-function cap) instead of the old client-side
read-modify-write-the-whole-sheet flow.

**Row identity, deposits-specific:** unlike bikes.html/contract.html
(single sheet-row number as the map key), a deposit entry is only unique
by (category, row) together, so `pendingRowSaves` here is keyed by a
composite `"category:row"` string (e.g. `"bank:5"`). Actions with no
existing row to badge (`addDeposit`, `deductCashDeposit`) pass `rows: []`,
same pattern as contract.html's `addContract`.

**Two bugs pre-empted, both citing precedent from earlier this session:**
- Stale in-memory cache after write (the exact bug that hit contract.html
  earlier this session, where only the localStorage cache was cleared on
  reload-after-write and writes looked like they silently did nothing):
  `dpReloadAndRerender()` clears BOTH `clearDepositsCache()` (localStorage)
  AND empties the in-memory `depositsJsonCache` object.
- TDZ crash (the exact bug that hit contract.html's `searchView` earlier
  this session — a `const` referenced before its declaration executes):
  `restoreUnresolvedSaves()` is defined inside the engine block (early in
  the file) but its *call* is deferred to the very end of the script,
  right before the final `loadDeposits()` — it transitively touches
  `allDeposits`/`lastSummary`/`depositsLoadedOnce`, which aren't declared
  until much further down the file.

**Also added:** missing mousedown+click "click-outside-to-close" guard on
`modalBackdrop` (per this project's CLAUDE.md modal convention — wasn't
applied to this page's modal before); per-row "Saving…/Queued…" badges in
`render()` when a save is in flight for that row (skipped on click while
pending); `MAX_QUEUE = 2` cap with an inline error if hit; dead progress-
indicator functions removed (`setModalButtonsDisabled`,
`start/stopModalProgress`, `start/stopCashDeductProgress` and their
backing consts/timer).

**Testing:** `node --check` on the single inline `<script>` block (OK,
55277 chars) and on `nav.js` (OK). Grep confirmed no dangling references
to any of the removed old write functions
(`addDepositEntryJson`/`editDepositEntryJson`/`deleteDepositEntryJson`/
`deductDepositEntryFromJson`/`deductCashDepositFromJson`/
`fetchSheetWithMeta`/`writeSheetJson(`). 27/27 unit tests against the real
sliced engine + render source, covering: unique client-txn-id generation;
basic enqueue/run/resolve with `rows:[]`; `"category:row"` keying for
edit/delete/deduct; the `MAX_QUEUE=2` cap; 409-conflict retry-then-succeed;
a real failure landing in `dpFailedItems` + banner (not silently dropped)
with the row released either way; `dpReloadAndRerender` clearing both
caches; `restoreUnresolvedSaves` recovering a leftover pending save with
the same `clientTxnId`; and a dedicated TDZ-safety test confirming
`restoreUnresolvedSaves()` doesn't throw or touch `render` when called
before `allDeposits`/`lastSummary` exist.

**Verification:** both `deposits.html` and `nav.js` writes confirmed held
(grepped for distinctive new content immediately after writing and again
15s later — unchanged both times), per this project's file-revert
caution.

**Files changed:** `vercel-site/deposits.html`, `vercel-site/nav.js`.
(`vercel-site/lib/depositsWrites.js` and the `api/accounts/write.js`
routing change were built/wired earlier this same session, prior to this
PROGRESS.md entry.)

**Not done in this delivery (deliberately deferred, same "small chunks"
convention as the rest of this project):** add-bikes.html (4 actions) and
customers.html (1 action) are next in the page-by-page rollout, each to be
its own separate tested/documented delivery.

---

## 🐛 Fixed contracts Google Drive folder-location mismatch — "View Photo
## of Passport" 404ing (and likely other document links) — CODED,
## UNIT-TESTED (13/13), NOT YET DEPLOYED (2026-08-17)

**Bug report (Anton, live):** Clicking "View Photo of Passport" on a real
contract 404'd (`/api/contracts/file/<id>` → 404), even though the photo
file demonstrably exists in the customer's Google Drive folder. Not
isolated to one contract — "a lot of the other ones" too.

**Root cause:** two separate, same-named Drive folder trees existed.
Code.gs (`getOrCreateContractsFolder()`) has always used
`DriveApp.getFoldersByName('AA Scooters Contracts')` — unscoped by parent,
Drive-wide — which resolves to the real, actively-used, TOP-LEVEL
"My Drive > AA Scooters Contracts" folder; every receipt regenerate and
every new contract's passport-photo upload still writes there today via
the reconnected `scriptUrl`. The Vercel backend's own
`ensureContractsRootFolder(drive, appFolderId)`, by contrast, searched only
NESTED inside the app's own "AA Scooters App Data" root folder — a
structurally different folder that only ever got populated by a one-time
manual copy Anton did on 2026-08-15 (hand-copying the legacy folder tree
into the app's Drive folder via the Drive web UI). Any contract touched by
Code.gs after that copy (a regenerated receipt, a newly uploaded passport
photo) landed only in the real top-level folder, so the nested copy went
stale immediately — the app was looking in the wrong place. This differs
from Bike Photos, where an equivalent one-time-copy fix already stuck,
because nothing writes to the legacy bike-photos location anymore.

Considered and rejected: copying the top-level folder's contents into the
nested app folder (like Bike Photos). Rejected because Code.gs is still
actively writing new content to the top-level folder — a copy-once fix
would go stale again the moment anyone touched a contract. Anton approved
repointing the code at the real folder instead, confirming it's fine to
leave the old, now-unused nested copy sitting there rather than clean it
up: "Having three folders there is not a problem."

**Fix, `lib/googleDrive.js` only:**
- Added `findNamedFolderAnywhere(drive, name)` — same as the existing
  `findNamedFolder`, but with no parent-scoping in its query, matching
  Code.gs's own unscoped `DriveApp.getFoldersByName` behavior exactly.
- Rewrote `ensureContractsRootFolder(drive, appFolderId)` to call
  `findNamedFolderAnywhere` instead of the old nested
  `ensureNamedFolder(drive, appFolderId, CONTRACTS_FOLDER_NAME)`. If truly
  nothing is found anywhere (shouldn't happen in practice — Code.gs would
  already have created it), falls back to creating a folder at the TOP
  level of Drive (no `parents` in the create call), not nested under
  `appFolderId`, so a from-scratch run stays pointed at the same place
  Code.gs uses. `appFolderId` param kept in the signature, now unused, for
  call-site compatibility with `api/contracts/[...path].js`'s three
  callers (handleDocuments, handleConfirmMatch, handleUpload) — none of
  which needed changes themselves.

**Testing:** `node --check` on `lib/googleDrive.js` (OK). 13/13 unit tests
against a fake Drive client (`drive.files.list`/`drive.files.create`
mocked) covering: `findNamedFolderAnywhere`'s query has no `in parents`
clause and correctly filters by name/non-trashed; returns null on no
match; takes the first result on multiple matches (mirrors Code.gs's
`.next()`); `ensureContractsRootFolder` returns an existing folder's id
without creating a duplicate; creates a new folder with no `parents` field
when nothing is found anywhere; behavior is unaffected by whatever
`appFolderId` value is passed in.

**Verification:** write confirmed held (grepped for the new function call
site both immediately after writing and again 15s later — unchanged both
times), per this project's file-revert caution.

**Files changed:** `vercel-site/lib/googleDrive.js` only.

**Open question:** the theory that this is specifically tied to contracts
"imported by the old app" (Anton's hypothesis) isn't confirmed either way
— the fix corrects the folder-lookup mismatch regardless of how any given
contract's folder came to exist, so it should resolve the 404s across the
board, not just for imported records. Worth spot-checking a few different
contracts (old-app-imported and newly created) after deploy to confirm.

---

## 🐛 Fixed 3 contract.html bugs: receipt regenerate failing, broken
## Documents-panel links, "Send Contract + Receipt" not reaching WhatsApp —
## CODED, UNIT-TESTED (19/19), NOT YET DEPLOYED (2026-08-17)

**Bug reports (Anton, live on staff-app-six-phi.vercel.app), 3 in one
session:**
1. Edit Receipt → Confirm & Regenerate failed with "Could not generate the
   receipt: Failed to execute 'json' on 'Response': Unexpected end of JSON
   input" (Ivan Zhirnov's contract, but not specific to that record).
2. The Edit modal's "Documents (passport, contract, etc.)" panel listed
   Receipt/Contract PDFs that 404'd when clicked (Murtadha Ramzi's
   contract). Anton didn't want that panel at all, given View Contract/
   View Receipt/View Photo of Passport already cover it.
3. "Send Contract + Receipt" wasn't reliably opening WhatsApp — just
   opened blank/unrelated tabs on desktop; "works sometimes" on phone.

**Root cause, #1 and #3 (same cause):** `const scriptUrl = ''` in
contract.html — deliberately blanked during the 13-15/08/2026 JSON-backed-
data migration, but several actions were explicitly left un-migrated
(`generateReceipt`, `getFilesForShare`, `findChecklistDocument`,
`uploadPassportPhoto`, `readPassportWithAI`, `addCalendarReminder`, etc. —
see the migration comment block right after where `scriptUrl` is declared)
and still call `fetch(scriptUrl, ...)` expecting a real Apps Script
backend. With `scriptUrl` blank, `fetch('')` resolves to POSTing back to
contract.html itself, which returns an empty non-JSON body — hence
"Unexpected end of JSON input", deterministically, every time, for every
contract. `editSendDocsBtn`'s old Web Share flow depended on the exact
same dead fetch (`action:'getFilesForShare'`), so it always landed in its
catch block and fell through to `openDocsFallback_()` (opening both PDFs
as tabs) — which is exactly what bug #3 looked like. This blank-scriptUrl
pattern is repo-wide (every page in vercel-site/ has it, all with the
identical "DISCONNECTED... dev/testing only" comment) — only contract.html
was touched this pass, since that's the page with the live bug reports.

**Root cause, #2:** the Documents panel listed EVERYTHING in the
customer's whole Drive contract folder (originally meant for passport
photos + misc extras), and since Contract/Receipt PDFs get saved into that
same folder by `generateReceiptDocument`/`regenerateContractDocumentEntry`,
they always showed up too — duplicating the View Contract/View Receipt
buttons. The 404s: best-supported theory is `generateReceiptDocument`
actively trashes the OLD receipt PDF every time a receipt is regenerated
(see its own comment in Code.gs) — a panel loaded before that happened
would still show the now-trashed file's id. Not fully confirmed with a
clean repro (Anton chose to just remove the panel rather than chase it
further, since it was redundant with existing buttons anyway).

**Fixes, all in `contract.html` only:**
- `scriptUrl` reconnected to the same live Apps Script deployment URL
  every Hostgator-copy page already uses
  (`AKfycbztdtViH9qFCZ755EefaZqiZWzKK_yTOWkwaFLqZJm271wzDIVMgGoaYGFaSrd20OGsnQ`)
  — fixes #1 directly, and un-breaks the underlying fetch behind #3.
- Documents panel (`editDocsPanel`, its list/status/picker, and the
  `renderContractDocsList`/`renderContractDocsCandidates`/
  `loadContractDocuments` functions) removed entirely. "View Photo of
  Passport" no longer scrolls to/reloads that panel — it now calls
  `/api/contracts/documents` on click only, filters to image files (PDFs
  drop out on their own by mimeType), and opens the first match directly
  via `/api/contracts/file/<id>`. "First match" = most recent with no
  extra sorting needed, since `listAllFilesInFolder` (lib/googleDrive.js)
  already queries Drive with `orderBy: 'createdTime desc'`. If no photo is
  found, shows an inline "No passport photo on file yet" message instead
  of a blank list. The passport-photo upload button no longer calls
  `loadContractDocuments()` on success (nothing to refresh anymore) — its
  own "Photo uploaded."/"already on file" status message is unchanged.
- `editSendDocsBtn` rebuilt: downloads both PDFs via a throwaway `<a
  download>` click each (`triggerDriveDownload_`, using
  `drive.google.com/uc?export=download&id=<id>` so it's a real download,
  not a Drive preview tab — both PDFs are already shared "Anyone with
  link" via Code.gs's `setSharing` calls), then opens
  `web.whatsapp.com/send?phone=<digits>&text=<message>` in one
  `window.open`. Same flow on every device now, instead of depending on
  `navigator.share`/`canShare({files})`, which desktop Chrome generally
  doesn't support for WhatsApp at all (that's why bug #3 always fell
  through to the "open both as tabs" fallback on desktop). Deliberately
  uses `<a>` clicks (not `window.open`) for the two downloads, since
  anchor clicks don't consume a popup-blocker "slot" the way `window.open`
  does — only the WhatsApp `window.open` call needs that slot. Old
  `getFilesForShare`/Web Share code path (`base64ToFile_`,
  `openDocsFallback_`, the `navigator.share` call) removed entirely, not
  left dead in the file. Still refuses to send if the contract/receipt PDF
  or the phone number is missing, same as before, with the same "say
  exactly what's missing" messaging.

**Testing:** `node --check` on both inline `<script>` blocks (both OK).
19/19 unit tests against the real sliced source (`extractDriveFileId_`,
`triggerDriveDownload_`, phone-digit-stripping + WhatsApp URL building,
most-recent-photo filtering) — covers real Drive view-URL parsing, `<a>`
creation/click/cleanup, garbage/empty/null inputs, phone numbers with
`+`/spaces/dashes/parens, missing-number and missing-name fallbacks, and
photo-vs-PDF filtering with PDFs interleaved before/after the target
photo. Did NOT write a fresh end-to-end harness for `generateReceipt`
itself (#1) since that fix is a one-line config reconnect, not new logic —
the actual Apps Script `generateReceiptDocument` function was already
unit-provably fine (it's wrapped in its own try/catch and always returns
valid JSON); the bug was purely that it was unreachable.

**Files changed:** `contract.html` only (scriptUrl reconnect, Documents
panel removal + View Photo of Passport rework, Send Contract + Receipt
rework). No `lib/*.js`, no `api/*.js`, no `Code.gs` changes this pass.

**Not done / open questions for Anton:**
- The exact 404 mechanism for bug #2 was never fully confirmed (theory:
  stale panel data vs. a just-trashed regenerated receipt) — moot now
  since the panel is gone, but worth knowing if the same trash-on-
  regenerate pattern ever causes a DIFFERENT stale-link symptom elsewhere
  (e.g. if `contractPdfUrl`/`receiptPdfUrl` cached on `currentEditRecord`
  ever go stale mid-session the same way).
- The same blank-`scriptUrl` pattern exists on every OTHER page in
  vercel-site/ (bikes.html, accounts.html, deposits.html, add-bikes.html,
  customers.html, etc.) — not touched this pass, scoped to contract.html's
  live bug reports only. Worth a deliberate decision later: reconnect
  everywhere, or finish porting each page's still-GAS-only actions the way
  editContract/addContract/cancelContract were ported.
- Push commands below once Anton reviews.

## 🐛🔴 URGENT FIX: cancelContract (and every other reload-after-write)
## looked like it did NOTHING -- a canceled row stayed showing "Pending"
## forever, re-cancelable endlessly with no visible effect -- CODED,
## UNIT-TESTED, NOT YET DEPLOYED (2026-08-17, reported live by Anton
## immediately after the "ALL 4 actions wired" entry below went live --
## this is the very next thing that broke)

**Bug report (Anton, live on staff-app-six-phi.vercel.app):** canceled a
Pending contract (a real one, "Liron Pasternak" / Gt black 5+4) -- it kept
showing in the Pending Contracts list as if nothing happened. Clicked
Cancel on it again, and again -- same result every time, record never
disappears.

**Root cause, traced through the actual code, not assumed:** the
`cancelContract` write itself was landing FINE server-side every time
(confirmed -- this made yesterday's idempotent-replay fix, just below,
LOOK like it hadn't fixed anything, when it actually had). The real bug is
a stale in-memory read cache: `contractJsonCache` (keyed by sheet name,
declared right next to `fetchSheetJson`) is populated ONCE per sheet name
and never invalidated by anything anymore -- it USED to get cleared by the
old client-side `writeSheetJson`, but that function is dead code now that
all 4 write actions go through the server-side `/api/contract/write`
engine instead, and NOTHING calls it. `ctReloadAndRerender()` (the generic
"reload and re-render whichever view is visible" callback every one of
today's 4 actions' `onAllSuccess` uses) was clearing `sheetRows`/
`rowsPromise` (a separate, higher-level cache) and the localStorage
cache (`aaContractRowsCache`) -- but never `contractJsonCache`. So
`loadRows()` → `getContractRowsFromJson()` → `fetchSheetJson('Contract')`
kept handing back the EXACT SAME stale pre-write snapshot from whenever
the page first loaded, for the rest of that page's lifetime, no matter how
many times "reload" ran. **This affected all 4 actions' reload step, not
just cancelContract** -- it just happened to surface first there, since a
canceled-but-still-Pending row sitting untouched in a list is the most
visible possible symptom (an edited/added record silently not showing its
own fresh data would have been much easier to miss).

**Fix:** added `clearContractJsonCache()` (clears every key in
`contractJsonCache`) right next to `fetchSheetJson`, and call it from
`ctReloadAndRerender()` alongside the existing `clearContractRowsCache()`.

**Testing:** new Node harness (`run4.js`, real sliced source: the
`fetchSheetJson`/`contractJsonCache`/`clearContractJsonCache` block,
`getContractRowsFromJson`, and the engine's `ctReloadAndRerender`) directly
reproduces the exact live scenario -- mock server returns "Pending" on the
first `/api/data/Contract` fetch, "Canceled" on every fetch after (same as
a real write having landed in between) -- and proves: (1) with the fix,
calling `ctReloadAndRerender()` triggers a genuinely NEW fetch and
`renderPendingList` receives the fresh "Canceled" data; (2) a control case
confirms that WITHOUT clearing this cache, a reload keeps serving the
stale "Pending" snapshot even though the underlying data changed -- i.e.
this really is the mechanism, not a guess. Also re-ran the full existing
suite (`run.js`/`run2.js`/`run3.js`, updated to account for
`ctReloadAndRerender` now calling `clearContractJsonCache` too) --
**88/88 green across all 4 harnesses.** Both inline `<script>` blocks
re-syntax-checked clean.

**Files changed:** `contract.html` only (`clearContractJsonCache()` added,
`ctReloadAndRerender()` calls it). No backend files touched -- this was
purely a client-side stale-cache bug, nothing to do with the server write
logic itself.

**Not yet done:**
1. Deliver + push -- Anton asked for this ahead of everything else,
   including the in-progress deposits.html rollout (paused, will resume
   after). **Live test once deployed:** cancel a real/throwaway Pending
   contract, confirm it now actually disappears from the Pending list
   immediately after the "Saving…" badge clears, and doesn't reappear.
   Worth double-checking Edit and Add too while at it -- same underlying
   cache bug means an edited/added record's fresh data might not have been
   showing either.
2. Still outstanding, queued for the end of the CURRENT session (Anton's
   own instruction): add a "Saving…" indicator to the Add form's bottom
   statusBox immediately on submit (currently goes blank -- only the
   shared top header strip shows progress; he wants local feedback too).
3. Resume deposits.html rollout (backend port in progress, paused for
   this fix).

## ✅ Phase 2, contract.html: ALL 4 write actions now wired onto the
## save-pipeline engine -- ROLLOUT COMPLETE for this page. CODED,
## TEST-GREEN (80/80 across 3 harnesses), NOT YET DEPLOYED (2026-08-17,
## `addContract` -- the last of the 4 -- landed + full regression pass run
## while Anton was away from his computer for ~an hour; nothing here was
## pushed without him, per standing instructions -- see the bottom of this
## entry for exact commands)

**What this is:** `addContract` (the Add form) is the last of contract.html's
4 write actions rewired onto the `ct`-prefixed save-pipeline engine, same
pattern as `cancelContract`/`customerIntake`/`editContract` above. The form
now resets IMMEDIATELY on submit (the "add" equivalent of a modal closing
instantly) instead of staying disabled/showing "Saving…" for the whole
round trip; the write runs in the background against
`/api/contract/write` (`action:'addContract'`) instead of the old local
`addContractFromJson` (now `__deadCode_oldAddContractFromJson`, unreferenced,
same convention as this file's other dead-code renames). A `clientTxnId` is
minted per submission -- `addContract` always appends a brand-new row, same
double-submit risk class as `customerIntake`, and already has a matching
guard server-side (`lib/contractWrites.js`'s `Contract_notes`-column-3
marker, ported in an earlier session).

**The passport-photo upload is DELIBERATELY still a separate client-side
step**, per the original rollout plan: `lib/contractWrites.js`'s
`addContractFromJson` never touches it. The chosen `File` object is
captured into a local variable BEFORE the optimistic `form.reset()` runs
(a plain `File` reference stays valid even after the input that produced
it is cleared -- confirmed by the harness below), and the actual
`POST /api/contracts/upload` only fires from inside `onAllSuccess`, AFTER
the queued Contract-row write has actually landed -- same endpoint/payload
shape (`name`/`phone`/`dateStr`/`mimeType`/`base64`) as the Edit modal's
own working "Upload photo" button. A photo-upload failure is reported in
the status box but does NOT roll back or hide the fact that the contract
itself saved successfully -- the two are independent outcomes now, not one
atomic unit.

**`rows: []`** in this action's `ctEnqueue()` call, deliberately -- unlike
the other 3 actions, there's no existing row to badge with "Saving…" (the
row doesn't exist until the write lands), so nothing in `pendingRowSaves`
tracks it. The shared header strip (`nav.js`) still shows it as a globally
pending/in-flight save regardless, since that's driven off
`aaContractPendingSaves` existing at all, not off any specific row.

**Testing:** three Node harnesses in outputs scratch (`/tmp`-equivalent,
gone between sessions -- rebuild from this description if picked up
fresh), all loading REAL sliced source verbatim out of `contract.html`
into fake-DOM `vm` sandboxes:
- `run.js` (`editContract`, carried over from the previous entry): 26/26.
- `run2.js` (`addContract`, this slice): 33/33 -- covers: form resets
  synchronously before the fetch resolves; `clientTxnId` present in the
  request; no photo chosen -> exactly one fetch (no spurious upload call);
  photo chosen -> exactly two fetches, upload strictly AFTER the write
  resolves, with the correct `name`/`phone` (from the `number` field, not
  `contact`)/`dateStr` (converted ISO -> dd-MM-yyyy)/`mimeType`/`base64`;
  a server `warning` surfaces in the status box without blocking the photo
  follow-up; a photo-upload failure is reported without erasing the
  "contract saved" confirmation; the 3 pre-existing client-side validation
  checks (total price / deposit amount / delivery fee) still block the
  save entirely (no reset, no fetch) exactly as before; `ctQueueFull()`
  blocks a 3rd concurrent Add with an inline error and never increments
  `sessionCount` or resets the form for that blocked attempt.
- `run3.js` (NEW -- full-rollout regression): 21/21, specifically
  exercising what none of the single-action harnesses could: THREE
  different action types (`cancelContract` + `editContract` + `addContract`)
  sharing the SAME `ctQueue`/`pendingRowSaves`/`MAX_QUEUE=2` cap at once.
  Confirms no cross-contamination between rows tracked under different
  items, correct FIFO promotion from queued -> running as earlier items
  resolve (regardless of which action type finishes first), an `addContract`
  item's `rows:[]` correctly never touches `pendingRowSaves`, and the queue
  + localStorage end up fully drained once all three resolve.
- **Total: 80/80 green.** Both inline `<script>` blocks in `contract.html`
  re-syntax-checked clean (`new Function(...)`), `lib/contractWrites.js`
  and `nav.js` both `node --check` clean.

**Old client-side `addContractFromJson`** renamed to
`__deadCode_oldAddContractFromJson`, unreferenced, kept for an easy
side-by-side comparison/revert -- matches `__deadCode_oldDoRent`/
`__deadCode_oldEditContractFromJson`.

**contract.html's 4-action rollout is now code-complete.** Nothing in this
entry or the 3 below it (editContract wiring, the cancelContract fix, the
searchView fix) has been pushed yet -- all landed in one working tree while
Anton was away, per his instruction to keep going without pushing myself.
Exact commands, once he's back and wants to review the diff first:

```
cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
git status                                  # review everything below first
git add contract.html lib/contractWrites.js PROGRESS.md
git commit -m "contract.html: wire editContract + addContract onto save-pipeline engine (rollout complete); fix cancelContract idempotent-replay bug; fix searchView TDZ crash"
git push
```
(searchView fix + cancelContract fix were already pushed earlier this same
session per the git ref check done then -- `git status` will show the true
current state either way, worth trusting that over this note.)

**Not yet done, in order:**
1. Anton reviews + pushes (see above).
2. **Live smoke test once deployed, all 4 actions**, same recommendation
   as every prior entry -- Rent/Cancel a throwaway Pending contract, Edit
   a field and Save, Add a brand-new test contract (with and without a
   photo) -- confirm each closes/resets instantly, shows the right
   Saving/Queued badge or header-strip indicator, and lands correctly on
   the actual sheet. Also worth deliberately reloading mid-save once (the
   same class of event that caused the `cancelContract` bug above) to
   confirm recovery now behaves -- succeeds silently if the write already
   landed, doesn't fall into the old retry-forever trap.
3. Then the rollout moves to `deposits.html`, then `add-bikes.html`, then
   `customers.html`, per the original plan -- NOT started yet this
   session.

**Files changed this slice:** `contract.html` only (`form`'s submit
handler rewired; old `addContractFromJson` renamed to dead code).
No backend files touched (`lib/contractWrites.js`'s `addContractFromJson`
was already correct from an earlier session).

## 🔧 Phase 2, contract.html: 'editContract' (Edit modal) REWIRED onto
## the save-pipeline engine -- LIVE-BEHAVIOR CHANGE, CODED AND
## TEST-GREEN, NOT YET DEPLOYED (2026-08-17, small delivery #4, third of
## the 4 actions -- landed same session as the two bug fixes just below,
## while Anton was away from his computer for ~an hour)

**What this is:** the third of contract.html's 4 actions wired to the
engine. The Edit modal's submit handler now hits the single-dispatch
`/api/contract/write` endpoint (action `editContract`) instead of the old
local `editContractFromJson` -- the modal closes IMMEDIATELY (optimistic),
the write runs in the background, and the Search-results list shows a
"Saving…"/"Queued…" badge on that one row while it's in flight (same
`opt-row-pending` badge treatment `renderPendingList` already had for
Rent/Cancel, now mirrored in `renderResults` for Edit -- click-handler
attachment is skipped for a row that's mid-save, same belt-and-suspenders
as the Pending list).

**No `clientTxnId`** -- `editContract` has no idempotency guard server-side
either, but for a genuinely benign reason this time (unlike the
`cancelContract` gap fixed below): it's an unconditional overwrite of the
same ~27 columns with the same values every time, so a naive retry
converges to the exact same end state on its own. No guard needed for that
to be safe -- see `lib/contractWrites.js`'s file header comment.

**Testing:** new Node harness in `/tmp` (outputs scratch, gone between
sessions -- rebuild from this description if picked up fresh), loading the
REAL sliced source (engine block + the editForm submit handler + the new
`renderResults` badge branch, sed'd verbatim out of `contract.html`) into a
fake-DOM `vm` sandbox. 26/26 green: submit handler closes the modal and
clears `currentEditRecord` SYNCHRONOUSLY, before the fetch it kicked off
even resolves (proves genuinely optimistic, not just fast); row marked
pending in `pendingRowSaves` and persisted to `aaContractPendingSaves`
immediately; resubmit hits `/api/contract/write` with
`{action:'editContract', rowNumber, ...fields}` and confirmed **NO**
`clientTxnId` in the payload (deliberate, see above); edited field values
carry through unchanged; a `warning` in the response (e.g. the
deposit-method-changed ledger-mismatch case) triggers `alert()` with the
server's own message, not silently swallowed; queue drains and
`ctReloadAndRerender` re-renders the Search-results view on success;
`ctQueueFull()` correctly blocks a 3rd concurrent edit save with an alert
and fires no new fetch; `renderResults` shows the Saving/Queued badge for a
pending row and skips attaching its click handler, while a non-pending row
in the same list still gets its normal card + click handler. Both inline
`<script>` blocks re-syntax-checked clean (`new Function(...)`) after the
edit.

**Old client-side `editContractFromJson`** renamed to
`__deadCode_oldEditContractFromJson`, unreferenced, kept for an easy
side-by-side comparison/revert -- same convention as this file's
`__deadCode_oldDoRent`.

**Not yet done, in order:**
1. Deliver via the workspace folder, push (bundle with the two fixes
   below -- all three are in the working tree together as of this
   entry). Worth testing live once deployed: open Search, click a record,
   change something, Save -- confirm the modal closes instantly and the
   row shows the Saving badge, then updates correctly.
2. `addContract` (Add form + passport-photo follow-up upload) -- the last
   of the 4 actions.
3. Full regression + PROGRESS.md wrap-up once all 4 are wired.

**Files changed this slice:** `contract.html` only (`editForm`'s submit
handler rewired; `renderResults` gains the pending-row badge branch; old
`editContractFromJson` renamed to dead code). No backend files touched.

## 🐛 Fixed: `cancelContract` resubmit of an ALREADY-canceled record threw
## forever -- a Retry button that could never succeed -- CODED, UNIT-
## TESTED, NOT YET DEPLOYED (2026-08-17, reported live by Anton on
## staff-app-six-phi.vercel.app right after the `cancelContract`/`doCancel`
## delivery further below went live)

**Bug report (Anton, live):** canceled a Pending contract; it stayed
showing "Pending"; the header's "1 change didn't save — tap to review"
banner appeared with `cancelContract` for that row, error "This contract
is no longer Pending (current status: "canceled")"; Retry produced the
exact same error every time.

**Root cause, traced through the actual code, not assumed:** the error
message itself gives it away -- the record's current status WAS already
"canceled", meaning the original cancel had genuinely succeeded
server-side. A SECOND `cancelContract` request for the same row landed
afterwards (most likely `restoreUnresolvedSaves()` recovering a leftover
`aaContractPendingSaves` localStorage entry after a page reload mid-flight
-- very plausible, given how much `contract.html` got reloaded during the
DevTools session that found the `searchView` bug above) and hit
`cancelContractFromJson`'s guard, which threw on ANY non-Pending status.
Because that request failed (not succeeded), `ctReloadAndRerender` never
ran, so the client's cached view kept showing the OLD "Pending" state even
though the sheet itself already said "Canceled" -- and because the record
really was already Canceled, every subsequent Retry re-threw the identical
error forever. This exact gap was previously flagged, deliberately, as a
known "real but low-stakes" limitation in `lib/contractWrites.js`'s file
header comment when `cancelContract` was first ported -- this is that gap
actually being hit live.

**Fix, in `lib/contractWrites.js`'s `cancelContractFromJson`:** if the
row's current status is already `"canceled"`, return
`{success:true, row, idempotentReplay:true}` immediately -- a no-op,
since that IS the outcome this action exists to produce -- instead of
throwing. Still throws for any OTHER non-Pending status (e.g. "Rented"),
since that's a genuine conflict (the record was actioned DIFFERENTLY than
this cancel intended) worth surfacing, not silently swallowing.

**Testing:** direct unit test against the real (copied) `contractWrites.js`
via `createContractWrites()` with a fake `sheetIO`, in outputs scratch
(gone between sessions). 3/3 scenarios green: already-"Canceled" row ->
succeeds with `idempotentReplay:true`, zero `writeSheetJson` calls (true
no-op, doesn't re-write anything unnecessarily); fresh "Pending" row ->
real write happens, succeeds, no `idempotentReplay` flag; "Rented" row ->
still correctly throws the conflict error. `node --check
lib/contractWrites.js` clean.

**Practical effect on Anton's currently-stuck failed-save panel:** once
this deploys, clicking Retry on that already-failed "Cancel contract" item
will now succeed and clear itself -- it's a genuine no-op, nothing gets
double-canceled.

**Files changed:** `lib/contractWrites.js` (`cancelContractFromJson` +
file header comment), `contract.html` (`doCancel`'s own comment updated to
match, no behavior change on the client side -- the fix is entirely
server-side).

## 🐛 Fixed: `contract.html` permanently stuck on "Loading bikes from the
## spreadsheet…" on every load -- CODED, SYNTAX-VERIFIED, NOT YET DEPLOYED
## (2026-08-17, reported live by Anton right after the save-pipeline
## engine scaffolding + `cancelContract`/`customerIntake` wiring entries
## below went live)

**Bug report (Anton, live on staff-app-six-phi.vercel.app):** opened
`contract.html`, stuck showing the red "Loading bikes from the
spreadsheet…" gate card forever, 5+ minutes, never resolved.

**Root cause, traced via the browser's own DevTools Console (not
assumed):** `Uncaught ReferenceError: Cannot access 'searchView' before
initialization`, thrown from `ctRefreshUi()` (called synchronously at page
load via `restoreUnresolvedSaves()`, part of the save-pipeline engine
scaffolding added earlier this session -- see that entry below).
`searchView` was declared with `const searchView =
document.getElementById('searchView')` much further down the file (in the
Search/autocomplete section), but referenced earlier by the engine block.
A `const`/`let` binding is in the temporal dead zone until its own
declaration line actually executes, so touching it earlier throws --
even the defensive `typeof searchView !== 'undefined'` guard already in
`ctRefreshUi()` didn't help, since that check doesn't protect against TDZ
(only against a genuinely undeclared identifier). Because this threw
INSIDE the page's initial synchronous script execution, everything after
it in that script block -- including the `loadBikeNames()` call that
actually kicks off the fetch -- never ran. The spinner wasn't waiting on
anything; the script had already died before it started.

**Fix:** moved the `const searchView = document.getElementById(...)`
declaration up to right after the `pendingBackdrop`/`pendingListBox` group
(well before the engine block that references it), with a comment
explaining why it's not declared in its more logical spot further down.
Left the down-stream declaration site as a comment pointing up to the new
one, rather than silently deleting it.

**Testing:** both inline `<script>` blocks re-syntax-checked clean (`new
Function(...)`) after the edit; confirmed only one `const searchView =
document.getElementById` remains in the file.

**Files changed:** `contract.html` only (`searchView`'s declaration
relocated; no other logic touched). No backend files touched.

## 🔧 Phase 2, contract.html: 'customerIntake' (doRent) REWIRED onto
## the save-pipeline engine -- LIVE-BEHAVIOR CHANGE, CODED AND
## TEST-GREEN, NOT YET DEPLOYED (2026-08-17, small delivery #3 --
## `doRent()` is THE action this project's clientTxnId guard was
## originally built for, see below)

**What this is:** the second of contract.html's 4 actions wired to the
engine. `doRent()` ("Yes, rent it") now hits the new single-dispatch
`/api/contract/write` endpoint (action `customerIntake`) instead of the
old local `customerIntakeFromJson` -- confirm modal closes IMMEDIATELY,
write runs in the background, Pending list shows the "Saving…" badge on
that row (same infrastructure the `cancelContract` entry below added).

**The one real judgment call this slice made:** the OLD `doRent()` had a
defensive block in its `catch` -- after a failed request, before
re-enabling "Yes, rent it", it re-fetched the record and checked whether
its status had already moved past Pending, to catch the specific failure
mode its own comment describes (a REAL double-booking Anton hit: Apps
Script finishes the write, the response is lost over a flaky connection,
and a naive retry books it twice). **That whole defensive check is
REMOVED in the new `doRent()`, deliberately, not by oversight.** It was a
same-session, client-side workaround for exactly the failure mode the
server-side `clientTxnId` guard (already ported, already tested 47/47
last session) now handles directly and strictly more robustly -- a
same-`clientTxnId` resubmit safely no-ops and returns the original row
(`idempotentReplay:true`) even across a killed tab or a response lost
AFTER the write landed, not just a same-session manual retry the old
check could catch. The old version is kept, renamed to
`__deadCode_oldDoRent`, unreferenced, for an easy side-by-side
comparison or revert -- same convention as bikes.html's own superseded
code, grep before deleting.

**Testing:** new Node harness in `/tmp/contracttest3/` (scratch). 10/10
green: `doRent()` closes the confirm modal BEFORE the write resolves;
row marked pending synchronously; resubmit hits `/api/contract/write`
with `action:'customerIntake'`; **`clientTxnId` IS present in the sent
payload this time** (explicitly checked, since the whole point of this
slice was getting that guard wired correctly -- contrast with
`cancelContract`'s entry below, which explicitly checks the OPPOSITE);
every record field (name/bikeModel/totalPrice/etc.) carries through
unchanged; `source` stays `'Direct'`; `isDeal` parses correctly from the
sheet's `"TRUE"/"FALSE"` string; queue drains on success; a `warning` in
the response triggers an `alert()` with the server's own message (not
silently swallowed), matching every other guarded action's convention in
this project. Whole file re-syntax-checked clean.

**Not yet done, in order:**
1. Deliver via the workspace folder, push. **Test live once deployed --
   this one's the highest-stakes of the 4** (real money, real prior
   double-booking history): rent out a real or throwaway test Pending
   contract, confirm the modal closes instantly, the row shows
   "Saving…" then disappears/updates correctly, and the customer/income/
   cash rows all land right (same combined-transaction-log behavior
   already verified server-side last session).
2. `editContract` (Edit modal, Search-results badge) next.
3. `addContract` (Add form + passport-photo follow-up) after that.
4. Full regression + wrap-up once all 4 are wired.

**Files changed this slice:** `contract.html` only (`doRent` rewired;
old version renamed to `__deadCode_oldDoRent`, unreferenced). No backend
files touched.

## 🔧 Phase 2, contract.html: 'cancelContract' (doCancel) REWIRED onto
## the save-pipeline engine -- LIVE-BEHAVIOR CHANGE, CODED AND
## TEST-GREEN, NOT YET DEPLOYED (2026-08-17, small delivery #2 of the
## action-by-action rollout -- see the scaffolding entry just below for
## why this is landing in small pieces)

**What this is:** the first of contract.html's 4 actions wired to the
engine scaffolding from the entry below -- picked first because it's the
simplest (single request, no clientTxnId/idempotency guard to reason
about). **This IS a live-behavior change** -- same as bikes.html's own
"first genuinely live-behavior-changing step" entry -- `doCancel()` now
hits the new single-dispatch `/api/contract/write` endpoint instead of
the old local `cancelContractFromJson` (~10 sequential-round-trip-capable
client function, now dead code for this action, left in place per this
project's convention -- grep before deleting). The confirm modal closes
IMMEDIATELY instead of showing "Canceling…"/blocking; the write runs in
the background; the Pending list shows a "Saving…"/"Queued…" badge on
that one row while it's in flight (mirrors bikes.html's
`renterActionsHtml()` treatment, badge suppresses the normal card
details and skips attaching a re-open-the-modal click handler on that
row).

**No `clientTxnId` sent** -- `cancelContract` deliberately has no guard
server-side either (see `lib/contractWrites.js`'s header comment: it
throws if the record isn't still Pending, so a naive retry of an attempt
that already landed would show a confusing error rather than silently
no-op'ing). This is a real but low-stakes, PRE-EXISTING gap -- identical
to what the OLD blocking version already did on a genuine double-submit
-- carried forward unchanged by this wiring, not introduced by it.

**Testing:** new Node harness in `/tmp/contracttest2/` (scratch, gone
between sessions), combining real source slices of `renderPendingList`,
the full save-pipeline engine, and `doCancel` from the actual file.
14/14 green: `doCancel()` closes the confirm modal BEFORE the write
resolves (proves it's genuinely optimistic, not just fast); row marked
pending and persisted to `aaContractPendingSaves` synchronously; resubmit
hits `/api/contract/write` with `{action:'cancelContract', rowNumber}`
and confirmed NO `clientTxnId` in the payload; queue drains and
`ctReloadAndRerender` (reload + re-render) fires on success;
`renderPendingList` shows the Saving badge and suppresses normal card
details for a pending row, and reverts to normal once it's no longer
pending; `ctQueueFull()` correctly blocks a 3rd concurrent save with an
alert and fires no new fetch. Contract.html's inline `<script>` blocks
re-syntax-checked clean (`new Function(...)`) after the edit.

**Not yet done, in order:**
1. Deliver via the workspace folder, push. **Worth testing live once
   deployed**, same recommendation as bikes.html's own single-dispatch-
   wiring entry -- try canceling a real (or throwaway test) Pending
   contract and confirm it still works exactly as before, just via the
   new endpoint, with the modal closing instantly.
2. Wire the next action in another small delivery: `customerIntake`
   (`doRent()`) -- same Pending-list badge infrastructure already
   applies, just needs its own `ctEnqueue()` call built with a
   `clientTxnId` (this one DOES have a guard, per the file header --
   see `doRent()`'s own comment on the real double-booking Anton hit).
3. Then `editContract` (Edit modal, Search-results badge) and
   `addContract` (Add form + passport-photo follow-up), per the order in
   the scaffolding entry below.
4. Full regression + PROGRESS.md wrap-up once all 4 actions are wired.

**Files changed this slice:** `contract.html` only (`renderPendingList`
gains the pending-row badge branch; `doCancel` rewired to
`ctEnqueue`/closes the modal immediately/no longer `async`). No backend
files touched -- `lib/contractWrites.js`/`api/contract/write.js` were
already correct from last session.

## 🔧 Phase 2, contract.html: save-pipeline engine SCAFFOLDING landed
## (unwired), + nav.js registers contract.html's pending-save key --
## CODED AND TEST-GREEN, NOT YET DEPLOYED (2026-08-17, small delivery,
## more to follow -- Anton's running low on usage this session and wants
## this pushed in small pieces rather than one big batch)

**What this is:** step 1 of rolling bikes.html's full optimistic-UI
save-pipeline engine out to contract.html (the actual next task per the
rollout plan -- backend was already ported last session in
`lib/contractWrites.js`/`api/contract/write.js`). This slice adds the
engine itself (`ct`-prefixed, byte-for-byte structural port of bikes.html's
`bk`-prefixed one -- queue-of-2, keepalive, 409-retry,
localStorage crash/nav recovery, failure review overlay) plus the
`opt-banner`/`opt-overlay` markup+CSS, but **wires it to NOTHING yet** --
`doRent()`/`doCancel()`/the Edit form/the Add form still call their OLD
local client-side functions, completely untouched. Same "nothing live
changes yet" guarantee every earlier step of this whole rollout has used.

**Also done this slice:** registered contract.html in nav.js's
`PENDING_SAVE_SOURCES` table (`aaContractPendingSaves`/
`aaContractFailedSaves` / `/api/contract/write`) -- this closes the loop
on the SAME-DAY orphan-save-recovery fix above, which was deliberately
written generically against that table specifically so this would be a
one-line addition. Also generalized `pendingBikesSaveCount()` ->
`pendingSaveCount(source)` and `refreshSaveStrip()` to sum across EVERY
registered source (not just bikes.html) and link to whichever one
actually has the most pending -- so once contract.html's actions are
wired (next slice), the shared header strip picks it up with no further
nav.js changes needed. Harmless today since `aaContractPendingSaves` is
never written yet.

**Testing:** two fresh Node harnesses in `/tmp/contracttest/` and
`/tmp/navtest/` (scratch, gone between sessions -- rebuild from this
description if picked up fresh, same as every other harness in this
file).
- `contracttest/run.js` (12/12 green): the sliced engine block loads and
  runs `restoreUnresolvedSaves()` at page-init time without throwing
  (nothing-pending case); `ctEnqueue()` marks the row pending
  synchronously and persists to `aaContractPendingSaves` immediately;
  resubmit hits `/api/contract/write` with the right body shape; success
  drains the queue, clears the row/localStorage, and calls
  `onAllSuccess` with the real server response; a definitive (non-409)
  failure lands in `ctFailedItems` and `aaContractFailedSaves` with the
  server's message, not silently dropped.
- `navtest/run.js`, re-run after the `pendingSaveCount`/`refreshSaveStrip`
  rename+generalization (24/24 green, up from 22 -- all 7 prior orphan-
  recovery scenarios still pass unchanged, plus a new scenario 8: with
  both bikes.html(1) and contract.html(2) pending at once, the strip
  correctly shows the SUMMED total ("(1 queued)" = 3 total minus the two
  sources' own "running" slots) and links to contract.html since it has
  more pending).
- Both files' inline `<script>` blocks syntax-checked clean
  (`new Function(...)`) and `node --check nav.js` clean, same discipline
  as every other change in this project.

**Not yet done, in order:**
1. Deliver via the workspace folder, push (zero risk -- nothing live
   changed, same guarantee as every prior "backend/engine only" slice in
   this whole rollout).
2. Wire the 4 actions to the engine, in small separate deliveries per
   Anton's request this session (usage running low, wants frequent
   pushable checkpoints): `cancelContract` (`doCancel()`) first --
   simplest, single request, no idempotency guard to worry about --
   then `customerIntake` (`doRent()`), then `editContract` (the Edit
   modal), then `addContract` (the Add form -- most complex, needs the
   passport-photo upload kept as a client-side follow-up AFTER the
   queued write succeeds, since `addContractFromJson` server-side
   deliberately doesn't do that part -- see that file's header comment).
3. Per-row "Saving…" badges on the Pending list (`renderPendingList`)
   and Search results (`renderResults`) -- both need a
   `pendingRowSaves.get(rowNumber)` check added, mirroring bikes.html's
   `renterActionsHtml()`/`bikeCardHtml()` treatment. Natural to do
   alongside step 2's wiring rather than as a separate pass, since the
   badge only means anything once something actually populates
   `pendingRowSaves`.
4. Once all 4 actions are wired and badged: full regression, then this
   whole contract.html slice is done and the rollout moves to
   deposits.html per the original order.

**Files changed this slice:** `contract.html` (added `genClientTxnId()`
+ the save-pipeline engine block + `opt-banner`/`opt-overlay` markup/CSS
-- nothing else touched, no existing function's body changed), `nav.js`
(`PENDING_SAVE_SOURCES` gains contract.html's row;
`pendingBikesSaveCount()` renamed+generalized to `pendingSaveCount(source)`;
`refreshSaveStrip()` now sums across all registered sources and sets
`href`/`title` dynamically instead of a static bikes.html-only link).

## 🐛 Fixed: shared "Saving…" strip could get stuck showing forever on
## pages OTHER than bikes.html -- CODED AND TEST-GREEN, NOT YET DEPLOYED
## (2026-08-17, reported live by Anton on parts.html, after the nav.js
## save-strip move + bikes.html save-pipeline engine entries just below)

**Bug report (Anton, live on staff-app-six-phi.vercel.app):** the shared
"● Saving…" strip was stuck showing on parts.html for several minutes,
survived a refresh of parts.html, and the underlying transaction had
already gone through (visible on the sheet) ages before.

**Root cause, traced through the actual code, not assumed:** the strip is
READ-ONLY -- it just displays whatever's in `aaBikesPendingSaves`
(localStorage). Only bikes.html's OWN script (`restoreUnresolvedSaves()`,
run on ITS OWN page load) ever actually resubmits/clears a leftover entry.
bikes.html's writes use `fetch(..., {keepalive:true})` -- keepalive keeps
the NETWORK REQUEST alive across a navigation, but the JS that would
receive the response and clear the flag is torn down the instant you
leave bikes.html. If nobody happens to revisit bikes.html afterwards
(entirely plausible -- there's no reason to go back to the page you just
finished acting on), that flag -- and the strip on every other page -- is
stuck forever, even though the write itself finished successfully
server-side within seconds. This was a real gap in the design, not a
one-off glitch: recovery was accidentally scoped to "whichever tab
happens to load bikes.html next," not to the app as a whole.

**Fix -- made recovery genuinely cross-page, in `nav.js`:**
- New `recoverOrphanedSaves()` in nav.js, run once on load and again on
  every 2.5s poll tick (alongside the existing `refreshSaveStrip()`).
  Duplicates bikes.html's `bkDispatch`/`bkDispatchWithRetry` shape (same
  POST to `/api/bikes/write`, same 409-retry-up-to-3) -- safe to blindly
  resubmit because every action here is idempotency-guarded server-side,
  same reasoning bikes.html's own recovery already relies on; this just
  stops that recovery being stuck waiting for one specific page.
- Only acts on items queued at least 15s ago (`RECOVERY_MIN_AGE_MS`) --
  guards against jumping in on a save that's simply still genuinely in
  flight on its own tab elsewhere. Also does nothing at all while
  standing ON bikes.html itself (that page's own engine still owns
  recovery there, per `PENDING_SAVE_SOURCES`'s `ownerPage` field) -- avoids
  two different scripts racing to resubmit the same request at once.
- A resolved item is removed from `aaBikesPendingSaves` by matching its
  `clientTxnId` (read-modify-write scoped to that one item), not by
  overwriting the whole key from a stale snapshot -- so this can't
  clobber a genuinely NEW save bikes.html itself queues in another tab
  while this recovery pass is mid-flight. A definitive failure (not a
  409) is written to `aaBikesFailedSaves` instead, so it still surfaces
  in bikes.html's own Retry/Discard review panel next time someone's
  there, rather than being silently dropped.
- Written generically against a `PENDING_SAVE_SOURCES` table (currently
  one entry, bikes.html) rather than hardcoded -- contract.html's own
  pending-save key should be added here the moment its save-pipeline
  engine exists (see the rollout entries below), so this same fix covers
  it automatically instead of needing to be rediscovered per page.
- Confirmed explicitly with Anton: the strip's text must keep stepping
  down correctly as multiple queued saves resolve one at a time (e.g. 2
  pending → "Saving… (1 queued)" → one resolves → "Saving…" → the second
  resolves → hidden), not just eventually land on the right end state --
  tested directly (scenario 2 below).

**Also fixed, found while touching `bkEnqueue()` for the `queuedAt`
timestamp this needed:** `bkEnqueue`'s destructured parameters
(`{ label, rows, requests, onAllSuccess }`) never captured `onStepSuccess`
even though every multi-step call site (e.g. `confirmReturn`) passes one
-- so the per-step local-state patch (e.g. patching `returnDate`/
`situation` the moment `markReturned` succeeds, ahead of the `returnDeposit`
follow-up) was silently a no-op the whole time bikes.html's save-pipeline
engine has existed. Low real-world impact (a full reload already happens
in most of these onAllSuccess handlers anyway) but a real, pre-existing
bug, now fixed as part of this same edit since it's the same function
signature. Confirmed by test (see below).

**`bikes.html` changes:** `bkEnqueue()` now also captures `onStepSuccess`
(bug fix, see above) and stamps `queuedAt: Date.now()` on every item;
`persistPendingSaves()` includes `queuedAt` in what it writes;
`restoreUnresolvedSaves()` preserves the ORIGINAL `queuedAt` from before
a reload (falls back to `0`/"very old" for a pre-this-fix record with no
`queuedAt` at all) rather than resetting the clock, so nav.js's staleness
check reflects genuine age across a reload too.

**Testing:** two fresh Node harnesses (no jsdom available in this sandbox
-- registry access is blocked -- so both use `new Function(...)` source-
slicing on the REAL files, same technique `frontend/dispatch.test.js` used
last session, built in `/tmp/navtest/`, scratch, gone between sessions).
- `run.js` against nav.js's sliced `currentPage`/`pendingBikesSaveCount`/
  `refreshSaveStrip`/`recoverOrphanedSaves`, with a fake localStorage,
  fake `document.getElementById('saveStrip')`, and a mocked `fetch`.
  22/22 green across 7 scenarios: a single orphaned item gets resubmitted
  and the strip clears; TWO orphaned items resolve in order with the
  strip's text correctly stepping "(1 queued)" → plain "Saving…" → hidden
  as each one lands (Anton's specific concern, see above); an item queued
  only 2s ago is left untouched; standing on bikes.html itself skips
  recovery entirely; a definitive (non-409) failure moves the item to
  `aaBikesFailedSaves` with the server's own message; a 409 retries once
  and succeeds transparently, NOT counted as a failure; a corrupted
  localStorage value fails quiet, no throw.
- `enginetest.js` against bikes.html's sliced save-pipeline engine block:
  `bkEnqueue()` stamps a numeric `queuedAt` that's also written to
  localStorage by `persistPendingSaves()`; `onStepSuccess` now actually
  fires (proving the bug above is fixed); `onAllSuccess` still fires;
  the queue drains and the pending key clears on success. 6/6 green.
- Whole-file syntax check (`node --check` on nav.js, `new Function(...)`
  on both of bikes.html's inline `<script>` blocks) clean after every
  edit, same discipline as every other change in this project.
- **28/28 assertions green** across both new harnesses. Did NOT re-run
  bikes.html's full pre-existing fake-Drive suites (129 assertions) or
  `frontend/save-queue.test.js` (33) this pass -- nothing server-side
  changed, and the only client-side surface touched (`bkEnqueue`'s
  signature) is covered fresh by `enginetest.js` above; re-verify those
  too before the NEXT real change to bikes.html's engine, not just this
  narrow fix.

**Not yet done:**
1. Deliver via the workspace folder, push. **This one's worth confirming
   live once deployed** -- if practical, deliberately reproduce the
   original bug (queue a save on bikes.html, navigate away before it
   resolves, wait 15s+, check the strip clears on its own from a
   different page) rather than only trusting the harness above, since
   this fix's whole point is behavior that's inherently awkward to catch
   with a synchronous mock (see `run.js`'s scenario 2 comment on why the
   mock needed an artificial delay to even observe the intermediate
   state).
2. Add contract.html's own `{ownerPage, pendingKey, failedKey, endpoint}`
   row to nav.js's `PENDING_SAVE_SOURCES` the moment its save-pipeline
   engine exists (next task, see the rollout entries below) -- this fix
   was written generically specifically so that's a one-line addition,
   not a repeat of this whole investigation.
3. The contract.html rollout itself (full optimistic-UI treatment,
   mirroring bikes.html's engine) is still the next task per the rollout
   plan -- this fix was a detour to handle Anton's live bug report first.

## 🔧 nav.js: "Saving..." strip moved into the SHARED header, visible from
## any page -- CODED AND TEST-GREEN, NOT YET DEPLOYED (2026-08-17, later
## same day as the bikes.html save-pipeline engine entry just below)

**Why:** the bikes.html save-pipeline engine entry below originally put its
"Saving…" strip directly in bikes.html's own page markup (`#optStrip`).
Anton flagged this after seeing it live: it only helped while actually
standing on bikes.html -- navigate to accounts.html mid-save (a completely
normal thing to do, since the save now runs in the background) and the
indicator just vanished, even though the save was often still genuinely in
flight server-side. Fix: moved the strip into nav.js's shared topbar
(`.save-strip`/`#saveStrip`, mirroring the existing `.sync-badge` pattern
already there for accounts.html's failed-save pill) so it shows on EVERY
page, reading the same `aaBikesPendingSaves` localStorage key bikes.html's
engine already writes to (see that entry's own `persistPendingSaves()`).
Polled every 2.5s (`setInterval`) rather than read once, so it stays
reasonably fresh even while sitting on a totally different page from the
one that queued the save -- that page's own script (the only thing that
would otherwise resolve/clear the indicator) is gone the moment you
navigate away. Clicking it links to bikes.html, the only page with an
actual review/retry panel today.

bikes.html's own page-local `#optStrip`/`.opt-strip` (element, CSS,
`bkRefreshUi()`'s DOM manipulation of it) was removed rather than kept
alongside the new shared one -- keeping both would have shown two "Saving…"
strips stacked on top of each other on bikes.html specifically. The
per-row "Saving…" badges and the failure banner/review overlay stay
exactly where they were (page-local, live/in-memory-accurate) -- only the
header progress indicator moved.

**Also confirmed with Anton (a question he asked, not a bug found):**
whether accounts.html would reflect a bikes.html transaction (e.g. an
extend, which logs income) while that save is still in the queue. Answer,
traced through the actual code rather than assumed: the write to Drive is
fully synchronous within bikes.html's single `POST /api/bikes/write`
request (`keepalive:true` only keeps the *client-side* network request
alive across navigation -- it has no bearing on server-side ordering,
which was already fully sequential/awaited). accounts.html's own
stale-while-revalidate read cache (Phase 1) has NO TTL/skip logic -- every
page load always fires a fresh network fetch and re-renders immediately
when it resolves. So the only real risk window is landing on accounts.html
while the bikes.html write is still actively processing server-side (can
take several seconds for a multi-step action) and accounts.html's own
fetch happening to resolve first -- not stuck, just needs a reload/revisit
a few seconds later, since nothing caches around it. No live cross-page
push exists (accounts.html only reflects reality whenever IT happens to
load/reload) -- that's the honest limitation, not a bug. Anton's call:
leave as-is for now, not worth solving today.

**Testing:** new `frontend/nav-save-strip.test.js`, 15 assertions. Unlike
`dispatch.test.js`/`save-queue.test.js` (which extract and call individual
functions), nav.js is one un-exported IIFE with no globals to grab, so this
loads the whole real file into jsdom and drives it through its actual
public surface -- the DOM it produces -- with `fetch` mocked (nav.js's own
auth-gate fires one on load) and `setInterval` intercepted so the poll can
be advanced manually rather than the test actually waiting 2.5s. Covers:
hidden with nothing pending, correct text for 1 vs 2 pending (the "(1
queued)" suffix), the `href="bikes.html"` link, picking up a NEWLY queued
save on the next poll tick without a reload, clearing itself on the next
tick once the save resolves, and failing quiet (no throw, stays hidden) on
a corrupted localStorage value. Combined with every pre-existing suite:
**269/269 assertions green** across 9 files (adds
`frontend/nav-save-strip.test.js`'s 15 to the 254 from the entry below).

**Not yet done:**
1. Deliver via the workspace folder, push (zero risk -- this Vercel copy's
   `scriptUrl`/API routes are intentionally disconnected in this sandbox,
   see this file's header / project `CLAUDE.md`).
2. When the SAME optimistic-UI treatment is built for contract.html/
   deposits.html/add-bikes.html/customers.html (see the entry below), their
   own pending-save keys should get added to nav.js's strip too (currently
   it only checks `aaBikesPendingSaves`) -- Anton wants to talk through the
   rollout to the other pages once this piece was confirmed working, which
   this entry does.
3. GLOBAL (cross-page) cap-of-2 write-button gray-out is still backlogged,
   unchanged from the entry below.
4. Phase 3 (nav.js's FAILURE badge, `.sync-badge`, being page-aware) is a
   separate, still-untouched item -- not the same thing as this entry,
   which only moved the IN-PROGRESS indicator.

## 🔧 bikes.html: FULL optimistic-UI save-pipeline engine (per-row saving
## state, header progress strip, 2-save cap, keepalive, auto-retry-on-409,
## localStorage crash/nav recovery) -- all 7 write actions rewired, CODED
## AND TEST-GREEN, NOT YET DEPLOYED (2026-08-17, later same day)

**Why this exists:** the earlier same-day "frontend wired to the single-
dispatch endpoint" entry (further below) shipped the perf win -- one round
trip instead of several -- but kept the OLD UX: `setAllButtonsDisabled(true)`
locked literally every button on the page for the whole save, and the
picker stayed open showing "Connecting…/Saving…" text. Anton flagged this
directly: "it still looks exactly the same... everything just locks up.
You can't click anywhere or do anything." What he actually wanted: only the
specific row being acted on grays out with a small "Saving…" badge, a
header strip shows overall progress, the rest of the app (including
navigating to a completely different page) stays fully usable, and up to 2
saves can be in flight/queued at once -- exactly 2 (1 running + 1 waiting),
not 3-4 -- with every write-committing button on the page grayed out once
both slots are full. This entry is that full rebuild, agreed with Anton as
an explicit 8-step plan before starting.

**Step 1 (prerequisite): closed the last idempotency gap.** `returnDeposit`
was the one bikes.html action with no `clientTxnId` guard (its payload has
no consistent customer/contract row to anchor a row-keyed marker to, unlike
every other action). Added a flat, non-row-keyed sidecar marker instead --
`depositReturn_notes` holds a plain `[clientTxnId, timestamp]` list, checked/
appended by two new functions in `lib/bikesWrites.js`
(`findExistingDepositReturnTxnMarkerFromJson`/`markDepositReturnTxnIdFromJson`),
wrapping the WHOLE function (not each of its 3 independent steps
individually) since a replay must skip all of them together. 15 new
scenarios in `return-deposit-idempotency.test.js`: no-clientTxnId backward
compatibility, money-critical idempotency on both the deduction and the
cross-method release+payout paths (retried request does NOT double-fire),
two different clientTxnIds both apply independently, fails open (not
throws) when the sidecar sheet doesn't exist yet. All 7 of bikes.html's
actions are now idempotency-guarded server-side -- the precondition the
rest of this engine relies on to safely auto-retry/blindly resubmit.

**Step 2-5 (the engine itself, in bikes.html's main `<script>`, marked with
`// ================== Save-pipeline engine (2026-08-17) ==================`
/ `// ================== end save-pipeline engine ==================`
comments so it's easy to find/remove as a unit, mirroring accounts.html's
"opt-" class-prefix convention from 16/08):**
- `bkQueue` (array, length 0-2) + `pendingRowSaves` (Map: rowNumber -> the
  queue item currently saving/queued for that row) replace the OLD
  single-scalar `savingReturnRowNumber`/`savingExtendRowNumber`/
  `savingEditTimeRowNumber`/`swapSaving` pattern, which could only ever
  track ONE row "saving" at a time, page-wide -- incompatible with two
  genuinely concurrent saves (e.g. extending bike A and bike B together).
- `bkEnqueue({label, rows, requests, onStepSuccess?, onAllSuccess})` is the
  one entry point every rewired action calls. `requests` is an ordered
  array of `{action, payload}` run in strict sequence as ONE queue slot --
  most actions are a single request, but Return-with-matched-deposit and a
  long Extend (close-out + new booking) are two, same order as before this
  pass, just backgrounded.
- `bkDispatch`/`bkDispatchWithRetry` wrap `fetch('/api/bikes/write', {...,
  keepalive:true})` -- keepalive is what lets the actual network request
  finish even after the user navigates to a different page (bikes.html has
  no SPA router; navigating tears this whole script down). A 409 response
  (another page/tab -- e.g. accounts.html -- legitimately wrote the same
  underlying month sheet in the meantime) is auto-retried up to 3 attempts
  with backoff before being treated as a real failure -- distinct from the
  clientTxnId guard, which protects against the SAME write being applied
  twice; this protects two DIFFERENT legitimate writes from clobbering each
  other on the wire, which matters more now that backgrounding widens the
  collision window.
- `persistPendingSaves()`/`restoreUnresolvedSaves()`: every queued/running
  save is written to `localStorage` (`aaBikesPendingSaves`) the INSTANT
  it's queued, not just on failure. On a fresh page load, anything still
  sitting there (from a navigation or closed tab mid-save) is safely
  resubmitted in the background -- safe purely because of the idempotency
  guard from step 1. A definitively FAILED save (`aaBikesFailedSaves`) is
  restored to the review panel instead, and deliberately does NOT
  auto-resubmit -- that needs a person's Retry click.
- Header strip (`#optStrip`, "● Saving…" / "● Saving… (1 queued)") plus a
  failure banner + Retry/Discard review overlay (`#optBanner`/`#optOverlay`),
  new CSS block prefixed `opt-` for the same find/remove-as-a-unit reason
  as accounts.html's.
- `renterActionsHtml()` now checks `pendingRowSaves` FIRST and renders only
  a small badge (no picker) when this row has an in-flight/queued save;
  otherwise every write-committing button (Confirm on any picker, plus the
  Return/Extend/Swap/Adjust Pickup trigger buttons) is disabled once
  `bkQueueFull()` is true. `bikeCardHtml()` adds an `opt-row-pending` class
  (dims the whole card) for the same row(s).

**Step 6: all 7 actions rewired** -- `confirmReturn` (+ its `returnDeposit`
follow-up, now request #2 of the same queue item instead of a separate
fire-and-forget call), `confirmEditTime`, `confirmExtend` (both the short
in-place path and the long close-out+intake pair), `submitSwap`. Every one
now: builds its payload(s) synchronously, closes its picker/modal
immediately (optimistic), and calls `bkEnqueue()` instead of
`bikesWriteDispatch()` + `setAllButtonsDisabled()`. The old
`bikesWriteDispatch`/`setAllButtonsDisabled` functions are left in place,
unused, with a comment explaining the supersession (grep before deleting).

**Step 7: failure review UI** -- built alongside the engine rather than as
a separate pass, since the banner/overlay/Retry/Discard plumbing is shared
infrastructure with the pending-save tracking. `bkRetryFailed` resets the
item to `reqIndex:0` and re-queues it from scratch (safe -- every step is
independently idempotency-guarded, so re-running a step that already
secretly succeeded is a harmless no-op). `bkDiscardFailed` has no generic
undo (unlike accounts.html's simple add/edit/delete rows, every action
here is a multi-sheet server-side operation) -- it just stops retrying and
reloads so the screen reflects whatever the real server-side state is.

**Step 8: testing.** New `frontend/save-queue.test.js` (33 assertions, same
jsdom-extraction technique as the existing `dispatch.test.js`, extracting
the whole engine block by its start/end marker comments rather than one
function at a time): queue-cap enforcement (0/1/2, `bkQueueFull()` exactly
at 2, never blocks a 3rd purely because 2 rows can be tracked
independently), `keepalive:true` present on every request + correct
URL/method/body shape, 409-retry succeeding transparently within 3
attempts, 409-retry exhausting after exactly 3 attempts and surfacing as a
real failure with the server's own message, `aaBikesPendingSaves` written
the instant a save is queued and cleared the instant it resolves, and
`restoreUnresolvedSaves()` both correctly resubmitting a leftover pending
save (and reloading once it resolves) AND correctly restoring a leftover
FAILED save to the review panel WITHOUT auto-resubmitting it. Combined with
all pre-existing backend suites: **239/239 assertions green** across 8
files (`contract-writes.test.js` 47, `extend-and-pickup.test.js` 38,
`long-extend.test.js` 34, `return-actions.test.js` 32,
`return-deposit-idempotency.test.js` 15, `swap.test.js` 25,
`frontend/dispatch.test.js` 15, `frontend/save-queue.test.js` 33). Whole
file also syntax-checked clean (`new Function(...)` on both inline
`<script>` blocks) after every edit.

**Explicitly deferred to the backlog, per Anton (17/08/2026):** the
cap-of-2 gray-out is currently PAGE-SCOPED (bikes.html only). A GLOBAL,
cross-page version (any write-committing button anywhere in the app grays
out once 2 saves are queued on ANY page) is wanted eventually but was
explicitly deprioritized -- "we can probably do that later though, if it's
a large scope... just put it on the list." Cross-page data safety in the
meantime is handled by the 409 auto-retry above plus the pre-existing
`expectedModifiedTime` conflict check server-side (a genuine collision
between two pages self-heals via retry rather than either silently
corrupting the other or just failing once).

**Not yet done:**
1. Deliver via the workspace folder, push (zero risk, nothing live changed
   -- this Vercel copy's `scriptUrl` is intentionally disconnected, see
   this file's own header / project `CLAUDE.md`).
2. Once bikes.html's pattern is proven live, apply the SAME full
   optimistic-UI treatment (not just backend-dispatch wiring) to
   contract.html before/while doing its frontend wiring (task pending
   below), and to deposits.html/add-bikes.html/customers.html after that,
   per the rollout order -- this is a course correction vs. the "keep the
   existing blocking UX" scope decision written into contract.html's own
   entry below, which predates Anton's clarification that the FULL
   real-time per-row background-save experience is what's wanted
   everywhere, not just bikes.html.
3. GLOBAL (cross-page) cap-of-2 gray-out -- backlogged, see above.
4. Phase 3 (make nav.js's failure badge page-aware) is still untouched.

## 🔧 Phase 2, contract.html write layer: ALL 4 IN-SCOPE ACTIONS PORTED
## AND TEST-GREEN, NOT YET DEPLOYED, NOT YET WIRED INTO THE FRONTEND
## (2026-08-17, later same day as the inventory entry just below)

**What this is:** the backend port for contract.html, following directly
from the inventory entry below -- `lib/contractWrites.js` (new) +
`api/contract/write.js` (new), covering all 4 in-scope actions in one
slice rather than several (unlike bikes.html's multi-slice rollout) since
the inventory pass already showed this page's REAL write surface is much
smaller than first thought -- 4 actions, not 16. **contract.html's own
frontend is completely untouched** -- same "nothing live changes yet"
guarantee as every bikes.html backend-porting entry.

**What got ported, byte-for-byte from contract.html's own copies:**
`cancelContractFromJson`, `addContractFromJson` (minus the passport-photo
upload, which stays a client-side follow-up step -- see the inventory
entry below), `editContractFromJson`, and `customerIntakeFromJson` (the
NEWER, combined-transaction-log version specific to contract.html -- see
inventory entry). Every shared helper (`createSheetIO`, the recompute
cascade, ledger-note helpers, name/bike matchers, `DEPOSIT_CATEGORIES_B`,
etc.) was cross-checked byte-for-byte against contract.html's own copy
before reuse -- confirmed identical to `lib/bikesWrites.js`'s versions in
every case checked, but verified rather than assumed given the "16 vs 4"
scope correction already taught not to assume too much between pages.

**Idempotency, decided per-action (full reasoning in the file's own header
comment):**
- `customerIntake` -- clientTxnId guard, same new-row-marker technique as
  bikes.html's swap/customerIntake (customer_notes, column 3). This is the
  one `doRent()`'s own client-side comment explicitly ties to a REAL
  double-booking Anton hit from a dropped-connection retry -- the clearest
  case for a guard of anything ported this slice.
- `addContract` -- ALSO got a guard (a genuinely new judgment call, not a
  mechanical copy): it always appends a new Contract row, same double-
  submit risk class as `customerIntake`/`swapBike`, even though
  contract.html's own client-side version has no such protection today.
  Marker lives on a SEPARATE sidecar (`Contract_notes`, column 3) from
  `customerIntake`'s (`customer_notes`, column 3) since they tag different
  sheets' rows.
- `editContract` -- no guard: unconditionally overwrites the same columns
  with the same values every time, so a retry converges to the same end
  state (same reasoning as bikes.html's `updateReturnPickup`).
- `cancelContract` -- deliberately NO guard, flagged as a real but
  low-stakes gap: this action throws if the contract isn't still Pending,
  so a retry after a first attempt that actually succeeded would show a
  confusing error instead of silently no-op'ing. Identical to
  contract.html's own existing behavior today (not a regression) -- worst
  case is a wrong error message, not a duplicate row or double-charge, so
  a third marker sidecar wasn't judged worth it this pass.

**Testing:** new fake-Drive Node test file (`contract-writes.test.js` in
`/tmp/bikestest/`, same harness as every bikes.html test file). 47/47
green across 14 scenarios: `cancelContract` basic success + rejecting a
non-Pending retry; `addContract` basic success, Deal-flag note, the
money-critical idempotency case (a retried add creates exactly ONE row,
not two, and a replay reports the original row number back), two
DIFFERENT clientTxnIds both applying independently, blank-name validation;
`editContract` basic success (confirms column A/date is left untouched,
matching contract.html's own comment), the deposit-method-changed warning,
invalid-row rejection; `customerIntake` basic success (customer row
correct, matching Pending Contract row flipped to Rented, income/cash/
bikes-sheet writes all correct), idempotency (retry does NOT create a
second booking), and -- specific to this page's newer design -- a direct
check that the COMBINED transaction-log entry actually covers every sheet
a rental touches (customer, Contract, bikes, the monthly income sheet, and
cash), confirming the 15/08/2026 bug fix (Contract status flip previously
un-logged, so un-reversible) survived the port intact. **All 5 backend
test files together: 176/176 assertions green** (bikes.html's 4 files:
129, contract.html: 47).

**Not yet done, in order:**
1. Deliver via the workspace folder, push (zero risk, nothing live changed).
2. Frontend wiring -- add a `contractWriteDispatch(payload)` +
   `genClientTxnId()` pair to contract.html (mirrors bikes.html's own
   pass), rewire `doRent()`/`doCancel()`/the Add form's submit handler/the
   Edit modal's submit handler to call it instead of the local functions,
   mark the old client-side write block as DEAD CODE (same banner as
   bikes.html got). Same scope decision as bikes.html: keep the existing
   blocking UX (Connecting/Saving stages), don't build the full
   accounts.html-style optimistic-UI layer in this pass.
3. Repeat this whole Phase 2 process for deposits.html, add-bikes.html,
   customers.html, per the rollout plan's suggested order -- re-verify
   each page's actual write-surface size first, the way this page's
   inventory pass corrected an over-estimate, rather than trusting the
   old 2026-08-16 counts.
4. Phase 3 (make nav.js's failure badge page-aware) is still untouched.

**Files changed this slice:** `lib/contractWrites.js` (NEW),
`api/contract/write.js` (NEW). `contract.html` itself untouched.

## 🚧 Phase 2, contract.html write layer: INVENTORY/DESIGN DONE, NO CODE
## WRITTEN YET (2026-08-17)

**What this is:** the write-action inventory pass for contract.html, the
next page in the rollout's suggested order (bikes.html → **contract.html**
→ deposits.html → add-bikes.html → customers.html). Same first step
bikes.html's own rollout started with -- read the whole page's write
surface before writing any server-side code, so the port that follows is
a mechanical byte-for-byte translation, not a redesign.

**Scope correction vs. the original 2026-08-16 count:** that entry counted
contract.html at "16" write-shaped functions, the largest of any
remaining page. Actually reading the page shows that count mixed two very
different things together. Only **4 actions are genuinely JSON-backed
Drive writes** -- the same `fetchSheetWithMeta`/`writeSheetJson` pattern
every other ported page uses, and the only kind this rollout's server-side
port applies to:
- `addContractFromJson` -- the Add-contract form (action:'addContract').
- `editContractFromJson` -- the Edit modal, Search tab (action:'editContract').
- `cancelContractFromJson` -- "Yes, cancel it" on a Pending record
  (action:'cancelContract').
- `customerIntakeFromJson` -- "Yes, rent it" (`doRent()`), the SAME
  customer-intake write bikes.html's long-extend and customers.html's Add
  form use, duplicated here per the per-file convention.

The other ~12 counted functions (`regenerateContract`,
`findContractDocument`, `generateReceipt`, `getFilesForShare`,
`findChecklistDocument`, `generateChecklist`, and their call sites) all
hit `fetch(scriptUrl, ...)` where `scriptUrl` is a literal empty string
(line 962: `const scriptUrl = ''; // DISCONNECTED: this Vercel copy is
intentionally not wired to the live backend`). These are Google
Docs/PDF-template document-generation features (contract PDFs, receipts,
checklists, file-share links) that were never part of the Drive-JSON
migration and are a fundamentally different kind of work (Apps Script
DocumentApp templating, not sheet read-modify-write) -- **explicitly OUT
OF SCOPE for this rollout**, same as bikes.html's calendar sync was ruled
out of scope for that page. They're already broken today regardless of
anything in this pass; porting them would be a separate project.

**One wrinkle `addContractFromJson` has that no bikes.html action did:** a
best-effort passport-photo upload, POSTed to `/api/contracts/upload` (a
real, already-connected Vercel endpoint -- NOT a scriptUrl legacy path)
after the Contract row itself saves successfully. This will need to stay
a client-side follow-up step after the main `addContract` server
dispatch succeeds (same shape as bikes.html's `returnDeposit` follow-up
after `markReturned`), rather than being folded into the server-side
write itself -- the upload takes a base64 image payload and returns a
file URL, unrelated to the sheetIO/Drive-JSON write path.

**Another difference from bikes.html worth flagging:** contract.html's
`customerIntakeFromJson` is NOT the same version as bikes.html's copy --
it's a NEWER design (dated 15/08/2026 in its own inline comments, fixing
a real bug Anton hit: reversing a rental's income/cash entries left the
bike showing "Rented" forever because the Contract-status-flip write was
never logged at all). Every helper it calls
(`appendMonthlyIncomeRowFromJson`, `appendCashSheetRowFromJson`,
`addRentalAmountToBikesSheetFromJson`, `processDepositForPaymentFromJson`,
`logSecurityDepositFromJson`, `markMatchingContractAsRentedFromJson`,
`syncContractRowTotalsFromJson`) now returns a `{write: {...}}`
descriptor instead of independently calling `logTransactionB` itself, and
`customerIntakeFromJson` collects all of them into ONE combined,
one-click-reversible transaction-log entry. **This version -- not
bikes.html's -- is the one to port for contract.html.** Byte-for-byte,
per the project's own convention (duplicate per page, no shared JS), but
the two pages' copies have now diverged in a real, meaningful way and
should not be assumed interchangeable going forward.

**Everything else needed to port these 4 actions was already built once
for `lib/bikesWrites.js` and can be reused as a direct, verified
reference** (not copy-pasted blind -- cross-checked byte-for-byte against
contract.html's own copy of each): `createSheetIO`, the recompute cascade
(`recomputeCashSheetTotalsB`/`recomputeMonthlySummaryCascadeB`/
`recomputeCurrentMonthSummaryCascadeB` -- confirmed identical, both
explicitly "ported verbatim from accounts.html's own copy"),
`DEPOSIT_CATEGORIES_B`/`DEPOSITS_MONTH_NAMES` (confirmed identical),
`HEADER_ROWS_B`/`LEDGER_CONTACT_COL_B` (confirmed identical),
`normalizeNameForContractMatch`/`bikeNamesMatchForTaxLookup` and the
ledger-note helpers (`parseLedgerTotal`/`formatMoneyForLedgerB`/
`stripLedgerTotalLineB`/`stripAllTrailingParensAndDealB`) -- all the same
shape as bikes.html's copies, to be verified line-by-line during the
actual port rather than assumed. Contract.html-SPECIFIC pieces with no
bikes.html equivalent: `CONTRACT_KEYS_B` (36-column layout array),
`buildContractCoreFieldsB`/`buildContractTailFieldsB` (shared field
derivation between add/edit), `syncContractDealNoteB` (the Deal-flag
sidecar note on `Contract_notes`, column B -- distinct from the
ledger-note sidecar on `customer_notes`).

**Planned slice order (smallest/most self-contained first, same strategy
as bikes.html's rollout):**
1. `cancelContractFromJson` -- simplest possible action: one status-flip
   write, guarded by "must currently be Pending", no money/ledger math at
   all. No clientTxnId guard needed (same reasoning as
   `closeBikeForExtend` in bikes.html -- flipping to "Canceled" again on
   a retry is harmless... **actually needs a closer look**: unlike
   `closeBikeForExtend`, this one THROWS if the status isn't "Pending"
   anymore, so a naive retry after a dropped connection where the first
   attempt actually landed would incorrectly report failure instead of
   succeeding silently -- worth deciding during implementation whether
   that's acceptable (matches today's behavior exactly, not a regression)
   or worth a small idempotency improvement.
2. `addContractFromJson` -- the Add form, plus the passport-photo
   follow-up wrinkle noted above.
3. `editContractFromJson` -- similar shape to `addContractFromJson`,
   reuses the same `buildContractCoreFieldsB`/`buildContractTailFieldsB`.
4. `customerIntakeFromJson` (`doRent()`) -- the big one, last, same
   reasoning as bikes.html doing its return-family before its
   long-extension pair: get the simpler, more self-contained actions
   proven first. This is also the one place a `clientTxnId` guard clearly
   matters -- `doRent()`'s own comment describes a REAL double-booking
   Anton hit from exactly this kind of dropped-connection retry.

**Not yet done:** no code written yet -- `lib/contractWrites.js` and
`api/contract/write.js` don't exist. This entry is the handoff if picked
up in a fresh session: read this whole entry, then start with
`cancelContractFromJson` per the slice order above.

## 🔧 Phase 2, bikes.html: FRONTEND NOW WIRED TO THE SINGLE-DISPATCH
## SERVER ENDPOINT FOR ALL 7 ACTIONS -- LIVE-BEHAVIOR CHANGE, NOT YET
## DEPLOYED (2026-08-17, later same day as the "all 7 actions ported"
## backend entry just below)

**What this is:** the first genuinely LIVE-BEHAVIOR-CHANGING step in this
whole bikes.html rollout -- every one of the prior bikes.html entries
below added new, unreferenced server-side code that changed nothing about
how the page actually behaved. This one rewires bikes.html's own 7 write
call sites (`confirmReturn`, `submitReturnDeposit`, `confirmEditTime`,
`confirmExtend`'s short AND long paths, `submitSwap`) to call the new
single-dispatch `/api/bikes/write` endpoint instead of the old local
client-side functions -- so from this point on, every Return/Extend/Swap/
Deposit action on bikes.html actually runs its business logic
server-side, in ONE round trip, with idempotency protection on the
money-affecting ones. This is the same architectural change
accounts.html got on 16/08/2026, applied to bikes.html.

**What changed:**
- Added `bikesWriteDispatch(payload)` (byte-for-byte structural mirror of
  accounts.html's `accountsWriteDispatch`) -- POSTs to `/api/bikes/write`,
  throws a clear error on 401 (signed out), 409 (conflict -- someone else
  saved this record in the meantime), or any other non-2xx/malformed
  response, otherwise resolves to the parsed JSON body.
- Added `genClientTxnId()` (identical to accounts.html's) -- one random id
  per logical write, generated once at submit time.
- All 7 call sites rewired to build a payload with an `action` field
  (`markReturned`, `earlyReturnBike`, `returnDeposit`, `updateReturnPickup`,
  `extendBike`, `closeBikeForExtend`, `customerIntake` -- matching
  `bikesWriteDispatch`'s switch in `lib/bikesWrites.js` exactly) and call
  `bikesWriteDispatch` instead of the old local function. `clientTxnId` is
  generated and sent on every action that has a server-side idempotency
  guard (`swapBike`, `markReturned`, `earlyReturnBike`, `extendBike`,
  `customerIntake`) -- NOT sent for `updateReturnPickup`/
  `closeBikeForExtend` (naturally idempotent, no guard exists) or
  `returnDeposit` (documented pre-existing gap, see the "all 7 actions"
  entry below).
- The old client-side write-action block (`performMarkReturned` through
  `customerIntakeFromJson`, ~2100 lines) is now genuinely DEAD CODE --
  marked with the same banner comment accounts.html used for its own
  equivalent block, left in place (not deleted) for an easy revert if
  anything about the new endpoint needs fixing once this is live, per the
  project's established convention.

**SCOPE DECISION, called out explicitly (also documented in bikes.html's
own DEAD CODE banner comment):** this pass did NOT build accounts.html's
full silent-background-optimistic UI (instant modal close + on-page
pending-row state + a dismissable failed-saves banner/review panel) on
top of the new single-dispatch endpoint. bikes.html's EXISTING UX --
modal stays open with a "Connecting…"/"Saving…" stage label and all
buttons disabled until the request resolves, then `alert()` on failure --
is UNCHANGED. Only what happens under the hood during that wait moved
from up to ~10 sequential client-side round trips per action down to
exactly 1, with idempotent retries now safe server-side. This was a
deliberate cut, not an oversight: bikes.html's 7 actions patch completely
different, heterogeneous on-page state (a Return, a long Extend, and a
Swap each touch different parts of the UI) unlike accounts.html's uniform
add/edit/delete-a-list-row shape, so reproducing that whole subsystem
faithfully across all 7 in one unattended pass -- on a live money-handling
page, with Playwright unavailable in this sandbox to verify visually --
carried real risk for a UX-only win. The performance + idempotency win
(the actual point of this rollout) is fully realized either way. Layering
the instant-close/banner UX on top is a well-scoped, lower-risk follow-up
once THIS pass has been verified live, not bundled into it.

**Testing:** two layers, given the live-behavior nature of this change:
1. Cross-checked every one of the 7 rewired payloads field-by-field
   against `bikesWriteDispatch`'s switch statement and each target
   function's own `data.<field>` reads in `lib/bikesWrites.js` (documented
   inline above) -- 3 of the 7 payloads (`returnDeposit`, `swapBike`,
   `customerIntake`) were constructed from object literals that were
   ALREADY being passed to the old local functions unchanged (only
   `action`/`clientTxnId` were added), so those carry over their existing
   correctness by construction; the other 4 (`markReturned`,
   `earlyReturnBike`, `updateReturnPickup`, `extendBike`,
   `closeBikeForExtend`) were rebuilt and checked field-by-field against
   the server function signatures.
2. New jsdom test file (`frontend/dispatch.test.js` in `/tmp/bikestest/`)
   -- extracts `bikesWriteDispatch`/`genClientTxnId`'s REAL source
   (byte-for-byte from the actual bikes.html file, not a retyped copy) and
   exercises them directly: success posts to `/api/bikes/write` with the
   right method/headers/body; 401 throws a signed-out error; 409 throws
   the server's conflict message; a 500 with an error field throws that
   message; a malformed/non-JSON error response falls back to "HTTP
   &lt;status&gt;" cleanly; `genClientTxnId` produces distinct ids via
   `crypto.randomUUID` when available and falls back to a manual
   `ctx_`-prefixed id when it isn't. 15/15 green. Did NOT attempt a full
   jsdom render of the whole page (300KB inline script, hundreds of
   top-level DOM lookups that assume a fully rendered page) to exercise
   each of the 7 call sites end-to-end via simulated clicks -- judged not
   worth the fragility for what would amount to re-verifying object
   literals already checked field-by-field in step 1. All 4 backend
   fake-Drive suites (129 assertions) re-run clean, confirming this
   frontend change didn't require touching `lib/bikesWrites.js` again.
   **144 assertions green across 5 test files total.**

**This is the first change in the whole bikes.html rollout where a typo
or wrong field name would show up as a real failure for Anton, not just
inert dead code** -- flagging this clearly rather than folding it into
the same "nothing live changed" framing every prior entry used.

**Not yet done, in order:**
1. Deliver via the workspace folder, push. **Recommend testing this one
   live before moving on** -- try a Return, a short Extend, a long
   Extend, and a Swap on a real (or throwaway test) booking and confirm
   each one still works exactly as before, just faster.
2. Optional follow-up, only after the above is confirmed solid: build the
   accounts.html-style instant-close/optimistic-UI + failed-saves-banner
   layer on top (see the SCOPE DECISION above for why this was cut from
   this pass).
3. Repeat this whole Phase 2 process (backend port, then frontend wiring)
   for the next page (contract.html, deposits.html, add-bikes.html, or
   customers.html, per the original rollout plan's suggested order).
4. Phase 3 (make nav.js's failure badge page-aware) is still untouched.

**Files changed this slice:** `bikes.html` (added `bikesWriteDispatch` +
`genClientTxnId`; rewired all 7 write-action call sites to use them;
updated the old write-action block's header comment to a DEAD CODE
banner). No backend files touched.

## 🔧 Phase 2, bikes.html write layer: ALL 7 ACTIONS NOW PORTED AND
## TEST-GREEN -- long-extension pair ('closeBikeForExtend' +
## 'customerIntake') is the last one, NOT YET DEPLOYED, NOT YET WIRED
## INTO THE FRONTEND (2026-08-17, later same day as the updateReturnPickup
## + extendBike-short entry just below)

**What this is:** the fourth and final backend-porting slice -- the
long-extension pair, the last 2 of bikes.html's 7 write actions (both
counted as one "action" conceptually -- the "Extend 1 month" checkbox /
30+ day extend flow -- but implemented as 2 separate dispatch actions,
see below for why). Added to the same `lib/bikesWrites.js` /
`api/bikes/write.js` from the prior three entries (no new files).
**bikes.html's own frontend is still completely untouched.** This
completes backend porting for every write action bikes.html has -- the
`bikesWriteDispatch` switch now handles all 7, and the file header STATUS
comments in both files reflect that.

**What got ported, byte-for-byte from bikes.html's own copies:**
`closeBikeForExtendFromJson`, `customerIntakeFromJson` (+ its dependencies
`findRentedContractRowForBackfillFromJson`, `syncContractRowTotalsFromJson`,
`logSecurityDepositFromJson`, `stripBikeNameBracketsB3`). Everything else
`customerIntakeFromJson` calls (`appendLedgerEntryFromJson`,
`appendMonthlyIncomeRowFromJson`, `appendCashSheetRowFromJson`,
`addRentalAmountToBikesSheetFromJson`, `processDepositForPaymentFromJson`,
`flipMatchingContractStatus`) was already ported in earlier slices and
reused verbatim.

**Design resolution for the "two sequential dependent writes" question
flagged in every prior entry:** turned out simpler than expected once
actually traced through bikes.html's own frontend. `confirmExtend()`'s
long-extension branch fires `closeBikeForExtendFromJson` and
`customerIntakeFromJson` as **two separate sequential HTTP requests
today**, not one atomic combined action -- so this port exposes them as 2
separate dispatch actions (`'closeBikeForExtend'`, `'customerIntake'`)
rather than inventing a wrapper bikes.html itself doesn't have. That
means each one just needs its OWN independent idempotency treatment, the
same as every other action already ported:
- `closeBikeForExtend` got **no** clientTxnId guard -- it's naturally
  idempotent, unconditionally setting situation to "Returned" regardless
  of the row's current value, so a retry converges to the same end state
  (same reasoning as `updateReturnPickup`'s gap in the prior entry).
- `customerIntake` got the **same** clientTxnId guard `swapBikeFromJson`
  uses (it also always creates a brand-new customer row), since a retried
  intake would otherwise double-book the whole extension period as two
  separate paid rows -- real money, so this needed protection. Tested
  explicitly (Test 5 below).

One residual gap, documented rather than silently shipped: if
`closeBikeForExtend` succeeds but the page/network dies before
`customerIntake`'s own retry-with-marker completes, a plain retry of the
CLOSE call is harmless (idempotent), but if the ORIGINAL `customerIntake`
call is somehow re-sent with a fresh `clientTxnId` (not a same-ID retry)
it would create a second new row -- this is a fundamentally different
risk than a same-ID replay and no guard here (or anywhere else in this
codebase) protects against it. This is a pre-existing characteristic of
bikes.html's own two-request design, not a new regression introduced by
this port.

**Testing:** same fake-Drive Node harness (`/tmp/bikestest/` on the
sandbox, scratch, rebuild if picked up again), extended with a fourth
test file (`long-extend.test.js`). 34/34 green across 7 scenarios:
closeBikeForExtend basic success (situation flips to Returned, return
date and total price both left untouched) and its natural idempotency (a
repeated call is harmless with no guard needed); customerIntake
(extend-sourced) basic success -- new row created with the right
fields, ledger note CARRIES FORWARD the original leg's history and
combines the running total (19 + 30 = 49 days), Contract row's return
date and status synced, income + cash rows written; a fresh security
deposit is correctly SKIPPED for an extend-sourced intake even when a
deposit method is set; the money-critical idempotency case (Test 5 -- a
retried intake with the SAME clientTxnId does NOT create a second row or
a second income row, and reports the original row number back); two
DIFFERENT clientTxnIds both apply independently as two separate rows
(proves the guard doesn't over-suppress genuinely separate extensions);
blank name validation. **All 4 test files together: 129/129 assertions
green** (swap 25, return-family 32, updateReturnPickup+extendBike-short
38, long-extension 34).

**Not yet done, in order -- backend porting for bikes.html is DONE, this
is what's left:**
1. Deliver via the workspace folder, push (zero risk, nothing live changed).
2. The frontend optimistic-UI + idempotency-submission layer in
   bikes.html itself (mirroring accounts.html's
   `genClientTxnId`/`optItems`/`optInFlight`/`queueMonthSave` pattern),
   wired to `api/bikes/write.js`, generating and sending `clientTxnId` on
   every action that has a guard (`swapBike`, `markReturned`,
   `earlyReturnBike`, `extendBike`, `customerIntake`). Still nothing
   user-visible changes before this step -- bikes.html's client script
   stays untouched until this step actually starts.
3. A jsdom-based frontend test batch for that layer (Playwright still
   unavailable in this sandbox).
4. Only after bikes.html's frontend is wired and tested: repeat this
   whole Phase 2 process for the next page (contract.html, deposits.html,
   add-bikes.html, or customers.html, per the original rollout plan's
   suggested order).

**Files changed this slice:** `lib/bikesWrites.js` (added
`stripBikeNameBracketsB3`, `closeBikeForExtendFromJson`,
`findRentedContractRowForBackfillFromJson`, `syncContractRowTotalsFromJson`,
`logSecurityDepositFromJson`, `customerIntakeFromJson`; updated
`bikesWriteDispatch` to add `'closeBikeForExtend'` and `'customerIntake'`;
updated the factory's returned-exports object; updated the file header
STATUS comment to reflect all 7 actions being done), `api/bikes/write.js`
(updated the header STATUS comment only).

## 🔧 Phase 2, bikes.html write layer: 'updateReturnPickup' +
## 'extendBike' (SHORT extension only) PORTED AND TEST-GREEN, NOT YET
## DEPLOYED, NOT YET WIRED INTO THE FRONTEND (2026-08-17, later same day
## as the return-family entry just below)

**What this is:** the third slice of the write-layer port -- 2 more of
bikes.html's 7 actions (6 of 7 total now done), added to the same
`lib/bikesWrites.js` / `api/bikes/write.js` from the prior two entries (no
new files). Grouped together because they're bikes.html's two remaining
small/self-contained actions -- everything left after this slice is just
the long-extension pair, which is a genuinely different shape (two
sequential dependent writes, not one). **bikes.html's own frontend is
still completely untouched** -- same as the prior two entries, these are
additions to files nothing else references yet.

**What got ported, byte-for-byte from bikes.html's own copies:**
`performUpdateReturnPickup` (+ its Contract-mirroring helper
`mirrorDeliveryLinkToContract`), and `extendBikeRowFromJson` (the SHORT
extension path only -- under 30 days, "1 month" checkbox not ticked; the
LONG path is `closeBikeForExtendFromJson` + `customerIntakeFromJson`,
still not ported) plus its two dependencies `buildRentalIncomeTextB` and
`appendMonthlyIncomeRowFromJson`. Everything else `extendBikeRowFromJson`
calls (`appendLedgerEntryFromJson`, `syncContractReturnDateOnlyFromJson`,
`addAmountToContractRowFromJson`, `appendCashSheetRowFromJson`,
`processDepositForPaymentFromJson`, `addRentalAmountToBikesSheetFromJson`)
was already ported in the swap/return-family slices, so this slice reused
those verbatim rather than re-adding them.

**Idempotency -- ported for 1 of the 2, deliberately NOT for the other:**
`extendBikeRowFromJson` got the same same-row `clientTxnId` guard
`markReturned`/`earlyReturnBike` got -- it adds real money to the total
price and appends a ledger/income/cash/bikes-sheet entry, so a retry
without the guard would double-charge. Tested explicitly (Test 3 below):
the same extend request submitted twice bumps the total price and the
return date ONCE, not twice, and produces exactly one income row and one
cash entry. `performUpdateReturnPickup` did NOT get a guard -- unlike
every other guarded action it never adds money or appends a row, it's a
plain field overwrite (return time/date/delivery link), so a retry
converges to the same end state rather than double-applying anything.
This matches bikes.html's own client version, which also has no
idempotency handling for this action -- not a new gap, a carried-forward
one, same as `returnDeposit`'s documented gap in the prior entry.

**Testing:** same fake-Drive Node harness (`/tmp/bikestest/` on the
sandbox, scratch, rebuild if picked up again), extended with a third test
file (`extend-and-pickup.test.js`). 38/38 green across 6 scenarios:
extendBike basic success (return date advances correctly, total price and
Contract total both bumped by the paid amount, paidBy overwritten,
timeConfirmed/confirmedReturnDate reset since the due date moved, ledger
note gets a new line and an updated running total, income row + cash row
written, "bikes" sheet monthly total bumped); validation (non-positive
days / negative amount / missing paidBy all rejected); idempotency (Test
3 -- the money-critical case: a retried extend does NOT double-charge);
two DIFFERENT clientTxnIds both apply independently (proves the guard
doesn't over-suppress genuinely separate extensions on the same booking);
updateReturnPickup basic success including the delivery-link mirror onto
the matching Contract row; updateReturnPickup with no delivery link given
(customer sheet updates, Contract left untouched).

**Not yet done, in order (unchanged from the prior entry's list, just 2
actions closer -- 6 of 7 now ported):**
1. Deliver via the workspace folder, push (zero risk, nothing live changed).
2. Port the last remaining action: the long-extension pair
   (`closeBikeForExtendFromJson` + `customerIntakeFromJson`) -- still has
   the open "clientTxnId across two sequential dependent writes" design
   question, now the ONLY remaining action with that shape.
3. Only once all 7 are ported and individually test-green: the frontend
   optimistic-UI + idempotency-submission layer in bikes.html itself, THEN
   its own Playwright-equivalent test batch. Still nothing user-visible
   changes before this step.

**Files changed this slice:** `lib/bikesWrites.js` (added
`mirrorDeliveryLinkToContract`, `performUpdateReturnPickup`,
`buildRentalIncomeTextB`, `appendMonthlyIncomeRowFromJson`,
`extendBikeRowFromJson`; updated `bikesWriteDispatch` to add
`'updateReturnPickup'` and `'extendBike'`; updated the factory's returned-
exports object; updated the file header STATUS comment), `api/bikes/write.js`
(updated the header STATUS comment only).

## 🔧 Phase 2, bikes.html write layer: RETURN FAMILY ('markReturned',
## 'earlyReturnBike', 'returnDeposit') PORTED AND TEST-GREEN, NOT YET
## DEPLOYED, NOT YET WIRED INTO THE FRONTEND (2026-08-17, later same day
## as the swapBike entry just below)

**What this is:** the second slice of the write-layer port -- 3 more of
bikes.html's 7 actions, added to the same `lib/bikesWrites.js` /
`api/bikes/write.js` from the swap entry below (no new files this time).
Grouped together deliberately rather than done as 3 separate slices:
bikes.html's own `confirmReturn()` always fires exactly ONE of
`markReturned`/`earlyReturnBike` (never both), then SEPARATELY fires
`returnDeposit` as a best-effort follow-up whenever a security deposit was
matched on the Return popup -- they're one user-facing flow (clicking
"Confirm" on a return) even though they're 2-3 separate backend calls.
**bikes.html's own frontend is still completely untouched** -- same as
the swap entry, these are additions to files nothing else references yet.

**What got ported, byte-for-byte from bikes.html's own copies:**
`performMarkReturned` (+ `flipMatchingContractStatus`), `earlyReturnBikeFromJson`
(+ `appendEarlyReturnRefundToLedgerFromJson`, `appendEarlyReturnRefundIncomeRowFromJson`,
`addRentalAmountToBikesSheetFromJson` -- the current-month sibling of
swap's month-parameterized version), and `returnDepositFromJson` (+
`setBikeSplitsNoteFromJsonB`, `appendCashExpenseRowFromJson`,
`writeDepositTransferIncomeRowFromJson`, `writeDepositTransferExpenseRowFromJson`,
`releaseDepositIntoBucketFromJson`, `payDepositOutOfBucketFromJson`, the
`DEPOSIT_CATEGORIES_B`/`DEPOSIT_CATEGORY_PAID_BY_B` constants, `todayIso`).
`earlyReturnBikeFromJson`'s write ORDER was preserved exactly as bikes.html
has it, not just its individual writes -- this matters: the Contract row's
return-date sync and total-price subtraction both only match a row whose
status is still "rented", so they run BEFORE the status flip to Returned
(the fix for a real bug Anton hit 21/07/2026, per bikes.html's own
comment -- see that file for the full story).

**Idempotency -- ported for 2 of the 3, deliberately NOT for the third:**
`markReturned` and `earlyReturnBike` both got the same `clientTxnId` guard
swap did (see the swap entry below for the mechanism) -- for these two the
marker tags the SAME row being modified rather than a new one, since
neither action creates a row. This mattered enough to test explicitly for
`earlyReturnBike` (Test 6 below): a refund is real money, so a retry must
not double-subtract it. `returnDeposit` did NOT get the same guard -- its
payload has no customer-row number in it at all (only a deposit-sheet row/
category), so the same technique doesn't directly apply, and retrofitting
a different mechanism felt like exactly the kind of "genuine design
question, not a mechanical copy" the original inventory entry already
flagged for the chained-call actions. Documented in the code (see
`returnDepositFromJson`'s own comment) and here rather than silently
shipped without protection -- bikes.html's own client version has the
identical gap today, so this is a known pre-existing risk carried
forward, not a new regression.

**Testing:** same fake-Drive Node harness as the swap entry (`/tmp/bikestest/`
on the sandbox, scratch, rebuild if picked up again), extended with a
second test file. 32/32 green across 9 scenarios: markReturned's basic
success + its idempotency guard (a replayed call doesn't re-touch the
return date); earlyReturnBike with a 0 refund (behaves exactly like a
plain return), with a genuine refund paid back by cash (booking total AND
Contract total both reduced, ledger note gets a refund line, a NEGATIVE
income row lands on the current month sheet, cash sheet also reduced),
refund-bigger-than-the-booking validation, and -- the money-critical one
-- idempotency (Test 6: the exact same refund request submitted twice
reduces the total price ONCE, not twice, and produces exactly one refund
income row and one cash entry, not two); returnDeposit clearing a matched
deposit entry, logging a deduction as income with its bike-split note and
"bikes" sheet bump, and a cross-method release+payout (deposit held under
one method, handed back via a different one -- confirms both the release-
income row and the payout-expense row land correctly, and that the
release side correctly does NOT touch the cash sheet when released via a
non-cash method).

**Not yet done, in order (unchanged from the swap entry's list, just 2
actions closer):**
1. Deliver via the workspace folder, push (zero risk, nothing live changed).
2. Port the remaining 3 actions: `updateReturnPickup` (small, standalone),
   then extend-short (`extendBikeRowFromJson`), then the long-extension
   pair (`closeBikeForExtendFromJson` + `customerIntakeFromJson` -- still
   the one with the open "clientTxnId across two sequential dependent
   writes" design question, now the ONLY remaining action with that
   shape).
3. Only once all 7 are ported and individually test-green: the frontend
   optimistic-UI + idempotency-submission layer in bikes.html itself, THEN
   its own Playwright-equivalent test batch. Still nothing user-visible
   changes before this step.

**Files changed:** `lib/bikesWrites.js`, `api/bikes/write.js` (both
extended, not new this time). `bikes.html` itself: still untouched.

---

## 🔧 Phase 2, bikes.html write layer: FIRST ACTION ('swapBike') PORTED AND
## TEST-GREEN, NOT YET DEPLOYED, NOT YET WIRED INTO THE FRONTEND (2026-08-17)

**What this is:** the first real slice of the write-layer port the
inventory entry just below this one mapped out. Per that entry's own
recommendation, started with `swapBike` -- the most self-contained of
bikes.html's 7 actions (a single request, no chained second call). New
files only: `lib/bikesWrites.js` (`createSheetIO` + `createBikesWrites(sheetIO)`,
mirroring `lib/accountsWrites.js`'s factory shape) and `api/bikes/write.js`
(single-dispatch endpoint, mirrors `api/accounts/write.js` almost
verbatim). **bikes.html's own client-side script is completely untouched**
-- these files are net-new and unreferenced by anything else, so the live
page's behavior hasn't changed at all yet. Wiring the frontend (optimistic
UI + idempotency submission) is explicitly a later step, only once every
action has its own tested backend port -- see the inventory entry's own
"do not wire ANY optimistic-UI changes until every action is ported" rule.

**What got ported:** `swapBikeFromJson` and its full call graph, byte-for-
byte from bikes.html's own client-side copy -- `appendLedgerEntryFromJson`,
`renameContractBikeOnSwapFromJson`, `syncContractReturnDateOnlyFromJson`,
`addAmountToContractRowFromJson`, `addRentalAmountToBikesSheetForMonthFromJson`,
`appendSwapUpgradeIncomeRowFromJson`, `appendCashSheetRowFromJson`,
`processDepositForPaymentFromJson`, `shortenLastLedgerLineForSwapFromJson`,
plus the whole recompute cascade (`recomputeCashSheetTotalsB`/
`recomputeMonthlySummaryCascadeB`, same formulas as `lib/accountsWrites.js`'s
copy, verified against the real workbook there already) and every small
utility (`decodeSheetDate`, `pad2Json`, `formatDmyJson`, `bikeNamesMatchForTaxLookup`,
etc.). SAME business rules, SAME edge cases, SAME warnings as the browser
version -- this was a mechanical port, not a redesign. `logTransactionB`
was ported as bikes.html's OWN simpler (non-queued) version rather than
accounts.html's promise-queue version -- confirmed swap never calls it
concurrently within one request, so accounts.html's later race-fix doesn't
apply here (see the file's own comment on this).

**The one genuinely NEW piece, not a mechanical copy -- an idempotency
guard for swap:** bikes.html's own client-side `swapBikeFromJson` has no
duplicate-submission protection at all (its own comment block says so
explicitly -- "no equivalent shared-lock cache exists across stateless
serverless function calls... low-risk enough to accept unported for now").
Since this whole rollout's end goal IS a frontend that can safely retry a
failed/uncertain save, added the guard now rather than porting-then-
immediately-needing-a-second-pass: an optional `clientTxnId` on the
request, checked via `findExistingSwapByTxnIdFromJson` (scans
`customer_notes` for a row already tagged with that clientTxnId in a
brand-new reserved column, `IDEMPOTENCY_NOTE_COL_B=3` -- doesn't collide
with the existing ledger-note column, `LEDGER_CONTACT_COL_B=2`) BEFORE any
validation or writes. A repeat request with the same clientTxnId short-
circuits straight to the already-saved result (`{success:true,
newRowNumber, idempotentReplay:true}`) instead of appending a second
customer row. Marked via `markSwapTxnIdFromJson` right after the core
write succeeds; if THAT specific write fails, it's surfaced as a warning
(not a thrown error, so it never makes a successful swap look failed) --
flagged honestly rather than silently swallowed, since a failed marker
write means a retry under the same clientTxnId could still create a
genuine duplicate.

**Testing:** no real browser available in this sandbox (same Playwright/
Chromium root-deps limitation as the read-cache pass) -- and this slice is
backend-only anyway (nothing wired into bikes.html's frontend yet, so
there's nothing to click-test). Built a fake-Drive Node harness instead
(`/tmp/bikestest/` on the sandbox -- scratch, gone between sessions,
rebuild if picked up again), testing `createBikesWrites(fakeSheetIO)`
directly against an in-memory fake at the `sheetIO` boundary (same
`fetchSheetWithMeta`/`writeSheetJson` shape `createSheetIO` produces from
real Drive) rather than mocking Google Drive/OAuth itself -- equivalent
coverage of the actual business logic, without needing the `googleapis`
package installed (it isn't, in this sandbox; a stub was used purely to
satisfy `lib/googleDrive.js`'s top-level `require('googleapis')`, never
exercised). 25/25 green across 5 scenarios: (1) a basic swap with no
upgrade -- old row closed out with the correct returnAmount/date/status,
new row appended with the redistributed amount and the ORIGINAL return
date carried forward, Contract row renamed, "bikes" sheet totals moved
between the old and new bike for the original rental's start month, new
row gets its own ledger note; (2) a swap WITH an upgrade charge paid by
cash -- upgrade income row + cash-sheet row both written with the correct
amount; (3) validation -- amounts that don't sum to the booking's current
total price are rejected with a clear error and nothing is written; (4)
idempotency -- the exact same `clientTxnId` submitted twice creates only
ONE new row, the second call flagged `idempotentReplay:true`; (5) two
DIFFERENT customers/clientTxnIds each get their own new row -- confirms
the guard keys strictly on clientTxnId, not on source row number or
similar-looking data, i.e. it doesn't over-suppress legitimate separate
swaps. (Test 3's validation check, run against an already-swapped row
during test authoring, incidentally also confirmed re-swapping a
just-closed row is correctly rejected -- caught a test-authoring bug, not
a product bug, but worth noting since it's exactly the kind of thing this
suite exists to catch.)

**Not yet done, in order:**
1. Deliver via the workspace folder, get Anton's go-ahead, push (this
   entry's files don't touch anything live, so this can happen anytime,
   no rush/no risk).
2. Port the remaining 6 actions the same way, one at a time, each with its
   own fake-Drive test batch, in roughly this order (per the inventory
   entry's suggested order, reassessed as each one turns out): return
   (`markReturned` + `earlyReturnBike` + the `returnDeposit` follow-up --
   these three are related enough to likely do as one slice), then
   `updateReturnPickup` (small, standalone), then extend-short
   (`extendBikeRowFromJson`), then the long-extension pair
   (`closeBikeForExtendFromJson` + `customerIntakeFromJson` -- the one
   with a genuine open design question flagged in the inventory entry:
   how does a clientTxnId apply across TWO sequential dependent writes).
3. Only once ALL 7 actions are ported and individually test-green: design
   and build the frontend optimistic-UI + idempotency-submission layer in
   bikes.html itself (mirroring accounts.html's `genClientTxnId`/
   `optItems`/`optInFlight`/`queueMonthSave`-equivalent pattern), wire it
   to `api/bikes/write.js`, and build the Playwright-equivalent frontend
   test batch for it. This is the step that actually changes what staff
   see when using bikes.html -- everything before it is invisible/inert.

**Files changed:** `lib/bikesWrites.js` (new), `api/bikes/write.js` (new).
`bikes.html` itself: untouched.

---

## 🚧 Phase 2, bikes.html write layer: INVENTORY/DESIGN DONE, NO CODE
## WRITTEN YET (2026-08-16, later same evening) -- read this before starting
## the actual port

**Status, plainly:** the read-side cache pass above finished clean, tested,
and is queued to push. Immediately after, started on bikes.html's write-
layer port (the optimistic + idempotency pattern, same as accounts.html
got) per Anton's go-ahead to work on it unattended overnight. Traced the
ENTIRE write surface (below) but deliberately did **not** start writing
`lib/bikesWrites.js` -- explaining why, since "why stop here" matters more
than usual on this one.

**Why no code got written tonight:** every write action on this page turns
out to touch several sheets in a chained, sometimes multi-step cascade
(ledger entry, monthly income row, cash sheet, bikes-sheet running total,
Contract-row sync, deposit-bucket release/pay, transaction log -- see the
action list below), with direct row/column cell math in places (e.g.
`returnDepositFromJson`'s deposit-clear step indexes into
`cat.dateCol`/`cat.amountCol`/`cat.nameCol` directly). This is a bigger,
more interdependent write surface than accounts.html's was, and
accounts.html's own port -- by Anton's own account -- took a full
dedicated session AND caught a real bug (the double-submit issue) only
because of the Playwright suite. Starting to port this business logic
into `lib/bikesWrites.js` without being able to finish AND fully test it
in the same sitting would leave a half-translated, unverified copy of
money-and-inventory logic sitting in the repo -- worse than not starting,
because a future session (or Anton) could mistake partially-ported code
for trustworthy. Per the standing rule above ("never deliver a half-
ported write layer") and CLAUDE.md's own file-integrity history on this
project, the safer stopping point was: fully map the surface, write
NOTHING into `lib/`, leave bikes.html's actual behavior 100% unchanged.

**The full write-action inventory (traced by reading the actual click
handlers, not guessed from function names):**

1. **`performMarkReturned(rowNumber, isoDate)`** -- normal return (the
   "Early return" box left unticked). Triggered from the `.confirm-return`
   click handler via `confirmReturn()`.
2. **`earlyReturnBikeFromJson(data)`** -- early return with refund
   (`.confirm-return` handler, `confirmReturn()`, when the Early Return box
   IS ticked -- refund can be 0, still routes through this action rather
   than #1). Full refund/ledger/Contract/bikes-sheet cascade -- see the
   function's own block comment.
3. **`returnDepositFromJson(data)`** -- fires as a SEPARATE best-effort
   follow-up call after #1 or #2 succeeds, only when a security deposit was
   matched on the return popup. Clears the matched deposit cell(s) and, if
   a deduction was entered, logs it as income. A failure here does NOT
   roll back the return that already succeeded (surfaces its own alert).
4. **`performUpdateReturnPickup(rowNumber, isoDate, hhmm, deliveryLink)`**
   -- the separate "edit pickup/return time" popup, independent of a full
   return.
5. **`extendBikeRowFromJson(data)`** -- SHORT extension (under 30 days,
   "long extension" box unticked): simple in-place update to the existing
   customer row. Triggered via `confirmExtend()`.
6. **`closeBikeForExtendFromJson(rowNumber)` THEN
   `customerIntakeFromJson(payload)`** -- LONG extension (30+ days, or the
   checkbox ticked): TWO sequential, dependent write calls, not one -- close
   out the old booking, then submit a brand-new customer row for the new
   period (reusing bikes.html's own local `customerIntakeFromJson`, NOT
   customers.html's or contract.html's -- three separate copies of similar
   logic across the app, confirmed by reading each file, not assumed).
   Also triggered via `confirmExtend()`, the other branch.
7. **`swapBikeFromJson(data)`** -- bike swap. Closes out the old customer
   row, opens a new one for the swapped bike, touches the bikes sheet.
   Triggered via `submitSwap()`. Cleanest/most self-contained of the set --
   candidate to port FIRST next session, same "smallest real slice first"
   approach as anything else this rollout has done.

**Internal helpers these 7 actions cascade through** (not separate UI-
triggered actions themselves, but each is real business logic that has to
be ported faithfully as part of whichever action(s) call it -- listed so
the next session doesn't have to re-discover them): `appendLedgerEntryFromJson`,
`appendMonthlyIncomeRowFromJson`, `appendCashSheetRowFromJson`,
`addRentalAmountToBikesSheetFromJson`, `addRentalAmountToBikesSheetForMonthFromJson`,
`processDepositForPaymentFromJson`, `addAmountToContractRowFromJson`,
`syncContractReturnDateOnlyFromJson`, `syncContractRowTotalsFromJson`,
`renameContractBikeOnSwapFromJson`, `appendSwapUpgradeIncomeRowFromJson`,
`appendEarlyReturnRefundToLedgerFromJson`, `appendEarlyReturnRefundIncomeRowFromJson`,
`appendCashExpenseRowFromJson`, `writeDepositTransferIncomeRowFromJson`,
`writeDepositTransferExpenseRowFromJson`, `releaseDepositIntoBucketFromJson`,
`payDepositOutOfBucketFromJson`, `logSecurityDepositFromJson`,
`findRentedContractRowForBackfillFromJson`, `flipMatchingContractStatus`,
`mirrorDeliveryLinkToContract`, `recomputeCashSheetTotalsB`,
`recomputeMonthlySummaryCascadeB`, `recomputeCurrentMonthSummaryCascadeB`.
That's the "13+" write-shaped-function count from the original rollout
plan's estimate -- it undercounted because it was a grep-based guess, not
a traced one; the real number of INTERNAL steps is closer to 25+, just
organized under 7 user-facing actions.

**Recommended approach for whoever (me or Anton) picks this up next:**
Port ONE action at a time, starting with `swapBikeFromJson` (#7,
self-contained, no chained second call) — not all 7 in one sitting. For
each: port its full call graph into `lib/bikesWrites.js` (mirroring
`createAccountsWrites(sheetIO)`'s factory pattern), add it to a new
`api/bikes/write.js` single-dispatch endpoint (mirror `api/accounts/write.js`
almost verbatim), write a fake-Drive test for JUST that action, confirm
green, THEN move to the next action. Do not wire ANY optimistic-UI/
idempotency frontend changes into bikes.html until every one of the 7
actions is ported and passing its backend test — a page that's "half
optimistic" (some buttons instant, others still blocking) is confusing
and error-prone for staff using it live. The two chained-call actions (#3
piggybacking on #1/#2, and #6's close-then-intake pair) need an explicit
decision on how idempotency keys apply to a two-request sequence -- flag
this as a genuine design question, not a mechanical copy, before starting
#6.

**Files touched this entry:** none (research/design only -- `bikes.html`
itself is untouched since the read-cache entry above; no new `lib/`or
`api/` files created).

---

## 🔧 Read-side stale-while-revalidate cache rolled out to 12 more pages,
## CODED AND TEST-GREEN, NOT YET DEPLOYED (2026-08-16, same day as accounts.html's)

**What this is:** step 1 of the "NEXT UP" plan directly below (still the
spec for HOW this was done — read that entry for the full pattern
writeup). Same accounts.html `loadMonth()` pattern (`readXCache`/
`writeXCache`/`clearXCache`/`timeAgoLabel`, instant render from
localStorage + background refresh + swap-in, cache preserved with a
"could not refresh" note on a failed background fetch, any successful
write on that page clears the relevant entry) ported mechanically to
every page with a real "load a chunk of data on open" moment.

**Pages done, one cache each unless noted:** `bikes.html` (loadData —
parts/customer snapshot, keyed `aaBikesDataCache`; 5 write-triggered
reloads now clear it first), `contract.html` (TWO caches — the
page-gating bike list `aaContractBikeNamesCache`, which used to block the
ENTIRE page behind a red "Loading bikes…" card on every single visit, and
the Search tab's `aaContractRowsCache`; both add/edit-contract success
paths clear the rows cache), `customers.html` (same two-cache shape as
contract.html — `aaCustomersBikeNamesCache` + `aaCustomersRowsCache`;
customerIntake success clears the rows cache), `deposits.html`
(`aaDepositsDataCache`; all three Add/Edit/Delete-deposit success paths
clear it), `add-bikes.html` (`aaAddBikesFleetListCache` for the lazily-
loaded "List all bikes" panel; Sell/Unsell/Edit-details all clear it),
`available-bikes.html` (`aaAvailableBikesDataCache` — no writes on this
page, pure quoting tool, so no invalidation call site), `bike-income.html`
(`aaBikeIncomeDataCache` — read-only report, no writes), `parts.html`
(`aaPartsDataCache` — a successful save already patches the in-memory row
directly via `Object.assign(currentRow, fields)`, so the cache is only
CLEARED on save, not refreshed from the save response, to keep the next
full page load honest), `oilchange.html` (`aaOilchangeDataCache` — no
writes, page comment literally says "This page has no write actions at
all"), `pricing.html` (`aaPricingRatesCache` — this page already had its
own from-scratch version of "instant + background refresh" via
`RATES_FALLBACK`, since it's an installable offline PWA; this just
upgrades the starting point from a hardcoded fallback table to the last
REAL live rates this device saw, which should track actual pricing much
more closely than the hardcoded fallback), `reply-assistant.html` (TWO
caches — `aaReplyAssistantCustomersCache` (cleared on a successful
addContact) and `aaReplyAssistantBikesCache` (no write touches bikes on
this page)), `bikephotos.html` (`aaBikephotosBikeNamesCache` for the
search autocomplete list only — the per-bike photo gallery hits a
different API, `/api/photos/list`, not the getXFromJson layer this
pattern is built on, and is naturally scoped to one bike at a time rather
than "load everything on open", so it was left untouched).

**Explicitly skipped, with reasons (matches this entry's own "skip if it
doesn't pay for itself" instruction below):**
- `calendar.html` — has real data loads (reminders, delivery/pickup
  links) but hits `fetch(scriptUrl...)` directly, a different/older data
  path than every other page's `getXFromJson()` → `fetchSheetJson()`
  layer this cache pattern is built on top of. Porting the cache here
  would mean designing against different plumbing, not a mechanical copy
  — flagging as a real follow-up decision rather than silently
  including or silently skipping.
- `settings.html` — admin/config page (AI keys, reset, logout), no
  sheet-backed list to cache.
- `bike-name-audit.html` — has real Parts/Customer data loads, but only
  behind an explicit "Run Audit" button, not on page open. The entire
  point of a click there is "run this fresh right now" — an instant
  stale render would work against that, not for it.

**Testing:** no real browser available in this sandbox (Playwright's
Chromium needs root-level system deps this environment doesn't grant --
confirmed via `sudo npx playwright install-deps` failing outright, not
just slow). Built a jsdom-based harness instead (loads the REAL modified
HTML file with `runScripts:'dangerously'`, stubs only the network-
touching `getXFromJson` functions, drives real `localStorage`, and reads
page-lexical `let`/`const` state — which doesn't attach to `window` the
way `var`/function declarations do — by injecting a same-realm `<script>`
tag rather than reading `window.x` directly; see `helpers.js`'s
`execInPage`/`readPageVar`). Same assertions per page as accounts.html's
own suite: cache-hit renders instantly before the real fetch resolves,
successful background refresh swaps in fresh data and rewrites the cache,
a FAILED background refresh leaves the cache up with a "could not
refresh" note instead of going blank, first-ever visit (no cache) behaves
exactly as before, and (where applicable) a successful write clears the
cache. 12 pages, 2-10 assertions each, all green. Sandbox scratch at
`/tmp/rc` on the sandbox VM, gone between sessions — rebuild if picked up
again. Every touched file also passed a plain `node -c`-equivalent syntax
check (`new Function(scriptBody)`) before the jsdom pass.

**Not yet done:** deliver via the workspace folder, get Anton's go-ahead,
push, then a real click-around per page (especially contract.html/
customers.html's page-gate, which used to hard-block on every visit) to
confirm the instant-render + swap-in look right in practice.

**Files changed:** `bikes.html`, `contract.html`, `customers.html`,
`deposits.html`, `add-bikes.html`, `available-bikes.html`,
`bike-income.html`, `parts.html`, `oilchange.html`, `pricing.html`,
`reply-assistant.html`, `bikephotos.html`.

---

## 🚀 NEXT UP (queued 2026-08-16) — STEP 1 (read cache) NOW DONE, see entry
## just above. STEP 2 (write-side optimistic/idempotent save) still not
## started: roll out accounts.html's two patterns to the rest of the app

**Anton's ask, verbatim intent:** accounts.html now has (a) a
stale-while-revalidate read cache and (b) instant/optimistic writes with
idempotency protection (both entries directly below this one — read those
two in full before starting, they're the actual spec, this entry is just
the punch list + rules for applying them elsewhere). He wants the SAME
treatment rolled out across the rest of the app, starting a fresh session/
login to do it (running low on usage on the session that built accounts.html),
working through it unattended while he's away -- **don't stop to ask him
questions, use judgment and keep moving, checkpoint safely as you go.**

**Read this first, set expectations correctly:** the read-side cache is
genuinely a same-shape, low-risk port -- do that across every data-loading
page in one sitting, it's the same ~80 lines of pattern each time. The
write-side change is NOT a small port -- it's the same scale of work
accounts.html's write layer took (a full dedicated session: a new
`lib/<page>Writes.js` server-side module ported action-by-action from that
page's existing client-side write logic, a new `api/<page>/write.js`
single-dispatch endpoint, the optimistic-UI layer, the idempotency-key
guard, AND a fake-Drive Node test suite + a Playwright frontend suite built
from scratch to prove it). **Confirmed by grep before queuing this:**
`api/data/[sheet].js` is still the ONLY generic write route -- every page
below still does the OLD "GET the whole array, mutate it in the browser,
POST the whole array back" pattern, same as accounts.html did before
2026-08-16. Rough per-page write-surface size (distinct add/edit/delete/
save-shaped functions in each page's own script, counted 2026-08-16 --
recount before trusting, pages may have moved on): contract.html 16,
bikes.html 13, deposits.html 10, add-bikes.html 8, customers.html 5.
bikes.html and contract.html are each comparably large to (or larger than)
what accounts.html's write layer was. Do NOT attempt all of these
simultaneously in one sweep -- do the read-cache pass everywhere first
(fast, low-risk, real value immediately), then take the write-side
migration ONE PAGE AT A TIME, each one fully designed, coded, tested, and
delivered (with its own PROGRESS.md entry, same depth as the two entries
below) before starting the next. If usage runs out mid-page, an
IN-PROGRESS page should still be left in whatever the last fully-tested,
fully-delivered state was -- never deliver a half-ported write layer.

**Suggested order** (biggest expected win / write-heaviest first, but
verify current file sizes and actually read each page before committing
to this -- it's a starting guess, not gospel):
1. Read-side cache -- ALL of: bikes.html, contract.html, customers.html,
   deposits.html, add-bikes.html, available-bikes.html, bike-income.html,
   parts.html, oilchange.html. Check calendar.html/pricing.html/
   settings.html/reply-assistant.html/bikephotos.html/bike-name-audit.html
   too, but skip any that turn out to be read-only/config/no real sheet
   load on open -- the pattern only pays for itself where there's an
   actual "load a chunk of data" step to make feel instant.
2. Write-side optimistic + idempotency, one at a time: bikes.html →
   contract.html → deposits.html → add-bikes.html → customers.html → the
   rest, reassessing priority after each one based on what's actually
   slow/error-prone in practice (grep production logs via the Vercel MCP
   connector if available, same as the original accounts.html perf pass
   did, rather than guessing).

**How to port the read-side cache (mechanical, same shape every time) --
see accounts.html's `loadMonth()` and everything from `MONTH_CACHE_PREFIX`
down to `timeAgoLabel()` for the reference implementation:**
- A localStorage cache keyed uniquely per page+whatever-scope-it-loads
  (accounts.html keys by month+year; another page might key by nothing at
  all if it loads one flat list, or by its own natural scope).
- The page's main load function renders the cached copy (if any) INSTANTLY
  before the real fetch, with a small non-blocking "Showing saved data
  from Xm ago — refreshing…" note, then still fires the real fetch exactly
  as before and swaps in the result + refreshes the cache when it lands.
- No cache yet (first-ever visit) = today's normal loading behavior,
  unchanged.
- A failed background refresh with a cache already showing leaves the
  cache up and says so, rather than blanking to an error screen.
- Any successful write on that page clears the relevant cache entry/
  entries immediately (see accountsWriteDispatch's and
  bulkSetExpenseTypeFromJson's `clearMonthCache` calls -- same reasoning:
  don't try to track exactly what a write touched, just drop what that
  write could plausibly have affected).
- Test with a Playwright harness in the same shape as
  `/tmp/optsave/test.js`'s Tests 12/12b/13/14 (sandbox scratch, gone
  between sessions -- rebuild it, don't go looking for the old one).

**How to port the write-side optimistic + idempotency pattern -- see
`lib/accountsWrites.js` (the `createAccountsWrites(sheetIO)` factory
pattern, ported action-by-action from that page's own existing write
functions -- SAME business rules, not a redesign), `api/accounts/write.js`
(the single-dispatch endpoint pattern), and accounts.html's whole
"Optimistic save UX" section (`genClientTxnId`, `optItems`/`optInFlight`/
`queueMonthSave`, `runPendingPayload`/`submitOptimistically`, the banner/
review-panel UI, `persistFailedSaves`/`restoreFailedSaves`) for the
reference implementation:**
- Port each of that page's write actions into a new `lib/<page>Writes.js`
  server module, byte-for-byte same business logic, called from a new
  `api/<page>/write.js` single-POST-dispatch route (mirror
  `api/accounts/write.js` almost verbatim -- it's not accounts-specific
  plumbing).
- Layer the optimistic UI + `clientTxnId` idempotency guard on top exactly
  as accounts.html has it, adapted to that page's own row/entity shape.
- Test BOTH sides: a fake-Drive Node harness (`createSheetIO`-shaped fake,
  see `/tmp/optsave/test-idempotency.js` for the pattern -- same
  "duplicate clientTxnId → one row, different ids → two rows, no id →
  unchanged old behavior" battery) AND a Playwright frontend harness (see
  `/tmp/optsave/test.js`'s Tests 2/7/11 for the add-fails-then-retries,
  no-double-submit, and clientTxnId-reuse patterns specifically).

**One real design decision this raises, not a mechanical copy -- decide
explicitly, don't silently guess:** `nav.js`'s failure badge currently
only reads `aaAccountsFailedSaves` and always links to accounts.html. Once
other pages can ALSO have their own failed-and-unretried saves, that badge
needs to either (a) become page-aware (a per-page localStorage key
convention, e.g. `aaFailedSaves_<page>`, with the badge summing counts
across all of them and linking to... whichever page has failures, or a
small dropdown if more than one does), or (b) get a documented reason it's
staying accounts-only. Don't leave it silently only covering accounts.html
once other pages have real failures it can't see -- that's a worse trap
than not having the badge at all, since it'll look like everything's fine.

**Standing rules that do NOT relax just because this is unattended:**
- Never `git commit`/`git push` yourself. Build, test, deliver via the
  device bridge (`SendUserFile` + `device_commit_files`), update this
  file, then hand Anton exact copy-paste git commands (including
  `rm -f .git/index.lock` first) and STOP. Same for every page, not just
  the first one.
- Test as rigorously as the two entries below did (both a backend and a
  frontend suite, real bugs caught before delivery, not just "looks
  right") -- this is live data for a real business, not a toy.
- Update this file with a full entry per page completed, same depth as
  the entries below -- the next session (or Anton reading this while
  deciding what to test) needs to be able to tell exactly what changed
  and why without reading the diff.
- "Without asking questions" means make the same kind of judgment calls
  the accounts.html work already made (and documented) when something's
  ambiguous -- not skipping the design thinking, just not blocking on
  Anton to make it for you. Flag genuinely open judgment calls in this
  file (like the nav.js badge one above) rather than silently picking
  one and hiding that a decision was made.

## 🔧 accounts.html: read-side stale-while-revalidate cache, CODED AND
## TEST-GREEN, NOT YET DEPLOYED (2026-08-16)

**What this is:** the read-side counterpart to the optimistic-save entry
just below. Anton: "the reads are reasonably quick... but could we somehow
save what's been read... keep a version of this and just periodically
update it." Reads here were never as slow as writes were, but every month
load (and every page visit, since this is a multi-page site and every
navigation tears down the whole script) still started from a blank
"Loading…" screen for however long the Drive round trip took. Now
accounts.html shows whatever was last successfully loaded for that month
INSTANTLY, then quietly refreshes in the background and swaps in the real
data the moment it lands -- classic stale-while-revalidate.

**Scope: accounts.html ONLY, piloting first**, same "prove it out on one
page before wider rollout" approach as the write-side change. Anton
specifically asked to start here and "go from there" -- other pages
(bikes.html etc.) would each need their own pass; this doesn't touch them.

**How it works:** `accountsJsonCache` (further up in this file) already
avoided a repeat Drive round trip when flipping between months WITHIN one
page load, but it's in-memory only -- gone the instant you navigate away
or reload. The new layer sits underneath `loadMonth()`, keyed to
localStorage (same mechanism the failed-save badge already uses, so it
survives a full reload/navigation): `readMonthCache`/`writeMonthCache`/
`clearMonthCache`, keyed `aaAccountsMonthCache_<year>_<monthIndex>`. On
entry, `loadMonth()` now checks this cache first -- if there's something
there, it renders it immediately (with a small "Showing saved data from
Xm ago — refreshing…" note instead of a blank screen) and THEN still fires
the real `getAccountsDataFromJson` fetch exactly as before; when that
resolves, the real data replaces what was showing and the cache is
refreshed with a new timestamp. A month with nothing cached yet (first
ever visit) behaves exactly as it always has -- normal "Loading…" state,
no stale flash of anything.

**Why this is safe on a shared, multi-person sheet:** these reads are
purely for display. Every actual save still reads fresh from Drive and
checks for a conflict at write time (`ConflictError`/`writeJsonFile`'s
`modifiedTime` check) -- a save is never based on what this cache happens
to be holding client-side, it's based on whatever's actually on Drive at
the moment of the write. Worst case is seeing numbers that are a few
minutes out of date for a second or two before the background refresh
catches up. The one pre-existing edge case this makes marginally more
likely, not new: opening what turns out to be a stale-looking row for
Edit/Delete right as someone else finishes changing it elsewhere --
already surfaces as the existing "this record was changed by someone else"
conflict error at save time, same as it always has.

**Refresh failure handling:** if the background refresh itself fails
(offline, Drive hiccup, etc.) while a cached view is already showing, the
cache stays up rather than being blown away -- the status line instead
says "Could not refresh (<error>) — showing saved data from Xm ago." A
stale-but-real number beats a blank error screen. (If there's NO cache and
the real fetch fails, behavior is unchanged from before -- the normal
error message.)

**Invalidation (so a write never leaves stale post-write data sitting in
the cache):** rather than track exactly which write touched which month
(the exact same call accountsJsonCache's own blanket-clear made, see
accountsWriteDispatch's comment), any successful accounts write just drops
that month's cache entry outright. Wired into both live write paths:
`accountsWriteDispatch` (covers add/edit/delete expense/income and
transferToBank -- the main server-side write route) and
`bulkSetExpenseTypeFromJson` (the bulk type-recolor buttons, which stayed
on their own older direct-write path and don't go through
accountsWriteDispatch). Next time that month is opened, it's guaranteed to
do a real fetch rather than risk showing pre-write data as if it were
current.

**Known remaining gap, deliberately out of scope:** a write from a
DIFFERENT device/tab/person doesn't proactively clear THIS device's
cached copy of that month -- there's no push/realtime channel here, so
this device only finds out on its own next load. Same class of staleness
window as everything else in this entry, just from someone else's write
instead of a background refresh in progress; not expected to matter for a
small in-person team, flagging it in case it ever does.

**Testing:** extended the same Playwright suite as the write-side entry
(`/tmp/optsave/test.js`), now 57/57 green (52 prior + 5 new): a normal
load seeds the cache; reloading the page shows the cached data instantly,
then swaps to the real data once the (deliberately slowed, for the test)
background fetch resolves, with the status note present while refreshing
and gone once settled; a failed background refresh leaves the cached view
up with a "could not refresh" note instead of going blank; a
never-before-loaded month shows the normal loading state with no stale
flash; a successful save clears that month's cache entry (this one had to
restore the REAL `accountsWriteDispatch` via a stashed reference and fake
the network underneath it with `page.route()`, since the invalidation
logic lives inside that function's own body and every other test
deliberately mocks over it).

**Not yet done:** deliver via the device bridge, get Anton's go-ahead to
push, then a real click-around (including a slow/offline refresh) to
confirm the "showing saved data" note and the swap-in both look right in
practice before calling this settled. If it proves out, next candidates
for the same treatment would be whichever other pages feel slow to open --
bikes.html was mentioned in passing during this discussion.

**Files changed:** `accounts.html` only.

---

## 🔧 accounts.html: optimistic save UX (instant + background) + a
## cross-page failure badge, CODED AND TEST-GREEN, NOT YET DEPLOYED
## (2026-08-16)

**What this is:** a different kind of speed fix than everything below. The
write-parallelization + region work already got a single save down from
~16-20s to roughly 3-8s, but that's still "sit and watch a spinner" time,
because Save blocked the whole page (`setAllButtonsDisabled(true)`) until
the full Drive round trip finished. Anton asked for the save itself to
feel instant -- update the screen right away, hold it as "pending", save
to Drive in the background, and surface a clear way to notice/fix it if a
background save ever actually fails. Explicitly NOT a database migration
-- Anton considered that (see the DB options doc delivered this session)
and decided to stay on Drive; this is a frontend-only UX change layered on
top of the existing (unmodified) Drive write layer.

**Scope: accounts.html ONLY**, confirmed explicitly with Anton before
starting. bikes.html/contract.html/deposits.html/etc. are untouched and
still block-and-wait exactly as before -- if this pattern proves out,
extending it to other pages is future work, each needing its own pass
(they don't share accounts.html's save plumbing). Within accounts.html,
`transferToBank` and the bulk expense-type-change buttons are also
untouched -- different shape, not what was flagged slow, same scoping
decision every prior pass in this file made.

**What changed, all in `accounts.html` (no backend/Drive code touched):**
Add/Edit/Delete Expense/Income now apply to the on-page list and close the
modal INSTANTLY, using the data just typed in (not the server's response),
then save to Drive in the background. Rows in flight show a dashed
border + small spinner ("Saving…"/"Deleting…"); the page stays fully
interactive, nothing is disabled. On success the row quietly settles to
normal. On failure it stays visible, flagged red ("Didn't save — tap to
review"), and a sticky banner appears at the top of the page (independent
of whichever month is currently on screen) with a review panel offering
Retry (resubmits the exact same payload) or Discard per item.

**Design decisions worth a future session knowing about:**
- A brand-new Add has no real row number until the server responds, so it
  gets a placeholder (`row: -1000000 - n`) that can never collide with a
  real sheet row; reconciled to the real `res.row` on success.
- Two saves fired close together (now possible since Save no longer blocks
  the page) are serialized per-month via a small promise-chain queue
  (`queueMonthSave`) before they ever reach `accountsWriteDispatch` --
  otherwise two concurrent read-modify-writes against the same Drive file
  could race, the same class of bug the `logTransactionB` queue fixed
  within a single save (see the parallelization entry below). Saves to
  different months are never serialized against each other.
- `needsDisambiguation` (the rare "which 'cash' row is this?" case, only
  possible on edit/delete) genuinely can't be resolved in the background --
  it needs a person to pick. Handled by reverting the optimistic change
  and falling back to exactly the existing blocking picker flow, rather
  than guessing which entries will hit it ahead of time.
- Discard is action-aware, not a blanket "remove the row": discarding a
  failed ADD removes the placeholder (it was never real), but discarding a
  failed EDIT or DELETE restores/un-marks the row instead of deleting it,
  since that row's real data is still sitting on Drive untouched. **This
  was a genuine bug caught by testing, not designed correctly the first
  time** -- the first version of `discardOptItem` always deleted the row
  regardless of action, which would have silently hidden a still-real row
  after a failed edit or delete. Fixed, and now covered by dedicated tests
  (5 and 6 below) so it can't silently regress.
**UPDATE (later the same day) -- real-world test caught a genuine
double-submit bug, since fixed:** Anton deployed nothing yet, but ran the
first version against a real deployed build (`staff-app-six-phi.vercel.app`),
actually turned his wifi off mid-save to test the failure path for real.
The banner correctly appeared ("failed to add"). He clicked Retry; it
wasn't obviously visible that anything had started, so he clicked Retry
again -- and once wifi came back, BOTH attempts went through, creating a
duplicate row. Root cause: `queueMonthSave`'s serialization only stops two
writes from racing each other on the wire -- it does nothing to stop a
SECOND retry from being queued at all while a first one is still
outstanding; both eventually ran, both eventually succeeded, both wrote a
row. Fixed with a new `optInFlight` Set that `submitOptimistically()`
checks and holds for the full duration of a submission (including time
spent waiting in the per-month queue, not just the network call) --
`retryOptItem()` is now a no-op if the same optId is already mid-submission,
so a second trigger (double click, or anything else that might call it
again) can never queue a duplicate attempt. Covered by a new test (7,
below) that calls `retryOptItem()` twice back-to-back and asserts only one
extra network call happens. NOTE: this closes the double-submission path,
but there's a harder, separate problem this does NOT fully solve -- if a
save actually succeeds server-side but the client's connection drops
before the response arrives, the client will still believe it failed and
a subsequent retry would create a real duplicate. Fixing THAT would need
an idempotency key generated client-side and checked server-side before
writing, which is a backend change -- out of scope for this "frontend UX,
accounts.html only" pass. Flagging it here in case duplicates keep
happening even after this fix; that's the tell it's this deeper issue
rather than the one just fixed.

**Also considered, then explicitly dropped by Anton:** automatic
background retry (checking failed saves every 30s and retrying them
without a person having to tap anything). Built once, then removed at
Anton's request ("don't worry about the auto retry, just stick with
manual") -- not in the delivered code. If this comes up again later, the
`optInFlight` guard already in place is exactly what would make auto-retry
and manual retry safe to coexist (whichever fires first wins, the other
is a no-op) -- see the git history around this entry if picking that back
up.

**Also added -- a cross-page failure indicator, since accounts.html's own
banner only helps while you're actually on that page:** this is a
multi-page site, not a single-page app, so navigating to bikes.html/
contract.html/etc. tears down accounts.html's whole script (and its
in-memory failure list) the moment you leave. Failed (not pending, not
warning) saves are now mirrored into `localStorage` under
`aaAccountsFailedSaves` (`persistFailedSaves()`/`restoreFailedSaves()` in
accounts.html) every time the in-page list changes. `nav.js` -- the shared
header included on every page -- reads that same key on load and shows a
small red pill in the top bar ("⚠ N") linking back to accounts.html when
there's anything unresolved; absent otherwise. accounts.html itself also
reads it back in on its own load, so a failure now survives a reload of
accounts.html, not just navigation elsewhere (retry still works even
though the specific row's pending/failed visual can't be reconstructed
after a reload -- currentExpenses/currentIncome are freshly loaded from
the server at that point and have no memory of a never-saved local entry;
`retryOptItem` already guards on `if (entry)` so this degrades gracefully,
it just resubmits without a matching row to flag). Real limitation worth
knowing: the badge is only read once per page load -- it won't live-update
if you're sitting on a different page while a failure happens elsewhere
(there's nothing "elsewhere" to cause that in a single-tab workflow, but
worth knowing if this app ever gets used multi-tab).

**Deliberately still NOT persisted:** anything currently in flight
(mid-save or mid-retry) -- only settled failures are saved to
`localStorage`. Closing the tab mid-save still loses tracking of that one
specific attempt; there's no durable queue for in-flight state, same
limitation as the first version of this entry, just narrowed now that
failures themselves do survive.

**Testing:** pure frontend change (no Drive/backend code touched), so the
fake-Drive harness pattern used for the write-parallelization pass doesn't
apply here -- instead built a Playwright-driven test harness
(`/tmp/optsave/test.js` on the sandbox, plus `/tmp/optsave/nav-test-host.html`
for the badge -- both local scratch, recreate if picked up again) that
serves the real modified `accounts.html`/`nav.js` over a local HTTP server,
drives it through actual clicks/field-fills (not calling internal functions
directly except where that's the more faithful way to set up a scenario or
to test a guard robustly regardless of UI timing -- see Test 7), and
monkey-patches only the two network-touching functions
(`accountsWriteDispatch`, `getAccountsDataFromJson`) to script
success/failure/disambiguation responses with an artificial delay, so
timing assertions are meaningful. 41/41 green across 10 scenarios (the
original 6 -- see below -- plus): retrying the same item twice before the
first attempt resolves submits exactly once, not twice (pins the real bug
above); a failed save writes to `localStorage` and clears once resolved;
reloading accounts.html mid-failure brings the banner/review panel/working
Retry back with no user action; nav.js's badge shows the right count and
is absent when there's nothing to review. Original 6: add succeeds
(instant pending row, page stays interactive, clean settle, reconciled to
the real row number); add fails then a Retry succeeds (banner appears/
clears correctly); edit hits `needsDisambiguation` (reverts to the original
value, the REAL picker UI reopens -- not a fake stand-in -- candidate
choice resubmits correctly with `cashRowChoice`); two same-month saves
fired back-to-back never overlap on the wire (proves the serialization
queue); failed-edit Discard restores the original value without deleting
the row; failed-delete Discard un-marks the row without removing it.

**UPDATE 2 (same day, after the double-submit fix above was live) -- the
deeper "client failed but server actually succeeded" risk flagged above
just happened for real, fixed:** Anton tested the offline path again on
the deployed build. Wifi dropped mid-save on an income entry ("twse",
฿5,135,131,515.00), the client showed "Failed to fetch" same as before --
but the row had actually already been written to Drive (visible in the
list with real data). He hit Retry once wifi was back; the retry
succeeded too, and this time it WAS a real second "twse" row on Drive (the
`optInFlight` fix from UPDATE 1 only prevents the same click firing twice
client-side -- it can't know the server already finished a request the
client itself gave up on). Screenshots confirmed both rows genuinely exist
side by side.

Fixed with an actual idempotency key, exactly as flagged as the remaining
risk in UPDATE 1: `accounts.html` now generates one random id
(`genClientTxnId()` -- `crypto.randomUUID()` with a fallback) per logical
ADD, at the moment the user hits Save, and keeps it on the retained
payload object for the rest of that attempt's life -- every retry reuses
the SAME id, and it survives a page reload too since it's part of what
`persistFailedSaves()` already writes to `localStorage`. Edits/deletes
don't get one -- an edit retried twice just reapplies the same field
values (already harmless), and a delete-of-an-already-deleted-row is a
separate, much lower-frequency risk not addressed here.

Server-side, `lib/accountsWrites.js`'s `addExpenseRowFromJson`/
`addIncomeRowFromJson` now check the `<monthName>_notes` sidecar (the same
file already used for bike-splits/expense-type notes, `[row, col, note]`
shape, new reserved col 900/901 so it can't collide with anything real)
for that id BEFORE creating a row. If it's already there, this is a replay
of an add that already landed -- skip the write entirely, return the
original row as a success (`duplicate: true`, purely informational, the
client treats it like any other success). If not, proceed exactly as
before, and record the id as part of the SAME notes-sidecar write the add
already does for bike-splits/type notes (no extra round trip on the normal
path -- only the pre-check read is new). Fully backward compatible: a
request with no `clientTxnId` is a complete no-op through this whole path,
identical to pre-fix behavior.

**Testing (this update):** two suites, since this update touches both the
frontend (accounts.html) and, for the first time in this whole entry, the
backend (`lib/accountsWrites.js`).
- Backend: a new fake-Drive Node harness (`/tmp/optsave/test-idempotency.js`
  on the sandbox, local scratch -- recreate if picked up again), using
  `createAccountsWrites(sheetIO)` with an in-memory `sheetIO` (no real Drive
  credentials needed). 19/19 green: the exact reported bug (same
  `clientTxnId` submitted twice) now produces only ONE real row both for
  addIncome and addExpense, with the second call reporting
  `duplicate: true` and the same row number; two calls with genuinely
  different ids still both write for real (not over-eagerly deduping
  legitimate repeat entries, e.g. two separate "Bolt" rides); a call with
  no id at all behaves exactly as it did before this fix (backward compat);
  an edit retried twice is untouched/unaffected.
- Frontend: extended the existing Playwright suite (`/tmp/optsave/test.js`)
  with Test 11 -- an add's `clientTxnId` is generated once and the exact
  same value is sent again on retry; a separate add gets its own distinct
  id; an edit payload carries no `clientTxnId` at all. 45/45 green
  (41 original + 4 new), confirming this change didn't regress anything
  from UPDATE 1.

**Known remaining gap, deliberately out of scope:** the pre-check read and
the marker-write happen in two separate round trips (read-before-write,
then write-as-part-of-the-existing-notes-lane-after). If a retry's
pre-check read landed in the tiny window between the original request's
row write and its notes lane finishing, it could still theoretically slip
through. In practice this window is milliseconds and a manual Retry click
happens seconds-to-minutes later, so this is not expected to matter, but
worth knowing if a duplicate somehow still occurs.

**Not yet done:** deliver via the device bridge, get Anton's go-ahead to
push, then a real test click or two (including deliberately going offline
mid-save again, and confirming a genuine "twse"-style retry-after-drop no
longer duplicates) before calling this fully settled.

**Files changed:** `accounts.html`, `nav.js`, `lib/accountsWrites.js`.

---

## ❌ TESTED AND SETTLED — Vercel function region: `iad1` (Washington D.C.)
## is the fastest of everything tried, despite being the farthest from
## Thailand -- do not retry region-switching without new evidence (2026-08-16)

**What happened:** after the parallelization pass below shipped, Anton
asked whether region also affects speed, since he's in Thailand. Reasoning
at the time: Vercel's edge network already receives his requests in
Singapore, then forwards them to `iad1` for the function to actually run
(confirmed in a real production log -- "Received in Singapore (sin1)" then
"Routed to Washington, D.C., USA (iad1)") -- eliminating that forward-hop
looked like a clear, free win, and `sin1` is Vercel's closest region to
Thailand. Shipped a one-line `vercel.json` (`{"regions": ["sin1"]}`, commit
`872fe95`) and asked Anton to test with a real "add expense" click.

**Result: measurably worse, not better.** Fresh production log, same
`console.log` instrumentation from the parallelization pass: total function
execution went from ~11.5s (`iad1`, previous test) to ~18.9s (`sin1`) --
roughly 1.5-2x slower, and consistently so across EVERY individually-timed
step, not just one outlier call: read month sheet 455ms → 1777ms, write row
1832ms → 2569ms, the cash lane 4143ms → 7227ms, the cascade lane 3717ms →
7088ms. That consistency across 8 independent measurements, all in the same
direction and similar magnitude, ruled out random noise.

**Follow-up: built a lightweight diagnostic tool to test more candidates
without needing a real click each time.** Real business-logic tests
(add-expense through the whole write layer) are expensive to iterate on --
each one needs Anton to click through the UI and pull fresh logs. Added a
TEMPORARY, unauthenticated route (`api/diag/ping.js`, deliberately bypassing
`withDrive`/OAuth so it needs no session cookie) that pings a real, public
Google endpoint (the Drive v3 discovery doc) 3 times and reports the
timings plus `process.env.VERCEL_REGION`. This let region swaps be tested
by just re-fetching one URL instead of a full add-expense-and-pull-logs
cycle. (Note: Claude's own sandboxed shell couldn't reach the deployment
directly -- `curl` failed with `blocked-by-allowlist` from the sandbox's
egress proxy -- but the generic `web_fetch` tool worked once given a
cache-busting query param, since it otherwise de-duplicated repeat fetches
of the same URL for up to an hour.)

**Tested 3 regions total, `iad1` won by a wide margin:**
- `iad1` (Washington D.C.): 170ms, 47ms, 66ms -- avg ~94ms
- `hkg1` (Hong Kong -- closest major hub to Thailand): 343ms, 216ms, 258ms
  -- avg ~272ms, ~2.9x worse
- `hnd1` (Tokyo -- huge Google infrastructure presence): 302ms, 197ms,
  197ms -- avg ~232ms, ~2.5x worse

**Important nuance this diagnostic tool surfaced:** `iad1`'s raw ping to
Google's API front door is only ~94ms average -- nowhere near the 800ms-1.8s
per call seen in the REAL business-logic logs (the read/write/cascade
steps in the entry below). That gap means most of the real slowness isn't
network distance at all -- it's Google Drive's own per-operation cost
(file lookup, permission checks, actual read/write to storage), which
doesn't meaningfully change by region. Region selection still matters (a
~2.5-2.9x difference between the best and worst tested is real and
worth avoiding), but it was never going to be the dominant lever -- the
parallelization work below remains the bigger win, and the diagnostic
`iad1` number is a reasonable proxy for "network path is fine, the
remaining cost lives inside Drive's own API."

**The fix:** settled on `iad1` -- `vercel.json` explicitly sets
`{"regions": ["iad1"]}` (matches the platform default, kept explicit so a
future session doesn't wonder whether the region was ever considered).
`api/diag/ping.js` removed (`git rm`) once testing was done -- it was
temporary and existed purely to make region comparisons cheap; keeping it
would cost a permanent slot against the Hobby plan's 12-function cap for
zero ongoing value. If a future session wants to explore other regions
(there are 20 total -- see Vercel's region list), the diagnostic-ping
approach here is reusable: re-add a similar unauthenticated route, swap
`vercel.json`, re-fetch. Candidates not yet tried: `bom1` (Mumbai), `icn1`
(Seoul), `syd1` (Sydney), `dxb1` (Dubai) -- no strong reason to expect any
of these beat `iad1` given the pattern so far (every region physically
closer to Thailand has been WORSE, not better), so this isn't a high
priority to revisit without a specific reason.

**Files changed:** `vercel.json` (net: present, set to `iad1` explicitly);
`api/diag/ping.js` added then removed (net: no file).

## ✅ CORRECTION (2026-08-16, later the same day): the entry directly below
## was left saying "NOT YET DEPLOYED" after it actually shipped -- fixing
## that here rather than leaving stale docs in the file. A later session
## picked this project back up with a handoff summary claiming this work
## was done/deployed/confirmed-live, which contradicted this entry's own
## "not yet done: deploy" closing line. Checked git directly to settle it:
## commit `c55ae13` ("Parallelize accounts.html write layer's independent
## Drive calls; fix a transactionLog race the parallelization introduced")
## is committed and pushed, `git status` clean, and it sits BEFORE all four
## region-testing commits in the entry above -- meaning it was live before
## region testing even started (that entry's own reference to reusing
## "the console.log instrumentation from the parallelization pass" only
## makes sense if this had already shipped). So: this DID deploy, the
## "Not yet done" paragraph below is stale and should be read as historical
## only. Real lesson for future sessions: update this file's status line
## the moment something deploys, in the same commit, exactly as the rule at
## the top of this file says -- this entry is the counterexample of what
## happens when that slips.

## 🔧 accounts.html write parallelization: coded, tested
## GREEN against a fake-Drive harness, DEPLOYED (2026-08-16 -- see
## correction above; original entry text below is otherwise unchanged)

**Status: mid-task, picking up here.** Before touching code, re-verified
the working copy on Anton's Mac against `origin/main` (given this
project's documented history of files silently reverting) -- `git status`
showed only an uncommitted `PROGRESS.md`, and a direct hash comparison of
`lib/accountsWrites.js`/`api/accounts/write.js`/`accounts.html` against
their `origin/main` blobs came back byte-identical. Clean start, no drift.

**What was built, per the plan approved at the end of the previous
session** (see the untouched paragraphs below this one for the original
root-cause analysis): `lib/accountsWrites.js`'s six write functions
(`addExpenseRowFromJson`, `addIncomeRowFromJson`, `editExpenseRowFromJson`,
`editIncomeRowFromJson`, `deleteExpenseRowFromJson`,
`deleteIncomeRowFromJson`) were each restructured from a long chain of
sequential `await`s into: solitary initial read(s) → solitary primary row
write (unchanged failure semantics -- still aborts the whole request if it
fails, still runs before any best-effort side effect) → one `Promise.all`
batch of independent lanes (notes sidecar / cash sheet / bikes sheet /
"touch the month sheet again" for deposit-total and expense-type-total,
whichever apply) → a second `Promise.all` pairing the summary cascade with
the transaction-log write. Each lane keeps its own existing try/catch
exactly as before (same warning messages, same best-effort semantics), so
none of the `Promise.all` calls can reject on their own -- only a genuine
hard failure in the solitary row write still aborts the request.
`editExpense`/`editIncome`/`deleteExpense`/`deleteIncome` also got a small
bonus win: their two initial reads (the month-sheet row and the
`<month>_notes` sidecar) don't depend on each other and are now batched too.
`transferToBankFromJson` and `bulkSetExpenseTypeFromJson` were deliberately
left untouched (short/different shape, not what was flagged slow). Every
function also got `Date.now()`-based timing instrumentation
(`console.log('[accountsWrites] <label>: <ms>ms')` around each phase and a
`TOTAL` at the end) since Vercel's log tool has no per-request duration
breakdown -- the next real test click will show actual per-wave numbers.

**A real correctness bug was found and fixed by the test suite below, not
guessed at:** `logTransactionB`'s retry-on-`ConflictError` loop only
protects against a race where `transactionLog.json` already EXISTS --
`writeJsonFile`'s conflict check is skipped entirely when the file doesn't
exist yet (no `modifiedTime` to compare against). Once several lanes could
call `logTransactionB` concurrently in the same request (e.g. a cash
append's own internal log call racing the top-level log call), if
`transactionLog.json` happened not to exist yet at all, two concurrent
"doesn't exist, I'll create it" callers could both create it -- Drive
allows duplicate filenames in the same folder -- silently orphaning one
entry in a duplicate file no later read would ever see again. This could
never happen in the old sequential code (only ever one `logTransactionB` in
flight at a time). Fixed with a small in-request promise queue
(`logQueue`) that every `logTransactionB` call chains onto, serializing
just the log read-modify-write across all lanes without blocking any
lane's other, unrelated work -- safe to scope per-request since
`createAccountsWrites` is instantiated fresh per request already (see
`api/accounts/write.js`). In production this specific race is unlikely to
ever fire (`transactionLog.json` has existed since this feature's original
15/08/2026 launch), but it's a real gap this pass introduced and is now
closed rather than left as a known risk.

**Testing (fake-Drive, differential against the git-committed pre-change
version, not just eyeballed):** built a fresh harness (`/tmp/accountstest3/`
on the sandbox -- local scratch, not part of the delivered project,
recreate if picked up again) rather than reusing the described-but-ephemeral
`/tmp/accountstest2/` from the prior session (never existed in this
session's environment). Rather than hand-computing expected sums for a
made-up fixture, took the git-committed pre-change `lib/accountsWrites.js`
(`git show HEAD:...`, commit `1527511`) as the OLD/sequential baseline, ran
BOTH the OLD and NEW code through IDENTICAL fixtures (a from-scratch but
internally-consistent fake month sheet/notes sidecar/cash sheet/bikes
sheet, built to satisfy every label/column lookup the real code performs,
self-healing row search included), and asserted the FINAL Drive file state
and response payload are byte-identical between the two -- so correctness
is checked against the actual old behavior, not a hand-derived guess. 8
scenarios covering all 6 restructured functions and every lane
(`addExpense` cash+personal+bikeSplit, `addExpense` wise+business,
`addIncome` cash+bikeSplit, `addIncome` wise+paidFromDeposit -- exercising
the two-same-file-writes-in-one-lane case, `editExpense`
cash→wise/business→personal, `editIncome` wise→cash, `deleteExpense`
cash+wages+bikeSplit, `deleteIncome` wise+bikeSplit), each diffed with
`transactionLog` entries' volatile `id`/`ts` fields masked and sorted
(since concurrent log-append order isn't -- and was never meant to be --
guaranteed). This is what caught the `logTransactionB` race above
(`editIncome wise→cash` failed the diff before the fix, matched after).
Also added: a same-file-overlap guard (records every read/write's wall-clock
start/end keyed by `folderId::filename`, asserts no two writes to the same
key ever overlap -- green); a real-concurrency timing proof (80ms artificial
delay on the notes/cash/bikes files, real `setTimeout`-based, run through
both OLD and NEW -- OLD took ~590ms, genuinely sequential; NEW took
~260ms, well under 60% of OLD's time, with the three delayed lanes'
reads starting within 0-1ms of each other, proving they actually ran
concurrently and not just "looks parallel in the code"). Regression-proofed
the `logTransactionB` fix specifically: reverted just the queue, re-ran,
confirmed the EXACT same scenario (`editIncome wise→cash`) failed and
nothing else did, restored, confirmed 20/20 green again. Final tested file
hash-verified identical to what's about to be delivered.

**Not yet done:** deploy, then ask Anton for one more real "add expense"
click, then pull fresh Vercel production logs -- this time the new
`console.log` instrumentation should show real per-wave timings (not just
total request time) to confirm the actual measured improvement, the way
every prior perf pass in this file was verified against real production
logs rather than fake-Drive timing alone.

**Files changed:** `lib/accountsWrites.js` only.

---

**Original root-cause writeup this pass was scoped from (2026-08-16,
kept for reference):** The entry directly below this one ("ARCHITECTURE
CHANGE... every add/edit/delete/transfer is now ONE browser round trip")
shipped and deployed (commit `1527511`, confirmed live). Anton tested it
for real right after deploy and reported it was STILL ~16 seconds to add
an expense -- so the architecture move alone did not fix the perceived
slowness, even though it worked correctly.

**What was checked (Vercel MCP connector, `get_runtime_errors` +
`get_runtime_logs`, projectId `prj_Af5KhlICFm0SIQKIYKvlyefQZ7Sj`, teamId
`team_o7QzdS7AYzDGLMCvQdObHMlC`):** pulled fresh production logs for
Anton's two real test saves (05:31:29 and 05:32:01 UTC, 2026-08-16).
Confirmed good news first: zero errors on `/api/accounts/write` (the one
unrelated pre-existing warning, `url.parse()` deprecation on
`/api/data/[sheet]`, is untouched by this work), and the browser really is
only making ONE request per save now -- the architecture fix itself is
correct and live.

**Root cause of the continued slowness:** the ~9-13 Drive read/write calls
that used to be spread across separate browser round trips are now all
happening inside that ONE server request -- but STILL sequentially, one
`await`ed after another, inside `lib/accountsWrites.js`. Evidence: in both
observed saves, the gap between the `POST /api/accounts/write` log line and
the immediate follow-up `GET /api/data/August` + `GET /api/data/August_notes`
(the client's `refreshSummaryAfterSave` call, fired right after the save
response comes back) was a consistent ~14 seconds both times -- strongly
implicating the POST itself as the slow part, not client-side think time.
Manually counting Drive calls for one plain "add cash expense" through
`addExpenseRowFromJson` (even on a WARM session with every folder/file id
already cached) comes to roughly 13 sequential Drive API calls: read+write
month sheet (x2, once for the row write, once again inside the summary
cascade), read+write notes sidecar, read+write cash sheet, one more cash
write inside the cascade recompute, read+write transactionLog (x2, since
`logTransactionB` now runs twice per cash expense -- once from
`appendCashExpenseRowFromJson`'s own internal log call, once as the
top-level entry -- and is now `await`ed both times instead of
fire-and-forget). None of that changed the CORRECTNESS of the port (the
call count math matches what was already documented/tested in the entry
below) -- it just means the "9 separate trips" problem was moved inside one
request rather than actually reduced, and several of those calls are
genuinely independent of each other (e.g. reading the month sheet, its
notes sidecar, and the cash sheet don't depend on each other's results) but
the ported code still runs them one at a time, exactly as it did in the
browser version, because that's what a byte-for-byte port preserves.

**Fix approved by Anton, NOT YET STARTED:** (1) add lightweight timing
instrumentation (e.g. wrap `sheetIO.fetchSheetWithMeta`/`writeSheetJson`
calls, or bracket each major step with `console.time`/`console.timeEnd`, or
Date.now() diffs logged via `console.log`) so the NEXT test click gives real
per-step numbers instead of the estimate above -- Vercel's runtime-log tool
has no built-in per-request duration breakdown, only start/status/path per
line, so this is the only way to get real data. (2) Parallelize the
genuinely-independent Drive reads/writes inside `lib/accountsWrites.js`'s
write functions (`addExpenseRowFromJson`/`addIncomeRowFromJson`/
`editExpenseRowFromJson`/etc.) using `Promise.all`, the exact same pattern
already proven twice in this project's own history: `api/data/[sheet].js`'s
own `resolveYearFolderId` caching writeup, and (cited directly to Anton
during the earlier "why is property-app faster" discussion)
`property-app`'s `api/data/route.ts` GET handler, whose own comment
explicitly credits running independent Drive calls concurrently instead of
stacked for cutting a "fifteen seconds every time" load down to "roughly
whichever one is slowest, not the sum of all three." SAME testing
discipline as every other change in this project: fake-Drive regression
suite first (there's already one at `/tmp/accountstest2/` from the previous
pass, though that's local scratch, not committed -- recreate/extend it,
verifying call ORDER doesn't matter for correctness once parallelized, only
that genuinely-independent calls are the ones being parallelized, never
ones with a real data dependency), then deploy, then ask Anton for one more
real test click and pull fresh logs to confirm the actual number improved.
Do NOT reduce the total DATA correctness of any write while doing this --
this is purely a "run the independent parts at the same time instead of
back-to-back" change, not a change to what gets written or when relative to
what depends on it.

**Anton's own words approving this, verbatim (2026-08-16, right before this
session had to hand off due to a usage limit):** "Yes. Good afternoon. Go
ahead and do it." -- said in direct response to the plan above (timing
instrumentation + parallelizing independent Drive calls in
`lib/accountsWrites.js`, tested the same rigorous way as every prior change,
deploy, then verify with one more real click + fresh logs).

**Files involved:** `lib/accountsWrites.js` (the file to change),
`api/accounts/write.js` (unlikely to need changes, but re-check once
`lib/accountsWrites.js`'s function signatures/return shapes are touched),
`accounts.html` (should NOT need further changes for this specific fix --
its `accountsWriteDispatch` already just does one `fetch()`).

## ✅ ARCHITECTURE CHANGE, tested and delivered — accounts.html's write
## layer moved server-side; every add/edit/delete/transfer is now ONE
## browser round trip instead of ~9 (2026-08-16)

**What happened:** the perf pass just below this one (3 "safe wins") shipped
and DEPLOYED to production, but Anton reported it "not any faster" -- still
20+ seconds per save. Investigation via fresh Vercel production logs (Vercel
MCP connector, real "add expense" click traced end to end) confirmed the
safe wins DID work exactly as measured (call count genuinely dropped), but
they were never the dominant cost. The real cost is architectural: every
one of accounts.html's ~9 remaining Drive touches (row write, notes,
cash, deposit total, bike splits, summary cascade, transaction log) was its
own SEPARATE browser<->Vercel<->Drive<->browser round trip, because the
business logic deciding what to write lived in the BROWSER (a 1:1 port of
Code.gs's function-per-concern shape) -- and Anton is in Thailand, so every
one of those 9 hops pays full transcontinental latency + TLS + auth on top
of the actual (fast) Drive work. Compared side-by-side against Anton's own
`property-app` (a separate project), which does the equivalent business
logic server-side in ONE Next.js API route and makes exactly one browser
round trip per save -- confirmed via that project's own `api/data/route.ts`
comment and source. Anton, after a "don't code, just discuss" investigation
and his own correct read of the situation ("can't it just write all that in
one trip?"), approved a 6-part plan to move accounts.html's write layer
server-side, scoped to accounts.html only (other pages explicitly
deferred), then approved building it.

**What changed:**

1. **New `lib/accountsWrites.js`.** A byte-for-byte port of accounts.html's
   entire client-side WRITE layer (the block between the "WRITE layer" and
   "end WRITE layer" banner comments there -- `addExpenseRowFromJson`,
   `addIncomeRowFromJson`, `editExpenseRowFromJson`, `editIncomeRowFromJson`,
   `deleteExpenseRowFromJson`, `deleteIncomeRowFromJson`,
   `bulkSetExpenseTypeFromJson`, `transferToBankFromJson`, plus every helper
   they call). Verified byte-for-byte (not retyped by hand -- extracted via
   script from the exact source line ranges and diffed back against the
   original to confirm zero drift) with exactly two intentional changes:
   `fetchSheetWithMeta`/`writeSheetJson` now resolve through a new
   `createSheetIO(drive, folderId, session)` (direct `readJsonFile`/
   `writeJsonFile` calls, mirroring `api/data/[sheet].js`'s own
   folder/filename-resolution logic exactly) instead of `fetch('/api/data/
   ...')`; and `logTransactionB`'s 10 call sites are now `await`ed instead
   of fire-and-forget, since the reason that was dropped (an extra
   browser<->Drive round trip after an already-successful save) doesn't
   apply when the whole request runs server-side in one function
   invocation. `shiftNotesForInsertedRowFromJson` was NOT ported -- confirmed
   dead code in the browser version (defined, never called;
   `applyMonthNotesEditsFromJson`'s own `shiftInsertedRow` option superseded
   it). `accountsWriteDispatch`'s switch gained a `'transferToBank'` case it
   never had client-side (that function used to be called directly from a
   separate click handler, not through the dispatcher) -- now the single
   entry point for all 8 actions.

2. **New `api/accounts/write.js`.** `withDrive`-wrapped (same auth guard as
   every other route here), single `POST {action, ...payload}` ->
   `accountsWriteDispatch(body)` -> one JSON response. `ConflictError` maps
   to a 409 with `isConflict:true`, same contract `api/data/[sheet].js`
   already uses.

3. **accounts.html client-side:** `accountsWriteDispatch`'s implementation
   replaced with a single `fetch('/api/accounts/write', ...)` -- same exact
   response shape as before, so `runPendingPayload` (rendering, the cash
   disambiguation modal, warning display, local list updates) needed NO
   changes. The Transfer-to-Bank modal's Save handler was updated to call
   `accountsWriteDispatch({action:'transferToBank', ...})` instead of
   calling `transferToBankFromJson` directly (it never went through the
   dispatcher before). The old ~2000 lines of now-unreachable client-side
   write functions were deliberately LEFT IN PLACE (not deleted) with a
   clear "dead code" banner comment explaining why and pointing at
   `lib/accountsWrites.js` -- lets this be verified live with an easy revert
   if needed; costs nothing at runtime (an uncalled function declaration).
   Physically deleting that dead code is a separate, purely-cosmetic
   follow-up once the new path is proven in production.

**Testing:** built a fake-Drive test harness (`/tmp/accountstest2/` --
local scratch, not part of the delivered project) simulating the exact
subset of the real `googleapis` Drive v3 surface `lib/googleDrive.js` calls
(`files.list/get/create/update`), fixtures matching the real column layouts
(`ACCOUNTS_SUMMARY_ITEMS`, cash sheet, bikes sheet, deposit-log columns),
and called `lib/accountsWrites.js`'s functions directly (no HTTP layer
needed now that there's no more fetch-based dispatch to simulate). 11
scenarios / 36 assertions covering all 8 actions including
`transferToBank`, the free-row-reuse AND insert-shift paths, cash-row
disambiguation (single match and ambiguous-2-candidates),
`consumeDepositFromJson`, the bikes-sheet income/expense cascade,
`ConflictError` propagation (a stale-`modifiedTime` write correctly throws
`ConflictError`, which `api/accounts/write.js` maps to 409), and the
now-awaited transaction log (asserted present immediately after the action
resolves, not racily). Also confirmed the SAME pre-existing "cash sheet
layout has drifted" bug (see the entry below) reproduces identically
post-port under the same conditions -- proof it's an unrelated, unchanged
bug, not something this pass introduced. Separately verified the ported
body is byte-identical to the original accounts.html source (script-diffed
the extracted+transformed lines back against `lib/accountsWrites.js`) --
the only content differences anywhere are the intentional
`fetchSheetWithMeta`/`writeSheetJson`/`logTransactionB` changes described
above.

**Not yet done (per the approved plan, step 6 -- explicitly deferred until
this is proven):** pulling fresh Vercel production logs after deploy to
confirm one browser round trip per action and measure real elapsed time;
deciding whether to roll the same server-side-write pattern out to other
pages with similar multi-step writes (bikes.html, deposits.html, etc.).

**Files changed:** `accounts.html` (client dispatch + transfer button call
site only -- see above), new `lib/accountsWrites.js`, new
`api/accounts/write.js`.

## ✅ PERF FIX, tested and delivered — accounts.html "add expense" write
## chain cut from ~16-18 sequential Drive round trips (~20-25s observed in
## production logs) down to a smaller, still-correct set of calls (2026-08-16)

**What happened:** Anton reported "add expense" on accounts.html taking
"around thirty seconds" / "ridiculous" for what should be a simple write.
He asked for the write process to be explained and broken down BEFORE any
code changed. Investigation (static call-tracing through every function
`addExpenseRowFromJson` touches, cross-checked against real Vercel
production runtime logs via the Vercel MCP connector) confirmed the
suspicion: every meaningful "side effect" of one add/edit/delete action
(row write, notes-sidecar edits, cash-sheet append, deposit total, bike
splits, monthly summary cascade, transaction log) is its own fully
`await`ed, sequential `fetchSheetWithMeta` + `writeSheetJson` round trip
against a JSON file on Drive -- a literal 1:1 port of Code.gs functions
that used to be cheap in-process calls against one open spreadsheet
object, now each an independent network hop. Real logs showed ~16-18
sequential calls, ~23s, for one real "add expense" click.

Anton approved 3 "safe wins" to ship now (parallelizing genuinely-
independent writes, and whether every write even needs the summary
cascade persisted at all, are BOTH explicitly deferred to a separate
discussion -- not done here):

1. **`logTransactionB` is now fire-and-forget.** It was already wrapped in
   its own try/catch that never throws/rejects (comment: "Logging must
   NEVER fail or delay the write it's describing") -- but every one of its
   10 call sites still `await`ed it anyway, meaning every write paid for a
   full extra read+write round trip to `transactionLog` for zero safety
   benefit. Dropped `await` at all 10 call sites (verified via test T11
   that a slow log write no longer blocks the calling function's return,
   and that it still lands on its own afterward).

2. **New `applyMonthNotesEditsFromJson` helper** combines any number of
   edits to the SAME `<monthName>_notes` sidecar file (insert-shift,
   bike-splits note, expense-type note) into ONE read + N in-memory edits
   + ONE write, instead of each edit type doing its own independent
   read-modify-write back-to-back. Used in `addExpenseRowFromJson` (was up
   to 3 round trips, now 1) and `addIncomeRowFromJson` (was up to 2, now
   1), and to merge just the two WRITES (not the separate old-state read)
   in `editExpenseRowFromJson`. Deliberately did NOT fold `editExpenseRowFromJson`'s/
   `editIncomeRowFromJson`'s own "read the OLD notes state before
   overwriting" fetch into the same merged call, even though it touches
   the same file -- that old-state read feeds `oldTypeKey`/`oldBikeSplits`,
   which the personal/wages running-total and bike-sheet reversal logic
   depend on being correct even if the merged write fails; keeping it
   separate and independently-successful preserves that guarantee exactly.
   Test T6 specifically forces the merged write to fail and confirms
   `oldTypeKey` was still read correctly regardless.

3. **Cash-sheet write threading.** `appendCashSheetRowFromJson`,
   `appendCashExpenseRowFromJson`, `updateCashRowFromJson`, and
   `deleteCashRowFromJson` now return `{rows, modifiedTime}` (previously
   nothing usable -- no caller captured their return value before this
   change, so this is purely additive). `recomputeCashSheetTotalsB` and
   `recomputeMonthlySummaryCascadeB` now take an optional `knownCash` param
   -- when the caller just wrote "cash" moments ago in the same request
   with nothing else touching it in between, the recompute step's own
   redundant re-read is skipped entirely (the write still always happens,
   since totals genuinely need recomputing). Threaded through all 7 call
   sites that can know cash state ahead of the cascade call
   (`addExpenseRowFromJson`, `addIncomeRowFromJson`, `editExpenseRowFromJson`,
   `editIncomeRowFromJson`, `deleteExpenseRowFromJson`,
   `deleteIncomeRowFromJson`, `transferToBankFromJson`). Falls back to a
   normal fresh read whenever cash wasn't touched or the write that would
   have told it failed -- fully backward compatible, no caller is forced
   to pass it.

**Net effect (measured via HTTP call-count assertions in the test suite,
not just eyeballed):** a plain cash business expense with no bike splits
went from 12 non-log calls to 9. An edit with a type change, bike-split
change, and cash update went from 13 to 9 (2 of the cash reads there --
resolving which cash row to touch, and reading it again to update it --
are pre-existing and out of scope, not something this pass touches).

**Testing:** built a new from-scratch Node test harness for accounts.html's
business logic (`/tmp/accountstest/` -- didn't exist before; the project's
existing `api/*.js` test pattern doesn't reach browser-side `<script>`
code). Loads the real, unmodified `<script>` block from accounts.html into
a Node `vm` context with a fake DOM + fake `fetch` backed by an in-memory
simulator of `/api/data/[sheet].js`'s exact read/write/409-conflict
semantics (tracks every GET/POST per sheet key so tests can assert on call
counts, which is the entire point of this pass). 12 test cases, 55
assertions, covering add/edit/delete expense and income, a forced
insert-shift, a forced merged-write failure, bulkSetExpenseType (untouched,
sanity-checked), and the fire-and-forget proof. Regression-proofed by
breaking each of the 3 changes one at a time (re-added the `await`;
disabled the bikeSplits branch of the merge; forced the cash recompute to
always re-read) and confirming exactly the expected tests failed each
time, then restored and confirmed 55/55 green again.

**Discovered but NOT fixed (flagged for Anton, out of scope for this
pass):** `deleteCashRowFromJson`'s row-shift (pre-existing code, untouched
by this change) always cascades its 3 columns to the physical end of the
"cash" array, which can nudge whatever row happens to hold the "total
cash" label immediately afterward. `recomputeCashSheetTotalsB` computes
where it EXPECTS that label from a fixed `+4` offset off the (re-scanned)
"income" row rather than also re-scanning for "total cash" itself, so a
delete above the totals block can make the next recompute throw `"cash"
sheet layout has drifted`. Confirmed via test that this reproduces
identically on a plain forced fresh read with no `knownCash` involved at
all -- it's unrelated to this perf pass, not a regression from it. Worth a
look, but is its own separate piece of work.

**Files changed:** `accounts.html` only.

## ✅ CHANGE, tested and delivered — switched default AI model tiers to
## Gemini Flash-Lite and Claude Haiku (2026-08-15)

## ✅ HOTFIX, tested and delivered — live "part.body.pipe is not a
## function" error on every real photo upload (contract passport photos
## AND bike photos), root cause was a long-standing bug, not a regression
## (2026-08-15)

**What happened:** Anton hit a live error on contract.html: after saving a
new customer's details successfully, the passport photo failed with
`Passport photo could not be uploaded: part.body.pipe is not a function`.

**Root cause, confirmed against the actual library source and a matching
GitHub issue rather than guessed:** `createImageFile` in
`lib/googleDrive.js` passed a raw Node `Buffer` as `media.body` to
`drive.files.create()`. googleapis' shared multipart-upload builder
(`apirequest.ts`, used by every client the `googleapis` package generates)
combines `requestBody` (metadata) + `media` (content) into one
`multipart/related` request -- for any part whose body isn't a string, it
unconditionally calls `part.body.pipe(...)`, assuming a Readable stream. A
plain Buffer has no `.pipe`, hence the exact error. Matches
`googleapis/google-api-nodejs-client#1833`, a long-standing, previously
reported instance of this exact error.

This is NOT a regression from anything shipped today (or ever) -- it looks
to have been broken since `createImageFile` was first written. It was
invisible to every test in this project because the fake Drive test
doubles just stored `media.body` directly, never exercising googleapis'
real pipe-based multipart internals. `createImageFile` is shared by BOTH
contract passport-photo uploads (`api/contracts/[...path].js`) and bike
photo uploads (`api/photos/[...path].js`, used by bikephotos.html) -- so
this almost certainly affected bike photo uploads too, not just contracts.
Worth Anton spot-checking whether any bike photos actually made it into
Drive successfully in the past, or whether they've been silently failing
the same way.

**The fix:** wrap the buffer in a real Readable stream before handing it to
googleapis -- `media: { mimeType, body: Readable.from(buffer) }` (`stream`
is a Node built-in, no new dependency). This is the exact fix the
library's own community points to for this error.

**Testing:** upgraded the shared fake-Drive test double (`fakedrive.js`,
used by `/tmp/contracttest` and `/tmp/phototest3`) to actually reject a raw
Buffer passed as `media.body` -- exactly like the real library does --
instead of silently accepting whatever shape it's handed, so the EXISTING
photo-upload tests in both suites now function as real regression tests
for this bug. Confirmed the old (buggy) code failed those tests against
the upgraded fake with the expected error message, then confirmed the
fixed code passes: `/tmp/contracttest/test.js` 51/51,
`/tmp/phototest3/test.js` 30/30, plus `/tmp/yearcache/test.js` 39/39 and
`/tmp/aitest/test.js` 60/60 (both unaffected, re-run for safety since they
also depend on `lib/googleDrive.js`).

**Files changed:** `lib/googleDrive.js` only (`createImageFile`, plus a new
`require('stream')`).

## ✅ PERF FIX, tested and delivered — file-id caching, closing the gap
## Anton flagged after comparing this app's write speed to property-app's
## (2026-08-15)

**What happened:** Anton said the "write functions" (save/edit actions
across bikes, customers, cash, contracts, etc.) still felt incredibly slow,
and asked for a side-by-side look at how property-app (his other Drive-
backed app, newly connected this session) handles the same kind of write.

**Root cause, found by direct comparison:** every read AND write of every
sheet file in this app was paying for a live Drive `files.list` search (by
filename) EVERY single time, via `findFileInFolderOnce`/
`findFileInFolderWithRetry` in `lib/googleDrive.js` -- no matter how many
times that exact file had already been resolved earlier in the same
session. Worse, `findFileInFolderWithRetry` retries up to 2 more times with
a 350ms/700ms backoff whenever a file isn't found on the first attempt (by
design, to cover Drive's search-index lag right after a file is created) --
so a file being written for the first time in a while could add up to ~1s
of pure waiting on top of the search itself.

property-app avoids almost all of this: it resolves its one data file's
Drive id exactly once (cached in a cookie), and every later read/write goes
straight to that file BY ID -- no search, ever. This app had already
partially learned that lesson for Drive FOLDER ids (see the 2026-08-14
entry on `resolveYearFolderId` further down this file) but never extended
it to the files themselves, which was the bigger of the two costs since it
ran on every single sheet read/write, not just once per year.

**The fix:** `resolveFileMeta`, a new helper in `lib/googleDrive.js`, used
by `readJsonFile`/`writeJsonFile` whenever a `session` is passed. It
prefers a file id already cached on the session (`session.driveFileIds`,
keyed by `folderId::filename`) over searching -- a direct `files.get(id)`
lookup is a single indexed call, always consistent, never needs the
not-found retry. Self-heals if a cached id turns out stale (deleted by
hand, or trashed): the direct lookup fails, the cache entry is dropped, and
it falls back to the normal search-by-name path, exactly like property-app's
own reconnect-on-404 fallback. A write whose cached id vanishes in the
brief window between the check and the actual `files.update` call clears
the cache and surfaces the error rather than silently creating a duplicate
file. Fully backward compatible -- `session` is an optional trailing
parameter; every caller that doesn't pass one behaves exactly as before
(always searches).

Wired into the two routes that actually mattered for "writes feel slow":
`api/data/[sheet].js` (every page's sheet read/write) and
`api/contracts/[...path].js` (the contract-documents sidecar, hit on every
contract.html lookup/upload). Both now persist the session cookie the
moment the cache changes, same "re-set the cookie the instant something
changes" pattern `resolveYearFolderId` already used. Deliberately left
`api/admin/reset.js` and `api/ai/[...path].js` unchanged -- reset is a rare
bulk-seed action that already avoids the worst of this cost via
`skipExistenceRetry`, and the AI route's own sidecar files (`ai_provider.json`,
`ai_keys.json`) are settings-page-only, nowhere near the actual hot path.
Keeping the change scoped to the two routes Anton actually feels the slowness
in kept the diff small and easy to verify end-to-end.

**Also discussed and deliberately rejected:** consolidating monthly sheets
into one file per year (Anton's own suggestion, prompted by the same
property-app comparison). Checked how the pages that read monthly sheets
actually use them (accounts.html, bike-income.html) -- none of them fan out
across multiple months on one page load, so consolidation would save no
round trips beyond what this fix already saves, while introducing a new
downside: two different months currently can never conflict (separate
files); merged into one file, editing July would start spuriously
conflicting with a simultaneous edit to August. Not worth it for zero
measured benefit.

**Testing:** four separate suites, all green --
`/tmp/contracttest/test.js` (51/51 -- includes new unit-level tests
directly against `resolveFileMeta`/`readJsonFile`/`writeJsonFile`: cache
hit skips the search, self-heal on a stale/trashed cached id, conflict
detection still works through the cached path, a write whose file vanishes
mid-request clears the cache and surfaces the error instead of duplicating,
two different folders with a same-named file never cross-contaminate);
`/tmp/yearcache/test.js` (39/39 -- end-to-end through the real
`api/data/[sheet].js` route with a real encrypted session cookie
round-tripped between simulated requests, confirming the file-id cache and
the pre-existing year-folder cache work correctly together and a genuine
save conflict still returns 409); `/tmp/aitest/test.js` (60/60, unaffected)
and `/tmp/phototest3/test.js` (30/30, unaffected -- neither route touches
`readJsonFile`/`writeJsonFile`). Also did the regression-proofing pass
twice (disabled the cache-hit branch in `lib/googleDrive.js`, confirmed
only the cache-specific assertions failed; disabled session-passing in
`api/data/[sheet].js`, confirmed the same) before restoring and confirming
fully green again both times.

**Files changed:** `lib/googleDrive.js` (new `resolveFileMeta` helper;
`readJsonFile`/`writeJsonFile` take an optional trailing `session` param),
`api/data/[sheet].js` (passes session through, persists the cookie after
GET/POST), `api/contracts/[...path].js` (same, plus `sendJson` now takes an
optional `session` param so every response exit point can persist the
cache consistently).

## ✅ CHANGE, tested and delivered — switched default AI model tiers per
## Anton's request: Gemini Flash-Lite, Claude Haiku (2026-08-15)

**What happened:** Anton asked (by voice) to change the fallback models --
Gemini to "flash-lite" and Claude to the Haiku tier. This is a deliberate
tier choice, not a bug fix like the HOTFIX entry directly below (that one
replaced a genuinely dead model; this one swaps to smaller/faster/cheaper
current models by preference).

**The fix:** `api/ai/[...path].js` fallback defaults changed:
- `ANTHROPIC_MODEL` fallback: `claude-sonnet-5` → `claude-haiku-4-5-20251001`
  (fastest Claude tier, confirmed current against
  `platform.claude.com/docs/en/about-claude/models/overview`).
- `GEMINI_MODEL` fallback: `gemini-3.7-flash` → `gemini-3.5-flash-lite`
  (confirmed "Stable" and current against
  `ai.google.dev/gemini-api/docs/models`).

`ANTHROPIC_MODEL`/`GEMINI_MODEL` env vars in Vercel still override either
one at any time without a code change, same as before.

**Testing:** re-synced the test harness copy of `api/ai/[...path].js` and
re-ran the full suite -- 60/60 passing (no test asserts on the specific
model string, so this was expected). Confirmed the two new model strings
by direct grep of the shipped file.

**Files changed:** `api/ai/[...path].js` only (two one-line fallback
changes).

## ✅ HOTFIX, tested and delivered — the AI feature below went live and
## Anton immediately hit a real "model no longer available" error on the
## very first live call (2026-08-15)

**What happened:** Anton pushed the AI-provider feature (entry directly
below this one), confirmed the deployment went live, then tried "Fill from
Passport (AI)" on contract.html with Gemini selected and got back: `Could
not read the passport photo: This model models/gemini-2.0-flash is no
longer available.` This is exactly the risk flagged in that entry's own
comment ("verify the fallback against each provider's current docs...
since model names/versions move faster than this file will get
revisited") -- it happened almost immediately. Good news buried in the bad
news: the error is proof the whole pipeline actually works end-to-end
(real request reached Google's real API, with a real key, and got a real
model-level response back) -- the ONLY thing wrong was the hardcoded
fallback model ID.

**The fix:** looked this up live rather than guessing again -- fetched
Google's own current model docs (`ai.google.dev/gemini-api/docs/models`)
directly, which confirms `gemini-2.0-flash` is now marked "Shut down" and
the current general-purpose recommendation is `gemini-3.7-flash`. Since
the exact same class of risk applies to the Anthropic side (just not yet
exercised live -- Anton had Gemini selected, not Claude), checked that too
against Anthropic's own current docs (`platform.claude.com`) and swapped
the fallback from the stale `claude-sonnet-4-5` to the current
`claude-sonnet-5`. Both are now confirmed-current as of today rather than
guessed. `ANTHROPIC_MODEL`/`GEMINI_MODEL` env vars still override either
one if a future model swap is needed without a code change.

**Testing:** re-ran the full 60-test suite (unaffected, since it asserts
on endpoint/headers/payload shape, not the specific model string) --
60/60. Added a one-off manual check confirming the new model ID actually
appears in the outgoing request body.

**Files changed:** `api/ai/[...path].js` only (two one-line fallback
changes + comment cleanup).

## ✅ NEW FEATURE, tested, PUSHED AND CONFIRMED LIVE by Anton — real AI
## provider wired up for passport reads, WhatsApp contact reads, and
## reply-draft generation (2026-08-15)

**What happened:** these three AI-assisted flows existed in the UI on
contract.html and reply-assistant.html the whole time but always hit the
old disconnected `scriptUrl` and failed cleanly (falling back to manual
entry) -- see each page's own "NOT ported... this backend has no
AI-provider integration at all yet" comments from the original JSON-parity
pass. Anton asked to have this wired up for real. Scope, per Anton: passport
photo read, WhatsApp "Edit contact" screenshot read, and the reply-draft
generator. The odometer photo reader on parts.html stays out of scope --
it's already switched off in the UI (staff found it unreliable before this
pass even started) and Anton didn't ask for it back.

**New file: `api/ai/[...path].js`.** ONE consolidated catch-all for all
three routes (`/passport`, `/whatsapp-contact`, `/reply-draft`) --
deliberately built as a single file from the start this time, learning
from the exact mistake documented in the entry above (leftover un-deleted
route files blowing the function cap). Project is now at 9 functions
(8 + this one), 3 slots of headroom left under the Hobby-plan cap of 12.

Each route reads a shared, staff-toggleable Claude/Gemini preference
(`getAiProvider`) and calls whichever provider's REST API directly via the
Node 24.x runtime's native `fetch` -- no new npm dependency. Response
shapes match the original disconnected calls EXACTLY (same `fields.name`/
`fields.nationality`/`fields.passport` for passport, same `fields.chatName`/
`fields.number` for WhatsApp, same `draft` string for the reply generator),
so contract.html/reply-assistant.html only needed their fetch target and
request body changed (drop the old `action` field, point at the new URL)
-- zero changes to how they handle the response.

**AI provider toggle (settings.html) also fixed the same pass** -- it
existed already (Claude/Gemini pills) but read/wrote through the old
disconnected Code.gs actions `aiProvider`/`setAiProvider`. Now reads/writes
through the EXISTING generic `/api/data/[sheet].js` endpoint against a
small `ai_provider.json` sheet-shaped file (one row: `["provider",
"claude"|"gemini"]`) -- no new backend route needed for the toggle itself,
just a client-side swap to the same `fetchSheetWithMeta`/`writeSheetJson`
pattern every other page's data layer already uses.

**UPDATE, same day -- API keys can now be entered right in the app,
per Anton ("make something significant... so you can add API keys in
there"):** settings.html's "AI provider" section now has an "API keys"
block with a password-style field per provider (Claude/Anthropic, Gemini)
and a Save button. Talks to a NEW, DEDICATED pair of routes on the same
`api/ai/[...path].js` catch-all -- `GET`/`POST /api/ai/keys` -- kept
separate from the generic `/api/data/[sheet].js` endpoint on purpose: that
generic endpoint echoes back whatever's stored, which would leak a full
API key to anyone who opened devtools. `/api/ai/keys` is deliberately
write-mostly -- GET only ever returns a MASKED preview (prefix + last 4
characters, e.g. `sk-ant-…j8Kq`) once a key is saved, never the full
value, and there's no way to read a saved key back out through the app at
all. Keys are stored in a new `ai_keys.json` sidecar in the app's own
Drive folder -- same trust boundary as every other piece of app data
(bikes_notes.json, contract_docs.json, etc): anyone who already has Drive
access to the app folder could in principle open this file directly, same
as any of those; flagging this plainly rather than overselling the
security model, since it's a real (if consistent-with-everything-else)
trade-off Anton should be aware of.

A Drive-saved key now takes PRECEDENCE over the matching Vercel
environment variable when both are set, and clearing a saved key (the
"Clear key" link, hidden when a key is only coming from an env var) falls
back to the env var again -- so the two ways of providing a key documented
above coexist cleanly rather than one silently overriding the other in a
surprising way.

**Bug caught by testing, fixed before delivery:** the settings.html toggle
and `ai_provider.json` use `'claude'`/`'gemini'` (the model brand shown to
staff), but the new keys UI and `ai_keys.json` use `'anthropic'`/`'gemini'`
(matching console.anthropic.com vs aistudio.google.com, the page each key
actually comes from) -- a real naming mismatch between the two vocabularies
that would have silently ignored every saved Anthropic key and always
fallen through to the env var instead. Caught by a live repro during
testing (a saved key wasn't being picked up), root-caused, fixed with a
small `providerToKeyName()` mapper, and regression-proofed (hardcoded the
mapper to always return 'anthropic', confirmed exactly the Gemini-path
test failed, restored, confirmed fully green).

**⚠️ Vercel Environment Variables (`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`,
Project → Settings → Environment Variables) still work exactly as
documented above and remain the fallback** -- the in-app "API keys" panel
is the recommended path now (no Vercel dashboard access needed), but
either one alone is enough to make the AI features work; nothing needs to
be done in both places. Missing a key entirely (from both sources) throws
a clear "No Claude/Gemini API key is set" error, surfacing to staff
exactly like any other failed read (never silently). Model IDs
(`ANTHROPIC_MODEL` / `GEMINI_MODEL` env vars, defaulting to
`claude-sonnet-4-5` / `gemini-2.0-flash` if unset) are still
environment-configurable rather than hardcoded -- worth double-checking
those defaults against each provider's current docs before relying on them
long-term, since model names move faster than this file will get revisited.

**Testing:** 60 tests total against a mocked-fetch harness (39 from the
first pass, 21 new) covering both providers (request shape sent to each --
correct endpoint, headers, image vs. text-only payload), the markdown-
code-fence-stripping JSON parser, the "model returned unparseable text"
soft-fail path (empty fields, `success:true`, never a thrown error),
missing-required-field 400s, a missing-API-key 500 with a clear message, a
malformed `ai_provider.json` row falling back to 'claude' instead of
throwing, the provider's own API returning a non-2xx error surfacing its
real message, unknown-route 404, wrong-method 405, saving/clearing a key
and confirming GET reflects it, confirming a saved key's full value is
NEVER present anywhere in a GET response, a Drive-saved key taking
precedence over the env var, clearing a saved key falling back to the env
var again, an invalid provider name rejected with 400, and two providers'
saved keys not disturbing each other. 60/60 passing. Regression-proofed
three times total (provider dispatch, image-required validation, and the
claude/anthropic naming-mismatch fix) -- all restored to fully green
after. Syntax-checked clean on all changed/new files.

**Files changed:** `api/ai/[...path].js` (new; extended same-day with the
`/keys` GET/POST routes + `providerToKeyName` mapper); `contract.html` (3
call sites -- passport read, WhatsApp read on the add form, WhatsApp read
on the edit modal); `reply-assistant.html` (2 call sites -- reply-draft
generator, WhatsApp read on "add customer from screenshot"); `settings.html`
(AI provider toggle now JSON-backed instead of Code.gs-backed, plus the new
"API keys" panel).

## ✅ FIXED AND CONFIRMED LIVE — the "photos/* consolidation" deployment
## (commit af9d4e3) actually FAILED the 12-function cap it was meant to
## fix (2026-08-15)

**What happened:** checked the Vercel dashboard (via the Vercel MCP
connector) after Anton noticed something looked off with the deployment
list. Commit `af9d4e3` ("Consolidate contracts and photos API routes...")
shows `state: ERROR`, same `errorCode: exceeded_serverless_functions_per_
deployment` as the very failure it was supposed to fix. Root cause: the 5
old `api/photos/*.js` files (`list.js`, `folders.js`, `upload.js`,
`delete.js`, `file/[fileId].js`) were never actually deleted from the
repo — the new `api/photos/[...path].js` catch-all was added alongside
them instead of replacing them, so the function count went from 12 to 13
instead of down to 8. This was a delivery mistake from that session (files
were written to Anton's Mac via the device bridge, which can only write —
it can't delete — and the follow-up `git add -A` + commit never actually
removed the old files since they were still sitting on disk). Confirmed by
listing `api/` on Anton's Mac directly: both `photos/[...path].js` AND the
5 old files are present.

**Consequence:** no downtime — a failed deploy doesn't take down what's
already live, so production has stayed pinned to the last GOOD deployment
(commit `749985e`, the contracts-only consolidation, exactly at the
12-function cap) the whole time. But the "further trim to 8 functions"
work from earlier today never actually went live, and — more urgently —
today's newest push (commit `40fe095`, the bike-income.html/
reply-assistant.html sold-bike fix) builds on top of the still-broken
13-function state, so it's very likely to hit the exact same deploy error
once its build finishes (build succeeds, deploy step fails — same no-
downtime outcome, just another stuck deployment).

**The fix:** `git rm` the 5 leftover old `api/photos/*.js` files for real
this time (see the exact commands given to Anton) — nothing references
them anymore since `api/photos/[...path].js` already has all 5 routes'
logic (tested 30/30 earlier today). This brings the function count back to
8, matching what was already documented above as the intended end state.

## ✅ FIXED, tested, awaiting Anton's push — bike-income.html and
## reply-assistant.html were the two pages missed by the "sold bikes never
## stopped appearing" fix below (2026-08-15)

**What happened:** after the big sold-bikes fix (see the entry further down
this file), Anton spot-checked the live app and found bikephotos.html
correct but sold bikes still showing wrong elsewhere. Auditing every page
that reads `Parts_and_Oil_change` or the "bikes" sheet found exactly two
pages with their own private copy of the sold-bike-loading logic (per this
project's no-shared-JS convention) that predate the original fix and were
never touched by it: **bike-income.html** (`getBikeIncomeSummaryFromJson`
had `sold: false, soldAmount: null, soldDate: null, reason: null`
hardcoded) and **reply-assistant.html** (`getPartsDataFromJson` had
`obj.__struck = false` hardcoded). Every other page — bikes.html,
contract.html, customers.html, oilchange.html, available-bikes.html,
bike-name-audit.html, parts.html, add-bikes.html (the source-of-truth
pattern), bikephotos.html — was confirmed already correctly wired.

**The fix — two different behaviors, per Anton's explicit instruction:**
bike-income.html now fetches `bikes_notes` in parallel with `bikes` (same
pattern as add-bikes.html: a `soldNoteByName` Map keyed by
`normalizeBikeNameForTaxLookup`, since `bikes_notes` is keyed by the exact
"bikes"-sheet name) and feeds real `sold`/`soldAmount`/`soldDate`/`reason`
into each bike row. Its render()/CSS (strikethrough name, dimmed row,
"Sold" tag, sold-bikes-sort-first) was already fully built from earlier
work and just needed real data — per Anton, **"flag it... have a line
through it... but I still want it listed there."** reply-assistant.html
now fetches `bikes_notes` too, but matches fuzzily against
`Parts_and_Oil_change` names via the page's existing `bikeNamesMatch`
helper (same pattern as oilchange.html/customers.html) and sets real
`obj.__struck`, which `loadBikes()`/`renderBikeList()` already filtered on
— per Anton, **"for reply assistance, just hide it"** — so a sold bike now
disappears entirely from the "available bikes" suggestion list shown to
staff drafting a customer reply, matching that function's own pre-existing
"available only -- not sold, not currently rented" comment.

**Testing:** extracted both pages' new logic (the `bikes_notes` → sold-flag
computation, and the fuzzy-match → hide filter) into a standalone Node test
script — 17 tests covering: a sold bike with full sale data gets flagged
with amount/date; a write-off (reason but no amount) still flags sold; an
empty/defensive note object doesn't false-positive; no `bikes_notes` data
at all leaves everything unsold (safe default); an unparseable note row is
ignored rather than crashing; reply-assistant's fuzzy name matching (a
shorter `bikes_notes` name against a longer `Parts_and_Oil_change` name)
still catches the match; the DISTINGUISHING_SUFFIXES guard correctly keeps
"Scoopy 1" and "Scoopy 2" from cross-matching; and the actual
available-bikes filter genuinely excludes the sold name while keeping
everything else. 17/17 passing. Both files also syntax-checked clean
(every inline `<script>` block parses).

**Files changed:** `bike-income.html` (added `normalizeBikeNameForTaxLookup`
helper; `getBikeIncomeSummaryFromJson` now fetches `bikes_notes` and
computes real sold fields instead of hardcoding them); `reply-assistant.html`
(`getPartsDataFromJson` now fetches `bikes_notes` and computes real
`__struck` instead of hardcoding `false`).

## ⚠️ IMPORTANT — this Vercel project is on the Hobby plan: hard cap of 12
## Serverless Functions per deployment (2026-08-15)

**What happened:** the contracts-documents feature's first push (commit
`f8eb403`) built fine but the DEPLOY step failed —
`errorCode: exceeded_serverless_functions_per_deployment`,
`"No more than 12 Serverless Functions can be added to a Deployment on the
Hobby plan."` This isn't a code bug: every `.js` file under `api/` (this
project uses Vercel's plain, non-framework builder, one function per file)
counts against the cap, and the 4 new `api/contracts/*.js` files pushed the
project from 11 to 15. The site kept running fine on the last GOOD
deployment the whole time — a failed deploy doesn't take down what's
already live.

**The fix (part 1, same day):** collapsed the 4 new contract-document
routes (`documents.js`, `confirmMatch.js`, `upload.js`, `file/[fileId].js`)
into ONE catch-all function, `api/contracts/[...path].js`, dispatching on
the URL's path segments + method internally. Zero client-side change
needed — `contract.html` still calls the exact same 4 URLs
(`/api/contracts/documents`, `/confirmMatch`, `/upload`, `/file/<id>`);
Vercel's catch-all routing (`[...path]`) matches all of them to this one
function. Brought the project back to exactly 12 functions (the hard cap,
zero headroom at that point).

**The fix (part 2, same day, per Anton — "trim those twelve down any
further?"):** also collapsed the 5 `api/photos/*` routes (`list.js`,
`folders.js`, `upload.js`, `delete.js`, `file/[fileId].js` — bikephotos.html's
whole backend) into a second catch-all, `api/photos/[...path].js`, same
pattern, same zero client-side change (bikephotos.html still calls
`/api/photos/list`, `/folders`, `/upload`, `/delete`, `/file/<id>`
unchanged). `api/auth/*` (login/session/OAuth callback, 4 files)
deliberately left AS SEPARATE FILES — discussed with Anton first: it's the
one place a subtle merge bug could actually lock him out or leak a
session, not worth merging to save 3 function slots when the safer
`photos/*` group already bought real headroom. Project is now at 8
functions (`admin/reset.js`, `auth/*` ×4, `contracts/[...path].js`,
`data/[sheet].js`, `photos/[...path].js`) — 4 slots of headroom instead of
zero.

**If more headroom is ever needed again:** `api/auth/*` is the only
remaining group that could still be collapsed the same way — approach it
carefully (it's the security-sensitive one) or just upgrade to Vercel Pro,
which removes the 12-function cap entirely for ~$20/mo. Whichever a future
session picks, check the current function count first (`find api -name
"*.js" | wc -l` in the repo, or ask the Vercel MCP connector's
`list_deployments` / `get_deployment` on the latest deploy) before
assuming a new route is safe to add as its own file.

**Testing:** both merges are pure refactors — no route's request/response
shape changed. Contracts: re-ran the existing 22-test fake-Drive suite
unchanged against the new consolidated file (still 22/22), plus 7 NEW
tests for the file-serving route (`/file/<id>`), which had never had test
coverage even as its own separate file — image success (right bytes +
Content-Type), PDF success, a non-servable id (a folder, not a file)
404ing instead of trying to stream a folder, unknown id 404ing cleanly.
29/29 total. Photos: built a fresh 30-test fake-Drive suite (this route
group never had one before) covering the two-fuzzy-matching-folders merge
+ newest-first sort (the exact bikephotos.html "Click red"/"Click red
(125cc)" scenario), the coverage-check per-folder counts, upload
creating-vs-reusing the exact-name folder, delete's non-image safety
guard, and the file route's image-only + trashed + unknown-id 404 paths.
30/30. Both merges regression-proofed the same way as every other change
this session: a route deliberately broken, confirmed the exact expected
tests failed (not unrelated ones), restored, confirmed fully green again.
Syntax-checked clean.

**Files changed:** new `api/contracts/[...path].js` and
`api/photos/[...path].js`; deleted `api/contracts/documents.js`,
`api/contracts/confirmMatch.js`, `api/contracts/upload.js`,
`api/contracts/file/[fileId].js`, `api/photos/list.js`,
`api/photos/folders.js`, `api/photos/upload.js`, `api/photos/delete.js`,
`api/photos/file/[fileId].js` (logic moved into the two new files, not
lost).

## ✅ NEW FEATURE, tested, awaiting Anton's push — contract.html: view +
## upload documents (passport photo, and anything else manually copied in)
## from the "AA Scooters Contracts" Drive folder, right from the edit-
## contract modal (2026-08-15)

**What it does:** Anton manually copied his old "AA Scooters Contracts"
Drive folder (one subfolder per customer, e.g. `01-08-2026 - Mr Yassine
Zagri - +212 655578462`, hand-copied from the legacy Code.gs app) into this
app's own Drive folder. This feature links that up: opening any contract in
the edit modal now shows a **Documents** panel listing everything in that
customer's subfolder (passport photo shown as a thumbnail, PDFs/other files
as plain links, each opening via a private proxy route), and the existing
"Upload photo" field in that same modal now actually uploads a new passport
photo into that same folder instead of doing nothing. New contracts (the
Add tab) work the same way — a bundled passport photo now actually uploads
instead of showing "Passport photo was NOT uploaded" placeholder text.

**Folder matching:** mirrors Code.gs's original `findCustomerContractFolder`/
`getOrCreateCustomerContractFolder` logic, but FUZZY instead of exact-string
— Anton's hand-copied folder names aren't always punctuated consistently.
Matches by normalized name + normalized (digits-only) phone, scored:
confident (100) only when both name AND phone agree; anything less
(name-only, phone-only, partial token overlap) is NOT auto-used. When
nothing's confident, the panel shows a picker of the closest candidate
folders to choose from instead of a bare "not found" message (Anton's
explicit choice). Once a match is confirmed — auto-confident OR manually
picked — it's remembered in a new `contract_docs.json` sidecar (global, not
year-scoped) so the same customer never has to be re-matched or re-picked
again, and a NEW contract for a returning customer reuses that same folder
rather than creating a duplicate one (also Anton's explicit instruction).
Uploading a second passport photo for the same customer+date is refused
(mirrors Code.gs's `savePassportPhoto` duplicate guard) and reports the
existing file instead of silently duplicating it.

**Files changed:** `lib/googleDrive.js` (new fuzzy contract-folder-matching
helpers: `normalizeContractName`, `normalizeContractPhone`,
`buildContractMatchKey`, `parseContractFolderName`,
`scoreContractFolderMatch`, `findContractFolderMatches`,
`ensureContractsRootFolder`, `ensureContractCustomerFolder`,
`listAllFilesInFolder`); three new API routes — `api/contracts/documents.js`
(GET, sidecar-first lookup with live fuzzy fallback), `api/contracts/
confirmMatch.js` (POST, manual picker confirmation), `api/contracts/
upload.js` (POST, resolves/creates the folder and uploads, with the
duplicate-date guard); a new private file-proxy route,
`api/contracts/file/[fileId].js` (images + PDFs); and `contract.html` (new
Documents panel in the edit modal, rewired "Upload photo" button, rewired
Add-tab bundled-photo upload, new `isoDateToDashDmy` date formatter for the
`dd-MM-yyyy` folder/file-naming convention).

**Testing:** backend covered by a hand-built fake-Drive unit test harness
(22/22 — confident/messy/no-phone/name-only/phone-only matching, the
sidecar remember-and-reuse path, the ambiguous-near-duplicate-folder case,
manual-pick-then-remembered flow, folder-reuse for returning customers,
duplicate-upload refusal, and end-to-end visibility of a freshly uploaded
file). One core piece (the confidence-scoring threshold) regression-proofed:
deliberately broken, confirmed the expected test failed, restored, confirmed
22/22 green again. UI wiring covered by three Playwright scripts against the
real `contract.html` (stubbing `/api/auth/session` + the new `/api/
contracts/*` routes): confident-match rendering (thumbnail + PDF link),
ambiguous-match picker rendering and "Use this one" → confirmMatch →
re-render, the edit-modal upload button's real file upload (correct name/
phone/dateStr/base64 in the request, status message, panel refresh), and
the Add-tab's bundled-photo upload wiring in `addContractFromJson` (upload
actually called, `passportPhotoUrl` set on success, no leftover warning).
All 5 new/changed JS files syntax-checked clean (`node --check`).

**Not done / deliberately out of scope:** contract PDF / receipt / checklist
generation ("View Contract", "Update Contract", "View Receipt", etc.) is
untouched — still disconnected, per contract.html's existing three-tier
deferral comment. This feature is only about viewing/uploading documents
that already exist or get manually copied into the customer's folder, not
generating new ones.

## ✅ FIXED, tested, awaiting Anton's push — bikephotos.html: a bike could
## show "has photos" in the coverage check but "No photos yet" when
## actually opened (2026-08-15, found live by Anton right after the
## drive.readonly fix below went in)

**The bug:** the coverage check (`api/photos/folders.js` + client-side
`bikeNamesMatch`) already fuzzy-matches a Drive folder name to a bike's
sheet name — needed because legacy hand-copied folders don't always spell
a bike identically (e.g. a `(125cc)` size suffix). But `api/photos/list.js`
— what actually runs when a bike is selected to view its photos — was
still doing an EXACT Drive name match (`findNamedFolder`). A bike whose
only Drive folder was a fuzzy-but-not-exact match (e.g. sheet says "Click
red", folder is "Click red (125cc)") would count as "has photos" in the
coverage summary but show a completely empty gallery when opened — since
the exact-match lookup simply couldn't see the folder the fuzzy-matched
coverage check found.

**The fix:** added `findBikePhotoFolders` to `lib/googleDrive.js` — a
Node-side port of the same `normalizeBikeName`/`bikeNamesMatch` fuzzy
logic every page already carries client-side (kept in `lib/` since that's
genuinely shared backend code, unlike the static pages) — that returns
EVERY subfolder under "Bike Photos" whose name fuzzily matches a given
bike, not just a single exact-name folder. `api/photos/list.js` now uses
this and merges photos from every matching folder (sorted newest-first
across all of them), so it always agrees with what the coverage check
already reported. Also fixed the coverage check itself
(`runCoverageCheck()` in bikephotos.html) to SUM photo counts across every
matching folder instead of taking only the first one found — matters if a
bike ends up with more than one matching folder (e.g. a legacy hand-copied
one plus a separate one the app auto-created on an earlier upload), which
otherwise could show the wrong count or even wrongly mark a bike as
"missing photos" if the first matching folder happened to be empty.

**Testing:** `api/photos/list.js` + `findBikePhotoFolders` covered by a
hand-mocked fake-Drive unit test (10/10, including the exact "Click
red"/"Click red (125cc)" scenario from Anton's report, a two-matching-
folder merge case, and a sanity check that plain exact-name matches still
work unchanged). bikephotos.html's coverage-check sum fix covered by
Playwright (4/4, including a duplicate-folder scenario proving the count
is now summed, not just the first match). Both regression-proofed:
reverted in isolation, confirmed the expected tests failed, restored,
confirmed green again. Syntax-checked clean.

**Files changed:** `lib/googleDrive.js` (new `findBikePhotoFolders` +
fuzzy-match helpers), `api/photos/list.js`, `bikephotos.html`.

## ✅ FIXED, tested, awaiting Anton's push — sold bikes never stopped
## appearing across the app (bikes.html, available-bikes.html, contract.html,
## customers.html, bikephotos.html, oilchange.html, parts.html,
## bike-name-audit.html); plus "Reset data" now clears the transaction log,
## and a manual "Remove" option for reversed log entries (2026-08-15)

**The bug:** the legacy Code.gs system marked a bike "sold" by putting a
strikethrough font on its row in the "Parts and Oil change" sheet tab —
purely cosmetic formatting with no JSON equivalent. When each page was
migrated off Code.gs to the Drive-backed JSON API, `__struck` (the "is this
row sold" flag every page reads) got stubbed `false` identically across all
8 pages that use it, flagged at the time as a KNOWN GAP. Result: sold bikes
kept showing up everywhere — available for new rentals, needing oil
changes, needing photos, etc.

**The fix — going forward:** Add Bike's existing Sell/Write-off flow
(shipped in an earlier session) already wrote a real sold-status note to a
`bikes_notes` sidecar JSON file, but keyed it by the "bikes" sheet's row
number — useless to the other 8 pages, none of which fetch that sheet. Re-
keyed `bikes_notes` to store `[bikeName, noteJson]` rows instead
(add-bikes.html's `readBikeSoldNoteFromJson`/`writeBikeSoldNoteFromJson`),
so any page can check sold status directly off its own already-fetched
Parts & Oil bike list, fuzzy-matched by name (bike names aren't always
spelled identically across sheets, e.g. "Aerox White (155)" vs "Aerox
white"). No workflow change for Anton — selling/writing off a bike in Add
Bike works exactly as before.

Every consumer page's `getPartsDataFromJson`/`getPartsBikeNamesFromJson`
now fetches `bikes_notes` alongside Parts & Oil and sets a real `__struck`
flag. What each page does with it:
- **bikes.html, available-bikes.html, contract.html, bikephotos.html** —
  already had a `__struck`/sold-name filter wired up but starved of real
  data; now works with no other changes needed.
- **customers.html, oilchange.html** — had no sold-bike filter at all;
  added one (new customer intakes and the oil-change due list both now
  exclude sold bikes).
- **parts.html** — deliberately the opposite: this page IS the maintenance
  record, so sold bikes are shown FLAGGED (strikethrough style + a "Sold"
  pill) rather than hidden, in both the search dropdown and the edit-form
  header.
- **bike-name-audit.html** — no filter needed; its struck-vs-not split
  already existed and was just waiting on real `__struck` data (its
  "Backend not updated yet" banner now correctly disappears).

**Backfill for the 5 already-sold bikes (2026-08-15, done via seed data
instead of the UI, per Anton's explicit request):** originally documented
here as a manual per-bike Add Bike → Sell/Write-off job. Anton asked
instead for the bundled seed JSON itself to carry these 5 as already-sold,
so a single "Reset data from latest deploy" click (Settings) picks them all
up at once — he didn't want to click through Sell/Write-off five times by
hand. New file `data/bikes_notes.json` (this "sheet" is otherwise a
runtime-only sidecar Add Bike's Sell/Write-off writes to on demand — see
the block comment above `readBikeSoldNoteFromJson` in add-bikes.html — not
normally part of the bundled seed snapshot; bundling one now works cleanly
because `api/admin/reset.js`'s file loop already writes ANY *.json file it
finds in `/data` to the matching global filename in Drive, `bikes_notes`
included, with zero reset.js changes needed) with one `[bikeName,
{soldAmount:0, soldDate:null, reason:"Sold (historical)"}]` row per bike —
aerox black, aerox blue, gt silver 2, gt black 6, gt Burgandy, using each
bike's EXACT name string as it appears in `Parts_and_Oil_change.json`
(pulled directly off that live file, including its exact stray
whitespace/casing, e.g. `"gt  black 6 "` with a double space and a
trailing space) so the fuzzy `bikeNamesMatch` every consumer page already
uses is guaranteed to hit — no reliance on fuzziness papering over a typo.
Flag-only (`soldAmount: 0`), no effect on any income total; `soldDate: null`
since the real historical sale date isn't known (shown as no date rather
than a misleading fabricated one — every consumer page already treats a
missing `soldDate` as optional/blank).

**Testing:** verified directly against the live `Parts_and_Oil_change.json`
staged from Anton's Mac (not a synthetic fixture) — ran the real
`bikeNamesMatch`/`normalizeBikeName` logic over all 45 bikes on that sheet
against the new `bikes_notes.json`, confirming exactly these 5 (and no
others — in particular that "gt silver 2" does NOT also catch "gt silver 1"
or "Gt 2", since `bikeNamesMatch`'s distinguishing-suffix rule keeps
same-family numbered bikes apart) come back struck. Also traced
`api/admin/reset.js`'s file-classifying logic by hand to confirm
`bikes_notes.json` lands in the global (non-year-scoped, flat-in-app-root)
branch, not the monthly branch (its `_notes`-suffix special case only
promotes a MONTH name back to monthly, and "bikes" isn't a month) — i.e.
it'll be written to exactly the same Drive path `/api/data/bikes_notes`
already reads from, no reset.js code changes needed at all.

**Files changed:** new `data/bikes_notes.json` only — `_manifest.json`
deliberately left untouched (it's export_to_json.py's own generated data
dictionary for real Sheet-tab exports; `bikes_notes` isn't one of those, so
adding a fake entry there would misrepresent what the manifest documents).

**Also this session, two settings.html/reset requests from Anton:**
- **"Reset data from latest deploy" now also wipes `transactionLog.json`**
  (`api/admin/reset.js`) — a reversible entry's logged before/after values
  would otherwise reference pre-reset data, so reversing one after a reset
  would silently write stale values back over the fresh reset data.
  Best-effort: if this specific write fails, the rest of the reset still
  reports success (the log can still be cleared by hand from Settings).
- **Manual "Remove" button on already-reversed transaction-log entries**
  (settings.html) — separate from the existing 24h auto-hide; lets Anton
  permanently delete a reversed entry from the list instead of it
  accumulating forever. Only appears on entries where `reversed: true`;
  confirms before removing; removes just that one entry via the normal
  read-modify-write flow.

**Testing:** every one of the 8 consumer pages, plus the reset.js change
and the settings.html Remove button, has full behavioral (Playwright,
real headless browser against a stateful mock server) test coverage — not
just syntax checks. Every single change was regression-proofed: reverted
in an isolated copy, confirmed the test suite failed in exactly the
expected way, then restored and confirmed green again. Syntax-checked
clean across all 10 touched files as a final sanity pass.

**Files changed:** `add-bikes.html` (the re-key + "Fleet" section header
now reads "Sell, write off, or edit a bike" per Anton's request),
`bikes.html`, `available-bikes.html`, `contract.html`, `customers.html`,
`bikephotos.html`, `oilchange.html`, `parts.html`, `bike-name-audit.html`,
`api/admin/reset.js`, `settings.html`.

**Not yet done:** push to Anton's Mac and deploy (see git commands handed
over alongside this file). Also still open from the entry directly below:
confirming whether the `lib/googleDrive.js` drive.readonly commit actually
went through — the last known state was a failed `git commit` blocked by
the recurring `.git/index.lock` bug, with Anton told to retry after
`rm -f .git/index.lock`, but no confirmation was seen after that.

## ⚠️ FIXED (code side), needs a real live Drive re-login test from Anton —
## bikephotos.html: manually-copied legacy photos still show 0 covered,
## even after Anton copied them straight into the app's own "Bike Photos"
## Drive folder (2026-08-15)

**Root cause, confirmed (not just theorized this time):** the app requests
only the `drive.file` OAuth scope, which per Google's own definition means
the app can only ever see/read files it created itself, or files the user
explicitly selected through a Google Picker dialog. A file or folder
Anton drags/uploads into Drive **through Drive's own web UI** — even
directly inside the "Bike Photos" folder the app itself created — stays
completely invisible to the app's `drive.files.list` calls forever. This
was confirmed live: Anton copied several legacy bike-photo folders
("freego red (125)", "nmax grey 2 (155)", "rax 1/2/3 (155)", etc.)
straight into `Bike Photos` via drive.google.com, and bikephotos.html
still reported 45 needing / 0 with photos — not a bike-name-matching bug
(`normalizeBikeName` already strips the legacy `(id)` suffix correctly,
confirmed by reading the matching code), the app genuinely cannot see
those files at all under `drive.file` alone.

**The fix:** added the `drive.readonly` scope alongside the existing
`drive.file` scope (`lib/googleDrive.js`, `DRIVE_SCOPES`) — writes
(uploads, sheet saves) still go through `drive.file` as before, but reads
can now see anything in the signed-in Drive account, including files
Anton adds by hand outside the app. Accepted as reasonable for this
specific app: it's a 2-person internal tool (Anton + his wife) and the
Drive account being read is the same account using the app — there's no
other-user privacy boundary being crossed the way there would be for a
public multi-tenant app, which is what Google's stricter "sensitive
scope" verification review is actually guarding against. Also tightened
`ensureAppFolder`'s folder lookup to `'root' in parents` (it was a bare
name search before) — that was safe by accident under `drive.file` alone
(nothing else was ever visible to match), but now that reads see the
whole Drive, pinning it to root rules out ever matching some unrelated
folder Anton happens to also have named "AA Scooters App Data".

**Cannot be fully tested here** — this is a real Google OAuth consent/
scope change, not something a mock server can simulate. Syntax-checked
clean; no other code changes needed (every existing `drive.files.list`
call automatically starts seeing more once the token itself carries the
broader scope — nothing about how those calls are written needs to
change).

**Anton, two things needed from you before this actually takes effect:**
1. **Google Cloud Console, one-time:** open your project → APIs & Services
   → OAuth consent screen → "Data access" tab → "Add or remove scopes" →
   check `.../auth/drive.readonly` ("See and download all your Google
   Drive files") → Save. Without this step Google will reject the new
   scope even though it's in the code.
2. **Log out and log back into the app once.** Existing sessions were
   granted the old, narrower scope — a fresh login re-triggers the
   consent screen (it already forces `prompt=consent` every time) and
   picks up the new one. You may see Google's "unverified app" warning
   screen during this login if you haven't seen it before — that's
   expected for an internal tool that hasn't gone through Google's
   public-app review, click "Advanced" → "Go to (app name)" the same as
   normal.

After both of those, reload bikephotos.html and the photos you already
copied in should show up with no further action — no re-uploading needed.

## ✅ FIXED, tested, awaiting Anton's push — contract.html: renting a bike
## logged several separate transaction entries instead of one, and the
## bike's own Rented status was never logged at all, so reversing a rental
## left the bike stuck showing "Rented" forever (2026-08-15, found live by
## Anton right after the accounts.html summary-refresh fix below)

**The bug, in two parts:** renting a bike (`customerIntakeFromJson`, the
function `doRent()`'s "Yes, rent it" button calls once a Pending contract
is confirmed) writes to several sheets — the customer intake row, the
month's income row, a cash row (if paid in cash), the bikes sheet's
running monthly total, sometimes a deposit total or security deposit
entry, and the Contract sheet's own status cell (Pending → Rented). Several
of these each logged their **own separate** transaction-log entry, so
reversing one rental meant clicking "Reverse" several times — exactly what
Anton reported ("we've divided the two things that have to be reversed...
I don't want that"). Worse, the single most important write — flipping the
Contract sheet's status cell to "Rented" — was **never logged at all**, so
there was no way to reverse it by any means: reversing every entry that
*was* reversible still left the bike showing "Rented" in both bikes.html
and this page's own Contract search, because nothing had ever recorded
what that cell used to say.

**The fix:** every helper function `customerIntakeFromJson` calls
(`appendMonthlyIncomeRowFromJson`, `appendCashSheetRowFromJson`,
`addRentalAmountToBikesSheetFromJson`, `processDepositForPaymentFromJson`,
`logSecurityDepositFromJson`, `markMatchingContractAsRentedFromJson`,
`syncContractRowTotalsFromJson`) now returns its write descriptor
(`{sheet, row, cols, before, after}`) instead of logging its own entry (or,
for the Contract-status flip and the bikes-total update, instead of not
logging anything at all). `customerIntakeFromJson` collects every one of
these into a single array — including the customer intake row itself,
using the same "before = blank cells" convention accounts.html already
uses for a freshly appended row — and logs it as **one** combined,
one-click-reversible transaction entry. The existing reversal mechanism in
settings.html (`executeReversal`) needed no changes at all — it already
walks a `writes` array applying each item independently regardless of
which sheet it's on, so this was purely about actually giving it the full
list. Deliberately NOT included: the customer ledger note (`customer_notes`
sheet) — it's addressed by [row, col] as data rather than a literal sheet
cell, gets the same "best-effort, not logged" treatment every other notes
sidecar write in this app already gets, and doesn't affect money or the
bike's rented status (the two things a rental reversal actually needs to
restore).

**Tested** in a real headless browser (Playwright) against a mock server
with true GET/POST persistence (not canned responses) seeded with Anton's
real August/cash data (so the real summary cascade genuinely runs) plus a
synthetic Contract row seeded as "Pending" — 25/25 passed: renting a bike
produces exactly ONE transaction-log entry (not several) covering the
customer row, income row, cash row, bikes total, and — critically — the
Contract status flip with the correct before="Pending"/after="Rented";
before reversal the bike genuinely shows "Rented" and every sheet reflects
the rental; reversing it through the REAL settings.html Reverse
Transactions UI (found the row, clicked it, clicked "Reverse" — the exact
steps Anton took) restores every single write in one click, including the
Contract status going back to "Pending" — the specific bug reported — while
correctly leaving unrelated pre-existing data on the same rows untouched
(the August/cash sheets pack expense and income blocks side by side on the
same rows). Confirmed this test suite genuinely catches the original bug:
re-run with just the Contract-status-flip fix reverted, it fails exactly
where expected (bike stays "Rented" after reversal) and passes clean
against the real fix.

## ✅ FIXED, tested, awaiting Anton's push — accounts.html: summary strip
## (Total expenses/income, profit, cash & deposits) stayed stale after
## Add Expense/Income until a manual page reload (2026-08-15, found live
## by Anton right after the load/save speed pass below)

**The bug:** adding or editing an expense/income entry correctly saved to
Drive and correctly updated the on-page list right away (via
`upsertLocalExpense`/`upsertLocalIncome`) — but the summary strip at the
top (Total expenses, Total income, Profit, Cash & Deposits) is read off
separate fixed cells the server recalculates during the save
(`recomputeMonthlySummaryCascadeB`), not derived from that list. Nothing
ever re-fetched or re-rendered that strip after a save — only a full month
reload (`loadMonth`, which only runs today on a delete or a rare
row-insert shift) called `renderSummary` at all. So the numbers you saw
right after saving were whatever was there before, until a full page
refresh forced a fresh `loadMonth`.

**The fix:** added `refreshSummaryAfterSave(monthIndex)`, called
(fire-and-forget, best-effort) right after a successful non-shifted
Add/Edit in `runPendingPayload`. It re-fetches this month's data — the
write that just happened already invalidated `accountsJsonCache`'s entry
for this month (see `writeSheetJson`), so this fetch always hits the
network and gets the figures the server just recalculated, never a stale
cached copy — and re-renders just the summary strip via `renderSummary`.
Guarded against a month switch racing this fetch (if the user clicks to a
different month before it resolves, the stale response is discarded
instead of overwriting the month they're now looking at). Deliberately
NOT awaited/surfaced as an error on failure — the save itself already
succeeded; a summary-refresh hiccup shouldn't read as a failed save.

**Tested** in a real headless browser (Playwright) against a mock server
seeded with Anton's actual exported August/cash data (so the real
`recomputeMonthlySummaryCascadeB` cascade genuinely runs and produces
real recalculated figures, not canned test values) — 8/8 passed: the
"Total expenses" figure changes immediately after Add Expense with no
page reload, and matches old total + the new expense's amount exactly;
this happens without ever falling back to a full `loadMonth()` reload
(confirmed by instrumenting it directly — zero calls); the new expense
still shows correctly in the list (existing behavior, unaffected); and a
month switch that races the in-flight summary refresh correctly keeps
showing the month the user switched to, not a late, stale overwrite.
Confirmed this test suite genuinely catches the bug: re-run against the
pre-fix code, it fails exactly as expected (totals never change, 0 refresh
calls); against the fix, 8/8 pass.

## ✅ DONE, tested, awaiting Anton's push — load/save speed pass:
## session-cached year folder + concurrent independent sheet fetches
## (2026-08-14/15, prompted by comparing against a separate project's
## own past "fifteen seconds every time" fix)

**Why this happened:** Anton flagged the app loading/saving slower than
he'd like, and specifically asked me to compare against how a *different*
project of his (a Next.js rental-property app) had fixed the exact same
complaint before reaching for "connect it to a database" — that project's
own code comments blamed the slowness on repeatedly re-fetching things
that don't actually change on every page load, not on the storage format
itself. The same class of waste turned out to exist here, in two
independent places. This was a discuss-first, code-second exercise —
options were laid out, Anton approved options 1 and 2 (of four), and only
those two were built. Options 3 and 4 (a heavier client-side cache layer,
and pre-warming data on login) were **not** approved and are **not**
included here.

**Option 1 — cache the year-folder Drive ID on the session
(`api/data/[sheet].js`):** every read/write of a monthly sheet
(`/api/data/July?year=2026`, etc.) was calling `ensureYearFolder`, which
does a live Drive `files.list` search for that year's subfolder — on
*every single request*, even though a year's folder ID never changes once
it exists. This is the same "re-resolve something on every request that's
actually stable for the life of the session" waste the property-app
comparison called out as its biggest win (there, via a `COOKIE_FILE_ID`
cookie). Added `resolveYearFolderId()`, which checks
`session.driveYearFolders[year]` first and only falls back to the live
Drive search if that year hasn't been resolved yet in this session; the
result is then cached onto the session and persisted via
`setSessionCookie`, exactly the same pattern already used for
`session.driveFolderId` (the app root). No behavior change from the
caller's point of view — same folder ID comes back either way, just
without paying for a Drive search on every request once a year's been
resolved once. Backward compatible with existing real login cookies that
don't have a `driveYearFolders` field yet (starts populating it from the
next request on).

**Option 2 — run independent sheet reads concurrently instead of
sequentially (`accounts.html`, `add-bikes.html`):** both pages had
functions that fetched two or three *unrelated* sheets one after another
with `await`, paying each request's full round-trip time back-to-back for
no reason — the fetches don't depend on each other's results.
- `accounts.html`'s `getAccountsDataFromJson()`: the month's rows and its
  notes sidecar (July/August only) now fetch via `Promise.all` instead of
  sequential awaits; a notes-fetch failure still degrades gracefully to an
  empty notes array exactly as before.
- `add-bikes.html`'s `getBikeDetailsFromJson()`: `Bike_Tax`, `bikes`, and
  `Operation` now all fire at once instead of one-after-another; the
  existing best-effort fallback behavior for cost/currentKm if `bikes`/
  `Operation` fail is unchanged.
- `add-bikes.html`'s `getBikeIncomeSummaryFromJson()`: `bikes` and
  `bikes_notes` now fire at once; same notes-failure fallback as before.

No page's data-fetching *logic* changed — only the scheduling of
already-independent requests. All existing error handling, fallbacks, and
cache behavior (each page's own in-memory `fetchSheetJson` promise cache)
are untouched.

**Tested — Option 1:** a from-scratch harness
(`resolveYearFolderId`/session round-trip, not a shortcut) exercising the
real, unmodified `api/data/[sheet].js` route end-to-end against an
in-memory Drive simulator, with a genuine AES-256-GCM encrypted session
cookie round-tripped exactly like a real browser (send whatever
`Set-Cookie` the previous response set, on the next request) — 20/20
passed: first read of a year resolves + caches it (exactly one Drive
search, a `Set-Cookie` goes out); a second read of a different sheet in
the same year reuses the cache (zero additional searches); a write reuses
it too; a different year resolves and caches independently without
disturbing the first year's cached entry; a global (non-year) sheet never
triggers a year-folder search at all; a session with no
`driveYearFolders` field at all (simulating a real pre-existing cookie
from before this change) still works and starts caching correctly from
that point; and a full write-then-read-back round trip still matches
exactly.

**Tested — Option 2:** a real headless-browser (Playwright) suite against
a mock server with an artificial 150ms per-request delay — 16/16 passed:
`accounts.html`'s August rows + notes fetches start within ~1ms of each
other (vs. the 150ms delay, proving genuine concurrency) with correct year
params, notes-failure resilience, and main-sheet-failure still propagating
as an error; `add-bikes.html`'s three-way `getBikeDetailsFromJson` fetch
(Bike_Tax/bikes/Operation) all start together with correct field values
and Operation-failure resilience; `getBikeIncomeSummaryFromJson`'s
bikes+bikes_notes fetch also starts together.

## ✅ DONE, tested, awaiting Anton's push — pricing.html: removed the
## leftover client-side login wall, added a "Number of Days" alternative
## to the return-date picker (2026-08-14)

**Login wall removal:** pricing.html was the only page in the app still
carrying an old client-side `sessionStorage`/plaintext-password lock screen
(`PASSWORD = "Aerox2016"`, ~90 lines of markup/CSS/JS) — a leftover from
before nav.js's server-backed session gate existed. It never actually
protected anything (any other page was always reachable directly), and
every real page — this one included, via `<script src="nav.js" defer>` —
already gets redirected to `login.html` server-side if there's no valid
Google sign-in (see nav.js's auth-gate IIFE, which checks
`/api/auth/session`). Removed the whole `#lockScreen`/`.lock-card`/etc.
block and its script entirely; nothing else in the file referenced it.

**"Number of Days" input, as an alternative to picking a Return Date:** a
new two-button toggle ("Pick Return Date" / "Enter Number of Days") above
the date fields. In days mode, the Return Date field is swapped for a
plain number input; "Rented From" defaults to today (only if not already
set) as a convenience for a quick "starting today, for N days" quote.
Deliberately does **not** duplicate any pricing math — entering a day count
just computes `fromDate + N calendar days` and writes it into the same
(now-hidden) `#toDate` input every existing function already reads, so
`calculate()`/`updateBtn()`/`monthDayBreakdown()`/the month-vs-day
breakdown logic are all completely untouched and stay unaware this mode
exists. Switching back to "Pick Return Date" clears the derived value
(rather than leaving a stale auto-computed date sitting there unexplained)
so the Calculate button correctly goes back to disabled until a real date
is chosen.

**Tested end-to-end in a real headless browser (Playwright, 18/18 checks)**
against the actual unmodified file: confirmed zero lock-screen elements
remain anywhere in the DOM and the page content is visible immediately;
the existing two-date-picker flow still prices correctly (regression
check, unchanged); switching to days mode correctly swaps which fields are
visible and preserves an already-picked "Rented From"; entering a day
count computes the exact right hidden Return Date and duration text, and
prices correctly against the fallback rate table; changing "Rented From"
while in days mode recomputes the Return Date; a fresh page load
correctly leaves "Rented From" empty until days mode is actually chosen,
at which point it defaults to today; and switching back to dates mode
clears the derived Return Date and correctly disables Calculate again.

## ✅ DONE, tested, awaiting Anton's push — bikephotos.html full Google
## Drive photo storage integration (2026-08-14, replaces the disconnected
## `scriptUrl`/Apps-Script stub this page had been left on)

**What this replaces:** bikephotos.html previously pointed at
`const scriptUrl = ''` — a disconnected Apps Script web-app URL, same as
every other page before its JSON port, except photos were never going to be
JSON-portable (they're binary files, not sheet rows). Anton explicitly chose
"full Drive integration now" over a quick friendly-error patch, then
confirmed this was next ("Let's see the bike photos. It's the most
important.").

**Architecture:** one Drive folder per bike, nested under a "Bike Photos"
folder inside the app's existing data folder (same `drive.file`-scoped
Drive access every other page already uses — the app still can't see
anything in the signed-in account's Drive that it didn't create itself).
Photos are served back through the app's own authenticated proxy route
rather than making any Drive file public, so a photo is exactly as private
as the rest of this session-gated app.

**New file: `lib/googleDrive.js` additions** (existing file extended, not
rewritten) — `ensureBikePhotosRootFolder`, `ensureBikeFolder`,
`findNamedFolder` (lookup-only, never creates — used by `list.js` so
browsing a bike with no photos yet doesn't create an empty folder as a side
effect), `listSubfolders`, `listImageFilesInFolder`, `createImageFile`,
`getFileMetadata`, `getFileMediaBuffer`, `trashFile` (soft delete).

**New files under `api/photos/`:**
- `folders.js` — GET, returns every bike-photo folder with its image count
  (used for the coverage check below).
- `list.js` — GET `?bike=<name>`, returns that bike's photos as
  `{id, url}` pairs.
- `upload.js` — POST `{bike, filename, mimeType, base64}`, validates every
  field (including rejecting a non-image `mimeType`), decodes and writes
  the file to Drive.
- `delete.js` — POST `{fileId}`; soft-deletes (trash, not permanent) —
  and, as a safety guard, first fetches the file's metadata and *refuses*
  (400) if its `mimeType` isn't an image, so a wrong/mistyped fileId can
  never trash a real JSON sheet file.
- `file/[fileId].js` — GET, the authenticated proxy: streams the actual
  image bytes back with the right `Content-Type` and a private cache
  header; 404s cleanly for a missing/trashed/non-image file.

**`bikephotos.html` changes:** removed the disconnected `scriptUrl` stub
entirely. Added `resizeImageForUploadB(file)` — every upload is resized
client-side (canvas, max 1600px longest edge) and re-encoded as JPEG
(quality 0.82) *before* being base64-encoded and posted, because Vercel
caps a serverless function's whole request body at 4.5MB on every plan
(confirmed against Vercel's current docs) and base64 inflates size by
~33% — an un-resized modern phone photo (often 3–8MB) would routinely blow
past that limit otherwise. Gallery load, upload, delete, and the "photo
coverage check" (which bikes are missing photos — now via
`/api/photos/folders`) all now call the real endpoints above instead of the
old stub, each with a `check401` handler so a session that's expired mid-use
surfaces the same "please refresh to sign in again" message every other
page's API calls already give.

**Tested at three levels, all against the real, unmodified source files:**
1. `lib/googleDrive.js`'s new functions (13/13) — against a from-scratch
   in-memory Google Drive API simulator (mocks only the
   `drive.files.{list,create,get,update}` surface actually used), since
   `googleapis` can't be installed in this sandbox and there's no real
   Google credential available here anyway. Covers folder create-once/
   reuse, per-bike folder isolation, lookup-without-creating, newest-first
   image ordering, exact-byte round-trip download, trash-removes-from-
   listing, and a bike name containing an apostrophe not breaking the Drive
   query.
2. `api/photos/*.js` route handlers (22/22) — same simulator, driving the
   real route files end-to-end via fake req/res objects with a fake
   `withDrive` auth wrapper. Covers every validation error, a full
   upload→list→count→download→delete round-trip with exact byte
   verification, `delete.js`'s mimeType safety check (confirmed a
   simulated JSON sheet file is refused and NOT trashed), 404s, and
   cross-bike photo-count isolation (two bikes' counts never bleed into
   each other).
3. `bikephotos.html` itself (15/15) — real headless-browser (Playwright)
   end-to-end test serving the actual unmodified file against a mocked
   HTTP backend: initial coverage check hits `/api/photos/folders` and
   correctly shows bikes as missing photos; selecting a bike hits
   `/api/photos/list`; uploading a real PNG through the file input runs it
   through the page's *actual* canvas resize/re-encode (confirmed the
   posted `mimeType` comes back `image/jpeg` and the filename normalized to
   `.jpg`, not the original PNG) and POSTs to `/api/photos/upload`;
   deleting POSTs to `/api/photos/delete` with the exact `fileId`; and a
   fresh page reload after upload+delete still shows correct net-zero
   coverage.

**One thing that can't be tested from this sandbox:** a real live Drive
OAuth upload. All three test levels above use a simulated Drive — Anton
still needs to do one real end-to-end check on the actual deployed app
after this is pushed (upload a real photo, view it, delete it) as the final
verification step no amount of mocking here can substitute for.

## ✅ DONE, tested, awaiting Anton's push — settings.html list-clutter
## follow-up (2026-08-14, same day, caught by Anton testing the panel live
## right after the push below)

Two small changes to the Reverse Transactions panel, both from Anton
watching the live "twse" test entries pile up in the list:

1. **No more separate "Reversed: ..." row.** `executeReversal()` used to
   log the reversal itself as a second, new `reverseTransactionEntry`
   entry (an audit trail) in addition to flipping `reversed:true` on the
   original entry. Anton pointed out this was pure duplication — the
   original entry's own `reversed`/`reversedAt` fields (shown as the green
   "Reversed" badge on that same row) already say everything the second
   row said. Removed that `logTransactionB(...)` call, and removed
   `logTransactionB` itself from settings.html entirely since nothing else
   there used it.
2. **Reversed entries drop out of the default view after ~24h.** Added
   `HIDE_REVERSED_AFTER_MS` (24 hours) to `entryMatchesFilter()` — an entry
   with `reversed:true` older than that is excluded from the default
   (no date filter active) recent list, so old settled reversals don't
   permanently clutter it. Nothing is deleted — searching an explicit date
   range that covers it still shows it, for when someone genuinely needs
   to dig up an old reversal.

**Tested:** extended the same Playwright end-to-end suite from the panel's
initial build (now 19/19) — added checks that reversing no longer creates
a second log entry (`txnRows.length` stays at the original count), and a
new scenario seeding an entry reversed 30 hours ago that's confirmed
hidden from the default view but reappears when explicitly searching the
date it happened on.

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
| bikephotos.html | Done | Done (real Drive integration) | **2026-08-14:** was "Out of scope" (uploadPhoto/deletePhoto need a live backend regardless of JSON migration) — now built and tested. Full Google Drive photo storage: one Drive folder per bike under a "Bike Photos" folder, `lib/googleDrive.js` extended with folder/file helpers, new `api/photos/{folders,list,upload,delete}.js` + `api/photos/file/[fileId].js` (authenticated proxy, photos never made public), client-side resize/re-encode before upload (Vercel's 4.5MB body cap). Tested 13/13 (Drive helpers) + 22/22 (API routes) + 15/15 (real headless-browser end-to-end against the actual file) — see full writeup at the top of this file. Still needs one real live Drive OAuth test from Anton post-push (can't be simulated here). |
| oilchange.html | Done | n/a (read-only page) | **Corrected 2026-08-14:** this row previously (wrongly) said "Writes: Done" — a full grep found ZERO `writeSheetJson(` calls anywhere in this file, and Code.gs has no `oilChange`-named write action either. It's a pure read-only dashboard (`getPartsDataFromJson`/`getBikeRentalStatusFromJson`, both reads) and always has been — there was never a write to port here. Documentation error only, not a functional gap. |
| parts.html | Done | Done | Turned out ALREADY PORTED in the cloud sandbox (dated 13/08/2026 in its own code comment) but never pushed — the exact bikes.html near-miss pattern, again. `getPartsDataFromJson`/`updateBikeRowJson` were already fully written and wired to the UI (`saveFields`/`performQuickSave`/`performSave`). Tested via `/tmp/parts_write_test.js` (existing thin test extended 2026-08-14 with: date/numeric/text/blank value-type coercion checks, clearing a field to blank actually clears it, an unknown field name is silently ignored rather than crashing, categoryRows/rates are populated from real Bike_Tax/rates_per_day data, and a malformed rates sheet reports a warning rather than throwing) — all pass. `readOdometerWithAI` correctly stays on the old disconnected path (AI vision call, no backend integration exists for this). Pushed to Mac, confirmed via md5 match (`b451b8a...`). |
| reply-assistant.html | Done | Done | `addContact` (`addContactFromJson`) is already ported and wired (line ~1212) — the "not yet audited" note was stale. `fetch(scriptUrl` sweep: 2 real calls remain, both confirmed AI-assist (`generateReplyDraft`, `readWhatsAppContactWithAI`) — correctly out of scope. |
| bike-name-audit.html | Done | Done | `fetch(scriptUrl` sweep (2026-08-14): 0 real calls (1 comment mention only) — the "1 site not yet audited" note was stale, nothing left here. |
| index.html | n/a | Out of scope (confirmed) | `createMonthSheetFromTemplate` (line ~243) is a TEMP/TEST button that creates a whole new monthly SHEET from a template — structural/month-rotation, not a row-level write against an existing sheet's data, genuinely a different concern from this migration. Recommend leaving as-is; flag to Anton for explicit confirmation before ever touching. |
| pricing.html | Done | n/a (read-only page) | Turned out ALREADY PORTED in the cloud sandbox (dated 13/08/2026 in its own code comment) but never pushed — same near-miss pattern as bikes.html/parts.html. `loadLiveRates()`/`getRatesDataFromJson()` were already fully written and wired up. Tested via new `/tmp/pricing_write_test.js`: real-data success path, fetch-failure path (confirmed `getRatesDataFromJson`'s internal try/catch means it never actually rejects, so loadLiveRates()'s outer `.catch` "Offline" text is effectively dead code in practice — the real failure message comes through the `.then()` branch instead; not a bug, just documented), the missing/never-written-file case (`rows: null`/`[]` reports a graceful warning, not a throw), a too-sparse rates block, and `isValidRatesTable`'s rejection of every malformed shape (missing day, wrong category count, NaN, string-typed number). All pass. Pushed to Mac, confirmed via md5 match (`1543d97...`). **2026-08-14 follow-up:** removed the leftover client-side login wall (redundant with nav.js's server-backed session gate) and added a "Number of Days" alternative to the Return Date picker — see full writeup near the top of this file. Tested 18/18 (real headless-browser end-to-end). |
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

## Calendar sync port (2026-08-18) -- built, NOT yet deployed/tested live

Full port of Code.gs's native Google Calendar integration (CalendarApp,
`syncCalendarForCustomerRow`/`syncDeliveryCalendarForContractRow`/reminders/
`createContactCustomerReminders`) onto the Vercel app, per Anton's explicit
ask: "I want the calendar to function exactly as it does here... other than
[a separate login], it should do exactly the same shit." Built end-to-end
without stopping for feedback, per Anton's own instruction that evening
("get as much of it done as you can without asking for feedback"). Not yet
exercised against a real Google account -- next session should treat this as
"needs live verification," not "done."

**New files:**
- `lib/googleCalendarAuth.js` -- a SECOND, independent OAuth2 flow (own
  scopes: `calendar` + `drive.readonly` + `userinfo.email`), completely
  separate from the staff Drive login. Token stored in `calendar_auth.json`
  in the app's Drive folder (same convention as `ai_keys.json`), read/written
  via the STAFF session's own Drive access -- see the file's header comment
  for the full "why," including why this account also needs `drive.readonly`
  (the headless daily cron has no browser/session to read booking data with,
  so this one connected account does double duty).
- `lib/googleCalendarSync.js` -- the ported sync logic: pure decision
  functions (`computeDueBackEventPlan`/`computeDeliveryEventPlan`/
  `computeContactReminderCandidates`, fully unit-tested, no network) plus
  thin Calendar-API-v3-calling wrappers. Change-detection (Code.gs's "note on
  the cell" trick) is now `extendedProperties.private.syncSignature` on the
  event itself. Color mapping confirmed against Google's own Apps Script
  reference docs (PALE_BLUE=1, YELLOW=5, ORANGE=6 [labeled "Tangerine" in the
  Calendar UI -- Code.gs's own `CalendarApp.EventColor.TANGERINE` reference
  isn't a real enum member and likely silently no-ops there; ORANGE/"6" is
  used here since that's clearly the intent], GREEN=10).

**Wired into (all try/catch'd, non-blocking, exactly Code.gs's own posture):**
`lib/customersWrites.js` (`customerIntakeFromJson`), `lib/bikesWrites.js`
(`closeBikeForExtendFromJson` + its own `customerIntakeFromJson` copy),
`lib/contractWrites.js` (`addContractFromJson`/`editContractFromJson`/
`cancelContractFromJson`/`markMatchingContractAsRentedFromJson`). All take an
optional `calendarCtx` param (`{drive, folderId, session}`) -- omitted
entirely by old call sites/tests, which keeps behaving exactly as before.

**Routing (Vercel Hobby 12-function cap is already maxed -- confirmed via
`api/` listing, no new files added):** calendar.html's 8 actions
(addCalendarReminder/editCalendarReminder/completeCalendarReminder/
listCalendarReminders/listDeliveryPickupLinks/setDeliveryPickupLink/
calendarConnectionStatus/disconnectCalendar) folded into
`api/contract/write.js`'s existing POST dispatch. The Calendar OAuth
connect/callback flow reuses `api/auth/login.js`/`api/auth/callback.js` (a
`?flow=calendar` branch + an `aa_oauth_flow` cookie tell the two flows
apart) rather than needing new files.

**Daily sweep (safety-net resync + Code.gs's nightly contact-reminder job,
combined into ONE run per Anton's own call that evening):**
`GET /api/contract/write?cron=dailySweep`, wired into `vercel.json`'s
`crons` (`"0 15 * * *"` = 22:00 Asia/Bangkok, matching Code.gs's own nightly
trigger hour -- confirmed Vercel Hobby only allows once-daily cron, so this
also replaces Code.gs's separate 15-minute sweep triggers; the real-time
write hooks above cover what those sweeps mostly existed to catch anyway).
Authenticated via a `CRON_SECRET` env var checked against the
`Authorization: Bearer` header Vercel sends its own cron requests with --
**not yet set**, so the cron endpoint will 401 until it is. The cron handler
also needs `CALENDAR_AUTOMATION_REFRESH_TOKEN` (a copy of the connected
calendar account's refresh token, shown once on calendar.html right after
connecting) as an env var -- **not yet set either**; without it the cron
just logs "skipped, not configured" and does nothing, harmlessly.

**Manual steps still needed before ANY of this actually works, none of which
this session could do:**
1. Google Cloud Console: add `calendar` + `drive.readonly` scopes to the
   OAuth consent screen for the existing client (GOOGLE_CLIENT_ID/SECRET are
   reused, not a new Cloud project).
2. Click "Connect Calendar" on calendar.html (once deployed) -- for testing,
   sign in as `aascooters1@gmail.com`.
3. Copy the refresh token calendar.html shows once after connecting into a
   new `CALENDAR_AUTOMATION_REFRESH_TOKEN` Vercel env var, and set a
   `CRON_SECRET` env var (any random string) -- both needed only for the
   daily sweep, not for the real-time sync, which works as soon as step 2 is
   done.
4. Share the "AA Scooters App Data" Drive folder (Viewer is enough) with
   whichever email got connected in step 2 -- required ONLY for the daily
   cron sweep to read booking data headlessly; the interactive sync doesn't
   need this.
5. Redeploy so the new `crons` entry in `vercel.json` actually registers.

**Explicit scope trims (flagged, not silently dropped):** the
"customer-facing bike model via Bike Tax lookup" refinement Code.gs's
`customerFacingBikeModelServer_` has isn't ported (no server-side Bike Tax
lookup exists anywhere in this app yet) -- WhatsApp reminder messages here
always use the shortened/mangled internal bike name, Code.gs's own fallback
case. `TestCalendarScript.gs` (the actual script behind calendar.html's OLD
test scriptUrl) was never obtained -- this port was built from Code.gs's
production logic instead, so if that test script had drifted from
production in some way, this won't match it exactly (matches PRODUCTION
Code.gs exactly, which was the more important target anyway).

**Testing:** 54 unit tests against the pure decision logic + a small
in-memory fake Calendar API client (color rules, all-day-vs-timed, the
extendedProperties change-detection skip, create/update/delete branches,
reminder CRUD, dailySweep), plus 9 regression tests confirming
`customersWrites.js`/`bikesWrites.js`/`contractWrites.js` still behave
identically with `calendarCtx` omitted and fail gracefully with it present
but disconnected. All 63 passing. Every edited/new file's write was verified
held via a fresh grep (not a cached read) after writing, per this file's own
"never trust a successful write on its own" rule above. No live Google
Calendar API call has been exercised (sandbox has no `googleapis` package
installed and no real credentials) -- that first real end-to-end test can
only happen once Anton does the manual steps above.

🔴 No `Code.gs` changes in this entry -- Code.gs's own calendar system is
untouched and keeps running the live production site exactly as before.

**Fix, same evening (2026-08-18), found via live testing:** Anton connected
`aascooters1@gmail.com`, then added a Pending contract and separately rented
one via contract.html -- neither produced a calendar event. Root cause: 
`lib/contractWrites.js` has its OWN separate copy of `customerIntakeFromJson`
(the actual "Rent" action contract.html's doRent flow calls -- distinct from
`lib/customersWrites.js`'s and `lib/bikesWrites.js`'s own copies, per this
project's no-shared-JS convention). The first pass wired the calendar hook
into `addContractFromJson`/`editContractFromJson`/`cancelContractFromJson`/
`markMatchingContractAsRentedFromJson` in that file, but missed this
`customerIntakeFromJson` copy -- exactly the function that creates the
customer-sheet row a 🛵 due-back event needs. Fixed by adding the same
pre-write sync hook used in the other two files' copies. Verified with 3 new
end-to-end regression tests (against the real files, with a stubbed-but-
functional fake Calendar API behind a "connected" fake Drive) proving:
`addContractFromJson` with `deliverToHotel:'Yes'` really does create a 🏨
event (this path was NOT broken -- tested clean even before this fix, so if
a delivery event still doesn't show up after redeploying, check that the
contract actually had "Deliver to hotel" toggled on with a delivery time
set, not just added -- both are required, matching Code.gs's own rule
exactly), and the previously-broken doRent `customerIntakeFromJson` now
creates the due-back event too. All 12/12 regression tests + the original
54/54 pass. This fix is included in the same files as the original entry
above -- no additional files touched.

**Second fix, same evening (2026-08-18) -- the REAL root cause, found by
reading Vercel's function logs directly:** after the `doRent` hook fix above
deployed, Anton reported renting a pending contract STILL produced no
calendar event, with no visible error either. Re-grepped the deployed file
to rule out a silent revert (per this file's/CLAUDE.md's own documented
risk) -- the fix code was genuinely present and intact, so the bug had to be
a live-runtime issue, not a redeploy/revert issue. Walked Anton through
Vercel's Logs tab (Observability -> Logs -> filter `/api/contract/write`,
expand a request, check "Contains Console Level" -> Warning) to get real
server-side evidence instead of guessing further, which surfaced the actual
line: `[googleCalendarSync] due-back sync failed: Missing time zone
definition for start time.`

Root cause: every TIMED (non-all-day) event this file builds --
`planToEventResource`'s `dateTime` branch (due-back events with a specific
return time, and every 🏨 delivery event, which is always timed), plus both
`addReminder` and `editReminder` -- set `dateTime` but never set the
sibling `timeZone` field. Apps Script's `CalendarApp` never needed this (it
implicitly used the script's own timezone), but the real Calendar API v3
**rejects** a `dateTime` with no UTC offset/`Z` and no `timeZone` field, so
every one of these was failing 100% of the time in production. Because
every calendar-sync call site wraps its own failure in a non-blocking
try/catch (by design -- a calendar hiccup should never break the booking
write it's piggybacking on), the booking always saved fine and the failure
was swallowed silently -- worse, `contractWrites.js`'s own
`customerIntakeFromJson` catch block (see the first fix above) only pushes
into a `warnings` array, which the frontend's `ctDispatch`/`doRent` path
(the overnight optimistic-UI save-pipeline engine) never actually reads or
surfaces to the user at all, so there was no alert either -- this made the
failure fully invisible from the browser, only visible in Vercel's own
logs. This is also almost certainly the same root cause behind the earlier
"delivery event didn't show up" complaint, not a toggle/time-not-set issue
as originally guessed.

Fixed in `lib/googleCalendarSync.js`: added a `CALENDAR_TIMEZONE = 'Asia/
Bangkok'` constant and wired `timeZone: CALENDAR_TIMEZONE` into every
`{ dateTime: ... }` block (`planToEventResource`'s timed branch, used by
both due-back and delivery events; `addReminder`; `editReminder`). All-day
events (`{ date: ... }`, no `dateTime`) are unaffected -- they don't require
`timeZone`.

Also hardened the test harness itself, since this bug got past all 66
existing tests without tripping a single one -- the fake Calendar API stub
(`stubs/node_modules/googleapis`) accepted any request shape, so a real API
rejection rule was never being checked. Added `assertValidEventResource`
to the fake `events.insert`/`events.update`, replicating this one real
validation rule (`dateTime` requires a sibling `timeZone`) so this exact bug
class is a red test from now on, not just a silent gap. Re-ran both
harnesses against the stricter stub after the fix: 54/54 + 12/12 still
green, confirming the fix is what actually satisfies the real API's
requirement, not just a coincidence of the old permissive stub.

**Third report, same evening (2026-08-18), still open:** after the timezone
fix above deployed, Anton confirmed the 🏨 delivery event and 🛵 due-back
event both now appear correctly -- but reported that renting a Pending
contract with a delivery event leaves the OLD delivery event on the
calendar instead of removing it (two events now visible: the stale
delivery one alongside the new due-back one). `computeDeliveryEventPlan`'s
own `!isPending -> action:'delete'` branch is supposed to handle this via
`markMatchingContractAsRentedFromJson`'s calendar hook (added in the first
fix above), and a new end-to-end regression test built to reproduce this
exact sequence (create a Pending+delivery contract, then rent it via the
same `customerIntakeFromJson` "Rent" flow, same name+bike) PASSES against
the real code -- `action=delete` is computed correctly and the row's
calendarEventId column does get cleared in the test. So the deletion logic
itself is not obviously wrong; something specific to Anton's live data
(most likely candidate: a bike-name mismatch between the Contract row's
stored bike field and whatever the Rent form actually sent, tripping
`bikeNamesMatchForTaxLookup`'s match check silently) is the leading
hypothesis, unconfirmed.

Added TEMP diagnostic logging (mirroring how the timezone bug itself was
found) rather than guess further: `lib/googleCalendarSync.js`'s
`syncDeliveryEventForContractRow` now logs the computed plan
(`action`/`existingEventId`/`status`) every time it runs, and
`lib/contractWrites.js`'s `markMatchingContractAsRentedFromJson` now logs
when a Pending row can't be matched at all, when a Pending row matches by
name but fails the bike check, and when `getCalendarClient()` itself
returns null. Next step: Anton reproduces the delivery-then-rent sequence
live once more and checks Vercel's logs (Observability -> Logs -> filter
`/api/contract/write` -> Warning level) for these new lines -- whichever
one fires (or doesn't) will point directly at the real cause. Remove this
logging once confirmed fixed. New regression test count: 13/13 (was 12),
plus the original 54/54, still green.

**Update, same evening (2026-08-18) -- narrowed further via Vercel logs,
still open:** Anton deployed the diagnostic-logging commit and reproduced
live with a fresh test bike ("Gt black 1"). The logs answered the question
cleanly: the CREATE request logged `action=create, existingEventId=(none),
status="Pending"`, and the later RENT request logged `action=delete,
existingEventId=i2loojeom8p03tlg59lubqje58, status="Rented"` -- confirming
`markMatchingContractAsRentedFromJson`'s match AND
`computeDeliveryEventPlan`'s decision logic are BOTH working correctly live,
not just in the sandbox test. Yet the delivery event stayed on the
calendar. This rules out both original hypotheses (silent name/bike
mismatch, plan computing something other than delete) and points
somewhere more specific: the actual `calendar.events.delete()` call inside
`applyDeliveryEventPlan` must itself be failing -- and that exact call was
wrapped in a bare `try { ... } catch (err) { /* best-effort */ }` with NO
logging at all, so whatever real error Google's API is returning (auth,
permissions, a bad/stale event id, quota, anything) had nowhere to surface
from. Found and fixed 3 other identical silent-catch spots in the same
file while in there (`applyDueBackEventPlan`'s own delete branch, its
all-day/timed-swap delete-then-recreate branch, and the daily sweep's
stale-contact-reminder cleanup) -- same risk, same fix, added
`console.warn` with the real `err.message` to all four. 54/54 + 13/13
still green. Next step: Anton redeploys and reproduces once more; whatever
error message these new lines print is the actual root cause.

**Resolved, same evening (2026-08-18):** before even redeploying the
error-logging commit above, Anton reloaded calendar.html and the stale
"Gt black 1" 🏨 delivery event had disappeared on its own -- the delete
call evidently DID succeed, it just took a while to actually clear from
Google Calendar's own view/index. Likely the same flavor of "not
immediately consistent" propagation delay this project has already hit on
the Drive side (see `lib/googleDrive.js`'s `findFileInFolderWithRetry`
comment) -- not a real bug in this app's code. The error-logging commit
above was still pushed regardless (purely additive, zero behavior change,
free visibility if a genuine delete failure ever does happen). No further
action needed unless a stale delivery event is seen NOT to clear after a
longer wait (a few minutes) -- if that happens, check Vercel's logs for
the new `delivery event delete failed for eventId=...` line this commit
added, which would now show the real reason.

## ✅ DONE, tested, awaiting Anton's push — "Add to Home Screen" icon across
## every page (2026-08-18)

Anton wants a proper icon when he saves any of these pages to his Android
home screen as a shortcut (currently falls back to a generic browser
glyph). Added to all 18 HTML pages' `<head>`: `<link rel="icon">`,
`<link rel="apple-touch-icon">`, `<link rel="manifest" href="/manifest.json">`,
plus `theme-color`/`apple-mobile-web-app-capable`/`apple-mobile-web-app-title`
meta tags (`pricing.html` already had those three, so only the icon/manifest
links were added there). New `manifest.json` at the project root declares
name/short_name/theme/background colors and one icon entry.

Icon source: reused the exact same externally-hosted logo `nav.js`'s own
header already links to (`https://scooterrentalchiangmai.com/wp-content/
uploads/2025/02/cropped-cropped-logo-3333-270x270.png`, a 270x270 square
PNG — the highest-res version of the AA Scooters logo actually published
on the live site, found via that site's own `msapplication-TileImage` meta
tag). Deliberately did NOT download/self-host a local copy: manifest icons
and `<link>` icon hrefs can point at any absolute URL, so pointing straight
at the already-live asset avoids adding an image file to this repo (and
avoids the file-revert risk this project's own CLAUDE.md flags for
image/binary assets) at zero functional cost — same trust boundary this
app already accepts by loading that URL in `nav.js`.

Also removed `pricing.html`'s OLD `<!-- PWA Manifest inline -->` script
block, which built a throwaway `Blob` URL manifest at runtime with a
generic 🏍️-emoji-on-orange-square placeholder icon (own comment called
this out already) and was never referenced by any other page -- replaced
by the same real static `manifest.json` link every other page now uses,
so `pricing.html`'s "Add to Home Screen" icon now matches the rest of the
site instead of showing the placeholder.

No `Code.gs` involved -- plain static file changes, so no Apps Script
redeploy needed, just the normal Vercel deploy on push.

## ✅ DONE, awaiting Anton's push — overnight bugfix pass, all 6 real bugs
## from the 2026-08-18 QA report (2026-08-19)

Ran unattended overnight per Anton's request ("fix everything, no
questions, I'm going to bed"). Full detail + code-level reasoning for each
fix is in `TESTING.md`'s "Fix pass (2026-08-19, overnight, unattended)"
section, right under the bug report it responds to -- this entry is just
the short version. Bug #7 (possible wrong contract date) was left alone,
per its own note in BUGFIX_HANDOFF.md -- never got a clean repro, and this
session had no logged-in browser access to attempt one.

1. **Cash-sheet-drift, `lib/accountsWrites.js`** -- fixed. Added
   `locateCashSummaryBlock()`, which finds the "income" and "total cash"
   summary rows independently by their own labels, and made
   `deleteCashRowFromJson`'s row-shift refuse to cross that boundary
   (previously it had no idea where the summary block was at all).
   Reproduced the original bug and confirmed the fix against the real
   `cash.json` data with a standalone Node harness.
2. **Bike photos 404** -- no code change. `api/photos/[...path].js` and
   `api/contracts/[...path].js` already look correct on disk. Live
   testing against the deployed site found every 1-segment sub-route
   (`/list`, `/folders`, `/documents`) correctly 401s (proving those
   functions ARE deployed), but every 2+-segment sub-route (`/file/<id>`,
   even a made-up `/list/extra`) hits a genuine Vercel-platform 404 --
   exactly the signature of the LIVE deployment still running an older,
   non-catch-all version of these two functions. Likely just needs
   tonight's deploy to go out; re-test after, and if still broken, check
   the Vercel dashboard's Functions tab directly (this session's Vercel
   connector didn't have access to this specific project).
3. **Stuck "Saving…" indicator** -- fixed defensively. Added a 20s
   `AbortController` timeout to both `contract.html`'s `ctDispatch` and
   `bikes.html`'s `bkDispatch`, so a hung fetch (the likely cause, given
   the write always completed correctly on the server) now resolves as a
   normal reviewable failure instead of leaving the UI stuck forever.
   Idempotency-safe on retry either way.
4. **Autocomplete double space** -- fixed, and root-caused to dirty
   source data, not the fill code: `data/Parts_and_Oil_change.json`'s
   "Bike" column genuinely has entries like `"Gt  black 1"` (double space
   baked in). Added `.replace(/\s+/g, ' ')` after `.trim()` everywhere
   this column becomes a names list -- contract.html, oilchange.html,
   customers.html, and bikes.html's Swap search (all 5 read sites, not
   just the 2 the QA pass happened to catch).
5. **Extend "Amount paid" concatenation, `bikes.html`** -- fixed. Added
   select-all-on-focus to the Amount-paid input so a keystroke replaces
   the auto-filled figure instead of inserting into it.
6. **ServiceWorker console exception, `pricing.html`** -- fixed by
   removing the dead `blob:` service-worker registration entirely (it
   could never have worked in any browser -- not a regression). Left a
   comment explaining why a real `/sw.js` wasn't used instead: a working
   cache-first SW would risk staff seeing stale cached pages after future
   fixes ship.

No `Code.gs` involved anywhere in this pass -- confirmed at the start that
this app is entirely JSON/Drive-backed with no live Apps Script dependency
left except the already-disconnected "Bugs & Features" legacy feature.
**None of this pass's fixes were verified live in the browser** (no
Anton-equivalent login available this session) -- re-test all 6 after
deploying.

## ⚠️ Bug #2 (bike photos 404) was STILL BROKEN after deploy 808533e --
## now root-caused and actually fixed, awaiting Anton's push (2026-08-19,
## morning)

Anton confirmed 808533e (last night's fix pass) deployed live and asked
for all 6 fixes to be live-verified. Full detail in TESTING.md's
"Live-verification pass (2026-08-19, morning)" section; short version:

- **Confirmed live and working:** cash-sheet-drift (#1, spot-checked),
  autocomplete double space (#4, byte-level DOM check, zero double
  spaces found), Extend amount concatenation (#5, watched the field
  auto-fill, pre-select, and cleanly get overwritten), ServiceWorker
  console exception (#6, zero related console messages on page load).
- **Not force-reproducible either way:** stuck "Saving…" indicator (#3)
  -- still just the defensive 20s timeout fix from last night, unchanged.
- **Was still broken, now actually fixed:** bike photos / contract file
  404 (#2). Last night's "just needs deployment" diagnosis was wrong --
  confirmed live against the deployed, logged-in site that
  `/api/photos/file/<id>` and `/api/contracts/file/<id>` still hit a
  genuine Vercel-platform 404, for ANY id (even a fake single-char one),
  while the exact same 1-segment sub-routes on both catch-alls work fine.
  Proved via the `x-vercel-id` response header that the 2+-segment
  requests never reach the function at all (no `iad1` region segment in
  the id) -- this is Vercel's own router failing to recognize the
  `[...path].js` catch-all convention as matching more than one path
  segment, not an app bug. **Fix:** added explicit `rewrites` to
  `vercel.json` pointing `/api/photos/:path*` and `/api/contracts/:path*`
  at their respective `[...path]` functions (Vercel's own documented
  workaround for exactly this), plus defensive parsing in both handlers
  so `req.query.path` is normalized whether Vercel hands it through as an
  array or a joined string. This is now the one part of the whole punch
  list still needing a push + re-deploy + re-test.

**Files touched this pass:** `vercel.json`, `api/photos/[...path].js`,
`api/contracts/[...path].js`. Every file re-read back from the real
device and grepped for the `2026-08-19` marker comment after writing,
per CLAUDE.md's standing instruction.

## 🚀 ROLLOUT (2026-08-20) — shipped with bug #2 (bike photos / passport
## viewing 404) deliberately deprioritized

Anton decided to roll out with the photo/passport-viewing 404 left
unpushed (not urgent) rather than block on it — see project memory
`aa-scooters-rollout-2026-08.md` for the full rationale and status of all
7 original bugs at rollout time. The `vercel.json` rewrite fix from the
pass above is still sitting on disk, written and verified, just not
committed/pushed. Don't chase it proactively; Anton will ask when ready.

## 📋 BACKLOG (queued 2026-08-20, not started) — reproduce the spreadsheet
## from JSON data

Anton wants an option to regenerate the original Excel spreadsheet
(`AA Scooter Account 2026.xlsx`, sits in the project root one level above
`vercel-site/`) FROM the live JSON data (the same JSON files this app
reads/writes via `/api/data/<sheet>`), rather than the spreadsheet being
the source of truth it used to be back when `Code.gs` drove everything.
Explicitly deferred — discussed in the same conversation as the daily
JSON backup feature (see the entry right below/above, whichever lands
first) but Anton was clear this one is NOT being worked on yet, just
wants it on record so it isn't lost. No design discussion has happened
yet for this one — start there next time it's picked up (what triggers
a regenerate — on demand button vs. scheduled; which sheet tabs map to
which JSON files; whether formulas/formatting need to be preserved or
it's a plain data dump; where the generated file should land — Drive,
download, or written back into the project folder).

## ✅ DONE, tested, awaiting Anton's push — daily/manual JSON data backups
## + restore-from-backup (2026-08-20)

Built per Anton's request: a real point-in-time backup/restore on top of
the existing "Reset data from latest deploy" button (which only restores
the static SEED snapshot, never real live data). New `lib/backups.js` +
extended `api/admin/reset.js` + small additions to `nav.js`/`settings.html`.

**Design decisions made with Anton before building (see conversation):**
- Restore is always whole-dataset (same "replace everything" shape as the
  existing reset button), not per-sheet -- Anton: "we'll just do the
  whole sheet... you can reenter what's happened."
- Retention: 30 days rolling, oldest auto-pruned (soft-deleted, same as
  every other delete in this app) after each successful backup.
- Storage: a `Backups/<timestamp>/` subfolder tree inside the app's own
  Drive folder, plain per-file copies (via `drive.files.copy`, not a zip)
  -- fast, and restore just reads them back through the exact same
  `readJsonFile`/`writeJsonFile` path every other save already uses.
- **No new cron, no new stored automation credential.** Traced how the
  EXISTING daily cron (the calendar sweep) authenticates headlessly and
  found it only carries `drive.readonly` scope -- it literally can't
  write anything, which likely also means that cron's own occasional
  customer/Contract write-back has been silently failing this whole time
  (a separate, not-yet-investigated finding, flagged to Anton, not fixed
  here). Setting up a second stored write-scoped credential just for this
  was considered and explicitly rejected in favor of piggybacking on
  whichever staff Drive session is already logged in: `nav.js` now fires
  a silent "has it been a while since the last backup" check once per
  page load AND on an hourly timer (Anton uses the app open in a phone
  browser tab for days at a stretch without reloading, so a load-only
  check would miss every day after the first). If nobody's logged in for
  a few days, nothing's changing in the live data either, so nothing is
  lost by not backing up those days -- confirmed with Anton this is fine.
- Manual "Backup now" button in Settings, for on-demand snapshots and
  testing, plus a restore list showing the last up-to-30 backups
  (date/time + Auto/Manual/Pre-restore tag) with a Restore button per row.
- Restoring a backup auto-snapshots the CURRENT live data first (tagged
  `pre-restore`) before overwriting anything -- a restore is itself
  always undoable. Clears `transactionLog.json` afterward, same reasoning
  as the existing reset button (stale reversible-entry pointers would
  silently corrupt the restored data if reversed).
- Excludes `ai_provider.json`/`ai_keys.json`/`calendar_auth.json` from
  backup/restore scope -- config/credentials, not "data," and restoring
  an old one over a newer one could silently break a working integration.
  Every other `.json` file in the app folder (root + every year
  subfolder) is included by default, so a brand-new sheet added later is
  automatically covered without this needing an update.

**Deliberately NOT a new `/api/` file** -- this project already hit
Vercel Hobby's 12-Serverless-Function cap once (the still-unpushed
bike-photos-404 saga -- see the entries above). All 4 new actions
(`backupCreate`/`backupEnsureDaily`/`backupList`/`backupRestore`) are
dispatched via an `action` field in `POST /api/admin/reset`'s body --
same file, same URL, backward-compatible with the existing button's
body-less POST (still runs the unchanged legacy reset path).

**Tested (standalone Node harnesses, no real Drive access needed, per
this project's standing "every write action needs a vm-run test harness"
rule):** a fake in-memory Drive client (files.list/create/copy/get/update)
exercising `lib/backups.js` directly -- source collection excludes config
files and includes year-folder files correctly; backup copies match
source content byte-for-byte; `listBackups` sorts newest-first;
`ensureDailyBackup` correctly no-ops when recent and creates when stale
(simulated via rewritten `createdTime`, not a real 20h wait); `pruneOldBackups`
trashes only >30-day-old entries; `restoreBackup` restores both a global
file (`cash.json`) and a year-scoped file (`August_2026.json`, correctly
inferred back into the `2026` folder from its filename suffix) over
deliberately-mutated live data, auto-snapshots first, clears the
transaction log. A second harness drives the REAL `api/admin/reset.js`
handler end-to-end (fake `withDrive`/Drive, real `lib/backups.js`) to
confirm the dispatch wiring itself: GET still 405s, an empty/no body
still runs the legacy reset unchanged, each of the 4 new actions responds
correctly, a missing `backupId` on restore is a clean 400 (not a crash),
and an unknown action is a clean 400 too. All passed.

No `Code.gs` changes -- this app is fully JSON/Drive-backed, same as
every other pass in this project recently.

**Files touched:** `lib/backups.js` (new), `api/admin/reset.js`,
`nav.js`, `settings.html`. Every file re-read back from the real device
after writing and grepped for a distinctive marker before being reported
here as done, per CLAUDE.md's standing instruction.

**Not yet done:**
1. Anton reviews the diff and pushes (git commands below).
2. Live smoke test once deployed: click "Backup now" in Settings, confirm
   a `Backups/<timestamp>` folder appears in Drive with the expected
   files; leave a tab open and confirm the hourly check doesn't spam
   duplicate backups; try a real Restore on a throwaway/test backup and
   confirm the pre-restore safety snapshot shows up too.

```
cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
git status                                  # review everything below first
git add lib/backups.js api/admin/reset.js nav.js settings.html PROGRESS.md
git commit -m "Add daily/manual JSON data backups + restore-from-backup

Piggybacks on the existing staff Drive session instead of a new cron/
credential -- see lib/backups.js and PROGRESS.md for the full design."
git push
```

## Backup feature: fixed duplicate "AUTO" backup race condition

**Status: DONE, tested, awaiting Anton's review + push.**

Anton caught this live (screenshot showed two "AUTO" backups created at
the same timestamp) and asked whether it would recur daily or was a
one-off. It was a real, recurring race condition in `ensureDailyBackup`
(`lib/backups.js`) -- traced and fixed the same session.

**Root cause:** the hourly `checkDailyBackup()` ping from `nav.js` fires
independently from every open tab/device. If two land in the same
window (e.g. two staff phones both idle-open past the 20h threshold),
both requests can reach `ensureDailyBackup` before either one's backup
has been created, so both see "no recent backup" and both proceed.

**First fix attempt (superseded):** re-used this app's existing
`writeJsonFile(expectedModifiedTime)` -> `ConflictError` pattern to
"claim" a new `backupLock.json` file, the same optimistic-concurrency
check used everywhere else in the app. A concurrency test (firing two
`ensureDailyBackup()` calls at once against a fake Drive) proved this
insufficient: both concurrent reads capture the same pre-write
`modifiedTime`, so both compare-checks pass and both create a backup --
because Drive (or at least this app's helper) has no true atomic
compare-and-swap, only "did the file change since I last read it," which
isn't enough when both reads happen before either write.

**Actual fix:** replaced the compare-and-swap with a claim/wait/verify
tiebreaker that doesn't depend on Drive-level atomicity at all --
`ensureDailyBackup` writes `backupLock.json` with a random nonce
(`claimId`), waits a fixed 300ms settle delay, then re-reads the lock
file fresh. It only proceeds to create a backup if its own `claimId` is
still the one stored -- if a second concurrent caller wrote after it,
whoever's write landed last on Drive's side is what both readers will
see, so at most one of them matches its own nonce. `backupLock.json` was
added to `BACKUP_EXCLUDE_FILENAMES` so it never gets swept into an
actual backup.

**Tested:** the same concurrency test (`Promise.all` of two
`ensureDailyBackup()` calls in steady state) now passes -- exactly 1 of
2 creates a backup, every time, across repeated runs. Added a second
test for the "very first backup ever" case (fresh app folder, no
pre-existing `backupLock.json`) -- the first fix attempt hadn't actually
been proven safe here either, and it wasn't: same nonce tiebreaker,
exactly 1 of 2 concurrent first-ever calls wins. Re-ran the full
existing backup test suite afterward -- all still passing (one
downstream test's hardcoded count had to become relative instead of
fixed, since the new concurrency test itself now creates an extra
backup as a side effect of proving the race is fixed).

**Files touched:** `lib/backups.js` only (`ensureDailyBackup`'s internals
plus the `BACKUP_EXCLUDE_FILENAMES` addition). Re-read back from the
real device and grepped for `LOCK_SETTLE_MS` before being reported here
as done, per CLAUDE.md's standing instruction.

```
cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
git status                                  # review the diff first
git add lib/backups.js PROGRESS.md
git commit -m "Fix race condition causing duplicate auto backups

Nonce + settle-delay + re-read tiebreaker instead of a compare-and-swap
Drive can't actually guarantee -- see lib/backups.js and PROGRESS.md."
git push
```

(Superseded by the single combined push below -- `lib/backups.js` picked up
more changes right after this, so there was no separate push of just the
race fix. No need to run the block above.)

## Updated bundled seed JSON from the new spreadsheet export + backup bulk-delete

**Status: DONE, tested, awaiting Anton's review + push.**

Two changes bundled into one push per Anton (both needed a push anyway,
no reason to make him do it twice).

### 1. Seed JSON refreshed from `AA Scooter Account 2026 2.xlsx`

Anton uploaded an updated export of the live spreadsheet (the one the old
Google Sheets/Code.gs system still runs on) and asked for the bundled
`/data/*.json` seed -- what the "Reset data from latest deploy" button in
Settings pushes to Drive -- to be refreshed from it, so that clicking
Reset brings the new app's data up to date with the old system ahead of
final cutover.

`export_to_json.py` (referenced in old code comments as the tool that
originally built this seed) isn't actually in the project folder, so this
was rebuilt from scratch against the existing seed JSON's own format as
the spec, verified sheet-by-sheet against `_manifest.json`'s row/col
counts before touching anything live:

- **Main sheets** (customer, Contract, cash, Bike Tax, bikes, checklist,
  Operation, Parts and Oil change, rates per day, waiting list,
  investment, Contacts, bugs, and the 9 month sheets incl. template) --
  a straight `openpyxl` grid dump (`data_only=True`, header row included
  as row 0, dates/times converted to the same ISO-string format the
  existing files already use). Row/col counts came out identical to the
  current manifest for every single sheet; real content differences
  confirmed anyway by diffing old vs. new row-by-row (customer: 19 of
  1317 rows changed -- new returns/extensions/dates; cash: 17 of 1357;
  bikes: 27 of 1064 -- so this is genuinely fresher data, not a no-op
  upload).
- **Notes sidecars** (`customer_notes.json`, `Contract_notes.json`,
  `July_notes.json`, `August_notes.json`) -- these turned out NOT to be
  spreadsheet data in the way they look; `lib/customersWrites.js`/
  `contractWrites.js`/`bikesWrites.js` use this sidecar shape
  (`[row, col, text]`) for BOTH the human-facing ledger note (col 2) AND
  app-internal idempotency-guard markers (col 3, col 90 on
  customer_notes) that only ever exist from live app usage, never from
  the spreadsheet. Checked directly: the xlsx's own cell comments (Excel/
  Sheets "notes" attached to specific cells), read via `cell.row`/
  `cell.column`/`cell.comment.text`, match the EXISTING customer_notes.json's
  `[row, col, text]` triples exactly, value-for-value, on the entries
  that already existed (e.g. row 302/col 2's "Cool 1 -- 02/06/2026 to
  20/07/2026..." note) -- confirming this app's ledger-note column is a
  direct, faithful port of the original spreadsheet's own cell comments,
  using the same 1-indexed row/column numbering. So these 4 files were
  regenerated the same way (extract every cell comment per sheet), which
  naturally produces ONLY ledger-note-shaped entries -- no idempotency
  markers ride along, since those were never real spreadsheet comments in
  the first place, and any old ones are tied to row numbers that no
  longer mean anything once `customer.json`/`Contract.json` are replaced
  wholesale. `Contract_notes.json` picked up one genuinely new comment
  (dated 15/08/2026, after the old seed's snapshot) this way, which is
  exactly the kind of freshness this update is for.
  - `bikes_notes.json` is a different thing again -- `[bikeName, jsonMetadata]`
    pairs tracking historical sold-bike info, keyed by name not row
    number, with zero corresponding cell comments in the "bikes" sheet
    (checked: 0 comments there). Left untouched, not part of this
    regeneration -- nothing to derive it from in the spreadsheet, and
    it's not row-position-dependent so the customer.json/Contract.json
    replacement doesn't invalidate it the way it would the other 4.
- `_manifest.json` regenerated alongside (same row/col counts as before,
  confirmed above).

**Not tested against the live app yet** -- that's the next step once
Anton pushes/deploys and clicks Reset: compare the new app against the
old live system page-by-page (two browser tabs) to confirm everything
matches before cutover.

### 2. Bulk-delete backups (checkboxes + "Delete selected") in Settings

Anton asked for a way to clear out old backups himself rather than
waiting on the 30-day automatic prune (`pruneOldBackups` in
`lib/backups.js`, unchanged, still runs after every backup creation).

- `lib/backups.js`: new `deleteBackups(drive, backupIds)` -- trashes
  (soft-delete, same as the automatic prune, recoverable from Drive's own
  trash) each id in the array, independently try/catched so one bad/
  already-gone id doesn't abort the rest of the selection.
- `api/admin/reset.js`: new `{ action: 'backupDelete', backupIds: [...] }`
  dispatch case (still the same endpoint, still no new `/api/` file --
  see that file's own header comment on why). 400s cleanly on a missing/
  empty/non-string-array `backupIds` rather than crashing.
- `settings.html`: a checkbox on each backup row (`.backup-item-checkbox`),
  a "Delete selected" bar above the list showing the current count and
  disabled until something's checked, and a confirm modal
  (`#backupDeleteBackdrop`) using the same mousedown+click backdrop-guard
  pattern as every other modal in this project (CLAUDE.md's standing
  rule) so a mid-drag text selection that releases over the backdrop
  can't accidentally close it.

**Tested:** extended the existing `api/admin/reset.js` dispatch harness
(`test_dispatch.js`) with `backupDelete` cases -- missing/empty/non-string
`backupIds` all 400 cleanly; deleting real backups removes them from a
subsequent `backupList`; a mix of one real id + one bogus id still
deletes the real one and reports the bogus one as an error instead of
failing the whole request. All passing. `settings.html`'s new script
block re-checked with `node --check` for syntax, and every new element id
it references confirmed to exist exactly once in the HTML.

**Files touched:** `lib/backups.js`, `api/admin/reset.js`,
`settings.html`, every file in `data/` except `bikes_notes.json`
(unchanged, see above). Every changed file re-read back from the real
device after writing, per CLAUDE.md's standing instruction.

**Not yet done:**
1. Anton reviews the diff and pushes (git commands below -- this is the
   combined push for both changes above, plus the earlier race-condition
   fix which hadn't been pushed yet either).
2. Anton clicks "Reset data from latest deploy" in Settings once deployed.
3. Browser-compare the new app against the old live system, page by page,
   to confirm parity before cutover.
4. Live smoke test of backup bulk-delete: select a couple of test backups
   in Settings, delete them, confirm they drop out of the list.

```
cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
git status                                  # review everything below first
git add lib/backups.js api/admin/reset.js settings.html data/ PROGRESS.md
git commit -m "Refresh seed data from updated spreadsheet export; add backup bulk-delete

Seed JSON (data/*.json) rebuilt from AA Scooter Account 2026 2.xlsx --
main sheets are a straight grid dump, the 4 notes sidecars are rebuilt
from the xlsx's own cell comments (verified to match the existing
ledger-note format exactly). bikes_notes.json is untouched (not
spreadsheet-derived). See PROGRESS.md for the full breakdown.

Also adds checkbox bulk-delete for backups in Settings (lib/backups.js's
new deleteBackups(), a new backupDelete action on api/admin/reset.js,
and the UI in settings.html) -- bundled into this same push per Anton."
git push
```

### 3. Parallelizing the heavy sequential-write actions (started 2026-08-20)

**Why:** `customerIntakeFromJson` in `lib/contractWrites.js` (contract.html's
"Rent out") chained ~15 sequential Drive read/write round trips end to end,
which routinely pushed past contract.html's 20s client-side save watchdog
even though the write always actually landed server-side (confirmed live
against Drive after Anton hit this exact symptom on a real Andrey Volkov
booking). Fixed by grouping the steps by which Drive file(s) each touches
and running the genuinely-independent groups concurrently via
`Promise.all`, keeping same-file and data-dependent steps sequential
within or across that block — see that function's own "PARALLELIZED
20/08/2026" comment for the full file-by-file safety reasoning. Verified
with a throwaway concurrency test (fake sheetIO enforcing the same
optimistic-concurrency ConflictError as the real `writeJsonFile`, run 15x
with randomized timing) before deploying: zero conflicts, correct result
every time.

Anton asked for the same treatment everywhere else this shape of problem
exists. A research pass across every `lib/*Writes.js` file found these
candidates (ranked by round-trip count; only functions with ≥5 sequential
round trips included — anything lighter isn't worth the engineering risk).
Working through this list one at a time, in this order, each with: read the
function, map exactly which sheet(s) each step touches (same method as
customerIntakeFromJson's comment), restructure into disjoint `Promise.all`
groups only where truly safe, write/run a concurrency test against a fake
sheetIO before touching the live file, deploy, verify the write stuck on
Anton's device, update this checklist.

- [x] `lib/contractWrites.js` — `customerIntakeFromJson` (action
      `customerIntake`, contract.html's "Rent out") — DONE, deployed
      2026-08-20, pending Anton's push.
- [x] `lib/bikesWrites.js` — `swapBikeFromJson` (action `swapBike`) — ~line
      1550, ~25-30 round trips, 6 sheets (customer, customer_notes,
      Contract, bikes, current-month income, cash). Biggest remaining win.
      DONE, deployed 2026-08-20 (4-way split: marker+ledger / Contract sync
      -- kept strictly sequential internally, rename must land before the
      other two Contract lookups can find the row by its new bike name --
      / bikes sheet / upgrade income). 15/15-run concurrency test passed,
      zero conflicts. Pending Anton's push.
- [x] `lib/bikesWrites.js` — `earlyReturnBikeFromJson` (action
      `earlyReturnBike`) — ~line 1069, ~20-25 round trips, same 6 sheets.
      DONE, deployed 2026-08-20 (4-way split: marker+ledger / Contract --
      sync-return-date, add-amount, flip-status, kept in original order,
      no rename dependency this time so purely a same-file precaution /
      bikes / refund income; dropped the refundAmount<=0 early-return
      since it produced the identical response shape either way). 15/15
      concurrency test runs passed, zero conflicts. Pending Anton's push.
- [x] `lib/bikesWrites.js` — `extendBikeRowFromJson` (action `extendBike`)
      — ~line 1869, ~20 round trips, same 6 sheets. DONE, deployed
      2026-08-20 (4-way split: marker+ledger / Contract sync / income-cash-
      deposit / bikes). 15/15 concurrency test runs passed, zero conflicts.
      Pending Anton's push.
- [x] `lib/bikesWrites.js` — `customerIntakeFromJson` (action
      `customerIntake`, bikes.html's OWN duplicate of the function already
      fixed in contractWrites.js) — ~line 2166, ~18-20 round trips, same 6
      sheets. DONE, deployed 2026-08-20 -- reused the exact same chain
      split from the contractWrites.js fix (marker+ledger / money sheets /
      bikes / contract status, with the totals-backfill-sync step still
      running after the parallel block since it needs both ledgerTotals
      and the Rented flip). 15/15 concurrency test runs passed, zero
      conflicts. Pending Anton's push.
- [x] `lib/customersWrites.js` — `customerIntakeFromJson` (action
      `customerIntake`, customers.html's THIRD near-identical copy of the
      same function) — line 856, ~15-18 round trips, same 6 sheets. DONE,
      deployed 2026-08-20 -- same 4-way split as the other two copies.
      One wrinkle this copy had: `markCustomerNotesTxnIdFromJson` used to
      be a standalone blocking `await` right after the row write, labeled
      "before the cascade" -- checked its own body, it already swallows
      its own errors internally and never rethrows, so folding it into
      chain A changes nothing observable, just lets it run concurrently
      with the other three chains instead of blocking them. 15/15
      concurrency test runs passed, zero conflicts. Pending Anton's push.
- [x] `lib/addBikesWrites.js` — `addBikeFromJson` (action `addBike`) —
      line 535, ~9-11 round trips, 4 sheets (Parts_and_Oil_change,
      Operation, bikes, Bike_Tax). DONE, deployed 2026-08-20 — flat 4-way
      fan-out (Operation / bikes / Bike_Tax / idempotency marker), no data
      dependency between the four at all since nothing computed by one step
      feeds another; only the critical Parts_and_Oil_change write (dupe-name
      guard + the insert every other step's own lookup relies on existing)
      stays before the Promise.all. 15/15 concurrency test runs passed
      (including an idempotent-replay check), zero conflicts. Write
      confirmed on Anton's device (re-staged + grepped for
      `await Promise.all([chainOperation(), chainBikesSheet(),
      chainBikeTax(), chainMarker()]`). Pending Anton's push.
- [x] `lib/addBikesWrites.js` — `editBikeFromJson` (action `editBike`) —
      line 282, ~8 round trips, same 4 sheets as addBikeFromJson. DONE,
      deployed 2026-08-20 — same flat fan-out shape (Operation / bikes /
      Bike_Tax), each looks its row up independently by originalBikeName so
      no dependency between them; the critical Parts_and_Oil_change
      rename+dupe-check stays before the Promise.all. 15/15 concurrency test
      runs passed, zero conflicts. Write confirmed on Anton's device
      (re-staged + grepped for `await Promise.all([chainOperation(),
      chainBikesSheet(), chainBikeTax()]`). Pending Anton's push.
- [x] `lib/bikesWrites.js` — `performMarkReturned` (action `markReturned`)
      — line 878, ~7 round trips, 3 sheets (customer_notes, customer,
      Contract). Modest payoff but safe and cheap. DONE, deployed
      2026-08-20 (marker + Contract-status-flip run concurrently, both
      independent of each other). 15/15 concurrency test runs passed, zero
      conflicts. Pending Anton's push.
- [x] `lib/depositsWrites.js` — `addDepositEntryJson` / `editDepositEntryJson`
      / `deleteDepositEntryJson` (lines ~525/589/632) — ~8-11 round trips
      each, sheets: monthName, monthName_notes, cash, transactionLog. DONE,
      deployed 2026-08-20. The primary deposit write to `monthName` stays
      sequential and first in all three (the cascade recompute re-fetches
      that sheet and needs to see the row that was just added/edited/
      cleared), then: `addDepositEntryJson` gets a 3-way split (idempotency
      marker on monthName_notes / cash+monthName recompute cascade, kept
      internally sequential exactly as it already was / logTransactionB) —
      the other two, which have no idempotency guard, get the same 2-way
      split minus the marker lane. 12/12 concurrency test runs passed for
      all three actions (36 total, including an idempotent-replay check for
      addDeposit), zero conflicts — seeded a realistic monthName/cash sheet
      layout so the recompute cascade genuinely ran end to end rather than
      silently no-op'ing on missing labels. Writes confirmed on Anton's
      device (re-staged + grepped for `await Promise.all([chainMarker(),
      chainCascade(), chainLog()]` and the two 2-lane
      `recomputeCurrentMonthSummaryCascadeB()` blocks). Pending Anton's
      push.

**Checked and deliberately NOT included** (same research pass, confirmed
sequential-by-necessity or too light to bother):
`lib/accountsWrites.js` is fully done already (dated 16/08/2026, all 8
dispatched actions already have the same Promise.all-lanes split).
`bikesWrites.js`'s `returnDepositFromJson` (~14-16 RT) repeatedly re-touches
the same current-month sheet in sequence (clear → income → release/payout)
— forced sequential, not a real candidate. `contractWrites.js`'s
`addContractFromJson` (~5-7 RT, only Contract/Contract_notes, touched 3x)
has a real ordering dependency (idempotency check must precede the write;
the marker needs the new row number the write produces). `editContractFromJson`,
`cancelContractFromJson`, `performUpdateReturnPickup`,
`closeBikeForExtendFromJson`, `sellBikeFromJson`, `unsellBikeFromJson`,
`deductCashDepositFromJson`: all under 5 round trips, not worth it.
`depositsWrites.js`'s `deductDepositEntryFromJson` (~10 RT) has an explicit
audit-safety comment (~line 966) requiring the deposit-balance write to land
before the income-log write, and both hit the same monthName file anyway.

**Status: ALL 9 CANDIDATES DONE** (2026-08-20). Every item above is coded,
tested (15/15 or 12/12 randomized-timing concurrency runs, zero conflicts,
each against a fake sheetIO enforcing the same optimistic-concurrency
ConflictError as the real `writeJsonFile`), deployed to Anton's device, and
write-confirmed via re-stage + grep. Still outstanding: none of this
sweep's changes (`bikesWrites.js`, `customersWrites.js`,
`addBikesWrites.js`, `depositsWrites.js` — `contractWrites.js` already got
its own push earlier) have been pushed to git yet — that's the next and
final step, a consolidated git command block for Anton to run himself.
