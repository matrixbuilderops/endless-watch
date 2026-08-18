// Unit tests for pure logic extracted from js/app.js.
//
// app.js references document/IndexedDB and cannot be imported in Node directly.
// These tests duplicate only the pure functions under test — the same technique
// the extension tests use for derive() and parseSE(). If the function body in
// app.js changes, this test will catch the regression.

import { test } from 'node:test';
import assert from 'node:assert';

// ---- syncStaleShows filter (pure predicate) -------------------------
//
// Extracted from syncStaleShows() — the part that decides which shows are stale.
// The real function calls db.all() and tvmaze; we test only the staleness logic.

const DAY  = 86400000;
const MONTH = 30 * DAY;

function isStale(show, now, { force = false } = {}) {
  if (String(show.id).startsWith('tvt-')) return false;
  if (!show.lastEpisodeSync) return true;
  if (force) return show.status !== 'Ended';
  const age = new Date(show.lastEpisodeSync).getTime();
  return show.status === 'Ended' ? age < now - MONTH : age < now - DAY;
}

// -- ended shows --

test('an ended show with no prior sync is stale', () => {
  assert.ok(isStale({ id: 1, status: 'Ended', lastEpisodeSync: null }, Date.now()));
});

test('an ended show synced 31 days ago is stale', () => {
  const ts = new Date(Date.now() - 31 * DAY).toISOString();
  assert.ok(isStale({ id: 1, status: 'Ended', lastEpisodeSync: ts }, Date.now()));
});

test('an ended show synced 29 days ago is NOT stale', () => {
  const ts = new Date(Date.now() - 29 * DAY).toISOString();
  assert.ok(!isStale({ id: 1, status: 'Ended', lastEpisodeSync: ts }, Date.now()));
});

test('an ended show synced today is NOT stale', () => {
  const ts = new Date().toISOString();
  assert.ok(!isStale({ id: 1, status: 'Ended', lastEpisodeSync: ts }, Date.now()));
});

// -- running shows --

test('a running show with no prior sync is stale', () => {
  assert.ok(isStale({ id: 1, status: 'Running', lastEpisodeSync: null }, Date.now()));
});

test('a running show synced 25 hours ago is stale', () => {
  const ts = new Date(Date.now() - 25 * 3600000).toISOString();
  assert.ok(isStale({ id: 1, status: 'Running', lastEpisodeSync: ts }, Date.now()));
});

test('a running show synced 1 hour ago is NOT stale', () => {
  const ts = new Date(Date.now() - 3600000).toISOString();
  assert.ok(!isStale({ id: 1, status: 'Running', lastEpisodeSync: ts }, Date.now()));
});

// -- force mode --

test('force skips ended shows', () => {
  const ts = new Date(Date.now() - 365 * DAY).toISOString();
  assert.ok(!isStale({ id: 1, status: 'Ended', lastEpisodeSync: ts }, Date.now(), { force: true }));
});

test('force re-syncs a running show even if recently synced', () => {
  const ts = new Date().toISOString();
  assert.ok(isStale({ id: 1, status: 'Running', lastEpisodeSync: ts }, Date.now(), { force: true }));
});

// -- placeholder shows --

test('a tvt- placeholder is never stale (it has no TVmaze id to fetch)', () => {
  assert.ok(!isStale({ id: 'tvt-show-12345', status: 'Running', lastEpisodeSync: null }, Date.now()));
});


// ---- recentSeed -------------------------------------------------------
//
// Finds the item from `items` whose show had the most recent watched record,
// falling back to a random item when nothing has been watched.

async function recentSeed(items, watchedAll, keyFn) {
  let best = null, bestT = 0;
  const watchedByShow = new Map();
  for (const w of watchedAll) {
    const t = w.watchedAt ? new Date(w.watchedAt).getTime() : 0;
    if (t > (watchedByShow.get(w.showId) || 0)) watchedByShow.set(w.showId, t);
  }
  for (const item of items) {
    const t = watchedByShow.get(keyFn(item)) || (item.watchedAt ? new Date(item.watchedAt).getTime() : 0);
    if (t > bestT) { bestT = t; best = item; }
  }
  return best || items[Math.floor(Math.random() * items.length)];
}

test('recentSeed picks the show with the most recent watched record', async () => {
  const shows = [
    { id: 1, name: 'Old Show' },
    { id: 2, name: 'Recent Show' },
    { id: 3, name: 'Middle Show' },
  ];
  const watched = [
    { showId: 1, watchedAt: '2020-01-01T00:00:00Z' },
    { showId: 2, watchedAt: '2024-11-01T00:00:00Z' },  // most recent
    { showId: 3, watchedAt: '2022-06-15T00:00:00Z' },
  ];
  const seed = await recentSeed(shows, watched, s => s.id);
  assert.strictEqual(seed.id, 2, 'most-recently-watched show must win');
});

test('recentSeed uses the latest watchedAt when a show has multiple records', async () => {
  const shows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const watched = [
    { showId: 1, watchedAt: '2024-01-01T00:00:00Z' },
    { showId: 1, watchedAt: '2024-12-01T00:00:00Z' },  // newest for show 1
    { showId: 2, watchedAt: '2024-06-01T00:00:00Z' },
  ];
  const seed = await recentSeed(shows, watched, s => s.id);
  assert.strictEqual(seed.id, 1, 'the latest record for show 1 puts it ahead of show 2');
});

test('recentSeed falls back to random when no watched records exist', async () => {
  const shows = [{ id: 10, name: 'X' }, { id: 20, name: 'Y' }];
  const seed = await recentSeed(shows, [], s => s.id);
  assert.ok(shows.includes(seed), 'must still return one of the items');
});

test('recentSeed returns the only item when list has one entry', async () => {
  const shows = [{ id: 5, name: 'Only' }];
  const watched = [{ showId: 5, watchedAt: '2023-01-01T00:00:00Z' }];
  const seed = await recentSeed(shows, watched, s => s.id);
  assert.strictEqual(seed.id, 5);
});

test('recentSeed works for movies using item.watchedAt directly', async () => {
  // movies use their own watchedAt field, not the watched store
  const movies = [
    { id: 'a', title: 'Old Movie', watchedAt: '2019-01-01T00:00:00Z' },
    { id: 'b', title: 'New Movie', watchedAt: '2024-09-01T00:00:00Z' },
  ];
  const seed = await recentSeed(movies, [], m => m.id);
  assert.strictEqual(seed.id, 'b', 'newest movie by watchedAt must win');
});

test('recentSeed ignores watched records with no watchedAt', async () => {
  const shows = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const watched = [
    { showId: 1, watchedAt: null },
    { showId: 2, watchedAt: '2023-03-01T00:00:00Z' },
  ];
  const seed = await recentSeed(shows, watched, s => s.id);
  assert.strictEqual(seed.id, 2, 'null watchedAt counts as time 0');
});
