#!/usr/bin/env node
// Reconcile a backup file against a server library, row by row.
//
// Written to answer one question — the backup held more rows than the server, so
// what was lost? — and kept because the answer (nothing; the extra rows are
// duplicate ids from the original TV Time conversion) is only convincing if it
// can be re-derived. It also produces the gap distribution that sets the default
// rewatch threshold in js/rewatch.js.
//
// Reads only. Prints counts, field names and dates; never record values, because
// the kv store holds API keys.
//
// Usage:
//   node analyze_backup.mjs <backup.json> [data/u_<username>]

import fs from 'node:fs';
import path from 'node:path';
import { viewings, DEFAULT_MIN_GAP_MS } from '../js/rewatch.js';

const [backupPath, libDir] = process.argv.slice(2);
if (!backupPath) {
  console.error('Usage: node analyze_backup.mjs <backup.json> [data/u_<username>]');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const ID = { shows: 'id', episodes: 'id', watched: 'epId', movies: 'id', watchlist: 'id', lists: 'id', kv: 'k' };
// Field order varies between rows, so compare on sorted keys.
const canonical = (o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
const rule = (s) => console.log('\n' + '='.repeat(70) + '\n' + s + '\n' + '='.repeat(70));

rule('PER-STORE RECONCILIATION');
console.log('store        rows  distinct  dupRows  identical  differing   server  match');

const differing = {};
for (const store of Object.keys(ID)) {
  const rows = backup[store] || [];
  const groups = new Map();
  for (const r of rows) {
    const id = r[ID[store]];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  let identical = 0;
  const fields = new Map();
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    if (new Set(g.map(canonical)).size === 1) { identical++; continue; }
    for (const f of new Set(g.flatMap(Object.keys))) {
      if (new Set(g.map(r => JSON.stringify(r[f]))).size > 1) fields.set(f, (fields.get(f) || 0) + 1);
    }
  }
  const dupGroups = [...groups.values()].filter(g => g.length > 1).length;
  differing[store] = fields;

  let server = null;
  if (libDir) {
    const f = path.join(libDir, store + '.json');
    if (fs.existsSync(f)) server = Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))).length;
  }
  // The claim under test: every distinct id in the backup is present on the
  // server, so the extra rows are duplicates rather than lost records.
  const match = server === null ? '-' : server === groups.size ? 'YES' : `NO (${groups.size - server})`;
  console.log(
    store.padEnd(11), String(rows.length).padStart(6), String(groups.size).padStart(9),
    String(rows.length - groups.size).padStart(8), String(identical).padStart(10),
    String(dupGroups - identical).padStart(10), String(server).padStart(8), ' ' + match);
}

rule('WHICH FIELDS DIFFER INSIDE A DUPLICATE GROUP');
for (const [store, fields] of Object.entries(differing)) {
  if (!fields.size) continue;
  console.log(store + ':');
  for (const [f, n] of [...fields].sort((a, b) => b[1] - a[1])) console.log('  ' + f.padEnd(18) + n + ' group(s)');
}

// ---- the rewatch question ----
const byEp = new Map();
for (const r of backup.watched || []) {
  if (r.epId == null || !r.watchedAt) continue;
  if (!byEp.has(r.epId)) byEp.set(r.epId, new Set());
  byEp.get(r.epId).add(r.watchedAt);
}
const multi = [...byEp.entries()].map(([epId, s]) => [epId, [...s].sort()]).filter(([, d]) => d.length > 1);

rule('EPISODES BY NUMBER OF DISTINCT VIEWING TIMESTAMPS');
const dist = new Map();
for (const [, s] of byEp) dist.set(s.size, (dist.get(s.size) || 0) + 1);
for (const [n, c] of [...dist].sort((a, b) => a[0] - b[0])) console.log(`  ${n}: ${c} episode(s)`);

rule('GAPS BETWEEN CONSECUTIVE VIEWINGS');
const gaps = [];
for (const [epId, d] of multi) {
  for (let i = 1; i < d.length; i++) gaps.push({ epId, ms: new Date(d[i]) - new Date(d[i - 1]), a: d[i - 1], z: d[i] });
}
gaps.sort((x, y) => x.ms - y.ms);
console.log(`  ${gaps.length} consecutive pair(s) across ${multi.length} episode(s)\n`);
let prev = 0;
for (const [label, lim] of [['< 1 min', 60000], ['< 1 hour', 3600000], ['< 6 hours', 6 * 3600000],
  ['< 1 day', 86400000], ['< 7 days', 7 * 86400000], ['< 30 days', 30 * 86400000],
  ['< 1 year', 365 * 86400000], ['>= 1 year', Infinity]]) {
  console.log('  ' + label.padEnd(12) + String(gaps.filter(g => g.ms >= prev && g.ms < lim).length).padStart(5));
  prev = lim;
}
// The threshold is only defensible if it falls in a band where no data sits —
// otherwise it is splitting a cluster of similar gaps and the choice is
// arbitrary. Report the nearest observed gap on each side of it.
const h = (ms) => ms < 3600000 ? `${(ms / 1000).toFixed(0)}s` : ms < 86400000 ? `${(ms / 3600000).toFixed(1)}h` : `${(ms / 86400000).toFixed(1)}d`;
const below = gaps.filter(g => g.ms < DEFAULT_MIN_GAP_MS).pop();
const above = gaps.find(g => g.ms >= DEFAULT_MIN_GAP_MS);
if (below && above) {
  console.log(`\n  default threshold ${h(DEFAULT_MIN_GAP_MS)} sits between observed gaps ${h(below.ms)} and ${h(above.ms)}`);
  // A wide empty band means the two shapes really are distinct; a narrow one
  // means episodes near the line could go either way.
  const ratio = above.ms / below.ms;
  console.log(ratio >= 2
    ? `  the band is ${ratio.toFixed(1)}x wide — the two shapes are clearly separated`
    : `  the band is only ${ratio.toFixed(1)}x wide — the threshold is splitting similar gaps, revisit js/rewatch.js`);
}

rule('HOW MANY QUALIFY AS REWATCHES AT EACH THRESHOLD');
for (const days of [0, 1 / 1440, 1 / 24, 0.25, 1, 7, 30, 365]) {
  let eps = 0, total = 0;
  for (const [, d] of multi) {
    const kept = viewings(d, days * 86400000);
    if (kept.length > 1) { eps++; total += kept.length - 1; }
  }
  const label = days === 0 ? 'exact dup only' : days < 1 ? `${(days * 24).toFixed(2)} h` : `${days} day(s)`;
  console.log('  ' + label.padEnd(16) + `${String(eps).padStart(5)} episode(s), ${total} rewatch(es)`);
}

if (libDir && fs.existsSync(path.join(libDir, 'watched.json'))) {
  rule('WHAT THE LIBRARY ALREADY RECORDS');
  const lib = JSON.parse(fs.readFileSync(path.join(libDir, 'watched.json'), 'utf8'));
  const recorded = Object.values(lib).filter(r => (r.rewatchCount || 0) > 0).length;
  const dated = Object.values(lib).filter(r => r.rewatches).length;
  const absent = multi.filter(([epId]) => !lib[epId]).length;
  const pending = multi.filter(([epId, d]) =>
    viewings(d, DEFAULT_MIN_GAP_MS).length > 1 && lib[epId] && !(lib[epId].rewatchCount > 0)).length;
  console.log(`  records with rewatchCount > 0     : ${recorded}`);
  console.log(`  records with a rewatches array    : ${dated}`);
  console.log(`  multi-viewing episodes not in lib : ${absent}`);
  console.log(`  repairable at the default gap     : ${pending}`);
}
