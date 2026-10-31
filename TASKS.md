# AA Scooters staff app: master task list

Rebuilt 31 Oct 2026 from: PROGRESS.md, TESTING.md, HANDOFF_2026-08-21.md,
the in-app 🐛 Bugs & Features list, and the git history to 30 Oct.
**This file is the single to-do list.** Older handoff notes are history.
Update this file in the same commit whenever a task is done or added.

Who: **Anton** = only Anton can do it · **Claude** = Claude can do it alone
(Anton only pushes) · **Together** = needs both, usually a live check
with real data.

Current live version: commit `6190144` (30 Oct). GitHub, Vercel and
Anton's local copy all match.

---

## P1: Do now (money accuracy, and cutting usage)

| # | Task | Who | Size |
|---|------|-----|------|
| 1 | **Clear the stuck "didn't save" banner.** On the device showing it: Bikes Status → refresh → tap banner → **Discard** (not Retry; it already went through). Fix is live (`6190144`). | Anton | 1 min |
| 2 | **Watch one real return with a deposit.** Return a bike that has a Scan/Wise/Revolut deposit and confirm the deposit row clears on the Deposits page. Checks `90bab13` + `3ec3fe1` end to end. | Together | 5 min |
| 3 | **Byron Stevens ฿1,300 Revolut deposit (31/07/2025)** is still in the Revolut table. Probably a leftover from last year. Decide: remove or keep. | Anton | 1 min |
| 4 | **Give Claude push access** to `aa-scooter/Staff-App` (add as a GitHub collaborator, or link the `AA-Scooters-Project Database` folder). Every fix now costs an extra round of patch → copy → Anton runs git → Claude checks. Cutting that saves real usage. | Anton | 5 min |
| 5 | **Find out why the booking's "deposit" field was blank** for Fabio Buechel even though a Revolut deposit was taken. Something in Rent/intake isn't writing the method onto the customer row. The return popup now copes with this, but the data should be right. | Claude | Small |
| 6 | **Deposits added by hand on the Deposits page aren't linked to a booking.** Those deposits fall back to the name match / pick list on return. Add a "which booking?" picker to the Add Deposit form so it stores the Contract row link. | Claude | Small |
| 7 | **Confirm or close: wrong default date on a new Pending contract** (item 7 of the old August punch list, never confirmed). Anton: has this happened recently? If no, close it. | Anton → Claude | Small |

## P2: Speed (saves are slow)

| # | Task | Who | Size |
|---|------|-----|------|
| 8 | **Re-measure the accounts edit-speed fix** (`646a5e7`, live since 5 Sep, never measured). Exact test and before-numbers are in TESTING.md §0 item 2 (12.8s before; expected ~9–10s). Uses a ZZTEST row that's deleted afterwards. | Claude | Small |
| 9 | **Make "Rent" faster.** `customerIntakeFromJson` (lib/contractWrites.js) re-reads and re-writes the cash + month sheets up to 3 times in one booking. Needs a shared in-memory cache across those steps. Real design work, and this file has a history of money bugs, so build carefully, test with ZZTEST rows, and do it one step at a time. Full notes: TESTING.md §0b. | Claude (+ Anton tests) | Large |
| 10 | Same pattern in `lib/bikesWrites.js` (12 places: Extend/Return/Swap etc.). Do after #9 proves the approach. | Claude | Medium |

## P3: Features from the in-app 🐛 list (still Open)

| # | Task | Who | Size |
|---|------|-----|------|
| 11 | **Tick off two that look done:** "Secure login" and "Ssl fix" (the app now runs on Vercel with HTTPS + Google sign-in). Anton to confirm and mark Done. | Anton | 1 min |
| 12 | **Edit customers** (added 18 Jul). Anton to say what's missing: customers.html already edits some fields. | Anton → Claude | Medium |
| 13 | **Pick-up link when rescheduling a pickup** (21 Jul). "Adjust Pickup" on Bikes Status should also update/send the pickup link. | Claude | Small–Medium |
| 14 | **Show multiple payments** (e.g. part Cash, part Wise) on one rental (23 Jul). Touches money routing, so needs a proper plan first. | Together (plan) → Claude | Large |
| 15 | **"Make walking tick box"** (26 Jul). Anton: what does this mean? (Walk-in customer?) | Anton → Claude | ? |

## P4: Housekeeping (no rush)

| # | Task | Who | Size |
|---|------|-----|------|
| 16 | **Calendar check.** The nightly sync secret is now set (checked 31 Oct). Confirm the 22:00 run is succeeding (sweepLog with the key) and that "Clean Up Duplicates" was run on the 24 duplicate pairs from August. | Together | Small |
| 17 | **Tidy the docs.** PROGRESS.md stops at 26 Aug. TESTING.md's bug table still shows BUG-04/05/06/08/09/10/11 as unfixed, but git shows they were fixed 4–5 Sep. Mark them fixed and point both files at this one. | Claude | Small |
| 18 | Remove dead retry/heal code in `lib/accountsWrites.js` (`HEAL_ATTEMPTS_EXP/INC`, `rowColsMatchB`) now that the Redis lock (BUG-06) is live. | Claude | Small |
| 19 | **Retire the old app** so nobody works from it again: the `/Users/anton/AA-Scooters-Project` folder (Code.gs, HostGator pages; data stops 20 Aug), the old Apps Script deployments, and the HostGator staff pages. Archive, don't delete. | Anton | Small |
| 20 | Untracked files in vercel-site: `BUGFIX_HANDOFF.md`, `HANDOFF_2026-08-26.md`, `TESTING-METHODOLOGY.md`, `_to_delete/`. Keep TESTING-METHODOLOGY.md (commit it); the rest can go once Anton has glanced at them. | Anton | 5 min |
| 21 | Decide the testing approach: keep testing on the real account with ZZTEST rows cleaned up afterwards (what's been done so far), or set up a separate test login. | Anton | Decision |
| 22 | Small untested leftovers: MBIKE-08 (blocked by environment), parts of §5.14 secondary pages, calendar behaviour on extend/return. | Claude | Small |

---

## Already done (so nobody redoes them)

- 30 Oct: Return finds deposit by booking link; looser name match; pick list
  by payment method; stuck "didn't save" banner buttons fixed (`90bab13`,
  `3ec3fe1`, `6190144`).
- Aug punch list items 1–6 (photos 404, cash-sheet drift, stuck Saving,
  autocomplete double-space, Extend amount concat, ServiceWorker): fixed 19 Aug.
- BUG-01 to BUG-11 from testing: all fixed and pushed 3–5 Sep.
- Nightly calendar sync secret (CRON_SECRET): set (checked 31 Oct).
- Code.gs: decommissioned; the full parity audit from Aug is no longer needed
  unless something specific turns up missing.

## How to ship a change (until #4 is done)

Claude commits in a local clone → `git format-patch` → copies the patch to
`/Users/anton/AA-Scooters-Project/<name>.patch` → Anton runs **once**:

    cd "/Users/anton/AA-Scooters-Project Database/vercel-site"
    git am ~/AA-Scooters-Project/<name>.patch
    git push

If `git am` fails, run `git am --abort` and send Claude the output. Vercel
deploys about 3 minutes after the push. One task at a time.
