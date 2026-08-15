// ---- Google Drive access for the staff app's data store. ----
//
// This replaces Code.gs/the live spreadsheet as the app's actual database
// (see project discussion, 13/08/2026): each sheet's JSON export lives as
// its own file in one Drive folder, owned by whichever Google account signs
// in (only Anton + his wife -- see project notes on why this doesn't need
// to handle multiple independent users/folders).
//
// Scope: drive.file for writes (creating/updating the app's own sheet files
// and bike-photo uploads -- the narrowest permission that works for those),
// PLUS drive.readonly (added 15/08/2026) so the app can also READ files it
// did NOT create itself -- specifically, the legacy "AA Scooters Bike
// Photos" folder tree and anything Anton copies/uploads into the new
// "Bike Photos" folder directly through Drive's own web UI rather than
// through this app. Under drive.file ALONE, files.list/files.get only ever
// see files this OAuth client created (or that were explicitly picked via
// Google Picker) -- a file dragged into a folder via drive.google.com,
// even a folder the app created, stays invisible to the app forever. That
// was confirmed 15/08/2026: Anton manually copied legacy bike-photo
// folders into the app's "Bike Photos" folder and bikephotos.html still
// showed 0 covered -- not a naming/matching bug, the app genuinely could
// not see those files at all.
//
// This is an acceptable scope for a 2-person internal tool where the app's
// only users (Anton + his wife) already own every file in the Drive being
// read -- there's no other-user privacy boundary being crossed the way
// there would be in a public multi-tenant app, which is the scenario
// Google's "sensitive scope" review process is really guarding against.
// The OAuth consent screen's "Data access" / scopes list needs
// drive.readonly added there too (a one-time Google Cloud Console step,
// separate from this code) before Google will actually grant it -- adding
// it to this array alone isn't sufficient. Existing logged-in sessions
// won't have this scope on their token; a normal log-out/log-in re-triggers
// the consent screen (prompt:'consent' is already forced below) and picks
// it up.
const { google } = require('googleapis');

const APP_FOLDER_NAME = 'AA Scooters App Data';
const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
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

// ---- Finds the app's data folder (by name), creating it if this is truly
// the first run. Returns the folder's file ID, which callers should cache
// in the session cookie afterwards rather than re-searching on every
// request.
//
// Scoped to `'root' in parents` (added 15/08/2026, alongside the
// drive.readonly scope addition above) -- this folder is always created
// with no explicit parent, which Drive puts directly under "My Drive", so
// this is exact, not just defensive. Under drive.file-only scope this
// query was unambiguous for free (the app could only ever see folders it
// created, regardless of name); now that reads can see the whole Drive, an
// unscoped name-only search could in principle match some unrelated folder
// Anton happens to also have named "AA Scooters App Data" -- pinning to
// root rules that out. ----
async function ensureAppFolder(drive) {
  const res = await drive.files.list({
    q: `name = '${APP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`,
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Finds (or creates) a per-year subfolder inside the app's root Drive
// folder, e.g. "2026" -- used for monthly sheets now that there's no more
// "new spreadsheet every year" convention to keep month names unambiguous
// (see project discussion, 13/08/2026: a bare "July.json" would collide
// between July 2026 and July 2027). Same search-or-create pattern as
// ensureAppFolder, just nested one level down and scoped by folder name AND
// parent id (so a same-named year folder some OTHER app/folder happens to
// have -- e.g. a plain "2026" folder somewhere unrelated in Drive -- is
// never a match; exact regardless of how broad the read scope is). ----
async function ensureYearFolder(drive, appFolderId, year) {
  const yearStr = String(year);
  const res = await drive.files.list({
    q: `name = '${yearStr}' and mimeType = 'application/vnd.google-apps.folder' and '${appFolderId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name: yearStr,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [appFolderId]
    },
    fields: 'id'
  });
  return created.data.id;
}

// ---- Looks up one file by exact name within a folder, via Drive's
// files.list search -- ONE attempt, no retry. Used internally wherever a
// "not found" genuinely just means "doesn't exist yet" (e.g. writeJsonFile
// deciding whether to create vs. update) -- retrying here would just add
// ~1s of pure waste to every brand-new file's first write, which matters
// when e.g. the "reset from deploy" button is creating 26 files in a row. ----
async function findFileInFolderOnce(drive, folderId, filename) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields: 'files(id, name, modifiedTime, md5Checksum)',
    spaces: 'drive'
  });
  return (res.data.files && res.data.files[0]) || null;
}

// ---- Same lookup, but retries a couple of times with a short backoff
// before accepting "not found". Confirmed in practice (13/08/2026): a file
// created moments ago (by a DIFFERENT prior request, e.g. right after
// "reset from deploy" finishes) can briefly come back as "not found" here
// even though it genuinely exists -- Drive's search index isn't always
// immediately consistent with a just-completed write, unlike a direct
// files.get(id) lookup by a known id. Used only by actual reads (see
// readJsonFile below), NOT by the internal existence-check inside
// writeJsonFile -- there, "not found" almost always means "genuinely
// doesn't exist yet", and retrying it everywhere would slow down bulk
// writes for no benefit. A truly nonexistent file still correctly returns
// null here, just ~1s slower, once per sheet (before its first-ever
// write) -- an acceptable cost for an occasional page-load-after-save
// check, not a bulk operation. ----
async function findFileInFolderWithRetry(drive, folderId, filename, attempt) {
  attempt = attempt || 0;
  const found = await findFileInFolderOnce(drive, folderId, filename);
  if (found || attempt >= 2) return found;
  await sleep(350 * (attempt + 1)); // 350ms, then 700ms
  return findFileInFolderWithRetry(drive, folderId, filename, attempt + 1);
}

// ---- Reads one JSON file from the app's Drive folder by name (e.g.
// "July.json", "customer.json" -- same filenames the export pipeline
// already uses). Returns { data, fileId, modifiedTime } so a subsequent
// write can be checked against modifiedTime for a simple conflict guard
// (see writeJsonFile below) -- or { data: null, fileId: null } if the file
// doesn't exist yet (e.g. before the first "reset from deploy" has run). ----
async function readJsonFile(drive, folderId, filename) {
  const file = await findFileInFolderWithRetry(drive, folderId, filename);
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

// ---- skipExistenceRetry: true is for bulk-seeding callers ONLY (see
// api/admin/reset.js) that already know they're likely writing brand-new
// files and would otherwise pay the ~1s not-found retry cost PER FILE for
// no benefit. Everywhere else (a normal user-triggered save/edit) keeps
// the retry, since falsely treating a just-created file as "doesn't exist
// yet" here would create a duplicate instead of updating it -- a real risk
// for something like editing an expense moments after a reset. ----
async function writeJsonFile(drive, folderId, filename, data, expectedModifiedTime, skipExistenceRetry) {
  const existing = skipExistenceRetry
    ? await findFileInFolderOnce(drive, folderId, filename)
    : await findFileInFolderWithRetry(drive, folderId, filename);
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

// ---- Bike photo storage (added 14/08/2026 for bikephotos.html's real
// Drive integration -- see that page's own comments for why it was
// deferred until now). One "Bike Photos" folder under the app's root,
// with one subfolder per bike name inside THAT, containing the actual
// photo files. Kept as its own small set of helpers rather than reusing
// readJsonFile/writeJsonFile -- those are specifically shaped around
// "exactly one JSON file per name"; photo storage is genuinely different
// (many binary files per folder, folders keyed by an arbitrary bike name
// rather than a fixed constant or a year). ----
const BIKE_PHOTOS_FOLDER_NAME = 'Bike Photos';

// Lookup-only (no create) version of the search half of ensureNamedFolder
// below -- used wherever finding nothing should mean "this bike has no
// photos yet" rather than "create an empty folder as a side effect of just
// looking" (see api/photos/list.js). Same single-quote escaping as
// ensureNamedFolder, for the same reason.
async function findNamedFolder(drive, parentFolderId, name) {
  const escaped = String(name).replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  return (res.data.files && res.data.files[0]) || null;
}

// ---- Fuzzy bike-name matching, ported from the client-side copy every
// page carries (normalizeBikeName/bikeNamesMatch -- see bikes.html/
// bikephotos.html/etc.) -- kept in lib/ rather than duplicated per-route
// since every route file here is genuinely shared backend code (unlike the
// static HTML pages, which deliberately don't share JS -- see project
// conventions). Needed because a bike's Drive PHOTO FOLDER name and its
// "Parts and Oil change" sheet name don't always match exactly (e.g. a
// legacy folder copied in by hand as "Click red 1" vs the sheet's "Click
// red", or a size/id suffix like "(155)") -- see findBikePhotoFolders
// below, added 15/08/2026 to fix bikephotos.html reporting a bike as
// "has photos" (coverage check, which already fuzzy-matched client-side)
// while its actual photo view showed none (list.js was doing an EXACT
// Drive name match, so a fuzzy-only match was invisible to it). ----
function normalizeBikeNameForPhotos(s) {
  return (s || '').toString()
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
const PHOTO_DISTINGUISHING_SUFFIXES = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'
]);
function bikeNamesMatchForPhotos(a, b) {
  const na = normalizeBikeNameForPhotos(a);
  const nb = normalizeBikeNameForPhotos(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(' ');
  const tb = nb.split(' ');
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  const isPrefix = shorter.every((tok, i) => tok === longer[i]);
  if (isPrefix) {
    const extra = longer.slice(shorter.length);
    if (extra.some((t) => PHOTO_DISTINGUISHING_SUFFIXES.has(t))) return false;
    return true;
  }
  return na.includes(nb) || nb.includes(na);
}

// ---- Every subfolder under the "Bike Photos" root whose name fuzzily
// matches the given bike name -- NOT just the first/only exact-name match
// (see bikeNamesMatchForPhotos above for why an exact match alone misses
// legacy-named folders). Used by api/photos/list.js so a bike's photo view
// finds the same folders the coverage check (api/photos/folders.js,
// fuzzy-matched client-side) already counted as "has photos". Deliberately
// returns ALL matches rather than just one: if a bike ever ends up with
// more than one matching folder (e.g. a legacy hand-copied folder plus a
// separate one this app later auto-created via ensureBikeFolder on a new
// upload), photos from every one of them should still show up together
// rather than only whichever folder happens to be returned first. ----
async function findBikePhotoFolders(drive, bikePhotosRootId, bikeName) {
  const all = await listSubfolders(drive, bikePhotosRootId);
  return all.filter((f) => bikeNamesMatchForPhotos(f.name, bikeName));
}

// Same search-or-create pattern as ensureAppFolder/ensureYearFolder above,
// but for an arbitrary folder name rather than a fixed constant.
async function ensureNamedFolder(drive, parentFolderId, name) {
  const found = await findNamedFolder(drive, parentFolderId, name);
  if (found) return found.id;
  const created = await drive.files.create({
    requestBody: { name: String(name), mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
    fields: 'id'
  });
  return created.data.id;
}

async function ensureBikePhotosRootFolder(drive, appFolderId) {
  return ensureNamedFolder(drive, appFolderId, BIKE_PHOTOS_FOLDER_NAME);
}

async function ensureBikeFolder(drive, bikePhotosRootId, bikeName) {
  return ensureNamedFolder(drive, bikePhotosRootId, bikeName);
}

// ---- Lists the immediate subfolders of a folder (used for the "Bike
// Photos" root -- one subfolder per bike that's ever had a photo
// uploaded). Does NOT recurse -- photo files themselves live one level
// deeper still, inside each of these. ----
async function listSubfolders(drive, parentFolderId) {
  const res = await drive.files.list({
    q: `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1000
  });
  return res.data.files || [];
}

// ---- Lists image files directly inside a folder (a single bike's photo
// folder), newest first -- matches how the gallery should read: most
// recently added photo first. ----
async function listImageFilesInFolder(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`,
    fields: 'files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime desc',
    spaces: 'drive',
    pageSize: 1000
  });
  return res.data.files || [];
}

// ---- Uploads one photo into a folder. Takes an already-decoded binary
// Buffer -- base64 decoding stays at the API route layer, not buried in
// here, so a future non-base64 upload path (a real multipart request)
// would only need to change the route, not this helper. ----
async function createImageFile(drive, folderId, filename, mimeType, buffer) {
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: buffer },
    fields: 'id, name, mimeType, createdTime'
  });
  return created.data;
}

// ---- Fetches just enough metadata to safety-check a delete request (see
// api/photos/delete.js) before touching anything. ----
async function getFileMetadata(drive, fileId) {
  const res = await drive.files.get({ fileId, fields: 'id, name, mimeType, parents, trashed' });
  return res.data;
}

// ---- Downloads a file's raw binary content (a photo, for serving back
// through api/photos/file/[fileId].js's <img> proxy). responseType:
// 'arraybuffer' is required here -- without it, googleapis tries to parse
// the response as JSON/text the same way readJsonFile's plain alt:'media'
// call does, which corrupts binary image data. ----
async function getFileMediaBuffer(drive, fileId) {
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ---- Moves a file to trash (soft delete -- recoverable from Drive's own
// trash for 30 days, same as a normal Drive delete, rather than a
// permanent files.delete). ----
async function trashFile(drive, fileId) {
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

module.exports = {
  APP_FOLDER_NAME,
  DRIVE_SCOPES,
  BIKE_PHOTOS_FOLDER_NAME,
  getAuthUrl,
  exchangeCodeForTokens,
  clientFromSession,
  driveClientFromSession,
  ensureAppFolder,
  ensureYearFolder,
  readJsonFile,
  writeJsonFile,
  listAppFiles,
  findNamedFolder,
  findBikePhotoFolders,
  ensureNamedFolder,
  ensureBikePhotosRootFolder,
  ensureBikeFolder,
  listSubfolders,
  listImageFilesInFolder,
  createImageFile,
  getFileMetadata,
  getFileMediaBuffer,
  trashFile,
  ConflictError
};
