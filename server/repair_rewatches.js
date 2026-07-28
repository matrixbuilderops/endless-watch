#!/usr/bin/env node
// One-off repair for libraries imported before collapseWatches existed.
//
// TV Time logs a rewatch as its own row. The old importer wrote one record per
// row and let the last one win, so an episode watched twice ended up as a single
// watch with rewatchCount 0. The dates are still sitting in the backup file, so
// the counts can be reconstructed from it.
//
// Usage:
//   node repair_rewatches.js <username> [path/to/backup.json]        # dry run
//   node repair_rewatches.js <username> [backup] --apply             # write it
//   ... --min-gap-days=30                                            # stricter
//
// Two viewings logged within --min-gap-days of each other are treated as one
// viewing double-logged, not a rewatch. Default 1 day: marking a whole season
// watched in one sitting produces near-identical timestamps, and those are not
// rewatches. Raise it if you want only unambiguous ones.
//
// IMPORTANT: stop the sync server first. It holds each library in memory and
// rewrites these files on the next change.

'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));

const APPLY = flags.includes('--apply');
const MIN_GAP_DAYS = Number((flags.find(f => f.startsWith('--min-gap-days=')) || '').split('=')[1] || 1);
const username = (positional[0] || '').trim().toLowerCase();

if (!username) {
  console.error('Usage: node repair_rewatches.js <username> [backup.json] [--apply] [--min-gap-days=N]');
  process.exit(1);
}

const defaultDir = path.join(process.env.HOME || '', 'tv-time-export-SAFE');
const backupPath = positional[1] ||
  ['endless-watch-backup.json', 'showtrack-backup.json']
    .map(f => path.join(defaultDir, f)).find(f => fs.existsSync(f));

if (!backupPath || !fs.existsSync(backupPath)) {
  console.error('Backup file not found. Pass its path as the second argument.');
  process.exit(1);
}

const watchedFile = path.join(DATA_DIR, 'u_' + encodeURIComponent(username), 'watched.json');
if (!fs.existsSync(watchedFile)) {
  console.error(`No watched.json for "${username}" in ${DATA_DIR}`);
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const watched = JSON.parse(fs.readFileSync(watchedFile, 'utf8'));

// group every logged viewing per episode, dropping exact-duplicate timestamps
const byEp = new Map();
for (const r of backup.watched || []) {
  if (r.epId == null || !r.watchedAt) continue;
  if (!byEp.has(r.epId)) byEp.set(r.epId, new Set());
  byEp.get(r.epId).add(r.watchedAt);
}

const gapMs = MIN_GAP_DAYS * 86400000;
const spread = { 0: 0, 1: 0, 7: 0, 30: 0 };   // how many qualify at each threshold
const fixes = [];

for (const [epId, set] of byEp) {
  if (set.size < 2) continue;
  const dates = [...set].sort();
  for (const d of Object.keys(spread)) {
    const kept = keepBeyond(dates, Number(d) * 86400000);
    if (kept.length > 1) spread[d]++;
  }
  const kept = keepBeyond(dates, gapMs);
  if (kept.length < 2) continue;

  const cur = watched[epId];
  if (!cur) continue;                                  // episode not in the library
  if ((cur.rewatchCount || 0) >= kept.length - 1) continue;  // already recorded
  fixes.push({ epId, from: cur.rewatchCount || 0, to: kept.length - 1, dates: kept });
}

// keep the first viewing, then any that is at least `gap` after the one kept before it
function keepBeyond(sorted, gap) {
  const out = [sorted[0]];
  for (const d of sorted.slice(1)) {
    if (new Date(d) - new Date(out[out.length - 1]) >= gap) out.push(d);
  }
  return out;
}

console.log(`Backup:   ${backupPath}`);
console.log(`Library:  ${watchedFile}`);
console.log(`Episodes logged more than once: ${[...byEp.values()].filter(s => s.size > 1).length}`);
console.log('Qualifying as rewatches by minimum gap:');
for (const d of Object.keys(spread)) console.log(`  >= ${String(d).padStart(2)} day(s): ${spread[d]}`);
console.log(`\nUsing --min-gap-days=${MIN_GAP_DAYS}: ${fixes.length} record(s) would gain a rewatch count.`);

for (const f of fixes.slice(0, 20)) {
  console.log(`  ep ${String(f.epId).padEnd(8)} rewatchCount ${f.from} -> ${f.to}   ${f.dates.map(d => d.slice(0, 10)).join(' , ')}`);
}
if (fixes.length > 20) console.log(`  …and ${fixes.length - 20} more`);

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to update the library.');
  process.exit(0);
}

const now = Date.now();
let seq = 0;
const metaFile = path.join(path.dirname(watchedFile), 'meta.json');
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { seq: 0 };
seq = meta.seq || 0;

for (const f of fixes) {
  const rec = watched[f.epId];
  rec.rewatchCount = f.to;
  rec.rewatches = f.dates.slice(1);
  rec.watchedAt = f.dates[f.dates.length - 1];
  rec._t = now;                 // newer than every device, so the fix wins the merge
  rec._seq = ++seq;
}
meta.seq = seq;

const write = (file, obj) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
};
write(watchedFile, watched);
write(metaFile, meta);

console.log(`\nUpdated ${fixes.length} record(s). Start the server; devices will sync the change down.`);
