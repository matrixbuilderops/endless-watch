// runImport, driven with fake stores and a fake TVmaze.
//
// This is the largest untested surface in the app — it is how a 113,000-episode
// library was created — and until the io seam existed none of it could run
// outside a browser. The cases that matter are the failure ones: a network blip
// used to cost a show its entire watch history, log a tick, and mark the show
// done so a re-run would never retry it.

import { test } from 'node:test';
import assert from 'node:assert';

import { runImport } from '../js/import.js';

// ---------------- fakes ----------------

function fakeDb(seed = {}) {
  const stores = { shows: new Map(), episodes: new Map(), watched: new Map(), movies: new Map(), watchlist: new Map(), ...seed };
  return {
    stores,
    idOf: { watched: 'epId', kv: 'k' },
    async get(s, id) { return stores[s].get(id); },
    async put(s, rec) { stores[s].set(rec[s === 'watched' ? 'epId' : 'id'], rec); },
    async putMany(s, recs) { for (const r of recs) await this.put(s, r); },
    async all(s) { return [...stores[s].values()]; },
    async del(s, id) { stores[s].delete(id); },
  };
}

function fakeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    async get(k, dflt = null) { return m.has(k) ? m.get(k) : dflt; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
  };
}

// `episodes` may be a function so a test can throw from it.
function fakeTvmaze({ show, episodes }) {
  return {
    async byTvdb() { return show; },
    async search() { return show ? [{ show }] : []; },
    async episodes(id) {
      if (typeof episodes === 'function') return episodes(id);
      return episodes;
    },
  };
}

const SHOW = { id: 82, name: 'Game of Thrones', tvdbId: 121361 };
const EPS = [
  { id: 4952, season: 1, number: 1, name: 'Winter Is Coming' },
  { id: 4953, season: 1, number: 2, name: 'The Kingsroad' },
];
const FIELDS = { seriesId: 'tvdb', series: 'series', season: 'season', epNumber: 'ep', watchedAt: 'date' };
const epRow = (season, ep, date) => ({
  r: { tvdb: '121361', series: 'Game of Thrones', season, ep, date }, f: FIELDS,
});

function plan(epRows) {
  return { episodes: epRows, movies: [], follows: [], watchlistMovies: [], netflix: [] };
}

const silent = () => {};
const io = (over = {}) => ({ db: fakeDb(), kv: fakeKv(), tvmaze: fakeTvmaze({ show: SHOW, episodes: EPS }), ...over });

// ---------------- the happy path ----------------

test('matched rows become watch records', async () => {
  const d = io();
  const report = await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z'), epRow('1', '2', '2021-01-02T00:00:00Z')]), silent, silent, d);
  assert.strictEqual(report.matchedShows, 1);
  assert.strictEqual(report.watchedImported, 2);
  assert.strictEqual(report.epUnmatched, 0);
  assert.deepStrictEqual([...d.db.stores.watched.keys()].sort(), [4952, 4953]);
  assert.strictEqual(d.db.stores.shows.size, 1);
});

test('repeat rows for one episode collapse to a single record', async () => {
  const d = io();
  const report = await runImport(plan([
    epRow('1', '1', '2019-01-01T00:00:00Z'),
    epRow('1', '1', '2022-01-01T00:00:00Z'),
  ]), silent, silent, d);
  assert.strictEqual(d.db.stores.watched.size, 1, 'one record, not one per row');
  assert.strictEqual(d.db.stores.watched.get(4952).rewatchCount, 1);
  assert.strictEqual(report.rewatchesImported, 1);
});

test('a bulk marking does not become a rewatch, and says it was logged twice', async () => {
  const d = io();
  await runImport(plan([
    epRow('1', '1', '2019-06-18T06:12:39Z'),
    epRow('1', '1', '2019-06-18T06:12:46Z'),
  ]), silent, silent, d);
  const rec = d.db.stores.watched.get(4952);
  assert.strictEqual(rec.rewatchCount, 0);
  assert.strictEqual(rec.viewingsLogged, 2, 'the discarded viewing is still accounted for');
});

test('a finished show is checkpointed so a resume skips it', async () => {
  const d = io();
  await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  assert.deepStrictEqual(await d.kv.get('import:doneKeys'), ['tvdb:121361']);
});

// ---------------- the regression this seam exists for ----------------

test('a failed episode fetch does not silently lose the show', async () => {
  const d = io({ tvmaze: fakeTvmaze({ show: SHOW, episodes: () => { throw new Error('network'); } }) });
  const rows = [epRow('1', '1', '2021-01-01T00:00:00Z'), epRow('1', '2', '2021-01-02T00:00:00Z')];
  const report = await runImport(plan(rows), silent, silent, d);

  assert.strictEqual(report.matchedShows, 0, 'a show whose episodes never arrived is not a match');
  assert.strictEqual(report.watchedImported, 0);
  assert.strictEqual(d.db.stores.watched.size, 0, 'nothing half-written');
  assert.strictEqual(report.showsDeferred.length, 1, 'the loss is reported, not buried in a tally');
  assert.match(report.showsDeferred[0], /Game of Thrones/);
});

test('a deferred show is left out of the checkpoint so a re-run retries it', async () => {
  const d = io({ tvmaze: fakeTvmaze({ show: SHOW, episodes: () => { throw new Error('network'); } }) });
  await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  const done = await d.kv.get('import:doneKeys', []);
  assert.deepStrictEqual(done, [], 'marking it done would make the loss permanent');
});

test('the retry after a failure imports the rows that were deferred', async () => {
  // First pass fails, second pass succeeds against the same stores — the whole
  // point of not checkpointing a deferred show.
  const db = fakeDb(), kv = fakeKv();
  let fail = true;
  const tvmaze = fakeTvmaze({ show: SHOW, episodes: () => { if (fail) throw new Error('network'); return EPS; } });
  const rows = [epRow('1', '1', '2021-01-01T00:00:00Z'), epRow('1', '2', '2021-01-02T00:00:00Z')];

  await runImport(plan(rows), silent, silent, { db, kv, tvmaze });
  assert.strictEqual(db.stores.watched.size, 0);

  fail = false;
  const report = await runImport(plan(rows), silent, silent, { db, kv, tvmaze });
  assert.strictEqual(db.stores.watched.size, 2, 'the history arrives on the retry');
  assert.strictEqual(report.matchedShows, 1);
});

test('a show with no episode rows is not deferred by a fetch failure', async () => {
  // Follow-only shows have nothing to lose, so a failed episode list is fine.
  const d = io({ tvmaze: fakeTvmaze({ show: SHOW, episodes: () => { throw new Error('network'); } }) });
  const report = await runImport(
    { episodes: [], movies: [], watchlistMovies: [], netflix: [],
      follows: [{ r: { tvdb: '121361', series: 'Game of Thrones' }, f: FIELDS }] },
    silent, silent, d);
  assert.strictEqual(report.showsDeferred.length, 0);
});

// ---------------- other failure paths ----------------

test('a show TVmaze cannot find is reported, not counted as imported', async () => {
  const d = io({ tvmaze: fakeTvmaze({ show: null, episodes: [] }) });
  const report = await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  assert.strictEqual(report.matchedShows, 0);
  assert.strictEqual(report.unmatchedShows.length, 1);
});

test('rows for an episode the show does not have are counted as unmatched', async () => {
  const d = io();
  const report = await runImport(plan([
    epRow('1', '1', '2021-01-01T00:00:00Z'),
    epRow('9', '9', '2021-01-01T00:00:00Z'),
  ]), silent, silent, d);
  assert.strictEqual(report.epUnmatched, 1);
  assert.strictEqual(report.watchedImported, 1);
});

test('an already-checkpointed show is skipped on resume', async () => {
  const d = io({ kv: fakeKv({ 'import:doneKeys': ['tvdb:121361'] }) });
  const report = await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  assert.strictEqual(report.watchedImported, 0, 'not re-imported');
  assert.strictEqual(d.db.stores.watched.size, 0);
});

test('the rewatch-dates setting is honoured end to end', async () => {
  const d = io({ kv: fakeKv({ 'settings:recordRewatchDates': false }) });
  await runImport(plan([
    epRow('1', '1', '2019-01-01T00:00:00Z'),
    epRow('1', '1', '2022-01-01T00:00:00Z'),
  ]), silent, silent, d);
  const rec = d.db.stores.watched.get(4952);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.rewatches, undefined);
});

// ---------------- how the show was matched ----------------
// A tvdb id identifies one show; a name search returns a ranked list and the top
// is taken. The record looked identical either way, so a wrong match was
// invisible — the same shape as taking the first FRU device and getting the
// tester's own motherboard.

test('a show matched by tvdb id is not flagged for review', async () => {
  const d = io();
  const report = await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  assert.deepStrictEqual(report.showsNameMatched, [], 'an id match is exact, nothing to review');
});

test('a show matched by name search is reported with its candidate count', async () => {
  const other = { id: 99, name: 'Game of Thrones (2011)' };
  const tvmaze = {
    async byTvdb() { return null; },                       // id lookup finds nothing
    async search() { return [{ show: SHOW }, { show: other }]; },
    async episodes() { return EPS; },
  };
  const d = io({ tvmaze });
  const report = await runImport(plan([epRow('1', '1', '2021-01-01T00:00:00Z')]), silent, silent, d);
  assert.strictEqual(report.matchedShows, 1);
  assert.strictEqual(report.showsNameMatched.length, 1);
  assert.match(report.showsNameMatched[0], /Game of Thrones/);
  assert.match(report.showsNameMatched[0], /2 candidates/, 'says how many it chose between');
});

// ---------------- the Netflix twin of the deferral bug ----------------

test('a Netflix lookup failure is not reported as "no match"', async () => {
  const tvmaze = {
    async byTvdb() { return null; },
    async search() { throw new Error('network'); },
    async episodes() { return EPS; },
  };
  const d = io({ tvmaze });
  const report = await runImport(
    { episodes: [], movies: [], follows: [], watchlistMovies: [],
      netflix: [{ series: 'Breaking Bad', epName: 'Pilot', seasonNum: 1, date: '2021-01-01' }] },
    silent, silent, d);
  assert.strictEqual(report.netflixUnmatched, 0, 'a blip is not evidence the show does not exist');
  assert.strictEqual(report.netflixDeferred.length, 1);
  assert.match(report.netflixDeferred[0], /Breaking Bad/);
});

test('a Netflix episode-fetch failure defers instead of counting rows unmatched', async () => {
  const tvmaze = {
    async byTvdb() { return null; },
    async search() { return [{ show: SHOW }]; },
    async episodes() { throw new Error('network'); },
  };
  const d = io({ tvmaze });
  const report = await runImport(
    { episodes: [], movies: [], follows: [], watchlistMovies: [],
      netflix: [{ series: 'Breaking Bad', epName: 'Pilot', seasonNum: 1, date: '2021-01-01' }] },
    silent, silent, d);
  assert.strictEqual(report.netflixUnmatched, 0);
  assert.strictEqual(report.netflixDeferred.length, 1);
  assert.strictEqual(d.db.stores.watched.size, 0, 'nothing half-written');
});

test('a Netflix series TVmaze genuinely lacks is still counted unmatched', async () => {
  const tvmaze = { async byTvdb() { return null; }, async search() { return []; }, async episodes() { return EPS; } };
  const d = io({ tvmaze });
  const report = await runImport(
    { episodes: [], movies: [], follows: [], watchlistMovies: [],
      netflix: [{ series: 'Nonexistent', epName: 'Pilot', seasonNum: 1, date: '2021-01-01' }] },
    silent, silent, d);
  assert.strictEqual(report.netflixUnmatched, 1, 'a real absence is still an absence');
  assert.deepStrictEqual(report.netflixDeferred, []);
});

// ---------------- Netflix rewatch collapse ----------------
// The importNetflix path must call collapseWatches the same way the TV Time
// path does — before our fix it called putMany with one flat record per row,
// silently overwriting the first viewing with the second.

const NF_SHOW = { id: 300, name: 'Stranger Things', tvdbId: null };
const NF_EPS  = [{ id: 3001, season: 1, number: 1, name: 'The Vanishing of Will Byers' }];

function netflixPlan(rows) {
  return { episodes: [], movies: [], follows: [], watchlistMovies: [], netflix: rows };
}

function netflixIo(over = {}) {
  const tvmaze = {
    async byTvdb() { return null; },
    async search() { return [{ show: NF_SHOW }]; },
    async episodes() { return NF_EPS; },
  };
  return { db: fakeDb(), kv: fakeKv(), tvmaze, ...over };
}

test('a Netflix episode watched twice produces rewatchCount 1, not two separate records', async () => {
  const d = netflixIo();
  const report = await runImport(netflixPlan([
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2019-01-01' },
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2022-06-01' },
  ]), silent, silent, d);

  assert.strictEqual(d.db.stores.watched.size, 1, 'one record per episode, not one per row');
  const rec = d.db.stores.watched.get(3001);
  assert.strictEqual(rec.rewatchCount, 1, 'the second viewing must become a rewatch');
  assert.strictEqual(report.netflixEpisodes, 1);
});

test('Netflix rewatches two seconds apart are one bulk-marking, not a rewatch', async () => {
  const d = netflixIo();
  await runImport(netflixPlan([
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2019-06-18T06:12:39Z' },
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2019-06-18T06:12:41Z' },
  ]), silent, silent, d);

  const rec = d.db.stores.watched.get(3001);
  assert.strictEqual(rec.rewatchCount, 0, 'near-simultaneous rows are not a rewatch');
  assert.strictEqual(rec.viewingsLogged, 2, 'but the double-log is still noted');
});

test('Netflix rewatch-dates setting off suppresses dates but keeps the count', async () => {
  const d = netflixIo({ kv: fakeKv({ 'settings:recordRewatchDates': false }) });
  await runImport(netflixPlan([
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2019-01-01' },
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2022-06-01' },
  ]), silent, silent, d);

  const rec = d.db.stores.watched.get(3001);
  assert.strictEqual(rec.rewatchCount, 1, 'count must survive even with dates off');
  assert.strictEqual(rec.rewatches, undefined, 'no dates array when setting is off');
});

test('a Netflix episode watched only once has rewatchCount 0 and source netflix', async () => {
  const d = netflixIo();
  await runImport(netflixPlan([
    { series: 'Stranger Things', epName: 'The Vanishing of Will Byers', seasonNum: 1, date: '2021-03-15' },
  ]), silent, silent, d);

  const rec = d.db.stores.watched.get(3001);
  assert.strictEqual(rec.rewatchCount, 0);
  assert.strictEqual(rec.source, 'netflix');
  assert.strictEqual(rec.progress, 100);
});

