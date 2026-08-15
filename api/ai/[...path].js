// Single catch-all function for every /api/ai/* route -- /passport,
// /whatsapp-contact, /reply-draft -- dispatched by path + method, same
// consolidation pattern as api/contracts/[...path].js and
// api/photos/[...path].js (Vercel Hobby plan caps a deployment at 12
// Serverless Functions total; see PROGRESS.md's 2026-08-15 entry for the
// full story, including the mistake made merging photos/* that this file
// deliberately avoids repeating -- there is exactly ONE file here, no
// leftover single-route files to forget to delete).
//
// Wires up the AI-provider integrations that were deliberately left
// unported during the JSON-parity migration (see each page's own
// "NOT ported" comments, e.g. contract.html/reply-assistant.html) --
// passport photo OCR, WhatsApp "Edit contact" screenshot OCR, and the
// AI reply-draft generator. All three read a shared, staff-toggleable
// Claude-vs-Gemini preference (see getAiProvider below) so the exact same
// settings.html toggle that already existed (previously wired to the old
// disconnected Code.gs backend) now actually does something.
//
// Needs an Anthropic and/or Gemini API key to actually work. Two ways to
// provide one, checked in this order: (1) a key saved through the app
// itself, in settings.html's "API keys" section (POST /api/ai/keys below
// -- stored in the app's own Drive folder, same trust boundary as every
// other piece of app data like bikes_notes.json), or (2) ANTHROPIC_API_KEY
// / GEMINI_API_KEY set as a Vercel Environment Variable (Project >
// Settings > Environment Variables), which still works as a fallback if
// no Drive-stored key is set -- added 2026-08-14/15, kept working
// unchanged so nothing breaks for anyone who already set env vars before
// this UI existed. Missing BOTH throws a clear "no key is set" error that
// surfaces to staff exactly like any other read failure (never a silent/
// blank fill -- every one of these three UI flows already treats a
// thrown error as "could not read, enter by hand").
const { withDrive } = require('../../lib/apiAuth');
const { ensureAppFolder, readJsonFile, writeJsonFile } = require('../../lib/googleDrive');

const AI_PROVIDER_FILENAME = 'ai_provider.json';
const AI_KEYS_FILENAME = 'ai_keys.json';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return Promise.resolve(req.body.length ? JSON.parse(req.body) : {});
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw.length ? JSON.parse(raw) : {}); }
      catch (err) { reject(new Error('Invalid JSON body: ' + err.message)); }
    });
    req.on('error', reject);
  });
}

// ---- Reads the staff-toggleable Claude/Gemini preference. Stored as a
// plain "sheet" JSON file (same shape as bikes_notes.json etc) so
// settings.html can read/write it through the EXISTING generic
// /api/data/[sheet].js endpoint -- no new backend route needed for the
// toggle itself, only for the three routes below that consume it.
// Defaults to 'claude' on any read failure or before it's ever been set,
// matching settings.html's own client-side default. ----
async function getAiProvider(drive, folderId) {
  try {
    const { data } = await readJsonFile(drive, folderId, AI_PROVIDER_FILENAME);
    const rows = data || [];
    const row = rows.find((r) => r && r[0] === 'provider');
    const val = row && row[1] ? row[1].toString().toLowerCase().trim() : '';
    return val === 'gemini' ? 'gemini' : 'claude';
  } catch (e) {
    return 'claude';
  }
}

// ---- getAiProvider/the settings.html toggle use 'claude'/'gemini' (the
// MODEL brand shown to staff); ai_keys.json and the "API keys" UI use
// 'anthropic'/'gemini' (the COMPANY/product each key page belongs to --
// matches console.anthropic.com vs aistudio.google.com). This maps one to
// the other so a handler that just resolved "the active provider is
// claude" can look up the right saved key without staff ever seeing the
// mismatch. ----
function providerToKeyName(provider) {
  return provider === 'gemini' ? 'gemini' : 'anthropic';
}

// ---- Reads a staff-saved API key from the app's own Drive folder (see
// settings.html's "API keys" section / handleGetKeys+handleSetKeys below).
// Returns null (not an error) if nothing's been saved there -- the caller
// falls back to the Vercel env var in that case. `provider` is 'anthropic'
// or 'gemini'. ----
async function getStoredApiKey(drive, folderId, provider) {
  try {
    const { data } = await readJsonFile(drive, folderId, AI_KEYS_FILENAME);
    const rows = data || [];
    const row = rows.find((r) => r && r[0] === provider);
    const val = row && row[1] ? row[1].toString().trim() : '';
    return val || null;
  } catch (e) {
    return null;
  }
}

// ---- Never send a saved key back to the client in full -- a short
// prefix (enough to recognize e.g. "sk-ant-" vs "AIza") plus the last 4
// characters, same convention as a payment processor showing "card ending
// in 4242". ----
function maskKey(key) {
  if (!key) return null;
  const k = key.toString();
  if (k.length <= 10) return '••••' + k.slice(-2);
  return k.slice(0, 7) + '…' + k.slice(-4);
}

// ---- Low-level provider calls. Both use the Node 24.x runtime's native
// global fetch -- no new npm dependency needed. Model IDs are read from
// env vars with a fallback default so they can be bumped to whatever's
// current without a code change/redeploy -- verify the fallback against
// each provider's current docs before relying on it long-term, since
// model names/versions move faster than this file will get revisited. ----
async function callAnthropic({ userText, imageBase64, imageMimeType, maxTokens, storedKey }) {
  const apiKey = storedKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No Claude API key is set -- add one in Settings > AI provider, or set ANTHROPIC_API_KEY in Vercel > Settings > Environment Variables.');
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const content = [];
  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: imageMimeType || 'image/jpeg', data: imageBase64 } });
  }
  content.push({ type: 'text', text: userText });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 500,
      messages: [{ role: 'user', content }]
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('Claude API error ' + r.status));
  return (data.content || []).map((b) => b.text || '').join('');
}

async function callGemini({ userText, imageBase64, imageMimeType, maxTokens, storedKey }) {
  const apiKey = storedKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('No Gemini API key is set -- add one in Settings > AI provider, or set GEMINI_API_KEY in Vercel > Settings > Environment Variables.');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const parts = [{ text: userText }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: imageMimeType || 'image/jpeg', data: imageBase64 } });
  }

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: maxTokens || 500 } })
    }
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('Gemini API error ' + r.status));
  const cand = (data.candidates || [])[0];
  const parts2 = cand && cand.content && cand.content.parts ? cand.content.parts : [];
  return parts2.map((p) => p.text || '').join('');
}

async function callAiProvider(provider, opts) {
  return provider === 'gemini' ? callGemini(opts) : callAnthropic(opts);
}

// ---- The vision routes ask the model to answer with ONLY a JSON object.
// Models sometimes wrap that in a markdown code fence anyway despite being
// told not to -- strip one if present before parsing. Returns null (never
// throws) on anything unparseable, same "never applied silently, always
// safe to fall back to manual entry" contract the client side already
// expects from a failed/empty read. ----
function parseJsonFromModelText(text) {
  if (!text) return null;
  let s = text.toString().trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const braced = s.match(/\{[\s\S]*\}/);
  if (braced) { try { return JSON.parse(braced[0]); } catch (e) { /* give up below */ } }
  return null;
}

// ---- POST /api/ai/passport -- body { imageBase64, imageMimeType }.
// Mirrors contract.html's original 'readPassportWithAI' action exactly:
// same three response fields (name, nationality, passport), same
// "empty string for anything illegible, never guess" contract. ----
async function handlePassport(req, res, { drive, folderId }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  const imageBase64 = (body.imageBase64 || '').toString();
  const imageMimeType = (body.imageMimeType || 'image/jpeg').toString();
  if (!imageBase64) { sendJson(res, 400, { success: false, error: 'Missing photo data.' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const provider = await getAiProvider(drive, effectiveFolderId);
  const storedKey = await getStoredApiKey(drive, effectiveFolderId, providerToKeyName(provider));

  const prompt = 'You are reading a photo of the personal-details page of a passport, for a motorbike rental shop\'s customer intake form. Respond with ONLY a JSON object (no markdown code fences, no extra text) in exactly this shape: {"name": "", "nationality": "", "passport": ""} -- full name exactly as printed, nationality (or the issuing country if nationality isn\'t explicitly printed), and the passport number. If a field is not legible, use an empty string for it. Never guess or invent a value.';

  const text = await callAiProvider(provider, { userText: prompt, imageBase64, imageMimeType, maxTokens: 400, storedKey });
  const parsed = parseJsonFromModelText(text) || {};
  sendJson(res, 200, {
    success: true,
    fields: {
      name: (parsed.name || '').toString().trim(),
      nationality: (parsed.nationality || '').toString().trim(),
      passport: (parsed.passport || '').toString().trim()
    }
  });
}

// ---- POST /api/ai/whatsapp-contact -- body { imageBase64, imageMimeType }.
// Mirrors the original 'readWhatsAppContactWithAI' action exactly: reads
// WhatsApp's own "Edit contact" screen (First name / Last name / Phone),
// same two response fields (chatName, number) used by both contract.html
// (add + edit) and reply-assistant.html's "add customer from screenshot". ----
async function handleWhatsAppContact(req, res, { drive, folderId }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  const imageBase64 = (body.imageBase64 || '').toString();
  const imageMimeType = (body.imageMimeType || 'image/jpeg').toString();
  if (!imageBase64) { sendJson(res, 400, { success: false, error: 'Missing photo data.' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const provider = await getAiProvider(drive, effectiveFolderId);
  const storedKey = await getStoredApiKey(drive, effectiveFolderId, providerToKeyName(provider));

  const prompt = 'You are reading a screenshot of WhatsApp\'s own "Edit contact" screen (fields typically include First name, Last name, and Phone). Respond with ONLY a JSON object (no markdown code fences, no extra text) in exactly this shape: {"chatName": "", "number": ""} -- chatName is the first and last name combined as one display name, number is the phone number exactly as shown (keep any "+" and country code visible on screen). If a field is not legible, use an empty string for it. Never guess or invent a value.';

  const text = await callAiProvider(provider, { userText: prompt, imageBase64, imageMimeType, maxTokens: 300, storedKey });
  const parsed = parseJsonFromModelText(text) || {};
  sendJson(res, 200, {
    success: true,
    fields: {
      chatName: (parsed.chatName || '').toString().trim(),
      number: (parsed.number || '').toString().trim()
    }
  });
}

// ---- POST /api/ai/reply-draft -- body { customerName, instruction,
// fleetContext, selectedBikes }. Mirrors the original 'generateReplyDraft'
// action: a plain text generation call (no image), trusts fleetContext
// completely for pricing/availability (reply-assistant.html's own
// buildFleetContext already flags when that context couldn't be
// refreshed -- see its comment), returns the draft as plain text for
// staff to review/edit before sending, never sent automatically. ----
async function handleReplyDraft(req, res, { drive, folderId }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  const customerName = (body.customerName || '').toString().trim();
  const instruction = (body.instruction || '').toString().trim();
  const fleetContext = (body.fleetContext || '').toString();
  const selectedBikes = Array.isArray(body.selectedBikes) ? body.selectedBikes.map((b) => b.toString()) : [];
  if (!instruction) { sendJson(res, 400, { success: false, error: 'Missing "instruction".' }); return; }

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const provider = await getAiProvider(drive, effectiveFolderId);
  const storedKey = await getStoredApiKey(drive, effectiveFolderId, providerToKeyName(provider));

  const promptLines = [
    'You are a staff member at AA Scooters, a motorbike rental shop in Chiang Mai, writing a WhatsApp reply to a customer.',
    'Write ONLY the reply message itself -- no preamble, no explanation, no surrounding quotation marks.',
    'Keep it friendly, concise, and in plain WhatsApp-appropriate language.',
    customerName ? ('Customer name: ' + customerName) : '',
    selectedBikes.length ? ('Bike(s) the customer is asking about: ' + selectedBikes.join(', ')) : '',
    'Staff instruction for what this reply should say:',
    instruction,
    '',
    'Current fleet availability and pricing -- trust this completely, do not invent a price or availability that is not listed here:',
    fleetContext || '(no fleet data available right now)'
  ].filter(Boolean);

  const draft = await callAiProvider(provider, { userText: promptLines.join('\n'), maxTokens: 600, storedKey });
  sendJson(res, 200, { success: true, draft: draft.trim() });
}

// ---- GET /api/ai/keys -- returns whether each provider's key is
// currently set and, if so, only a MASKED preview (see maskKey above) --
// the full key value is never sent back to the client once saved. Also
// reports fromEnv so settings.html can show "(from Vercel env var)" and
// hide the "Clear key" button for a key that lives in Vercel, not Drive
// (clearing it here wouldn't do anything -- the env var would still be
// there). ----
async function handleGetKeys(req, res, { drive, folderId }) {
  if (req.method !== 'GET') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const anthropicStored = await getStoredApiKey(drive, effectiveFolderId, 'anthropic');
  const geminiStored = await getStoredApiKey(drive, effectiveFolderId, 'gemini');
  sendJson(res, 200, {
    success: true,
    anthropic: {
      set: !!(anthropicStored || process.env.ANTHROPIC_API_KEY),
      preview: maskKey(anthropicStored),
      fromEnv: !anthropicStored && !!process.env.ANTHROPIC_API_KEY
    },
    gemini: {
      set: !!(geminiStored || process.env.GEMINI_API_KEY),
      preview: maskKey(geminiStored),
      fromEnv: !geminiStored && !!process.env.GEMINI_API_KEY
    }
  });
}

// ---- POST /api/ai/keys -- body { provider: 'anthropic'|'gemini', apiKey }.
// Replaces the stored key for that provider; an empty apiKey clears it
// (falling back to the Vercel env var on the next call, if one is set).
// Stored in the app's own Drive folder -- same trust boundary as every
// other piece of app data (bikes_notes.json, contract_docs.json, etc):
// anyone who already has Drive access to the app folder could in
// principle open this file directly, same as any of those. This route
// itself never echoes a saved key back out in full -- see handleGetKeys. ----
async function handleSetKeys(req, res, { drive, folderId }) {
  if (req.method !== 'POST') { sendJson(res, 405, { success: false, error: 'Method not allowed.' }); return; }
  const body = await readJsonBody(req);
  const provider = (body.provider || '').toString().trim();
  if (provider !== 'anthropic' && provider !== 'gemini') {
    sendJson(res, 400, { success: false, error: 'Invalid "provider" -- must be "anthropic" or "gemini".' });
    return;
  }
  const apiKey = (body.apiKey || '').toString().trim();

  const effectiveFolderId = folderId || await ensureAppFolder(drive);
  const { data } = await readJsonFile(drive, effectiveFolderId, AI_KEYS_FILENAME);
  const rows = (data || []).filter((r) => r && r[0] !== provider);
  if (apiKey) rows.push([provider, apiKey]);
  await writeJsonFile(drive, effectiveFolderId, AI_KEYS_FILENAME, rows, null, false);

  sendJson(res, 200, { success: true, set: !!apiKey, preview: maskKey(apiKey) });
}

module.exports = withDrive(async function handler(req, res, ctx) {
  const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const pathParts = (req.query && req.query.path) ||
    url.pathname.replace(/^\/api\/ai\//, '').split('/').filter(Boolean);
  const route = pathParts[0] || '';

  try {
    if (route === 'passport') { await handlePassport(req, res, ctx); return; }
    if (route === 'whatsapp-contact') { await handleWhatsAppContact(req, res, ctx); return; }
    if (route === 'reply-draft') { await handleReplyDraft(req, res, ctx); return; }
    if (route === 'keys') {
      if (req.method === 'GET') { await handleGetKeys(req, res, ctx); return; }
      if (req.method === 'POST') { await handleSetKeys(req, res, ctx); return; }
      sendJson(res, 405, { success: false, error: 'Method not allowed.' });
      return;
    }
    sendJson(res, 404, { success: false, error: 'Not found.' });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err.message });
  }
});
