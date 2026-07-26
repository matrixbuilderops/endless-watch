#!/usr/bin/env node
// Load an Endless Watch backup JSON straight into a user's server library, so
// every device syncs it down instead of restoring the (large) file on the phone.
//
// Usage:
//   node import_backup.js <username> [path/to/backup.json]
// With no path it looks in ~/tv-time-export-SAFE for endless-watch-backup.json,
// then showtrack-backup.json (what exports were called before the rename).
//
// IMPORTANT: stop the sync server before running this. The server keeps each
// user's library in memory and rewrites these files on the next change, so an
// import done while it's running can be overwritten. Stop it, import, start it.

'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const KEY_FIELD = { shows: 'id', episodes: 'id', watched: 'epId', movies: 'id', watchlist: 'id', lists: 'id', kv: 'k' };

// Marker written inside every backup file. Kept as the app's original name so
// backups exported before the rename still load — see js/db.js.
const BACKUP_MARKER = 'showtrack';

const username = (process.argv[2] || '').trim().toLowerCase();
const defaultDir = path.join(process.env.HOME || '', 'tv-time-export-SAFE');
const backupPath = process.argv[3] ||
  [ 'endless-watch-backup.json', 'showtrack-backup.json' ]   // new name first, then the old one
    .map(f => path.join(defaultDir, f))
    .find(f => fs.existsSync(f)) ||
  path.join(defaultDir, 'endless-watch-backup.json');

if (!username) {
  console.error('Usage: node import_backup.js <username> [path/to/backup.json]');
  process.exit(1);
}
// must be a real account (created via the app or /api/register)
const usersFile = path.join(DATA_DIR, 'users.json');
const users = fs.existsSync(usersFile) ? JSON.parse(fs.readFileSync(usersFile, 'utf8')) : {};
if (!users[username]) {
  console.error(`No account "${username}" on this server (${DATA_DIR}).`);
  console.error('Create it first: open the app, More → Account & sync → Create account.');
  process.exit(1);
}
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
if (backup.app !== BACKUP_MARKER) {
  console.error('That file is not an Endless Watch backup.');
  process.exit(1);
}

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJSON(f, o) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }

const dir = path.join(DATA_DIR, 'u_' + encodeURIComponent(username));
fs.mkdirSync(dir, { recursive: true });
const meta = readJSON(path.join(dir, 'meta.json'), { seq: 0, tombstones: {}, lastCheck: {} });
meta.tombstones = meta.tombstones || {};
let seq = meta.seq || 0;

const dateFrom = (item) => {
  for (const k of ['followedAt', 'watchedAt', 'addedAt', 'createdAt']) {
    if (item[k]) { const t = new Date(item[k]).getTime(); if (!isNaN(t)) return t; }
  }
  return Date.now();
};

console.log(`Importing "${backupPath}" into account "${username}"…`);
let total = 0;
for (const store of STORES) {
  const kf = KEY_FIELD[store];
  const file = path.join(dir, `${store}.json`);
  const records = readJSON(file, {});
  const incoming = backup[store] || [];
  let applied = 0;
  for (const item of incoming) {
    const id = item[kf];
    if (id == null) continue;
    // preserve the backup's own _t (from the app), else derive from date fields
    const t = item._t || dateFrom(item);
    const cur = records[id];
    if (cur && (cur._t || 0) > t) continue;          // existing is newer → keep it (last-writer-wins)
    records[id] = { ...item, _t: t, _seq: ++seq };
    applied++;
  }
  writeJSON(file, records);
  total += applied;
  console.log(`  ${store}: ${applied} imported, ${Object.keys(records).length} total`);
}

meta.seq = seq;
writeJSON(path.join(dir, 'meta.json'), meta);
console.log(`Done. ${total} records imported, server seq now ${seq}.`);
console.log('Start the server and your devices will sync this library down.');
