// GET /api/data/<year>/<sheet> -- reads one YEAR-SCOPED (monthly) sheet's
// current JSON from Drive, e.g. /api/data/2026/July, /api/data/2026/July_notes.
//
// Storage layout (see lib/monthSheets.js and project discussion, 13/08/2026):
// monthly sheets live in a per-year Drive subfolder, filename ALSO carrying
// the year for good measure:
//   <app folder>/<year>/<sheet>_<year>.json
// e.g. <app folder>/2026/July_2026.json, <app folder>/2026/July_notes_2026.json
//
// Global (year-independent) sheets are UNAFFECTED by this route -- they
// keep using the flat /api/data/<sheet> route (api/data/[sheet].js), which
// reads directly from the app folder root.
const { withDrive } = require('../../../lib/apiAuth');
const { readJsonFile, ensureAppFolder, ensureYearFolder } = require('../../../lib/googleDrive');

module.exports = withDrive(async function handler(req, res, { drive, folderId }) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed.' }));
    return;
  }

  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  // Vercel's [year]/[sheet].js dynamic route puts the matched segments on
  // req.query.year / req.query.sheet in the Node runtime; fall back to
  // parsing the path directly so this also works when invoked in a plain
  // Node test harness (mirrors api/data/[sheet].js's fallback).
  const pathParts = url.pathname.split('/').filter(Boolean);
  const yearParam = (req.query && req.query.year) || pathParts[pathParts.length - 2];
  const sheetParam = (req.query && req.query.sheet) || pathParts[pathParts.length - 1];

  const year = decodeURIComponent(yearParam || '').trim();
  const sheet = decodeURIComponent(sheetParam || '').trim();

  if (!/^\d{4}$/.test(year)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Invalid year.' }));
    return;
  }
  if (!sheet || /[\\/]/.test(sheet)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Invalid sheet name.' }));
    return;
  }

  try {
    const effectiveFolderId = folderId || await ensureAppFolder(drive);
    const yearFolderId = await ensureYearFolder(drive, effectiveFolderId, year);
    const filename = `${sheet}_${year}.json`;
    const { data, modifiedTime } = await readJsonFile(drive, yearFolderId, filename);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, year, sheet, rows: data, modifiedTime }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
});
