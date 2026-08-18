// The rule that decides what counts as a rewatch.
//
// A TV Time export logs every viewing as its own row, including the rows a bulk
// "mark season watched" produces. Telling those apart is the whole job, and
// getting it wrong is silent: too loose and the library invents rewatches, too
// strict and real ones vanish. The gap fixtures below are taken from the real
// 32,130-row export — see server/analyze_backup.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

import { collapseWatches, keepBeyond, viewings, DEFAULT_MIN_GAP_MS } from '../js/rewatch.js';

const DAY = 86400000;
const at = (ms) => new Date(ms).toISOString();

// ---------------- keepBeyond ----------------

test('keepBeyond keeps a lone viewing', () => {
  assert.deepStrictEqual(keepBeyond(['2021-01-01T00:00:00.000Z'], DAY), ['2021-01-01T00:00:00.000Z']);
});

test('keepBeyond on no viewings gives no viewings', () => {
  assert.deepStrictEqual(keepBeyond([], DAY), []);
});

test('keepBeyond drops a viewing inside the gap and keeps one outside it', () => {
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  assert.deepStrictEqual(keepBeyond([at(t0), at(t0 + 1000)], DAY), [at(t0)]);
  assert.deepStrictEqual(keepBeyond([at(t0), at(t0 + 2 * DAY)], DAY), [at(t0), at(t0 + 2 * DAY)]);
});

test('a viewing exactly one gap later is kept', () => {
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  assert.deepStrictEqual(keepBeyond([at(t0), at(t0 + DAY)], DAY), [at(t0), at(t0 + DAY)],
    'the threshold is inclusive');
});

test('an unbroken run of near-neighbours is one sitting, however long', () => {
  // Six viewings 20 hours apart span five days, but no two consecutive ones are
  // a day apart, so the run never breaks.
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  const drip = [0, 20, 40, 60, 80, 100].map(h => at(t0 + h * 3600000));
  assert.deepStrictEqual(keepBeyond(drip, DAY), [at(t0)]);
});

// The regression. Measuring from the last *kept* viewing made a viewing's fate
// depend on which earlier ones survived rather than on its own neighbours, and
// silently kept every other one — half of a nightly rewatch went missing.
test('a run of near-neighbours is never split into alternating sittings', () => {
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  for (const h of [20, 22, 23]) {
    const run = [0, 1, 2, 3, 4, 5].map(i => at(t0 + i * h * 3600000));
    const kept = keepBeyond(run, DAY);
    assert.strictEqual(kept.length, 1,
      `${h}h apart: expected one unbroken sitting, got ${kept.length}`);
  }
});

test('a break in the run starts a new sitting, measured from its neighbour', () => {
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  // 20h (joins), then 30h later (breaks) — two sittings, not three.
  const kept = keepBeyond([at(t0), at(t0 + 20 * 3600000), at(t0 + 50 * 3600000)], DAY);
  assert.deepStrictEqual(kept, [at(t0), at(t0 + 50 * 3600000)]);
});

test('a gap of zero keeps every distinct viewing', () => {
  const t0 = Date.parse('2021-01-01T00:00:00.000Z');
  assert.strictEqual(keepBeyond([at(t0), at(t0 + 1), at(t0 + 2)], 0).length, 3);
});

// ---------------- viewings ----------------

test('viewings dedupes identical timestamps and sorts oldest first', () => {
  assert.deepStrictEqual(
    viewings(['2022-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z'], DAY),
    ['2019-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z']);
});

test('viewings accepts a Set as well as an array', () => {
  const s = new Set(['2022-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z']);
  assert.deepStrictEqual(viewings(s, DAY), ['2019-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z']);
});

// ---------------- collapseWatches ----------------

test('a single viewing is not a rewatch', () => {
  const [rec] = collapseWatches(82, [{ epId: 1, when: '2021-01-01T00:00:00.000Z' }]);
  assert.strictEqual(rec.rewatchCount, 0);
  assert.strictEqual(rec.watchedAt, '2021-01-01T00:00:00.000Z');
  assert.strictEqual(rec.rewatches, undefined);
  assert.strictEqual(rec.showId, 82);
  assert.strictEqual(rec.progress, 100);
  assert.strictEqual(rec.source, 'tvtime');
});

test('watching an episode again years later is a rewatch', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-06-18T10:00:00.000Z' },
    { epId: 1, when: '2022-03-04T21:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.watchedAt, '2022-03-04T21:00:00.000Z', 'watchedAt is the most recent viewing');
  assert.deepStrictEqual(rec.rewatches, ['2022-03-04T21:00:00.000Z']);
});

test('three separated viewings give a rewatch count of two, in order', () => {
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

// The regression this rule exists for. Ten Naruto episodes in the real export
// carry two timestamps seven seconds apart — one bulk marking, not two viewings.
// Collapsing on exact equality alone counted every one of them as a rewatch.
test('viewings seconds apart are one bulk marking, not a rewatch', () => {
  const [rec] = collapseWatches(45019, [
    { epId: 1, when: '2019-06-18T06:12:39.000Z' },
    { epId: 1, when: '2019-06-18T06:12:46.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 0, 'seven seconds apart is a double-log');
  assert.strictEqual(rec.rewatches, undefined);
  assert.strictEqual(rec.watchedAt, '2019-06-18T06:12:39.000Z');
});

test('viewings hours apart within a marking session are not a rewatch', () => {
  // Naruto S2003E22 in the real export: 23 hours apart, the tail of a session
  // that walked the whole season.
  const [rec] = collapseWatches(45040, [
    { epId: 1, when: '2019-06-18T06:12:39.000Z' },
    { epId: 1, when: '2019-06-19T05:12:39.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 0);
});

test('viewings two days apart are a rewatch', () => {
  // Alice in Borderland S1E1 in the real export, the closest genuine pair.
  const [rec] = collapseWatches(1945915, [
    { epId: 1, when: '2021-01-01T00:00:00.000Z' },
    { epId: 1, when: '2021-01-03T00:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.deepStrictEqual(rec.rewatches, ['2021-01-03T00:00:00.000Z']);
});

test('rewatch dates are omitted when the setting is off, but the count survives', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-01-01T00:00:00.000Z' },
    { epId: 1, when: '2022-01-01T00:00:00.000Z' },
  ], false);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.rewatches, undefined);
});

test('a caller can loosen the gap to count same-day viewings', () => {
  const hits = [
    { epId: 1, when: '2019-06-18T06:00:00.000Z' },
    { epId: 1, when: '2019-06-18T20:00:00.000Z' },
  ];
  assert.strictEqual(collapseWatches(82, hits)[0].rewatchCount, 0, 'default one day');
  assert.strictEqual(collapseWatches(82, hits, true, 3600000)[0].rewatchCount, 1, 'one hour');
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

test('every row for an episode collapses into exactly one record', () => {
  // The original bug: one record per row, and putMany kept only the last.
  const hits = Array.from({ length: 22 }, (_, i) => ({ epId: 7, when: at(Date.parse('2020-01-01T00:00:00.000Z') + i * 5000) }));
  const out = collapseWatches(82, hits);
  assert.strictEqual(out.length, 1, 'one record, not 22');
  assert.strictEqual(out[0].rewatchCount, 0, 'five seconds apart is one sitting');
});

test('no rows means no records', () => {
  assert.deepStrictEqual(collapseWatches(82, []), []);
});

test('the default gap is one day', () => {
  assert.strictEqual(DEFAULT_MIN_GAP_MS, DAY);
});

// ---------------- provenance ----------------
// A collapsed record must say how many viewings it came from, or it is
// indistinguishable from an episode watched once and the discarded stamps are
// gone for good.

test('a record that absorbed a duplicate log says how many it came from', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-06-18T06:12:39.000Z' },
    { epId: 1, when: '2019-06-18T06:12:46.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 0);
  assert.strictEqual(rec.viewingsLogged, 2, 'two viewings were logged, one survived');
});

test('an episode genuinely watched once carries no viewing count', () => {
  const [rec] = collapseWatches(82, [{ epId: 1, when: '2021-01-01T00:00:00.000Z' }]);
  assert.strictEqual(rec.viewingsLogged, undefined, 'nothing was discarded, nothing to cite');
});

test('the two are distinguishable, which is the whole point', () => {
  const once = collapseWatches(82, [{ epId: 1, when: '2019-06-18T06:12:39.000Z' }])[0];
  const twice = collapseWatches(82, [
    { epId: 1, when: '2019-06-18T06:12:39.000Z' },
    { epId: 1, when: '2019-06-18T06:12:46.000Z' },
  ])[0];
  assert.strictEqual(once.rewatchCount, twice.rewatchCount, 'same verdict');
  assert.notDeepStrictEqual(once, twice, 'but not the same record');
});

test('a record where nothing collapsed cites nothing', () => {
  const [rec] = collapseWatches(82, [
    { epId: 1, when: '2019-01-01T00:00:00.000Z' },
    { epId: 1, when: '2022-01-01T00:00:00.000Z' },
  ]);
  assert.strictEqual(rec.rewatchCount, 1);
  assert.strictEqual(rec.viewingsLogged, undefined, 'both viewings survived');
});
