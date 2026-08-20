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
const { Readable } = require('stream');

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

// ---- Same idea as driveClientFromSession, for the Docs API instead of
// Drive (added 2026-08-20 for lib/contractDocGen.js -- see that file's own
// header comment on why a Docs API client is needed at all now that
// Code.gs, which used to fill in the contract template via
// DocumentApp.replaceText, is gone). Reuses the SAME OAuth2 client
// construction as driveClientFromSession -- the 'drive.file' scope this app
// already has covers Docs API access to files it itself created (the
// contract template's COPY, made via drive.files.copy under this same
// session), per the Docs API's own scope documentation. ----
function docsClientFromSession(session, onTokensRefreshed) {
  const auth = clientFromSession(session, onTokensRefreshed);
  return google.docs({ version: 'v1', auth });
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

// ---- Resolves { id, modifiedTime } for one Drive file, preferring a file
// id already cached on the session over asking Drive to search for it by
// name again (2026-08-15 perf pass -- prompted directly by comparing this
// app's write path against property-app's, at Anton's request; see
// PROGRESS.md). The search findFileInFolderOnce/WithRetry do above is a
// live Drive query that used to run on EVERY read and write of every file,
// no matter how many times that exact file had already been resolved
// earlier in the same session -- plus, via findFileInFolderWithRetry, up to
// ~1s of retry-backoff on any file whose search-index entry hadn't caught
// up yet (see that function's own comment). A direct files.get(fileId)
// lookup by a KNOWN id pays neither cost: it's a single indexed lookup,
// always consistent, never needs a retry. Once a file's id has been
// resolved once per session, every later read/write of that same file
// skips the search entirely -- the same idea api/data/[sheet].js's
// resolveYearFolderId already applies to folder ids, extended here to the
// files themselves.
//
// Self-heals if the cached id turns out stale (deleted by hand in Drive, or
// trashed): a failed/trashed direct lookup drops the cache entry and falls
// back to the normal search-by-name path below, exactly like property-app's
// own reconnect()-on-404 fallback for its cached file id.
//
// `session`, if passed, is a plain object (the decrypted session -- see
// lib/session.js) that the caller is responsible for re-persisting via
// setSessionCookie afterwards; this function only mutates it in memory.
// Optional throughout -- pass null/undefined to always search, unchanged
// from the old behavior (existing callers/tests that don't have a session
// handy don't need to change).
//
// `skipExistenceRetry` has the same meaning as it does for writeJsonFile
// below (see its comment) -- true only for the bulk-seeding caller in
// api/admin/reset.js.
async function resolveFileMeta(drive, folderId, filename, session, skipExistenceRetry) {
  const cacheKey = folderId + '::' + filename;
  const cachedId = session && session.driveFileIds && session.driveFileIds[cacheKey];

  if (cachedId) {
    try {
      const res = await drive.files.get({ fileId: cachedId, fields: 'id, modifiedTime, trashed' });
      if (!res.data.trashed) {
        return { id: res.data.id, modifiedTime: res.data.modifiedTime, cacheKey };
      }
      // Trashed out from under us -- treat exactly like "not found" below.
    } catch (err) {
      // Stale id (deleted, or some other mismatch) -- fall through to the
      // normal search-and-cache path.
    }
    delete session.driveFileIds[cacheKey];
  }

  const found = skipExistenceRetry
    ? await findFileInFolderOnce(drive, folderId, filename)
    : await findFileInFolderWithRetry(drive, folderId, filename);
  if (!found) return null;
  if (session) {
    session.driveFileIds = session.driveFileIds || {};
    session.driveFileIds[cacheKey] = found.id;
  }
  return { id: found.id, modifiedTime: found.modifiedTime, cacheKey };
}

// ---- Reads one JSON file from the app's Drive folder by name (e.g.
// "July.json", "customer.json" -- same filenames the export pipeline
// already uses). Returns { data, fileId, modifiedTime } so a subsequent
// write can be checked against modifiedTime for a simple conflict guard
// (see writeJsonFile below) -- or { data: null, fileId: null } if the file
// doesn't exist yet (e.g. before the first "reset from deploy" has run).
//
// `session`, if passed, lets this skip the live Drive search on every read
// after the first -- see resolveFileMeta's comment above. Optional and
// backward compatible; omit it to always search, same as before. ----
async function readJsonFile(drive, folderId, filename, session) {
  const file = await resolveFileMeta(drive, folderId, filename, session, false);
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
// for something like editing an expense moments after a reset.
//
// `session`, if passed, is threaded into resolveFileMeta so this write can
// skip the live existence search when a prior read/write in this same
// session already resolved this exact file's id -- see resolveFileMeta's
// comment for why that search was the real cost behind "writes feel slow".
// Optional and backward compatible: omit it to always search, same as
// before. ----
async function writeJsonFile(drive, folderId, filename, data, expectedModifiedTime, skipExistenceRetry, session) {
  const existing = await resolveFileMeta(drive, folderId, filename, session, skipExistenceRetry);
  if (expectedModifiedTime && existing && existing.modifiedTime !== expectedModifiedTime) {
    throw new ConflictError(
      `"${filename}" was changed by someone else since it was loaded (at ${existing.modifiedTime}) -- reload and try again.`
    );
  }

  const body = JSON.stringify(data);
  const media = { mimeType: 'application/json', body };

  if (existing) {
    try {
      const updated = await drive.files.update({ fileId: existing.id, media, fields: 'id, modifiedTime' });
      return { fileId: existing.id, modifiedTime: updated.data.modifiedTime };
    } catch (err) {
      // The cached id was confirmed to exist a moment ago (resolveFileMeta
      // just checked it) but could in principle still have been deleted in
      // the brief window between that check and this write -- vanishingly
      // rare for a 2-person app, but worth clearing the now-stale cache
      // entry so the NEXT request self-heals via a fresh search, rather
      // than repeatedly retrying a dead id. Doesn't retry automatically
      // within this same request -- surfacing the failure and letting the
      // caller (or the person) retry is safer than silently creating a
      // duplicate file mid-write.
      if (session && session.driveFileIds && existing.cacheKey) {
        delete session.driveFileIds[existing.cacheKey];
      }
      throw err;
    }
  }
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media,
    fields: 'id, modifiedTime'
  });
  if (session) {
    const cacheKey = folderId + '::' + filename;
    session.driveFileIds = session.driveFileIds || {};
    session.driveFileIds[cacheKey] = created.data.id;
  }
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

// Same as findNamedFolder above, but searches the WHOLE Drive rather than
// one specific parent -- i.e. exactly DriveApp.getFoldersByName(name) in
// Code.gs (Apps Script), which is unscoped by parent. Used only by
// ensureContractsRootFolder below (see its own comment for why the
// Contracts root specifically needs this, unlike the Bike Photos root).
async function findNamedFolderAnywhere(drive, name) {
  const escaped = String(name).replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });
  // If more than one non-trashed folder shares this name (shouldn't
  // normally happen), just take the first -- same "good enough" behavior
  // as Code.gs's own DriveApp.getFoldersByName(...).next() iteration.
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

// ---- Lists every non-folder file directly inside a folder (no mimeType
// filter -- unlike listImageFilesInFolder, a customer's contract folder
// can hold a passport photo AND PDFs/docs alongside it), newest first. ----
async function listAllFilesInFolder(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name, mimeType, createdTime)',
    orderBy: 'createdTime desc',
    spaces: 'drive',
    pageSize: 1000
  });
  return res.data.files || [];
}

// ---- Per-customer contract-document storage (added 15/08/2026, mirrors
// the "AA Scooters Contracts" folder the legacy Code.gs app maintained --
// see that file's getOrCreateContractsFolder/getOrCreateCustomerContractFolder
// for the original design this replicates). Anton hand-copied the whole
// legacy "AA Scooters Contracts" folder tree (one subfolder per customer,
// named "<rental start date dd-MM-yyyy> - <name> - <phone>", e.g.
// "11-07-2026 - Christian Jay Verona - 081 234 5678") straight into this
// app's own Drive folder via the Drive web UI -- same drive.readonly
// dependency as the Bike Photos fix above, and the same reason a plain
// exact-name match isn't good enough here either: real folder names in
// that copied tree are inconsistently punctuated ("Mr" vs "Mr." vs
// "Miss."), so matching a contract record to its folder needs to tolerate
// that messiness, with a manual picker as the fallback when it can't be
// done confidently (see findContractFolderMatches below). ----
const CONTRACTS_FOLDER_NAME = 'AA Scooters Contracts';

// Title words stripped from the FRONT of a name before comparing --
// "Mr Yassine Zagri" and "Yassine Zagri" should be treated as the same
// person. Punctuation is stripped by normalizeContractName itself before
// this check runs, so "Mr." and "Mr" both reduce to the bare token "mr".
const CONTRACT_NAME_TITLES = new Set(['mr', 'mrs', 'miss', 'ms', 'mx', 'dr']);

function normalizeContractName(s) {
  const norm = (s || '').toString().toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = norm.split(' ').filter(Boolean);
  while (tokens.length > 1 && CONTRACT_NAME_TITLES.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

// Digits only -- so "081 234 5678", "081-234-5678", and "0812345678" all
// compare equal. An empty/missing phone normalizes to '', which is also
// what a folder's literal "no phone" segment normalizes to (see
// parseContractFolderName) -- so a customer with no phone on file still
// matches a legacy "no phone" folder by name alone, instead of the exact
// string mismatch ('' !== 'no phone') the original Code.gs matcher had.
function normalizeContractPhone(s) {
  return (s || '').toString().replace(/\D+/g, '');
}

// The sidecar (contract_docs.json) key for a given name+phone -- shared by
// every route that reads or writes that sidecar, so a lookup always hits
// what an earlier write stored under the exact same key.
function buildContractMatchKey(name, phone) {
  return normalizeContractName(name) + '|' + normalizeContractPhone(phone);
}

// Splits a contract folder's name into its three "<date> - <name> -
// <phone>" parts, the same way Code.gs's findCustomerContractFolder does:
// first segment is the date, LAST segment is the phone (or the literal
// "no phone"), everything in between (rejoined on " - ") is the name --
// safe even if the name itself happens to contain " - ". Returns null for
// anything that doesn't look like a customer folder at all (fewer than 3
// segments).
function parseContractFolderName(folderName) {
  const parts = String(folderName || '').split(' - ');
  if (parts.length < 3) return null;
  const dateStr = parts[0].trim();
  const phoneRaw = parts[parts.length - 1].trim();
  const name = parts.slice(1, parts.length - 1).join(' - ').trim();
  const phone = /^no phone$/i.test(phoneRaw) ? '' : phoneRaw;
  return { dateStr, name, phone };
}

// Scores how well one Drive folder name matches a target name+phone.
// `confident` (name AND phone both match after normalization) means safe
// to use automatically, no picker needed -- anything else is only ever
// offered as a candidate for a human to confirm. Returns { score: 0,
// confident: false } for anything that doesn't look like a customer
// folder or shares nothing in common.
function scoreContractFolderMatch(targetName, targetPhone, folderName) {
  const parsed = parseContractFolderName(folderName);
  if (!parsed) return { score: 0, confident: false, parsed: null };
  const nA = normalizeContractName(targetName);
  const nB = normalizeContractName(parsed.name);
  const pA = normalizeContractPhone(targetPhone);
  const pB = normalizeContractPhone(parsed.phone);
  const nameMatch = !!nA && nA === nB;
  const phoneMatch = pA === pB; // '' === '' counts -- see normalizeContractPhone's comment
  if (nameMatch && phoneMatch) return { score: 100, confident: true, parsed };
  if (nameMatch) return { score: 60, confident: false, parsed };
  if (phoneMatch && pA) return { score: 55, confident: false, parsed }; // non-empty phone match, different name
  // Weak signal: shared name tokens (e.g. a typo'd surname) -- still worth
  // surfacing as a low-ranked candidate rather than not at all.
  const tokensA = new Set(nA.split(' ').filter(Boolean));
  const tokensB = nB.split(' ').filter(Boolean);
  const overlap = tokensB.filter((t) => tokensA.has(t)).length;
  if (overlap > 0) return { score: 20 + overlap * 10, confident: false, parsed };
  return { score: 0, confident: false, parsed };
}

// Finds every subfolder of the contracts root that plausibly matches this
// name+phone, best first -- `confident` is set only when the TOP match is
// itself a confident (name+phone both matched) result, so a caller can
// auto-use it without a picker; `candidates` is always populated (capped
// to the 5 closest) for when a picker is needed. ----
async function findContractFolderMatches(drive, contractsRootId, name, phone) {
  const subfolders = await listSubfolders(drive, contractsRootId);
  const scored = subfolders
    .map((f) => Object.assign({ folder: f }, scoreContractFolderMatch(name, phone, f.name)))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  return {
    confident: top && top.confident ? top.folder : null,
    candidates: scored.slice(0, 5).map((s) => ({ id: s.folder.id, name: s.folder.name, score: s.score }))
  };
}

// FIX 2026-08-17 (live production bug, reported by Anton via contract.html:
// "View Photo of Passport" 404ing, and "a lot of the other ones" too).
// Root cause: this used to be ensureNamedFolder(drive, appFolderId,
// CONTRACTS_FOLDER_NAME) -- i.e. nested inside THIS app's own
// "AA Scooters App Data" root folder, a location that only ever got
// populated by a one-time manual copy Anton did on 2026-08-15. Code.gs's
// getOrCreateContractsFolder(), meanwhile, has always used
// DriveApp.getFoldersByName('AA Scooters Contracts') with NO parent
// restriction -- which resolves to a completely different, TOP-LEVEL
// "My Drive > AA Scooters Contracts" folder. Code.gs is still the thing
// actively creating/updating contract folders today (every receipt
// regenerate, every new contract's passport-photo upload) -- unlike Bike
// Photos, where the equivalent one-time-copy fix stuck because nothing
// keeps writing to the OLD bike-photos location afterward. For Contracts
// specifically, a copy-once fix would immediately start going stale again
// the next time anyone touches a contract, so the durable fix is to point
// THIS app at the SAME real folder Code.gs already writes to, permanently,
// rather than copying data into a second location that Code.gs doesn't
// know about. Anton confirmed: having the old nested "AA Scooters App
// Data > AA Scooters Contracts" folder sit around unused afterward is not
// a problem -- it's just an artifact of the 2026-08-15 migration attempt,
// left alone rather than deleted. ----
async function ensureContractsRootFolder(drive, appFolderId) {
  const found = await findNamedFolderAnywhere(drive, CONTRACTS_FOLDER_NAME);
  if (found) return found.id;
  // None found anywhere (shouldn't happen in practice -- Code.gs would
  // have already created it) -- create one at the TOP level of Drive, same
  // as Code.gs's DriveApp.createFolder(...) always does, NOT nested under
  // appFolderId, so this app and Code.gs stay pointed at the same real
  // folder even starting from a blank slate.
  const created = await drive.files.create({
    requestBody: { name: CONTRACTS_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return created.data.id;
}

// Get-or-create version of findContractFolderMatches -- reuses an existing
// confidently-matched folder (a returning customer's second, third, etc.
// contract keeps landing in the SAME folder, exactly like the legacy
// Code.gs behavior), or creates a fresh one dated to THIS contract's
// rental start date if nothing matches at all. ----
async function ensureContractCustomerFolder(drive, contractsRootId, name, phone, dateStr) {
  const { confident } = await findContractFolderMatches(drive, contractsRootId, name, phone);
  if (confident) return confident.id;
  const folderName = `${dateStr} - ${(name || 'Unnamed').toString().trim()} - ${(phone || '').toString().trim() || 'no phone'}`;
  return ensureNamedFolder(drive, contractsRootId, folderName);
}

// ---- Uploads one photo into a folder. Takes an already-decoded binary
// Buffer -- base64 decoding stays at the API route layer, not buried in
// here, so a future non-base64 upload path (a real multipart request)
// would only need to change the route, not this helper.
//
// FIX (2026-08-15, live production bug reported by Anton via contract.html):
// media.body MUST be a Readable stream here, not a raw Buffer. googleapis'
// underlying multipart-upload builder (apirequest.ts, shared by every
// client the `googleapis` package generates) combines requestBody +
// media into one multipart/related request by checking
// `typeof part.body === 'string'`, and if that's false, unconditionally
// calling `part.body.pipe(...)` -- a plain Buffer has no .pipe method, so
// this threw "part.body.pipe is not a function" on every real upload. This
// was invisible to every test in this project until now because the fake
// Drive test doubles just store media.body directly without exercising
// googleapis' real internals -- confirmed via the library's own source
// (github.com/googleapis/nodejs-googleapis-common) and a matching, long-
// standing GitHub issue (googleapis/google-api-nodejs-client#1833) rather
// than guessed. Readable.from(buffer) is the fix the library's own
// maintainers/community point to for this exact error. Affects every
// caller of this helper -- both contract passport-photo uploads AND bike
// photo uploads (bikephotos.html), since both share this one function. ----
async function createImageFile(drive, folderId, filename, mimeType, buffer) {
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
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
  CONTRACTS_FOLDER_NAME,
  getAuthUrl,
  exchangeCodeForTokens,
  clientFromSession,
  driveClientFromSession,
  docsClientFromSession,
  ensureAppFolder,
  ensureYearFolder,
  readJsonFile,
  writeJsonFile,
  listAppFiles,
  findNamedFolder,
  findNamedFolderAnywhere,
  findBikePhotoFolders,
  bikeNamesMatchForPhotos,
  ensureNamedFolder,
  ensureBikePhotosRootFolder,
  ensureBikeFolder,
  listSubfolders,
  listImageFilesInFolder,
  listAllFilesInFolder,
  createImageFile,
  getFileMetadata,
  getFileMediaBuffer,
  trashFile,
  normalizeContractName,
  normalizeContractPhone,
  buildContractMatchKey,
  parseContractFolderName,
  scoreContractFolderMatch,
  findContractFolderMatches,
  ensureContractsRootFolder,
  ensureContractCustomerFolder,
  ConflictError
};
