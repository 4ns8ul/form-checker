require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

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
console.log('FORM_URL present:', !!FORM_URL);
console.log('TELEGRAM_BOT_TOKEN set:', !!TELEGRAM_BOT_TOKEN);
console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : '(not set)');
console.log('SECRET_KEY set:', !!SECRET_KEY);
console.log('FORCE_NOTIFY_ENV:', FORCE_NOTIFY_ENV);

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

/* ---------- fetch & parse ---------- */
async function fetchHtml(url) {
  console.log('Fetching URL:', url);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
  const res = await axios.get(url, { headers, timeout: 20000, maxRedirects: 5 });
  console.log('Fetched length:', res.data.length);
  return res.data;
}

function parseAcceptingFromHtml(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  const closedPhrases = [
    'no longer accepting responses',
    'not accepting responses',
    'responses are no longer being accepted',
    'this form is no longer accepting responses',
    'is no longer accepting form responses'
  ];
  for (const p of closedPhrases) {
    if (bodyText.includes(p)) return { accepting: false, reason: `matched-closed: "${p}"` };
  }

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

  if (bodyText.includes('submit') || bodyText.includes('send') || bodyText.includes('response') || $('form').length > 0) {
    return { accepting: true, reason: 'found-form-controls' };
  }

  return { accepting: false, reason: 'fallback-no-indicator' };
}

/* ---------- alternate fetch attempts (heuristics) ---------- */
function buildAlternativeUrls(formUrl) {
  // Try variants commonly used to reveal the form
  const variants = [];
  // original
  variants.push(formUrl);
  // try adding usp params
  variants.push(formUrl + '?usp=sf_link');
  variants.push(formUrl + '?usp=pp_url');
  variants.push(formUrl + '&embedded=true');
  // sometimes e/ id form link pattern - try /e/ path if original is /d/
  const m = formUrl.match(/\/forms\/d\/(?:e\/)?([^\/\?]+)/);
  if (m && m[1]) {
    const id = m[1];
    variants.push(`https://docs.google.com/forms/d/e/${id}/viewform`);
    variants.push(`https://docs.google.com/forms/d/${id}/viewform`);
    variants.push(`https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`);
  }
  // dedupe
  return [...new Set(variants)];
}

async function tryAlternativeFetches(formUrl) {
  const urls = buildAlternativeUrls(formUrl);
  console.log('Trying alternative URLs:', urls);
  for (const u of urls) {
    try {
      const html = await fetchHtml(u);
      // quick parse check
      const parsed = parseAcceptingFromHtml(html);
      console.log('Alt parse for', u, '=>', parsed);
      if (parsed.accepting) {
        // save debug html for inspection
        try { fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8'); } catch (e) {}
        return parsed;
      }
      // if we hit something that's not sign-in and not closed but ambiguous, keep trying
    } catch (e) {
      console.warn('Alt fetch error for', u, e.message);
      // continue trying other URLs
    }
  }
  return null;
}

/* ---------- Telegram helper ---------- */
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  console.log('Sending Telegram...');
  try {
    const res = await axios.post(url, payload, { timeout: 15000 });
    console.log('Telegram ok:', !!res.data.ok);
    try {
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push({ at: new Date().toISOString(), ok: !!res.data.ok, response: res.data });
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2));
    } catch (e) { console.error('write log fail', e.message); }
    return res.data;
  } catch (err) {
    const errBody = err.response ? err.response.data : { message: err.message };
    console.error('Telegram error:', errBody);
    try {
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push({ at: new Date().toISOString(), ok: false, error: errBody });
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2));
    } catch (e) {}
    throw err;
  }
}

/* ---------- helper to extract form id ---------- */
function extractFormId(url) {
  const m = url.match(/\/forms\/d\/(?:e\/)?([^\/\?]+)/);
  return m ? m[1] : null;
}

/* ---------- main route ---------- */
app.get('/check', async (req, res) => {
  console.log('=== /check called ===', new Date().toISOString());
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) {
    console.warn('Unauthorized request, providedKey:', providedKey ? providedKey.substring(0,12) + '...' : '(empty)');
    return res.status(401).send('unauthorized');
  }

  const forceQuery = req.query.force === '1';
  console.log('forceQuery:', forceQuery, 'FORCE_NOTIFY_ENV:', FORCE_NOTIFY_ENV);

  const prev = loadState();

  // Primary fetch attempt
  let html = null;
  let parsed = null;
  try {
    html = await fetchHtml(FORM_URL);
    try { fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8'); } catch (e) {}
    parsed = parseAcceptingFromHtml(html);
    console.log('Primary parse result:', parsed);
  } catch (e) {
    console.error('Primary fetch error:', e.message);
    return res.status(502).send({ ok: false, notified: false, error: 'failed to fetch primary form url', details: e.message });
  }

  // If primary parse says sign-in/blocked, try alternative URLs
  if (parsed && parsed.reason && parsed.reason.startsWith('blocked-signin')) {
    console.log('Primary parse detected sign-in. Attempting alternative fetches...');
    const altParsed = await tryAlternativeFetches(FORM_URL);
    if (altParsed) {
      // We found an alternative that shows accepting=true
      parsed = altParsed;
      console.log('Alternative fetch succeeded and shows accepting=true');
    } else {
      // still blocked: here is the change requested:
      // If previously closed, still send a STATUS notification (caveated) and mark state as accepting=true
      // so you get a one-time status message.
      if (prev.accepting === false || prev.accepting === null) {
        const now = new Date().toISOString();
        const statusMsg = `ℹ️ Google Form status: POSSIBLY ACTIVE (blocked view)\n${FORM_URL}\nChecked at: ${now}\nNote: server fetch returned a sign-in/blocked page; cannot fully verify content.`;
        try {
          console.log('Sending STATUS notification despite blocked view (as requested).');
          await sendTelegramMessage(statusMsg);
        } catch (e) {
          console.error('Failed to send status telegram:', e.response?.data || e.message);
          // do not crash; return error to caller
          return res.status(500).send({ ok: false, notified: false, error: 'telegram_send_failed', details: e.response?.data || e.message });
        }
        // Mark state as accepting to avoid repeat notifications until a real close happens.
        saveState({ accepting: true, last_checked: now });
        return res.send({ ok: true, notified: true, accepting: true, reason: 'blocked-signin-status-sent', last_checked: now });
      } else {
        // already previously considered accepting, do not send again
        const now = new Date().toISOString();
        saveState({ accepting: true, last_checked: now });
        return res.send({ ok: true, notified: false, accepting: true, reason: 'blocked-signin-no-change', last_checked: now });
      }
    }
  }

  // If parse indicates closed phrases explicitly, do not notify
  if (parsed && parsed.reason && parsed.reason.startsWith('matched-closed')) {
    console.warn('Detected explicit closed phrase. Not notifying.');
    const now = new Date().toISOString();
    saveState({ accepting: false, last_checked: now });
    return res.send({ ok: true, notified: false, accepting: false, reason: parsed.reason, last_checked: now });
  }

  // Normal flow: parsed.accepting true/false
  const accepting = !!parsed.accepting;
  const reason = parsed.reason || '';
  const now = new Date().toISOString();
  const changed = (prev.accepting === null) ? false : (accepting && prev.accepting === false);
  console.log('Final parsed:', parsed, 'prev:', prev, 'changed:', changed);

  // save new state
  saveState({ accepting, last_checked: now });

  // decide to notify: only on closed->open transition or forced testing
  const shouldNotify = (changed && accepting) || (forceQuery && FORCE_NOTIFY_ENV);
  console.log('shouldNotify:', shouldNotify);

  if (!shouldNotify) {
    return res.send({ ok: true, notified: false, accepting, reason, last_checked: now });
  }

  const msg = `✅ Google Form activated\n${FORM_URL}\nChecked at: ${now}\nreason: ${reason}`;
  try {
    const tRes = await sendTelegramMessage(msg);
    return res.send({ ok: true, notified: true, accepting, reason, last_checked: now, telegram: tRes });
  } catch (e) {
    console.error('Telegram send failed:', e.response?.data || e.message);
    return res.status(500).send({ ok: false, notified: false, error: 'telegram_send_failed', details: e.response?.data || e.message });
  }
});

/* ---------- debug endpoints ---------- */
app.get('/test-telegram', async (req, res) => {
  try {
    const r = await sendTelegramMessage(`✅ test-telegram OK at ${new Date().toISOString()}`);
    return res.send({ ok: true, result: r });
  } catch (e) {
    return res.status(500).send({ ok: false, error: e.response?.data || e.message });
  }
});

app.get('/debug-fetch', async (req, res) => {
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) return res.status(401).send('unauthorized');

  // try primary
  try {
    const html = await fetchHtml(FORM_URL);
    fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    const parsed = parseAcceptingFromHtml(html);
    return res.send({ ok: true, parsed, via: 'primary', length: html.length });
  } catch (e) {
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('form-checker running'));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
