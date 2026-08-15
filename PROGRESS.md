# AA Scooters — JSON-parity rewrite progress tracker

Last updated: 2026-08-15. Keep this file current — whenever a page's write
layer gets ported/tested/pushed, update its row below in the same commit.
This exists because work on this project gets picked up across multiple
Claude sessions/accounts with no shared memory between them — this file is
the handoff.

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
