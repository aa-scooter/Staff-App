// ---- Calendar sync logic -- port of Code.gs's calendar-sync system (lines
// ~7412-8900 there) onto the Google Calendar v3 REST API (via `googleapis`,
// same package lib/googleDrive.js already uses) instead of Apps Script's
// CalendarApp global. Field logic, color rules, and change-detection are
// all meant to match Code.gs EXACTLY -- see project discussion, 18/08/2026:
// "I want the calendar to function exactly as it does here... other than
// [a separate login], it should do exactly the same shit."
//
// Split into PURE decision functions (compute what the event should look
// like / whether anything changed -- fully unit-testable, no network) and
// thin API-calling wrappers (actually create/update/delete the event) --
// unlike Code.gs, which mixes both in one function, since CalendarApp calls
// are cheap/synchronous there. Kept separate here so the decision logic can
// be tested without mocking the whole googleapis client for every case.
//
// Row shapes match this app's actual Drive-JSON storage exactly (plain
// arrays, 0-indexed, index i <-> Code.gs's column i+1 -- confirmed against
// lib/customersWrites.js and lib/contractWrites.js's own column-index
// comments), NOT Code.gs's spreadsheet Date-object cells: dates/times here
// are ISO strings ("2026-08-19T00:00:00", "14:30:00"), so parsing them is
// the one genuinely different piece versus the original.
'use strict';

const { bikeNamesMatchForPhotos } = require('./googleDrive');

// =====================================================================
// ---- "customer" sheet (customer.json) column indices -- 0-indexed,
// matches Code.gs's 1-indexed C/F/I/J/N/Q/R/S/T/U/V exactly (index = col - 1).
const CUST = {
  NAME: 2, BIKE: 5, RETURN_DATE: 8, RETURN_TIME: 9, SITUATION: 13,
  CAL_EVENT_ID: 16, TIME_CONFIRMED: 17, CONFIRMED_DATE: 18, PICKUP_LINK: 19,
  CONTACT_REMINDER_EVENT_ID: 20, CONTACT_REMINDER_FOR_DATE: 21
};
// ---- "Contract" sheet (Contract.json) column indices -- matches
// lib/contractWrites.js's own CONTRACT_KEYS_B array positions exactly.
const CT = {
  CONTACT: 1, NUMBER: 2, NAME: 3, BIKE: 6, RENTING_DATE_FROM: 7,
  DELIVER_TO_HOTEL: 10, STATUS: 16, DELIVERY_TIME: 21, CAL_EVENT_ID: 22,
  DELIVERY_LINK: 23, CHAT_NAME: 25, MESSENGER_ID: 35
};

// Apps Script CalendarApp.EventColor -> Calendar API v3 colorId, confirmed
// against Google's own reference (developers.google.com/apps-script/
// reference/calendar/event-color): PALE_BLUE="1", YELLOW="5", ORANGE="6"
// (labeled "Tangerine" in the Calendar UI itself -- Code.gs's
// createContactCustomerReminders uses CalendarApp.EventColor.TANGERINE,
// which ISN'T a real Apps Script enum member; that call likely silently
// no-ops there today. Using colorId "6" here on purpose, since "Tangerine"
// in the UI IS colorId 6 -- this is what was clearly intended), GREEN="10".
const COLOR_ID = { PALE_BLUE: '1', YELLOW: '5', ORANGE: '6', GREEN: '10' };

// ---- Fixed IANA timezone for every timed (non-all-day) event this file
// creates -- AA Scooters operates out of Chiang Mai, Thailand. Added
// 18/08/2026: the Calendar API v3 REJECTS a `dateTime` with no offset/Z
// AND no sibling `timeZone` field ("Missing time zone definition for
// start/end time"), unlike Apps Script's CalendarApp (which always
// implicitly used the script's own timezone, so Code.gs never needed
// this). Found live via Vercel logs after Anton reported rented
// contracts silently not producing a 🛵 due-back event -- every timed
// event insert/update here was failing this same way, non-fatally
// swallowed by each function's own try/catch (by design, so a calendar
// hiccup never blocks the booking write it's piggybacking on), so the
// booking always saved fine but no calendar entry ever appeared, with no
// user-visible error either (see contract.html's own warning-alert path,
// which only fires when a failure IS caught -- these all were, just too
// quietly for anyone to notice unless the response was compared to
// Vercel's logs directly). All-day events (start: {date: ...}, no
// dateTime) are unaffected since date-only events use the calendar's
// default timezone and don't require this field.
const CALENDAR_TIMEZONE = 'Asia/Bangkok';

// =====================================================================
// ---- Shared helpers -- verbatim-as-possible ports of Code.gs's
// buildWhatsAppLinkServer_/buildMessengerLinkServer_/firstNameOfServer_/
// shortBikeNameServer_/buildReturnReminderMessage_. ----
function buildWhatsAppLink(rawNumber) {
  const trimmed = (rawNumber || '').toString().trim();
  if (!trimmed) return null;
  let digits;
  if (trimmed.indexOf('+') === 0) {
    digits = trimmed.replace(/[^0-9]/g, '');
  } else {
    const local = trimmed.replace(/[^0-9]/g, '').replace(/^0/, '');
    digits = local ? ('66' + local) : '';
  }
  if (digits.length < 8) return null;
  return 'https://wa.me/' + digits;
}

function buildMessengerLink(messengerId) {
  const trimmed = (messengerId || '').toString().trim();
  if (!trimmed) return null;
  return 'https://m.me/' + encodeURIComponent(trimmed);
}

const HONORIFIC_PREFIXES = ['mr', 'mrs', 'ms', 'miss', 'mister', 'mistress', 'dr', 'master'];
function firstNameOf(fullName) {
  const trimmed = (fullName || '').toString().trim();
  if (!trimmed) return 'there';
  const honorifics = HONORIFIC_PREFIXES.slice().sort((a, b) => b.length - a.length).join('|');
  const prefixRe = new RegExp('^(' + honorifics + ')\\.?', 'i');
  const m = trimmed.match(prefixRe);
  let stripped = trimmed;
  if (m) {
    const rest = trimmed.slice(m[0].length);
    if (rest === '' || /^[A-Z\s]/.test(rest)) stripped = rest.trim();
  }
  const tokens = (stripped || trimmed).split(/\s+/);
  const first = tokens[0] || '';
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const BRAND_PREFIXES = ['yamaha', 'honda', 'suzuki', 'kawasaki', 'vespa', 'sym', 'gpx', 'kymco',
  'aprilia', 'benelli', 'scomadi', 'royal', 'alloy', 'vino', 'ducati', 'piaggio'];
const COLOR_WORDS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink',
  'black', 'white', 'grey', 'gray', 'silver', 'gold', 'brown', 'beige',
  'cream', 'navy', 'maroon', 'teal', 'matte', 'metallic', 'glossy', 'camo'];
const ACRONYM_EXCEPTIONS = ['gt', 'pcx'];
const DISTINGUISHING_SUFFIXES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

function capitalizeBikeName(s) {
  return s.split(' ').map((word) => {
    if (!word) return word;
    const lw = word.toLowerCase();
    if (ACRONYM_EXCEPTIONS.indexOf(lw) !== -1) return lw.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

// NOTE on scope: Code.gs's shortBikeNameServer_ has a second-tier fallback
// (customerFacingBikeModelServer_) that looks up the bike's real "Model"
// from the Bike Tax tab when available. This app has no server-side port of
// Bike Tax lookups yet (bikesWrites.js/customersWrites.js don't expose one),
// so this port always uses the shortened/mangled internal bike name -- the
// same fallback Code.gs itself uses when a bike isn't found in Bike Tax.
// Slightly less polished for the WhatsApp reminder message text than
// Code.gs's best case, never wrong -- worth revisiting if Anton wants exact
// parity there too.
function shortBikeName(fullName) {
  const original = (fullName || '').toString().trim();
  if (!original) return original;
  let tokens = original.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return original;
  if (tokens.length > 1 && BRAND_PREFIXES.indexOf(tokens[0].toLowerCase()) !== -1) tokens = tokens.slice(1);
  if (tokens.length > 1 && DISTINGUISHING_SUFFIXES.indexOf(tokens[tokens.length - 1].toLowerCase()) !== -1) tokens = tokens.slice(0, -1);
  tokens = tokens.filter((t) => {
    const lt = t.toLowerCase();
    if (/^\d+cc$/.test(lt)) return false;
    if (/^\d{2,4}$/.test(lt)) return false;
    if (lt === 'keyless' || lt === 'manual') return false;
    if (COLOR_WORDS.indexOf(lt) !== -1) return false;
    return true;
  });
  const joined = tokens.join(' ').replace(/\bstandard\s+key\b/i, '').trim().replace(/\s+/g, ' ');
  if (!joined) return original;
  return capitalizeBikeName(joined);
}

function buildReturnReminderMessage(firstName, bikeShort) {
  const prayEmoji = String.fromCodePoint(128591); // 🙏
  const scooterEmoji = String.fromCodePoint(128757); // 🛵
  return 'Hi ' + firstName + ' ' + prayEmoji + ', hope you\'re doing well! Just a quick reminder that your ' +
    bikeShort + ' is due back tomorrow. Would you like to return it as planned, or would you prefer to extend the rental? ' +
    'Let us know either way — thanks so much! ' + scooterEmoji;
}

// ---- Contract-sheet chat-name/contact lookup -- port of Code.gs's
// buildContractChatNameLookup_ + find*ForCustomerRow_ helpers, adapted to
// this app's plain-array Contract rows and its own fuzzy bike-name matcher
// (bikeNamesMatchForPhotos, imported from lib/googleDrive.js -- same
// prefix-plus-distinguishing-suffix idea as Code.gs's
// bikeNamesMatchForTaxLookup, close enough for this best-effort lookup). ----
function normalizeNameForMatch(name) {
  return (name || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildContractLookup(contractRows) {
  const rows = [];
  for (const r of (contractRows || [])) {
    if (!Array.isArray(r)) continue;
    rows.push({
      name: normalizeNameForMatch(r[CT.NAME]),
      bikeModel: (r[CT.BIKE] || '').toString().trim(),
      number: (r[CT.NUMBER] || '').toString().trim(),
      chatName: (r[CT.CHAT_NAME] || '').toString().trim(),
      contact: (r[CT.CONTACT] || '').toString().trim(),
      messengerId: (r[CT.MESSENGER_ID] || '').toString().trim()
    });
  }
  return rows;
}

// Shared matcher: exact normalized-name match + fuzzy bike match, most
// recently added Contract row wins on a tie (searches from the end) --
// same best-effort rule as every find*ForCustomerRow_ in Code.gs.
function findContractLookupRow(contractLookup, name, bikeModel) {
  const nameTarget = normalizeNameForMatch(name);
  if (!nameTarget) return null;
  const bikeTarget = (bikeModel || '').toString().trim();
  for (let i = contractLookup.length - 1; i >= 0; i--) {
    const row = contractLookup[i];
    if (row.name !== nameTarget) continue;
    if (bikeTarget && row.bikeModel && !bikeNamesMatchForPhotos(row.bikeModel, bikeTarget)) continue;
    return row;
  }
  return null;
}

// ---- Date/time parsing -- this app stores "YYYY-MM-DDTHH:MM:SS" for dates
// and bare "HH:MM:SS" for times (see lib/contractWrites.js's
// decodeSheetDate/isoDateInputToContractValue), NOT real Date-typed cells
// like Code.gs's spreadsheet. ----
function decodeSheetDate(val) {
  if (typeof val !== 'string' || !val) return null;
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function decodeSheetTimeOfDay(val) {
  if (typeof val !== 'string' || !val) return null;
  const m = val.match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return { hours: Number(m[1]), minutes: Number(m[2]) };
}
function toRfc3339(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}
function toDateOnly(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// =====================================================================
// ---- Due-back (🛵) event -- port of Code.gs's syncCalendarForCustomerRow.
// =====================================================================

// PURE: decides what should happen to this row's calendar event, and what
// it should look like, without touching the network. `existingSignature` is
// whatever was stored on the event's extendedProperties.private.syncSignature
// the last time this row was synced (Calendar API's direct equivalent of
// Code.gs's "note on the calendarEventId cell" change-detection trick).
function computeDueBackEventPlan(row, contractLookup) {
  const name = (row[CUST.NAME] || '').toString().trim();
  const bike = (row[CUST.BIKE] || '').toString().trim();
  const situation = (row[CUST.SITUATION] || '').toString().trim().toLowerCase();
  const existingEventId = (row[CUST.CAL_EVENT_ID] || '').toString().trim();
  const timeConfirmedRaw = row[CUST.TIME_CONFIRMED];
  const timeConfirmed = timeConfirmedRaw === true ||
    (typeof timeConfirmedRaw === 'string' && timeConfirmedRaw.trim().toLowerCase() === 'true');
  const pickupLink = (row[CUST.PICKUP_LINK] || '').toString().trim();

  const stillOut = situation !== 'returned';
  const returnDate = decodeSheetDate(row[CUST.RETURN_DATE]);
  const hasReturnDate = !!returnDate;

  if (!stillOut || !hasReturnDate || !name || !bike) {
    return { action: existingEventId ? 'delete' : 'skip', existingEventId };
  }

  const confirmedDate = decodeSheetDate(row[CUST.CONFIRMED_DATE]);
  const eventDateSource = confirmedDate || returnDate;
  const timeOfDay = decodeSheetTimeOfDay(row[CUST.RETURN_TIME]);
  const wantsAllDay = !timeOfDay;
  const startDate = new Date(eventDateSource.getFullYear(), eventDateSource.getMonth(), eventDateSource.getDate(),
    timeOfDay ? timeOfDay.hours : 0, timeOfDay ? timeOfDay.minutes : 0);

  const syncSignature = [bike, name, wantsAllDay ? '1' : '0',
    wantsAllDay ? toDateOnly(startDate) : toRfc3339(startDate),
    timeConfirmed ? '1' : '0', pickupLink].join('|');

  const confirmedPrefix = timeConfirmed ? String.fromCodePoint(9989) + ' ' : ''; // ✅
  const title = confirmedPrefix + String.fromCodePoint(128757) + ' ' + bike + ' — ' + name; // 🛵
  const pickupLinkHtml = pickupLink
    ? `<a href="${pickupLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Open pickup location in Google Maps</a>`
    : '';

  const contactRow = findContractLookupRow(contractLookup, name, bike);
  const isMessengerContact = !!(contactRow && contactRow.contact.toLowerCase() === 'messenger' && contactRow.messengerId);
  const custNumber = isMessengerContact ? '' : (contactRow ? contactRow.number : '');
  const waLink = buildWhatsAppLink(custNumber);
  const messengerLink = isMessengerContact ? buildMessengerLink(contactRow.messengerId) : null;
  const nameLinkTarget = waLink || messengerLink;
  const renterNameHtml = nameLinkTarget
    ? `<a href="${nameLinkTarget.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${name}</a>`
    : name;
  let contactLinkHtml = '';
  if (waLink) {
    const reminderMessage = buildReturnReminderMessage(firstNameOf(name), shortBikeName(bike));
    const reminderWaUrl = waLink + '?text=' + encodeURIComponent(reminderMessage);
    contactLinkHtml = `<a href="${reminderWaUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${String.fromCodePoint(128172)} Contact customer on WhatsApp</a>`;
  }

  const description = 'Renter: ' + renterNameHtml +
    '\nBike: ' + bike +
    (timeConfirmed ? '\n✅ Confirmed pickup — staff-adjusted from the original due date/time.' : '') +
    (pickupLinkHtml ? '\n' + pickupLinkHtml : '') +
    (contactLinkHtml ? '\n\n' + contactLinkHtml : '');

  return {
    action: existingEventId ? 'upsert' : 'create',
    existingEventId,
    syncSignature,
    wantsAllDay,
    startDate,
    title,
    description,
    location: pickupLink || '',
    colorId: timeConfirmed ? COLOR_ID.GREEN : COLOR_ID.PALE_BLUE
  };
}

function planToEventResource(plan) {
  const resource = {
    summary: plan.title,
    description: plan.description,
    location: plan.location,
    colorId: plan.colorId,
    extendedProperties: { private: { syncSignature: plan.syncSignature } }
  };
  if (plan.wantsAllDay) {
    resource.start = { date: toDateOnly(plan.startDate) };
    resource.end = { date: toDateOnly(plan.startDate) }; // Calendar API all-day "end" is exclusive next-day normally, but a single-day all-day event uses the same date for start/end per the API's own convention -- corrected below.
    const next = new Date(plan.startDate.getTime() + 24 * 60 * 60 * 1000);
    resource.end = { date: toDateOnly(next) };
  } else {
    const endDate = new Date(plan.startDate.getTime() + 30 * 60 * 1000);
    resource.start = { dateTime: toRfc3339(plan.startDate), timeZone: CALENDAR_TIMEZONE };
    resource.end = { dateTime: toRfc3339(endDate), timeZone: CALENDAR_TIMEZONE };
  }
  return resource;
}

// Best-effort existence check -- Calendar API's events.get() throws (404)
// for a deleted/bad ID rather than Apps Script's "ghost object" quirk, so
// this is simpler than Code.gs's getCalendarEventSafe_/isCalendarEventNotFoundError_
// combo, but serves the same purpose.
async function getEventSafe(calendar, eventId) {
  if (!eventId) return null;
  try {
    const res = await calendar.events.get({ calendarId: 'primary', eventId });
    if (res.data && res.data.status === 'cancelled') return null;
    return res.data;
  } catch (err) {
    return null;
  }
}

// Applies a computed plan against the real Calendar API. Returns the row's
// updated calendarEventId (empty string if removed/never existed).
async function applyDueBackEventPlan(calendar, plan) {
  if (plan.action === 'skip') return plan.existingEventId || '';

  if (plan.action === 'delete') {
    if (plan.existingEventId) {
      try {
        await calendar.events.delete({ calendarId: 'primary', eventId: plan.existingEventId });
      } catch (err) {
        // Already gone (404) or some other transient failure -- either way,
        // matches Code.gs's own "couldn't confirm, but don't treat delete as
        // fatal" posture. Unlike Code.gs we don't retry-preserve the ID here
        // (no per-cell note to leave a trace in) -- next sweep's a create no-op
        // if it's actually still there, which is self-healing either way.
      }
    }
    return '';
  }

  const existing = plan.existingEventId ? await getEventSafe(calendar, plan.existingEventId) : null;
  const existingSignature = existing && existing.extendedProperties && existing.extendedProperties.private
    ? existing.extendedProperties.private.syncSignature : null;

  if (existing && existingSignature === plan.syncSignature) {
    return plan.existingEventId; // nothing changed and the event is still there
  }

  const resource = planToEventResource(plan);

  // If all-day vs timed needs to change, delete and recreate (mirrors
  // Code.gs's own reasoning for the same edge case).
  const existingIsAllDay = existing && existing.start && !!existing.start.date;
  if (existing && existingIsAllDay !== plan.wantsAllDay) {
    try { await calendar.events.delete({ calendarId: 'primary', eventId: plan.existingEventId }); } catch (err) { /* best-effort */ }
    const created = await calendar.events.insert({ calendarId: 'primary', requestBody: resource });
    return created.data.id;
  }

  if (existing) {
    const updated = await calendar.events.update({ calendarId: 'primary', eventId: plan.existingEventId, requestBody: resource });
    return updated.data.id;
  }
  const created = await calendar.events.insert({ calendarId: 'primary', requestBody: resource });
  return created.data.id;
}

// Combines the two above -- the main entry point real write hooks call.
// Returns { row: updatedRowCopy, changed: bool } so the caller decides
// whether a sheet write-back is needed. Never throws (matches Code.gs's own
// "a calendar problem should never break the row write it's piggybacking
// on" posture) -- logs and returns the row unchanged on failure.
async function syncDueBackEventForCustomerRow(calendar, row, contractLookup) {
  if (!calendar) return { row, changed: false }; // calendar not connected -- skip quietly
  try {
    const plan = computeDueBackEventPlan(row, contractLookup);
    if (plan.action === 'skip') return { row, changed: false };
    const newEventId = await applyDueBackEventPlan(calendar, plan);
    if (newEventId === (row[CUST.CAL_EVENT_ID] || '')) return { row, changed: false };
    const updatedRow = row.slice();
    updatedRow[CUST.CAL_EVENT_ID] = newEventId;
    return { row: updatedRow, changed: true };
  } catch (err) {
    console.warn('[googleCalendarSync] due-back sync failed:', err && err.message);
    return { row, changed: false };
  }
}

// =====================================================================
// ---- Delivery (🏨) event -- port of Code.gs's
// attemptDeliveryCalendarSyncOnce_/syncDeliveryCalendarForContractRow.
// =====================================================================

function computeDeliveryEventPlan(row) {
  const name = (row[CT.NAME] || '').toString().trim();
  const bike = (row[CT.BIKE] || '').toString().trim();
  const deliverToHotel = (row[CT.DELIVER_TO_HOTEL] || '').toString().trim().toLowerCase();
  const status = (row[CT.STATUS] || '').toString().trim().toLowerCase();
  const existingEventId = (row[CT.CAL_EVENT_ID] || '').toString().trim();
  const deliveryLink = (row[CT.DELIVERY_LINK] || '').toString().trim();

  const isPending = status === 'pending';
  const wantsDelivery = deliverToHotel === 'yes';
  const dateVal = decodeSheetDate(row[CT.RENTING_DATE_FROM]);
  const timeVal = decodeSheetTimeOfDay(row[CT.DELIVERY_TIME]);

  if (!isPending || !wantsDelivery || !dateVal || !timeVal || !name || !bike) {
    return { action: existingEventId ? 'delete' : 'skip', existingEventId };
  }

  const startDate = new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate(), timeVal.hours, timeVal.minutes);
  const title = String.fromCodePoint(127976) + ' Delivery: ' + bike + ' — ' + name; // 🏨
  const deliveryLinkHtml = deliveryLink
    ? `<a href="${deliveryLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Open delivery location in Google Maps</a>`
    : '';
  const description = 'Renter: ' + name + '\nBike: ' + bike + '\nDeliver to hotel at rental start.' +
    (deliveryLinkHtml ? '\n' + deliveryLinkHtml : '');
  const syncSignature = [bike, name, toRfc3339(startDate), deliveryLink].join('|');

  return {
    action: existingEventId ? 'upsert' : 'create',
    existingEventId, syncSignature, wantsAllDay: false, startDate,
    title, description, location: deliveryLink || '', colorId: COLOR_ID.ORANGE
  };
}

async function applyDeliveryEventPlan(calendar, plan) {
  if (plan.action === 'skip') return plan.existingEventId || '';
  if (plan.action === 'delete') {
    if (plan.existingEventId) {
      try { await calendar.events.delete({ calendarId: 'primary', eventId: plan.existingEventId }); } catch (err) { /* best-effort */ }
    }
    return '';
  }
  const existing = plan.existingEventId ? await getEventSafe(calendar, plan.existingEventId) : null;
  const existingSignature = existing && existing.extendedProperties && existing.extendedProperties.private
    ? existing.extendedProperties.private.syncSignature : null;
  if (existing && existingSignature === plan.syncSignature) return plan.existingEventId;

  const resource = planToEventResource(plan);
  if (existing) {
    const updated = await calendar.events.update({ calendarId: 'primary', eventId: plan.existingEventId, requestBody: resource });
    return updated.data.id;
  }
  const created = await calendar.events.insert({ calendarId: 'primary', requestBody: resource });
  return created.data.id;
}

// Mirrors syncDeliveryCalendarForContractRow's single retry.
async function syncDeliveryEventForContractRow(calendar, row) {
  if (!calendar) return { row, changed: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const plan = computeDeliveryEventPlan(row);
      if (plan.action === 'skip') return { row, changed: false };
      const newEventId = await applyDeliveryEventPlan(calendar, plan);
      if (newEventId === (row[CT.CAL_EVENT_ID] || '')) return { row, changed: false };
      const updatedRow = row.slice();
      updatedRow[CT.CAL_EVENT_ID] = newEventId;
      return { row: updatedRow, changed: true };
    } catch (err) {
      console.warn(`[googleCalendarSync] delivery sync attempt ${attempt + 1} failed:`, err && err.message);
    }
  }
  return { row, changed: false };
}

// =====================================================================
// ---- Reminders (🔔) -- port of Code.gs's addCalendarReminderEntry/
// editCalendarReminderEntry/completeCalendarReminderEntry/getCalendarReminders.
// No sheet backing, same as the original -- the calendar event IS the
// record. ----
// =====================================================================

function parseReminderDateTime(date, time) {
  if (!date) throw new Error('Please pick a date.');
  if (!time) throw new Error('Please pick a time.');
  const dateParts = String(date).split('-');
  const timeParts = String(time).split(':');
  if (dateParts.length !== 3 || timeParts.length < 2) throw new Error('Invalid date or time.');
  const startDate = new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]), Number(timeParts[0]), Number(timeParts[1]));
  if (isNaN(startDate.getTime())) throw new Error('Invalid date or time.');
  return startDate;
}

async function addReminder(calendar, { date, time, text }) {
  const trimmedText = (text || '').toString().trim();
  if (!trimmedText) throw new Error('Please enter what the reminder is about.');
  const startDate = parseReminderDateTime(date, time);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
  const resource = {
    summary: String.fromCodePoint(128276) + ' Reminder: ' + trimmedText, // 🔔
    description: trimmedText + '\n\nAdded by staff from the Bike Returns Calendar page.',
    start: { dateTime: toRfc3339(startDate), timeZone: CALENDAR_TIMEZONE },
    end: { dateTime: toRfc3339(endDate), timeZone: CALENDAR_TIMEZONE },
    colorId: COLOR_ID.YELLOW
  };
  const created = await calendar.events.insert({ calendarId: 'primary', requestBody: resource });
  return { eventId: created.data.id };
}

async function editReminder(calendar, { eventId, date, time, text }) {
  const trimmedEventId = (eventId || '').toString().trim();
  if (!trimmedEventId) throw new Error('Missing reminder event ID.');
  const trimmedText = (text || '').toString().trim();
  if (!trimmedText) throw new Error('Please enter what the reminder is about.');
  const startDate = parseReminderDateTime(date, time);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
  const existing = await getEventSafe(calendar, trimmedEventId);
  if (!existing) throw new Error('This reminder no longer exists on the calendar -- it may have already been completed. Refresh the list and try again.');
  const resource = {
    summary: String.fromCodePoint(128276) + ' Reminder: ' + trimmedText,
    description: trimmedText + '\n\nAdded by staff from the Bike Returns Calendar page.',
    start: { dateTime: toRfc3339(startDate), timeZone: CALENDAR_TIMEZONE },
    end: { dateTime: toRfc3339(endDate), timeZone: CALENDAR_TIMEZONE },
    colorId: COLOR_ID.YELLOW
  };
  await calendar.events.update({ calendarId: 'primary', eventId: trimmedEventId, requestBody: resource });
  return {};
}

// Returns the eventId so the API layer can also clear a matching customer
// row's contact-reminder columns (U/V) -- mirrors Code.gs's
// clearContactReminderColumnsForEventId_ split (that part needs sheet
// access, which this pure calendar module doesn't have).
async function completeReminder(calendar, { eventId }) {
  const trimmedEventId = (eventId || '').toString().trim();
  if (!trimmedEventId) throw new Error('Missing reminder event ID.');
  const existing = await getEventSafe(calendar, trimmedEventId);
  if (existing) {
    try { await calendar.events.delete({ calendarId: 'primary', eventId: trimmedEventId }); } catch (err) { /* already gone is fine */ }
  }
  return { eventId: trimmedEventId };
}

async function listReminders(calendar) {
  const bellPrefix = String.fromCodePoint(128276); // 🔔
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: windowStart.toISOString(),
    timeMax: windowEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500
  });
  const events = (res.data.items || []).filter((e) => (e.summary || '').startsWith(bellPrefix));
  return events.map((e) => {
    const start = e.start && (e.start.dateTime || e.start.date);
    const startDate = start ? new Date(start) : null;
    const pad = (n) => String(n).padStart(2, '0');
    return {
      eventId: e.id,
      displayDate: startDate ? `${pad(startDate.getDate())}/${pad(startDate.getMonth() + 1)}/${startDate.getFullYear()}` : '',
      date: startDate ? toDateOnly(startDate) : '',
      time: (e.start && e.start.dateTime) ? `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}` : '',
      text: (e.summary || '').replace(bellPrefix, '').replace(/^\s*Reminder:\s*/, '').trim()
    };
  });
}

// =====================================================================
// ---- Delivery/pickup link list + set -- port of Code.gs's
// getDeliveryPickupLinkList/setDeliveryPickupLinkEntry. Pure sheet-data
// functions (no Calendar API call) -- the actual link-set + re-sync is two
// steps the API layer composes (write the link cell, then call
// syncDeliveryEventForContractRow/syncDueBackEventForCustomerRow above),
// exactly like Code.gs's own setDeliveryPickupLinkEntry does. ----
// =====================================================================

function listDeliveryPickupLinks(customerRows, contractRows) {
  const entries = [];
  (contractRows || []).forEach((row, i) => {
    if (!Array.isArray(row)) return;
    const name = (row[CT.NAME] || '').toString().trim();
    const bike = (row[CT.BIKE] || '').toString().trim();
    const status = (row[CT.STATUS] || '').toString().trim().toLowerCase();
    const deliver = (row[CT.DELIVER_TO_HOTEL] || '').toString().trim().toLowerCase();
    const dateVal = decodeSheetDate(row[CT.RENTING_DATE_FROM]);
    const timeVal = decodeSheetTimeOfDay(row[CT.DELIVERY_TIME]);
    if (!name || !bike || status !== 'pending' || deliver !== 'yes' || !dateVal || !timeVal) return;
    const pad = (n) => String(n).padStart(2, '0');
    entries.push({
      type: 'delivery', rowIndex: i, name, bikeModel: bike,
      date: toDateOnly(dateVal), time: `${pad(timeVal.hours)}:${pad(timeVal.minutes)}`,
      displayDate: `${pad(dateVal.getDate())}/${pad(dateVal.getMonth() + 1)}/${dateVal.getFullYear()}`,
      link: (row[CT.DELIVERY_LINK] || '').toString().trim()
    });
  });
  (customerRows || []).forEach((row, j) => {
    if (!Array.isArray(row)) return;
    const name = (row[CUST.NAME] || '').toString().trim();
    const bike = (row[CUST.BIKE] || '').toString().trim();
    const situation = (row[CUST.SITUATION] || '').toString().trim().toLowerCase();
    const returnDate = decodeSheetDate(row[CUST.RETURN_DATE]);
    if (!name || !bike || situation === 'returned' || !returnDate) return;
    const confirmedDate = decodeSheetDate(row[CUST.CONFIRMED_DATE]);
    const dateSource = confirmedDate || returnDate;
    const timeVal = decodeSheetTimeOfDay(row[CUST.RETURN_TIME]);
    const pad = (n) => String(n).padStart(2, '0');
    entries.push({
      type: 'pickup', rowIndex: j, name, bikeModel: bike,
      date: toDateOnly(dateSource), time: timeVal ? `${pad(timeVal.hours)}:${pad(timeVal.minutes)}` : '',
      displayDate: `${pad(dateSource.getDate())}/${pad(dateSource.getMonth() + 1)}/${dateSource.getFullYear()}`,
      link: (row[CUST.PICKUP_LINK] || '').toString().trim()
    });
  });
  entries.sort((a, b) => {
    const aKey = a.date + ' ' + (a.time || '00:00');
    const bKey = b.date + ' ' + (b.time || '00:00');
    return aKey < bKey ? -1 : (aKey > bKey ? 1 : 0);
  });
  return entries;
}

// =====================================================================
// ---- Nightly "contact customer" reminder job -- port of Code.gs's
// createContactCustomerReminders. PURE decision half (which rows need a
// fresh 🔔 reminder tonight) -- the API-calling half is folded into
// dailySweep below since it shares the calendar client with the resync
// passes. ----
// =====================================================================

function computeContactReminderCandidates(customerRows, todayLocal) {
  const today = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate());
  const dayAfterTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
  const dayAfterTomorrowKey = toDateOnly(dayAfterTomorrow);
  const candidates = [];
  (customerRows || []).forEach((row, i) => {
    if (!Array.isArray(row)) return;
    const name = (row[CUST.NAME] || '').toString().trim();
    if (!name) return;
    const situation = (row[CUST.SITUATION] || '').toString().trim().toLowerCase();
    const bike = (row[CUST.BIKE] || '').toString().trim();
    if (situation === 'returned' || !bike) return;
    const confirmedDate = decodeSheetDate(row[CUST.CONFIRMED_DATE]);
    const returnDate = decodeSheetDate(row[CUST.RETURN_DATE]);
    const dueDateSource = confirmedDate || returnDate;
    if (!dueDateSource) return;
    const dueDateKey = toDateOnly(dueDateSource);
    if (dueDateKey !== dayAfterTomorrowKey) return;

    const existingReminderId = (row[CUST.CONTACT_REMINDER_EVENT_ID] || '').toString().trim();
    const existingReminderForDate = (row[CUST.CONTACT_REMINDER_FOR_DATE] || '').toString().trim();
    if (existingReminderId && existingReminderForDate === dueDateKey) return; // already reminded

    candidates.push({ rowIndex: i, name, bike, dueDateKey, staleReminderId: existingReminderId || null });
  });
  return { candidates, tomorrow: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
}

async function createContactCustomerReminders(calendar, customerRows, contractLookup, now) {
  if (!calendar) return { created: 0, checked: 0 };
  const { candidates, tomorrow } = computeContactReminderCandidates(customerRows, now || new Date());
  const updatedRows = customerRows.slice();
  let created = 0;
  for (const c of candidates) {
    if (c.staleReminderId) {
      const stale = await getEventSafe(calendar, c.staleReminderId);
      if (stale) { try { await calendar.events.delete({ calendarId: 'primary', eventId: c.staleReminderId }); } catch (err) { /* best-effort */ } }
    }
    const contactRow = findContractLookupRow(contractLookup, c.name, c.bike);
    const waLink = buildWhatsAppLink(contactRow ? contactRow.number : '');
    const renterNameHtml = waLink ? `<a href="${waLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${c.name}</a>` : c.name;
    let contactLinkHtml = '';
    if (waLink) {
      const msg = buildReturnReminderMessage(firstNameOf(c.name), shortBikeName(c.bike));
      const url = waLink + '?text=' + encodeURIComponent(msg);
      contactLinkHtml = `<a href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${String.fromCodePoint(128172)} Contact customer on WhatsApp</a>`;
    }
    const description = 'Renter: ' + renterNameHtml + '\nBike: ' + c.bike +
      '\nDue back tomorrow -- contact to arrange extension or return.' + (contactLinkHtml ? '\n\n' + contactLinkHtml : '');
    const resource = {
      summary: String.fromCodePoint(128276) + ' Contact customer: ' + c.bike + ' — ' + c.name, // 🔔
      description,
      start: { date: toDateOnly(tomorrow) },
      end: { date: toDateOnly(new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000)) },
      colorId: COLOR_ID.ORANGE
    };
    try {
      const eventRes = await calendar.events.insert({ calendarId: 'primary', requestBody: resource });
      const row = updatedRows[c.rowIndex].slice();
      row[CUST.CONTACT_REMINDER_EVENT_ID] = eventRes.data.id;
      row[CUST.CONTACT_REMINDER_FOR_DATE] = c.dueDateKey;
      updatedRows[c.rowIndex] = row;
      created++;
    } catch (err) {
      console.warn('[googleCalendarSync] contact-customer reminder failed for row', c.rowIndex, err && err.message);
    }
  }
  return { created, checked: candidates.length, rows: updatedRows };
}

// =====================================================================
// ---- Daily sweep -- combines the resync safety-net (both event types)
// with the nightly contact-reminder job into ONE pass, per Anton's own
// call (18/08/2026): "one daily job... nothing stops one daily job from
// doing the reminder pass and then the full resync pass back to back."
// Returns updated row arrays for the caller to persist via sheetIO. ----
// =====================================================================

async function dailySweep(calendar, customerRows, contractRows) {
  if (!calendar) return { ok: false, reason: 'not_connected' };
  const contractLookup = buildContractLookup(contractRows);

  let updatedCustomerRows = customerRows.slice();
  let dueBackChanged = 0;
  for (let i = 0; i < updatedCustomerRows.length; i++) {
    if (!Array.isArray(updatedCustomerRows[i]) || !updatedCustomerRows[i][CUST.NAME]) continue;
    const { row, changed } = await syncDueBackEventForCustomerRow(calendar, updatedCustomerRows[i], contractLookup);
    if (changed) { updatedCustomerRows[i] = row; dueBackChanged++; }
  }

  let updatedContractRows = contractRows.slice();
  let deliveryChanged = 0;
  for (let i = 0; i < updatedContractRows.length; i++) {
    if (!Array.isArray(updatedContractRows[i]) || !updatedContractRows[i][CT.NAME]) continue;
    const { row, changed } = await syncDeliveryEventForContractRow(calendar, updatedContractRows[i]);
    if (changed) { updatedContractRows[i] = row; deliveryChanged++; }
  }

  const reminderResult = await createContactCustomerReminders(calendar, updatedCustomerRows, contractLookup, new Date());
  if (reminderResult.rows) updatedCustomerRows = reminderResult.rows;

  return {
    ok: true,
    customerRows: updatedCustomerRows,
    contractRows: updatedContractRows,
    stats: {
      customerRowsChecked: customerRows.filter((r) => Array.isArray(r) && r[CUST.NAME]).length,
      dueBackEventsChanged: dueBackChanged,
      contractRowsChecked: contractRows.filter((r) => Array.isArray(r) && r[CT.NAME]).length,
      deliveryEventsChanged: deliveryChanged,
      contactRemindersCreated: reminderResult.created
    }
  };
}

module.exports = {
  CUST, CT, COLOR_ID,
  buildWhatsAppLink, buildMessengerLink, firstNameOf, shortBikeName, buildReturnReminderMessage,
  normalizeNameForMatch, buildContractLookup, findContractLookupRow,
  decodeSheetDate, decodeSheetTimeOfDay, toRfc3339, toDateOnly,
  computeDueBackEventPlan, applyDueBackEventPlan, syncDueBackEventForCustomerRow,
  computeDeliveryEventPlan, applyDeliveryEventPlan, syncDeliveryEventForContractRow,
  parseReminderDateTime, addReminder, editReminder, completeReminder, listReminders,
  listDeliveryPickupLinks,
  computeContactReminderCandidates, createContactCustomerReminders,
  dailySweep
};
