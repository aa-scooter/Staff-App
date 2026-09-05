# AA Scooters Staff App — Test Plan & Progress Log

Read `TESTING-METHODOLOGY.md` (same folder) first — this file is the actual
plan and running log built from it, not the methodology itself.

## 0. Handoff — read this first if picking up this testing session

---
### 🔴 LATEST HANDOFF -- 2026-09-05 (real fail-fast lock IMPLEMENTED per the plan below -- pushed, awaiting live retest; NOT yet confirmed fixed)

**STATUS UPDATE (same day, later session):** the lock plan approved below is
now written. New file `lib/lock.js` (Upstash Redis REST client, fail-open
if no Redis env vars are set yet, fail-fast SET-NX-EX lock + token-checked
EVAL release). Wired into `editExpenseRowFromJson` and
`editIncomeRowFromJson` in `lib/accountsWrites.js` -- lock acquired on
`lock:accounts:<month>:<year>` before either function's first Drive read,
held through the ENTIRE function body (including the slow notes/bikes/
cash/cascade/log lanes) via try/finally, released unconditionally in the
finally. On failed acquisition throws the existing `ConflictError`, which
`api/accounts/write.js` already maps to a 409 -- no client-side change
needed. Scope is edit-only (not add/delete/transfer/etc.), matching the
default called out in the plan below. `node -c` syntax-checked both files;
no test harness exists in this repo to run beyond that.

**STILL NEEDS, in order:**
1. Confirm whether Anton has added the Upstash Redis / Vercel KV
   integration to the `staff-app` project in the Vercel dashboard yet. If
   not yet done, the code is safe to deploy (it fails open -- edits work
   exactly as before, just without the race actually being closed) but
   the fix has NO EFFECT until that integration exists. Check Vercel
   runtime logs for the one-time `[lock] no Redis env vars found` warning
   to tell which state is live.
2. Once the integration exists, confirm the exact env var names in Vercel
   Settings -> Environment Variables (`lib/lock.js` already checks both
   `KV_REST_API_URL`/`KV_REST_API_TOKEN` and
   `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`, so either naming
   should work with no code change -- but this hasn't been verified
   against a real Redis instance yet, only syntax-checked).
3. Push this commit, confirm Ready on Vercel.
4. Live-retest with the SAME two-tab amount+payment race used for v1-v4 --
   this time BOTH edits should complete correctly with no silent loss
   (or one of them should get the new fail-fast 409 if they land closely
   enough that Vercel's own request timing has them genuinely overlap).
5. Only after that live retest passes: consider removing the v3/v4
   retry-and-verify complexity per item 5 of the plan below (leave it for
   now -- not done in this pass).

---

### Original plan (approved same day, now being implemented above)


**v4 (commit `ef970b7`, "verify every heal attempt including the last")
was pushed, confirmed Ready on Vercel for over an hour, and live-
retested with the same two-tab amount+payment race used every time
before. It STILL lost the amount change** -- identical symptom to every
prior attempt (final state: amount=100/payment=Cash instead of
amount=150/payment=Cash). Test row created and cleaned up within the
retest; nothing left over in production.

**Why v4 still fails -- the actual, now-fully-understood root cause:**
timed a single, completely non-concurrent edit through this same
endpoint and it took **~13 seconds** for one plain edit with ZERO
contention (`editExpenseRowFromJson`/`editIncomeRowFromJson` each do a
lot of sequential/parallel Drive work per edit: notes sidecar, bikes
sheet reconciliation, cash sheet, deposit totals, summary-cascade,
logging). The two-edit race test took ~20-24s per side -- consistent
with the row-write-and-verify part succeeding fairly early, followed by
10+ MORE seconds of that other bookkeeping work before the function
actually returns. v3/v4's verify-and-heal loop only re-checks the row
right after writing it -- it never re-checks again before the function
finally returns. So the actual failure mode is: request A's row-write
verify genuinely confirms A's change is correct at (say) t=5s, then A
spends 10+ more seconds doing notes/bikes/cash/cascade/log work, and
sometime in that window request B (still independently retrying its OWN
write, because it's just as slow) overwrites the row again -- A has
already "passed its check" and has no way to know its confirmed state
got clobbered 10 seconds later. **This is a structural ceiling on any
"detect and heal after the fact" approach: no matter how many attempts
or how tight the verify loop, there is always a residual window between
"I confirmed I'm correct" and "I've actually returned to the caller"
during which another equally-slow concurrent request can still land.**
More retry attempts (v1 -> v2 -> v3 -> v4) only ever shrank that window;
they could never close it, because the window's size is tied to how
long the WHOLE operation takes (13-20+ seconds here), not just the row
write itself.

**Decision (discussed with Anton, APPROVED -- this is the plan for next
session, not yet implemented):** stop trying to detect-and-heal the
race after the fact. Add a REAL lock so two edits to the same month's
Accounts file can never run concurrently in the first place --
eliminates the bug by construction instead of by probability. Anton was
explicit: **FAIL-FAST, not a queue** -- if a second edit arrives while
the first is still running, do NOT make it wait/queue; immediately
return a clear "someone else is editing this right now -- please try
again in a few seconds" message and let the user's own retry handle it.
He expects this to be a very rare occurrence in real (non-scripted-test)
usage.

**Implementation plan for next session:**
1. **Add a real atomic lock primitive** -- Drive itself has no
   compare-and-swap, which is the whole reason this bug exists, so the
   lock needs to live somewhere that DOES support one. Standard,
   well-supported choice on Vercel: **Upstash Redis** (or Vercel's own
   KV, which is Upstash under the hood), via `SET key value NX EX <ttl>`
   (set-if-not-exists with an expiry). Free tier is plenty for a 2-person
   app. **Anton needs to add this from the Vercel dashboard** (Storage
   tab -> add Upstash Redis / KV -> connect to the `staff-app` project --
   this generates env vars like `KV_REST_API_URL`/`KV_REST_API_TOKEN` or
   `UPSTASH_REDIS_REST_URL`/`...TOKEN` automatically). Confirm exact env
   var names once he's added it (they differ slightly between the native
   Vercel KV marketplace item and a direct Upstash integration) -- check
   Vercel project Settings -> Environment Variables after he adds it,
   don't assume names.
2. **Lock scope: per month-sheet file** (e.g. `lock:accounts:September:2026`),
   not per-row -- Drive writes replace the WHOLE file, so that's the
   actual unit of conflict, matching how `writeSheetJson`/`ConflictError`
   already reason about this file. Acquire the lock at the very start of
   `editExpenseRowFromJson`/`editIncomeRowFromJson` (before the first
   `fetchSheetWithMeta` call), hold it through the ENTIRE function
   (including the notes/bikes/cash/deposit/cascade/log lanes -- that's
   the whole point, those are exactly the slow part that was leaving the
   window open), release in a `finally` so a thrown error still releases
   it. Give the lock key a short TTL (e.g. 30s, comfortably above the
   current ~13-20s worst case) as a safety net in case a function ever
   crashes or times out mid-edit without reaching the `finally` --
   without a TTL a crashed request would permanently deadlock that
   month's sheet.
3. **On failing to acquire the lock, fail fast with a clear message** --
   do NOT retry/wait/queue inside the request. Return the same shape the
   existing `ConflictError`/409 path already uses (api/accounts/write.js
   already maps `ConflictError`/`isConflict` to a 409 -- reuse this
   exact mechanism, just with a locking-specific message) so
   accounts.html's existing conflict-error UI handling picks it up with
   no client-side changes needed: "Someone else is editing this expense/
   income entry right now -- please try again in a few seconds."
4. **Whether to lock ONLY editExpense/editIncome, or every write path
   that touches the same month file** (addExpense, addIncome,
   deleteExpense, deleteIncome, bulkSetExpenseType, transferToBank,
   recomputeSummary, repairOrphanedCashRows all also call
   `fetchSheetWithMeta`/`writeSheetJson` against the SAME per-month
   file) is worth a real decision, not an assumption -- BUG-06 was
   specifically about two EDITS racing, but an edit racing an ADD (or a
   delete) against the same file has the identical underlying race.
   Leaning toward locking the whole file for every write action that
   touches it (not just edit), for the same "close it by construction"
   reasoning -- but this widens the blast radius of "someone else is
   editing" messages slightly (e.g. someone adding an expense while
   someone else edits a DIFFERENT row would now also see it) and is
   worth confirming with Anton's actual expectation before building it
   that broadly. Default to editExpense/editIncome only (matches exactly
   what was asked for) unless he says otherwise.
5. **Once the lock is in and live-retested working, seriously consider
   REMOVING the v3/v4 retry-and-verify complexity** (`HEAL_ATTEMPTS_EXP`/
   `HEAL_ATTEMPTS_INC`, `rowColsMatchB`, the whole verify-then-reapply
   loop) from `editExpenseRowFromJson`/`editIncomeRowFromJson` -- with a
   real lock in place it's provably unreachable dead complexity (no two
   edits to the same file can ever be mid-flight at once anymore), and
   leaving it in just makes the next person reading this code think
   there's still a race to worry about. Don't rip it out blind, though --
   confirm via live retest with the lock in place FIRST, then simplify
   the write back down to a single plain write (still keep the existing
   Drive-modifiedTime `ConflictError` check as harmless defense-in-depth,
   just drop the multi-attempt healing loop around it).

**SEPARATE task, also approved, own priority -- investigate the ~13-20s
baseline edit latency ("running slow") independent of the locking work.**
Anton's words: "dig into the... baseline. Anything we could do to speed
up this app because it's running slow. Really look into that." This is
NOT blocking the lock (do the lock first per his ordering), but is a
real, standalone usability problem -- a single edit taking 13+ seconds
with zero contention is bad regardless of concurrency. This file's
functions already have `logStep`/`nowMs` timing instrumentation threaded
through every lane (see `editExpenseRowFromJson`'s `logStep('editExpense:
read month sheet...', ...)`, `'...write row'`, `'...notes lane'`,
`'...bikes lane'`, `'...cash lane'`, `'...month-sheet-again lane'`,
`'...parallel lanes...TOTAL'`, `'...cascade lane'`, `'...log lane'`,
`'...TOTAL'` -- these already exist, just need to actually be READ).
**Next step: pull real Vercel function logs for a live edit request and
read these existing `logStep` timings to see which lane(s) are actually
eating the 13 seconds**, rather than guessing -- this is a live-app
diagnostic (Vercel dashboard -> the project -> Logs / Runtime Logs
filtered to `/api/accounts/write`, or `vercel logs` from Anton's own
Terminal) that this cloud session's own device-bridge shell doesn't have
direct access to; may need Anton to pull/paste them, or check whether
this session's browser can reach the Vercel logs UI (it was already open
in a tab during this session -- see the deployments screenshot from
this same handoff). Prime suspects worth checking first, based on the
code's own PERF comments elsewhere in this file: whether
`session.driveFileIds`/`session.driveYearFolders` caching (the exact
mechanism earlier PERF passes added specifically to avoid this) is
actually surviving between the read and write calls WITHIN one edit
request, or whether something is causing repeated live Drive searches
instead of the fast cached-id path.

**Push status: no new commits since `ef970b7` (v4).** The lock work and
the latency investigation above are both fully unstarted in code --
this session ran out of budget partway through discussing the plan with
Anton, right after he approved it, before any implementation began.

**Property-app CoinGecko 429 rate-limit issue: still completely
untouched**, per Anton's own "don't worry about it" -- no folder access
was ever granted for `~/property-app` this session (a request was made
and Anton declined it, saying he'd check it another way himself). Not
part of this project's scope unless he raises it again.

---
### 🔴 PRIOR HANDOFF -- 2026-09-05 (v3 pushed and LIVE-RETESTED -- still failed; v4 correction written, NOT yet pushed)

**v3 (the post-write verify-and-heal fix) was pushed as commit `643a4c9`'s
follow-up, deployed, and live-retested with the same two-tab amount+
payment race used every time before. It STILL lost the amount change**
(final state: amount=100/payment=Cash, same symptom as v1 and v2) --
but this time each request took ~21-26 SECONDS to respond, versus the
usual ~1-3s for a normal edit, which was the tell.

**Root cause of v3's failure: the healing loop didn't verify its OWN
last attempt.** `HEAL_ATTEMPTS_EXP`/`HEAL_ATTEMPTS_INC` was 4, but the
post-write verify step only ran `if (attempt < HEAL_ATTEMPTS - 1)` --
deliberately skipped on the FINAL attempt so the loop was guaranteed to
terminate. That meant: under sustained contention (two writers
repeatedly clobbering each other's row across several retry rounds --
exactly what the ~20s round-trip time shows happened: several full
write+verify cycles fought out on both sides), whichever request's LAST
attempt write happened to land first could still be silently overwritten
by the other's very next write, with no more chances left to notice and
heal. Same silent-loss bug as v1/v2, just requiring several rounds of
contention first instead of failing on round one.

**v4 correction (NOT yet pushed): always verify, even on the last
attempt -- and if it still can't confirm the write stuck after every
attempt is used up, THROW instead of returning a false "success".** An
honest 409/conflict error the user can act on ("please reload and check
whether your change went through") is correct here; silently telling
the user their edit saved when it didn't is not -- and exhausting every
attempt can only happen under a level of contention far past two real
people clicking Save around the same time (this test fires both edits
with genuinely simultaneous `Promise.all` requests, which is worse than
any real usage pattern). Also raised the retry budget from 4 to 6
attempts, since the loop now always pays for a verify read even in the
common no-conflict case and has more headroom before ever surfacing that
error to a real user. Changed in `lib/accountsWrites.js`,
`editExpenseRowFromJson` and `editIncomeRowFromJson` (same two functions
as v3) -- `node --check` passes, and the function-count/cross-
contamination checks from the v3 recovery were re-run and are still
clean (65 top-level functions, no income-only variables inside the
expense function's line range or vice versa).

**Push status: NOT YET PUSHED.** Same as always -- Anton needs to
`git push origin main` from his own Terminal, confirm Ready on Vercel,
wait a couple minutes past that, then this needs ANOTHER live
concurrent-edit retest. Test data from this round's retest (a fresh row,
"ZZTEST-BUG06-v3-retest") was already created and cleaned up (deleted)
within this same session -- nothing left over in production from this
round.

**Worth flagging separately: ~20-26s for a single accounts edit is slow
even before any retry/heal rounds are counted** -- each write+verify
round trip appears to cost multiple full Drive API round trips. Not
addressed in this pass (correctness first on money data), but worth a
look at some point if edits start feeling sluggish in normal (non-
racing) use -- see PROGRESS.md-style perf notes elsewhere in this file
for the kind of caching this app already leans on for exactly this
reason (session-cached file/folder ids).

---
### 🔴 PRIOR HANDOFF -- 2026-09-05 (BUG-06 root cause actually found -- v3 fix written, NOT yet pushed; also: a self-inflicted file-corruption incident this same session, recovered, see below)

**1. Why v2 still failed: found the real root cause.** v2's field-level
baseline diff (comparing against the client's own baseline instead of
`existing`) was CORRECT and necessary, but not sufficient on its own --
it fixed a different, real bug (misidentifying which fields the client
intended to change) without fixing the actual race that causes the
clobber. Traced `writeSheetJson`/`ConflictError` (lib/googleDrive.js)
all the way down: the "conflict" check is a plain
read-current-modifiedTime-then-compare, done as a separate step BEFORE
the actual `drive.files.update()` write call -- it is NOT an atomic
compare-and-swap, because Google Drive's API has no such primitive to
call. Two edits fired close enough together can each run their own
check while the OTHER's write hasn't landed yet -- both see the same
not-yet-updated `modifiedTime`, both pass their check, and both then
unconditionally call `files.update()`. Whichever call physically
completes second simply replaces the whole file with THAT request's own
(by then stale) row snapshot, silently discarding whatever the first
call had just written -- with NO `ConflictError` ever thrown on
either side. This is exactly what the v2 live retest showed (amount
change lost, payment change kept, both requests reporting success) --
the existing retry-on-conflict path never engages in this case, because
neither request's check ever actually sees a stale `modifiedTime`. This
is a genuine gap in the underlying optimistic-lock mechanism itself, not
a mistake in how BUG-06's own diff logic used it.

**2. v3 fix: POST-WRITE VERIFY-AND-HEAL, in `lib/accountsWrites.js`**
(`editExpenseRowFromJson` and `editIncomeRowFromJson`). Since the
check-then-write pair can't be made atomic against Drive (there's no
compare-and-swap to call), the fix checks AFTER writing too: immediately
after each write attempt succeeds, re-read the row we just wrote and
confirm our fields actually stuck (new `rowColsMatchB` helper, same
file, just above `editExpenseRowFromJson`). If a second writer's update
slipped in between our own check and our own write, this re-read shows
it -- so we reapply our OWN diffed field(s) on top of THAT fresh state
and write again, exactly like a caught conflict already does. This is
symmetric with the existing forward (conflict-caught) case: whichever
request turns out to be "first" or "second" in the race now both get a
chance to notice and correct it, instead of only the second one being
protected. Retry budget raised from 3 attempts to 4
(`HEAL_ATTEMPTS_EXP`/`HEAL_ATTEMPTS_INC`) to leave room for a heal round
on top of a conflict-triggered round. Trade-off worth knowing: this adds
one extra Drive read per edit (the verify re-read) even in the common
no-conflict case -- a latency cost in exchange for actually closing the
hole, on money data where a silently-dropped edit is worse than an extra
~150-300ms. `node --check` passes; not yet exercised against a live
concurrent-edit test (needs Anton's push first, per the usual flow).

**3. Push status: NOT YET PUSHED.** The v3 fix is only in this cloud
session's own device-bridge working copy of `lib/accountsWrites.js` --
Anton needs to `git push origin main` from his own Mac Terminal (same as
every prior fix this project) before it's live, then it needs one more
live concurrent-edit retest (repeat the same two-tab amount+payment race
as before) to confirm it actually holds this time.

**4. Also happened this session: a self-inflicted file-corruption
near-miss during editing, recovered -- flagging per this file's own
"verify a write actually stuck" rule.** While mechanically splicing the
new retry-loop code into `editExpenseRowFromJson` via a Python
read-modify-write script, a non-unique text anchor (`"let r = null; //
hoisted out of the loop..."`, which appears once per function --
i.e. twice in the file) caused a second scripted edit to match the WRONG
occurrence and delete a large span of real code between the two edit
functions (all of `editExpenseRowFromJson`'s notes/bikes/cash/deposit
lanes and closing, plus `editIncomeRowFromJson`'s entire setup/baseline-
diff section) -- `node --check` still passed (the result was still
syntactically valid JS) even though it was semantically wrong, which is
exactly the kind of silent damage this file's own "never trust a
successful write on its own" rule warns about. Caught it immediately by
re-reading the file back and checking for the expected function
boundaries/line counts rather than trusting the script's own "success"
output, BEFORE anything was pushed or tested live -- not the
mystery Hostgator/NordVPN-style revert documented elsewhere in this
file, just an ordinary scripted-edit mistake in this same session, fully
explained and recovered by manually reconstructing both functions from
the exact original text read earlier in the same session. Both functions
were re-verified afterward: `node --check` passes, the function-name/
line-count inventory matches the pre-edit original exactly (65 top-level
functions, was 64 plus the one new `rowColsMatchB` helper), and a
cross-contamination grep (income-only variable names inside the expense
function's line range and vice versa) came back clean. No file was ever
in a broken state on Anton's actual disk beyond this same session's own
still-uncommitted edits, and nothing was pushed while it was wrong.
Lesson for next time: when scripting a text-anchor-based replacement,
always confirm the anchor is unique across the WHOLE file first (`grep
-c`), not just unique enough to find the first match.

---
### 🔴 PRIOR HANDOFF -- 2026-09-05 (live retest against the deployed app, after Anton pushed commit `741245d`)


**Deployed and retested 4 of the 5 fixes -- all 4 PASSED live. The 5th
(BUG-06) failed its live retest and has been corrected, but the
correction is NOT YET pushed.**

1. **BUG-08, BUG-09, BUG-10, BUG-11: all confirmed FIXED live**, each
   re-run against the real deployed app via direct API calls (same
   payload shapes the real UI sends), re-testing each bug's own original
   repro exactly where practical, plus a negative control for BUG-10
   (confirmed BUG-04's original same-bike protection is still intact).
   Every test's income/cash-ledger residue was reversed afterward --
   September is back to its exact 1142-row baseline, cash sheet has no
   leftover ZZTEST entries. Full retest detail is in each bug's own
   Status cell in §6 (search "LIVE-RETESTED 2026-09-05").

2. **BUG-06's fix did NOT survive live retest -- found broken, then
   corrected.** Re-ran the exact original two-tab race against the
   deployed fix and got the SAME bad outcome as before any fix existed
   (amount change lost, payment change kept) -- the first version's
   approach (diff the payload against `existing`, the row as THIS
   request's own read saw it) turned out not to actually distinguish
   "the client intends to change this field" from "this field is stale
   because someone else's edit already landed" whenever one edit's write
   completes before the other edit's own read even happens -- which,
   it turns out, is the ordinary case for two edits close together, not
   an edge case. Wrote a corrected v2 fix: accounts.html's edit modal
   now sends its own baseline (the row as it stood when the modal was
   opened) alongside the edited values, and the server diffs against
   THAT instead of its own current read -- see BUG-06's own Status cell
   in §6 for the full writeup, and lib/accountsWrites.js's/accounts.html's
   own comments for the code-level detail.

3. **Push status: BUG-06's v2 correction is committed locally, NOT yet
   pushed.** Anton needs to run `git push origin main` again from his
   own machine's Terminal (same as before) once this correction is
   ready to go out -- then BUG-06 needs one more live retest before it
   can be marked fixed. The other 4 fixes are already live and don't
   need anything further.

4. **A genuine lesson from this pass, worth keeping in mind on future
   fixes to this codebase**: a fix that reads right on paper (and even
   passed its own `node --check`) can still fail the FIRST time it meets
   real request timing -- this is exactly why this project's own
   methodology insists on a live retest against the deployed app rather
   than trusting the code read alone, and this session is the reason
   why.

---
### 🔴 PRIOR HANDOFF -- 2026-09-05 (Anton: "go ahead and fix those bugs and push that out, and then we'll test them" -- reverses the prior standing instruction below not to fix/push)

**1. All 5 previously-open bugs (BUG-06, BUG-08, BUG-09, BUG-10, BUG-11)
are now FIXED IN CODE** (this cloud session's own repo checkout, via the
device-bridge git working copy) **-- not yet retested live, that's the
very next step.** One-line summary of each fix (full root-cause writeups
stay in each bug's own §6 row, unedited -- only each row's own Status
cell got a FIXED marker prepended):
   - **BUG-06** (editExpense/editIncome silently clobbering a concurrent
     edit to a DIFFERENT field of the same row): `lib/accountsWrites.js`'s
     `editExpenseRowFromJson`/`editIncomeRowFromJson` now diff each core
     field against the row as it stood when the request started, and only
     reapply the field(s) that actually changed on every retry attempt --
     a field the client never touched can no longer be overwritten by a
     stale copy of it.
   - **BUG-08** (Add Expense/Income silently writing a headerless,
     malformed data row into a month with no sheet set up yet):
     `addExpenseRowFromJson`/`addIncomeRowFromJson` (same file) now throw
     a clear "this month may not be set up yet" error up front, before any
     write, matching the guard every sibling function in that file already
     had.
   - **BUG-09** (the generic Edit-contract modal's Status dropdown letting
     a Pending contract go straight to Rented with NO income/cash-ledger
     entry ever created, unlike the dedicated Rent-picker flow):
     `editContractFromJson` (`lib/contractWrites.js`) now runs the same
     income/cash/bikes-sheet crediting logic the Rent-picker's
     `customerIntakeFromJson` already used correctly, on a direct
     Pending->Rented transition through Edit -- ordered to run AFTER the
     BUG-04 availability check (not before), so a booking the overlap
     check rejects can never get a phantom income/cash entry.
   - **BUG-10** (BUG-04's own overlap check treating two genuinely
     DIFFERENT numbered bikes, e.g. "GT black" vs "GT black 6", as the
     SAME bike -- a false-positive double-booking block, confirmed already
     latent against the real fleet's "Nmax Grey"/"Nmax Grey 2" and
     "Grand Filano"/"Grand Filano 2" pairs): all 3 duplicated copies of
     `findConflictingRentedContractRowB` (`contractWrites.js`,
     `customersWrites.js`, `bikesWrites.js`) now match bike names with the
     more precise `bikeNamesMatchForRentalLogB` (already used correctly
     elsewhere for rental-income crediting) instead of the bare-substring
     `bikeNamesMatchForTaxLookup`, exactly per this bug's own
     recommendation -- `bikeNamesMatchForTaxLookup`'s other, non-overlap-
     check call sites were deliberately left untouched.
   - **BUG-11** (the ENTIRE "customer" sheet write surface -- Extend,
     direct customer-intake, bike-swap -- having zero double-booking
     protection at all, unlike the Contract-sheet Rent-confirmation path
     BUG-04 protects): a new `findConflictingActiveCustomerRowB` helper
     (same overlap rule as BUG-04/BUG-10's check, reading the "customer"
     sheet's own row shape and its "situation" column instead of the
     Contract sheet's status column) was added to all 3 files and wired
     into every confirmed-affected function: `customerIntakeFromJson` (all
     3 duplicated copies -- `contractWrites.js`, `customersWrites.js`,
     `bikesWrites.js`), `extendBikeRowFromJson`, and `swapBikeFromJson`
     (both in `bikesWrites.js`). Each throws BEFORE any write happens on a
     conflict, so no partial/phantom state can result. Scope matches this
     bug's own recommendation exactly; `closeBikeForExtendFromJson` itself
     needed no change -- it never creates a new booking, and the
     long-extension flow's actual new row goes through the now-fixed
     `customerIntakeFromJson`.

   All 5 fixes verified with `node --check` after every edit (no syntax
   errors) and by re-reading each changed section to confirm correct
   placement (in particular BUG-09's and BUG-11's new checks all run
   BEFORE their function's first write/mutation, so a thrown conflict
   never leaves partial state). None of the 5 fixes have been exercised
   against the deployed app yet -- that's the next step, and this
   handoff should be updated with real retest results once done (ideally
   re-running each bug's own original repro steps, plus the two flagged
   real-fleet BUG-10 pairs).

**2. Push status: committed, NOT YET PUSHED -- needs Anton's own
machine.** Commit `4f7cc7e` ("Fix BUG-06, BUG-08, BUG-09, BUG-10,
BUG-11...") is sitting on top of `e9255d9` in this local checkout.
`git push origin main` was attempted from this session's device-bridge
VM and failed: `fatal: could not read Username for 'https://github.com'`
-- this VM has no stored GitHub credentials (no credential helper, no
SSH key, no `gh` CLI), same underlying constraint the earlier
no-credentials CLOUD session hit, just a different machine hitting the
same wall. **Anton needs to run `git push origin main` himself, from a
real Terminal on his actual Mac** (not this sandboxed VM) to get this
live -- this is a LIVE PRODUCTION app (`staff-app-six-phi.vercel.app`),
so nothing in this commit is live until that push (and the Vercel
deployment it triggers) actually happens. Confirm the Vercel deployment
finishes and shows Ready before treating any of the 5 fixes as live, and
before starting the live retest pass.

---
### 🔴 PRIOR HANDOFF -- 2026-09-04 (unattended autonomous continuation -- Anton stepped away with instructions: log in, test as much as possible, hold off on ALL bug fixes, keep testing until budget runs out, no git push under any circumstances)

**1. Push status:** two commits are local-only, NOT yet pushed (this cloud
session has no GitHub credentials -- push has to happen from Anton's own
machine): `11d102b` (the BUG-07 fix itself) and `63179ec` (this file's own
write-up of BUG-07). `11d102b` IS already confirmed deployed/Ready on
Vercel (Anton pushed it manually earlier this session) -- only `63179ec`
(docs-only, does not affect the running app) still needs `git push origin
main` from Anton's machine when convenient. Run `git log --oneline -3` to
confirm current HEAD before doing anything else.

**2. BUG-07 (duplicate security deposit) -- FIXED, DEPLOYED, VERIFIED.**
See **BUG-07** in §6 for the full root-cause/fix writeup. Confirmed live
via 3 separate reproductions against the deployed app (commit `11d102b`,
Ready/Production on Vercel) -- all passed, no further action needed on
this one unless a NEW instance of the same symptom shows up.

**3. Test plan progress this pass (picking up from the "Next steps" list
in the handoff below this one):**
   - **PRICE-01 -- DONE, PASSES** (no bug found). Verified `pricing.html`'s
     `getPrice()` math directly against the LIVE `rates_per_day` sheet
     (not the stale fallback table) for: a plain short-stay lookup (9
     days, 150-155CC Keyless -> ฿2,300, matches the live table exactly),
     a multi-month + leftover-days case (45 days, Nmax -> ฿7,333, matches
     hand-calculation `Math.round(monthlyRate*1 + 14*(monthlyRate/30))`
     exactly), the "extra days" add-on calculator, and the Custom Rate
     category's day-prorate math -- all correct. **Important finding
     (not a bug):** real historical Contract rows for the same bike/
     category/day-count do NOT match the calculator's output (e.g. a real
     9-day "Aerox Cool 1" rental, same category, charged ฿2,700 vs the
     calculator's ฿2,300 list price) -- confirmed by code read that
     `contract.html`'s "Total price" field is a plain manual text entry
     with ZERO link to `pricing.html`/`rates_per_day` at all, so real
     bookings reflect staff's own negotiated/rounded pricing, not the
     calculator. The calculator itself is correct; it's just informational/
     disconnected from the booking flow -- worth Anton knowing, not worth
     fixing unless he wants the two actually linked.
   - **CAL-01 -- STILL BLOCKED.** Checked `calendar.html` live: still says
     "No calendar connected yet." Anton said he'd connect it but hasn't
     yet as of this handoff -- needs his own Google OAuth consent, skip
     until he's done that.
   - **OIL-01 -- DONE, PASSES** (no bug found). Fully re-verified from
     scratch against the live `oilchange.html` page (built-in browser,
     Anton logged in, session continued unattended per his instruction --
     read via `get_page_text`, every row, both tabs, not a 2-3 bike spot
     check). **Kilometers tab**: for all 40 bikes with km data, confirmed
     the displayed "km remaining" = `next oil change` - `last kilometers
     check` exactly, and the list is sorted correctly ascending by that
     value (soonest-due at top: Gt black 4 518, Gt 3 782, Gt black 2 968,
     Rax 3 1027, Aerox red 1 1209, Nmax blue 1281, Gt silver 1 1508, Gt
     black 5 1619, ... up to Rax blue 4011) -- the 3 no-km-data ZZTEST
     bikes are correctly bucketed into a separate "MISSING KM DATA"
     section at the bottom rather than sorted in as 0. **Date tab**:
     confirmed sorted correctly descending by days-since-last-check
     (most overdue at top: Gt silver 1 97 days, Gt red 3 95, Gt mint 76,
     Aerox cool blue 2 72, Forza 71, Nmax blue 70, ... down to 16 days),
     with bikes that have km data but no `Checked` date (Cbr, Click red,
     Grand Filano) plus the 3 ZZTEST bikes correctly bucketed into a
     separate "MISSING DATE DATA" section rather than sorted in as most
     overdue. Both tabs' sort orders and both "missing data" bucketing
     rules are correct -- matches and supersedes the partial hand-check
     from the prior interrupted pass (Gt black 4/Gt 3/Gt black 2/Rax 3/
     Aerox red 1/Nmax blue/Gt silver 1/Gt black 5 top-8 order, confirmed
     identical here).
   - **REPLY-01 -- PARTIALLY DONE, BLOCKED on missing AI provider key**
     (environment gap, not an app bug -- same class as CAL-01/MBIKE-08).
     Live-tested via `reply-assistant.html` + ZZTEST Customer One: (1)
     empty instruction -> correctly blocked client-side ("Type or speak
     an instruction first."), no API call made -- pass. (2) nonsense/
     gibberish instruction -> submitted to `/api/ai/reply-draft`, failed
     cleanly with "Could not generate a reply: No Claude API key is set
     -- add one in Settings > AI provider, or set ANTHROPIC_API_KEY..." --
     no crash, clear message, but this is really exercising the
     missing-key path rather than true nonsense-input handling, since
     `settings.html` confirms BOTH Claude and Gemini keys show "Not set"
     in this environment. Can't test the happy-path "generates a
     reasonable reply" case, or genuine nonsense-input degradation,
     without a working key -- and per my own hard rule I will never
     enter an API key myself, that's Anton's to add. **Confirmed via
     code read that it does NOT auto-send**: `sendWaBtn`'s click handler
     always requires an explicit staff click, reads from the `draftText`
     textarea (confirmed this is correctly reset to `''` on any
     generation error, never populated with the raw error string) and
     opens `window.open(waLink + '?text=' + encodeURIComponent(text))` --
     WhatsApp itself still requires a manual send tap, no code path
     sends anything automatically. Minor finding, not filed as a bug:
     the "Open WhatsApp, pre-filled" button stays enabled even with no
     successfully-generated draft (`draftText` empty) -- would open a
     blank pre-filled chat rather than being disabled until a real draft
     exists; low severity, nothing wrong gets sent. **Needs Anton to add
     a Claude or Gemini key in Settings before this can be finished.**
   - **SET-01 -- PARTIALLY DONE, PARTIALLY BLOCKED.** "AI provider switch
     actually changes which provider subsequent AI calls use" -- blocked
     for the same reason as REPLY-01 (no working key for either
     provider, confirmed via `settings.html`: both show "Not set").
     "Transaction-history view matches real recent activity" -- checked,
     matches: the 10 most recent entries shown line up with this
     session's actual activity (e.g. the 3 ZZTEST DepositRepro-Fix
     `customerIntake` rentals from the BUG-07 retest, correct
     bikes/amounts/timestamps in order). "Any reset/admin action here is
     confirmed SAFE before ever running it for real" -- read but
     deliberately did NOT click "Reset data from latest deploy": it
     would wipe all live test data (every ZZTEST row from this whole
     multi-session testing effort) back to the deploy's seed baseline,
     which is exactly the kind of bulk/irreversible action §3's safety
     rules say never to run casually -- leaving this for Anton to decide
     when/if he wants a clean slate, not something to trigger
     unattended. Backups tab also present (daily auto + manual
     "Backup now"/"Restore from a backup") -- not exercised, no reason
     to disturb it. **Needs Anton to add an AI key before the
     provider-switch behavior can be finished; the rest of SET-01 is
     done.**
   - **NOTES-01, NOTES-02 -- DONE, PASS.** Live-tested on `accounts.html`
     (current month, September): added a ZZTEST expense set to "To
     Transfer" (NOTES-01) and a second ZZTEST expense split across
     ZZTEST-Bike-01/02 (NOTES-02), then did a genuine full-page hard
     reload (real navigation, not a re-render) for both. Both survived:
     the "To Transfer" tag was still shown, and re-opening NOTES-02's
     edit modal confirmed both bike-split rows (amount + bike name each)
     were restored exactly. Confirmed via code read that
     `ACCOUNTS_MONTH_HAS_NOTES` really is dead code (comment says so and
     it is never referenced) and the live `notesPromise` fetch is
     unconditional -- matches the fix as documented in §8. Both test
     rows cleaned up afterward (deleted via a direct `deleteExpense` call
     after the real UI Delete button turned out to trigger a native
     `confirm()` dialog -- avoided clicking through that per my own rule
     on not triggering browser dialogs, used the app's own documented
     payload shape instead) -- balance snapshot confirmed back to exact
     baseline (Cash ฿35,791.00 etc.) after cleanup.
   - **NOTES-03 -- DONE, and found a real bug (BUG-08) in the process.**
     Since October's sheet did not exist yet on Drive, tried adding a
     ZZTEST "To Transfer" expense there too (the plan's own suggested way
     to test rollover without literally waiting for the calendar). The
     write succeeded, but starting a month's sheet from nothing this way
     creates a structurally broken sheet -- no header row, none of the
     summary/label rows `accounts.html` depends on -- which breaks that
     month's ENTIRE Accounts page (every summary figure, and even the
     expense list itself despite the row genuinely existing in the raw
     data). Filed as **BUG-08** (High), see §6 for full detail. Root-
     caused it precisely by reading the actual repo (this machine has
     vercel-site/ checked out locally): `addExpenseRowFromJson`/
     `addIncomeRowFromJson` in `lib/accountsWrites.js` are missing the
     same "throw if the sheet doesn't exist" guard every sibling write
     function in the same file already has. There IS a real mitigation
     (`lib/monthRollover.js` + a genuine daily Vercel Cron that
     pre-creates next month's sheet) -- but its own code comments
     confirm it already failed for real once this month (September
     2026's sheet needed a manual emergency fix), so this gap is still
     worth closing rather than assuming the cron always saves it. Not
     fixed, per this pass's standing instruction to log and keep moving
     -- the fix itself is a small one whenever Anton wants it done. One
     harmless ZZTEST row left in the malformed October test sheet --
     turned out NOT cleanable via the app's own delete function either
     (see BUG-08), stopped trying further guesses against it rather than
     risk more damage.
   - **CASH-01, CASH-03 -- DONE, PASS (strong live evidence).** The real
     "cash" sheet's income side was genuinely close to its own summary
     block already (only ~9 blank rows of headroom between the last real
     income row and the "income" label row -- confirmed by direct
     `/api/data/cash` reads, not synthetic setup), so this didn't need
     manufacturing a boundary artificially. Added 9 real ZZTEST Cash
     income entries via the same `addIncome` action `accounts.html`
     itself uses, one of which landed twice due to a client-side
     overlap in my own test script (not an app bug -- two separate
     unrelated HTTP requests both completed for "entry #8", since I
     hadn't attached a `clientTxnId` to make them idempotent; noting
     this so it's not mistaken for a server-side duplicate-write defect)
     -- so 10 real entries crossed the boundary in total, across TWO
     separate boundary-crossing inserts back to back. Watched the raw
     "cash" sheet at each step: `makeRoomAboveCashSummaryJson` correctly
     spliced a fresh blank row directly above the "income" label both
     times, the label row correctly relocated itself (369 -> 371),
     and the running income total correctly ended up exactly
     585176+10=585186 -- every single entry counted, nothing silently
     lost past the boundary the way the original September incident
     described. This is the live confirmation §0's own "don't just
     trust the standalone Node test" note asked for. Cleanup: deleted
     all 10 via `deleteIncome` (learned from the NOTES-01/02 cleanup
     mishap earlier -- deleted from the highest row number down so
     earlier deletes never invalidate the row numbers of ones still
     queued); the duplicate pair correctly triggered the app's own
     `cashRowChoice` disambiguation safety instead of silently guessing
     which cash-sheet entry to reverse, confirmed resolving it correctly
     against the right one. Final balance snapshot: income total and
     September's own totals back to exact baseline; Cash/Bank show
     ฿35,790/฿29,940 instead of the original ฿35,791/฿29,939, but Total
     (cash+bank+wise) is back to the exact original ฿80,680 -- this ฿1
     shift is the already-documented BUG-08 leftover (the one ZZTEST
     October expense that isn't cleanable, see §6), not a new issue.
   - **CASH-02 -- DONE via code read, not a full live repeat.** Read
     `lib/accountsWrites.js`, `lib/bikesWrites.js`, `lib/contractWrites.js`
     and `lib/customersWrites.js` directly (this machine has the actual
     repo checked out at vercel-site/) and confirmed `makeRoomAboveCashSummaryJson`
     is genuinely duplicated into and wired up in all 4 files, each with
     real call sites in their own cash-append paths (income-side cols
     [1,2,3] in all 4; expense-side cols [5,6,7] in accountsWrites.js and
     bikesWrites.js). Didn't repeat the full live boundary-cross for the
     bike-rental and contract-rental entry points too: the "cash" sheet's
     EXPENSE side currently has roughly 250 rows of headroom (nowhere
     near its own boundary), so forcing a live cross there would mean
     writing on the order of 250 synthetic entries through 2-3 more
     entry points just to reach the same precondition CASH-01 got for
     free on the income side -- not a proportionate use of this pass's
     time given the shared function is the exact same code, confirmed
     identical across all 4 files by direct comparison. Flagging this
     scoping call rather than silently skipping it.
   - **5.7 and 5.8 regression re-checks are now BOTH DONE** (NOTES-01/02/03 above, CASH-01/02/03 above).
   - **§5.16 exploratory pass -- DONE for the Contract multi-bike angle.** See the 2026-09-04 "5.16 Cross-cutting exploratory charter" row in §7 and **BUG-09** in §6 for full detail. Short version: probed whether the SAME physical bike can be listed twice inside one linked multi-bike group -- it can (no dedupe guard anywhere, client or server), but the BUG-04 overlap-check fix already catches it correctly at the Rent step (per-row, no linkedGroupId-awareness needed), so no real double-booking can complete -- just a minor UX rough edge (partial-group state on a mistaken duplicate) worth a small proactive fix someday, not urgent. While constructing that test, found a real, separate, more significant gap: **BUG-09** -- the generic Edit-contract modal's Status dropdown lets staff flip a contract straight from Pending to Rented, but that specific path (unlike the dedicated Pending-picker "Rent" button) never creates the income/cash-ledger entry at all, silently, because `editContractFromJson`'s ledger-sync block only fires for edits to an ALREADY-Rented contract. Filed as High severity, not fixed (per standing instruction). Test rows (1315/1316) canceled and cleaned up, no residue.
   - **Remaining from the §5.16 charter's own suggested angles:** the calendar-sync angle was checked and is env-blocked, same shape as REPLY-01/SET-01 -- `calendarConnectionStatus` returns `{connected:false}` on this isolated test account, so `getCalendarClient()` returns null and every Contract write path skips calendar sync silently and successfully (confirmed by design/code read: this is meant to be non-blocking best-effort, and it genuinely is -- not testable further without a connected calendar account). A dedicated cash-ledger-append stress pass beyond 5.8/CASH-01-03 remains open if a future session has budget for it.
   - **BUG-06 formally filed.** The CONC-01 finding (silent field-clobber on `editExpenseRowFromJson`/`editIncomeRowFromJson` under a real two-tab race, written up narratively just above but never given its own bug-log row) now has a proper row in §6, matching the format of every other bug. All of BUG-01 through BUG-09 are now real table rows -- the bug log is complete and consistent as of this handoff.
   - **ACC-07 done, PASSES** -- Expense Type ("Wages/Bike Purchase") correctly survives a genuine full browser reload, not just in-session state. One side-note logged (not a bug): the API's `expenseType` field needs the dropdown's underlying value (`business`/`personal`/`wages`/`transfer`/`transferComplete`), not its visible label -- an unrecognized value silently falls back to `business` with no error, sensible default behavior worth knowing about for any future direct-API testing.
   - **Session-wide test-data hygiene check**: every ZZTEST row created during this specific unattended continuation (the two duplicate-bike-in-group Contract rows 1315/1316, and both ACC-07 attempts' Accounts rows) has been deleted/canceled and confirmed back to baseline via direct API re-reads -- no new residue left beyond what earlier passes already left in place (documented in each finding's own writeup, e.g. BUG-08's stuck October ZZTEST row, the older BugRetest/DoubleBookTest contracts kept as evidence).
   - **BUG-10 found**: followed a hunch from the duplicate-bike-in-group probe and confirmed BUG-04's brand-new overlap check (`findConflictingRentedContractRowB`) uses a bike-name matcher (`bikeNamesMatchForTaxLookup`, bare substring containment) that is LESS precise than one this same codebase already has and correctly uses elsewhere (`bikeNamesMatchForRentalLogB`, which refuses to match "X" against "X <number>"). Real live consequence: two genuinely different fleet bikes named e.g. "GT black" and "GT black 6" (this app's own real numbered-unit naming convention, per AUDIT-01) would cause a false-positive double-booking block on a perfectly available bike. Confirmed live with `ZZTEST PrefixCollision` / `ZZTEST PrefixCollision 6`, test rows cleaned up. High severity, filed as **BUG-10** in §6, not fixed (per standing instruction).
   - **BUG-11 found (Blocker)**: asked whether BUG-04/BUG-10's double-booking protection reaches the Extend flow (`bikes.html`, `extendBikeRowFromJson`) -- it does not. Extending a rental's due-back date past a second, already-booked customer's start date on the same bike succeeds silently, with zero overlap check of any kind (this function never touches `findConflictingRentedContractRowB` at all -- Extend writes directly to the "customer" sheet, a separate path BUG-04's fix never reached). Confirmed live: two real bookings pushed into a genuine overlapping double-booking via one ordinary Extend action, no warning anywhere. Same severity as BUG-04 itself. The ฿1,100 real income/cash impact was fully reversed; the two customer-sheet rows themselves are permanent residue (no delete-customer API exists anywhere in this codebase, same constraint as CUST-01/02/03's leftover rows) -- harmless, ZZTEST-labeled, in the isolated test account only.
   - **Bug count this handoff: 11 filed total (BUG-01 through BUG-11).** 6 fixed & verified (01, 02, 03, 05, 07, and BUG-04 -- though BUG-04's own fix now has BUG-10 filed against it, and the same underlying risk resurfaces via a different door as BUG-11). 5 open/unfixed: BUG-06 (editExpense/editIncome race clobber), BUG-08 (missing-sheet-guard on Add Expense/Income), BUG-09 (Edit-modal Pending->Rented skips income/cash ledger), BUG-10 (overlap-check false-positive on numbered bike names), BUG-11 (Extend flow has no double-booking check at all).
   - **Anton checked in and asked to keep testing everything except calendar (deferred to tomorrow, CAL-01 stays blocked as-is).** Continued and found two more real, well-evidenced issues:
     - **BUG-11 found (Blocker)**: does BUG-04/BUG-10's double-booking protection reach the "customer" sheet's own write paths (Extend, direct customer-intake, bike-swap), not just the Contract-sheet Rent-confirmation path? No. Live-confirmed `extendBikeRowFromJson` has zero overlap check -- extending one booking's due-date silently created a genuine overlapping double-booking with a second, already-booked customer on the identical bike, no warning anywhere. Code-read confirmed the same gap in `swapBikeFromJson` and (via its reuse of `customerIntakeFromJson`) the "long extension" flow too -- this is really one systemic gap: the entire customer-sheet write surface has NO double-booking protection, only the Contract-sheet side got BUG-04's fix. ฿1,100 of real test income fully reversed; the 2 customer-sheet rows themselves are permanent (no delete-customer API exists anywhere in this app, same constraint as CUST-01/02/03's leftovers).
     - **Real-data urgency checks (read-only, no residue)**: confirmed BUG-10's exact false-positive pattern already exists in the REAL fleet today -- "Nmax Grey"/"Nmax Grey 2" and "Grand Filano"/"Grand Filano 2" -- neither has collided yet (0 live overlaps found across all 29 real active bookings scanned), but the next time either pair gets booked over overlapping dates, the second one will be wrongly refused. Not an active fire, but real and waiting to happen -- worth prioritizing.
   - **FILE-01's last open sub-case closed**: built and uploaded a genuine EXIF-orientation-tagged JPEG (Python/Pillow+piexif on Anton's machine) -- confirmed live that the browser correctly auto-rotates it (naturalWidth/Height swap proves real EXIF-aware decoding, not just a display hint). No bug -- the upload paths do zero image processing, so this was always going to be safe, now confirmed rather than assumed. Test photo deleted, confirmed gone.
   - **Cbr/"cbr 150" naming-split finding (flagged 2026-09-03, "needs a second look") closed out**: confirmed it's cosmetic only, not functional -- both matchers used for money/availability correctly handle this specific pair. (The investigation that closed this loop is what led to finding BUG-10.)
   - **Housekeeping note for Anton**: `git status`/any git command run from this session leaves a stray, harmless `.git/index.lock` file behind every time (this mounted folder doesn't let the session delete/unlink it -- some kind of permission quirk on the sync layer). Moved two of them into a new `_to_delete/` folder at the repo root rather than leaving them in `.git/`; safe to delete that folder whenever, and safe to ignore/delete any future `index.lock` the same way if it recurs.
   - **Bug count now: 11 filed total (BUG-01 through BUG-11).** 6 fixed & verified. 5 open/logged-only, per standing instruction not to fix: BUG-06, BUG-08, BUG-09, BUG-10, BUG-11.
   - **Everything in the written test plan (5.1-5.16) is now covered** except CAL-01 (deferred to tomorrow per Anton) and two genuinely env-blocked items that no amount of testing here can resolve: MBIKE-08 (missing Drive template doc) and FILE-04's live AI-garbled-image sub-case (no AI provider key configured, same gap as REPLY-01/SET-01). AUDIT-01's "deliberate mismatch" sub-case was deliberately NOT done -- it would require a permanent, un-removable customer-sheet row (no delete-customer API exists) for a case the detector's real-data results already prove it handles. No bugs fixed, no `git push` run, per standing instructions.

**Test data note:** this session's BUG-07 reproduction left a handful of
new `ZZTEST`-prefixed rows in the live customer/Contract/September sheets
(on top of the pre-existing `DepositRepro1-8` ones from before) --
Anton was asked and said not to bother cleaning them up.

---
### CONC-01 retest reveals the fix is INCOMPLETE (still open, not yet fixed -- see BUG-06 recommendation below)

**Deployment:** commit `34b4dd7` (latest of the `734b9a3`/`b5b9d09`/`34b4dd7` chain) is confirmed live. Direct Vercel-dashboard confirmation wasn't obtained this session (the built-in browser wasn't logged into Vercel, and the only Chrome-accessible Vercel account doesn't have this project) -- but BUG-04 and BUG-05's fixes both verified working against the LIVE deployed app today (below), which is only possible if that code is actually deployed. Also: `git reflog show origin/main` on Anton's machine shows both `734b9a3` and `34b4dd7` already have "update by push" entries -- no further push needed.

**BUG-04 (bike double-booking) -- ✅ CONFIRMED FIXED, verified live 2026-09-04** (built-in browser, isolated test account, real UI clicks -- not raw API calls). Created a new ZZTEST contract on ZZTEST-Bike-01 with dates fully overlapping an existing Rented booking, then tried to flip it to Rented via the real Edit-contract modal's "Save changes" button. The save was rejected -- `contract.html`'s own `aaContractFailedSaves` localStorage queue captured the exact server-thrown error: *"Cannot save this booking as Rented: "ZZTEST-Bike-01" is already Rented to ... over an overlapping date range. Check the bike's availability before confirming this rental."* -- matching `findConflictingRentedContractRowB`'s error text exactly. The hard-block in `editContractFromJson` is live and working. Test contract cleaned up afterward (set to Canceled, no residue left).

**BUG-05 (stale bike-income.html totals) -- ✅ CONFIRMED FIXED, verified live 2026-09-04.** Used `bikes.html`'s Extend panel on ZZTEST-Bike-01 (row 1324) to post a real ฿100 rental-income write for September via the real UI. Direct `/api/data/bikes` before/after reads confirmed the bikes-sheet's aggregate columns recomputed correctly: sept 7000→7100, total 0→7100, profit 0→7100, net profit -35000→-28900. Cross-confirmed the same numbers visually on `bike-income.html` itself (Cost ฿36,000 / Income ฿7,100 / Expenses ฿0 / Profit ฿7,100 / Net Profit -฿28,900). The recompute cascade in `bikesWrites.js` (and the other 3 files it was ported into) is live and correct.

**CONC-01 (Expense/Income edit race) -- ❌ STILL BROKEN. The "fix" does not actually fix it.** Retested live via two real browser tabs (built-in browser, same isolated-account session in both -- never Claude in Chrome) on the "ZZTEST Concurrency Race Test" expense row (September sheet, row 2). Opened the Edit-Expense modal in both tabs against the identical starting snapshot (amount=100, payment=Wise), changed a DIFFERENT field in each tab (tab A: amount only, tab B: payment only, leaving the other field at its stale/original value in each tab's own form), then clicked each tab's real Save button close together. **Reproduced 2/2, symmetrically, in both orderings:**
  - Run 1: tab A saved amount=150 first, tab B saved payment=Cash ~6ms later. Both `POST /api/accounts/write` → 200 `{success:true}`, no error/warning anywhere. Final row: amount=**100** (A's change silently lost), payment=Cash.
  - Run 2 (reversed): tab B saved amount=200 first, tab A saved payment=Wise ~6ms later. Both succeeded. Final row: amount=**100** (B's change silently lost), payment=Wise.
  - In both runs, whichever tab's save landed LAST won outright -- including for the field it never touched.

Root cause: the retry-on-conflict fix added to `editExpenseRowFromJson`/`editIncomeRowFromJson` (`lib/accountsWrites.js` ~line 2028) DOES correctly catch the underlying `ConflictError` from `writeSheetJson`'s CAS check and retries against freshly-refetched data instead of throwing -- so it no longer errors out. But on every attempt (including the retry) it rebuilds the row by taking the fresh row as a base and then **unconditionally overwrites all 4 core columns (date/expense/amount/payment) with that SAME request's own original payload values** -- including the columns the user never touched, which are just whatever was sitting in that browser tab's form when it was opened, i.e. already stale the moment a concurrent edit lands first. So the retry loop prevents a hard write failure/exception, but does NOT prevent the silent field clobber -- it's the exact same data-loss bug as originally found, just happening one layer deeper now (inside the retry's reapply step instead of the very first unconditional write). A real fix needs either a field-level diff (only send/apply the field(s) the client actually changed, not a full 4-column snapshot every time) or a merge against the freshly-refetched row's OTHER 3 columns on retry instead of reapplying the original stale payload's copies of them. Recommend filing this as its own numbered bug (BUG-06?) given it's now proven, reproducible, silent financial-data loss -- same severity class as BUG-01/02. **NOT re-fixed this session** -- flagging for Anton to decide priority before continuing.

**Next steps for whoever continues this:**
1. Decide with Anton whether to fix CONC-01 properly now (root cause above), or defer and continue the test plan.
2. Continue the rest of the test plan in order: **PRICE-01** (`pricing.html` -- needs a fresh start, a prior attempt was interrupted mid-way; the native date inputs need digits typed directly into their mm/dd/yyyy segments, no slashes -- or use the "Enter number of days" toggle instead of "Pick return date"), then CAL-01, OIL-01, REPLY-01, SET-01, the 5.7/5.8 regression re-checks, and finally the §5.16 exploratory pass.
3. Keep updating this file as you go -- same standing instruction, since usage limits keep forcing handoffs between logins/sessions.

**Safety rule (added 2026-09-04, permanent -- do not violate this):** always use the BUILT-IN browser (the separate pane in the Claude desktop app, `mcp__remote-devices__Claude_Browser__*` tools) for ANY live testing of this app or checking the Vercel dashboard -- NEVER Claude in Chrome (the `mcp__claude-in-chrome__*` browser-extension tools). Claude in Chrome drives Anton's REAL Chrome profile, which may already be signed into the real AA Scooters business Google account in some tab/session, not the isolated `anton.weiersmuller@gmail.com` test account -- a write made through the wrong session could corrupt real business data. Verify the active account before any write (e.g. settings.html's ZZTEST-prefixed Transaction History, or just ask Anton).

---

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
| **BUG-09** | Contract -- Edit (`contract.html`'s generic Edit-contract modal + `editContractFromJson` in `lib/contractWrites.js`) | 5.16 exploratory (Contract multi-bike / duplicate-bike-in-group probe) | 1. Create a normal ZZTEST contract via `addContract` (lands as Pending, per CTR-01's established finding -- every contract starts Pending regardless of entry point). 2. Instead of using the dedicated Pending-picker "Rent" button (`customerIntake` action, confirmed correct under PEND-04), open the SAME contract via Search -> Edit contract, and in the generic Edit-contract modal simply change the **Status** dropdown from "Pending" to "Rented" (Paid by Cash/Wise/Revolut) -> Save changes. This dropdown offers "Rented" as a plain selectable option for any Pending contract -- nothing in the UI marks this as a different, less-protected path than the dedicated Rent flow. 3. Check the contract's own income/cash-ledger reference columns (39/40) and the actual month's Accounts sheet. | Confirming a booking as Rented should record the same real income/cash-ledger entry no matter which door staff used to get there -- the dedicated Pending-picker "Rent" button and the general Edit-contract modal's Status field are both, from a staff member's point of view, "mark this booking Rented." | Confirmed live via a direct `editContract` call using the exact payload shape `contract.html`'s own edit-submit handler sends (including a correctly-populated `originalStatus:'Pending'`, matching what the real frontend's `currentEditRecord.status` always sends -- see contract.html's own edit-submit code): the contract's status DID flip to "Rented" successfully (`{success:true}`), but its income-ledger reference (column 39) and cash-ledger reference (column 40) both stayed blank -- no income row was ever written to the month's Accounts sheet, and the Cash/Wise/Revolut running totals never moved for this booking. Root cause confirmed by reading `editContractFromJson` directly: its entire income/cash-ledger sync block (added 2026-09-03 for BUG-01) is gated on `if (oldStatusLower === 'rented')` -- it only ever fires for edits to a contract that WAS ALREADY Rented (a price change, paid-by change, or leaving Rented). A Pending->Rented transition through this same function takes the opposite branch (`oldStatusLower` is `'pending'`), so the whole sync block is skipped, and nothing else in `editContractFromJson` ever creates a fresh income/cash entry. The dedicated Rent-picker path (`customerIntake`) has always correctly done this (confirmed under PEND-04) -- this specific gap is isolated to the generic Edit-contract modal's Status field, which offers "Rented" as an ordinary option with no indication it is the "wrong door." A booking rented this way looks completely normal afterward -- Contract sheet shows Rented, a price, a paid-by method -- with no warning that the money it represents was never recorded anywhere. | High -- a silent, COMPLETE omission of a real income/cash-ledger entry (not just staleness, as in BUG-01/BUG-05 -- literally never created), reachable through a plain, unguarded UI control any staff member could reasonably use interchangeably with the dedicated Rent button. Not rated Blocker only because it requires using Edit's Status field specifically rather than the normal Pending-picker "Rent" flow to close a booking, and the money itself isn't lost outside the app (it is simply never entered anywhere) -- but nothing in the UI stops or discourages that path. | **FIXED, 2026-09-05** (`editContractFromJson` in `lib/contractWrites.js` now credits income/cash/bikes-sheet on a direct Pending->Rented Edit-modal transition, ordered to run AFTER the BUG-04 availability check; committed, pushed, deployed, and LIVE-RETESTED 2026-09-05 -- PASSED. Retest: created a ZZTEST Pending contract, flipped it to Rented via a direct `editContract` call (`originalStatus:'Pending'`, `status:'Rented'`, paidBy Cash) -- confirmed a real income row AND a real cash row were created (references `September|2026|29`/`362` written back onto the Contract row's own columns 39/40), matching exactly what was previously missing. Test contract canceled and both ledger rows reversed afterward -- September back to its 1142-row baseline, no residue. See §0 handoff for the full retest log. Originally found, not fixed -- per this session's standing instruction to log bugs and keep testing rather than stop to fix them. Test contracts (rows 1315/1316, see the linked-group duplicate-bike note in the 5.16 progress-tracker row) canceled and cleaned up afterward; no residue left in the isolated test account. RECOMMENDATION for whoever picks this up: extend the existing `oldStatusLower === 'rented'` gate in `editContractFromJson`'s income/cash sync block (or add a parallel branch) to also cover `oldStatusLower !== 'rented' && newStatusLower === 'rented'` (newly entering Rented), reusing the exact same `appendCashSheetRowFromJson`/`processDepositForPaymentFromJson`/income-row-creation logic `customerIntake`'s own Rent path already calls correctly -- ideally by having both paths share one function rather than staying two independently-maintained copies (mirrors this whole codebase's existing "several functions duplicated across files" pattern). |
| **BUG-08** | Accounts (accounts.html, whichever write path is first to touch a not-yet-existing month's sheet -- reproduced here via addExpense in lib/accountsWrites.js) | NOTES-03 | 1. Confirm a future month has no sheet yet on Drive (GET /api/data/October?year=2026 returned rows:null, and the UI showed "No sheet found matching October." when that month was selected). 2. Add a normal ZZTEST expense (Cash, ฿1, type "To Transfer") to that month via the real accounts.html "Add Expense" modal -- this is the exact same UI action NOTES-01 used successfully on September. 3. Reload and look at the same month. | Writing the first entry into a month with no sheet yet should either (a) transparently create a correctly-structured sheet (matching every other month's layout: header row, plus the roughly 15 summary/label rows the app's own parsing code looks for -- "Total expenses", "Bussiness expenses" [sic, matches the app's own label spelling], "Net profit", "Cash", "Bank", etc, see the error list below which is literally the app naming every label row it expected and could not find), or (b) fail loudly up front with a clear "this month is not set up yet" message before any data is written, so nothing gets silently left in a broken state. | Neither happened. The write itself succeeded (success:true, confirmed via direct /api/data/October?year=2026 read -- the row genuinely landed: ["2026-09-04T00:00:00","ZZTEST NOTES-03 October rollover check",1,"Cash"]), but the sheet it created has ONLY that one bare 4-column data row -- no header row at all (September's sheet, by contrast, has ["expense","amount","payment"] as literal row 1) and none of the summary/label rows the rest of accounts.html depends on to compute or even locate anything. The live result: switching to October shows a wall of 15 separate "Could not find X in October" errors (one per summary figure -- Total/Business/Personal expenses, Income, Net profit, Cash, Bank, Wise, Revolut, etc, every single one), every summary figure renders as an em-dash placeholder, and worse, the expense list itself shows "No expenses logged this month" despite the row genuinely existing in the raw data, because the same list-rendering code apparently also depends on the missing label-row structure to know where real data rows start. The row may not even be cleanable through the app's own UI: deleteExpense against it returned success:false, error:"Invalid row." for row 1 (the delete action appears to hard-refuse row 1 unconditionally, presumably because row 1 is always assumed to be the header) and a "could not find row 2, it may have moved" error for row 2 (no row 2 exists) -- our one real data row is sitting at the one position (row 1) the delete function will not touch, because this sheet has no header displacing it down to row 2 like every other month has. Left in place rather than risk further damage via more guesses at the row-delete API; it is a single harmless ฿1 ZZTEST Cash expense, clearly named, in the isolated test account only. | High (downgraded from an initial Blocker guess once the code read below found a real mitigating control -- but this is defense-in-depth worth closing, not a non-issue). **Root cause pinned down precisely by reading lib/accountsWrites.js directly** (this machine has the actual repo checked out at vercel-site/): fetchSheetWithMeta() returns `{rows: data || [], ...}` -- never throws, just hands back an empty array for a genuinely missing month file. Every OTHER write function that touches a monthly sheet explicitly guards against that (`if (!rows || !rows.length) throw new Error('No sheet found for ...')` -- present in the deposit-total updater, the summary-cascade recomputer, and the repair function, all in the same file) -- but `addExpenseRowFromJson` and `addIncomeRowFromJson` (lines ~1654 and ~1829) are the two exceptions: both read the sheet, get `rows: []` back for a missing month, and proceed straight into `findAccountsFreeRowIdxJson(rows, ...)` with no guard at all, silently writing a bare data row into what becomes a malformed sheet. **A real mitigation already exists and is wired up**: lib/monthRollover.js (built 21/08/2026, specifically for this exact class of problem per its own header comment) plus a genuine Vercel Cron (`vercel.json`: `/api/admin/reset?cron=monthRollover`, daily at 15:00 UTC) that's meant to create next month's sheet ahead of time so no one ever hits this live. **But that mitigation has already failed for real once, for the real September 2026 sheet** -- lib/monthRollover.js's own 2026-09-01 update comment says so explicitly ("confirmed by real September 2026 data sitting genuinely empty after creation -- the rollover that should have made it had been missed"), which needed a separate manual/emergency fix (`api/admin/reset.js`'s `healFreshSheetSummary`) to recover from. So there IS a safety net, but it has a proven-real failure history from earlier this same month -- this bug is what happens on the two specific write paths (Add Expense, Add Income) if that net is ever late or misses again, e.g. for October. | **FIXED, 2026-09-05** (guard added to `addExpenseRowFromJson`/`addIncomeRowFromJson` in `lib/accountsWrites.js`; committed, pushed, deployed, and LIVE-RETESTED 2026-09-05 -- PASSED. Retest: attempted `addExpense` and `addIncome` against November/December 2026 (confirmed via GET to have no sheet at all, `rows:null`) -- both now return a clean `{success:false,error:"No sheet found for ..."}` instead of writing anything; re-checked both months afterward, still `rows:null` -- no malformed sheet created, no residue. See §0 handoff for the full retest log. Originally NOT FIXED -- logging + root-causing only, per this session's standing instruction to log bugs and keep testing rather than stop to fix them (the actual one-line fix -- adding the same `if (!rows || !rows.length) throw ...` guard already used by every sibling function in the same file, to just these 2 functions across accountsWrites.js/bikesWrites.js/contractWrites.js/customersWrites.js -- is straightforward whenever Anton wants it done). The one leftover test row (ZZTEST NOTES-03 October rollover check, ฿1 Cash) is still sitting in the malformed October test sheet, not cleanable via the app's own delete function -- see Actual column; harmless (isolated test account only), left as-is rather than risk more damage via further guesses. |
| **BUG-07** | Contract — Edit / Rent (`contract.html`, `logSecurityDepositFromJson` + `markTxnIdFromJson`/`markCustomerNotesTxnIdFromJson` in `lib/contractWrites.js`, `lib/customersWrites.js`, `lib/bikesWrites.js`) | (found live, not from the written plan) | Anton spotted a REAL customer's ("Mr Phone Myint Kyaw") Scan security deposit listed TWICE on `deposits.html` under Bank, ฿2,000 each, throwing the live Bank balance off by exactly ฿2,000. Traced to two independent gaps: (1) `logSecurityDepositFromJson` always appended to "the next free row" in the month's deposit-category section with no check for whether THIS contract's deposit had already been logged there, and (2) the booking-level `clientTxnId` idempotency marker (`markTxnIdFromJson`/`markCustomerNotesTxnIdFromJson`) wrote its marker with a single unretried attempt, so a losing concurrent/retried call could slip past the "already done?" check before the winning call's marker had actually landed. Most likely real trigger (not a literal double-click on Rent, see below): `editContractFromJson`'s deposit-method-change sync block calls `logSecurityDepositFromJson` with ZERO idempotency guard of any kind (by design, per that function's own header comment -- an assumption that holds for the row-overwrite parts of an edit but NOT for this append-only side effect) -- a resubmitted/retried "Save changes" on a deposit-method change would log the deposit twice with the OLD code, no special timing needed. | A security deposit should be logged exactly once per contract, no matter how many times the triggering request is resubmitted (network retry, double-click, etc.). | Confirmed live via the real incident itself (the duplicate Bank entry Anton found); pre-fix reproduction on live prod was deliberately not attempted further to avoid compounding the discrepancy -- root cause instead confirmed by code read against the exact live incident's shape. Fix verified post-deploy, see Status. | High -- silent double-counting of a real customer security deposit, directly threw off the live Bank balance; recurring ("this is the second time I'm having to fix it" -- Anton). | **FIXED & VERIFIED** (2026-09-04) -- `logSecurityDepositFromJson` (ported identically into all 3 duplicated copies) now retries on conflict (3 attempts) and, before appending, scans the target category for an existing ACTIVE row already stamped with this same `contractRowNumber` -- if found, returns it instead of appending a duplicate. `markTxnIdFromJson`/`markCustomerNotesTxnIdFromJson` (all 3 copies) now retry on conflict with a re-check for an existing marker before each retry, so a losing concurrent call throws cleanly instead of racing to also "succeed"; `customersWrites.js`'s copy was also moved out of the concurrent `chainMarkerAndLedger()` into a sequential, hard-failing step right after the customer-row write, matching `contractWrites.js`'s existing pattern (previously ran concurrently with its own failure silently swallowed). Frontend: `contract.html`'s `doRent()` now disables the "Yes, rent it" button the instant it's clicked, as a belt-and-suspenders guard alongside the server-side fix. Deployed commit `11d102b`, confirmed Ready/Production on Vercel. **Retested live against the deployed app, 3 independent reproductions, all pass:** (1) fired the identical `editContract` deposit-method-change request (None→wise) twice -- exactly ONE ฿2,500 entry logged, not two; (2) fired the identical `editContract` request three times in a row (wise→revolut) -- exactly ONE ฿2,700 entry logged, not three; (3) sent the same `customerIntake` booking request 3 times with the same `clientTxnId` (the literal "single bike, pay by scan, deposit by scan, click Rent twice" scenario Anton asked to be tried) -- 1st call created the booking + deposit, 2nd/3rd correctly returned `{idempotentReplay:true}` and made no further writes; exactly one customer row, one ฿2,000 deposit entry. |
| **BUG-06** | Accounts -- Expenses/Income edit (`accounts.html`, `editExpenseRowFromJson`/`editIncomeRowFromJson` in `lib/accountsWrites.js`) | CONC-01 | 1. Open the same Expense (or Income) row for edit in two separate browser tabs/sessions at once, as if two staff members had it open simultaneously -- confirm both start from the identical snapshot (e.g. amount=100, payment=Wise). 2. In tab A change ONLY the amount; in tab B change ONLY the payment method (each tab's form still holds its own now-stale copy of the field it did NOT touch). 3. Save tab A, then save tab B shortly after (a few ms to a few seconds apart -- no exact race timing needed). 4. Check the row's final saved state. | Two staff editing DIFFERENT fields of the same row at nearly the same time should not cause either person's change to silently vanish -- at minimum the field neither tab touched should never regress, and ideally both real changes (amount AND payment method) should both end up saved. | Reproduced live, 2/2, symmetrically in both submit orderings (via two real built-in-browser tabs against the same isolated test account, not simulated): whichever tab's save request reached the server LAST won completely -- including for the field it never touched, silently discarding the OTHER tab's real change with zero error, warning, or conflict indicator anywhere. Example: tab A saved amount 100->150 first; tab B saved payment Wise->Cash ~6ms later; final row ended up amount=100 (A's change erased) / payment=Cash. Root cause confirmed by code read: a retry-on-conflict guard exists (`editExpenseRowFromJson`/`editIncomeRowFromJson`, `lib/accountsWrites.js` ~line 2028) and correctly catches the underlying optimistic-concurrency `ConflictError`, retrying against a freshly-refetched row instead of throwing -- but on every attempt (including the retry) it rebuilds the row by unconditionally overwriting all 4 core columns (date/expense/amount/payment) with THAT SAME request's own original payload, which for the untouched field(s) is just whatever was already sitting in that browser tab's form when it was opened -- already stale the moment the other tab's edit lands first. So the retry loop stops the request from ever hard-failing, but does nothing to stop the silent field clobber; it is the exact same data-loss bug originally suspected, just now happening one layer deeper (inside the retry's reapply step) instead of the very first unconditional write. | High -- silent financial-data loss with no error surfaced to either staff member, same class and severity as BUG-01/BUG-02, reproduced deterministically (2/2) with no special timing required beyond two people having the same row open, which is an entirely ordinary shared-workspace scenario for a 2+ person staff app. Not Blocker only because it requires a genuine overlap of two edits to the SAME row within a narrow window, rather than being reachable from a single staff action alone. | **FIXED, 2026-09-05** (field-level diff implemented in `lib/accountsWrites.js`) -- **LIVE RETEST ON 2026-09-05 FOUND THIS FIRST VERSION DOES NOT ACTUALLY WORK.** Reproduced the original two-tab scenario against the deployed fix (tab A: amount 100->150; tab B, submitted after A's write had already landed: payment Wise->Cash, with its own stale unedited amount=100 still in the payload) -- final row: amount=100 (A's change lost AGAIN), payment=Cash. Root cause: comparing the payload against `existing` (this request's OWN read of the row) cannot distinguish "the client genuinely intends to change this field" from "this field is just stale, and the CURRENT row already differs because a fully-completed prior write changed it" -- whenever a first edit's write lands before a second edit's own read even happens (an entirely ordinary sequencing, not a rare race), the second request's `existing` already reflects the first edit, and the second request's own untouched-but-stale field then looks "changed" and gets wrongly reapplied. **CORRECTED (same day, still 2026-09-05, NOT YET DEPLOYED -- see §0 handoff):** accounts.html's edit modal now sends its own baseline (`originalDate`/`originalExpense`/`originalAmount`/`originalPayment`, or the income equivalents -- the row as it stood when the modal was opened) alongside the edited values, mirroring the `originalStatus` convention `editContractFromJson` already uses for the identical reason; `editExpenseRowFromJson`/`editIncomeRowFromJson` now diff the new value against that CLIENT baseline instead of `existing`, so intent is captured correctly regardless of how two requests happen to interleave, while the row values actually written still always come from the CURRENT freshly-refetched row. This v2 fix is committed locally but NOT yet pushed/deployed -- retest again once it is. Originally found, not fixed -- per this session's standing instruction to log bugs and keep testing rather than stop to fix them; this was previously written up narratively (see the "CONC-01 retest reveals the fix is INCOMPLETE" note above §1) but had not yet been given its own bug-log row until now. RECOMMENDATION for whoever picks this up: either (a) a field-level diff on the client (only send the field(s) actually changed, `undefined`/omitted for the rest, and have the server only touch keys present in the payload), or (b) on each retry, merge the freshly-refetched row's OTHER 3 columns into the write instead of reapplying the original request's stale copies of them -- (b) is the smaller, single-file change and matches the "retry + patch-reapply" pattern `applyMonthNotesEditsFromJson` already uses correctly elsewhere in this same file (proven under CONC-02 to genuinely work under a real race). |
| **BUG-05** | Bikes Status / Bike Income (`bike-income.html`, root cause spans `lib/bikesWrites.js`, `lib/contractWrites.js`, `lib/customersWrites.js`, `lib/depositsWrites.js`) | INCOME-01 | 1. Note any bike's current-month rental income landing correctly in its own month column on the "bikes" sheet (confirmed all session via direct API reads -- e.g. ZZTEST-Bike-01's "sept" column correctly accumulated to ฿7,000 across several real transactions: initial rent, a deposit deduction, `returnDeposit`). 2. Open `bike-income.html` (no need to expand "SHOW MONTHS") and look at that same bike's headline Income/Profit/Net Profit columns. | The headline Income/Profit/Net Profit figures should reflect the bike's actual accrued rental income, matching a hand-sum of its own month-column rows (per this test case's own stated goal) -- these are meant to be the same money, just displayed two ways (aggregate vs. per-month breakdown). | They do NOT match, confirmed live: ZZTEST-Bike-01 shows Income ฿0 / Profit ฿0 / Net Profit -฿35,000 on `bike-income.html`'s main table, despite genuinely having ฿7,000 of real September rental income sitting in its own "sept" column (independently confirmed via `/api/data/bikes` reads throughout this session) -- same for ZZTEST-Bike-02 and ZZTEST-Bike-03. Root cause fully traced by code read: `bike-income.html`'s main table reads its "Income" figure from the "bikes" sheet's own **`total`** column (a separate, distinct column from the per-month "sept"/"oct"/etc columns, only visible via the page's "SHOW MONTHS" toggle) -- and `total` (along with `expenses`/`profit`/`net profit`) is a pre-computed SUM that has to be explicitly recalculated any time a month cell changes, since the JSON data model has no live spreadsheet formulas. A real recompute function for exactly this (`recomputeBikeRowTotalsB`) DOES exist in the codebase -- but it is ONLY ever called from `accountsWrites.js`'s own "split an expense/income across one or more bikes" feature (the Accounts page's bike-split rows). EVERY rental-flow write path that credits a bike's month column via `addRentalAmountToBikesSheetFromJson`/`addRentalAmountToBikesSheetForMonthFromJson` (each file -- `bikesWrites.js`, `contractWrites.js`, `customersWrites.js`, `depositsWrites.js` -- has its own duplicated copy of this function) NEVER calls the recompute function afterward. Confirmed by grep across the whole codebase: `recomputeBikeRowTotalsB`'s only call site is inside `accountsWrites.js` itself. Real-world impact: for ANY bike (not just these ZZTEST ones) whose rental income comes through the normal Contract/Rent flow, deposit deductions, extensions, or early returns -- i.e. virtually every real rental transaction in this app -- `bike-income.html`'s main Income/Profit/Net Profit table silently understates or shows stale figures, and only the money that happened to also go through Accounts' manual "split across bikes" feature is reflected. Spot-checked one real, long-standing bike ("Aerox cool 1") for contrast: its `total` (฿64,550) currently DOES match a hand-sum of its own month cells -- but only because that bike happens to have had zero September activity yet (`total` = `2025` carryover + Σ Jan-Aug, and Sept/Oct/Nov/Dec are all still `null` for it); the moment it earns ANY rental income through the live app this month, its `total` will silently freeze and go stale exactly like the ZZTEST bikes already have. | High -- this is the app's core "how much has this bike earned" business metric silently going stale for essentially all real rental activity going forward, not just a display glitch on an obscure page; distinguished from Blocker only because the underlying month-by-month data IS correct and recoverable (visible via "SHOW MONTHS", and a fix can recompute `total`/`expenses`/`profit`/`net profit` from it at any time without any data loss). | **Fix applied 2026-09-04** (not yet pushed/deployed/retested -- see §0 handoff). Ported `findBikesHeaderColIdxB`/`recomputeBikeRowTotalsB`/`recomputeBikeRowSoloTotalsB` (plus a small shared `applyBikeRowTotalsCascadeB` wrapper) into `lib/bikesWrites.js`, `lib/contractWrites.js`, `lib/customersWrites.js`, and `lib/depositsWrites.js`, and wired the cascade into every one of those files' own `addRentalAmountToBikesSheetFromJson`/`addRentalAmountToBikesSheetForMonthFromJson` copies (best-effort -- a cascade failure surfaces as a warning after the month-cell write, exactly like `accountsWrites.js`'s own already-correct copy does). Committed (not pushed). NOT done: the one-time repair pass for already-stale real bikes' `total`/`profit`/`net profit` -- still worth doing once this fix is live, since existing real bikes' totals are stale until their next write. STILL NEEDS: push + deploy + live retest (re-check ZZTEST-Bike-01/02/03's headline Income on `bike-income.html` after a fresh rental-income write, confirm it now matches the month-column figure). **RETESTED LIVE 2026-09-04 -- CONFIRMED FIXED**, see top-of-file 🔴 LATEST HANDOFF for full verification detail (before/after bikes-sheet totals + bike-income.html cross-check). |
| **BUG-04** | Contract — Create/Rent (`contract.html`, `addContractFromJson`/`editContractFromJson` in `lib/contractWrites.js`) | CONC-03 | 1. Confirm a bike has an active RENTED contract for specific dates (e.g. ZZTEST-Bike-01, Contract row 1299, "ZZTEST BugRetest One", Rented 2026-09-03 to 2026-09-05). 2. Create a SECOND, completely independent contract for a DIFFERENT customer on the SAME bike with FULLY OVERLAPPING dates (`addContract` then `editContract` to status Rented) -- no need for any special timing or two actual browser tabs; two plain SEQUENTIAL API calls a few seconds apart reproduce it every time. | The app should refuse, or at minimum warn, when a bike already has an active Rented booking for the requested dates -- physically, one scooter cannot be handed to two different customers on the same day. | Both contracts saved successfully as status Rented with `{success:true}` and NO warning of any kind -- confirmed live: Contract row 1299 ("ZZTEST BugRetest One", ZZTEST-Bike-01, Rented 2026-09-03..2026-09-05) and Contract row 1304 ("ZZTEST DoubleBookTest", ZZTEST-Bike-01, Rented 2026-09-03..2026-09-05) coexist right now, both fully Rented, for the identical bike and identical date range. Confirmed by code read that neither `addContractFromJson` nor `editContractFromJson` contains ANY bike-availability/date-overlap check at all -- this isn't a race-condition edge case, it's a complete absence of the validation in the first place. In real use this means: two staff (or the same staff member clicking through twice, or a UI page that hasn't refreshed) can both complete a full Create-then-Rent flow for the same physical bike on overlapping dates with zero pushback from the system -- the only thing that would catch it is a human noticing by eye before handing over keys. | Blocker -- this is a real operational/financial risk (a double-booked physical asset, not just a data-sync discrepancy), silent, and trivially reproducible with no special timing required. | **Found, not yet fixed** -- confirmed live against the deployed app on the isolated test account via direct API calls (bypassing no special UI trick -- the normal `addContract`+`editContract` flow contract.html itself uses). Test contracts (rows 1299, 1304) left in place as evidence/repro; not yet raised as a fix with Anton, flagging per his standing instruction to log bugs as found and keep testing. RECOMMENDATION for whoever picks this up: add an availability check (matching bikeModel + overlapping date range across other Rented/Pending Contract rows) to `addContractFromJson`/`editContractFromJson`, mirroring the kind of guard already proven out elsewhere in this codebase (e.g. the idempotency/conflict patterns in the same file) -- at minimum a clear warning, ideally a hard block with an override for legitimate same-day turnarounds. NUANCE found during 5.14 testing: `available-bikes.html` DOES correctly detect and exclude a bike with any active (non-Returned, not-yet-due) booking -- confirmed live, ZZTEST-Bike-01 and ZZTEST-Bike-02 both correctly did NOT appear in its "not rented right now" list while they had open bookings. So the protection that exists today is advisory-only: it only helps if staff happen to browse that separate page before creating a contract. The actual Create/Rent flow itself (`contract.html`'s main form, which is how staff normally book a bike -- especially a returning customer's usual named bike) performs NO check at all, so nothing stops a booking from going through even though the SAME data that would have flagged it on available-bikes.html was sitting right there in the Contract/customer sheets the whole time. | Blocker -- a real double-booked physical bike, not just a bookkeeping discrepancy. | **Fix applied 2026-09-04** (not yet pushed/deployed/retested -- see §0 handoff). Added a shared `findConflictingRentedContractRowB` overlap check, ported into `lib/contractWrites.js` (`markMatchingContractAsRentedFromJson`, `editContractFromJson`), `lib/customersWrites.js`'s own duplicate `markMatchingContractAsRentedFromJson`, and `lib/bikesWrites.js`'s `flipMatchingContractStatus`. `editContractFromJson`'s direct status-edit path now hard-blocks (throws) on a detected overlap; the concurrent customer-intake chains (which already treat the Rented flip as best-effort, wrapped in try/catch, per their own existing race-safety design) turn a detected overlap into a non-blocking warning instead -- the Contract row simply stays Pending rather than silently flipping to a double-booked Rented, with the reason surfaced to staff. Committed (not pushed -- see push commands in the handoff). STILL NEEDS: push + deploy + live retest exactly like BUG-01/02/03 got (re-attempt this same repro and confirm the second booking is now blocked/warned instead of silently succeeding). **RETESTED LIVE 2026-09-04 -- CONFIRMED FIXED**, see top-of-file 🔴 LATEST HANDOFF for full verification detail (exact server-thrown block message reproduced via the real Edit-contract UI, test contract cleaned up). |
| **BUG-03** | Accounts — Expenses (`accounts.html`, expense-row rendering) | ACC-06 | 1. Accounts → September → Add Expense → description = `<img src=x onerror="window.zztestXssProbe()">ZZTEST XSS img-onerror test`, any amount/payment method → Save. 2. Reload/re-render the Expenses list (it re-renders automatically after save) and check whether the injected handler executed. | User-entered text (expense description) should be rendered as inert text no matter what it contains -- HTML/script content typed into a form field must never be interpreted as markup by the page that displays it back. | The injected `onerror` handler DID execute (confirmed via a harmless test probe function that set a flag when called) -- proof the expense-row renderer inserts this field via `innerHTML` (or equivalent) instead of `textContent`/`innerText`. A first probe with a literal `<script>alert(9)</script>` tag also confirmed a real (inert, non-executing per the `<script>`-via-innerHTML browser rule) `<script>` element was actually created in the live DOM, not just escaped text. Only the Expense description field was tested this way (time-boxed); the same free-text pattern likely exists on Income description/name and possibly other list-rendered fields on this and other pages -- worth a dedicated audit rather than assuming it's isolated to this one field. Real-world impact: any staff account (this app currently has no login allowlist -- already flagged separately) could plant a payload that runs in ANY other staff member's browser the next time they open Accounts for that month, e.g. to silently hit other API endpoints using that staff member's own session. | High -- genuine stored XSS with confirmed code execution, though it requires an already-authenticated staff account to plant (not exploitable by an outside member of the public), so not rated Blocker. | **FIXED & VERIFIED** (2026-09-03) -- root cause (unescaped `innerHTML` insertion of user-controlled text in `renderExpenses`/`renderIncome`/`openSaveReview`/`showCashDisambiguation` in `accounts.html`) fixed via a shared `escapeHtml()` helper applied to every affected field; deployed in commit `7e81625`. Retested live against the deployed app: the same `<img onerror>` XSS probe now renders as inert literal text (confirmed via DOM inspection -- no `<script>`/handler execution, no console errors), test row deleted afterward, balances confirmed back to baseline. Per Anton's instruction ("let's just fix all the bugs... retest them, and then continue"), fixed and retested in the same pass rather than left open. |
| **BUG-02** | Contract — Edit (`contract.html`, `editContractFromJson`'s deposit-ledger-sync block + `clearSecurityDepositAtRowFromJson` in `contractWrites.js`) | CTR-EDIT-02 | 1. Create+Rent a contract with Deposit = Scan, ฿3000 (e.g. ZZTEST Customer One / ZZTEST-Bike-01) -- confirm it appears on `deposits.html` under Bank for that customer, and the Contract row's own hidden deposit-ledger-reference column (col 37) holds a real reference string. 2. Search → open that contract → change Deposit from Scan to Cash → Save Changes. The app reports success (no error shown; in the live UI this reports via a suppressed native `alert()`, so I confirmed the actual outcome with a direct `editContract` API call instead, see below). 3. Re-check `deposits.html` and the Contract row's own deposit-ledger reference column. | Changing a Rented contract's Deposit method away from a ledger-tracked one (Scan/Wise/Revolut) to a non-tracked one (Cash) should clear the OLD ledger entry (this is exactly what the `oldDepositLower !== newDepositLower` sync block in `editContractFromJson` is FOR, per its own header comment) -- and only blank the contract's stored reference once that clear is confirmed to have actually happened. | The Contract row's deposit correctly shows "Cash" and its stored reference (col 37) was blanked to `''`, as if the old Bank entry had been successfully cleared -- but `deposits.html` still lists "ZZTEST Customer One -- ฿3,000.00" under Bank, and a direct fetch of the `September` sheet confirms that row is untouched (date/amount/name all still populated). So the clear silently did NOT happen, but the app believed it had and threw away the only breadcrumb (the reference) that would have let staff find and fix the orphaned entry later -- confirmed by then re-submitting the same edit a second time via the raw API: it now says *"could not be matched automatically (no reference stored on this contract)"*, i.e. the reference really is gone. Net effect: a customer's real security deposit can be silently double-counted forever (both stuck as an un-refundable-looking Bank ledger entry AND the contract itself now shows a different, untracked method), with no error or trace pointing anyone at the problem. Root cause not fully isolated (didn't dig into whether `clearSecurityDepositAtRowFromJson`'s `alreadyEmpty` pre-check is misreading the row, or the stored reference's row number was off from the start) -- flagging for a code-level look rather than guessing further. | Blocker -- this is a real, silent, un-traceable deposit-ledger discrepancy (money literally going untracked), on the exact class of financial figure this whole testing effort was commissioned to protect. | **FIXED & VERIFIED** (2026-09-03) -- root cause (`editContractFromJson`'s deposit-method-change block blanked the contract's own ledger reference without confirming the old ledger row was actually cleared) fixed by adding a real reference-based clear (`writeContractRefColumnFromJson` alongside the existing `clearSecurityDepositByRefFromJson` clear path), deployed in commit `7e81625`. Retested live end-to-end on a fresh Rented contract (Contract row 1300): changed Deposit method Scan->Wise -- confirmed via direct `/api/data/September` reads that the OLD Bank-category ledger row (row 7) was correctly blanked (date/amount/name all cleared) and a NEW Wise-category ledger row (row 6) was correctly created with the right name/amount/date, with the contract's own deposit-reference column updated to point at the new entry (`September|2026|wise|6`) -- no orphaned entry, no lost reference. |
| **BUG-01** | Contract — Edit (`contract.html`, `editContract`/`editContractFromJson` in `contractWrites.js`) | MBIKE-09 / CTR-EDIT-01 | 1. Create+Rent a contract paid by Cash (e.g. ZZTEST MultiBike Test / ZZTEST-Bike-01, ฿500, paid by cash) -- confirm September's Cash balance moves by ฿500. 2. Search → open that contract → change **Total price** only (500 → 700, payment method left as Cash) → Save Changes. 3. Re-check September's Cash balance and the income row on the `September` sheet. | Editing a Rented contract's total price (or paid-by method) should keep the Accounts income ledger in sync with the Contract sheet -- the two are meant to represent the same booking. | Contract sheet row correctly updates to 700 (confirmed via Search: "Paid: ฿700 via cash"), but the September sheet's income row (col G `ZZTEST-Bike-01 rent 2 days` / `ZZTEST MultiBike Test`) is untouched at the OLD amount (500), and the Accounts summary Cash/Income totals don't move at all. Root cause confirmed by code read: `editContractFromJson` (lib/contractWrites.js ~line 811) only re-syncs the **security deposit** ledger when the Deposit method changes (`oldDepositLower !== newDepositLower` block) -- there is no equivalent sync for the **income/cash ledger** anywhere in this function, for either a Total price change or a Paid-by change. The income row is only ever written once, at Rent time (`customerIntake`/`doRent`), and `editContract` never revisits it. Net effect: the Contract sheet and the Accounts sheet can silently disagree on how much a rental actually earned, with no warning to staff, indefinitely -- exactly the class of discrepancy this whole testing effort exists to catch. **CONFIRMED to also cover CTR-DEL-CASCADE-01** (canceling a RENTED contract, not just editing its price): set a separate clean Rented ฿800-cash contract (ZZTEST MultiBike Test / ZZTEST-Bike-02) straight to Status=Canceled via the same `editContract` action -- September's Cash balance did not move at all (stayed at ฿33,291 before and after), confirming a canceled-after-rented booking's income is never reversed either, same root cause (editContract's blanket lack of any income-ledger sync, regardless of which field changed). | High -- silent financial-figure mismatch, no error/warning shown, would require staff to manually notice and hand-fix the Accounts sheet. Not rated Blocker only because it needs a specific edit-after-rent action (not the default create/rent path, which IS correct per CTR-08/MBIKE-07 above) and doesn't lose or duplicate data, only leaves it stale. | **FIXED & VERIFIED** (2026-09-03) -- root cause (`editContractFromJson` had zero income/cash-ledger sync for a Rented contract's Total price, Paid-by, or Status changes) fixed by adding reference-based reconciliation (new income/cash ledger reference columns 40/41 on the Contract sheet, written at Rent time via `buildIncomeRefB`/`buildCashRefB`, patched or cleared on edit via `patchOrClearIncomeRowFromRefFromJson`/`patchOrClearCashRowFromRefFromJson`), deployed in commit `7e81625`. Retested live end-to-end on a fresh Rented cash contract (Contract row 1300, ZZTEST BugRetest Two) through 3 scenarios, each confirmed via direct `/api/data/<sheet>` reads AND cross-checked against the Accounts summary page: (1) **price-only change** (600->900, still Cash) -- income row amount patched 600->900, Accounts Cash balance moved by the exact +300 delta (฿34,314->฿34,614); (2) **paid-by change** (Cash->Wise, price unchanged) -- old Cash ledger row fully cleared, Wise running total incremented by the contract amount (+900, ฿6,200->฿7,100), Accounts Cash balance dropped back by 900 (฿34,614->฿33,714), income row's payment method patched to 'wise' with amount preserved; (3) **status leaving Rented** (Rented->Returned) -- income row fully cleared/blanked and its ledger reference removed, Wise running total correctly reversed by -900 back to its pre-rent baseline (฿7,100->฿6,200). All three scenarios also confirmed the deposit ledger (BUG-02's concern) was left untouched, correctly isolated from this income/cash sync. |
| **BUG-10** | Contract -- Create/Rent, the BUG-04 overlap-check itself (`findConflictingRentedContractRowB`/`bikeNamesMatchForTaxLookup`, duplicated in `lib/contractWrites.js`, `lib/customersWrites.js`, `lib/bikesWrites.js`) | 5.16 exploratory (probing BUG-04's own fix for a multi-bike-shaped gap) | 1. Book a bike named plainly, e.g. `ZZTEST PrefixCollision`, Rented for a date range (any real availability-check codepath: `editContract` to Rented, or the Pending-picker Rent flow). 2. Create and attempt to Rent a SECOND, completely independent booking for a DIFFERENT physical bike whose name happens to start with the first bike's full name plus a trailing space and a number -- exactly this app's own established "same model, different physical unit" naming convention (real examples already in the fleet per AUDIT-01's findings: "GT black 6", "Nmax grey 1", etc.) -- e.g. `ZZTEST PrefixCollision 6`, same or overlapping dates. | Two DIFFERENT physical bikes should never be treated as the same bike just because one name is a text-prefix of the other -- this app already has a real numbered-unit naming convention for exactly this situation ("Bike model N" = the Nth physical unit of that model), and already has a correct, distinguishing-suffix-aware matcher for it elsewhere in this same codebase (`bikeNamesMatchForRentalLogB`, used for rental-income crediting) that specifically refuses to match e.g. "GT black" against "GT black 6" for exactly this reason. | Confirmed live via direct API calls against the isolated test account (same call shape `editContract`'s real UI Save-changes button sends): booked `ZZTEST PrefixCollision` as Rented for 2026-12-10..15 (row 1317) -- succeeded normally. Then attempted to Rent the CLEARLY DIFFERENT bike `ZZTEST PrefixCollision 6` for the identical date range (row 1318) -- incorrectly BLOCKED with `{success:false,error:"Cannot save this booking as Rented: \"ZZTEST PrefixCollision 6\" is already Rented to ZZTEST PrefixCollision Customer X (Contract row 1317) over an overlapping date range."}`, even though these are two entirely separate, independently-bookable physical bikes by this app's own naming convention. Root cause confirmed by code read: `findConflictingRentedContractRowB` (the exact overlap check BUG-04 added) matches bike names via `bikeNamesMatchForTaxLookup`, which is a bare padded-substring-containment test (`" "+a+" "` contains `" "+b+" "` or vice versa) with NO awareness of trailing distinguishing numbers/suffixes -- so "X" and "X 6" always match, unconditionally. This is a strictly LESS precise matcher than `bikeNamesMatchForRentalLogB` (used correctly for rental-income crediting, see BUG-05's fix), which does the same prefix-style comparison but explicitly refuses to match when the extra trailing token is a number 1-10 or roman numeral I-X (`RENTAL_LOG_DISTINGUISHING_SUFFIXES_B`) -- i.e. this codebase already has the right fix for this exact problem, just not wired into the one place (BUG-04's brand-new overlap check) that most needs it. Confirmed by grep that this same imprecise matcher is the ONLY one used across every one of BUG-04's fix call sites, duplicated identically into all 3 files (`contractWrites.js`, `customersWrites.js`, `bikesWrites.js`) -- so this false-positive risk is systemic to the whole fix, not an isolated call site. Test rows (1317, 1318) both set back to Canceled afterward; confirmed via the cancel response that neither had an income/cash-ledger reference to reverse (consistent with BUG-09 -- these were flipped to Rented via the same raw `editContract` path that finding covers, so no ledger entry was ever created for either), no residue left. | High -- this is a false-positive availability block on a brand-new, deliberately-added safety feature (BUG-04's fix), meaning a real, LEGITIMATE booking for a genuinely available bike could be refused with a confusing, wrong error message ("already Rented to [other customer]") any time two bikes in the fleet happen to share this common "Model" / "Model N" naming relationship -- which, per AUDIT-01's own findings, is already this app's normal naming pattern for multi-unit models. Not rated Blocker because it fails SAFE (over-blocks rather than double-books) and has a trivial workaround (staff can still complete the booking by leaving it Pending, or renaming one bike so the names don't collide) -- but it directly undercuts trust in the just-shipped BUG-04 fix and would likely generate confusing support/complaint traffic the moment it's hit for real. | **FIXED, 2026-09-05** (all 3 duplicated copies of `findConflictingRentedContractRowB` -- `contractWrites.js`/`customersWrites.js`/`bikesWrites.js` -- now use `bikeNamesMatchForRentalLogB` instead of `bikeNamesMatchForTaxLookup`, exactly as recommended below; committed, pushed, deployed, and LIVE-RETESTED 2026-09-05 -- PASSED. Retest: booked `ZZTEST PrefixCollision` Rented Dec 10-15, then successfully booked the genuinely DIFFERENT `ZZTEST PrefixCollision 6` Rented over the identical overlapping dates (previously wrongly blocked -- now succeeds). Negative control confirmed BUG-04's original protection is still intact: a THIRD attempt to Rent the exact same bike name (`ZZTEST PrefixCollision` again) over an overlapping window was correctly blocked with the same error as before. All 3 test contracts, their income/cash ledger entries, canceled/reversed afterward -- September back to its 1142-row baseline, no cash residue. The two flagged real-fleet pairs ("Nmax Grey"/"Nmax Grey 2", "Grand Filano"/"Grand Filano 2") were not separately live-tested (that would require real fleet bookings) but are covered by the same code path just verified. See §0 handoff for the full retest log. Originally found, not fixed -- per this session's standing instruction to log bugs and keep testing rather than stop to fix them. RECOMMENDATION for whoever picks this up: swap `bikeNamesMatchForTaxLookup` for `bikeNamesMatchForRentalLogB` (or port its distinguishing-suffix logic into `bikeNamesMatchForTaxLookup`) specifically inside `findConflictingRentedContractRowB`'s own bike-name comparison (all 3 duplicated copies) -- the rest of `bikeNamesMatchForTaxLookup`'s existing call sites (tax-lookup/pricing-category matching) may have been deliberately tuned looser for that different purpose, so a wholesale swap isn't obviously safe without checking each site; the overlap-check call sites specifically are where this precision actually matters. **This is not theoretical -- confirmed live against the REAL Bike Tax fleet data (read-only scan, 2026-09-04):** of 43 real bike names, 2 pairs already collide under this exact matcher today -- "Nmax Grey" / "Nmax Grey 2" and "Grand Filano" / "Grand Filano 2" (both genuine same-model, different-physical-unit pairs, per this app's own numbering convention). Neither has hit the false-positive yet (a separate read-only scan of current active bookings found no live overlap to trigger it), but the very next time both bikes in either pair get booked over any overlapping window, the SECOND booking will be wrongly refused with a confusing "already Rented to [other customer]" error on a bike that was genuinely free. This raises real urgency on fixing BUG-10 specifically for these two pairs, independent of the general recommendation above. |

| **BUG-11** | Bikes Status -- Extend (`bikes.html`'s Extend panel, `extendBikeRowFromJson` in `lib/bikesWrites.js`) | BIKE-02 / 5.16 exploratory (following on from BUG-04/BUG-10, checking whether the double-booking protection reaches the Extend flow too) | 1. Rent a bike for a fixed window (e.g. `customerIntake`, Dec 1-5). 2. Rent the SAME bike again for a DIFFERENT customer, dates starting right after the first ends (Dec 6-10) -- no overlap yet, both bookings are legitimate at the moment each is made. 3. Go back to the FIRST booking and use bikes.html's "Extend" action to push its due-back date out past the second booking's start (e.g. extend by 6 days: Dec 5 -> Dec 11, which now fully overlaps the second booking's Dec 6-10 window). | Extending a rental's due-back date should be checked against other active bookings for the SAME physical bike, the same way BUG-04's fix now checks a fresh Rent confirmation -- physically, one scooter still can't be with two customers at once, whether the conflict was created by a brand-new booking or by stretching an existing one into someone else's slot. | Confirmed live via direct API calls (same `extendBike` action `bikes.html`'s own Extend panel calls): extended `ZZTEST ExtendOverlap Customer A`'s booking (customer-sheet row 1339, originally Dec 1-5) by 6 days -- succeeded with `{success:true}` and only an unrelated, expected warning (the fictitious ZZTEST bike name has no matching "bikes" sheet row). Return date moved cleanly from 2026-12-05 to 2026-12-11, confirmed via a direct re-fetch -- now FULLY overlapping `ZZTEST ExtendOverlap Customer B`'s already-booked Dec 6-10 window on the exact same bike name (row 1340). No warning, error, or any hint of the conflict anywhere -- both customer-sheet rows now show active, overlapping bookings for the same physical bike, with zero pushback. Root cause confirmed by code read: `extendBikeRowFromJson` never references `findConflictingRentedContractRowB` (or any conflict/overlap check at all) -- it simply reads the "customer" sheet row, pushes `returnDate` (column I) forward by the requested days, and writes it back, with no cross-check against any other row on that same sheet. This is a structurally different gap from BUG-04/BUG-10: those both live in the Contract-row Rent-confirmation paths and are now protected (modulo BUG-10's naming-precision issue); Extend operates directly on the "customer" sheet, a wholly separate write path BUG-04's fix never touched at all, so a bike can still end up double-booked through this door with the exact same real-world consequence BUG-04 was filed to prevent. Test rows (customer-sheet 1339/1340) cannot be deleted (no delete-customer API exists in this codebase, confirmed during earlier CUST-01/02/03 testing) -- left in place as a harmless, clearly-ZZTEST-labeled, isolated-test-account artifact, consistent with existing precedent. The ฿1,100 of real income/cash entries the two bookings and the extend generated (September sheet) WERE fully reversible and have been deleted, cash-ledger balance confirmed back to the exact pre-test baseline (1142 rows). **Scope is broader than just Extend, confirmed by a follow-up code read (not separately live-tested, to avoid piling up more permanent customer-sheet residue for what is clearly the same root cause):** `swapBikeFromJson` (bikes.html's bike-swap action) ALSO never checks whether the bike a customer is being swapped ONTO is already committed elsewhere -- grepped its full ~330-line body for any conflict/overlap/availability reference and found none. `closeBikeForExtendFromJson` (the first half of the "long extension" flow, for extensions that cross a month boundary) itself just flips the old row's situation to Returned with no date logic at all, but its second half is a plain `customerIntakeFromJson` call for the continued booking on a new row -- and `customerIntakeFromJson` has no overlap check either (same as confirmed under CUST-01 and re-confirmed here), so the long-extension path inherits the exact same gap. **The real shape of this bug: the entire "customer" sheet write surface (`customerIntakeFromJson`, `extendBikeRowFromJson`, `swapBikeFromJson`) has ZERO double-booking protection -- only the Contract-sheet Rent-confirmation path (`editContractFromJson`/`markMatchingContractAsRentedFromJson`) got BUG-04's fix.** Since a real booking's customer-sheet row and Contract row are both meant to represent the same reality, this leaves a wide, easy-to-hit gap: BUG-04 only closed the door on ONE of the two places staff can put a bike into an overlapping commitment. | Blocker -- same real-world severity class as BUG-04 itself (a physically double-booked bike, not just a data-sync discrepancy), reachable through a completely ordinary staff action (extending an existing rental) with no special timing or trick required, and NOT covered by BUG-04's fix despite addressing the identical underlying risk. | **FIXED, 2026-09-05** (new `findConflictingActiveCustomerRowB` added to `contractWrites.js`/`customersWrites.js`/`bikesWrites.js` and wired into all 3 confirmed-affected functions -- `customerIntakeFromJson` [all 3 copies], `extendBikeRowFromJson`, `swapBikeFromJson`; committed, pushed, deployed, and LIVE-RETESTED 2026-09-05 -- PASSED, all 3 call sites. Retest 1 (Extend, the original repro exactly): rented a bike Dec 1-5 for Customer A and Dec 6-10 for Customer B, then extended Customer A by 6 days -- previously succeeded silently and created a real double-booking; now correctly BLOCKED (`"...already booked out to ZZTEST BUG11 Customer B..."`), and confirmed the row was NOT partially mutated (return date/price/situation all unchanged after the throw). Retest 2 (swapBike): attempted to swap a customer onto a bike already committed to someone else over an overlapping window -- correctly BLOCKED, row unmutated. Retest 3 (customerIntake, all 3 duplicated routes -- `/api/bikes/write`, `/api/accounts/write`, `/api/contract/write`): a direct new booking for an already-committed bike over overlapping dates was correctly BLOCKED via all three routes. All test income/cash ledger entries reversed afterward -- September back to its 1142-row baseline, no cash residue (customer-sheet rows themselves are permanent, harmless ZZTEST residue, same established constraint as before -- no delete-customer API exists). See §0 handoff for the full retest log. Originally found, not fixed -- per this session's standing instruction to log bugs and keep testing rather than stop to fix them. RECOMMENDATION for whoever picks this up: port a `findConflictingRentedContractRowB`-style check (comparing the bike's date range against every OTHER active, non-Returned row for the same bike name) into all 3 confirmed-affected functions -- `extendBikeRowFromJson`, `customerIntakeFromJson`, and `swapBikeFromJson` -- ideally as one new shared customer-sheet-native check (`findConflictingActiveCustomerRowB` or similar) rather than 3 more independently-duplicated copies, given this codebase's own established pattern of the same logic drifting out of sync across duplicated copies (see BUG-04/BUG-07/BUG-08's histories). Longer term, the two data sources (Contract sheet's Rented rows vs. customer sheet's active rows) maintaining bike-busy state independently, with no cross-validation between them, is itself worth a design conversation -- BUG-04 only closed one of the two doors. **Reassurance check, read-only, 2026-09-04**: scanned all 29 currently-active (non-Returned, non-ZZTEST) rows on the real "customer" sheet for any pair sharing a matching bike name with overlapping dates -- found ZERO conflicts right now, so this gap hasn't (yet) produced a real double-booking in the live-mirrored data. Worth closing before it does, not an active fire today. |


## 7. Progress tracker

| Date | Area tested | Cases run | Pass | Fail | Notes |
|------|-------------|-----------|------|------|-------|
| 2026-09-03 | Plan written (this file + `TESTING-METHODOLOGY.md`) | 0 | — | — | Plan only, per Anton's explicit request — no live testing yet. Waiting on a fresh login. |
| 2026-09-03 | 5.1 Auth & login (`login.html`) | AUTH-01, AUTH-03, AUTH-04, AUTH-05 | 4 | 0 | Tested on `anton.voicemail@gmail.com` (dedicated test account, NOT the live AA Scooters account — Anton's explicit instruction, see below) [corrected 2026-09-03: this account name was wrong -- the actual isolated test account is `anton.weiersmuller@gmail.com`, see §0]. AUTH-01: valid login lands on `index.html` — pass. AUTH-03: session cookie is `Max-Age=180 days` (`lib/session.js`) — long-lived by design, not tested to actual expiry (impractical). AUTH-04: Sign Out (settings.html) redirects cleanly to `login.html` — pass. AUTH-05: direct nav to `bikes.html` while logged out redirects to `login.html?next=%2Fbikes.html` (client-side redirect per `nav.js`'s auth-gate; real security boundary is server-side in every `/api/data`/`/api/write` route per `lib/apiAuth.js` — confirmed by code read, not separately re-tested here). AUTH-02 (wrong password) N/A as originally scoped — this app uses real Google Sign-In (`api/auth/callback.js`), there is no app-level password to get wrong; Google's own consent screen owns that. NOTE (not a bug, a real finding): `api/auth/callback.js` has NO email/domain allowlist — any Google account can sign in and get a full staff session. Flagged to Anton live; he said leave it for now (test-only concern for this pass). |
| 2026-09-03 | 5.13 Add Bike / Fleet (`add-bikes.html`) — addBike + `bike-name-audit.html` | FLEET-01, AUDIT-01 (partial) | 2 | 0 | FLEET-01: `addBike` on `ZZTEST-Bike-01` (Yamaha Aerox, 155CC Standard Key, ฿35,000/฿2,000/0km) — POST `/api/bikes/write` returned `{success:true}` with a real warning worth keeping: "Bike Tax: the Status and day-count columns (G/H) are formulas in the live sheet with no equivalent here -- left blank for this new row." New bike appeared instantly on add-bikes.html's own list (no reload) AND on bikes.html as "NOT RENTED" (fresh nav, not a hard reload) — pass. Contract-picker / Available-Bikes cross-check still pending. AUDIT-01: ran `bike-name-audit.html` against the real seeded Jan-Aug data (not a synthetic case yet) — tool correctly surfaced 15 real pre-existing inconsistencies (e.g. "Aerox Red" vs "Aerox red 1", "GT black 6" vs "Gt black 6", case-only diffs on "Nmax grey 1"/"Nmax Grey"). Confirms the detector genuinely works. NOT YET DONE: the deliberate-ZZTEST-mismatch case from the written plan (create one on purpose, confirm flagged, remove). FINDING (not yet a filed bug — needs a second look): bikes.html showed a bike as "Cbr" while add-bikes.html's own fleet list (sourced from Bike Tax) shows the same bike as "cbr 150" -- a real 3-way naming split between the "bikes"/Operation sheet and Bike Tax. `bike-name-audit.html` does NOT catch this class of mismatch at all -- it only cross-checks Bike Tax vs Parts & Oil vs Customer, never against the "bikes"/Operation sheet that bikes.html itself renders from. Worth deciding whether that's in-scope for the audit tool. **Follow-up 2026-09-04, closing this loop**: checked whether this specific "Cbr" vs "cbr 150" split has any FUNCTIONAL consequence (not just cosmetic) by reading the fuzzy-matchers that actually gate money/availability -- `bikeNamesMatchForRentalLogB` (rental-income crediting, the BUG-05 fix's own matcher) correctly treats "cbr" as a token-prefix of "cbr 150" with no distinguishing-suffix conflict, so it WOULD match and credit correctly; same result under `bikeNamesMatchForTaxLookup` (tax-lookup/pricing, and now also BUG-04's overlap check) via plain substring containment. So this specific pair is cosmetic-only, not a functional bug -- income crediting and availability checks both still find the right bike despite the display-name split. (The matcher-precision investigation this prompted, however, surfaced a real, separate, more serious issue -- see **BUG-10** in section 6: those same matchers mishandle a DIFFERENT, much more common naming pattern, two genuinely different numbered bikes like "GT black" vs "GT black 6".) |
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
| 2026-09-04 | 5.15 Concurrency / multi-staff simultaneous use | CONC-01, CONC-02, CONC-03 | 1 | 2 | Tested via genuinely concurrent (`Promise.all`-fired) and back-to-back sequential API calls against the live deployed app, not simulated -- real race conditions against real Drive-backed JSON files. **CONC-01 → FAILS (silent data loss, not yet filed as its own bug -- see note below)**: two `editExpense` calls against the SAME expense row, each changing a DIFFERENT field (amount vs payment method) as if two staff had the same expense open in separate tabs -- both requests returned `{success:true}` with NO conflict/warning, but the final row only reflects the SECOND request's fields; the FIRST request's field change was silently discarded with no trace, reproduced twice in a row (100%). Root cause confirmed by code read: `editExpenseRowFromJson`'s core write (`lib/accountsWrites.js` ~line 2028) does a single unconditional `writeSheetJson` of all 4 columns (date/expense/amount/payment) using whatever the CALLING client submitted for every field -- there is no optimistic-concurrency retry AND no partial/field-level merge, so a client's stale copy of an untouched field silently overwrites a concurrent edit to just that field. This is the SAME class of bug as BUG-01/02 (silent financial-data loss, no error shown) but on the base Expense/Income edit path specifically, not Contract editing. NOT yet filed as its own BUG-0N number -- flagging here for Anton to decide whether this warrants the same treatment as BUG-01/02/03 (recommend it does, given the established severity bar this session). **CONC-02 → PASSES**: two `editExpense` calls racing a TYPE change (`expenseType`) on the same row -- correctly resolved to ONE consistent, clean value (no corruption, no duplicate entries, no silent total loss) via the `applyMonthNotesEditsFromJson` 3-attempt retry-on-conflict + patch-reapply pattern (the historical fix from §8 item 3) -- confirms that fix genuinely works under a real concurrent race, not just in isolation. **CONC-03 → FAILS, filed as BUG-04 (Blocker)**: attempted to book the same physical bike twice for overlapping dates -- succeeded on the FIRST try with plain sequential (non-racing) calls, no concurrency needed at all. See §6 BUG-04 for full detail: `addContractFromJson`/`editContractFromJson` have NO bike-availability/date-overlap check whatsoever. This is more severe than a race condition -- it's a complete absence of the validation. **CONC-01 RE-RETESTED 2026-09-04 (after that session's own 'fix')** -- STILL FAILS, same silent field-clobber, now happening inside the retry-on-conflict reapply step rather than the original unconditional write. Reproduced 2/2, symmetrically, in both submit orderings. See top-of-file 🔴 LATEST HANDOFF for full detail and root-cause. |
| 2026-09-04 | 5.9 File uploads (passport photos, bike photos, WhatsApp AI fill) | FILE-01, FILE-02, FILE-03, FILE-04 (partial) | 3 | 0 (1 minor finding) | Discovered mid-test that the passport-photo upload code visible earlier in `contract.html` (with the `passportPhotoBase64` field bundled into `addContract`) is `__deadCode_oldAddContractFromJson` -- explicitly dead, unreferenced client-side code kept only for comparison. The LIVE path uploads the photo as a genuinely separate follow-up call to `/api/contracts/upload` AFTER the Contract row save succeeds (confirmed by code comment: "deliberately NOT part of the queued request"). Tested that live endpoint directly, plus its bike-photos counterpart (`/api/photos/upload`+`/delete`, used by `bikephotos.html`, a different feature from `bikes.html`). **FILE-01**: valid PNG upload -- pass, file created in the correct per-customer Drive folder with the expected `Photo of Passport - <name> - <date>` naming convention. **FILE-02**: 0-byte upload correctly rejected (400, "Missing photo data."); a non-image mimeType (`application/pdf`) correctly rejected (400, "Only image files can be uploaded here.") -- both clean rejections, no crash, pass. Minor finding, not filed as a bug (plan asked for "clear rejection, no crash" -- this technically half-holds): garbage/invalid base64 text claiming `mimeType:'image/jpeg'` was NOT rejected -- Node's `Buffer.from(str,'base64')` silently strips invalid characters instead of throwing, so a corrupted or fake-extension file is silently accepted and stored as a `.jpg` that will show as broken/unreadable whenever anyone actually opens it. Low real-world severity (immediately visible to whoever opens it, not a silent financial-data issue like BUG-01/02/04) but worth Anton knowing -- true image-content validation (e.g. checking real magic bytes) is not happening anywhere in this upload path. **FILE-03**: tested via the bike-photos flow (passport photos have no delete capability in this app at all -- confirmed by code read, add-only by design, duplicate-detected rather than replaceable) -- uploaded, listed, deleted, and confirmed GENUINELY gone via a fresh server-side `/api/photos/list` re-fetch (not just hidden client-side) -- pass. **FILE-04 (partial -- code read only, not live-tested)**: confirmed by code read that "Fill from WhatsApp (AI)" is a pure form-autofill helper -- it reads name/phone off a screenshot into the Number/Chat-name fields for staff to review before saving, and explicitly never uploads, saves, or sends anything anywhere (confirmed via the feature's own code comment) -- the "does NOT auto-send" safety property the plan asked about is satisfied by the feature's basic design, not just a policy. The "garbled screenshot degrades gracefully" behavioral question was NOT live-tested (would need a real AI call with a deliberately bad image) -- left open for a future pass if Anton wants it. |
| 2026-09-04 | 5.14 Read-only / secondary pages (partial: AVAIL-01, INCOME-01) | AVAIL-01, INCOME-01 | 1 | 1 | **AVAIL-01 → PASSES**: `available-bikes.html` correctly excludes ZZTEST-Bike-01 and ZZTEST-Bike-02 from its "not rented right now" list (both have genuinely active, non-Returned bookings on the customer sheet -- confirmed by direct API cross-check) while correctly including ZZTEST-Bike-03 (returned via our earlier swap test). Confirms this page's availability derivation (scan `customer` sheet for situation != Returned AND returnDate in the future, matched by bike name) works correctly -- also directly relevant to BUG-04: this page WOULD have warned a staff member who checked it first, the protection gap is specifically that the Create/Rent flow itself never consults this same data. **INCOME-01 → FAILS, filed as BUG-05 (High)**: see §6 for full detail -- `bike-income.html`'s main Income/Profit/Net Profit table reads a separate `total`/`profit`/`net profit` column on the "bikes" sheet that is NEVER recomputed by any of the actual rental-income write paths (only by Accounts' own "split across bikes" feature) -- confirmed live (ZZTEST bikes show ฿0 Income despite verified real month-column income) and via full code-path trace (grepped every call site of the one function that DOES recompute it). The rest of §5.14 (PRICE-01, CAL-01, OIL-01, REPLY-01, SET-01) was NOT reached this pass -- session time/budget was prioritized toward Deposits/Customers/Bikes-Status/Concurrency per the plan's own emphasis on financial-risk areas, and toward chasing this and the BUG-04 double-booking finding once they surfaced live. Left for a future pass. |

| 2026-09-04 | Live bug found + fixed mid-session: duplicate security deposit (outside the written plan, Anton's own live discovery) | BUG-07 | 3 (repro/verification runs) | 0 | Anton spotted a real customer's Scan deposit posted twice on `deposits.html` (฿2,000 Bank discrepancy) and asked for it to be fixed and retested multiple times before resuming the plan. Root-caused to `logSecurityDepositFromJson` having no same-contract dedup and the `clientTxnId` marker guard having no retry-with-recheck (see BUG-07 in §6 for full detail) -- most likely actually triggered via a resubmitted `editContract` deposit-method-change edit, not a literal double-click on Rent. Fixed across all 3 duplicated copies (`contractWrites.js`/`customersWrites.js`/`bikesWrites.js`) plus a frontend button-disable guard on `doRent()`, committed `11d102b`, pushed, confirmed deployed (Ready/Production on Vercel). Retested live 3x against the deployed app: (1) duplicate `editContract` deposit-method-change submit (None→wise) x2 -- 1 entry, not 2; (2) same x3 (wise→revolut) -- 1 entry, not 3; (3) duplicate `customerIntake` (single bike, scan/wise pay+deposit) with the same `clientTxnId` x3 -- 1 booking, 1 deposit, retries correctly returned `idempotentReplay:true`. All 3 pass. Test artifacts (new ZZTEST rows) left in place per Anton's own instruction. Resuming the rest of the plan (PRICE-01 fresh start, then CAL-01/OIL-01/REPLY-01/SET-01/5.7-5.8 regression) next. |
| 2026-09-04 | 5.14 Read-only / secondary pages (OIL-01, unattended continuation) | OIL-01 | 1 | 0 | Anton logged into the built-in browser then stepped away, asked for continued unattended testing with no pushes and bugs just logged (not fixed) as found. Fully re-verified `oilchange.html` from scratch (superseding the prior interrupted hand-check): read every bike row via `get_page_text` on both the Kilometers and Date tabs (not a 2-3 bike spot-check). Kilometers tab -- confirmed `km remaining` = `next oil change` - `last kilometers check` exactly for all 40 bikes with km data, and ascending sort order (soonest-due at top) is correct end-to-end; the 3 no-data ZZTEST bikes are correctly bucketed into a separate "MISSING KM DATA" section rather than sorted in. Date tab -- confirmed descending sort by days-since-checked (most-overdue at top) is correct end-to-end; bikes with km data but no `Checked` date (Cbr, Click red, Grand Filano) plus the 3 ZZTEST bikes are correctly bucketed into a separate "MISSING DATE DATA" section rather than sorted in as most-overdue. No bugs found. Moving on to REPLY-01 next per the plan order. |
| 2026-09-04 | 5.14 Read-only / secondary pages (REPLY-01, SET-01, unattended continuation) | REPLY-01, SET-01 | 3 | 0 (both partially blocked, not failed) | Continued the unattended pass. **REPLY-01**: empty-instruction guard works (client-side block, no API call) -- pass. Gibberish instruction correctly fails gracefully via `/api/ai/reply-draft`, but only because NEITHER Claude nor Gemini has an API key configured in this environment (`settings.html` confirms both "Not set") -- so the true happy-path ("generates a reasonable reply") and genuine nonsense-input degradation are BLOCKED pending Anton adding a key himself (never entering one myself, per my own hard rule on API keys/credentials). Confirmed via code read (fetched the page's own inline script) that WhatsApp sending always requires an explicit staff click on "Open WhatsApp, pre-filled", which reads from a `draftText` textarea that's correctly cleared to empty on any generation error (never populated with the raw error string) -- no auto-send path exists. Minor non-bug finding: that button stays clickable even with an empty draft (would open a blank pre-filled chat) -- low severity, logged in the handoff for whoever picks up cosmetics later. **SET-01**: AI-provider-switch behavior blocked for the same missing-key reason. Transaction history cross-checked against this session's own known-real activity -- matches. Deliberately did NOT click "Reset data from latest deploy" (would wipe all ZZTEST rows back to seed baseline, a bulk/irreversible action per §3's safety rules -- Anton's call, not mine to trigger unattended). No bugs found; both cases left partially open pending an AI key. |
| 2026-09-04 | 5.7/5.8 regression re-checks (NOTES-01/02/03), unattended continuation | NOTES-01, NOTES-02, NOTES-03 | 2 | 0 (1 new bug found: BUG-08, not a NOTES-01/02/03 fail) | **NOTES-01/NOTES-02 -- PASS**: added a ZZTEST "To Transfer" expense and a ZZTEST bike-split expense (ZZTEST-Bike-01/02) to September via the real accounts.html Add Expense modal, did a genuine hard-reload (real navigation, not a re-render), confirmed both the type tag and the full bike-split breakdown survived exactly. Code read confirmed `ACCOUNTS_MONTH_HAS_NOTES` is genuinely dead (never referenced) and the live notes-fetch is unconditional, matching the documented fix. Cleaned up afterward via a direct `deleteExpense` call (avoided the real Delete button, which triggers a native `confirm()` dialog I don't click through) -- balance snapshot confirmed back to exact baseline. **NOTES-03 -- surfaced BUG-08**: tested the plan's own suggested rollover-without-waiting approach by writing into October, whose sheet did not exist yet -- the write succeeded but left a structurally broken sheet (no header, no summary/label rows), breaking that whole month's Accounts page (every summary figure unreadable, expense list showing empty despite the row genuinely existing). Filed as BUG-08 (High, see §6) -- root-caused via direct repo read (this machine has vercel-site/ checked out) to a missing `if (!rows.length) throw` guard on `addExpenseRowFromJson`/`addIncomeRowFromJson` specifically (every sibling write function in the same file has it, these two don't). A real mitigation exists (`lib/monthRollover.js` + a daily Vercel Cron pre-creating next month's sheet) but its own comments confirm it already failed once for real this month (September needed a manual emergency fix), so this is worth fixing rather than trusting the cron alone. Left one harmless ZZTEST row in the malformed October sheet -- confirmed it isn't even deletable via the app's own delete function, stopped rather than risk more damage. |
| 2026-09-04 | 5.8 Cash ledger boundary re-check (CASH-01/02/03), unattended continuation | CASH-01, CASH-02, CASH-03 | 3 | 0 | **CASH-01/CASH-03 -- PASS, strong live evidence**: the real "cash" sheet's income side already had only ~9 rows of headroom before its own summary block, so added 9-10 real ZZTEST Cash income entries via the same addIncome action accounts.html uses (one landed twice due to an overlap in my own test script, not a server bug -- no clientTxnId was attached so nothing made the two separate requests idempotent). Watched the raw cash sheet at each step: makeRoomAboveCashSummaryJson correctly spliced room and relocated the "income" label TWICE as the boundary was crossed twice, and the running total ended up exactly right (585176+10=585186) -- nothing silently dropped past the boundary, which is the exact failure this fix exists to prevent. Cleaned up all 10 via deleteIncome, deleting from the highest row number down (lesson learned from the NOTES-01/02 cleanup earlier) -- the duplicate pair correctly triggered the app's own cashRowChoice disambiguation instead of guessing. Final balance back to baseline except for the already-documented BUG-08 leftover's ฿1 Cash/Bank shift (Total unaffected). **CASH-02 -- done via code read**: confirmed makeRoomAboveCashSummaryJson is genuinely duplicated into and wired up in all 4 write-layer files (accountsWrites.js, bikesWrites.js, contractWrites.js, customersWrites.js) via direct repo read (this machine has vercel-site/ checked out locally) -- did not repeat the live boundary-cross for the other 3 entry points since the cash sheet's expense side has ~250 rows of headroom, making that impractical to reach live within this pass; scoping call flagged rather than silently skipped. No bugs found in this area. |

| 2026-09-04 | 5.16 Cross-cutting exploratory charter (Contract multi-bike flow) | (unscripted, per methodology 1) | 2 (confirmed working) | 1 new bug found (BUG-09) | Targeted the plan's own callout ("Particularly worth aiming at: the Contract multi-bike flow, newest, least battle-tested"). **Probe: does the app allow the SAME physical bike to be listed twice within one linked multi-bike group?** Confirmed via code read (`contract.html`'s "+ Add another bike" bike-line inputs, `buildContractTailFieldsB`/`addContractFromJson` in `lib/contractWrites.js`) that nothing -- neither client-side nor server-side -- checks a newly-added bike-line against bikes already chosen elsewhere in the same draft. Reproduced live: created two linked Contract rows (same `linkedGroupId`, `linkedBikeIndex` 0/1) both naming ZZTEST-Bike-01, fully overlapping dates -- both saved as Pending with no error at all. **The good news: BUG-04's overlap-check fix DOES correctly catch this at the Rent step, with no multi-bike-shaped gap** -- flipping row 0 to Rented succeeded, and flipping row 1 (the duplicate) was correctly hard-blocked with the exact "already Rented ... over an overlapping date range" error, because `findConflictingRentedContractRowB` checks purely on bikeModel + date overlap per-row and has no special-case awareness of `linkedGroupId` at all, so a same-bike duplicate inside one group is just an ordinary conflict to it -- confirms this specific interaction between the newest area (multi-bike) and the most recent fix (BUG-04) is already sound. **Minor UX rough edge, not filed as its own bug**: because the guard only fires at the Rent step (not at bike-selection or Create time), a staff member who accidentally repeats a bike across two lines in one multi-bike draft would get all the way through Create successfully and only discover the mistake when "Rent all" partially fails on the second bike -- leaving the group in a mixed state (row 0 Rented, row 1 stuck Pending, both still tagged with the same `linkedGroupId`) rather than being stopped up front with a clear "you already added this bike" message. Worth a small proactive fix (dedupe-check across bike-line inputs, or against `linkedGroupId` siblings before Rent) but not urgent -- the actual double-booking outcome is already fully prevented. **BUG-09 found along the way**: while manually flipping row 0 to Rented via a direct `editContract` call (rather than the dedicated Pending-picker Rent button) to test the above, noticed the income/cash-ledger reference columns stayed blank even though the save succeeded and Paid-by was Cash -- traced this to a real, separate gap in `editContractFromJson` (see BUG-09 in section 6): the generic Edit-contract modal's Status dropdown lets staff flip Pending->Rented directly, but that specific path never creates the income/cash-ledger entry at all (only edits to an ALREADY-Rented contract sync the ledger; the dedicated `customerIntake` Rent-picker path remains correct, per PEND-04). Test rows (1315 Rented / 1316 Pending, ZZTEST-Bike-01, Dec 2026 dates chosen to avoid clashing with the September ZZTEST data already in place) both set back to Canceled afterward -- no residue, and confirmed no stray income/cash entry existed to reverse (that was the whole point of the finding). NOT YET DONE from the 5.16 charter: a dedicated pass on the cash-ledger append paths beyond what 5.8/CASH-01-03 already covered, and the calendar-sync exploratory angle (external Google Calendar API) -- both still open if further session budget allows. |

| 2026-09-04 | 5.6 Accounts -- ACC-07 (Expense Type persistence after a genuine reload) | ACC-07 | 1 | 0 | Added a ZZTEST expense with Type = "Wages/Bike Purchase" via the real `addExpense` action, then did a genuine full browser navigation/reload of `accounts.html` (not just a client-side re-render) and confirmed the row still rendered with its correct type label ("Wages/Bike Purchase") intact -- pass. Confirms the type-note sidecar mechanism (`<month>_notes` sheet, `setExpenseTypeNoteFromJson`/`normalizeExpenseTypeKeyB`) survives a real reload correctly, not just the current session's in-memory state. Side note while setting this up: the first attempt used the literal displayed label "To Transfer" as the `expenseType` value instead of its real dropdown value `transfer` -- `normalizeExpenseTypeKeyB` silently falls back to `business` for any unrecognized key (case-insensitive exact match against `EXPENSE_TYPE_COLORS`'s keys only, no fuzzy/label matching), which is sensible default behavior, not a bug, but worth knowing: any API caller must use the dropdown's underlying value (`business`/`personal`/`wages`/`transfer`/`transferComplete`), not its visible label, or the type silently reverts to Business with no error. Test row deleted afterward, September row count confirmed back to baseline (1142). |

| 2026-09-04 | 5.16 Cross-cutting exploratory charter, continued (probing BUG-04's own new overlap-check for a naming-precision gap) | (unscripted, per methodology 1) | 0 | 1 new bug found (BUG-10) | Followed up on a hunch from the earlier duplicate-bike-in-group probe: this codebase already has TWO different bike-name fuzzy-matchers (`bikeNamesMatchForTaxLookup` -- bare substring containment, and `bikeNamesMatchForRentalLogB` -- prefix-matching WITH an explicit carve-out refusing to match when the extra trailing token is a distinguishing number/roman-numeral, used correctly for rental-income crediting per BUG-05's fix). BUG-04's brand-new overlap check (`findConflictingRentedContractRowB`) uses the FIRST, less precise one. Hypothesis: two different physical bikes named e.g. "X" and "X 6" (this app's own real fleet-naming convention for multiple units of one model, confirmed via AUDIT-01's earlier findings -- "GT black 6", "Nmax grey 1", etc.) would be wrongly treated as the same bike by the overlap check. Tested live and confirmed: `ZZTEST PrefixCollision` (Rented, Dec 10-15) correctly blocked `ZZTEST PrefixCollision 6` (a DIFFERENT bike) from being Rented over the same dates, with the exact "already Rented to [other customer]" error -- a false positive on a completely legitimate, available bike. Filed as **BUG-10** (see section 6) -- High severity (fails safe, but directly undercuts the just-verified BUG-04 fix and would generate real confusion the first time two fleet bikes happen to share this ordinary naming relationship). Confirmed via grep this affects all 3 duplicated copies of the overlap-check (`contractWrites.js`, `customersWrites.js`, `bikesWrites.js`), not just the one call site tested. Test rows (1317 Rented / 1318 blocked-then-Pending) both Canceled afterward, confirmed no ledger residue (consistent with BUG-09 -- flipped to Rented via the same raw `editContract` path, so no income/cash entry was ever created to begin with). This closes out the §5.16 charter's multi-bike/BUG-04-interaction angle with TWO real findings (BUG-09, BUG-10), beyond what the written plan anticipated. |

| 2026-09-04 | 5.16 exploratory, continued (does BUG-04's double-booking protection reach the Extend flow?) | BIKE-02 (revisited) | 0 | 1 new bug found (BUG-11) | Anton asked to keep testing everything except the calendar angle (that's deferred to tomorrow, per CAL-01's own env block). Followed the natural next question after BUG-04/BUG-10: those both protect the Contract-row Rent-confirmation moment -- does anything protect a bike from becoming double-booked by EXTENDING an existing rental past a second, already-booked customer's start date instead? Live test: booked `ZZTEST-ExtendOverlapTest` for Customer A (Dec 1-5) and Customer B (Dec 6-10) -- no overlap yet, both legitimate. Extended Customer A's booking by 6 days via the real `extendBike` action -- succeeded cleanly, new due-back date Dec 11, now fully overlapping Customer B's Dec 6-10 slot on the identical bike, with zero warning anywhere. Confirmed by code read that `extendBikeRowFromJson` has no conflict/overlap check of any kind -- BUG-04's fix never touched this function, since Extend writes directly to the "customer" sheet, a separate data path from the Contract-row Rent-confirmation BUG-04 protects. Filed as **BUG-11**, Blocker (same severity class as BUG-04 -- a real double-booked bike, ordinary staff action, no special timing needed). The ฿1,100 of real income/cash this generated was fully reversed (three `deleteIncome` calls, cash-ledger disambiguation used for the two identical ฿500 rows, confirmed back to the exact 1142-row September baseline); the two customer-sheet rows themselves (1339/1340) can't be deleted -- no delete-customer API exists in this codebase (same constraint already established during CUST-01/02/03) -- left in place as harmless, clearly-labeled ZZTEST residue, consistent with precedent elsewhere in this file. |

| 2026-09-04 | 5.9 File uploads -- FILE-01 remaining sub-case (EXIF-rotated phone photo) | FILE-01 | 1 | 0 | Closed out the one specific FILE-01 sub-case the earlier 5.9 pass left untested: a real EXIF-rotated photo, as an actual phone camera produces when held sideways. Confirmed by code read first that neither `/api/photos/upload` nor `/api/contracts/upload` do ANY image processing (no sharp/jimp/exif library anywhere in either path) -- raw bytes are stored and served completely unmodified, so correctness rests entirely on the browser's own native EXIF handling, not the app's code. Built a genuine test JPEG (Python/Pillow+piexif on Anton's machine): a 400x300 landscape-oriented raw pixel buffer (red top-band / blue bottom-band / green top-left corner, as if photographed sideways) tagged with EXIF Orientation=6 (the standard "rotate 90 CW to display upright" tag). Uploaded it live via `/api/photos/upload` (bike-photos path, same raw pass-through the passport-photo path also uses) and opened the served file directly. Confirmed via `img.naturalWidth`/`naturalHeight` (300x400, i.e. the EXIF-corrected UPRIGHT portrait dimensions, not the raw-stored 400x300 landscape buffer) that Chrome decoded and auto-rotated it correctly at the pixel level, not just via a CSS display hint -- this is the browser's standard, reliable EXIF-aware image decoding, universal across current Chromium/Safari/Firefox. Pass -- no bug; this is inherently safe by construction (the app never touches the bytes, and EXIF-aware rendering has been standard browser behavior for over a decade). Test photo deleted afterward via `/api/photos/delete`, confirmed gone. This closes out FILE-01/5.9 completely -- nothing further open in that section. |


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
