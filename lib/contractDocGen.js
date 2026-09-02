// ---- Server-side port of Code.gs's generateContractDocument (and the Bike
// Tax / Parts-and-Oil-change lookups it depends on), now that Code.gs / the
// Google Sheets backend has been fully decommissioned (2026-08-20 -- per
// Anton, live). Until now this was DELIBERATELY left un-ported (see
// lib/contractWrites.js's own header comment and PROGRESS.md's contract.html
// write-layer inventory entry) because Code.gs was still the thing actually
// generating contract documents -- contract.html's "View Contract"/"Update
// Contract" buttons called the old Apps Script Web App (`scriptUrl`) for
// this specifically. With Code.gs gone, that call has no backend left to
// reach at all, which is why contract generation stopped working ("No
// contract document found... Would you like to generate one now?" followed
// by a failed generate). This file plus the new 'generate' route in
// api/contracts/[...path].js is the replacement.
//
// Reuses the SAME "AA Scooters Contracts" Drive folder / customer-subfolder
// resolution already wired up in lib/googleDrive.js
// (ensureContractsRootFolder / ensureContractCustomerFolder) -- fixed
// 2026-08-17 to point at the real, long-lived TOP-LEVEL folder Code.gs
// always used, so a contract generated here lands in exactly the same place
// old contracts do, and is found by the existing GET /api/contracts/documents
// route the same way a passport photo already is.
//
// Template: reuses the SAME master template Doc Code.gs always used --
// 'AA Scooter Rental Agreement - MASTER TEMPLATE (do not edit fields)',
// living directly in the contracts root folder, with <<TOKEN>> placeholders
// (see Code.gs's buildContractTemplateDoc for the original design this
// mirrors). Looked up by exact name every call, same as Code.gs's own
// getOrCreateContractTemplateDoc. Deliberately does NOT attempt to rebuild
// the template from scratch if it's ever missing (unlike Code.gs, which had
// a DocumentApp-based from-scratch builder as a fallback) -- reconstructing
// the exact legal terms/table layout blind, with no way to visually verify
// without a live test, is riskier than failing loudly with a clear error. If
// this ever actually fires, the fix is to restore/rename the existing
// template Doc back to this exact name inside "AA Scooters Contracts", not
// to silently generate a different-looking document.
//
// Token replacement uses the Docs API's batchUpdate/replaceAllText, NOT
// Apps Script's DocumentApp.replaceText -- these behave differently:
// DocumentApp.replaceText(pattern, replacement) treats BOTH sides as
// regex (which is why Code.gs's escapeDocReplacement had to backslash-escape
// "\\" and "$" in the replacement value). The Docs API's replaceAllText does
// a LITERAL substring match/replace on both sides -- no regex, no escaping
// needed. Porting escapeDocReplacement here would be a bug, not a faithful
// port, so it's deliberately left out.
//
// Scope note: this calls docs.googleapis.com (Docs API), a different API
// surface from drive.googleapis.com even though both ride on the same
// OAuth2 client. The 'drive.file' scope this app already has covers Docs
// API access to files the app itself created (the template copy, made via
// drive.files.copy under this same session) -- per Google's own Docs API
// scope documentation. This is the one piece of this port that couldn't be
// verified without a live call; if it ever surfaces as a 403/insufficient
// permission error from the Docs API specifically, the fix is adding the
// 'https://www.googleapis.com/auth/documents' scope to DRIVE_SCOPES in
// lib/googleDrive.js, enabling it on the OAuth consent screen in Google
// Cloud Console, and having Anton log out/in to re-consent (same steps as
// the 2026-08-15 drive.readonly rollout -- see that scope's own comment).
const { Readable } = require('stream');
const {
  ensureContractsRootFolder, ensureContractCustomerFolder, ensureAppFolder,
  readJsonFile, writeJsonFile, ConflictError, listAllFilesInFolder, trashFile, docsClientFromSession,
  ensureFilePubliclyViewable
} = require('./googleDrive');

const CONTRACT_TEMPLATE_NAME = 'AA Scooter Rental Agreement - MASTER TEMPLATE (do not edit fields)';
const BIKE_TAX_FILENAME = 'Bike_Tax.json';
const PARTS_OIL_FILENAME = 'Parts_and_Oil_change.json';
// ---- Receipt/checklist generation (added 2026-08-20) -- see the big
// comment block right before generateReceiptDocumentFromJson below for the
// full story of why these exist and what they're faithfully porting. ----
const RECEIPT_TEMPLATE_NAME = 'AA Scooter Rental Payment Receipt - MASTER TEMPLATE (do not edit fields)';
const CHECKLIST_TEMPLATE_NAME = 'AA Scooter Rental Checklist - MASTER TEMPLATE (do not edit fields)';
const RECEIPT_COUNTER_FILENAME = 'receipt_counter.json';

// ==================== bike-name matching (ported from Code.gs) ====================
// Byte-for-byte port of Code.gs's normalizeBikeNameForTaxLookup /
// normalizeBikeNameCore / bikeNamesMatchForTaxLookup -- see that file's own
// comments for the full "why two stages" rationale. Needed here for the
// same reason Code.gs needed it: the bike name typed/selected on the
// contract form doesn't always match the Bike Tax tab's "Bike" column or
// the Parts and Oil change tab's first column byte-for-byte (extra spaces,
// CC tags, make words).
function normalizeBikeNameForTaxLookup(s) {
  return (s || '').toString()
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeBikeNameCore(s) {
  let t = (s || '').toString().toLowerCase();
  t = t.replace(/\(\s*\d{2,4}\s*cc?\s*\)/gi, ' ');
  t = t.replace(/\b\d{2,4}\s?cc\b/gi, ' ');
  t = t.replace(/[()]/g, ' ');
  t = t.replace(/\b(yamaha|honda|gpx)\b/gi, ' ');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return t;
}

function bikeNamesMatchForTaxLookup(a, b) {
  const na = normalizeBikeNameForTaxLookup(a);
  const nb = normalizeBikeNameForTaxLookup(b);
  if (na && nb) {
    if (na === nb) return true;
    const paddedA = ' ' + na + ' ';
    const paddedB = ' ' + nb + ' ';
    if (paddedA.indexOf(paddedB) !== -1 || paddedB.indexOf(paddedA) !== -1) return true;
  }
  const ca = normalizeBikeNameCore(a);
  const cb = normalizeBikeNameCore(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const paddedCa = ' ' + ca + ' ';
  const paddedCb = ' ' + cb + ' ';
  return paddedCa.indexOf(paddedCb) !== -1 || paddedCb.indexOf(paddedCa) !== -1;
}

// Ported from Code.gs's buildBikeDisplayName -- "Make Model" (e.g. "Yamaha
// GT3") for the document, without doubling the make if the model column
// already includes it.
function buildBikeDisplayName(make, model, fallback) {
  make = (make || '').toString().trim();
  model = (model || '').toString().trim();
  if (!make && !model) return fallback || '';
  if (!make) return model;
  if (!model) return make;
  const makeLower = make.toLowerCase();
  const modelLower = model.toLowerCase();
  if (modelLower === makeLower || modelLower.indexOf(makeLower + ' ') === 0) return model;
  return make + ' ' + model;
}

function stripBikeNameBrackets(s) {
  return (s || '').toString().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// dd/MM/yyyy from an ISO ('yyyy-mm-dd...') string -- built from the string's
// own Y/M/D components directly (NOT via `new Date(iso)` + local-timezone
// formatting), so this can't be thrown off by a day near midnight the way
// going through a JS Date object in the server's own timezone could.
function formatIsoDateToDMY(isoStr) {
  if (!isoStr) return '';
  const s = String(isoStr).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// Today's date, dd/MM/yyyy, in the business's own timezone (Asia/Bangkok) --
// used for the <<DATE>> signature-block token (Code.gs used
// Utilities.formatDate(new Date(), spreadsheet's own timezone, ...), which
// was always Asia/Bangkok in practice) and as a folder-naming fallback when
// a contract has no rentingDateFrom at all.
function todayDMYBangkok() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

// ==================== Bike Tax / Parts-and-Oil-change lookups ====================
// Reads the SAME Drive-JSON exports every other page already reads via
// GET /api/data/<sheet> (see api/data/[sheet].js) -- Bike_Tax.json and
// Parts_and_Oil_change.json -- instead of SpreadsheetApp. Column positions
// are resolved BY HEADER NAME every call (not hardcoded indices), same
// robustness Code.gs's own getBikeTaxCategories/getNextOilChangeForBike had,
// so this keeps working even if columns get reordered.
function findHeaderCol(headerRow, name, searchFrom) {
  const lower = (headerRow || []).map((h) => (h || '').toString().trim().toLowerCase());
  return lower.indexOf(name, searchFrom || 0);
}
function findHeaderColContains(headerRow, needle) {
  const lower = (headerRow || []).map((h) => (h || '').toString().trim().toLowerCase());
  return lower.findIndex((h) => h.indexOf(needle) !== -1);
}

async function getBikeTaxCategories(drive, folderId, session) {
  const { data } = await readJsonFile(drive, folderId, BIKE_TAX_FILENAME, session);
  const rows = data || [];
  if (!rows.length) return [];
  const header = rows[0];
  let bikeCol = findHeaderCol(header, 'bike model');
  if (bikeCol === -1) bikeCol = findHeaderCol(header, 'bike');
  const catCol = findHeaderCol(header, 'category');
  if (bikeCol === -1 || catCol === -1) return [];
  const makeCol = findHeaderCol(header, 'make');
  const searchFrom = makeCol > -1 ? makeCol : 0;
  const modelCol = findHeaderCol(header, 'model', searchFrom);
  const ccCol = findHeaderCol(header, 'cc', searchFrom);
  const keyCol = findHeaderCol(header, 'key', searchFrom);
  const plateCol = findHeaderColContains(header, 'plate');

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const bike = (r[bikeCol] || '').toString().trim();
    if (!bike) continue;
    out.push({
      bike,
      make: makeCol > -1 ? (r[makeCol] || '').toString().trim() : '',
      model: modelCol > -1 ? (r[modelCol] || '').toString().trim() : '',
      cc: ccCol > -1 ? (r[ccCol] || '').toString().trim() : '',
      key: keyCol > -1 ? (r[keyCol] || '').toString().trim() : '',
      plate: plateCol > -1 ? (r[plateCol] || '').toString().trim() : ''
    });
  }
  return out;
}

// Ported from Code.gs's getKeyTypeForBike -- only bikes explicitly marked
// "keyless" in the Bike Tax tab's "key" column come back as 'Keyless';
// every other bike found in the tab is 'Standard Key'. '' only when the
// bike itself isn't found at all.
function getKeyTypeForBike(bikeTaxRows, bikeName) {
  const name = (bikeName || '').toString().trim();
  if (!name) return '';
  const match = bikeTaxRows.find((r) => bikeNamesMatchForTaxLookup(r.bike, name));
  if (!match) return '';
  const raw = (match.key || '').toString().trim().toLowerCase();
  return raw === 'keyless' ? 'Keyless' : 'Standard Key';
}

// Ported from Code.gs's getNextOilChangeForBike -- reads
// Parts_and_Oil_change.json's first column (bike name) and its
// header-matched "next oil change" column.
async function getNextOilChangeForBike(drive, folderId, session, bikeName) {
  const name = (bikeName || '').toString().trim();
  if (!name) return '';
  const { data } = await readJsonFile(drive, folderId, PARTS_OIL_FILENAME, session);
  const rows = data || [];
  if (!rows.length) return '';
  const header = rows[0];
  const nextOilCol = findHeaderCol(header, 'next oil change');
  if (nextOilCol === -1) return '';
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const bike = (r[0] || '').toString().trim();
    if (bikeNamesMatchForTaxLookup(bike, name)) {
      const v = r[nextOilCol];
      return v === null || v === undefined ? '' : String(v).trim();
    }
  }
  return '';
}

// ==================== Template lookup ====================
async function findContractTemplateId(drive, contractsRootId) {
  const escaped = CONTRACT_TEMPLATE_NAME.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and '${contractsRootId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    spaces: 'drive'
  });
  const found = (res.data.files || [])[0];
  if (!found) {
    throw new Error(
      'Could not find the contract template Doc ("' + CONTRACT_TEMPLATE_NAME + '") inside the ' +
      '"AA Scooters Contracts" Drive folder. This app no longer builds one automatically the way ' +
      'Code.gs used to -- check that folder in Drive for that exact file name (it may have been ' +
      'renamed or moved) and try again.'
    );
  }
  if (found.mimeType !== 'application/vnd.google-apps.document') {
    throw new Error(
      'The contract template file was found but is not a native Google Doc (mimeType ' +
      found.mimeType + '). Open it in Drive, use File > Save as Google Docs, then try again.'
    );
  }
  return found.id;
}

// ==================== Main entry point ====================
// `data` is the SAME shape contract.html's buildRegenerateContractPayload
// already builds (name, nationality, passport, number, bikeModel,
// rentingDateFrom, returnDate, returnTime, deliverToHotel, totalPrice,
// deposit, depositAmount, depositCurrency, deliveryFeeApplies, deliveryFee,
// helmet fields) -- this function's job is the SAME as Code.gs's
// generateContractDocument(data, depositMethod, depositAmount, deliveryFee),
// just reshaped to take one object (api/contracts/[...path].js's 'generate'
// route pulls depositMethod/depositAmount/deliveryFee out of `data` itself,
// same fields contract.html already sends).
// ---- Multi-bike support (added 2026-09-02): a contract with more than
// one linked bike joins each of the 5 per-bike Scooter Details fields
// (Bike / Plate / CC / Key type / Next oil change) with " + " instead of
// adding a table row or restructuring the template -- Anton's call,
// after seeing the real template: the existing single-value token slots
// just get a longer value, wrapping to a second line on their own if
// needed. Total Rental Fee / Total Amount Paid are NEVER built from this
// -- those stay exactly the single combined number the caller already
// passes in data.totalPrice / data.totalPaid, deliberately not split
// per bike.
//
// bikeModelList is an array of bike model name strings, one per linked
// Contract row, in the same order those rows were created. A normal
// single-bike contract passes (or falls back to) a 1-element array, so
// every field below resolves to exactly what it always did -- this is
// purely additive, nothing about the single-bike path changes shape.
async function resolveMultiBikeFields(drive, effectiveFolderId, session, bikeTaxRows, bikeModelList) {
  const models = (bikeModelList || [])
    .map((m) => stripBikeNameBrackets(m))
    .filter(Boolean);
  const rows = [];
  for (const model of models) {
    const bikeRow = bikeTaxRows.find((r) => bikeNamesMatchForTaxLookup(r.bike, model));
    const nextOil = await getNextOilChangeForBike(drive, effectiveFolderId, session, model);
    rows.push({
      displayName: buildBikeDisplayName(bikeRow && bikeRow.make, bikeRow && bikeRow.model, model),
      plate: bikeRow ? bikeRow.plate : '',
      cc: bikeRow ? bikeRow.cc : '',
      keyType: getKeyTypeForBike(bikeTaxRows, model),
      nextOil
    });
  }
  const join = (key) => rows.map((r) => r[key]).filter((v) => v !== '' && v !== undefined && v !== null).join(' + ');
  return {
    bikeDisplayName: join('displayName'),
    plate: join('plate'),
    cc: join('cc'),
    keyType: join('keyType'),
    nextOil: join('nextOil')
  };
}

async function generateContractDocumentFromJson(ctx, data) {
  const { drive, folderId, session } = ctx;
  const effectiveFolderId = folderId || await ensureAppFolder(drive);

  const depositMethod = (data.deposit || '').toString().trim();
  const depositNeedsAmount = depositMethod !== '' && depositMethod.toLowerCase() !== 'passport';
  const depositAmount = depositNeedsAmount ? (data.depositAmount || '') : '';
  const deliveryFee = data.deliveryFeeApplies ? (data.deliveryFee || '') : '';

  const bikeTaxRows = await getBikeTaxCategories(drive, effectiveFolderId, session);
  // data.bikes (array of bike model names, one per linked Contract row)
  // is how a multi-bike contract passes every rented bike through -- a
  // normal single-bike contract has no `bikes` array at all and falls
  // back to the same [data.bikeModel] single-item list this always used.
  const bikeModelList = (data.bikes && data.bikes.length) ? data.bikes : [data.bikeModel];
  const { bikeDisplayName, plate, cc, keyType, nextOil } = await resolveMultiBikeFields(
    drive, effectiveFolderId, session, bikeTaxRows, bikeModelList
  );

  const time = data.returnTime || '';
  const depositCurrency = (data.depositCurrency || '').toString().trim() || 'THB';
  const isPassportDeposit = depositMethod.toLowerCase() === 'passport';
  const depositAmountDisplay = isPassportDeposit
    ? 'Passport'
    : (depositAmount !== '' && depositAmount !== undefined && depositAmount !== null
        ? Number(depositAmount).toLocaleString('en-US') + ' ' + depositCurrency
        : '');
  const totalFeeDisplay = (data.totalPrice !== undefined && data.totalPrice !== null && data.totalPrice !== '')
    ? Number(data.totalPrice).toLocaleString('en-US') + ' THB' : '';
  const deliveryFeeDisplay = (deliveryFee !== undefined && deliveryFee !== null && deliveryFee !== '')
    ? Number(deliveryFee).toLocaleString('en-US') + ' THB' : 'No';

  const helmetHalfSizeQty = Math.min(4, Number(data.helmetHalfSizeQty) || 0);
  const helmetKidsQty = Math.min(2, Number(data.helmetKidsQty) || 0);
  const helmetFullFaceQty = Math.min(2, Number(data.helmetFullFaceQty) || 0);
  const helmetFullSizeS = Number(data.helmetFullSizeS) || 0;
  const helmetFullSizeM = Number(data.helmetFullSizeM) || 0;
  const helmetFullSizeL = Number(data.helmetFullSizeL) || 0;
  const helmetFullSizeXL = Number(data.helmetFullSizeXL) || 0;
  const helmetFullSizeQty = Math.min(4, helmetFullSizeS + helmetFullSizeM + helmetFullSizeL + helmetFullSizeXL);
  const helmetNoneChecked = !!data.helmetNone;
  const helmetTick = (qty, boxNum) => (qty === boxNum ? '☑' : '☐');

  const tokens = {
    '<<FULL_NAME>>': data.name || '',
    '<<PASSPORT_ID>>': data.passport || '',
    '<<NATIONALITY>>': data.nationality || '',
    '<<PHONE>>': data.number || '',
    '<<DELIVERY>>': data.deliverToHotel || '',
    '<<BIKE>>': bikeDisplayName,
    '<<PLATE>>': plate,
    '<<CC>>': cc,
    '<<KEY_TYPE>>': keyType,
    '<<NEXT_OIL>>': nextOil,
    '<<START_DATE>>': formatIsoDateToDMY(data.rentingDateFrom),
    '<<START_TIME>>': time,
    '<<RETURN_DATE>>': formatIsoDateToDMY(data.returnDate),
    '<<RETURN_TIME>>': time,
    '<<DELIVERY_FEE>>': deliveryFeeDisplay,
    '<<TOTAL_FEE>>': totalFeeDisplay,
    '<<DEPOSIT_METHOD>>': isPassportDeposit ? 'Passport' : depositMethod,
    '<<DEPOSIT_AMOUNT>>': depositAmountDisplay,
    '<<DATE>>': todayDMYBangkok(),
    '<<HS1>>': helmetTick(helmetHalfSizeQty, 1),
    '<<HS2>>': helmetTick(helmetHalfSizeQty, 2),
    '<<HS3>>': helmetTick(helmetHalfSizeQty, 3),
    '<<HS4>>': helmetTick(helmetHalfSizeQty, 4),
    '<<FS1>>': helmetTick(helmetFullSizeQty, 1),
    '<<FS2>>': helmetTick(helmetFullSizeQty, 2),
    '<<FS3>>': helmetTick(helmetFullSizeQty, 3),
    '<<FS4>>': helmetTick(helmetFullSizeQty, 4),
    '<<KID1>>': helmetTick(helmetKidsQty, 1),
    '<<KID2>>': helmetTick(helmetKidsQty, 2),
    '<<FF1>>': helmetTick(helmetFullFaceQty, 1),
    '<<FF2>>': helmetTick(helmetFullFaceQty, 2),
    '<<SZ_S>>': helmetFullSizeS ? String(helmetFullSizeS) : '',
    '<<SZ_M>>': helmetFullSizeM ? String(helmetFullSizeM) : '',
    '<<SZ_L>>': helmetFullSizeL ? String(helmetFullSizeL) : '',
    '<<SZ_XL>>': helmetFullSizeXL ? String(helmetFullSizeXL) : '',
    '<<HELMET_NONE>>': helmetNoneChecked ? '☑' : '☐'
  };

  const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
  const templateId = await findContractTemplateId(drive, contractsRootId);

  const contractDateStr = data.rentingDateFrom
    ? formatIsoDateToDMY(data.rentingDateFrom).replace(/\//g, '-')
    : todayDMYBangkok().replace(/\//g, '-');
  const customerFolderId = await ensureContractCustomerFolder(
    drive, contractsRootId, data.name, data.number, contractDateStr
  );

  const fileName = 'Contract - ' + (data.name || 'Unnamed') + ' - ' + contractDateStr;

  // Exactly one contract PDF per customer per name+date combo -- trash
  // whatever already exists under this exact filename first, same as
  // Code.gs's generateContractDocument. Scoped to this filename only, so a
  // repeat customer's contract from a different rental date sharing this
  // same folder is never touched.
  const existingFiles = await listAllFilesInFolder(drive, customerFolderId);
  for (const f of existingFiles) {
    if (f.name === fileName || f.name === fileName + '.pdf') {
      try { await trashFile(drive, f.id); } catch (e) { /* stale/already-gone -- never block generation */ }
    }
  }

  const copyRes = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: fileName, parents: [customerFolderId] },
    fields: 'id'
  });
  const copyId = copyRes.data.id;

  try {
    const docs = docsClientFromSession(session);
    const requests = Object.keys(tokens).map((token) => ({
      replaceAllText: {
        containsText: { text: token, matchCase: true },
        replaceText: tokens[token]
      }
    }));
    await docs.documents.batchUpdate({ documentId: copyId, requestBody: { requests } });

    const exportRes = await drive.files.export(
      { fileId: copyId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(exportRes.data);

    const pdfCreated = await drive.files.create({
      requestBody: { name: fileName + '.pdf', parents: [customerFolderId] },
      media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
      fields: 'id, name, mimeType'
    });

    // The filled Doc was only ever an intermediate step to produce the PDF
    // -- contracts are PDF-only in the Drive folder, same as Code.gs.
    try { await trashFile(drive, copyId); } catch (e) { /* best-effort cleanup, never block a successful generate */ }

    // Added 2026-08-20 (Anton, live): viewing a contract from a Chrome
    // profile signed into a different Google account than the file owner
    // showed Drive's "you need permission" screen -- contract.html now
    // opens a real drive.google.com/file/d/<id>/view link instead of this
    // app's own private proxy (see contract.html's driveViewUrl()), so the
    // file itself needs "anyone with the link, view only" sharing for that
    // to work regardless of who's logged into the viewer's browser.
    // Best-effort -- a failure here shouldn't fail contract generation
    // itself, and viewContract() also calls the 'makeContractPublic' route
    // as a backstop for contracts generated before this existed.
    try { await ensureFilePubliclyViewable(drive, pdfCreated.data.id); } catch (e) { /* best-effort */ }

    return { success: true, pdfFileId: pdfCreated.data.id };
  } catch (err) {
    // Clean up the half-made Doc copy so a failed generate doesn't leave
    // clutter behind in the customer's folder every time someone retries.
    try { await trashFile(drive, copyId); } catch (e) { /* best-effort */ }
    throw err;
  }
}

// ==================== Receipt / Checklist generation (added 2026-08-20) ====================
// Ports Code.gs's generateReceiptDocument/generateChecklistDocument (and
// their own addContractEntry callers, which generated BOTH automatically
// right after every new contract row -- see api/contracts/[...path].js's
// 'generateReceipt'/'generateChecklist' routes and contract.html's
// add-contract submit handler, which now call these the same way).
// Deliberately left out of the original 2026-08-20 contractDocGen.js port
// (the PDF-only "View/Update Contract" fix) because it's a bigger, separate
// piece of work -- these were STILL calling the decommissioned Code.gs
// (`scriptUrl`, actions 'generateReceipt'/'findChecklistDocument'/
// 'generateChecklist') until now, which is why a receipt/checklist could
// never be found again after being generated (nothing was ever persisted
// anywhere retrievable) and why a brand-new contract never got either
// document automatically the way it used to.
//
// Template lookup: SAME "look up by exact name inside the AA Scooters
// Contracts folder" rule findContractTemplateId uses above -- but unlike
// the contract template (which is a real, already-correctly-named/placed
// Doc), NEITHER 'AA Scooter Rental Payment Receipt - MASTER TEMPLATE (do
// not edit fields)' nor 'AA Scooter Rental Checklist - MASTER TEMPLATE (do
// not edit fields)' actually exists at that name/location today (checked
// live against Drive while building this). Nicer, manually-designed
// versions of both DO exist elsewhere in Drive (uploaded by Anton at some
// point) but were never actually wired up -- Code.gs's own lookup only
// ever searched the Contracts folder by that exact name too, so it always
// fell through to ITS OWN bare-bones DocumentApp-built fallback as well
// (same <<TOKEN>> layout ported below, just built via the Docs API
// instead of DocumentApp). Ported that fallback behavior faithfully here
// -- same tokens, same trigger condition (build-once, by name, the first
// time this ever runs) -- rather than guessing at inserting tokens into
// Anton's own uploaded design without asking him first. Flagged to Anton
// separately; if he wants the nicer designs used instead, the fix is
// either renaming/moving his Doc to the exact name above (then this find
// finds it straight away, zero code changes) or asking for the tokens to
// be added to a copy of it.
async function findTemplateIdByName(drive, contractsRootId, templateName) {
  const escaped = templateName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and '${contractsRootId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
    spaces: 'drive'
  });
  const found = (res.data.files || [])[0];
  if (!found) return null;
  if (found.mimeType !== 'application/vnd.google-apps.document') {
    throw new Error(
      'The "' + templateName + '" file was found but is not a native Google Doc (mimeType ' +
      found.mimeType + '). Open it in Drive, use File > Save as Google Docs, then try again.'
    );
  }
  return found.id;
}

// Builds a brand-new template Doc containing nothing but plain-text
// paragraphs (no tables) with <<TOKEN>> placeholders, moves it into the
// Contracts folder under `name`, and returns its id. A single insertText
// call is deliberately simpler/safer than reconstructing Code.gs's
// DocumentApp table layout via raw Docs API structural requests (table
// cell index math is easy to get subtly wrong) -- this is a functional
// fallback, not a pixel-perfect one, same spirit as Code.gs's own
// "bare-bones... only ever used until a real uploaded design takes its
// place" fallback.
async function buildPlainTemplateDoc(docs, drive, contractsRootId, name, bodyText) {
  const createRes = await docs.documents.create({ requestBody: { title: name } });
  const documentId = createRes.data.documentId;
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: bodyText } }] }
  });
  // docs.documents.create always lands the new Doc directly in "My Drive"
  // root -- move it into the Contracts folder so it's found by name next
  // to the contract template, same place Code.gs always kept these.
  const fileMeta = await drive.files.get({ fileId: documentId, fields: 'parents' });
  const prevParents = (fileMeta.data.parents || []).join(',');
  await drive.files.update({
    fileId: documentId,
    addParents: contractsRootId,
    removeParents: prevParents,
    fields: 'id, parents'
  });
  return documentId;
}

function receiptFallbackTemplateBody() {
  return [
    'AA SCOOTER RENTAL',
    'Payment Receipt',
    '150/33 Chanyayon Village, Suthep, Chiang Mai 50200, Thailand | +66 86 654 3609',
    '',
    'Receipt No.: <<RECEIPT_NO>>          Date: <<RECEIPT_DATE>>',
    '',
    'RECEIVED FROM',
    'Name: <<FULL_NAME>>',
    '',
    'SCOOTER DETAILS',
    'Scooter Type: <<BIKE>>',
    'Engine Size (CC): <<CC>>          Rental Period: <<RENTAL_PERIOD>>',
    '',
    'PAYMENT DETAILS',
    'Rental Fee: <<RENTAL_FEE>> THB',
    'Delivery Fee (if applicable): <<DELIVERY_FEE>> THB',
    'Other (<<OTHER_LABEL>>): <<OTHER_AMOUNT>> THB',
    'Total Amount Paid: <<TOTAL_PAID>> THB',
    '',
    'Payment Method: <<CASH_BOX>> Cash   <<SCAN_BOX>> Thai QR Scan   <<WISE_BOX>> Wise   <<REVOLUT_BOX>> Revolut   <<OTHER_BOX>> Other: <<OTHER_METHOD_TEXT>>',
    '',
    'RECEIVED BY',
    'Company: AA Scooter Rental',
    'Received by: <<RECEIVED_BY>>',
    'Signature: ',
    '',
    'Thank you for choosing AA Scooter Rental!',
    'We appreciate your support and wish you a safe and enjoyable ride.'
  ].join('\n');
}

function checklistFallbackTemplateBody() {
  return [
    'AA SCOOTER RENTAL',
    'Rental Checklist',
    '150/33 Chanyayon Village, Suthep, Chiang Mai 50200, Thailand | +66 86 654 3609',
    '',
    'RENTER ACKNOWLEDGEMENT',
    'Name: <<FULL_NAME>>          Date: <<DATE>>',
    'Signature: '
  ].join('\n');
}

async function getOrBuildReceiptTemplateId(drive, docs, contractsRootId) {
  const existing = await findTemplateIdByName(drive, contractsRootId, RECEIPT_TEMPLATE_NAME);
  if (existing) return existing;
  return buildPlainTemplateDoc(docs, drive, contractsRootId, RECEIPT_TEMPLATE_NAME, receiptFallbackTemplateBody());
}
async function getOrBuildChecklistTemplateId(drive, docs, contractsRootId) {
  const existing = await findTemplateIdByName(drive, contractsRootId, CHECKLIST_TEMPLATE_NAME);
  if (existing) return existing;
  return buildPlainTemplateDoc(docs, drive, contractsRootId, CHECKLIST_TEMPLATE_NAME, checklistFallbackTemplateBody());
}

// ---- Hands out the next receipt number in sequence (e.g. "AA-100001"),
// persisted in a small JSON counter file in the app's own Drive folder
// (same folder every other sidecar -- contract_docs.json, etc. -- already
// lives in), NOT Script Properties (Code.gs's version -- gone along with
// it). Uses the same optimistic-concurrency retry-on-ConflictError pattern
// every other shared-counter-shaped write in this project uses (e.g.
// logTransactionB) since two receipts could in theory be generated at
// close to the same moment.
//
// Starts at 100000 (first assigned number: AA-100001) rather than 0 --
// Code.gs's own counter (LAST_RECEIPT_NUMBER) was lost when Code.gs was
// decommissioned and can't be recovered from here, so this starts high
// enough that it can never collide with a number already handed to a real
// customer under the old system (safe unless AA Scooters has issued
// 100,000+ receipts, which it hasn't). If Anton wants exact continuity
// with his own paper/email records instead, this file's stored number can
// be corrected by hand. ----
async function getNextReceiptNumberFromJson(drive, appFolderId, session) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let rows, modifiedTime;
    try {
      const res = await readJsonFile(drive, appFolderId, RECEIPT_COUNTER_FILENAME, session);
      rows = res.data;
      modifiedTime = res.modifiedTime;
    } catch (e) {
      rows = null;
      modifiedTime = null;
    }
    const last = (rows && Array.isArray(rows) && rows[0] && Number(rows[0][0])) || 99999;
    const wholeLast = isNaN(last) ? 99999 : last;
    const next = wholeLast + 1;
    try {
      await writeJsonFile(drive, appFolderId, RECEIPT_COUNTER_FILENAME, [[next]], modifiedTime || null, false, session);
      let digits = String(next);
      while (digits.length < 6) digits = '0' + digits;
      return 'AA-' + digits;
    } catch (writeErr) {
      if (writeErr instanceof ConflictError || writeErr.isConflict) continue; // raced with another generate -- retry
      throw writeErr;
    }
  }
  throw new Error('Could not assign a receipt number after several attempts (repeated write conflicts) -- try again.');
}

// ==================== Shared: fill a template copy + export as a
// standalone PDF ====================
// Used by generateReceiptDocumentFromJson and generateChecklistDocumentFromJson
// below -- copy the template, run replaceAllText (Docs API) to fill in
// `tokens`, export the result as a PDF into `customerFolderId`, trash the
// intermediate Doc copy, and return the new PDF's file id. Trashes
// anything already sitting under `fileName`/`fileName + '.pdf'` first, so
// regenerating always ends up with exactly one PDF, never a second one
// alongside the first -- same behavior Code.gs's own
// generateReceiptDocument/generateChecklistDocument had. Deliberately NOT
// reused by generateContractDocumentFromJson above -- that function
// predates this one and is already live/proven; duplicating this handful
// of lines here is a smaller risk than touching working code.
async function fillTemplateAndExportPdf(docs, drive, templateId, tokens, fileName, customerFolderId) {
  const existingFiles = await listAllFilesInFolder(drive, customerFolderId);
  for (const f of existingFiles) {
    if (f.name === fileName || f.name === fileName + '.pdf') {
      try { await trashFile(drive, f.id); } catch (e) { /* stale/already-gone -- never block generation */ }
    }
  }

  const copyRes = await drive.files.copy({
    fileId: templateId,
    requestBody: { name: fileName, parents: [customerFolderId] },
    fields: 'id'
  });
  const copyId = copyRes.data.id;

  try {
    const requests = Object.keys(tokens).map((token) => ({
      replaceAllText: {
        containsText: { text: token, matchCase: true },
        replaceText: tokens[token]
      }
    }));
    await docs.documents.batchUpdate({ documentId: copyId, requestBody: { requests } });

    const exportRes = await drive.files.export(
      { fileId: copyId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    const pdfBuffer = Buffer.from(exportRes.data);

    const pdfCreated = await drive.files.create({
      requestBody: { name: fileName + '.pdf', parents: [customerFolderId] },
      media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
      fields: 'id, name, mimeType'
    });

    try { await trashFile(drive, copyId); } catch (e) { /* best-effort cleanup */ }

    return pdfCreated.data.id;
  } catch (err) {
    try { await trashFile(drive, copyId); } catch (e) { /* best-effort */ }
    throw err;
  }
}

// `data`: { rowNumber (unused now -- see note below), name, number,
// rentingDateFrom (yyyy-MM-dd, folder-naming fallback only), receiptNo
// (blank to auto-assign), receiptDate (yyyy-MM-dd), bikeModel, cc
// (optional override), rentalPeriodFrom/rentalPeriodTo (yyyy-MM-dd),
// rentalFee, deliveryFee, otherLabel, otherAmount, totalPaid,
// paymentMethod ('cash'|'scan'|'wise'|'revolut'|'other'), otherMethodText,
// receivedBy }. Returns { success: true, pdfFileId, receiptNo }.
//
// Folder resolution is simpler than Code.gs's own getContractRowFolder
// (which read back whichever of 5 possible link columns the Contract row
// already had populated): in this app contractDocUrl/contractPdfUrl/
// receiptPdfUrl/checklistPdfUrl are never written back onto the Contract
// row at all (deliberate -- see lib/contractWrites.js's header comment),
// so that read would always come back empty here anyway. Goes straight to
// the same name+phone folder resolution (ensureContractCustomerFolder)
// generateContractDocumentFromJson above already uses -- guarantees the
// receipt lands in the exact same folder the contract PDF does. ----
async function generateReceiptDocumentFromJson(ctx, data) {
  const { drive, folderId, session } = ctx;
  const effectiveFolderId = folderId || await ensureAppFolder(drive);

  const name = (data.name || '').toString().trim();
  if (!name) throw new Error('No customer name given.');

  const receiptNo = (data.receiptNo || '').toString().trim() ||
    await getNextReceiptNumberFromJson(drive, effectiveFolderId, session);

  const bikeTaxRows = await getBikeTaxCategories(drive, effectiveFolderId, session);
  // Same data.bikes convention as the contract doc above -- a multi-bike
  // receipt joins every linked bike's Scooter Type / CC with " + " too
  // (Anton, 02/09/2026: "the receipt needs to be listed too").
  const bikeModelList = (data.bikes && data.bikes.length) ? data.bikes : [data.bikeModel];
  const multiBike = await resolveMultiBikeFields(drive, effectiveFolderId, session, bikeTaxRows, bikeModelList);
  const bikeDisplayName = multiBike.bikeDisplayName;
  // An explicit data.cc override still wins for a single-bike receipt
  // (unchanged behavior) -- it can't stand in for several bikes' CC
  // figures at once, so a multi-bike receipt always uses the joined
  // lookup instead.
  const ccOverride = (data.cc || '').toString().trim();
  const cc = (bikeModelList.length <= 1 && ccOverride) ? ccOverride : multiBike.cc;

  const periodFrom = formatIsoDateToDMY(data.rentalPeriodFrom);
  const periodTo = formatIsoDateToDMY(data.rentalPeriodTo);
  const rentalPeriod = (periodFrom && periodTo) ? (periodFrom + ' - ' + periodTo) : (periodFrom || periodTo || '');

  function moneyDisplay(v) {
    return (v !== '' && v !== undefined && v !== null && !isNaN(Number(v)))
      ? Number(v).toLocaleString('en-US')
      : '';
  }
  const method = (data.paymentMethod || '').toString().trim().toLowerCase();
  const box = (key) => (method === key ? '☑' : '☐');

  const tokens = {
    '<<RECEIPT_NO>>': receiptNo,
    '<<RECEIPT_DATE>>': formatIsoDateToDMY(data.receiptDate) || todayDMYBangkok(),
    '<<FULL_NAME>>': name,
    '<<BIKE>>': bikeDisplayName,
    '<<CC>>': cc,
    '<<RENTAL_PERIOD>>': rentalPeriod,
    '<<RENTAL_FEE>>': moneyDisplay(data.rentalFee),
    '<<DELIVERY_FEE>>': moneyDisplay(data.deliveryFee),
    '<<OTHER_LABEL>>': data.otherLabel || '',
    '<<OTHER_AMOUNT>>': moneyDisplay(data.otherAmount),
    '<<TOTAL_PAID>>': moneyDisplay(data.totalPaid),
    '<<CASH_BOX>>': box('cash'),
    '<<SCAN_BOX>>': box('scan'),
    '<<WISE_BOX>>': box('wise'),
    '<<REVOLUT_BOX>>': box('revolut'),
    '<<OTHER_BOX>>': box('other'),
    '<<OTHER_METHOD_TEXT>>': method === 'other' ? (data.otherMethodText || '') : '',
    '<<RECEIVED_BY>>': data.receivedBy || ''
  };

  const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
  const docs = docsClientFromSession(session);
  const templateId = await getOrBuildReceiptTemplateId(drive, docs, contractsRootId);

  // FILE NAME uses the rental start date, NOT the receipt date -- this is a
  // deliberate deviation from Code.gs's own version (which named the file
  // "Receipt - <name> - <TODAY, the day the receipt happened to be
  // generated>"). That made a receipt's own file name impossible to
  // reconstruct later purely from the contract row's own stored fields
  // (today's date obviously isn't stored anywhere), which is exactly why
  // Code.gs never had a findReceiptDocument action the way it had
  // findContractDocument/findChecklistDocument -- "View Receipt" could
  // only ever work within the same browser session that generated it, and
  // reported "no receipt" every time after a reload even though one
  // genuinely existed on Drive (this is the exact bug Anton reported
  // 2026-08-20). Keying the file name to rentingDateFrom instead -- the
  // SAME immutable field the contract/checklist file names already use --
  // makes the file name deterministic and reconstructable the same way
  // theirs are, while the <<RECEIPT_DATE>> TOKEN inside the document itself
  // still shows the actual date the receipt was (re)generated/edited.
  // Regenerating (e.g. for an extension) still replaces the same file
  // (folder-and-fileName trash-first behavior lives in
  // fillTemplateAndExportPdf below), so this stays exactly one receipt per
  // contract, same invariant Code.gs intended.
  const folderDateStr = data.rentingDateFrom
    ? formatIsoDateToDMY(data.rentingDateFrom).replace(/\//g, '-')
    : todayDMYBangkok().replace(/\//g, '-');
  const customerFolderId = await ensureContractCustomerFolder(
    drive, contractsRootId, name, data.number, folderDateStr
  );

  const fileName = 'Receipt - ' + name + ' - ' + folderDateStr;
  const pdfFileId = await fillTemplateAndExportPdf(docs, drive, templateId, tokens, fileName, customerFolderId);

  // Added 2026-08-27 (Anton, live): receipts need the same "anyone with
  // the link, view only" sharing contracts got on 2026-08-20 -- Anton
  // reported the checklist link works, but viewing a receipt from a
  // Chrome profile signed into a different Google account than the file
  // owner (aascooterchiangmai@gmail.com) still shows Drive's "you need
  // permission" screen. Best-effort, same as the contract's own call --
  // never blocks a successful generate. viewReceipt() in contract.html
  // also calls the 'makeContractPublic' route as a backstop for receipts
  // generated before this existed.
  try { await ensureFilePubliclyViewable(drive, pdfFileId); } catch (e) { /* best-effort */ }

  return { success: true, pdfFileId, receiptNo };
}

// `data`: { rowNumber (unused, see generateReceiptDocumentFromJson's own
// note above), name, number, rentingDateFrom (yyyy-MM-dd) }. Only
// <<FULL_NAME>> and today's date get filled in -- everything else on the
// checklist is filled in by hand at pickup/return, same as Code.gs's own
// version. Returns { success: true, pdfFileId }. ----
async function generateChecklistDocumentFromJson(ctx, data) {
  const { drive, folderId, session } = ctx;
  const effectiveFolderId = folderId || await ensureAppFolder(drive);

  const name = (data.name || '').toString().trim();
  if (!name) throw new Error('No customer name given.');

  const tokens = {
    '<<FULL_NAME>>': name,
    '<<DATE>>': todayDMYBangkok()
  };

  const contractsRootId = await ensureContractsRootFolder(drive, effectiveFolderId);
  const docs = docsClientFromSession(session);
  const templateId = await getOrBuildChecklistTemplateId(drive, docs, contractsRootId);

  const checklistDateStr = data.rentingDateFrom
    ? formatIsoDateToDMY(data.rentingDateFrom).replace(/\//g, '-')
    : todayDMYBangkok().replace(/\//g, '-');
  const customerFolderId = await ensureContractCustomerFolder(
    drive, contractsRootId, name, data.number, checklistDateStr
  );

  const fileName = 'Checklist - ' + name + ' - ' + checklistDateStr;
  const pdfFileId = await fillTemplateAndExportPdf(docs, drive, templateId, tokens, fileName, customerFolderId);

  // Added 2026-08-27 (Anton, live) -- same fix as the receipt's own call
  // just above generateReceiptDocumentFromJson's return: checklists need
  // "anyone with the link, view only" sharing too so viewChecklist() opens
  // cleanly regardless of which Google account the viewer's Chrome is
  // signed into. Best-effort, never blocks a successful generate.
  try { await ensureFilePubliclyViewable(drive, pdfFileId); } catch (e) { /* best-effort */ }

  return { success: true, pdfFileId };
}

module.exports = {
  generateContractDocumentFromJson,
  generateReceiptDocumentFromJson,
  generateChecklistDocumentFromJson,
  bikeNamesMatchForTaxLookup,
  buildBikeDisplayName,
  formatIsoDateToDMY,
  CONTRACT_TEMPLATE_NAME,
  RECEIPT_TEMPLATE_NAME,
  CHECKLIST_TEMPLATE_NAME
};
