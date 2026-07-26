// mergePlaceholder folds a TV Time placeholder show ("tvt-…", created for
// anything the import could not match on TVmaze) into the real show a scrobble
// resolved it to. It deletes records, so it is tested directly.

const { test } = require('node:test');
const assert = require('node:assert');
const { mergePlaceholder } = require('../server/scrobble.js');

const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];

// minimal stand-in for a user's in-memory server state
function makeState() {
  const st = { records: {}, tombstones: {}, seq: 0 };
  for (const s of STORES) { st.records[s] = {}; st.tombstones[s] = {}; }
  return st;
}

// the shape resolveShow() returns
function makeInfo(name, eps) {
  const epsBySn = new Map();
  for (const e of eps) epsBySn.set(e.season + ':' + e.number, e);
  return { show: { id: 900, name }, epsBySn };
}

function fixture() {
  const st = makeState();
  st.records.shows['tvt-show-248580'] = {
    id: 'tvt-show-248580', name: 'The Bear', platform: 'Hulu',
    archived: true, private: true, followedAt: '2021-01-01T00:00:00.000Z',
  };
  st.records.episodes['tvt-ep-1'] = { id: 'tvt-ep-1', showId: 'tvt-show-248580', season: 1, number: 1 };
  st.records.episodes['tvt-ep-2'] = { id: 'tvt-ep-2', showId: 'tvt-show-248580', season: 1, number: 2 };
  st.records.watched['tvt-ep-1'] = {
    epId: 'tvt-ep-1', showId: 'tvt-show-248580', progress: 100,
    rewatchCount: 2, rewatches: ['2022-01-01T00:00:00.000Z'], watchedAt: '2022-01-01T00:00:00.000Z',
  };
  const info = makeInfo('The Bear', [
    { id: 5001, season: 1, number: 1 },
    { id: 5002, season: 1, number: 2 },
  ]);
  return { st, info };
}

const bumpFor = (st) => () => ++st.seq;

test('a placeholder with no name match is left alone', () => {
  const { st } = fixture();
  const other = makeInfo('Severance', [{ id: 7001, season: 1, number: 1 }]);
  assert.strictEqual(mergePlaceholder(st, other, 900, Date.now(), bumpFor(st)), null);
  assert.ok(st.records.shows['tvt-show-248580'], 'placeholder must survive');
  assert.strictEqual(st.seq, 0, 'nothing should have been written');
});

test('the placeholder show and its episodes are tombstoned, not just dropped', () => {
  const { st, info } = fixture();
  const out = mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));

  assert.strictEqual(out.shows, 1);
  assert.strictEqual(st.records.shows['tvt-show-248580'], undefined);
  assert.ok(st.tombstones.shows['tvt-show-248580'], 'other devices need the tombstone to drop it too');
  assert.strictEqual(st.records.episodes['tvt-ep-1'], undefined);
  assert.ok(st.tombstones.episodes['tvt-ep-1']);
  assert.ok(st.tombstones.episodes['tvt-ep-2']);
});

test('watch history is re-pointed onto the real episode by season+number', () => {
  const { st, info } = fixture();
  const out = mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));

  assert.strictEqual(out.movedWatches, 1);
  const moved = st.records.watched[5001];
  assert.ok(moved, 'S1E1 watch record should land on TVmaze episode 5001');
  assert.strictEqual(moved.showId, 900);
  assert.strictEqual(moved.epId, 5001);
  // the whole point: rewatch history survives the move
  assert.strictEqual(moved.rewatchCount, 2);
  assert.deepStrictEqual(moved.rewatches, ['2022-01-01T00:00:00.000Z']);
  assert.strictEqual(st.records.watched['tvt-ep-1'], undefined);
  assert.ok(st.tombstones.watched['tvt-ep-1']);
});

test('the user own flags are handed back to carry onto the real show', () => {
  const { st, info } = fixture();
  const out = mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));
  assert.strictEqual(out.platform, 'Hulu');
  assert.strictEqual(out.archived, true);
  assert.strictEqual(out.private, true);
  assert.strictEqual(out.followedAt, '2021-01-01T00:00:00.000Z');
});

test('an existing watch record on the real episode is not overwritten', () => {
  const { st, info } = fixture();
  st.records.watched[5001] = { epId: 5001, showId: 900, progress: 100, rewatchCount: 9 };
  const out = mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));

  assert.strictEqual(out.movedWatches, 0);
  assert.strictEqual(st.records.watched[5001].rewatchCount, 9, 'real record wins');
  assert.ok(st.tombstones.watched['tvt-ep-1'], 'placeholder record still cleaned up');
});

test('an episode with no season+number counterpart is cleaned up without inventing a watch', () => {
  const { st } = fixture();
  const info = makeInfo('The Bear', [{ id: 5002, season: 1, number: 2 }]); // no S1E1
  const out = mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));

  assert.strictEqual(out.movedWatches, 0);
  assert.strictEqual(Object.keys(st.records.watched).length, 0);
  assert.ok(st.tombstones.episodes['tvt-ep-1']);
});

test('every write takes a fresh seq so pulls see the merge', () => {
  const { st, info } = fixture();
  mergePlaceholder(st, info, 900, Date.now(), bumpFor(st));
  const seqs = [
    ...Object.values(st.tombstones.shows), ...Object.values(st.tombstones.episodes),
    ...Object.values(st.tombstones.watched), ...Object.values(st.records.watched),
  ].map(r => r._seq);
  assert.ok(seqs.every(s => s > 0), 'no record should be left without a seq');
  assert.strictEqual(new Set(seqs).size, seqs.length, 'seqs must be unique');
});
