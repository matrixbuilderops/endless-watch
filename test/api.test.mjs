// Unit tests for the pure TVmaze normalizers. These shape every show and episode
// record that lands in IndexedDB, so a regression here corrupts the library.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert';

import { autoPlatform, normalizeShow, normalizeEpisode } from '../js/api.js';

test('autoPlatform maps TVmaze web channels onto our platform names', () => {
  assert.strictEqual(autoPlatform({ webChannel: { name: 'Netflix' } }), 'Netflix');
  assert.strictEqual(autoPlatform({ webChannel: { name: 'HBO Max' } }), 'Max');
  assert.strictEqual(autoPlatform({ webChannel: { name: 'Amazon Prime Video' } }), 'Prime Video');
});

test('autoPlatform is case-insensitive', () => {
  assert.strictEqual(autoPlatform({ webChannel: { name: 'NETFLIX' } }), 'Netflix');
});

test('autoPlatform returns empty for unknown or absent channels', () => {
  assert.strictEqual(autoPlatform({ webChannel: { name: 'BBC One' } }), '');
  assert.strictEqual(autoPlatform({}), '');
  assert.strictEqual(autoPlatform({ network: { name: 'AMC' } }), '');
});

test('normalizeShow keeps the fields the app depends on', () => {
  const got = normalizeShow({
    id: 82, name: 'Game of Thrones', status: 'Ended', premiered: '2011-04-17', ended: '2019-05-19',
    image: { medium: 'm.jpg', original: 'o.jpg' },
    network: { name: 'HBO' }, genres: ['Drama'], summary: '<p>hi</p>',
    externals: { thetvdb: 121361, imdb: 'tt0944947' },
  });
  assert.strictEqual(got.id, 82);
  assert.strictEqual(got.name, 'Game of Thrones');
  assert.strictEqual(got.image, 'm.jpg');
  assert.strictEqual(got.imageBig, 'o.jpg');
  assert.strictEqual(got.network, 'HBO');
  assert.strictEqual(got.tvdbId, 121361);
  assert.strictEqual(got.imdbId, 'tt0944947');
});

test('normalizeShow survives a sparse TVmaze record', () => {
  const got = normalizeShow({ id: 1, name: 'X' });
  assert.strictEqual(got.image, null);
  assert.strictEqual(got.imageBig, null);
  assert.strictEqual(got.network, '');
  assert.deepStrictEqual(got.genres, []);
  assert.strictEqual(got.summary, '');
  assert.strictEqual(got.tvdbId, null);
  assert.strictEqual(got.imdbId, null);
});

test('normalizeShow falls back to the web channel for the network name', () => {
  assert.strictEqual(normalizeShow({ id: 1, name: 'X', webChannel: { name: 'Netflix' } }).network, 'Netflix');
});

test('normalizeEpisode stamps the show id and defaults the type', () => {
  const got = normalizeEpisode(
    { id: 9, season: 2, number: 4, name: 'Oathkeeper', airdate: '2014-04-27', airstamp: '2014-04-28T01:00:00+00:00', runtime: 55 },
    82);
  assert.strictEqual(got.showId, 82);
  assert.strictEqual(got.season, 2);
  assert.strictEqual(got.number, 4);
  assert.strictEqual(got.runtime, 55);
  assert.strictEqual(got.type, 'regular');
});

test('normalizeEpisode nulls missing dates rather than leaving them undefined', () => {
  const got = normalizeEpisode({ id: 1, season: 1, number: 1, name: 'TBA' }, 5);
  assert.strictEqual(got.airdate, null);
  assert.strictEqual(got.airstamp, null);
  assert.strictEqual(got.runtime, null);
});
