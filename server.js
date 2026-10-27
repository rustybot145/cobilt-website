// Cobilt website: serves /public and runs the waitlist with a 6-digit email code.
//
//   POST /api/waitlist         { email, name, location } → emails a code (always answers { status: "pending" })
//   POST /api/waitlist/verify  { email, code }           → confirms, returns { name, email, position }
//
// Nothing about a signup is revealed or changed without the right code.
//
// Storage: Supabase when SUPABASE_URL + SUPABASE_SECRET_KEY are set (see supabase/waitlist.sql),
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
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set when running behind a proxy/host that sets X-Forwarded-For
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data', 'waitlist.json');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/(rest\/v1\/?)?$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || ''; // server-only; never sent to browsers
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Cobilt <hello@getcobilt.app>';

if (SUPABASE_SECRET_KEY.startsWith('sb_publishable_')) {
  console.error('SUPABASE_SECRET_KEY is a publishable key. Use the secret key (sb_secret_…).');
  process.exit(1);
}

const MAX_BODY = 10_000; // bytes
const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000 }; // API calls per IP
const CODE_MINUTES = 10; // codes expire after this
const MAX_TRIES = 5; // wrong codes allowed per code
const RESEND_AFTER_MS = 60 * 1000; // at most one code email per address per minute…
const MAX_EMAILS_PER_DAY = 5; // …and this many per address per 24 hours
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
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', // ignored on plain http (localhost)
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
  const headers = { apikey: SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' };
  if (!SUPABASE_SECRET_KEY.startsWith('sb_')) headers.Authorization = `Bearer ${SUPABASE_SECRET_KEY}`; // legacy service_role JWT
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
    return row.status;
  },
  async verify(email, codeHash) {
    const [row] = await rpc('verify_waitlist', { p_email: email, p_code_hash: codeHash });
    return { result: row.result, name: row.joined_name, position: row.spot == null ? null : Number(row.spot), triesLeft: row.tries_left };
  },
};

/* ---------- Storage: local file (testing) ---------- */
// Same rules as the SQL functions in supabase/waitlist.sql.

function loadFile() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; }
}

// Write to a temp file, then rename, so a crash mid-write can't corrupt the list.
function saveFile(list) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = `${DATA}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA);
}

// Spot in line among confirmed signups, ordered by when they confirmed.
const spotIn = (list, entry) => list.filter((e) => e.confirmedAt && e.confirmedAt <= entry.confirmedAt).length;
const iso = (ms) => new Date(ms).toISOString();

const fileStore = {
  label: () => 'data/waitlist.json (local)',
  async start({ email, name, location, codeHash }) {
    const now = Date.now();
    const list = loadFile().filter((e) => e.confirmedAt || now - Date.parse(e.joinedAt) < PENDING_DAYS * 864e5);
    let entry = list.find((e) => e.email === email);

    if (entry && now - Date.parse(entry.emailSentAt) < RESEND_AFTER_MS) return 'wait';

    const newWindow = !entry || !entry.emailsWindowStart || now - Date.parse(entry.emailsWindowStart) >= 864e5;
    if (entry && !newWindow && entry.emailsSentCount >= MAX_EMAILS_PER_DAY) return 'limited';

    if (!entry) {
      entry = { email, name, location, perkMonths: PERK_MONTHS, joinedAt: iso(now), confirmedAt: null };
      list.push(entry);
    } else if (!entry.confirmedAt) {
      Object.assign(entry, { name, location }); // confirmed details can't be changed this way
    }
    Object.assign(entry, {
      codeHash, codeAttempts: 0,
      codeExpiresAt: iso(now + CODE_MINUTES * 6e4),
      emailSentAt: iso(now),
      emailsSentCount: newWindow ? 1 : entry.emailsSentCount + 1,
      emailsWindowStart: newWindow ? iso(now) : entry.emailsWindowStart,
    });
    saveFile(list);
    return 'send';
  },
  async verify(email, codeHash) {
    const list = loadFile();
    const entry = list.find((e) => e.email === email);
    if (!entry || !entry.codeHash || Date.parse(entry.codeExpiresAt) <= Date.now() || entry.codeAttempts >= MAX_TRIES) {
      return { result: 'expired' };
    }
    if (entry.codeHash !== codeHash) {
      entry.codeAttempts += 1;
      saveFile(list);
      return { result: 'wrong', triesLeft: MAX_TRIES - entry.codeAttempts };
    }
    Object.assign(entry, { confirmedAt: entry.confirmedAt || iso(Date.now()), codeHash: null, codeExpiresAt: null, codeAttempts: 0 });
    saveFile(list);
    return { result: 'ok', name: entry.name, position: spotIn(list, entry) };
  },
};

const store = SUPABASE_URL && SUPABASE_SECRET_KEY ? supabaseStore : fileStore;

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
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Resolves to a plain object (anything else becomes {}), rejects when too large.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      resolve(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
    });
    req.on('error', reject);
  });
}

const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress;
}

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
  if (rateLimited(clientIp(req))) {
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
  const status = await store.start({ email, name, location, codeHash: hashCode(email, code) });

  if (status === 'limited') {
    return send(res, 429, { error: 'Too many codes sent to this email today. Try again tomorrow.' });
  }
  if (status === 'send') {
    try { await sendCodeEmail(email, name, code); } catch (err) {
      console.error('Code email failed:', err.message);
      return send(res, 502, { error: "We couldn't send the email. Try again in a minute." });
    }
  }
  // Same answer whether the email is new, pending or already confirmed.
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

// Clean page addresses
const PAGES = { '/': 'index.html', '/joined': 'joined.html' };

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch {
    res.writeHead(400, SECURITY_HEADERS); return res.end('Bad request');
  }
  const file = path.join(PUBLIC, PAGES[urlPath] || path.normalize(urlPath));
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

const server = http.createServer((req, res) => {
  const route = req.method === 'POST' && ROUTES[req.url];
  if (route) {
    return route(req, res).catch((err) => {
      console.error(`${req.url} failed:`, err.message);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Try again.' });
    });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST' });
  res.end();
});

// Drop slow or stalled connections instead of holding them open.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;

server.listen(PORT, HOST, () => {
  console.log(`Cobilt website on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Waitlist storage: ${store.label()}`);
  console.log(`Code emails: ${RESEND_API_KEY ? `Resend, from ${EMAIL_FROM}` : 'not sent (codes printed here)'}`);
});
