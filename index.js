/**
 * form-checker - robust checker that notifies when a Google Form becomes accepting.
 *
 * Behavior summary (generalized):
 * - Try Google Forms API (service account) first if configured and has access.
 * - Otherwise fetch the public HTML and parse heuristically.
 * - NEVER notify when the page indicates the form is closed (common phrases) OR when fetch/parse shows sign-in / access errors.
 * - Notify (Telegram) only when we detect a transition closed -> open (accepting true) OR when forced with `?force=1` *and* FORCE_NOTIFY is enabled (for safe testing).
 *
 * ENV (required):
 * - FORM_URL
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_ID
 * - SECRET_KEY
 *
 * ENV (optional but recommended for reliable "logged-out" checks):
 * - GOOGLE_SERVICE_ACCOUNT_KEY_B64  (base64 of service-account JSON with Forms API enabled and access to the form)
 * - FORCE_NOTIFY (true|false) - enables forced notify via ?force=1 for testing
 *
 * Usage:
 * - GET /check?key=SECRET_KEY
 * - GET /check?key=SECRET_KEY&force=1  (works only if FORCE_NOTIFY=true)
 * - GET /test-telegram
 * - GET /debug-fetch?key=SECRET_KEY
 *
 * Keep secrets in env vars (Render, Railway, etc.). Do NOT commit keys to repo.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const PORT = process.env.PORT || 3000;
const FORM_URL = process.env.FORM_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const FORCE_NOTIFY_ENV = (process.env.FORCE_NOTIFY || 'false').toLowerCase() === 'true';
const STATE_FILE = path.join(__dirname, 'state.json');
const DEBUG_HTML_FILE = path.join(__dirname, 'last_html_debug.html');
const TELEGRAM_LOG = path.join(__dirname, 'telegram_log.json');

console.log('=== form-checker start ===');
console.log('FORM_URL:', !!FORM_URL);
console.log('TELEGRAM_BOT_TOKEN set:', !!TELEGRAM_BOT_TOKEN);
console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : '(not set)');
console.log('SECRET_KEY set:', !!SECRET_KEY);
console.log('FORCE_NOTIFY_ENV:', FORCE_NOTIFY_ENV);
console.log('GOOGLE_SERVICE_ACCOUNT_KEY_B64 present:', !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64);

// sanity env check
if (!FORM_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SECRET_KEY) {
  console.error('❌ Missing required env vars. See .env.example');
  process.exit(1);
}

const app = express();

/* ---------- state helpers ---------- */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw);
    console.log('Loaded state:', s);
    return s;
  } catch (e) {
    console.log('No state file found — initializing.');
    return { accepting: null, last_checked: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('Saved state:', state);
}

/* ---------- HTML fetch & parse fallback ---------- */
async function fetchFormHtml(url) {
  console.log('Fetching form HTML:', url);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
  const res = await axios.get(url, { headers, timeout: 20000, maxRedirects: 5 });
  console.log('Fetched HTML length:', res.data.length);
  return res.data;
}

function parseAcceptingFromHtml(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  // phrases that indicate closed form
  const closedPhrases = [
    'no longer accepting responses',
    'not accepting responses',
    'responses are no longer being accepted',
    'this form is no longer accepting responses',
    'is no longer accepting form responses' // variant user mentioned
  ];
  for (const p of closedPhrases) {
    if (bodyText.includes(p)) return { accepting: false, reason: `matched-closed: "${p}"` };
  }

  // sign-in / access block indicators (treat as "cannot access" / no notify)
  const signInIndicators = [
    'accounts.google.com/signin',
    'sign in to continue',
    'sign in',
    'access denied',
    'you need permission',
    'please sign in'
  ];
  for (const s of signInIndicators) {
    if (bodyText.includes(s)) return { accepting: false, reason: `blocked-signin: "${s}"` };
  }

  // if obvious form controls exist, treat as accepting (heuristic)
  if (bodyText.includes('submit') || bodyText.includes('send') || bodyText.includes('response') || $('form').length > 0) {
    return { accepting: true, reason: 'found-form-controls' };
  }

  // fallback - ambiguous -> treat as closed (do not notify)
  return { accepting: false, reason: 'fallback-no-indicator' };
}

/* ---------- Google Forms API using service account (optional but recommended) ---------- */
async function getFormAcceptingViaServiceAccount(formId) {
  try {
    const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64;
    if (!b64) {
      console.log('No GOOGLE_SERVICE_ACCOUNT_KEY_B64 configured — skipping Forms API.');
      return null;
    }
    const keyJson = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const scopes = [
      'https://www.googleapis.com/auth/forms.body.readonly',
      'https://www.googleapis.com/auth/forms.responses.readonly',
      'https://www.googleapis.com/auth/drive.readonly'
    ];
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes
    });
    const client = await auth.getClient();
    const forms = google.forms({ version: 'v1', auth: client });

    console.log('Calling Forms API for formId:', formId);
    const res = await forms.forms.get({ formId }); // may fail if SA lacks access
    const data = res.data || {};

    // preferred: publishSettings.publishState.isAcceptingResponses (if present)
    if (data.publishSettings && data.publishSettings.publishState && typeof data.publishSettings.publishState.isAcceptingResponses === 'boolean') {
      const isAccepting = !!data.publishSettings.publishState.isAcceptingResponses;
      return { accepting: isAccepting, reason: 'forms-api-publishState' };
    }

    // best-effort: if responderUri present, assume accepting
    if (data.responderUri) {
      return { accepting: true, reason: 'forms-api-responderUri' };
    }

    // else, let caller know API returned no usable info
    return null;
  } catch (err) {
    console.error('Forms API error (will fallback to HTML):', err.response?.data || err.message);
    return null;
  }
}

/* ---------- Telegram send helper (writes simple log file) ---------- */
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  console.log('Calling Telegram API...');
  try {
    const res = await axios.post(url, payload, { timeout: 15000 });
    console.log('Telegram API response ok:', res.data && res.data.ok);
    // append small log
    try {
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push({ at: new Date().toISOString(), ok: !!res.data.ok, response: res.data });
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2));
    } catch (e) {
      console.error('Failed to write telegram log:', e.message);
    }
    return res.data;
  } catch (err) {
    const errBody = err.response ? err.response.data : { message: err.message };
    console.error('Telegram API error:', errBody);
    try {
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push({ at: new Date().toISOString(), ok: false, error: errBody });
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2));
    } catch (e) {
      console.error('Failed to write telegram log:', e.message);
    }
    throw err;
  }
}

/* ---------- utilities ---------- */
function extractFormId(url) {
  const m = url.match(/\/forms\/d\/(?:e\/)?([^\/\?]+)/);
  return m ? m[1] : null;
}

/* ---------- routes ---------- */
app.get('/check', async (req, res) => {
  console.log('=== /check called ===', new Date().toISOString());
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) {
    console.warn('Unauthorized request, providedKey:', providedKey ? providedKey.substring(0, 12) + '...' : '(empty)');
    return res.status(401).send('unauthorized');
  }
  const forceQuery = req.query.force === '1';
  console.log('forceQuery:', forceQuery, 'FORCE_NOTIFY_ENV:', FORCE_NOTIFY_ENV);

  const prevState = loadState();

  // 1) Try Forms API (authenticated) first (most reliable for "logged-out" checks)
  let parsed = null;
  const formId = extractFormId(FORM_URL);
  if (formId) {
    parsed = await getFormAcceptingViaServiceAccount(formId);
    if (parsed) console.log('Forms API parsed result:', parsed);
    else console.log('Forms API returned no result (falling back to HTML parse).');
  } else {
    console.log('Could not extract formId; skipping Forms API.');
  }

  // 2) Fallback to HTML parse when Forms API not available/usable
  let html = null;
  if (!parsed) {
    try {
      html = await fetchFormHtml(FORM_URL);
      fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    } catch (err) {
      console.error('Fetch error:', err.message);
      // on fetch error we do NOT notify (user requested no notify on errors)
      return res.status(502).send({ ok: false, notified: false, error: 'failed to fetch form', details: err.message });
    }
    parsed = parseAcceptingFromHtml(html);
    console.log('HTML parse result:', parsed);
  }

  const accepting = !!parsed.accepting;
  const reason = parsed.reason || '';
  const now = new Date().toISOString();
  const changed = (prevState.accepting === null) ? false : (accepting && prevState.accepting === false);
  console.log('prevState:', prevState, 'accepting:', accepting, 'changed:', changed, 'reason:', reason);

  // DO NOT notify if parser discovered closed-form text or sign-in/access error
  // closed reasons begin with matched-closed:, and sign-in reasons start with blocked-signin:
  if (reason && (reason.startsWith('matched-closed') || reason.startsWith('blocked-signin') || reason === 'fallback-no-indicator')) {
    console.warn('Not notifying because reason indicates closed/sign-in/fallback:', reason);
    // update state to reflect inability or closed status (persist false)
    const st = { accepting: false, last_checked: now };
    saveState(st);
    // do not notify (explicitly)
    return res.send({ ok: true, notified: false, accepting: false, reason, last_checked: now });
  }

  // Save state
  const newState = { accepting, last_checked: now };
  saveState(newState);

  // Decide whether to notify:
  // - natural: transition false -> true (changed && accepting)
  // - forced: forceQuery & FORCE_NOTIFY_ENV (for controlled testing only)
  const shouldNotify = (changed && accepting) || (forceQuery && FORCE_NOTIFY_ENV);
  console.log('shouldNotify:', shouldNotify);

  if (!shouldNotify) {
    return res.send({ ok: true, notified: false, accepting, reason, last_checked: now });
  }

  // Build message and send
  const msg = `✅ Google Form activated\n${FORM_URL}\nChecked at: ${now}\nreason: ${reason}`;
  try {
    const tRes = await sendTelegramMessage(msg);
    console.log('Telegram send success?', !!tRes.ok);
    return res.send({ ok: true, notified: true, accepting, reason, last_checked: now, telegram: tRes });
  } catch (e) {
    console.error('Telegram send failed:', e.response?.data || e.message);
    // we don't notify the caller with Telegram internals; return error
    return res.status(500).send({ ok: false, notified: false, error: 'telegram_send_failed', details: e.response?.data || e.message });
  }
});

// test Telegram (no secret required)
app.get('/test-telegram', async (req, res) => {
  console.log('=== /test-telegram called ===');
  try {
    const r = await sendTelegramMessage(`✅ test-telegram OK at ${new Date().toISOString()}`);
    return res.send({ ok: true, result: r });
  } catch (e) {
    console.error('test-telegram error:', e.response?.data || e.message);
    return res.status(500).send({ ok: false, error: e.response?.data || e.message });
  }
});

// debug fetch (requires secret)
app.get('/debug-fetch', async (req, res) => {
  console.log('=== /debug-fetch called ===');
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) {
    console.warn('Unauthorized /debug-fetch, providedKey:', providedKey ? providedKey.substring(0,12)+'...' : '(empty)');
    return res.status(401).send('unauthorized');
  }
  try {
    // prefer API if configured
    const formId = extractFormId(FORM_URL);
    if (formId && process.env.GOOGLE_SERVICE_ACCOUNT_KEY_B64) {
      const apiParsed = await getFormAcceptingViaServiceAccount(formId);
      if (apiParsed) {
        console.log('/debug-fetch: parsed from API:', apiParsed);
        return res.send({ ok: true, parsed: apiParsed, via: 'api' });
      }
    }
    // fallback html
    const html = await fetchFormHtml(FORM_URL);
    fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    const parsedHtml = parseAcceptingFromHtml(html);
    console.log('/debug-fetch parsed (html):', parsedHtml);
    return res.send({ ok: true, parsed: parsedHtml, via: 'html', length: html.length });
  } catch (e) {
    console.error('debug-fetch error:', e.message);
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('form-checker running'));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
