// The TV Time / Netflix importer: ZIP inflation, RFC 4180 CSV parsing, column
// detection and row classification. This is how a 113,000-episode library came
// into existence and it had no tests at all.
//
// Driven through the real public entry point, analyzeFiles(), with real File
// objects and real ZIP bytes — Node has File, Blob and DecompressionStream, so
// nothing needs stubbing.

import { test } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';

import { analyzeFiles, collapseWatches } from '../js/import.js';

// ---------------- a real ZIP, assembled by hand ----------------

function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.text ?? '');
    const method = e.method ?? 8;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const csize = e.csizeOverride ?? data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(csize, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);

    offset += 30 + name.length + data.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const zipFile = (name, entries) => new File([zip(entries)], name);
const csvFile = (name, text) => new File([Buffer.from(text)], name);

// ---------------- fixtures shaped like the real export ----------------

const EPISODES_CSV = [
  'key,entity_type,s_id,series_name,s_no,ep_no,created_at',
  'watch-episode-101,episode,82,Game of Thrones,1,1,2021-03-01T10:00:00Z',
  'watch-episode-102,episode,82,Game of Thrones,1,2,2021-03-02T10:00:00Z',
  'rewatch-episode-103,episode,82,Game of Thrones,1,1,2022-01-01T10:00:00Z',
  'user-series-82,series,82,Game of Thrones,,,2021-02-28T10:00:00Z',
  'tracking-stats,,,,,,',
].join('\n');

const MOVIES_CSV = [
  'key,entity_type,movie_id,movie_name,imdb_id,type,created_at',
  'watch-movie-1,movie,55,Arrival,tt2543164,watch,2021-04-01T10:00:00Z',
  'towatch-movie-2,movie,66,Dune,tt1160419,towatch,2021-05-01T10:00:00Z',
].join('\n');

const NETFLIX_CSV = [
  'Title,Date',
  '"Severance: Season 1: Good News About Hell",01/02/2022',
  '"Arrival",03/04/2022',
  '"The Bear: Season 2: Fishes",05/06/2022',
].join('\n');

// ---------------- ZIP handling ----------------

test('a deflated ZIP entry is inflated and parsed', async () => {
  const out = await analyzeFiles([zipFile('export.zip', [
    { name: 'seen_episode.csv', text: EPISODES_CSV, method: 8 },
  ])]);
  assert.strictEqual(out.episodes.length, 3);
  assert.strictEqual(out.follows.length, 1);
  assert.strictEqual(out.unknown.length, 1, 'tracking-stats is not an importable event');
});

test('a stored (uncompressed) ZIP entry works too', async () => {
  const out = await analyzeFiles([zipFile('export.zip', [
    { name: 'seen_episode.csv', text: EPISODES_CSV, method: 0 },
  ])]);
  assert.strictEqual(out.episodes.length, 3);
});

test('directories and unsupported compression are skipped, not fatal', async () => {
  const out = await analyzeFiles([zipFile('export.zip', [
    { name: 'data/', text: '', method: 0 },
    { name: 'data/weird.csv', text: EPISODES_CSV, method: 9 },   // not store or deflate
    { name: 'data/movies.csv', text: MOVIES_CSV, method: 8 },
  ])]);
  assert.strictEqual(out.movies.length, 1);
  assert.strictEqual(out.watchlistMovies.length, 1);
  assert.strictEqual(out.episodes.length, 0, 'the method-9 entry should be ignored');
});

test('a JSON file inside the ZIP is noted but not imported', async () => {
  const out = await analyzeFiles([zipFile('export.zip', [
    { name: 'profile.json', text: '{"a":1}' },
  ])]);
  assert.strictEqual(out.episodes.length, 0);
  assert.match(out.analyzed[0].note, /not imported/);
});

test('a file that is not a ZIP fails with a clear message', async () => {
  await assert.rejects(
    () => analyzeFiles([new File([Buffer.from('nope nope nope')], 'export.zip')]),
    /Not a valid ZIP file/);
});

test('ZIP64 is refused with advice rather than silently truncating', async () => {
  await assert.rejects(
    () => analyzeFiles([zipFile('export.zip', [
      { name: 'big.csv', text: EPISODES_CSV, method: 0, csizeOverride: 0xFFFFFFFF },
    ])]),
    /ZIP64 not supported/);
});

test('loose CSVs can be handed over without a ZIP', async () => {
  const out = await analyzeFiles([
    csvFile('seen_episode.csv', EPISODES_CSV),
    csvFile('movies.csv', MOVIES_CSV),
  ]);
  assert.strictEqual(out.episodes.length, 3);
  assert.strictEqual(out.movies.length, 1);
});

test('an empty CSV is reported as empty, not crashed on', async () => {
  const out = await analyzeFiles([csvFile('empty.csv', 'key,entity_type\n')]);
  assert.strictEqual(out.analyzed[0].note, 'empty');
});

// ---------------- CSV parsing (RFC 4180) ----------------

test('quoted commas, escaped quotes and embedded newlines survive', async () => {
  const csv = [
    'key,entity_type,s_id,series_name,s_no,ep_no,created_at',
    'watch-episode-1,episode,1,"Hello, World",1,1,2021-01-01',
    'watch-episode-2,episode,2,"He said ""hi""",1,1,2021-01-01',
    'watch-episode-3,episode,3,"Multi\nline",1,1,2021-01-01',
  ].join('\n');
  const out = await analyzeFiles([csvFile('seen.csv', csv)]);
  const titles = out.episodes.map(e => e.r[e.f.title]);
  assert.deepStrictEqual(titles, ['Hello, World', 'He said "hi"', 'Multi\nline']);
});

test('CRLF line endings parse the same as LF', async () => {
  const out = await analyzeFiles([csvFile('seen.csv', EPISODES_CSV.replace(/\n/g, '\r\n'))]);
  assert.strictEqual(out.episodes.length, 3);
  assert.strictEqual(out.episodes[0].r[out.episodes[0].f.title], 'Game of Thrones');
});

test('a trailing newline does not invent a blank record', async () => {
  const out = await analyzeFiles([csvFile('seen.csv', EPISODES_CSV + '\n')]);
  assert.strictEqual(out.episodes.length + out.follows.length + out.unknown.length, 5);
});

// ---------------- column detection ----------------

test('the v2 export column names are detected', async () => {
  const out = await analyzeFiles([csvFile('seen_episode.csv', EPISODES_CSV)]);
  const f = out.analyzed[0].fields;
  assert.strictEqual(f.recordKey, 'key');
  assert.strictEqual(f.seriesId, 's_id');
  assert.strictEqual(f.season, 's_no');
  assert.strictEqual(f.epNumber, 'ep_no');
  assert.strictEqual(f.title, 'series_name');
  assert.strictEqual(f.watchedAt, 'created_at');
});

test('the older v1 column spellings are detected too', async () => {
  const csv = [
    'type,tv_show_id,tv_show_name,season_number,episode_number,watched_at',
    'watch,82,Game of Thrones,1,1,2021-03-01',
  ].join('\n');
  const out = await analyzeFiles([csvFile('v1.csv', csv)]);
  const f = out.analyzed[0].fields;
  assert.strictEqual(f.action, 'type');
  assert.strictEqual(f.seriesId, 'tv_show_id');
  assert.strictEqual(f.title, 'tv_show_name');
  assert.strictEqual(f.season, 'season_number');
  assert.strictEqual(f.epNumber, 'episode_number');
  assert.strictEqual(f.watchedAt, 'watched_at');
  assert.strictEqual(out.episodes.length, 1);
});

test('unrecognized columns land in unknown instead of being dropped silently', async () => {
  const out = await analyzeFiles([csvFile('mystery.csv', 'alpha,beta\n1,2\n3,4\n')]);
  assert.strictEqual(out.unknown.length, 2);
  assert.strictEqual(out.analyzed[0].rows, 2);
  assert.ok(out.analyzed[0].headers.includes('alpha'), 'headers are reported for the column report');
});

// ---------------- classification ----------------

test('watch and rewatch rows both count as episodes', async () => {
  const out = await analyzeFiles([csvFile('seen.csv', EPISODES_CSV)]);
  const keys = out.episodes.map(e => e.r.key);
  assert.ok(keys.includes('watch-episode-101'));
  assert.ok(keys.includes('rewatch-episode-103'));
});

test('counters and aggregates are not mistaken for events', async () => {
  const csv = [
    'key,type,s_id,series_name,s_no,ep_no',
    'x,count-episodes,82,Game of Thrones,,',
    'x,last-episode-watched,82,Game of Thrones,,',
    'x,time-count,82,Game of Thrones,,',
    'x,rewatch_count,82,Game of Thrones,,',
  ].join('\n');
  const out = await analyzeFiles([csvFile('stats.csv', csv)]);
  assert.strictEqual(out.unknown.length, 4);
  assert.strictEqual(out.episodes.length, 0);
  assert.strictEqual(out.follows.length, 0);
});

test('watched movies and watch-later movies are told apart', async () => {
  const out = await analyzeFiles([csvFile('movies.csv', MOVIES_CSV)]);
  assert.strictEqual(out.movies.length, 1);
  assert.strictEqual(out.watchlistMovies.length, 1);
  assert.strictEqual(out.movies[0].r.movie_name, 'Arrival');
  assert.strictEqual(out.watchlistMovies[0].r.movie_name, 'Dune');
});

test('a movie row is not misread as an episode', async () => {
  const out = await analyzeFiles([csvFile('movies.csv', MOVIES_CSV)]);
  assert.strictEqual(out.episodes.length, 0);
});

// ---------------- Netflix viewing history ----------------

test('a Netflix export is recognized by its two columns alone', async () => {
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', NETFLIX_CSV)]);
  assert.strictEqual(out.netflix.length, 3);
  assert.strictEqual(out.episodes.length, 0, 'Netflix rows go down their own path');
});

test('Netflix episode titles split into series, season and episode name', async () => {
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', NETFLIX_CSV)]);
  const eps = out.netflix.filter(r => r.kind === 'episode');
  assert.deepStrictEqual(eps.map(e => [e.series, e.seasonNum, e.epName]), [
    ['Severance', 1, 'Good News About Hell'],
    ['The Bear', 2, 'Fishes'],
  ]);
});

test('a Netflix film stays a movie', async () => {
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', NETFLIX_CSV)]);
  const movies = out.netflix.filter(r => r.kind === 'movie');
  assert.deepStrictEqual(movies.map(m => m.title), ['Arrival']);
});

test('Netflix titles with a colon but no season marker are movies, not episodes', async () => {
  const csv = 'Title,Date\n"Okja: A Netflix Film",01/01/2022\n';
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', csv)]);
  assert.strictEqual(out.netflix[0].kind, 'movie');
  assert.strictEqual(out.netflix[0].title, 'Okja: A Netflix Film');
});

test('Netflix limited-series and chapter wording is treated as episodic', async () => {
  const csv = [
    'Title,Date',
    '"Beef: Limited Series: The Birds Don\'t Sing",01/01/2022',
    '"Dark: Chapter 3: Ghosts",02/01/2022',
  ].join('\n');
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', csv)]);
  assert.deepStrictEqual(out.netflix.map(r => r.kind), ['episode', 'episode']);
  assert.strictEqual(out.netflix[0].series, 'Beef');
  assert.strictEqual(out.netflix[0].seasonNum, null, 'no "Season N" means match by name');
});

test('the Netflix date column rides along for each row', async () => {
  const out = await analyzeFiles([csvFile('NetflixViewingHistory.csv', NETFLIX_CSV)]);
  assert.deepStrictEqual(out.netflix.map(r => r.date), ['01/02/2022', '03/04/2022', '05/06/2022']);
});

// ---------------- the whole export at once ----------------

test('a full mixed export is separated into the right buckets', async () => {
  const out = await analyzeFiles([zipFile('tv-time-export.zip', [
    { name: 'tvtime/seen_episode.csv', text: EPISODES_CSV },
    { name: 'tvtime/movies.csv', text: MOVIES_CSV },
    { name: 'tvtime/profile.json', text: '{}' },
    { name: 'tvtime/empty.csv', text: 'key\n' },
  ]), csvFile('NetflixViewingHistory.csv', NETFLIX_CSV)]);

  assert.strictEqual(out.episodes.length, 3);
  assert.strictEqual(out.follows.length, 1);
  assert.strictEqual(out.movies.length, 1);
  assert.strictEqual(out.watchlistMovies.length, 1);
  assert.strictEqual(out.netflix.length, 3);
  assert.strictEqual(out.analyzed.length, 5, 'every file is accounted for in the report');
});

// ---------------- rewatch collapsing ----------------
// A TV Time export logs a rewatch as its own row, so one episode arrives several
// times. Writing one record per row let putMany overwrite and lost every
// rewatch — which is exactly what happened to 12 episodes in the original
// converted library.

test('a single viewing is not a rewatch', () => {
  const [rec] = collapseWatches(82, [{ epId: 1, when: '2021-01-01T00:00:00.000Z' }]);
  assert.strictEqual(rec.rewatchCount, 0);
  assert.strictEqual(rec.watchedAt, '2021-01-01T00:00:00.000Z');
  assert.strictEqual(rec.rewatches, undefined);
  assert.strictEqual(rec.showId, 82);
  assert.strictEqual(rec.progress, 100);
});

test('watching an episode twice becomes one record with a rewatch', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-06-18T10:00:00.000Z' },
    { epId: 1, when: '2022-03-04T21:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.watchedAt, '2022-03-04T21:00:00.000Z', 'watchedAt is the most recent viewing');
  assert.deepStrictEqual(rec.rewatches, ['2022-03-04T21:00:00.000Z'], 'the repeat viewing is the rewatch');
});

test('three viewings give a rewatch count of two, in order', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2022-01-01T00:00:00.000Z' },
    { epId: 1, when: '2019-01-01T00:00:00.000Z' },
    { epId: 1, when: '2020-01-01T00:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 2);
  assert.deepStrictEqual(rec.rewatches, ['2020-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z']);
});

test('rows sharing an exact timestamp are a double-log, not two viewings', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-06-18T10:00:00.000Z' },
    { epId: 1, when: '2019-06-18T10:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 0, 'the same instant cannot be two viewings');
  assert.strictEqual(rec.rewatches, undefined);
});

test('rewatch dates are omitted when the setting is off, but the count survives', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-01-01T00:00:00.000Z' },
    { epId: 1, when: '2022-01-01T00:00:00.000Z' },
  ], false);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.rewatches, undefined);
});

test('separate episodes stay separate', () => {
  const out = collapseWatches(82, [
    { epId: 1, when: '2021-01-01T00:00:00.000Z' },
    { epId: 2, when: '2021-01-02T00:00:00.000Z' },
    { epId: 1, when: '2023-01-01T00:00:00.000Z' },
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find(r => r.epId === 1).rewatchCount, 1);
  assert.strictEqual(out.find(r => r.epId === 2).rewatchCount, 0);
});

test('no rows means no records', () => {
  assert.deepStrictEqual(collapseWatches(82, []), []);
});
