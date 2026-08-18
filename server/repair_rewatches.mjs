#!/usr/bin/env node
// One-off repair for libraries imported before the rewatch collapse existed.
//
// TV Time logs a rewatch as its own row. The old importer wrote one record per
// row and let the last one win, so an episode watched twice ended up as a single
// watch with rewatchCount 0. The dates are still sitting in the backup file, so
// the counts can be reconstructed from it.
//
// Usage:
//   node repair_rewatches.mjs <username> [path/to/backup.json]       # dry run
//   node repair_rewatches.mjs <username> [backup] --apply            # write it
//   ... --min-gap-days=30                                            # stricter
//
// What counts as a rewatch lives in js/rewatch.js and is shared with the
// importer, so a library repaired by this script and a library imported fresh
// from the same export end up with the same counts.
//
// IMPORTANT: stop the sync server first. It holds each library in memory and
// rewrites these files on the next change.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepBeyond, viewings, DEFAULT_MIN_GAP_MS } from '../js/rewatch.js';

// Every distinct viewing timestamp the backup holds per episode, oldest first.
// No gap rule applied yet — planRepair and the spread table each apply their own.
export function groupViewings(backupWatched) {
  const byEp = new Map();
  for (const r of backupWatched || []) {
    if (r.epId == null || !r.watchedAt) continue;
    if (!byEp.has(r.epId)) byEp.set(r.epId, new Set());
    byEp.get(r.epId).add(r.watchedAt);
  }
  return new Map([...byEp].map(([epId, set]) => [epId, [...set].sort()]));
}

// Which records should gain a rewatch count, given the backup's viewings and the
// library as it stands. Skips episodes the library does not have, and records
// that already carry at least as many rewatches as the backup can justify — so
// running this twice, or after the user logged the rewatch by hand, is a no-op.
export function planRepair(groups, watched, minGapMs = DEFAULT_MIN_GAP_MS) {
  const fixes = [];
  for (const [epId, logged] of groups) {
    if (logged.length < 2) continue;
    const cur = watched[epId];
    if (!cur) continue;
    const kept = keepBeyond(logged, minGapMs);
    const from = cur.rewatchCount || 0;
    const countChanged = kept.length - 1 > from;
    // An episode whose extra viewings all collapsed gains no rewatch, but the
    // fact that it was logged more than once is still worth recording — those
    // are exactly the records where information was discarded.
    const provChanged = logged.length !== kept.length && cur.viewingsLogged !== logged.length;
    if (!countChanged && !provChanged) continue;
    fixes.push({
      epId, from, to: countChanged ? kept.length - 1 : from,
      dates: kept, logged: logged.length, countChanged,
    });
  }
  return fixes;
}

// How many episodes qualify at each threshold, so the choice of --min-gap-days
// is visible rather than assumed.
export function spreadByGap(groups, days = [0, 1, 7, 30]) {
  return days.map(d => {
    const gap = d * 86400000;
    const eps = [...groups.values()].filter(dates => viewings(dates, gap).length > 1).length;
    return { days: d, episodes: eps };
  });
}

// Apply the fixes in place. `_t` is bumped past every device so the correction
// wins the last-writer-wins merge; `_seq` continues the server's own sequence so
// devices pull it as a normal change.
export function applyFixes(watched, fixes, { keepDates = true, now = Date.now(), startSeq = 0 } = {}) {
  let seq = startSeq;
  for (const f of fixes) {
    const rec = watched[f.epId];
    if (f.countChanged) {
      rec.rewatchCount = f.to;
      // When the user has rewatch dates turned off, leave whatever is there alone
      // rather than writing new ones — same choice app.js makes on a manual rewatch.
      if (keepDates) rec.rewatches = f.dates.slice(1);
      rec.watchedAt = f.dates[f.dates.length - 1];
    }
    if (f.logged !== f.dates.length) rec.viewingsLogged = f.logged;
    rec._t = now;
    rec._seq = ++seq;
  }
  return seq;
}

// ---------------------------------------------------------------- CLI ----

function main(argv) {
  const flags = argv.filter(a => a.startsWith('--'));
  const positional = argv.filter(a => !a.startsWith('--'));

  const APPLY = flags.includes('--apply');
  const gapFlag = (flags.find(f => f.startsWith('--min-gap-days=')) || '').split('=')[1];
  const MIN_GAP_DAYS = gapFlag === undefined ? DEFAULT_MIN_GAP_MS / 86400000 : Number(gapFlag);
  if (!Number.isFinite(MIN_GAP_DAYS) || MIN_GAP_DAYS < 0) {
    console.error(`--min-gap-days must be a non-negative number, got "${gapFlag}"`);
    process.exit(1);
  }
  const username = (positional[0] || '').trim().toLowerCase();

  if (!username) {
    console.error('Usage: node repair_rewatches.mjs <username> [backup.json] [--apply] [--min-gap-days=N]');
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');
  const defaultDir = path.join(process.env.HOME || '', 'tv-time-export-SAFE');
  const backupPath = positional[1] ||
    ['endless-watch-backup.json', 'showtrack-backup.json']
      .map(f => path.join(defaultDir, f)).find(f => fs.existsSync(f));

  if (!backupPath || !fs.existsSync(backupPath)) {
    console.error('Backup file not found. Pass its path as the second argument.');
    process.exit(1);
  }

  const userDir = path.join(DATA_DIR, 'u_' + encodeURIComponent(username));
  const watchedFile = path.join(userDir, 'watched.json');
  if (!fs.existsSync(watchedFile)) {
    console.error(`No watched.json for "${username}" in ${DATA_DIR}`);
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const watched = JSON.parse(fs.readFileSync(watchedFile, 'utf8'));

  // Honour the user's own setting, the same one app.js and the importer read.
  const kvFile = path.join(userDir, 'kv.json');
  const kvStore = fs.existsSync(kvFile) ? JSON.parse(fs.readFileSync(kvFile, 'utf8')) : {};
  const keepDates = kvStore['settings:recordRewatchDates']?.v ?? true;

  const groups = groupViewings(backup.watched);
  const multi = [...groups.values()].filter(d => d.length > 1).length;
  const fixes = planRepair(groups, watched, MIN_GAP_DAYS * 86400000);

  console.log(`Backup:   ${backupPath}`);
  console.log(`Library:  ${watchedFile}`);
  console.log(`Rewatch dates: ${keepDates ? 'recorded' : 'off (counts only)'}`);
  console.log(`Episodes logged more than once: ${multi}`);
  console.log('Qualifying as rewatches by minimum gap:');
  for (const s of spreadByGap(groups)) {
    console.log(`  >= ${String(s.days).padStart(2)} day(s): ${s.episodes}`);
  }
  const gaining = fixes.filter(f => f.countChanged);
  const noting = fixes.filter(f => !f.countChanged);
  console.log(`\nUsing --min-gap-days=${MIN_GAP_DAYS}:`);
  console.log(`  ${gaining.length} record(s) gain a rewatch count`);
  console.log(`  ${noting.length} record(s) keep their count and are noted as logged more than once`);

  for (const f of gaining.slice(0, 20)) {
    console.log(`  ep ${String(f.epId).padEnd(8)} rewatchCount ${f.from} -> ${f.to}   ${f.dates.map(d => d.slice(0, 10)).join(' , ')}`);
  }
  if (gaining.length > 20) console.log(`  …and ${gaining.length - 20} more`);
  if (noting.length) {
    const [first] = noting;
    console.log(`  e.g. ep ${first.epId}: ${first.logged} viewings logged, ${first.dates.length} kept, still ${first.to} rewatch(es)`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to update the library.');
    return;
  }
  if (!fixes.length) {
    console.log('\nNothing to change.');
    return;
  }

  const metaFile = path.join(userDir, 'meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { seq: 0 };
  meta.seq = applyFixes(watched, fixes, { keepDates, startSeq: meta.seq || 0 });

  // Keep a copy of the pre-repair library; this is the only step that is not
  // reconstructible from the backup if the gap threshold turns out to be wrong.
  const bak = watchedFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(watchedFile, bak);

  const write = (file, obj) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  write(watchedFile, watched);
  write(metaFile, meta);

  console.log(`\nPrevious library saved to ${path.basename(bak)}`);
  console.log(`Updated ${fixes.length} record(s) — ${gaining.length} gained a rewatch, ${noting.length} noted only. Server seq now ${meta.seq}.`);
  console.log('Start the server; devices will sync the change down.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
