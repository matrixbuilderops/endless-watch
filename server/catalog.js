// Catalog proxy: TMDB and streaming-availability lookups, made with the
// owner's API keys so nobody signing in has to set anything up.
//
// Two things make this safe to expose to accounts you invited:
//
//   1. It is an ALLOWLIST of named operations, never a pass-through. A generic
//      "proxy this path/URL" route would hand every account your key and your
//      server's network position — the SSRF shape already guarded against in
//      webpush.js. Adding an operation is deliberate; there is no escape hatch.
//   2. Responses are cached per operation and shared across users, so ten
//      people opening the same show costs one upstream call instead of ten.
//      Pooling keys is what makes pooling the cache possible.

'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const MAX_RESPONSE = 4 * 1024 * 1024;
const CACHE_MAX = 2000;              // bounded: entries are small, keys are ours
const UPSTREAM_TIMEOUT_MS = 15000;

// ---------------- the vault ----------------

// Keys live in DATA_DIR/keys.json at 0600, exactly like vapid.json, and the
// static-file allowlist already returns 403 for anything under server/.
function loadKeys(dataDir) {
  const file = path.join(dataDir, 'keys.json');
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* seed below */ }

  // env seeding, so a fresh install needs no editor
  const seeded = {
    tmdb: keys.tmdb || process.env.TMDB_KEY || '',
    rapidapi: keys.rapidapi || process.env.RAPIDAPI_KEY || '',
  };
  if (seeded.tmdb !== keys.tmdb || seeded.rapidapi !== keys.rapidapi) saveKeys(dataDir, seeded);
  return seeded;
}

function saveKeys(dataDir, keys) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'keys.json'), JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

// One-time lift: before this existed, the keys synced inside each user's kv
// store. If the vault is empty and a library still carries them, move them in
// so the upgrade needs no manual step. Returns the username they came from.
function adoptKeysFromLibrary(dataDir, keys, usernames, loadUser) {
  if (keys.tmdb || keys.rapidapi) return null;
  for (const u of usernames) {
    let kv;
    try { kv = loadUser(u).records.kv; } catch { continue; }
    const tmdb = kv['settings:tmdbKey'] && kv['settings:tmdbKey'].v;
    const rapid = kv['settings:rapidApiKey'] && kv['settings:rapidApiKey'].v;
    if (tmdb || rapid) {
      keys.tmdb = tmdb || '';
      keys.rapidapi = rapid || '';
      saveKeys(dataDir, keys);
      return u;
    }
  }
  return null;
}

// ---------------- shared response cache ----------------

const cache = new Map(); // key -> { at, ttl, value }

function cached(key, ttl, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = produce();          // a promise; stored so concurrent callers share one flight
  cache.delete(key);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), ttl, value });
  // a failed lookup must not be cached for hours
  Promise.resolve(value).then(v => { if (v == null) cache.delete(key); }, () => cache.delete(key));
  return value;
}

const cacheStats = () => ({ entries: cache.size });

// ---------------- upstream ----------------

function getJSON(options) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '', over = false;
      res.on('data', c => {
        if (over) return;
        data += c;
        if (data.length > MAX_RESPONSE) { over = true; req.destroy(); resolve(null); }
      });
      res.on('end', () => {
        if (over) return;
        if (res.statusCode >= 400) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const tmdbGet = (key, pathname, params = {}) => {
  const qs = new URLSearchParams(params);
  const opts = { host: 'api.themoviedb.org', path: `/3${pathname}?${qs}`, method: 'GET',
    headers: { accept: 'application/json' } };
  // v4 bearer tokens are JWTs; v3 keys go in the query string
  if (key.split('.').length === 3) opts.headers.Authorization = 'Bearer ' + key;
  else { qs.set('api_key', key); opts.path = `/3${pathname}?${qs}`; }
  return getJSON(opts);
};

const availabilityGet = (key, pathAndQuery) => getJSON({
  host: 'streaming-availability.p.rapidapi.com', path: pathAndQuery, method: 'GET',
  headers: { 'x-rapidapi-host': 'streaming-availability.p.rapidapi.com', 'x-rapidapi-key': key },
});

// ---------------- the allowlist ----------------

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const str = (v) => String(v == null ? '' : v).slice(0, 200);

// Number(null) and Number('') are both 0, and Number.isFinite(0) is true — so a
// plain finite check waved `{ id: null }` straight through to /tv/0/....
const isId = (v) => (typeof v === 'number' || typeof v === 'string')
  && String(v).trim() !== '' && Number.isInteger(Number(v)) && Number(v) > 0;

// Every operation names its own upstream call and TTL. Params are coerced and
// length-capped here so nothing a client sends reaches a URL unshaped.
const OPS = Object.assign(Object.create(null), {
  search_movie: {
    ttl: HOUR,
    valid: (p) => str(p.query).trim().length > 0,
    key: (p) => `search_movie:${str(p.query).toLowerCase()}`,
    run: (keys, p) => tmdbGet(keys.tmdb, '/search/movie', { query: str(p.query), include_adult: 'true' }),
    needs: 'tmdb',
  },
  external_ids: {
    ttl: 30 * DAY,                                   // an imdb id does not change
    key: (p) => `external_ids:${Number(p.id)}`,
    run: (keys, p) => tmdbGet(keys.tmdb, `/movie/${Number(p.id)}/external_ids`),
    needs: 'tmdb',
    valid: (p) => isId(p.id),
  },
  movie_recs: {
    ttl: DAY,
    key: (p) => `movie_recs:${Number(p.id)}`,
    run: (keys, p) => tmdbGet(keys.tmdb, `/movie/${Number(p.id)}/recommendations`),
    needs: 'tmdb',
    valid: (p) => isId(p.id),
  },
  tv_recs: {
    ttl: DAY,
    key: (p) => `tv_recs:${Number(p.id)}`,
    run: (keys, p) => tmdbGet(keys.tmdb, `/tv/${Number(p.id)}/recommendations`),
    needs: 'tmdb',
    valid: (p) => isId(p.id),
  },
  find_by_imdb: {
    ttl: 7 * DAY,
    key: (p) => `find_by_imdb:${str(p.imdbId)}`,
    run: (keys, p) => tmdbGet(keys.tmdb, `/find/${encodeURIComponent(str(p.imdbId))}`, { external_source: 'imdb_id' }),
    needs: 'tmdb',
    valid: (p) => /^tt\d{4,12}$/.test(str(p.imdbId)),
  },
  availability: {
    ttl: DAY,                                        // matches the old per-device cache
    key: (p) => `availability:${str(p.imdbId)}`,
    run: (keys, p) => availabilityGet(keys.rapidapi,
      `/shows/${encodeURIComponent(str(p.imdbId))}?country=us`),
    needs: 'rapidapi',
    valid: (p) => /^tt\d{4,12}$/.test(str(p.imdbId)),
  },
});

// Runs one allowlisted operation. Throws {status} errors the router understands.
async function run(keys, op, params = {}) {
  const spec = OPS[op];
  if (!spec) { const e = new Error('Unknown catalog operation'); e.status = 400; throw e; }
  if (spec.valid && !spec.valid(params)) { const e = new Error('Bad parameters'); e.status = 400; throw e; }
  if (!keys[spec.needs]) {
    const e = new Error(`This server has no ${spec.needs === 'tmdb' ? 'TMDB' : 'availability'} key configured`);
    e.status = 503;
    throw e;
  }
  return cached(spec.key(params), spec.ttl, () => spec.run(keys, params));
}

// what the client should offer, without ever learning the keys themselves
const capabilities = (keys) => ({ tmdb: !!keys.tmdb, availability: !!keys.rapidapi });

module.exports = { loadKeys, saveKeys, adoptKeysFromLibrary, run, capabilities, cacheStats, OPS };
