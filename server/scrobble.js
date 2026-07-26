// Scrobble resolver. The browser extension scrapes {title, season, episode,
// epName, platform} off a streaming page and POSTs it here; we resolve the show
// and episode against TVmaze (cached), then write the records so the app shows
// it on next sync. Show flags (archived/private) are preserved; platform is set.

'use strict';
const https = require('https');

const showCache = new Map(); // normalized title -> { at, info | null }
const HIT_TTL_MS = 12 * 60 * 60 * 1000;  // refresh a resolved show twice a day
const MISS_TTL_MS = 10 * 60 * 1000;      // a failed lookup retries soon, not never
const CACHE_MAX = 500;                   // titles come from whatever page the extension saw
const MAX_RESPONSE = 4 * 1024 * 1024;
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function tvmazeGet(path) {
  return new Promise((resolve) => {
    const req = https.get('https://api.tvmaze.com' + path, { headers: { 'User-Agent': 'EndlessWatch-scrobble/1.0' } }, (r) => {
      let d = '', over = false;
      r.on('data', c => {
        if (over) return;
        d += c;
        // don't buffer an unbounded response into memory
        if (d.length > MAX_RESPONSE) { over = true; req.destroy(); resolve(null); }
      });
      r.on('end', () => { if (!over) try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
  });
}

// LRU-on-write, so a burst of unknown titles can't grow this without bound.
function remember(key, info) {
  showCache.delete(key);
  if (showCache.size >= CACHE_MAX) showCache.delete(showCache.keys().next().value);
  showCache.set(key, { at: Date.now(), info });
  return info;
}

async function resolveShow(title) {
  const key = norm(title);
  const hit = showCache.get(key);
  // misses expire too: a cached null used to be permanent, so one TVmaze blip
  // stopped a show scrobbling until the server was restarted
  if (hit && Date.now() - hit.at < (hit.info ? HIT_TTL_MS : MISS_TTL_MS)) return hit.info;

  const show = await tvmazeGet('/singlesearch/shows?q=' + encodeURIComponent(title));
  if (!show || !show.id) return remember(key, null);
  const eps = await tvmazeGet(`/shows/${show.id}/episodes?specials=1`) || [];
  const info = { show, epsBySn: new Map(), epsByName: new Map() };
  for (const e of eps) {
    if (e.number != null) info.epsBySn.set(e.season + ':' + e.number, e);
    if (e.name) info.epsByName.set(norm(e.name), e);
  }
  return remember(key, info);
}

// A TV Time import leaves a placeholder show (id "tvt-…") for anything it
// couldn't match on TVmaze. Scrobbling one of those used to create a *second*
// show under the real TVmaze id, splitting the library in two. Fold the
// placeholder in instead: re-point its watch history onto the matching TVmaze
// episodes by season+number, tombstone the leftovers so every device drops the
// duplicate, and hand back the user's own flags to carry over.
function mergePlaceholder(st, info, realId, now, bump) {
  const wanted = norm(info.show.name);
  const ids = Object.keys(st.records.shows).filter(id =>
    String(id).startsWith('tvt-') && norm(st.records.shows[id].name) === wanted);
  if (!ids.length) return null;

  const stale = new Set(ids.map(String));
  const tomb = (store, id) => {
    delete st.records[store][id];
    st.tombstones[store][id] = { _t: now, _seq: bump(), id };
  };

  const adopt = { shows: ids.length, movedWatches: 0, platform: '', archived: false, private: false, followedAt: null };
  for (const id of ids) {
    const old = st.records.shows[id];
    if (!adopt.platform && old.platform) adopt.platform = old.platform;
    if (old.archived) adopt.archived = true;
    if (old.private) adopt.private = true;
    if (old.followedAt && (!adopt.followedAt || old.followedAt < adopt.followedAt)) adopt.followedAt = old.followedAt;
  }

  // one pass over episodes rather than one per placeholder
  for (const eid of Object.keys(st.records.episodes)) {
    const e = st.records.episodes[eid];
    if (!stale.has(String(e.showId))) continue;
    const match = info.epsBySn.get(e.season + ':' + e.number);
    const w = st.records.watched[eid];
    if (w && match && !st.records.watched[match.id]) {
      st.records.watched[match.id] = { ...w, epId: match.id, showId: realId, _t: now, _seq: bump() };
      adopt.movedWatches++;
    }
    if (w) tomb('watched', eid);
    tomb('episodes', eid);
  }
  for (const id of ids) tomb('shows', id);
  return adopt;
}

// st: the user's in-memory state; bump: () => next server seq.
async function handleScrobble(st, body, bump) {
  const { platform, title, season, episode, epName } = body;
  if (!title) return { ok: false, reason: 'no title' };
  const info = await resolveShow(title);
  if (!info) return { ok: false, reason: 'show not found on TVmaze' };

  let ep = null;
  if (season != null && episode != null) ep = info.epsBySn.get(Number(season) + ':' + Number(episode));
  if (!ep && epName) ep = info.epsByName.get(norm(epName));
  if (!ep) return { ok: false, reason: 'episode not matched' };

  const now = Date.now();
  const raw = info.show, sid = raw.id;

  const merged = mergePlaceholder(st, info, sid, now, bump);

  const existing = st.records.shows[sid];
  const show = existing ? { ...existing } : {
    id: sid, name: raw.name,
    image: raw.image ? raw.image.medium : null,
    imageBig: raw.image ? raw.image.original : null,
    status: raw.status, premiered: raw.premiered, ended: raw.ended || null,
    network: (raw.network && raw.network.name) || (raw.webChannel && raw.webChannel.name) || '',
    genres: raw.genres || [], summary: raw.summary || '',
    tvdbId: (raw.externals || {}).thetvdb ?? null, imdbId: (raw.externals || {}).imdb ?? null,
    followedAt: new Date(now).toISOString(), archived: false, private: false, lastEpisodeSync: null,
  };
  if (platform) show.platform = platform;
  if (merged) {
    if (!show.platform && merged.platform) show.platform = merged.platform;
    if (merged.archived) show.archived = true;
    if (merged.private) show.private = true;
    if (merged.followedAt && (!show.followedAt || merged.followedAt < show.followedAt)) show.followedAt = merged.followedAt;
  }
  show._t = now; show._seq = bump();
  st.records.shows[sid] = show;

  st.records.episodes[ep.id] = {
    id: ep.id, showId: sid, season: ep.season, number: ep.number, name: ep.name,
    airdate: ep.airdate || null, airstamp: ep.airstamp || null, runtime: ep.runtime || null,
    type: ep.type || 'regular', _t: now, _seq: bump(),
  };

  // Finishing an episode you'd already completed is a rewatch, not a reset. The
  // old code replaced the record outright, wiping rewatchCount and the rewatch
  // dates the app records when settings:recordRewatchDates is on.
  const prev = st.records.watched[ep.id];
  const seen = prev ? Math.min(100, prev.progress ?? 100) : 0;
  const count = prev ? (prev.rewatchCount ?? 0) : 0;
  const again = seen >= 100;
  const keepDates = st.records.kv['settings:recordRewatchDates']
    ? st.records.kv['settings:recordRewatchDates'].v !== false : true;
  const stamp = new Date(now).toISOString();
  st.records.watched[ep.id] = {
    ...prev,
    epId: ep.id, showId: sid, watchedAt: stamp, progress: 100,
    rewatchCount: again ? count + 1 : count,
    ...(again && keepDates ? { rewatches: [...((prev && prev.rewatches) || []), stamp] } : {}),
    source: 'scrobble', _t: now, _seq: bump(),
  };
  return {
    ok: true, show: raw.name, marked: `S${ep.season}E${ep.number}`,
    ...(again ? { rewatch: count + 1 } : {}),
    ...(merged ? { mergedPlaceholders: merged.shows, movedWatches: merged.movedWatches } : {}),
  };
}

// mergePlaceholder is exported for the unit test — it deletes records, so it
// gets direct coverage rather than only running behind a live TVmaze lookup.
module.exports = { handleScrobble, mergePlaceholder };
