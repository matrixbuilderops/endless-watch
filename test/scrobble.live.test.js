// handleScrobble against the real TVmaze API — the path the browser extension
// drives every time you finish an episode. Everything else in the scrobbler is
// unit-tested; this covers resolution and the watch-record write for real.
//
// Network-dependent by nature: skips with a message when TVmaze is unreachable
// rather than failing the suite. Uses one show throughout, and the module's own
// cache means the whole file costs two upstream requests.

const { test } = require('node:test');
const assert = require('node:assert');

const { handleScrobble } = require('../server/scrobble.js');

const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const SHOW = 'Breaking Bad';      // stable id 169 on TVmaze, stable episode names

function state(kv = {}) {
  const st = { records: {}, tombstones: {}, alerts: [], seq: 0 };
  for (const s of STORES) { st.records[s] = {}; st.tombstones[s] = {}; }
  for (const [k, v] of Object.entries(kv)) st.records.kv[k] = { k, v };
  return st;
}
const bumpFor = (st) => () => ++st.seq;

let reachable = null;
async function online() {
  if (reachable === null) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      const r = await fetch('https://api.tvmaze.com/shows/169', { signal: c.signal });
      clearTimeout(t);
      reachable = r.ok;
    } catch { reachable = false; }
  }
  return reachable;
}
const OFFLINE = 'TVmaze unreachable — skipping the live scrobble path';

test('a season+episode scrobble marks the right episode watched', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  const r = await handleScrobble(st, { title: SHOW, season: 1, episode: 1, platform: 'Netflix' }, bumpFor(st));

  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.marked, 'S1E1');
  assert.match(r.show, /Breaking Bad/);

  const shows = Object.values(st.records.shows);
  assert.strictEqual(shows.length, 1);
  assert.strictEqual(shows[0].platform, 'Netflix');
  assert.strictEqual(shows[0].id, 169);

  const watched = Object.values(st.records.watched);
  assert.strictEqual(watched.length, 1);
  assert.strictEqual(watched[0].progress, 100);
  assert.strictEqual(watched[0].source, 'scrobble');
  assert.strictEqual(watched[0].showId, 169);
  // the episode record has to exist too, or the app has a watch with no episode
  assert.ok(st.records.episodes[watched[0].epId], 'episode record must be written');
});

test('an episode name alone is enough when the site gives no numbers', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  const r = await handleScrobble(st, { title: SHOW, season: null, episode: null, epName: 'Pilot' }, bumpFor(st));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.marked, 'S1E1', 'name-only signals are the common case on Netflix');
});

test('finishing an episode again counts as a rewatch, not a reset', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  const body = { title: SHOW, season: 1, episode: 2, platform: 'Netflix' };

  const first = await handleScrobble(st, body, bumpFor(st));
  assert.strictEqual(first.rewatch, undefined, 'the first watch is not a rewatch');
  const epId = Object.keys(st.records.watched)[0];
  assert.strictEqual(st.records.watched[epId].rewatchCount, 0);

  const second = await handleScrobble(st, body, bumpFor(st));
  assert.strictEqual(second.rewatch, 1);
  const rec = st.records.watched[epId];
  assert.strictEqual(rec.rewatchCount, 1, 'the old code reset this to 0');
  assert.strictEqual(rec.rewatches.length, 1, 'and dropped the dates entirely');

  const third = await handleScrobble(st, body, bumpFor(st));
  assert.strictEqual(third.rewatch, 2);
  assert.strictEqual(st.records.watched[epId].rewatchCount, 2);
  assert.strictEqual(st.records.watched[epId].rewatches.length, 2);
});

test('rewatch dates are not recorded when the setting is off', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state({ 'settings:recordRewatchDates': false });
  const body = { title: SHOW, season: 1, episode: 3 };

  await handleScrobble(st, body, bumpFor(st));
  await handleScrobble(st, body, bumpFor(st));

  const rec = Object.values(st.records.watched)[0];
  assert.strictEqual(rec.rewatchCount, 1, 'the count is still kept');
  assert.strictEqual(rec.rewatches, undefined, 'but not the dates');
});

test('an existing partial watch is completed without inventing a rewatch', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  await handleScrobble(st, { title: SHOW, season: 1, episode: 4 }, bumpFor(st));
  const epId = Number(Object.keys(st.records.watched)[0]);

  // rewind to "43% seen", as the app would after partial progress
  st.records.watched[epId] = { ...st.records.watched[epId], progress: 43, rewatchCount: 0 };
  const r = await handleScrobble(st, { title: SHOW, season: 1, episode: 4 }, bumpFor(st));

  assert.strictEqual(r.rewatch, undefined, 'finishing something half-watched is not a rewatch');
  assert.strictEqual(st.records.watched[epId].progress, 100);
  assert.strictEqual(st.records.watched[epId].rewatchCount, 0);
});

test('your own flags on a show survive a scrobble', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  st.records.shows[169] = {
    id: 169, name: 'Breaking Bad', archived: true, private: true,
    platform: 'Netflix', followedAt: '2019-01-01T00:00:00.000Z', rating: 9,
  };
  await handleScrobble(st, { title: SHOW, season: 1, episode: 5, platform: 'Hulu' }, bumpFor(st));

  const show = st.records.shows[169];
  assert.strictEqual(show.archived, true, 'a scrobble must not un-archive a show');
  assert.strictEqual(show.private, true, 'or un-hide a private one');
  assert.strictEqual(show.rating, 9, 'or drop fields it does not model');
  assert.strictEqual(show.followedAt, '2019-01-01T00:00:00.000Z');
  assert.strictEqual(show.platform, 'Hulu', 'but the platform you watched on does update');
});

test('a tvt- placeholder is folded in rather than duplicated', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  st.records.shows['tvt-show-999'] = {
    id: 'tvt-show-999', name: 'Breaking Bad', platform: 'Netflix',
    archived: false, private: true, followedAt: '2018-01-01T00:00:00.000Z',
  };
  st.records.episodes['tvt-ep-1'] = { id: 'tvt-ep-1', showId: 'tvt-show-999', season: 1, number: 6 };
  st.records.watched['tvt-ep-1'] = { epId: 'tvt-ep-1', showId: 'tvt-show-999', progress: 100, rewatchCount: 3 };

  const r = await handleScrobble(st, { title: SHOW, season: 1, episode: 7 }, bumpFor(st));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mergedPlaceholders, 1);

  assert.strictEqual(st.records.shows['tvt-show-999'], undefined, 'no duplicate show left behind');
  assert.ok(st.tombstones.shows['tvt-show-999'], 'other devices need to drop it too');
  assert.strictEqual(st.records.shows[169].private, true, 'flags carried across');

  // the S1E6 history should now hang off the real TVmaze episode
  const moved = Object.values(st.records.watched).find(w => w.rewatchCount === 3);
  assert.ok(moved, 'rewatch history should survive the move');
  assert.strictEqual(moved.showId, 169);
});

test('an unknown show is reported, not guessed at', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  const r = await handleScrobble(st, { title: 'Zzzqqx Not A Real Show 91773', season: 1, episode: 1 }, bumpFor(st));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not found/);
  assert.deepStrictEqual(Object.keys(st.records.shows), [], 'nothing written on a miss');
});

test('an episode that does not exist is reported, not mismarked', async (t) => {
  if (!await online()) return t.skip(OFFLINE);
  const st = state();
  const r = await handleScrobble(st, { title: SHOW, season: 99, episode: 99 }, bumpFor(st));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /episode not matched/);
  assert.deepStrictEqual(Object.keys(st.records.watched), [], 'better nothing than the wrong episode');
});

test('a missing title is rejected before any network call', async () => {
  const st = state();
  for (const body of [{}, { title: '' }, { title: null }]) {
    const r = await handleScrobble(st, body, bumpFor(st));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no title');
  }
});
