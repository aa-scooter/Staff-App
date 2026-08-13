// ---- Google Drive access for the staff app's data store. ----
//
// This replaces Code.gs/the live spreadsheet as the app's actual database
// (see project discussion, 13/08/2026): each sheet's JSON export lives as
// its own file in one Drive folder, owned by whichever Google account signs
// in (only Anton + his wife -- see project notes on why this doesn't need
// to handle multiple independent users/folders).
//
// Scope used is drive.file ONLY -- the app can only see/touch files IT
// creates, never anything else in the signed-in account's Drive. That's a
// deliberate choice (narrowest permission that works, avoids Google's
// heavier "sensitive scope" review) as much as a safety one.

const { google } = require('googleapis');

const APP_FOLDER_NAME = 'AA Scooters App Data';
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email'
];

function getRedirectUri() {
  // Set explicitly via env var rather than derived from the request host,
  // so it always matches exactly what's registered in the Google Cloud
  // OAuth client (Google rejects any mismatch) -- see project setup notes.
  const uri = process.env.GOOGLE_REDIRECT_URI;
  if (uri) return uri;
  // Fallback: derive from VERCEL_URL (set automatically by Vercel) so
  // preview deployments work without a manually-set env var too, as long
  // as that preview URL is ALSO registered as an authorized redirect URI
  // in the Google Cloud OAuth client.
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}/api/auth/callback`;
  throw new Error('GOOGLE_REDIRECT_URI is not set and VERCEL_URL is unavailable -- cannot build an OAuth redirect URI.');
}

function newOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars are not set (see project setup notes).');
  }
  return new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
}

// ---- Step 1 of login: the URL to send the browser to. access_type:
// 'offline' + prompt:'consent' are both required to reliably get a
// refresh_token back (Google only issues one on the FIRST consent, or
// every time if prompt=consent is forced) -- without this, a returning
// user's session would only last as long as a short-lived access token. ----
function getAuthUrl(state) {
  const oauth2Client = newOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
    state: state || ''
  });
}

// ---- Step 2 of login: exchange the one-time code Google redirected back
// with for actual tokens. ----
async function exchangeCodeForTokens(code) {
  const oauth2Client = newOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, token_type, id_token }
}

// ---- Builds an authenticated OAuth2 client from a stored session, and
// wires up onTokensRefreshed so the caller can persist a rotated
// access_token back into the session cookie -- googleapis automatically
// refreshes an expired access_token using the refresh_token on the next
// API call and fires a 'tokens' event when it does, but doesn't persist
// that anywhere on its own (there's no server-side session store here to
// persist it TO -- the cookie is it). ----
function clientFromSession(session, onTokensRefreshed) {
  const oauth2Client = newOAuthClient();
  oauth2Client.setCredentials({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expiry_date: session.expiry_date
  });
  if (onTokensRefreshed) {
    oauth2Client.on('tokens', (tokens) => {
      // tokens.refresh_token is only present on the very first exchange in
      // most cases -- don't overwrite a previously-stored refresh_token
      // with undefined on a routine access-token refresh.
      onTokensRefreshed({
        access_token: tokens.access_token || session.access_token,
        refresh_token: tokens.refresh_token || session.refresh_token,
        expiry_date: tokens.expiry_date || session.expiry_date
      });
    });
  }
  return oauth2Client;
}

function driveClientFromSession(session, onTokensRefreshed) {
  const auth = clientFromSession(session, onTokensRefreshed);
  return google.drive({ version: 'v3', auth });
}

// ---- Finds the app's data folder (by name, since drive.file scope means
// we can only ever see folders/files this app itself created -- no
// ambiguity with some OTHER unrelated folder happening to share the name),
// creating it if this is truly the first run. Returns the folder's file ID,
// which callers should cache in the session cookie afterwards rather than
// re-searching on every request. ----
async function ensureAppFolder(drive) {
  const res = await drive.files.list({
    q: `name = '${APP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name: APP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id'
  });
  return created.data.id;
}

async function findFileInFolder(drive, folderId, filename) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields: 'files(id, name, modifiedTime, md5Checksum)',
    spaces: 'drive'
  });
  return (res.data.files && res.data.files[0]) || null;
}

// ---- Reads one JSON file from the app's Drive folder by name (e.g.
// "July.json", "customer.json" -- same filenames the export pipeline
// already uses). Returns { data, fileId, modifiedTime } so a subsequent
// write can be checked against modifiedTime for a simple conflict guard
// (see writeJsonFile below) -- or { data: null, fileId: null } if the file
// doesn't exist yet (e.g. before the first "reset from deploy" has run). ----
async function readJsonFile(drive, folderId, filename) {
  const file = await findFileInFolder(drive, folderId, filename);
  if (!file) return { data: null, fileId: null, modifiedTime: null };
  const res = await drive.files.get({ fileId: file.id, alt: 'media' });
  // googleapis returns res.data already parsed as an object when the
  // response Content-Type is application/json; guard against it coming
  // back as a string too (observed depending on transport).
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return { data, fileId: file.id, modifiedTime: file.modifiedTime };
}

// ---- Writes (creating or replacing) one JSON file in the app's Drive
// folder. If expectedModifiedTime is passed, the file's CURRENT
// modifiedTime is checked immediately before writing -- if it's moved on
// since the caller last read it (someone else saved in between), this
// throws a ConflictError instead of silently overwriting their change.
// Deliberately simple optimistic-locking rather than a real transaction
// (there's no multi-file atomicity here), which is an acceptable tradeoff
// for a 2-person app where overlapping writes to the very same file are
// rare, as long as they're never silent. ----
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.isConflict = true;
  }
}

async function writeJsonFile(drive, folderId, filename, data, expectedModifiedTime) {
  const existing = await findFileInFolder(drive, folderId, filename);
  if (expectedModifiedTime && existing && existing.modifiedTime !== expectedModifiedTime) {
    throw new ConflictError(
      `"${filename}" was changed by someone else since it was loaded (at ${existing.modifiedTime}) -- reload and try again.`
    );
  }

  const body = JSON.stringify(data);
  const media = { mimeType: 'application/json', body };

  if (existing) {
    const updated = await drive.files.update({ fileId: existing.id, media, fields: 'id, modifiedTime' });
    return { fileId: existing.id, modifiedTime: updated.data.modifiedTime };
  }
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media,
    fields: 'id, modifiedTime'
  });
  return { fileId: created.data.id, modifiedTime: created.data.modifiedTime };
}

async function listAppFiles(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, modifiedTime)',
    spaces: 'drive',
    pageSize: 1000
  });
  return res.data.files || [];
}

module.exports = {
  APP_FOLDER_NAME,
  DRIVE_SCOPES,
  getAuthUrl,
  exchangeCodeForTokens,
  clientFromSession,
  driveClientFromSession,
  ensureAppFolder,
  readJsonFile,
  writeJsonFile,
  listAppFiles,
  ConflictError
};
