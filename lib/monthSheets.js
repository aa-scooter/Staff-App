// ---- Shared knowledge of which sheet names are "monthly" (year-scoped)
// vs. "global" (year-independent), used by both api/admin/reset.js and
// api/data/[year]/[sheet].js so the two agree on filenames without
// duplicating the list.
//
// Storage layout on Drive (per project discussion, 13/08/2026): the old
// spreadsheet-per-year convention (archive it, start a fresh spreadsheet
// each January) doesn't exist anymore now that this is a single
// ever-running Drive store -- a bare "July.json" would collide between
// July 2026 and July 2027. Monthly sheets now live in a per-year
// subfolder, filename ALSO carrying the year for good measure:
//   <app folder>/<year>/<MonthName>_<year>.json
//   <app folder>/<year>/<MonthName>_notes_<year>.json   (when it has notes)
// Global (year-independent) sheets are unaffected, still directly in the
// app folder root:
//   <app folder>/<sheet>.json
//
// Matches the exact tab-name casing already used throughout this project
// (some lowercase: "march", "april", "may" -- see export_to_json.py's
// output and Code.gs's ACCOUNTS_MONTH_NAMES).
const MONTH_SHEET_NAMES = [
  'January', 'February', 'march', 'april', 'may', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function isMonthSheetName(name) {
  return MONTH_SHEET_NAMES.includes(name);
}

function monthlyFilename(monthName, year) {
  return `${monthName}_${year}.json`;
}

function monthlyNotesFilename(monthName, year) {
  return `${monthName}_notes_${year}.json`;
}

module.exports = { MONTH_SHEET_NAMES, isMonthSheetName, monthlyFilename, monthlyNotesFilename };
