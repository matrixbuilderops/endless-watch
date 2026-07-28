#!/usr/bin/env node
// The Endless Watch sync server — zero dependencies (Node built-ins only).
// Holds each user's library and merges changes from every signed-in device
// (last-writer-wins by record `_t`). Also runs a periodic streaming-availability
// check so shows leaving a platform can be flagged even when the app is closed.
//
// Run:  node server.js           (defaults to 127.0.0.1:8570, ./data)
// Env:  PORT, HOST, DATA_DIR, ALLOW_ORIGIN, TRUST_PROXY, MAX_USERS

'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8570', 10);
// Loopback by default: `tailscale serve` (the documented setup) proxies to
// localhost, so nothing needs the server on a public interface. Set
// HOST=0.0.0.0 only if you reach it directly over the LAN.
const HOST = process.env.HOST || '127.0.0.1';
// The app and API share an origin in the documented setup, so CORS is not
// needed. Set ALLOW_ORIGIN to one origin (e.g. https://you.github.io) if you
// host the PWA elsewhere; it used to send '*', which let any site you happened
// to visit talk to this server.
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PAGE_LIMIT = 4000;          // records per pull page
const MAX_BODY = 8 * 1024 * 1024;  // 8 MB per request (client chunks ≤5000 records ≈ 1–2 MB)
const MAX_USERS = parseInt(process.env.MAX_USERS || '50', 10); // cap accounts (disk-fill DoS)
const MAX_CACHED_USERS = parseInt(process.env.MAX_CACHED_USERS || '4', 10); // libraries held in RAM
const AUTH_MAX = 20;              // auth attempts per IP per window (brute-force / signup flood)
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const CATALOG_MAX = parseInt(process.env.CATALOG_MAX || '60', 10); // catalog lookups per account per window
const CATALOG_WINDOW_MS = 60 * 1000;
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // sessions age out after ~6 months
const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // forget deletions after a year
const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const KEY_FIELD = { shows: 'id', episodes: 'id', watched: 'epId', movies: 'id', watchlist: 'id', lists: 'id', kv: 'k' };

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// ---------------- persistence ----------------

const webpush = require('./webpush.js');
const VAPID = webpush.loadOrCreateVapid(DATA_DIR);

// Owner-held API keys. Clients never see these; they call /api/catalog instead.
const catalog = require('./catalog.js');
const KEYS = catalog.loadKeys(DATA_DIR);

const usersFile = path.join(DATA_DIR, 'users.json');
const tokensFile = path.join(DATA_DIR, 'tokens.json');
const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
function writeJSON(f, obj) {
  const tmp = f + '.tmp';
  // owner-only: these files hold password hashes, session tokens, and personal data
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// ---- coalesced writes for the big per-user store files ----
// episodes.json alone is tens of MB, and one scrobble touches shows + episodes
// + watched + meta, so writing each synchronously rewrote ~30 MB and stalled the
// event loop for every marked episode. Queue the *live object* and serialize it
// once per flush, so a burst (a chunked upload, a scrobble) collapses into one
// write per file. users.json / tokens.json stay synchronous via writeJSON —
// auth state must never lag behind a response.
const WRITE_DELAY_MS = 400;
const pendingWrites = new Map(); // file -> () => object
let writeTimer = null, flushing = null;

function queueWrite(file, getObj) {
  pendingWrites.set(file, getObj);
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flushWrites(); }, WRITE_DELAY_MS);
  writeTimer.unref();
}

function flushWrites() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (pendingWrites.size) {
      const batch = [...pendingWrites];
      pendingWrites.clear();
      for (const [file, getObj] of batch) {
        try {
          const tmp = file + '.tmp';
          await fs.promises.writeFile(tmp, JSON.stringify(getObj()), { mode: 0o600 });
          await fs.promises.rename(tmp, file);
        } catch (e) { console.error('write failed', file, e.message); }
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// Shutdown / pre-eviction: land everything now, synchronously.
function flushWritesSync() {
  if (!pendingWrites.size) return;
  for (const [file, getObj] of pendingWrites) {
    try { writeJSON(file, getObj()); } catch (e) { console.error('write failed', file, e.message); }
  }
  pendingWrites.clear();
}
// Null-prototype maps: any client-controlled key (token, username, record id,
// kv key) can't reach inherited props like "toString"/"constructor", so a
// bogus token can't impersonate a user and a pushed id of "__proto__" can't
// pollute prototypes. readMap() loads a JSON object as one of these.
const nullMap = (src) => Object.assign(Object.create(null), src || {});
const readMap = (f) => nullMap(readJSON(f, {}));

let users = readMap(usersFile);     // username -> {salt, hash, createdAt}
let tokens = readMap(tokensFile);   // token -> { u: username, at: issuedAt }

// tokens.json used to hold a bare username string per token, and tokens never
// expired or got pruned. Normalize the old shape so sessions can age out.
{
  let migrated = false;
  for (const t in tokens) {
    if (typeof tokens[t] === 'string') { tokens[t] = { u: tokens[t], at: Date.now() }; migrated = true; }
  }
  if (migrated || pruneTokens()) writeJSON(tokensFile, tokens);
}

// per-user in-memory state, lazily loaded
const cache = Object.create(null); // username -> state

function userDir(u) { return path.join(DATA_DIR, 'u_' + encodeURIComponent(u)); }

function loadUser(u) {
  if (cache[u]) { cache[u].usedAt = Date.now(); return cache[u]; }
  const dir = userDir(u);
  const state = { records: Object.create(null), tombstones: Object.create(null), seq: 0, alerts: [], lastCheck: {}, usedAt: Date.now() };
  for (const s of STORES) state.records[s] = readMap(path.join(dir, s + '.json'));
  const meta = readJSON(path.join(dir, 'meta.json'), { seq: 0, tombstones: {}, lastCheck: {} });
  state.seq = meta.seq || 0;
  state.lastCheck = meta.lastCheck || {};
  for (const s of STORES) state.tombstones[s] = nullMap(meta.tombstones && meta.tombstones[s]);
  state.alerts = readJSON(path.join(dir, 'alerts.json'), []);
  state.pushSubs = readJSON(path.join(dir, 'push.json'), []);
  // Forget very old deletions — otherwise meta.json grows forever. A device
  // that hasn't synced in over a year keeps anything deleted in the meantime.
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  for (const s of STORES)
    for (const id in state.tombstones[s])
      if ((state.tombstones[s][id]._t || 0) < cutoff) delete state.tombstones[s][id];
  cache[u] = state;
  evictStaleUsers(u);
  return state;
}

// A loaded library is tens of MB in memory and nothing ever dropped it. Keep the
// few most recently used and let the rest be re-read on demand.
function evictStaleUsers(keep) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHED_USERS) return;
  // a queued write still holds its own state object so it lands correctly, but
  // re-reading from disk before it does would see stale data — flush first.
  flushWritesSync();
  keys.filter(k => k !== keep)
    .sort((a, b) => cache[a].usedAt - cache[b].usedAt)
    .slice(0, keys.length - MAX_CACHED_USERS)
    .forEach(k => delete cache[k]);
}

function persistPush(u) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  const st = cache[u];
  queueWrite(path.join(dir, 'push.json'), () => st.pushSubs || []);
}

function persistUser(u, changedStores) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  const st = cache[u];
  for (const s of changedStores || []) queueWrite(path.join(dir, s + '.json'), () => st.records[s]);
  queueWrite(path.join(dir, 'meta.json'), () => ({ seq: st.seq, tombstones: st.tombstones, lastCheck: st.lastCheck }));
}
function persistAlerts(u) {
  const dir = userDir(u); fs.mkdirSync(dir, { recursive: true });
  const st = cache[u];
  queueWrite(path.join(dir, 'alerts.json'), () => st.alerts);
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
  tokens[token] = { u: username, at: Date.now() };
  pruneTokens();
  writeJSON(tokensFile, tokens);
  return token;
}
// Drop sessions past the TTL. Returns how many went, so callers can skip the
// write when nothing changed.
function pruneTokens() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  let gone = 0;
  for (const t in tokens) if ((tokens[t].at || 0) < cutoff) { delete tokens[t]; gone++; }
  return gone;
}
function revokeTokens(pred) {
  let gone = 0;
  for (const t in tokens) if (pred(t, tokens[t])) { delete tokens[t]; gone++; }
  if (gone) writeJSON(tokensFile, tokens);
  return gone;
}
function userFor(token) {
  // token must be a string; null-proto `tokens` prevents inherited-key lookups
  const e = typeof token === 'string' ? tokens[token] : undefined;
  if (!e) throw err(401, 'Not signed in — sign in again');
  if (Date.now() - (e.at || 0) > TOKEN_TTL_MS) {
    revokeTokens(t => t === token);
    throw err(401, 'Session expired — sign in again');
  }
  return e.u;
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
    // `>=`, not `>`: re-pushing a record we already hold must be a no-op, or it
    // bumps _seq and every other device pulls a change that isn't one. That
    // idempotence is what lets the client re-push freely after a pull.
    if (cur && (cur._t || 0) >= t) continue;        // we have this or newer
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

// Every record and tombstone, ordered by _seq. Building this walks the whole
// library, and a fresh device pulls ~113k episodes in 4k-record pages — which
// used to redo the walk and the sort on every one of those ~28 requests.
// Memoize it against st.seq: any write bumps that, invalidating the list.
function changeList(st) {
  if (st._changes && st._changesSeq === st.seq) return st._changes;
  const out = [];
  for (const s of STORES) {
    for (const id in st.records[s]) {
      const r = st.records[s][id];
      out.push({ kind: 'rec', store: s, seq: r._seq || 0, rec: r });
    }
    for (const id in st.tombstones[s]) {
      const tb = st.tombstones[s][id];
      // tb.id preserves the original type (number vs string); fall back for old data
      out.push({ kind: 'del', store: s, seq: tb._seq || 0, id: tb.id != null ? tb.id : id, _t: tb._t });
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  st._changes = out; st._changesSeq = st.seq;
  return out;
}

// Collect changes with _seq > since across all stores, paginated.
function pullChanges(u, since) {
  const st = loadUser(u);
  const all = changeList(st);
  // sorted by seq, so binary-search the first unseen entry instead of filtering
  let lo = 0, hi = all.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid].seq > since) hi = mid; else lo = mid + 1; }
  const page = all.slice(lo, lo + PAGE_LIMIT);
  const more = all.length > lo + PAGE_LIMIT;
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

// Fixed-window counters, shared by every limited route. Buckets are separate so
// a burst of catalog lookups can't lock anyone out of signing in.
const buckets = new Map(); // bucket -> Map(key -> { count, resetAt })
function rateLimit(bucket, key, max, windowMs, message) {
  let b = buckets.get(bucket);
  if (!b) { b = new Map(); buckets.set(bucket, b); }
  const now = Date.now();
  let e = b.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; b.set(key, e); }
  if (++e.count > max) throw err(429, message);
}
const rateLimitAuth = (ip) => rateLimit('auth', ip, AUTH_MAX, AUTH_WINDOW_MS,
  'Too many attempts — wait a few minutes and try again');
// The catalog spends the owner's API quota, so it is limited per account, not
// per IP: one person cannot burn the month for everyone else.
const rateLimitCatalog = (user) => rateLimit('catalog', user, CATALOG_MAX, CATALOG_WINDOW_MS,
  'Too many lookups — wait a minute and try again');

setInterval(() => {
  const now = Date.now();
  for (const b of buckets.values()) for (const [k, e] of b) if (now > e.resetAt) b.delete(k);
}, AUTH_WINDOW_MS).unref();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (ALLOW_ORIGIN) Object.assign(headers, {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  });
  res.writeHead(status, headers);
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
  // Revoke this device's session, or every session for the account (`all`) —
  // the only way to cut off a lost or stolen device.
  '/api/logout': (b) => {
    const e = typeof b.token === 'string' ? tokens[b.token] : undefined;
    if (!e) return { ok: true };                    // unknown token: nothing to do
    const n = b.all ? revokeTokens((t, v) => v.u === e.u) : revokeTokens(t => t === b.token);
    return { ok: true, revoked: n };
  },
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
  // What this server can do for you, so the app knows whether to offer movie
  // search and "where to watch". Never reveals the keys themselves.
  '/api/capabilities': (b) => { userFor(b.token); return catalog.capabilities(KEYS); },
  // Catalog lookups on the owner's keys — an allowlist of named operations, not
  // a pass-through. See server/catalog.js.
  '/api/catalog': async (b) => {
    const u = userFor(b.token);
    rateLimitCatalog(u);
    const data = await catalog.run(KEYS, b.op, b.params || {});
    return { ok: true, data };
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
// APP_DIR is the repo root, so what's web-readable is an allowlist, not a
// denylist: a denylist served .git/ (whole history), package.json, test/, and
// would serve node_modules/ the moment anyone ran npm install here.
const PUBLIC_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
const PUBLIC_DIRS = new Set(['css', 'js', 'icons']);
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
  // must stay inside APP_DIR (no traversal) *and* be part of the web app
  const relCheck = path.relative(APP_DIR, full);
  const escapes = relCheck.startsWith('..') || path.isAbsolute(relCheck);
  const isPublic = PUBLIC_FILES.has(relCheck) || PUBLIC_DIRS.has(relCheck.split(path.sep)[0]);
  if (escapes || !isPublic) { res.writeHead(403); return res.end('Forbidden'); }
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
    return send(res, 200, { ok: true, app: 'endless-watch-sync', users: Object.keys(users).length });
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

// One-time upgrade: keys used to sync inside each user's kv store. If the vault
// is empty and a library still carries them, lift them in so nothing has to be
// re-entered — and so they stop being handed back down to every device.
{
  const from = catalog.adoptKeysFromLibrary(DATA_DIR, KEYS, Object.keys(users), loadUser);
  if (from) console.log(`Adopted API keys from "${from}" into ${path.join(DATA_DIR, 'keys.json')} (0600)`);
}

server.listen(PORT, HOST, () => {
  console.log(`The Endless Watch sync server on ${HOST}:${PORT}  data=${DATA_DIR}  users=${Object.keys(users).length}`);
});

// Store files are written on a short delay (see queueWrite) — make sure a clean
// shutdown doesn't drop the last few seconds of changes.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushWritesSync(); process.exit(0); });
}
process.on('exit', flushWritesSync);

// ---------------- background availability checks ----------------
require('./availability.js').schedule({
  loadUser, persistAlerts, persistUser, persistPush,
  listUsers: () => Object.keys(users),
  sendPush: (sub, payload) => webpush.sendNotification(sub, payload, VAPID),
  apiKey: KEYS.rapidapi,   // the owner's key, not one synced up from a device
});
