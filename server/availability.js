// Background streaming-availability checker. Runs on an interval, and for each
// user who opted into background checks, flags shows that are leaving (or have
// left) a platform they were watching on. Conservative with the free RapidAPI
// quota: a small cap per run, round-robined by least-recently-checked.

'use strict';
const https = require('https');

const INTERVAL_MS = 12 * 60 * 60 * 1000; // every 12h
const CAP_PER_RUN = 15;                  // shows checked per user per run
const GAP_MS = 1500;                     // spacing between API calls
const MAX_RESPONSE = 4 * 1024 * 1024;    // cap on a single API response body

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function apiGet(pathAndQuery, key) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'streaming-availability.p.rapidapi.com', path: pathAndQuery, method: 'GET',
      headers: { 'x-rapidapi-host': 'streaming-availability.p.rapidapi.com', 'x-rapidapi-key': key },
    }, (res) => {
      let data = '', over = false;
      res.on('data', c => {
        if (over) return;
        data += c;
        // don't buffer an unbounded response into memory
        if (data.length > MAX_RESPONSE) { over = true; req.destroy(); resolve(null); }
      });
      res.on('end', () => { if (!over) try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

const kvGet = (recs, k, dflt = null) => (recs.kv[k] ? recs.kv[k].v : dflt);

function hasAired(ep, now) {
  if (ep.airstamp) return new Date(ep.airstamp).getTime() <= now;
  if (ep.airdate) return new Date(ep.airdate + 'T23:59:59').getTime() <= now;
  return false;
}

// shows you're mid-way through — the ones where losing access actually hurts
function currentlyWatching(st, now) {
  const epsByShow = {};
  for (const id in st.records.episodes) {
    const e = st.records.episodes[id];
    (epsByShow[e.showId] = epsByShow[e.showId] || []).push(e);
  }
  const watched = st.records.watched;
  const out = [];
  for (const id in st.records.shows) {
    const show = st.records.shows[id];
    if (show.archived) continue;
    const eps = (epsByShow[id] || []).filter(e => e.type === 'regular' && e.number != null && hasAired(e, now));
    if (!eps.length) continue;
    let done = 0, started = false;
    for (const e of eps) {
      const w = watched[e.id];
      const p = w ? Math.min(100, w.progress ?? 100) : 0;
      if (p >= 100) { done++; started = true; }
      else if (p > 0) started = true;
    }
    if (started && done < eps.length) out.push(show);
  }
  return out;
}

async function checkUser(u, st, helpers) {
  const key = kvGet(st.records, 'settings:rapidApiKey', '');
  const mode = kvGet(st.records, 'settings:availMode', 'app');
  if (!key || (mode !== 'background' && mode !== 'both')) return;
  const owned = (kvGet(st.records, 'settings:myPlatforms', []) || []).map(p => String(p).toLowerCase());
  // guard the name: undefined threw and killed this user's whole run, and ''
  // made p.includes('') true, marking every service as one you pay for
  const isOwned = (name) => {
    const n = String(name || '').toLowerCase();
    return !!n && owned.some(p => n.includes(p) || p.includes(n));
  };

  const now = Date.now();
  const shows = currentlyWatching(st, now)
    .sort((a, b) => (st.lastCheck[a.id] || 0) - (st.lastCheck[b.id] || 0))
    .slice(0, CAP_PER_RUN);
  if (!shows.length) return;

  // remember which alert messages already existed, so we only push genuinely new ones
  const before = new Set(st.alerts.map(a => a.showId + '|' + a.message));
  const fresh = [];

  // apiGet and the pacing gap come through helpers like every other side effect
  // in this file, so the alert logic can be tested without burning API quota.
  const fetchShow = helpers.apiGet || apiGet;
  const gap = helpers.gapMs ?? GAP_MS;

  for (const show of shows) {
    let data = null;
    if (show.imdbId) data = await fetchShow(`/shows/${show.imdbId}?country=us`, key);
    st.lastCheck[show.id] = Date.now();
    if (!data) { await sleep(gap); continue; }

    const opts = (data.streamingOptions && data.streamingOptions.us) || [];
    // drop any stale alerts for this show, then recompute
    st.alerts = st.alerts.filter(a => a.showId !== show.id);

    const leaving = opts.filter(o => o.expiresSoon);
    for (const o of leaving) {
      st.alerts.push({
        showId: show.id, name: show.name, kind: 'leaving',
        service: o.service.name,
        message: `${show.name} is leaving ${o.service.name}` +
          (o.expiresOn ? ` on ${new Date(o.expiresOn * 1000).toLocaleDateString()}` : ' soon'),
        expiresOn: o.expiresOn || null, at: Date.now(),
      });
    }
    // gone from the platform you tagged it with?
    if (show.platform) {
      // Same guard as isOwned needs, for the same reason: the payload is
      // third-party, and one entry missing a name used to throw here and abort
      // this user's whole run. An empty id also had to stop matching, or
      // platform.includes('') reported every show as still available.
      const platform = show.platform.toLowerCase();
      const stillThere = opts.some(o => {
        const name = String((o.service && o.service.name) || '').toLowerCase();
        const id = String((o.service && o.service.id) || '').toLowerCase();
        return (!!name && name.includes(platform)) || (!!id && platform.includes(id));
      });
      if (!stillThere) {
        const subs = [...new Set(opts
          .filter(o => o.type === 'subscription' && o.service && o.service.name)
          .map(o => o.service.name))];
        // prefer services the user actually pays for
        const yours = subs.filter(isOwned);
        const elsewhere = yours.length ? yours : subs;
        st.alerts.push({
          showId: show.id, name: show.name, kind: 'left',
          service: show.platform,
          message: elsewhere.length
            ? `${show.name} left ${show.platform} — ${yours.length ? 'you can watch it on' : 'now on'} ${elsewhere.join(', ')}`
            : `${show.name} left ${show.platform} — not on any subscription now`,
          at: Date.now(),
        });
      }
    }
    await sleep(gap);
  }
  helpers.persistUser(u, []);   // save lastCheck (meta)
  helpers.persistAlerts(u);

  // push the newly-created alerts to the user's devices (locked-phone delivery)
  for (const a of st.alerts) if (!before.has(a.showId + '|' + a.message)) fresh.push(a);
  if (fresh.length && helpers.sendPush && (st.pushSubs || []).length) {
    const payload = JSON.stringify(fresh.length === 1
      ? { title: 'Endless Watch', body: fresh[0].message, tag: 'endless-watch-alert' }
      : { title: 'Endless Watch', body: `${fresh.length} shows are leaving a platform`, tag: 'endless-watch-alert' });
    const dead = [];
    for (const sub of st.pushSubs) {
      const { status } = await helpers.sendPush(sub, payload);
      if (status === 404 || status === 410) dead.push(sub.endpoint); // subscription expired
    }
    if (dead.length) { st.pushSubs = st.pushSubs.filter(s => !dead.includes(s.endpoint)); helpers.persistPush(u); }
  }
}

async function runAll(helpers) {
  for (const u of helpers.listUsers()) {
    try { await checkUser(u, helpers.loadUser(u), helpers); }
    catch (e) { console.error('availability check failed for', u, e.message); }
  }
}

// currentlyWatching and checkUser are exported for the unit test: they decide
// what gets an API call and what alert the user is shown.
exports.currentlyWatching = currentlyWatching;
exports.checkUser = checkUser;

exports.schedule = (helpers) => {
  // first run shortly after startup, then on the interval
  setTimeout(() => runAll(helpers).catch(() => {}), 60 * 1000);
  setInterval(() => runAll(helpers).catch(() => {}), INTERVAL_MS);
};
