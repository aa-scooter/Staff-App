// ---- Google Calendar login: a SECOND, independent Google OAuth connection
// used only for calendar sync, kept deliberately separate from the staff
// Drive login (lib/googleDrive.js). See project discussion, 18/08/2026:
// Anton wants calendar.html to have its own "Connect Calendar" / "Disconnect"
// button so the calendar account can be swapped freely (test account now,
// production account later, or any other account at any point) without
// touching who's logged into the app itself for Drive/bookings.
//
// ---- Why this account also carries drive.readonly, not just calendar ----
// The daily automated sweep (lib/googleCalendarSync.js's dailySweep, run by
// Vercel Cron -- see api/contract/write.js's GET handler) has no browser and
// therefore no staff session cookie to read booking data with. Rather than
// invent a second kind of durable credential just for that, this ONE
// connected account is asked to carry both scopes at once: `calendar` to
// read/write events, and `drive.readonly` so the exact same stored refresh
// token can also open the app's existing Drive data folder ("AA Scooters App
// Data") headlessly and read customer.json/Contract.json for the sweep.
//
// This means: after connecting a calendar account (test or production),
// Anton needs to do ONE manual Drive-sharing step for the automated daily
// sweep to work -- share the "AA Scooters App Data" folder with that
// connected account's email, Viewer access is enough. Nothing else in this
// file requires that share: the interactive, real-time sync hooks (called
// from an already-logged-in staff request) never need this account's own
// Drive access at all -- they read/write calendar_auth.json via the STAFF's
// existing Drive session instead (see calendarClientFromStoredAuth below),
// exactly the same convention api/ai/[...path].js already uses for
// ai_keys.json. Only the headless cron path (automationClientsFromEnv)
// depends on the share.
//
// ---- Why the daily sweep also needs an env var, not just calendar_auth.json ----
// calendar_auth.json lives inside the app's Drive folder, which itself can
// only be opened via an authenticated Drive client -- normally the staff
// session's. A cron job has no session to bootstrap from. To break that
// circularity, the SAME refresh token calendar_auth.json stores also needs
// to be copied, once, into a Vercel environment variable
// (CALENDAR_AUTOMATION_REFRESH_TOKEN) so the cron handler can build its
// clients directly from an env var with no Drive round-trip needed just to
// find its own credentials. The Connect flow's callback logs/returns this
// token once so Anton can copy it in -- see api/auth/callback.js. Whenever
// the connected account changes (test -> production, or any future swap),
// that env var needs updating too, the same "paste in a new value and
// redeploy" pattern this project already uses for other secrets.
const { google } = require('googleapis');

const CALENDAR_AUTH_FILENAME = 'calendar_auth.json';
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

function getRedirectUri() {
  // Same redirect URI as the staff Drive login -- both flows land on
  // api/auth/callback.js, which tells them apart via the aa_oauth_flow
  // cookie login.js sets (see that file). Registering a second redirect URI
  // in the Google Cloud OAuth client is NOT needed because of this.
  const uri = process.env.GOOGLE_REDIRECT_URI;
  if (uri) return uri;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/auth/callback`;
  throw new Error('GOOGLE_REDIRECT_URI is not set and VERCEL_URL is unavailable -- cannot build an OAuth redirect URI.');
}

// Deliberately reuses the SAME Google Cloud OAuth client (GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET) as the staff Drive login -- one Cloud Console
// project, two independent authorization flows against it. This means the
// OAuth consent screen's scope list in Google Cloud Console needs `calendar`
// and `drive.readonly` added alongside whatever's there for Drive already
// (a one-time Console step, separate from this code, same caveat
// lib/googleDrive.js's own comment already flags for drive.readonly).
function newCalendarOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are not set (see project setup notes).');
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

// ---- Step 1 of the Calendar connect flow: the URL to send the browser to.
// access_type/prompt match the Drive login's own reasoning (getAuthUrl in
// lib/googleDrive.js) -- both are required to reliably get a refresh_token
// back. ----
function getCalendarAuthUrl(state) {
  const oauth2Client = newCalendarOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: CALENDAR_SCOPES,
    state: state || ''
  });
}

// ---- Step 2: exchange the one-time code for tokens. ----
async function exchangeCalendarCodeForTokens(code) {
  const oauth2Client = newCalendarOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, token_type, id_token }
}

// ---- Looks up the connected account's own email, right after exchanging
// tokens -- stored alongside the refresh token so calendar.html can show
// "Connected as X" without a second round trip later. ----
async function fetchConnectedEmail(tokens) {
  const oauth2Client = newCalendarOAuthClient();
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const res = await oauth2.userinfo.get();
  return (res.data && res.data.email) || null;
}

// ---- Persistence (interactive path): calendar_auth.json in the app's own
// Drive folder, read/written via the STAFF session's Drive client -- exact
// same convention api/ai/[...path].js uses for ai_keys.json/ai_provider.json
// (see lib/googleDrive.js's readJsonFile/writeJsonFile). Nothing here needs
// the connected calendar account's own Drive access; it only ever gets
// touched by an already-authenticated staff request. ----
async function saveCalendarAuth(drive, folderId, tokens, email, session) {
  const { writeJsonFile } = require('./googleDrive');
  const payload = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    connected_email: email || null,
    connected_at: new Date().toISOString()
  };
  await writeJsonFile(drive, folderId, CALENDAR_AUTH_FILENAME, payload, null, false, session);
  return payload;
}

async function loadCalendarAuth(drive, folderId, session) {
  const { readJsonFile } = require('./googleDrive');
  const { data } = await readJsonFile(drive, folderId, CALENDAR_AUTH_FILENAME, session);
  return data || null;
}

async function clearCalendarAuth(drive, folderId, session) {
  const { writeJsonFile } = require('./googleDrive');
  await writeJsonFile(drive, folderId, CALENDAR_AUTH_FILENAME, { refresh_token: null, connected_email: null }, null, false, session);
}

// ---- Builds an authenticated google.calendar client from whatever's
// currently stored in calendar_auth.json (read via the staff session's own
// Drive client, passed in). Returns null (never throws) if nothing's
// connected yet -- every caller in lib/googleCalendarSync.js treats a null
// client as "calendar not configured yet, skip quietly", the same shape
// Code.gs's own CALENDAR_ID-not-set early-return already uses. ----
async function calendarClientFromStoredAuth(drive, folderId, session) {
  const stored = await loadCalendarAuth(drive, folderId, session);
  if (!stored || !stored.refresh_token) return null;

  const oauth2Client = newCalendarOAuthClient();
  oauth2Client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: stored.expiry_date
  });
  // Persist a rotated access token back to calendar_auth.json in the
  // background if googleapis refreshes it mid-request -- best-effort, a
  // failure here just means the next request refreshes again, never a
  // user-facing error (mirrors clientFromSession's onTokensRefreshed in
  // lib/googleDrive.js, just persisted to a JSON file instead of a cookie).
  oauth2Client.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    saveCalendarAuth(drive, folderId, {
      refresh_token: tokens.refresh_token || stored.refresh_token,
      access_token: tokens.access_token,
      expiry_date: tokens.expiry_date
    }, stored.connected_email, session).catch(() => { /* best-effort, see comment above */ });
  });

  return {
    calendar: google.calendar({ version: 'v3', auth: oauth2Client }),
    connectedEmail: stored.connected_email || null
  };
}

async function getCalendarConnectionStatus(drive, folderId, session) {
  const stored = await loadCalendarAuth(drive, folderId, session);
  return {
    connected: !!(stored && stored.refresh_token),
    email: (stored && stored.connected_email) || null
  };
}

async function disconnectCalendar(drive, folderId, session) {
  await clearCalendarAuth(drive, folderId, session);
}

// ---- Headless path, for the daily cron sweep only (no browser, no staff
// session cookie to read calendar_auth.json with) -- see this file's header
// comment for the full "why". Builds BOTH a calendar client and a
// drive.readonly client straight from env vars, no Drive round-trip needed
// to find its own credentials. Returns null if the env var isn't set yet
// (i.e. Anton hasn't done the one-time copy-into-Vercel step after
// connecting) -- the cron handler treats that as "sweep not configured yet,
// skip quietly and log it", never a hard failure. ----
function automationClientsFromEnv() {
  const refreshToken = process.env.CALENDAR_AUTOMATION_REFRESH_TOKEN;
  if (!refreshToken) return null;

  const oauth2Client = newCalendarOAuthClient();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return {
    calendar: google.calendar({ version: 'v3', auth: oauth2Client }),
    drive: google.drive({ version: 'v3', auth: oauth2Client }),
    connectedEmail: process.env.CALENDAR_AUTOMATION_EMAIL || null
  };
}

module.exports = {
  CALENDAR_AUTH_FILENAME,
  CALENDAR_SCOPES,
  getCalendarAuthUrl,
  exchangeCalendarCodeForTokens,
  fetchConnectedEmail,
  saveCalendarAuth,
  loadCalendarAuth,
  clearCalendarAuth,
  calendarClientFromStoredAuth,
  getCalendarConnectionStatus,
  disconnectCalendar,
  automationClientsFromEnv
};
