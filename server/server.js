#!/usr/bin/env node
// ShowTrack sync server — zero dependencies (Node built-ins only).
// Holds each user's library and merges changes from every signed-in device
// (last-writer-wins by record `_t`). Also runs a periodic streaming-availability
// check so shows leaving a platform can be flagged even when the app is closed.
//
// Run:  node server.js           (defaults to port 8570, ./data)
// Env:  PORT, DATA_DIR

'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8570', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PAGE_LIMIT = 4000;          // records per pull page
const MAX_BODY = 8 * 1024 * 1024;  // 8 MB per request (client chunks ≤5000 records ≈ 1–2 MB)
const MAX_USERS = parseInt(process.env.MAX_USERS || '50', 10); // cap accounts (disk-fill DoS)
const AUTH_MAX = 20;              // auth attempts per IP per window (brute-force / signup flood)
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const KEY_FIELD = { shows: 'id', episodes: 'id', watched: 'epId', movies: 'id', watchlist: 'id', lists: 'id', kv: 'k' };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// ---------------- persistence ----------------

const webpush = require('./webpush.js');
const VAPID = webpush.loadOrCreateVapid(DATA_DIR);

const usersFile = path.join(DATA_DIR, 'users.json');
const tokensFile = path.join(DATA_DIR, 'tokens.json');
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJSON(f, obj) {
  const tmp = f + '.tmp';
  // owner-only: these files hold password hashes, session tokens, and personal data
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// Null-prototype maps: any client-controlled key (token, username, record id,
// kv key) can't reach inherited props like "toString"/"constructor", so a
// bogus token can't impersonate a user and a pushed id of "__proto__" can't
// pollute prototypes. readMap() loads a JSON object as one of these.
const nullMap = (src) => Object.assign(Object.create(null), src || {});
const readMap = (f) => nullMap(readJSON(f, {}));

let users = readMap(usersFile);     // username -> {salt, hash, createdAt}
let tokens = readMap(tokensFile);   // token -> username

// per-user in-memory state, lazily loaded
const cache = Object.create(null); // username -> state

function userDir(u) { return path.join(DATA_DIR, 'u_' + encodeURIComponent(u)); }

function loadUser(u) {
  if (cache[u]) return cache[u];
  const dir = userDir(u);
  const state = { records: Object.create(null), tombstones: Object.create(null), seq: 0, alerts: [], lastCheck: {} };
  for (const s of STORES) state.records[s] = readMap(path.join(dir, s + '.json'));
  const meta = readJSON(path.join(dir, 'meta.json'), { seq: 0, tombstones: {}, lastCheck: {} });
  state.seq = meta.seq || 0;
  state.lastCheck = meta.lastCheck || {};
  for (const s of STORES) state.tombstones[s] = nullMap(meta.tombstones && meta.tombstones[s]);
  state.alerts = readJSON(path.join(dir, 'alerts.json'), []);
  state.pushSubs = readJSON(path.join(dir, 'push.json'), []);
  cache[u] = state;
  return state;
}

function persistPush(u) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  writeJSON(path.join(dir, 'push.json'), cache[u].pushSubs || []);
}

function persistUser(u, changedStores) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  const st = cache[u];
  for (const s of changedStores || []) writeJSON(path.join(dir, s + '.json'), st.records[s]);
  writeJSON(path.join(dir, 'meta.json'), { seq: st.seq, tombstones: st.tombstones, lastCheck: st.lastCheck });
}
function persistAlerts(u) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  writeJSON(path.join(dir, 'alerts.json'), cache[u].alerts);
}

// ---------------- auth ----------------

function hashPw(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function register(username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw err(400, 'Username must be 3–32 chars: letters, numbers, . _ -');
  if (String(password || '').length < 6) throw err(400, 'Password must be at least 6 characters');
  if (users[username]) throw err(409, 'That username is taken');
  if (Object.keys(users).length >= MAX_USERS) throw err(403, 'This server has reached its account limit');
  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = { salt, hash: hashPw(password, salt), createdAt: Date.now() };
  writeJSON(usersFile, users);
  return newToken(username);
}
function login(username, password) {
  username = String(username || '').trim().toLowerCase();
  const u = users[username];
  if (!u) throw err(401, 'No such user');
  const h = hashPw(password, u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex')))
    throw err(401, 'Wrong password');
  return newToken(username);
}
function newToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens[token] = username; writeJSON(tokensFile, tokens);
  return token;
}
function userFor(token) {
  // token must be a string; null-proto `tokens` prevents inherited-key lookups
  const u = typeof token === 'string' ? tokens[token] : undefined;
  if (!u) throw err(401, 'Not signed in — sign in again');
  return u;
}

// ---------------- sync merge ----------------

// Apply a batch of records/deletes for one store. Returns true if anything changed.
function mergeBatch(u, store, records, deletes) {
  const st = loadUser(u);
  const recs = st.records[store], tombs = st.tombstones[store];
  const kf = KEY_FIELD[store];
  let changed = false;
  for (const r of records || []) {
    const id = r[kf];
    if (id == null) continue;
    const cur = recs[id], tomb = tombs[id];
    const t = r._t || 0;
    if (cur && (cur._t || 0) > t) continue;         // we have newer
    if (tomb && tomb._t > t) continue;              // deleted more recently
    r._seq = ++st.seq;
    recs[id] = r;
    if (tomb) delete tombs[id];
    changed = true;
  }
  for (const d of deletes || []) {
    const id = d.id != null ? d.id : d[kf];
    if (id == null) continue;
    const cur = recs[id], t = d._t || 0;
    if (cur && (cur._t || 0) > t) continue;         // resurrected more recently
    const tomb = tombs[id];
    if (tomb && tomb._t >= t) continue;
    if (cur) delete recs[id];
    // keep the original typed id (object keys stringify; clients need the real type)
    tombs[id] = { _t: t, _seq: ++st.seq, id };
    changed = true;
  }
  return changed;
}

// Collect changes with _seq > since across all stores, paginated.
function pullChanges(u, since) {
  const st = loadUser(u);
  const out = [];
  for (const s of STORES) {
    for (const id in st.records[s]) {
      const r = st.records[s][id];
      if ((r._seq || 0) > since) out.push({ kind: 'rec', store: s, seq: r._seq, rec: r });
    }
    for (const id in st.tombstones[s]) {
      const tb = st.tombstones[s][id];
      // tb.id preserves the original type (number vs string); fall back for old data
      if ((tb._seq || 0) > since) out.push({ kind: 'del', store: s, seq: tb._seq, id: tb.id != null ? tb.id : id, _t: tb._t });
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  const page = out.slice(0, PAGE_LIMIT);
  const more = out.length > PAGE_LIMIT;
  const records = {}, deletes = [];
  for (const c of page) {
    if (c.kind === 'rec') (records[c.store] = records[c.store] || []).push(c.rec);
    else deletes.push({ store: c.store, id: c.id, _t: c._t });
  }
  const nextSince = page.length ? page[page.length - 1].seq : since;
  return { records, deletes, nextSince, more, serverSeq: st.seq };
}

// ---------------- HTTP ----------------

function err(status, message) { const e = new Error(message); e.status = status; return e; }

// Simple per-IP rate limiter for auth routes (brute-force + signup flooding).
const authHits = new Map(); // ip -> { count, resetAt }
function rateLimitAuth(ip) {
  const now = Date.now();
  let e = authHits.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + AUTH_WINDOW_MS }; authHits.set(ip, e); }
  if (++e.count > AUTH_MAX) throw err(429, 'Too many attempts — wait a few minutes and try again');
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of authHits) if (now > e.resetAt) authHits.delete(ip); }, AUTH_WINDOW_MS).unref();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  // reject an oversized declared body before reading a single byte
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_BODY) return Promise.reject(err(413, 'Body too large'));
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; reject(err(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => { if (aborted) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(err(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}

const routes = {
  '/api/register': (b) => ({ token: register(b.username, b.password), username: String(b.username).trim().toLowerCase() }),
  '/api/login': (b) => ({ token: login(b.username, b.password), username: String(b.username).trim().toLowerCase() }),
  '/api/push': (b) => {
    const u = userFor(b.token);
    if (!STORES.includes(b.store)) throw err(400, 'Unknown store');
    const changed = mergeBatch(u, b.store, b.records, b.deletes);
    if (changed) persistUser(u, [b.store]);
    return { ok: true, seq: loadUser(u).seq };
  },
  '/api/pull': (b) => { const u = userFor(b.token); return pullChanges(u, b.since || 0); },
  '/api/scrobble': async (b) => {
    const u = userFor(b.token);
    const st = loadUser(u);
    const r = await require('./scrobble.js').handleScrobble(st, b, () => ++st.seq);
    if (r.ok) persistUser(u, ['shows', 'episodes', 'watched']);
    return r;
  },
  '/api/alerts': (b) => {
    const u = userFor(b.token);
    const st = loadUser(u);
    return { alerts: st.alerts, count: st.alerts.length };
  },
  '/api/alerts/clear': (b) => {
    const u = userFor(b.token); const st = loadUser(u);
    st.alerts = []; persistAlerts(u); return { ok: true };
  },
  '/api/vapid-public': (b) => { userFor(b.token); return { key: VAPID.publicKey }; },
  '/api/push-subscribe': (b) => {
    const u = userFor(b.token);
    if (!b.subscription || !b.subscription.endpoint) throw err(400, 'Bad subscription');
    if (!webpush.endpointLooksSafe(b.subscription.endpoint)) throw err(400, 'Push endpoint must be a public HTTPS address');
    const st = loadUser(u);
    st.pushSubs = (st.pushSubs || []).filter(s => s.endpoint !== b.subscription.endpoint);
    st.pushSubs.push(b.subscription);
    persistPush(u);
    return { ok: true };
  },
  '/api/push-unsubscribe': (b) => {
    const u = userFor(b.token); const st = loadUser(u);
    st.pushSubs = (st.pushSubs || []).filter(s => s.endpoint !== (b.endpoint || (b.subscription && b.subscription.endpoint)));
    persistPush(u);
    return { ok: true };
  },
};

// Static serving of the app itself, so app + API share one origin (no CORS,
// no mixed-content problem when fronted by HTTPS). App files live one dir up.
const APP_DIR = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); } // NUL -> fs.readFile throws synchronously (crash)
  if (rel === '/') rel = '/index.html';
  const full = path.normalize(path.join(APP_DIR, rel));
  // relative path must stay inside APP_DIR (no traversal) and outside server/
  const relCheck = path.relative(APP_DIR, full);
  const escapes = relCheck.startsWith('..') || path.isAbsolute(relCheck);
  const inServerDir = relCheck === 'server' || relCheck.startsWith('server' + path.sep);
  if (escapes || inServerDir) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/health')
    return send(res, 200, { ok: true, app: 'showtrack-sync', users: Object.keys(users).length });
  const route = routes[url];
  if (req.method === 'POST' && route) {
    try {
      if (url === '/api/register' || url === '/api/login') {
        // socket address can't be spoofed; only trust X-Forwarded-For behind a
        // proxy you control (set TRUST_PROXY=1, e.g. tailscale serve)
        const ip = (process.env.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',')[0].trim())
          || req.socket.remoteAddress || 'unknown';
        rateLimitAuth(ip);
      }
      send(res, 200, await route(await readBody(req)));
    }
    catch (e) { send(res, e.status || 500, { error: e.message || 'Server error' }); }
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res, url);
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`ShowTrack sync server on :${PORT}  data=${DATA_DIR}  users=${Object.keys(users).length}`);
});

// ---------------- background availability checks ----------------
require('./availability.js').schedule({
  loadUser, persistAlerts, persistUser, persistPush,
  listUsers: () => Object.keys(users),
  sendPush: (sub, payload) => webpush.sendNotification(sub, payload, VAPID),
});
