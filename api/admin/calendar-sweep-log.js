// GET /api/admin/calendar-sweep-log?key=<CRON_SECRET value>
//
// Read-only status/diagnostic endpoint for the nightly calendar dailySweep
// cron (see api/contract/write.js's `?cron=dailySweep` handler and
// lib/googleCalendarSync.js's dailySweep). Added 25/08/2026.
//
// WHY THIS EXISTS: Anton is asleep/away when the sweep runs (22:00
// Bangkok), so any per-row warning it hits has nowhere to surface in real
// time the way bikes.html's "Saved, but: ..." alert does for a live staff
// action. The sweep now writes each run's outcome to
// calendar_sweep_log.json in the app's shared Drive folder (see that
// write's own comment in api/contract/write.js). This endpoint is a thin,
// no-session-required way to read that log back over a plain HTTPS GET --
// so a future Claude session (or Anton, or anyone with the URL+key) can
// check on the sweep without needing Vercel dashboard access, which this
// project's own history shows has been unreliable to reach from a Claude
// session (Vercel MCP only sees an unrelated team; the device Chrome
// bridge errors "Chrome is not running" -- see project memory
// aa-scooters-calendar-nightly-sweep-2026-08-25 for the full trail).
//
// AUTH: reuses CRON_SECRET as the read key rather than inventing a new env
// var -- if CRON_SECRET isn't set, the cron itself can't run anyway, so
// gating on it here adds no extra setup step beyond what dailySweep already
// needs. WITHOUT a matching ?key=, this still safely reports whether the
// two required env vars are SET (booleans only -- never their values,
// never customer data) -- enough on its own to answer "is this configured
// yet at all", which is exactly the open question as of 25/08/2026's
// project memory.
'use strict';

const { automationClientsFromEnv } = require('../../lib/googleCalendarAuth');
const { findNamedFolderAnywhere, readJsonFile, APP_FOLDER_NAME } = require('../../lib/googleDrive');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { success: false, error: 'GET only.' });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const providedKey = (req.query && req.query.key) || '';
  const envStatus = {
    cronSecretSet: !!cronSecret,
    calendarAutomationTokenSet: !!process.env.CALENDAR_AUTOMATION_REFRESH_TOKEN
  };

  if (!cronSecret || providedKey !== cronSecret) {
    sendJson(res, 200, {
      success: true,
      authenticated: false,
      envStatus,
      note: 'Pass ?key=<CRON_SECRET value> to also read the actual sweep log (last runs, stats, per-row errors).'
    });
    return;
  }

  try {
    const automation = automationClientsFromEnv();
    if (!automation) {
      sendJson(res, 200, {
        success: true, authenticated: true, envStatus, sweepConfigured: false,
        reason: 'CALENDAR_AUTOMATION_REFRESH_TOKEN is not set (or invalid) -- automationClientsFromEnv() returned null. See lib/googleCalendarAuth.js.'
      });
      return;
    }
    const found = await findNamedFolderAnywhere(automation.drive, APP_FOLDER_NAME);
    if (!found) {
      sendJson(res, 200, {
        success: true, authenticated: true, envStatus, sweepConfigured: false,
        reason: `Could not find the "${APP_FOLDER_NAME}" Drive folder from the connected calendar account -- has it been shared (Viewer) with that account's email yet? See lib/googleCalendarAuth.js's header comment.`
      });
      return;
    }
    const { data } = await readJsonFile(automation.drive, found.id, 'calendar_sweep_log.json');
    const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
    sendJson(res, 200, {
      success: true,
      authenticated: true,
      envStatus,
      sweepConfigured: true,
      totalEntriesStored: entries.length,
      mostRecent: entries.slice(-10) // last 10 runs, most recent last
    });
  } catch (err) {
    sendJson(res, 500, { success: false, authenticated: true, envStatus, error: err.message });
  }
};
