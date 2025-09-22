// index.js
// Simple Express app: GET /check?key=SECRET
// Reads env vars for configuration. Writes state.json locally.

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
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'form-checker/1.0' },
    timeout: 20000
  });
  return res.data;
}

function parseAccepting(html) {
  // Heuristic: look for phrases that indicate closed form
  const $ = cheerio.load(html);
  const text = $('body').text().toLowerCase();
  const closedPhrases = [
    'no longer accepting responses',
    'not accepting responses',
    'responses are no longer being accepted',
    'this form is no longer accepting responses'
  ];
  for (const p of closedPhrases) {
    if (text.includes(p)) return false;
  }

  // If page lacks obvious submit/send word, likely closed (heuristic)
  if (!text.includes('submit') && !text.includes('send') && !text.includes('response')) {
    return false;
  }
  return true; // default to accepting
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true
  });
}

// main route: called by cron-job.org every 2 minutes
app.get('/check', async (req, res) => {
  try {
    const key = req.query.key || '';
    if (!key || key !== SECRET_KEY) {
      return res.status(401).send('unauthorized');
    }

    const state = loadState();
    let html;
    try {
      html = await fetchFormHtml(FORM_URL);
    } catch (err) {
      // fetch failed; respond 500 but don't change state
      console.error('fetch error', err.message);
      return res.status(502).send('failed to fetch form');
    }

    const accepting = parseAccepting(html);
    const now = new Date().toISOString();
    const changed = state.accepting === null ? false : (accepting && state.accepting === false);

    // Update and persist state
    const newState = { accepting, last_checked: now };
    saveState(newState);

    if (changed) {
      const msg = `✅ Google Form activated\n${FORM_URL}\nChecked at: ${now}`;
      try {
        await sendTelegramMessage(msg);
        console.log('Notified via Telegram');
      } catch (e) {
        console.error('Telegram send error', e.message);
      }
    } else {
      console.log(`${now} accepting=${accepting} (no notify)`);
    }

    return res.send({ ok: true, accepting, last_checked: now });
  } catch (e) {
    console.error('unexpected', e);
    return res.status(500).send('internal error');
  }
});

app.get('/', (req, res) => res.send('form-checker running'));

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
