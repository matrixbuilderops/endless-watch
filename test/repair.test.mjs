// The one-off rewatch repair. It rewrites a live library in place, which makes
// it the most dangerous script in the repo and the one that had no tests: the
// interesting cases are all about what it must NOT touch.

import { test } from 'node:test';
import assert from 'node:assert';

import { groupViewings, planRepair, spreadByGap, applyFixes } from '../server/repair_rewatches.mjs';
import { collapseWatches } from '../js/rewatch.js';

const DAY = 86400000;
const w = (epId, watchedAt) => ({ epId, watchedAt });
const lib = (recs) => Object.fromEntries(recs.map(r => [r.epId, r]));

// ---------------- groupViewings ----------------

test('viewings are grouped per episode, deduped and sorted', () => {
  const g = groupViewings([
    w(1, '2022-01-01T00:00:00Z'), w(2, '2021-01-01T00:00:00Z'),
    w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z'),
  ]);
  assert.deepStrictEqual(g.get(1), ['2019-01-01T00:00:00Z', '2022-01-01T00:00:00Z']);
  assert.deepStrictEqual(g.get(2), ['2021-01-01T00:00:00Z']);
});

test('rows with no episode id or no date are ignored', () => {
  const g = groupViewings([
    { epId: null, watchedAt: '2021-01-01T00:00:00Z' },
    { epId: 1, watchedAt: null },
    { epId: 1, watchedAt: '' },
    w(2, '2021-01-01T00:00:00Z'),
  ]);
  assert.strictEqual(g.has(1), false);
  assert.strictEqual(g.size, 1);
});

test('a missing watched array is not an error', () => {
  assert.strictEqual(groupViewings(undefined).size, 0);
});

// ---------------- planRepair: what it must not touch ----------------

test('an episode logged once is left alone', () => {
  const g = groupViewings([w(1, '2021-01-01T00:00:00Z')]);
  assert.deepStrictEqual(planRepair(g, lib([{ epId: 1, rewatchCount: 0 }])), []);
});

test('viewings inside the gap gain no rewatch', () => {
  const g = groupViewings([w(1, '2019-06-18T06:12:39Z'), w(1, '2019-06-18T06:12:46Z')]);
  const fixes = planRepair(g, lib([{ epId: 1, rewatchCount: 0 }]));
  assert.ok(fixes.every(f => !f.countChanged), 'nothing gains a rewatch count');
});

test('an episode the library does not have is skipped', () => {
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  assert.deepStrictEqual(planRepair(g, {}), [], 'never invents a record');
});

test('a record that already has the rewatch is not touched', () => {
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  assert.deepStrictEqual(planRepair(g, lib([{ epId: 1, rewatchCount: 1 }])), [],
    'the user already logged it by hand');
});

test('a record with more rewatches than the backup justifies is not reduced', () => {
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  assert.deepStrictEqual(planRepair(g, lib([{ epId: 1, rewatchCount: 5 }])), [],
    'the library is ahead of the backup; leave it');
});

test('running the repair twice changes nothing the second time', () => {
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  const library = lib([{ epId: 1, rewatchCount: 0 }]);
  const first = planRepair(g, library);
  assert.strictEqual(first.length, 1);
  applyFixes(library, first);
  assert.deepStrictEqual(planRepair(g, library), [], 'idempotent');
});

// ---------------- planRepair: what it does fix ----------------

test('a genuine rewatch is planned with its dates', () => {
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  assert.deepStrictEqual(planRepair(g, lib([{ epId: 1, rewatchCount: 0 }])), [
    {
      epId: 1, from: 0, to: 1, logged: 2, countChanged: true,
      dates: ['2019-01-01T00:00:00Z', '2022-01-01T00:00:00Z'],
    },
  ]);
});

// The 27 episodes in the real library whose second viewing collapsed: they gain
// no rewatch, but "logged twice, judged once" is the fact that was being thrown
// away, and it is what makes the threshold reversible later.
test('an episode whose extra viewing collapsed is recorded as logged twice', () => {
  const g = groupViewings([w(1, '2019-06-18T06:12:39Z'), w(1, '2019-06-18T06:12:46Z')]);
  const [fix] = planRepair(g, lib([{ epId: 1, rewatchCount: 0 }]));
  assert.strictEqual(fix.countChanged, false, 'seven seconds apart is not a rewatch');
  assert.strictEqual(fix.to, 0);
  assert.strictEqual(fix.logged, 2);
});

test('applying a provenance-only fix records the count without inventing a rewatch', () => {
  const library = lib([{ epId: 1, rewatchCount: 0, watchedAt: '2019-06-18T06:12:39Z' }]);
  const g = groupViewings([w(1, '2019-06-18T06:12:39Z'), w(1, '2019-06-18T06:12:46Z')]);
  applyFixes(library, planRepair(g, library));
  assert.strictEqual(library[1].viewingsLogged, 2);
  assert.strictEqual(library[1].rewatchCount, 0, 'no rewatch invented');
  assert.strictEqual(library[1].rewatches, undefined);
  assert.strictEqual(library[1].watchedAt, '2019-06-18T06:12:39Z', 'watchedAt untouched');
});

test('a record that already cites its viewing count is not rewritten', () => {
  const g = groupViewings([w(1, '2019-06-18T06:12:39Z'), w(1, '2019-06-18T06:12:46Z')]);
  assert.deepStrictEqual(planRepair(g, lib([{ epId: 1, rewatchCount: 0, viewingsLogged: 2 }])), []);
});

test('a partly-recorded record is topped up, not reset', () => {
  const g = groupViewings([
    w(1, '2019-01-01T00:00:00Z'), w(1, '2020-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z'),
  ]);
  const [fix] = planRepair(g, lib([{ epId: 1, rewatchCount: 1 }]));
  assert.strictEqual(fix.from, 1);
  assert.strictEqual(fix.to, 2);
});

test('the gap threshold decides how many gain a rewatch', () => {
  const g = groupViewings([w(1, '2021-01-01T00:00:00Z'), w(1, '2021-01-01T14:00:00Z')]);
  const library = () => lib([{ epId: 1, rewatchCount: 0 }]);
  const gained = (gap) => planRepair(g, library(), gap).filter(f => f.countChanged).length;
  assert.strictEqual(gained(DAY), 0, 'same day: not a rewatch');
  assert.strictEqual(gained(3600000), 1, 'one hour: a rewatch');
});

// ---------------- spreadByGap ----------------

test('the spread table counts episodes at each threshold', () => {
  const g = groupViewings([
    w(1, '2021-01-01T00:00:00Z'), w(1, '2021-01-01T00:00:07Z'),   // 7s
    w(2, '2021-01-01T00:00:00Z'), w(2, '2021-01-03T00:00:00Z'),   // 2d
    w(3, '2021-01-01T00:00:00Z'), w(3, '2021-03-01T00:00:00Z'),   // 59d
  ]);
  assert.deepStrictEqual(spreadByGap(g, [0, 1, 7, 30]), [
    { days: 0, episodes: 3 },
    { days: 1, episodes: 2 },
    { days: 7, episodes: 1 },
    { days: 30, episodes: 1 },
  ]);
});

// ---------------- applyFixes ----------------

test('applying a fix writes the count, dates and a winning timestamp', () => {
  const library = lib([{ epId: 1, rewatchCount: 0, watchedAt: '2019-01-01T00:00:00Z', _t: 1, _seq: 5 }]);
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  const seq = applyFixes(library, planRepair(g, library), { now: 999, startSeq: 40 });
  assert.strictEqual(library[1].rewatchCount, 1);
  assert.deepStrictEqual(library[1].rewatches, ['2022-01-01T00:00:00Z']);
  assert.strictEqual(library[1].watchedAt, '2022-01-01T00:00:00Z', 'most recent viewing');
  assert.strictEqual(library[1]._t, 999, 'fresh _t so the fix wins the merge');
  assert.strictEqual(library[1]._seq, 41, 'continues the server sequence');
  assert.strictEqual(seq, 41, 'returns the new high-water mark');
});

test('sequence numbers keep climbing across several fixes', () => {
  const library = lib([{ epId: 1, rewatchCount: 0 }, { epId: 2, rewatchCount: 0 }]);
  const g = groupViewings([
    w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z'),
    w(2, '2019-01-01T00:00:00Z'), w(2, '2022-01-01T00:00:00Z'),
  ]);
  const seq = applyFixes(library, planRepair(g, library), { startSeq: 100 });
  assert.strictEqual(seq, 102);
  assert.deepStrictEqual([library[1]._seq, library[2]._seq].sort(), [101, 102]);
});

test('with rewatch dates off the count is written but no dates are', () => {
  const library = lib([{ epId: 1, rewatchCount: 0 }]);
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  applyFixes(library, planRepair(g, library), { keepDates: false });
  assert.strictEqual(library[1].rewatchCount, 1);
  assert.strictEqual(library[1].rewatches, undefined);
});

test('with rewatch dates off an existing dates array is left alone', () => {
  // app.js makes the same choice on a manual rewatch: stop adding, do not erase.
  const library = lib([{ epId: 1, rewatchCount: 0, rewatches: ['2020-05-05T00:00:00Z'] }]);
  const g = groupViewings([w(1, '2019-01-01T00:00:00Z'), w(1, '2022-01-01T00:00:00Z')]);
  applyFixes(library, planRepair(g, library), { keepDates: false });
  assert.deepStrictEqual(library[1].rewatches, ['2020-05-05T00:00:00Z']);
});

// ---------------- the two consumers must agree ----------------

test('repair and import reach the same rewatch count for the same viewings', () => {
  const cases = [
    ['2019-06-18T06:12:39Z', '2019-06-18T06:12:46Z'],   // 7s   — bulk marking
    ['2019-06-18T06:12:39Z', '2019-06-19T05:12:39Z'],   // 23h  — one session
    ['2021-01-01T00:00:00Z', '2021-01-03T00:00:00Z'],   // 2d   — a rewatch
    ['2019-04-06T07:23:49Z', '2020-02-01T04:59:29Z'],   // 301d — a rewatch
    ['2019-01-01T00:00:00Z', '2020-01-01T00:00:00Z', '2022-01-01T00:00:00Z'],
  ];
  for (const dates of cases) {
    const fromImport = collapseWatches(82, dates.map(d => ({ epId: 1, when: d })))[0].rewatchCount;
    const fixes = planRepair(groupViewings(dates.map(d => w(1, d))), lib([{ epId: 1, rewatchCount: 0 }]));
    const fromRepair = fixes.length ? fixes[0].to : 0;
    assert.strictEqual(fromRepair, fromImport, `disagreed on ${dates.join(' , ')}`);
  }
});
