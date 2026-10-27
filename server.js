// Cobilt website: serves /public and runs the waitlist with a 6-digit email code.
//
//   POST /api/waitlist         { email, name, location } → saves as pending, emails a code
//   POST /api/waitlist/verify  { email, code }           → confirms, returns { name, position }
//
// Storage: Supabase when SUPABASE_URL + SUPABASE_KEY are set (see supabase/waitlist.sql),
// otherwise data/waitlist.json for local testing.
// Email: Resend when RESEND_API_KEY is set, otherwise the code is printed to the console.
// No dependencies. Run: npm start   (settings in .env, see .env.example)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- Config ---------- */

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data', 'waitlist.json');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/(rest\/v1\/?)?$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''; // publishable/anon key only, never the secret key
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Cobilt <hello@getcobilt.app>';

const MAX_BODY = 10_000; // bytes
const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 }; // API calls per IP
const CODE_MINUTES = 10; // codes expire after this
const MAX_TRIES = 5; // wrong codes allowed before a new one is needed
const RESEND_AFTER_MS = 60 * 1000; // at most one code email per address per minute
const PENDING_DAYS = 7; // unconfirmed signups are deleted after this
const PERK_MONTHS = 2; // free months of Bolt AI promised to confirmed members

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style="--x:…" on scene bubbles
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE = /^\d{6}$/;
const COUNTRIES = new Set(JSON.parse(fs.readFileSync(path.join(PUBLIC, 'countries.json'), 'utf8')).map(([, name]) => name));

/* ---------- Codes ---------- */

const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
// Tied to the email so the same code for two people never hashes the same.
const hashCode = (email, code) => crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');

/* ---------- Storage: Supabase ---------- */

async function rpc(fn, args) {
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (!SUPABASE_KEY.startsWith('sb_')) headers.Authorization = `Bearer ${SUPABASE_KEY}`; // legacy anon JWT
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Supabase ${fn} ${res.status}: ${await res.text()}`);
  return res.json();
}

const supabaseStore = {
  label: () => `Supabase (${new URL(SUPABASE_URL).host})`,
  async start({ email, name, location, codeHash }) {
    const [row] = await rpc('join_waitlist', { p_email: email, p_name: name, p_location: location, p_code_hash: codeHash });
    return { status: row.status, position: row.spot == null ? null : Number(row.spot), sendEmail: row.send_email };
  },
  async verify(email, codeHash) {
    const [row] = await rpc('verify_waitlist', { p_email: email, p_code_hash: codeHash });
    return { result: row.result, name: row.joined_name, position: row.spot == null ? null : Number(row.spot), triesLeft: row.tries_left };
  },
};

/* ---------- Storage: local file (testing) ---------- */

function loadFile() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; }
}

// Write to a temp file, then rename, so a crash mid-write can't corrupt the list.
function saveFile(list) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = `${DATA}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA);
}

// Spot in line among confirmed signups, ordered by when they confirmed.
const spotIn = (list, entry) => list.filter((e) => e.confirmedAt && e.confirmedAt <= entry.confirmedAt).length;

const fileStore = {
  label: () => 'data/waitlist.json (local)',
  async start({ email, name, location, codeHash }) {
    const now = Date.now();
    const list = loadFile().filter((e) => e.confirmedAt || now - Date.parse(e.joinedAt) < PENDING_DAYS * 864e5);
    let entry = list.find((e) => e.email === email);

    if (entry?.confirmedAt) {
      Object.assign(entry, { name, location, updatedAt: new Date(now).toISOString() });
      saveFile(list);
      return { status: 'confirmed', position: spotIn(list, entry), sendEmail: false };
    }
    if (entry && now - Date.parse(entry.emailSentAt) < RESEND_AFTER_MS) {
      return { status: 'pending', position: null, sendEmail: false };
    }

    if (!entry) {
      entry = { email, perkMonths: PERK_MONTHS, joinedAt: new Date(now).toISOString(), confirmedAt: null };
      list.push(entry);
    }
    Object.assign(entry, {
      name, location, codeHash, codeAttempts: 0,
      codeExpiresAt: new Date(now + CODE_MINUTES * 6e4).toISOString(),
      emailSentAt: new Date(now).toISOString(),
    });
    saveFile(list);
    return { status: 'pending', position: null, sendEmail: true };
  },
  async verify(email, codeHash) {
    const list = loadFile();
    const entry = list.find((e) => e.email === email);
    if (!entry) return { result: 'expired' };
    if (!entry.confirmedAt) {
      if (!entry.codeHash || Date.parse(entry.codeExpiresAt) <= Date.now() || entry.codeAttempts >= MAX_TRIES) {
        return { result: 'expired' };
      }
      if (entry.codeHash !== codeHash) {
        entry.codeAttempts += 1;
        saveFile(list);
        return { result: 'wrong', triesLeft: MAX_TRIES - entry.codeAttempts };
      }
      Object.assign(entry, { confirmedAt: new Date().toISOString(), codeHash: null, codeExpiresAt: null });
      saveFile(list);
    }
    return { result: 'ok', name: entry.name, position: spotIn(list, entry) };
  },
};

const store = SUPABASE_URL && SUPABASE_KEY ? supabaseStore : fileStore;

/* ---------- Email ---------- */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function codeEmail(name, code) {
  const first = name.split(' ')[0];
  const text = `Hi ${first},

Your Cobilt code is ${code}

Enter it on the site to confirm your spot on the waitlist and lock in 2 months of Bolt AI free.
It expires in ${CODE_MINUTES} minutes. If you didn't sign up, ignore this email.

Cobilt. Don't build alone.`;

  const html = `<!doctype html><html><body style="margin:0;background:#07061A;font-family:Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07061A;padding:40px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#100E33;border-radius:20px;padding:36px 32px;">
<tr><td style="color:#F4F3FF;font-size:22px;font-weight:800;letter-spacing:-0.5px;padding-bottom:24px;">cobilt</td></tr>
<tr><td style="color:#F4F3FF;font-size:24px;font-weight:800;line-height:1.2;letter-spacing:-0.5px;padding-bottom:10px;">Here's your code, ${escapeHtml(first)}.</td></tr>
<tr><td style="color:#B9B7D6;font-size:16px;line-height:1.5;padding-bottom:24px;">Enter it on the site to confirm your spot.</td></tr>
<tr><td style="padding-bottom:24px;"><div style="display:inline-block;background:#07061A;border-radius:14px;padding:16px 24px;color:#F4F3FF;font-size:34px;font-weight:800;letter-spacing:10px;font-family:Menlo,Consolas,monospace;">${code}</div></td></tr>
<tr><td style="color:#8A88AD;font-size:13px;line-height:1.5;">Expires in ${CODE_MINUTES} minutes. If you didn't sign up, ignore this email.</td></tr>
</table>
</td></tr></table></body></html>`;

  // Code first in the subject so phones can offer it for autofill.
  return { subject: `${code} is your Cobilt code`, text, html };
}

async function sendCodeEmail(to, name, code) {
  if (!RESEND_API_KEY) {
    console.log(`[no RESEND_API_KEY] Code for ${to}: ${code}`);
    return;
  }
  const { subject, text, html } = codeEmail(name, code);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

/* ---------- Helpers ---------- */

function send(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const hits = new Map(); // ip -> timestamps of recent API calls
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear(); // keep memory bounded
  return recent.length > RATE_LIMIT.max;
}

// Shared checks for every API call; returns the parsed body, or null after replying.
async function apiBody(req, res) {
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    send(res, 415, { error: 'Send JSON.' }); return null;
  }
  if (rateLimited(req.socket.remoteAddress)) {
    send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' }); return null;
  }
  try { return await readBody(req); } catch { send(res, 413, { error: 'That was too long.' }); return null; }
}

/* ---------- API ---------- */

async function joinWaitlist(req, res) {
  const body = await apiBody(req, res);
  if (!body) return;

  const email = clean(body.email, 254).toLowerCase();
  const name = clean(body.name, 80);
  const location = clean(body.location, 100);

  if (!EMAIL.test(email)) return send(res, 400, { error: 'Enter an email like name@domain.com.' });
  if (name.length < 2) return send(res, 400, { error: 'Enter your name.' });
  if (!COUNTRIES.has(location)) return send(res, 400, { error: 'Choose your country.' });

  const code = newCode();
  const result = await store.start({ email, name, location, codeHash: hashCode(email, code) });

  if (result.status === 'confirmed') return send(res, 200, { status: 'confirmed', position: result.position });
  if (result.sendEmail) {
    try { await sendCodeEmail(email, name, code); } catch (err) {
      console.error('Code email failed:', err.message);
      return send(res, 502, { error: "We couldn't send the email. Try again in a minute." });
    }
  }
  send(res, 202, { status: 'pending' });
}

async function verifyWaitlist(req, res) {
  const body = await apiBody(req, res);
  if (!body) return;

  const email = clean(body.email, 254).toLowerCase();
  const code = clean(body.code, 6);
  if (!EMAIL.test(email) || !CODE.test(code)) return send(res, 400, { error: 'Enter the 6-digit code.' });

  const r = await store.verify(email, hashCode(email, code));
  if (r.result === 'ok') return send(res, 200, { name: r.name, email, position: r.position });
  if (r.result === 'wrong') {
    return send(res, 400, { error: r.triesLeft > 0
      ? `That code isn't right. ${r.triesLeft} ${r.triesLeft === 1 ? 'try' : 'tries'} left.`
      : 'Too many wrong codes. Tap Resend code for a new one.' });
  }
  send(res, 410, { error: 'That code expired. Tap Resend code for a new one.' });
}

/* ---------- Static files ---------- */

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch {
    res.writeHead(400, SECURITY_HEADERS); return res.end('Bad request');
  }
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : path.normalize(urlPath));
  if (urlPath.includes('\0') || !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden');
  }
  const type = TYPES[path.extname(file)];
  if (!type) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ---------- Server ---------- */

const ROUTES = {
  '/api/waitlist': joinWaitlist,
  '/api/waitlist/verify': verifyWaitlist,
};

http.createServer((req, res) => {
  const route = req.method === 'POST' && ROUTES[req.url];
  if (route) {
    return route(req, res).catch((err) => {
      console.error(`${req.url} failed:`, err.message);
      send(res, 500, { error: 'Something went wrong. Try again.' });
    });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST' });
  res.end();
}).listen(PORT, HOST, () => {
  console.log(`Cobilt website on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Waitlist storage: ${store.label()}`);
  console.log(`Code emails: ${RESEND_API_KEY ? `Resend, from ${EMAIL_FROM}` : 'not sent (codes printed here)'}`);
});
