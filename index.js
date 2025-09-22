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

console.log("=== form-checker start ===");
console.log("FORM_URL:", !!FORM_URL);
console.log("TELEGRAM_BOT_TOKEN set:", !!TELEGRAM_BOT_TOKEN);
console.log("TELEGRAM_CHAT_ID:", TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : '(not set)');
console.log("SECRET_KEY set:", !!SECRET_KEY);
console.log("FORCE_NOTIFY_ENV:", FORCE_NOTIFY_ENV);

if (!FORM_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SECRET_KEY) {
  console.error('❌ Missing required env vars. See .env.example');
  process.exit(1);
}

const app = express();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const s = JSON.parse(raw);
    console.log('Loaded state:', s);
    return s;
  } catch (e) {
    console.log('No state file found — starting fresh.');
    return { accepting: null, last_checked: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('Saved state:', state);
}

async function fetchFormHtml(url) {
  console.log('Fetching form HTML:', url);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
  const res = await axios.get(url, { headers, timeout: 20000, maxRedirects: 5 });
  console.log('Fetched HTML length:', res.data.length);
  return res.data;
}

function parseAccepting(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  const closedPhrases = [
    'no longer accepting responses',
    'not accepting responses',
    'responses are no longer being accepted',
    'this form is no longer accepting responses'
  ];
  for (const p of closedPhrases) {
    if (bodyText.includes(p)) return { accepting: false, reason: `matched phrase: "${p}"` };
  }

  const signInIndicators = ['accounts.google.com/signin', 'sign in to continue', 'sign in', 'access denied', 'you need permission'];
  for (const s of signInIndicators) {
    if (bodyText.includes(s)) return { accepting: false, reason: `blocked/sign-in detected: "${s}"` };
  }

  if (bodyText.includes('submit') || bodyText.includes('send') || bodyText.includes('response') || $('form').length > 0) {
    return { accepting: true, reason: 'found form controls / submit / response text' };
  }

  return { accepting: false, reason: 'fallback: no indicators of accepting responses' };
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  console.log('Calling Telegram API...', url);
  try {
    const res = await axios.post(url, payload, { timeout: 15000 });
    console.log('TELEGRAM API RESPONSE:', JSON.stringify(res.data));
    // append to telegram_log.json
    try {
      const entry = { at: new Date().toISOString(), ok: res.data.ok, payload: payload, response: res.data };
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push(entry);
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2)); // keep last 200
      console.log('Wrote telegram_log.json (tail).');
    } catch (e) {
      console.error('Failed to write telegram_log.json:', e.message);
    }
    return res.data;
  } catch (err) {
    const errBody = err.response ? err.response.data : { message: err.message };
    console.error('TELEGRAM API ERROR:', JSON.stringify(errBody));
    // write error to telegram_log as well
    try {
      const entry = { at: new Date().toISOString(), ok: false, payload: payload, error: errBody };
      const arr = fs.existsSync(TELEGRAM_LOG) ? JSON.parse(fs.readFileSync(TELEGRAM_LOG, 'utf8')) : [];
      arr.push(entry);
      fs.writeFileSync(TELEGRAM_LOG, JSON.stringify(arr.slice(-200), null, 2));
      console.log('Wrote telegram_log.json error entry.');
    } catch (e) {
      console.error('Failed to write telegram_log.json:', e.message);
    }
    throw err;
  }
}

app.get('/check', async (req, res) => {
  console.log('=== /check called ===', new Date().toISOString());
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) {
    console.warn('Unauthorized request, providedKey:', providedKey ? providedKey.substring(0,8) + '...' : '(empty)');
    return res.status(401).send('unauthorized');
  }

  const forceQuery = req.query.force === '1';
  console.log('forceQuery:', forceQuery, 'FORCE_NOTIFY_ENV:', FORCE_NOTIFY_ENV);

  const prevState = loadState();
  let html;
  try {
    html = await fetchFormHtml(FORM_URL);
    fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    console.log('Saved debug HTML to', DEBUG_HTML_FILE);
  } catch (e) {
    console.error('Fetch error:', e.message);
    return res.status(502).send({ ok: false, error: 'failed to fetch form', details: e.message });
  }

  const parsed = parseAccepting(html);
  const accepting = !!parsed.accepting;
  const reason = parsed.reason || '';
  const now = new Date().toISOString();
  const changed = (prevState.accepting === null) ? false : (accepting && prevState.accepting === false);

  console.log('Parsed result:', parsed, 'prevState:', prevState, 'changed:', changed);

  // If sign-in detected, do not notify unless FORCE_NOTIFY_ENV is true and forceQuery requested.
  if (reason && reason.toLowerCase().includes('sign-in')) {
    console.warn('Sign-in/blocked page detected. Reason:', reason);
    saveState({ accepting: false, last_checked: now });
    // if we explicitly force and have the env toggle, allow send for testing
    if (!(FORCE_NOTIFY_ENV && forceQuery)) {
      return res.send({ ok: true, notified: false, accepting: false, reason, last_checked: now });
    }
    console.log('FORCE_NOTIFY_ENV && forceQuery detected — proceeding to send despite sign-in reason (testing mode).');
  }

  // Update state
  const newState = { accepting, last_checked: now };
  saveState(newState);

  // Decide to notify
  const shouldNotify = (changed && accepting) || (forceQuery && FORCE_NOTIFY_ENV);
  console.log('shouldNotify:', shouldNotify);

  if (!shouldNotify) {
    return res.send({ ok: true, notified: false, accepting, reason, last_checked: now });
  }

  const msg = `✅ Google Form activated\n${FORM_URL}\nChecked at: ${now}\nreason: ${reason}`;
  try {
    const tRes = await sendTelegramMessage(msg);
    console.log('Telegram send result ok?', tRes.ok);
    return res.send({ ok: true, notified: true, accepting, reason, last_checked: now, telegram: tRes });
  } catch (e) {
    console.error('Telegram send failed:', e.response?.data || e.message);
    return res.status(500).send({ ok: false, error: 'telegram send failed', details: e.response?.data || e.message });
  }
});

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

app.get('/debug-fetch', async (req, res) => {
  console.log('=== /debug-fetch called ===');
  const providedKey = (req.query.key || req.headers['x-secret'] || '').toString();
  if (!providedKey || providedKey !== SECRET_KEY) {
    console.warn('Unauthorized /debug-fetch, providedKey:', providedKey ? providedKey.substring(0,8)+'...' : '(empty)');
    return res.status(401).send('unauthorized');
  }
  try {
    const html = await fetchFormHtml(FORM_URL);
    fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    const parsed = parseAccepting(html);
    console.log('/debug-fetch parsed:', parsed);
    return res.send({ ok: true, parsed, length: html.length });
  } catch (e) {
    console.error('debug-fetch error:', e.message);
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('form-checker running'));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
