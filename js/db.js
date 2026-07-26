// IndexedDB data layer. All user data lives here, on-device.
// Every record carries `_t` (last-modified ms, client clock) so the sync
// server can do last-writer-wins merges; deletions leave a tombstone.
// A record changed on this device also carries `_dirty` until the server
// accepts it — device-local bookkeeping, stripped before upload.
// Stores:
//   shows     { id (tvmaze), name, image, status, premiered, network, tvdbId, imdbId,
//               genres, followedAt, archived, platform, private, lastEpisodeSync, _t }
//   episodes  { id (tvmaze ep), showId, season, number, name, airdate, airstamp, runtime, type, _t }
//   watched   { epId, showId, watchedAt, progress, rewatchCount, rewatches, source, _t }
//   movies    { id (uuid), title, tmdbId, imdbId, poster, watchedAt, progress,
//               rewatchCount, rewatches, platform, private, rating, source, _t }
//   watchlist { id (uuid), type, title, tvmazeId, imdbId, addedAt, _t }
//   lists     { id (uuid), name, isPublic, items, _t }
//   kv        { k, v, _t }
//   _tombstones { tkey ("store|id"), store, id, _t }

// ---- storage identifiers ----
// Not the product name. These are the keys this device's data is already filed
// under: the IndexedDB database, the localStorage namespace, and the marker
// written into every backup file ever exported. Renaming one makes every device
// open an empty library and stops existing backups from loading, so changing
// them is a data migration, not a find-and-replace. They stay 'showtrack' from
// the app's first name — the rename to The Endless Watch is user-facing only.
const DB_NAME = 'showtrack';
const LOCAL_PREFIX = 'showtrack:';
const BACKUP_MARKER = 'showtrack';

const DB_VERSION = 3;

// key field per synced store, used for tombstones and sync apply
export const KEY_FIELD = {
  shows: 'id', episodes: 'id', watched: 'epId',
  movies: 'id', watchlist: 'id', lists: 'id', kv: 'k',
};
export const SYNC_STORES = Object.keys(KEY_FIELD);

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (s) => db.objectStoreNames.contains(s);
      if (!has('shows')) db.createObjectStore('shows', { keyPath: 'id' });
      if (!has('episodes')) {
        const eps = db.createObjectStore('episodes', { keyPath: 'id' });
        eps.createIndex('showId', 'showId');
      }
      if (!has('watched')) {
        const w = db.createObjectStore('watched', { keyPath: 'epId' });
        w.createIndex('showId', 'showId');
      }
      if (!has('movies')) db.createObjectStore('movies', { keyPath: 'id' });
      if (!has('watchlist')) db.createObjectStore('watchlist', { keyPath: 'id' });
      if (!has('lists')) db.createObjectStore('lists', { keyPath: 'id' });
      if (!has('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!has('_tombstones')) db.createObjectStore('_tombstones', { keyPath: 'tkey' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// tx(store | [stores], mode, fn) — fn receives (primaryObjectStore, transaction).
// Resolves when the transaction commits.
function tx(store, mode, fn) {
  const stores = Array.isArray(store) ? store : [store];
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    fn(t.objectStore(stores[0]), t);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqAsPromise(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

// Composite tombstone key. The separator was a literal NUL byte, which made this
// whole file count as binary — git showed it as "Bin" instead of a diff, and grep
// skipped it silently. `|` can't appear in a store name, so it can't collide.
// Tombstones written under the old key are simply never matched by put()'s clear;
// they still push once and are dropped after (see dropTombstones), and a
// resurrected record outranks them on `_t` server-side.
const tkeyOf = (store, id) => `${store}|${id}`;

export const db = {
  get: (store, key) => reqAsPromise(store, 'readonly', s => s.get(key)),
  all: (store) => reqAsPromise(store, 'readonly', s => s.getAll()),
  allByIndex: (store, index, value) =>
    reqAsPromise(store, 'readonly', s => s.index(index).getAll(value)),
  count: (store) => reqAsPromise(store, 'readonly', s => s.count()),

  // Local writes stamp `_t`, mark the record dirty so sync knows to upload it,
  // and clear any tombstone so the record resurrects.
  put: (store, obj) => {
    obj._t = Date.now();
    obj._dirty = 1;
    return tx([store, '_tombstones'], 'readwrite', (os, t) => {
      os.put(obj);
      t.objectStore('_tombstones').delete(tkeyOf(store, obj[KEY_FIELD[store]]));
    });
  },
  putMany: (store, objs) => {
    const now = Date.now();
    return tx([store, '_tombstones'], 'readwrite', (os, t) => {
      const ts = t.objectStore('_tombstones');
      for (const o of objs) { o._t = now; o._dirty = 1; os.put(o); ts.delete(tkeyOf(store, o[KEY_FIELD[store]])); }
    });
  },
  del: (store, key) => tx([store, '_tombstones'], 'readwrite', (os, t) => {
    os.delete(key);
    t.objectStore('_tombstones').put({ tkey: tkeyOf(store, key), store, id: key, _t: Date.now() });
  }),
  delMany: (store, keys) => tx([store, '_tombstones'], 'readwrite', (os, t) => {
    const ts = t.objectStore('_tombstones'), now = Date.now();
    for (const k of keys) { os.delete(k); ts.put({ tkey: tkeyOf(store, k), store, id: k, _t: now }); }
  }),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),

  // Raw variants used ONLY by the sync engine: never re-stamp or tombstone,
  // so a record pulled from the server keeps its origin device's `_t`.
  putRaw: (store, obj) => tx(store, 'readwrite', s => s.put(obj)),
  putManyRaw: (store, objs) => tx(store, 'readwrite', s => { for (const o of objs) s.put(o); }),
  delRaw: (store, key) => tx(store, 'readwrite', s => s.delete(key)),

  // Apply a page of pulled records/deletes in ONE transaction (last-writer-wins
  // by _t). No tombstones written — remote deletes don't need re-propagating.
  applyBatch: (store, records, deletes) => tx(store, 'readwrite', (os) => {
    const kf = KEY_FIELD[store];
    for (const rec of records || []) {
      const g = os.get(rec[kf]);
      g.onsuccess = () => { const cur = g.result; if (!cur || (cur._t || 0) <= (rec._t || 0)) os.put(rec); };
    }
    for (const d of deletes || []) {
      const g = os.get(d.id);
      g.onsuccess = () => { const cur = g.result; if (cur && (cur._t || 0) <= (d._t || 0)) os.delete(d.id); };
    }
  }),

  // ---- what this device still owes the server ----
  // `_dirty` is a local-only marker set by put/putMany and never sent. It
  // replaced a "records with _t newer than my last push" watermark, which broke
  // whenever another device's clock ran fast: pulling its records dragged the
  // watermark into the future and this device's own edits silently stopped
  // uploading until the clock caught up.
  dirty: (store) => db.all(store).then(rows => rows.filter(r => r._dirty)),

  // Unmark records the server has accepted. `sent` is [{ id, _t }] — a record
  // edited again mid-sync has a newer `_t` and stays dirty.
  clearDirty: (store, sent) => tx(store, 'readwrite', (os) => {
    for (const s of sent) {
      const g = os.get(s.id);
      g.onsuccess = () => {
        const cur = g.result;
        if (cur && cur._dirty && (cur._t || 0) === s._t) { delete cur._dirty; os.put(cur); }
      };
    }
  }),

  allTombstones: () => db.all('_tombstones'),

  // A tombstone only has to reach the server once; it keeps its own and fans it
  // out to other devices. Dropping ours also stops _tombstones growing forever.
  dropTombstones: (tombs) => tx('_tombstones', 'readwrite', (os) => {
    for (const t of tombs) {
      const g = os.get(t.tkey);
      g.onsuccess = () => { const cur = g.result; if (cur && cur._t === t._t) os.delete(t.tkey); };
    }
  }),
};

export const kv = {
  get: (k, dflt = null) => db.get('kv', k).then(r => (r ? r.v : dflt)),
  set: (k, v) => db.put('kv', { k, v }),
  del: (k) => db.del('kv', k),
};

// Device-local sync state (token, server URL, watermarks) lives in
// localStorage, NOT kv, so it is never itself synced between devices.
export const local = {
  get: (k, dflt = null) => { const v = localStorage.getItem(LOCAL_PREFIX + k); return v === null ? dflt : JSON.parse(v); },
  set: (k, v) => localStorage.setItem(LOCAL_PREFIX + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(LOCAL_PREFIX + k),
};

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxx-xxxx-xxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

// One-time: stamp `_t` on any record predating change-tracking so it will sync.
export async function migrateStamps() {
  if (local.get('migratedStamps')) return;
  const now = Date.now();
  for (const store of SYNC_STORES) {
    const rows = await db.all(store);
    const need = rows.filter(r => !r._t);
    if (need.length) { for (const r of need) r._t = now; await db.putManyRaw(store, need); }
  }
  local.set('migratedStamps', true);
}

// One-time: carry the old `sync:lastPushT` watermark over to `_dirty` markers,
// so anything this device hadn't uploaded yet still gets uploaded. A device that
// never synced has no watermark, so everything is marked — which is correct.
export async function migrateDirty() {
  if (local.get('migratedDirty')) return;
  const since = local.get('sync:lastPushT', 0);
  for (const store of SYNC_STORES) {
    const rows = await db.all(store);
    const need = rows.filter(r => (r._t || 0) > since && !r._dirty);
    if (need.length) { for (const r of need) r._dirty = 1; await db.putManyRaw(store, need); }
  }
  local.del('sync:lastPushT');
  local.set('migratedDirty', true);
}

// ---- backup / restore ----

export async function exportAll() {
  const out = { app: BACKUP_MARKER, version: DB_VERSION, exportedAt: new Date().toISOString() };
  for (const s of SYNC_STORES) out[s] = await db.all(s);
  return out;
}

export async function importAll(data, { merge = false } = {}) {
  if (!data || data.app !== BACKUP_MARKER) throw new Error('Not an Endless Watch backup file');
  for (const s of SYNC_STORES) {
    if (!Array.isArray(data[s])) continue;
    if (!merge) await db.clear(s);
    await db.putMany(s, data[s]);   // stamps _t so a restored library syncs up
  }
}
