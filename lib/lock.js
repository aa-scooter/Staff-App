// ---- Fail-fast distributed lock for exclusive access to a Drive-backed
// per-month sheet file (2026-09-05). ----
//
// WHY THIS EXISTS: see TESTING.md section 0's 2026-09-05 handoff for the
// full story. Short version -- Google Drive has no compare-and-swap, so
// two concurrent edits to the SAME month's accounts sheet can both pass
// their own "is this file still the version I last read" check and both
// unconditionally overwrite the whole file, with whichever one lands
// physically second silently discarding the other's change. BUG-06's
// v1-v4 fixes all tried to detect-and-heal this after the fact (retry on
// conflict, then re-verify-and-reapply); live retesting proved that
// approach has a structural ceiling -- editExpenseRowFromJson/
// editIncomeRowFromJson do 13-20+ seconds of sequential/parallel Drive
// work per edit (row write, notes sidecar, bikes sheet, cash sheet,
// deposit totals, summary cascade, logging), and there is always a
// residual window between "I confirmed my write stuck" and "I've
// actually finished all my other work and returned" during which another
// equally-slow concurrent edit can still land. No amount of retrying
// closes a window whose size is tied to the whole operation's duration.
//
// The actual fix: a REAL mutual-exclusion lock, acquired before any Drive
// read/write for a given month-sheet file starts and held through the
// ENTIRE edit (not just the row write) -- so two edits to the same file
// can never be in flight at the same time in the first place. This
// closes the race by construction instead of by probability.
//
// FAIL-FAST BY DESIGN (Anton's explicit instruction, 2026-09-05 -- NOT a
// queue): if the lock is already held, acquireLock returns null
// immediately. The caller is expected to throw a ConflictError in that
// case, which api/accounts/write.js already maps to a 409 response
// (`{success:false, isConflict:true, error: message}`) -- the exact same
// path accounts.html's existing conflict-error UI handling already
// understands, so no client-side change is needed. This is expected to
// be rare in real (non-scripted-test) usage; a genuine collision just
// means the second person's Save button shows "someone else is editing
// this right now -- please try again in a few seconds" and their own
// retry (a second click) goes through once the first edit finishes.
//
// BACKING STORE: Upstash Redis's REST API (works from a stateless Vercel
// serverless function with no persistent connection -- a plain fetch()
// per lock op, no new npm dependency). Supports EITHER of the two env
// var namings Vercel's storage integrations generate, checked in this
// order:
//   1. KV_REST_API_URL / KV_REST_API_TOKEN
//      (Vercel Marketplace "KV" / native Upstash-backed KV product)
//   2. UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//      (a direct Upstash integration added from the Storage tab)
// Whichever Anton actually added in the Vercel dashboard, this picks it
// up with no code change -- confirm the exact names via the project's
// Settings -> Environment Variables if locking doesn't seem to be taking
// effect (see the console warning below).
//
// FAILS OPEN if neither pair of env vars is set: acquireLock always
// "succeeds" (returns the sentinel 'no-op') and releaseLock is a no-op.
// This means the code deploys safely even before the Redis/KV
// integration is added in Vercel, but the actual race is only closed
// once it is -- check Vercel's runtime logs for the one-time
// "[lock] no Redis env vars found" warning to confirm which state is
// live in production right now.

let warnedMissingConfig = false;

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn('[lock] no Redis env vars found (checked KV_REST_API_URL/KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) -- locking is DISABLED (failing open). Add the Upstash Redis / Vercel KV integration in the Vercel dashboard (Storage tab) to enable the real fail-fast lock.');
    }
    return null;
  }
  return { url: url.replace(/\/+$/, ''), token };
}

// Sends one Redis command via Upstash's REST API using the JSON-body form
// (POST the command + args as a JSON array) rather than path-encoding --
// the lock-release script below contains quotes/parens that would be
// error-prone to URL-encode by hand, and the body form handles arbitrary
// argument strings correctly with no encoding footguns.
async function redisCommand(config, args) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Redis command failed (' + res.status + '): ' + text);
  }
  const data = await res.json();
  if (data && data.error) throw new Error('Redis command error: ' + data.error);
  return data ? data.result : undefined;
}

// Attempts to acquire an exclusive lock on `key` for up to `ttlSeconds`.
// Returns a unique token string on success (needed to safely release
// later -- see releaseLock), or null if someone else already holds it.
// The TTL is a safety net only: if a request crashes or times out before
// reaching its `finally`, the lock still self-expires instead of
// permanently deadlocking that month's sheet for everyone else.
async function acquireLock(key, ttlSeconds) {
  const config = getRedisConfig();
  if (!config) return 'no-op'; // fail-open: locking disabled, "succeeds" trivially

  const token = 'lock-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  // SET key token NX EX ttlSeconds -- set-if-not-exists with an expiry,
  // Redis's standard building block for a simple distributed lock.
  const result = await redisCommand(config, ['SET', key, token, 'NX', 'EX', String(ttlSeconds)]);
  return result === 'OK' ? token : null;
}

// Releases the lock on `key`, but ONLY if it's still the one WE acquired
// (verified via the token acquireLock returned) -- otherwise a request
// whose TTL already expired (and was re-acquired by someone else in the
// meantime) could delete a lock it no longer owns, letting a THIRD
// concurrent request in early. The check-then-delete is done via EVAL so
// it's atomic on the Redis side (no separate GET-then-DEL round trip that
// could itself race).
async function releaseLock(key, token) {
  if (!token || token === 'no-op') return; // fail-open: nothing was ever actually acquired
  const config = getRedisConfig();
  if (!config) return;

  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  try {
    await redisCommand(config, ['EVAL', script, '1', key, token]);
  } catch (e) {
    // Non-fatal: worst case the lock just sits until its TTL expires on
    // its own -- logging so a pattern of these is visible, but never
    // throwing (the caller's actual edit already succeeded by this point).
    console.warn('[lock] failed to release lock "' + key + '": ' + e.message);
  }
}

module.exports = { acquireLock, releaseLock };
