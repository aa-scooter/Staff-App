// ---- Daily/manual JSON data backups + whole-dataset restore. ----
//
// Added 2026-08-20 per Anton: a "you're not completely f***ed" safety net
// on top of the existing "Reset data from latest deploy" button (which only
// ever restores a static seed snapshot, not real point-in-time data -- see
// api/admin/reset.js's own header comment). Snapshots every live data JSON
// file into a dated subfolder under Backups/ in the app's own Drive folder.
//
// AUTH DESIGN, deliberately NOT a headless cron: the app already has one
// headless automation credential (lib/googleCalendarAuth.js's
// CALENDAR_AUTOMATION_REFRESH_TOKEN, for the daily calendar sweep) and it
// turned out to only carry drive.readonly scope -- can't write anything.
// Setting up a SECOND stored write-scoped credential just for backups was
// considered and deliberately rejected (discussed with Anton, 20/08/2026):
// it's one more long-lived secret to keep valid, and this app is used
// daily, so there's always a real staff Drive session (full drive.file
// write scope already) available to piggyback on instead. See nav.js's
// checkDailyBackup() for the client-side trigger -- runs once per page
// load PLUS on an hourly timer (so a tab left open for days, per Anton's
// own workflow on his phone, still catches a new day without a reload),
// calling ensureDailyBackup() below through the CURRENT staff session.
// If nobody's logged in for a few days, nothing changes in the live data
// either, so nothing is lost by simply not backing up on those days --
// the next time someone IS logged in, ensureDailyBackup() catches up.
//
// BACKUP is a pure server-side Drive-to-Drive copy (drive.files.copy) --
// no file content passes through this Vercel function, so it's fast and
// cheap even for the whole ~28-file dataset. RESTORE, by contrast, reads
// and rewrites each file's content through the exact same readJsonFile/
// writeJsonFile helpers every other save in this app already goes
// through, rather than inventing a second, less-exercised write path for
// something this consequential.
const {
  ensureNamedFolder, ensureYearFolder, listAppFiles, listSubfolders, writeJsonFile
} = require('./googleDrive');

const BACKUPS_FOLDER_NAME = 'Backups';

// Config/credential files that live alongside the real data in the same
// Drive folder but are NOT "data" a backup/restore should touch --
// restoring an OLD ai_keys.json or calendar_auth.json over a newer one
// could silently break a working integration for no benefit (these aren't
// what "the data got compromised" is worried about). Every other .json
// file found is treated as backup-worthy data by default (inclusive,
// not an explicit allow-list) so a brand-new sheet added later is
// automatically covered without this file needing an update.
const BACKUP_EXCLUDE_FILENAMES = new Set(['ai_provider.json', 'ai_keys.json', 'calendar_auth.json']);

const RETENTION_DAYS = 30;

// How long since the last backup (of ANY trigger type) before
// ensureDailyBackup() decides a new one is due. 20h rather than a strict
// 24h -- deliberately a bit under a full day so a staff member who opens
// the app at, say, 9:10am two days running still gets a fresh backup each
// time, rather than the exact-24h edge case pushing it later and later.
// Not tied to calendar-day/timezone boundaries at all (see nav.js's own
// comment) -- "has it been a while" is all this needs to mean.
const DAILY_MIN_GAP_MS = 20 * 60 * 60 * 1000;

function timestampFolderName(date) {
  // e.g. "2026-08-20T15-32-07.123Z" -- ISO order sorts chronologically,
  // and colons are swapped for hyphens so this stays a safe folder name
  // even if Anton ever downloads a backup folder as a zip from Drive's
  // own UI onto a filesystem that rejects ':' in names (Windows).
  return date.toISOString().replace(/:/g, '-');
}

async function ensureBackupsRootFolder(drive, appFolderId) {
  return ensureNamedFolder(drive, appFolderId, BACKUPS_FOLDER_NAME);
}

// ---- Every year-subfolder directly under the app root (e.g. "2026") --
// a plain "name is exactly 4 digits" test is enough to tell a year folder
// apart from Backups/Bike Photos/anything else that could ever live
// alongside it here. ----
async function listYearFolders(drive, appFolderId) {
  const subs = await listSubfolders(drive, appFolderId);
  return subs.filter((f) => /^\d{4}$/.test(f.name));
}

// ---- Every live data file this feature backs up: every .json file
// directly in the app root, PLUS every .json file inside each year
// subfolder. listAppFiles() also returns FOLDERS (Backups, Bike Photos,
// any year folder) since it has no mimeType filter -- harmless here, none
// of those names end in ".json" so the filter below already excludes
// them without needing a second Drive query shape. ----
async function collectBackupSources(drive, appFolderId) {
  const sources = [];
  const rootFiles = await listAppFiles(drive, appFolderId);
  for (const f of rootFiles) {
    if (f.name.endsWith('.json') && !BACKUP_EXCLUDE_FILENAMES.has(f.name)) {
      sources.push({ id: f.id, name: f.name });
    }
  }
  const yearFolders = await listYearFolders(drive, appFolderId);
  for (const yf of yearFolders) {
    const files = await listAppFiles(drive, yf.id);
    for (const f of files) {
      if (f.name.endsWith('.json')) sources.push({ id: f.id, name: f.name });
    }
  }
  return sources;
}

// ---- Creates one backup right now (manual button, the daily auto-check,
// or the pre-restore safety snapshot -- `trigger` just labels which). ----
async function createBackup(drive, appFolderId, trigger) {
  const backupsRootId = await ensureBackupsRootFolder(drive, appFolderId);
  const sources = await collectBackupSources(drive, appFolderId);
  const folderName = timestampFolderName(new Date());

  const backupFolder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [backupsRootId],
      appProperties: { trigger: trigger || 'manual' }
    },
    fields: 'id, name, createdTime, appProperties'
  });
  const backupFolderId = backupFolder.data.id;

  // Each copy independently try/catched -- one locked/unreadable source
  // file shouldn't abort the whole backup and leave NOTHING captured;
  // failures are reported back in `errors`, not silently swallowed.
  const files = [];
  const errors = [];
  for (const src of sources) {
    try {
      await drive.files.copy({ fileId: src.id, requestBody: { name: src.name, parents: [backupFolderId] } });
      files.push(src.name);
    } catch (err) {
      errors.push({ file: src.name, error: err.message });
    }
  }

  return {
    id: backupFolderId,
    name: folderName,
    createdAt: backupFolder.data.createdTime,
    trigger: trigger || 'manual',
    fileCount: files.length,
    files,
    errors
  };
}

// ---- Every backup folder currently on file, newest first. ----
async function listBackups(drive, appFolderId) {
  const backupsRootId = await ensureBackupsRootFolder(drive, appFolderId);
  const res = await drive.files.list({
    q: `'${backupsRootId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name, createdTime, appProperties)',
    orderBy: 'createdTime desc',
    spaces: 'drive',
    pageSize: 200
  });
  return (res.data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    createdAt: f.createdTime,
    trigger: (f.appProperties && f.appProperties.trigger) || 'manual'
  }));
}

// ---- Trashes (soft-delete, recoverable from Drive's own trash for 30
// days, same as every other delete in this app) any backup older than
// RETENTION_DAYS. Called after every successful backup creation, not on
// its own schedule -- so it costs nothing extra on the common
// already-backed-up-today no-op path through ensureDailyBackup(). ----
async function pruneOldBackups(drive, appFolderId) {
  const backups = await listBackups(drive, appFolderId);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const stale = backups.filter((b) => Date.parse(b.createdAt) < cutoff);
  for (const b of stale) {
    try { await drive.files.update({ fileId: b.id, requestBody: { trashed: true } }); }
    catch (err) { /* best-effort -- one stuck old backup isn't worth failing this over */ }
  }
  return stale.length;
}

// ---- Creates a backup only if the most recent one on file is older than
// DAILY_MIN_GAP_MS (or none exists yet) -- the "silent, once-a-day-ish"
// path nav.js's checkDailyBackup() calls on every page load + hourly
// timer. A no-op call (the common case -- most page loads land well
// inside the same day's already-done backup) costs exactly one Drive
// list call. ----
async function ensureDailyBackup(drive, appFolderId) {
  const existing = await listBackups(drive, appFolderId); // newest first
  const mostRecent = existing[0];
  const mostRecentAt = mostRecent ? Date.parse(mostRecent.createdAt) : 0;
  if (mostRecent && (Date.now() - mostRecentAt) < DAILY_MIN_GAP_MS) {
    return { created: false, backup: null, mostRecentAt: mostRecent.createdAt };
  }
  const backup = await createBackup(drive, appFolderId, 'auto');
  await pruneOldBackups(drive, appFolderId).catch(() => { /* best-effort */ });
  return { created: true, backup, mostRecentAt: backup.createdAt };
}

// ---- Whole-dataset restore from one backup folder. Always takes a fresh
// "pre-restore" safety backup of whatever's LIVE first (best-effort -- if
// THAT fails, still proceeds with the restore rather than blocking Anton
// from recovering bad data over a safety step hiccup, but reports the
// failure back rather than hiding it), then reads+rewrites every file in
// the chosen backup over the live data, then clears transactionLog.json
// (same reasoning as api/admin/reset.js's own reset flow: a reversible
// entry's before/after values from BEFORE this restore no longer match
// the restored data -- reversing one afterward would silently overwrite
// the restore with stale values). ----
async function restoreBackup(drive, appFolderId, backupId) {
  let preRestoreBackup = null;
  let preRestoreError = null;
  try {
    preRestoreBackup = await createBackup(drive, appFolderId, 'pre-restore');
  } catch (err) {
    preRestoreError = err.message;
  }

  const res = await drive.files.list({
    q: `'${backupId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name)',
    spaces: 'drive',
    pageSize: 1000
  });
  const files = res.data.files || [];
  if (!files.length) {
    throw new Error('This backup has no files (or no longer exists) -- nothing to restore.');
  }

  const yearFolderCache = {};
  async function getYearFolderId(year) {
    if (!yearFolderCache[year]) {
      yearFolderCache[year] = await ensureYearFolder(drive, appFolderId, year);
    }
    return yearFolderCache[year];
  }

  const restored = [];
  const errors = [];
  for (const f of files) {
    try {
      const fileRes = await drive.files.get({ fileId: f.id, alt: 'media' });
      const data = typeof fileRes.data === 'string' ? JSON.parse(fileRes.data) : fileRes.data;

      // A year-scoped file's own filename already carries its year, e.g.
      // "August_2026.json" -- same naming convention api/data/[sheet].js
      // writes it under, so this alone is enough to know where it goes
      // back to without needing any other lookup.
      const yearMatch = /^(.+)_(\d{4})\.json$/.exec(f.name);
      const targetFolderId = yearMatch ? await getYearFolderId(yearMatch[2]) : appFolderId;

      // No expectedModifiedTime, skipExistenceRetry: true -- same
      // reasoning as api/admin/reset.js's own bulk-seed writes: this is
      // an explicit, deliberate "yes, overwrite whatever's there" from a
      // human, not a routine save, and most restore targets already
      // exist (being overwritten, not created), so there's no
      // not-found-retry cost worth paying here either way.
      await writeJsonFile(drive, targetFolderId, f.name, data, null, true);
      restored.push(f.name);
    } catch (err) {
      errors.push({ file: f.name, error: err.message });
    }
  }

  let transactionLogCleared = false;
  try {
    await writeJsonFile(drive, appFolderId, 'transactionLog.json', [], null, true);
    transactionLogCleared = true;
  } catch (err) { /* best-effort, see comment above */ }

  return { restoredFiles: restored, errors, transactionLogCleared, preRestoreBackup, preRestoreError };
}

module.exports = {
  BACKUPS_FOLDER_NAME,
  BACKUP_EXCLUDE_FILENAMES,
  RETENTION_DAYS,
  ensureBackupsRootFolder,
  collectBackupSources,
  createBackup,
  listBackups,
  pruneOldBackups,
  ensureDailyBackup,
  restoreBackup
};
