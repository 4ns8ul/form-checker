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
const SECRET_KEY = process.env.SECRET_KEY; // required in query param ?key=...
const STATE_FILE = path.join(__dirname, 'state.json');
const DEBUG_HTML_FILE = path.join(__dirname, 'last_html_debug.html');

if (!FORM_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !SECRET_KEY) {
  console.error('Missing required env vars. See .env.example');
  process.exit(1);
}

const app = express();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { accepting: null, last_checked: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchFormHtml(url) {
  // set browser-like headers to reduce chance of being served a login/blocked page
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  };
  const res = await axios.get(url, { headers, timeout: 20000, maxRedirects: 5 });
  return res.data;
}

function parseAccepting(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  // explicit closed phrases (common)
  const closedPhrases = [
    'no longer accepting responses',
    'not accepting responses',
    'responses are no longer being accepted',
    'this form is no longer accepting responses'
  ];
  for (const p of closedPhrases) {
    if (bodyText.includes(p)) {
      return { accepting: false, reason: `matched phrase: "${p}"` };
    }
  }

  // If we detect a Google sign-in form or a "Sign in" prompt, treat as inaccessible (not accepting)
  const signInIndicators = ['accounts.google.com/signin', 'sign in to continue', 'sign in', 'access denied', 'you need permission'];
  for (const s of signInIndicators) {
    if (bodyText.includes(s)) {
      return { accepting: false, reason: `blocked/sign-in detected: "${s}"` };
    }
  }

  // Heuristic: presence of form controls / "submit" button / "Send" text
  if (bodyText.includes('submit') || bodyText.includes('send') || bodyText.includes('response') || $('form').length > 0) {
    return { accepting: true, reason: 'found form controls / submit / response text' };
  }

  // fallback: assume closed
  return { accepting: false, reason: 'fallback: no indicators of accepting responses' };
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  const res = await axios.post(url, payload, { timeout: 15000 });
  return res.data;
}

// main route: called by cron-job.org locally or remote
app.get('/check', async (req, res) => {
  try {
    const key = req.query.key || '';
    if (!key || key !== SECRET_KEY) return res.status(401).send('unauthorized');

    const force = req.query.force === '1';
    const state = loadState();

    let html;
    try {
      html = await fetchFormHtml(FORM_URL);
      fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');
    } catch (err) {
      console.error('fetch error:', err.message);
      return res.status(502).send({ ok: false, error: 'failed to fetch form', details: err.message });
    }

    const parsed = parseAccepting(html);
    const accepting = !!parsed.accepting;
    const reason = parsed.reason || '';
    const now = new Date().toISOString();

    // Determine whether the form transitioned from closed to open
    const changed = (state.accepting === null) ? false : (accepting && state.accepting === false);
    // Update and persist state
    const newState = { accepting, last_checked: now };
    saveState(newState);

    console.log(`${now} - fetched form (len=${html.length}) - accepting=${accepting} - reason=${reason} - previous=${state.accepting} - changed=${changed} - force=${force}`);

    if ((changed && accepting) || force) {
      const msg = `✅ Google Form activated\n${FORM_URL}\nChecked at: ${now}\nreason: ${reason}`;
      try {
        const apiRes = await sendTelegramMessage(msg);
        console.log('Telegram send ok', apiRes.ok);
        return res.send({ ok: true, notified: true, accepting, reason, last_checked: now });
      } catch (e) {
        console.error('Telegram send error', e.response?.data || e.message);
        return res.status(500).send({ ok: false, error: 'telegram send failed', details: e.response?.data || e.message });
      }
    }

    return res.send({ ok: true, notified: false, accepting, reason, last_checked: now });
  } catch (e) {
    console.error('unexpected', e);
    return res.status(500).send({ ok: false, error: 'internal error', details: e.message });
  }
});

// debug - test telegram only
app.get('/test-telegram', async (req, res) => {
  try {
    const result = await sendTelegramMessage(`✅ test-telegram OK at ${new Date().toISOString()}`);
    return res.send({ ok: true, result });
  } catch (e) {
    console.error('test-telegram error', e.response?.data || e.message);
    return res.status(500).send({ ok: false, error: e.response?.data || e.message });
  }
});

// debug fetch - saves last_html_debug.html and returns parse result
app.get('/debug-fetch', async (req, res) => {
  try {
    const key = req.query.key || '';
    if (!key || key !== SECRET_KEY) return res.status(401).send('unauthorized');

    const html = (await fetchFormHtml(FORM_URL));
    fs.writeFileSync(DEBUG_HTML_FILE, html, 'utf8');

    const parsed = parseAccepting(html);
    console.log('/debug-fetch parsed:', parsed);
    return res.send({ ok: true, parsed, length: html.length });
  } catch (e) {
    console.error('debug-fetch error', e.message);
    return res.status(500).send({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.send('form-checker running'));
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
