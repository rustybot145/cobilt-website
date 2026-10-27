// Cobilt website: serves /public and stores waitlist signups (email, name, location)
// in data/waitlist.json. No dependencies.
// Run: node server.js   (env: PORT, default 4321; HOST, default 127.0.0.1)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data', 'waitlist.json');

const MAX_BODY = 10_000; // bytes
const RATE_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 }; // signups per IP
const PERK_MONTHS = 2; // free months of Bolt AI promised to waitlist members

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
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

/* ---------- Storage ---------- */

function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; }
}

// Write to a temp file, then rename, so a crash mid-write can't corrupt the list.
function save(list) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = `${DATA}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DATA);
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

const hits = new Map(); // ip -> timestamps of recent signups
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear(); // keep memory bounded
  return recent.length > RATE_LIMIT.max;
}

/* ---------- API ---------- */

async function joinWaitlist(req, res) {
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    return send(res, 415, { error: 'Send JSON.' });
  }
  if (rateLimited(req.socket.remoteAddress)) {
    return send(res, 429, { error: 'Too many tries. Wait a few minutes and try again.' });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 413, { error: 'That was too long.' }); }

  const email = clean(body.email, 254).toLowerCase();
  const name = clean(body.name, 80);
  const location = clean(body.location, 100);

  if (!EMAIL.test(email)) return send(res, 400, { error: 'Enter an email like name@domain.com.' });
  if (name.length < 2) return send(res, 400, { error: 'Enter your name.' });
  if (location.length < 2) return send(res, 400, { error: 'Enter your city or country.' });

  const list = load();
  const i = list.findIndex((e) => e.email === email);
  if (i !== -1) {
    // Same email again: keep their spot, update their details
    Object.assign(list[i], { name, location, updatedAt: new Date().toISOString() });
    save(list);
    return send(res, 200, { position: i + 1, existing: true });
  }

  list.push({ email, name, location, perkMonths: PERK_MONTHS, joinedAt: new Date().toISOString() });
  save(list);
  send(res, 201, { position: list.length });
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

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/waitlist') {
    return joinWaitlist(req, res).catch(() => send(res, 500, { error: 'Something went wrong. Try again.' }));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD, POST' });
  res.end();
}).listen(PORT, HOST, () => console.log(`Cobilt website on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
