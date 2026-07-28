// The catalog proxy: the owner's API keys, used on behalf of signed-in accounts.
// The things that matter here are that it cannot be turned into a general-
// purpose proxy, that it never leaks a key, and that the shared cache actually
// protects the quota.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('../server/catalog.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ew-catalog-'));
const KEYS = { tmdb: 'tmdb-secret-key', rapidapi: 'rapid-secret-key' };

// ---------------- the vault ----------------

test('keys are written owner-only, like the VAPID key', () => {
  const dir = tmp();
  catalog.saveKeys(dir, KEYS);
  const mode = fs.statSync(path.join(dir, 'keys.json')).mode & 0o777;
  assert.strictEqual(mode, 0o600, `keys.json is ${mode.toString(8)}, expected 600`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty vault seeds itself from the environment', () => {
  const dir = tmp();
  process.env.TMDB_KEY = 'from-env';
  const keys = catalog.loadKeys(dir);
  delete process.env.TMDB_KEY;
  assert.strictEqual(keys.tmdb, 'from-env');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).tmdb, 'from-env',
    'seeding should persist, not be recomputed every boot');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keys already in the vault win over the environment', () => {
  const dir = tmp();
  catalog.saveKeys(dir, { tmdb: 'on-disk', rapidapi: '' });
  process.env.TMDB_KEY = 'from-env';
  const keys = catalog.loadKeys(dir);
  delete process.env.TMDB_KEY;
  assert.strictEqual(keys.tmdb, 'on-disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('keys are lifted out of an old library that still carries them', () => {
  const dir = tmp();
  const keys = { tmdb: '', rapidapi: '' };
  const loadUser = (u) => ({
    records: { kv: u === 'alex'
      ? { 'settings:tmdbKey': { v: 'lifted-tmdb' }, 'settings:rapidApiKey': { v: 'lifted-rapid' } }
      : {} },
  });
  const from = catalog.adoptKeysFromLibrary(dir, keys, ['someoneelse', 'alex'], loadUser);
  assert.strictEqual(from, 'alex');
  assert.strictEqual(keys.tmdb, 'lifted-tmdb');
  assert.strictEqual(keys.rapidapi, 'lifted-rapid');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')).tmdb, 'lifted-tmdb');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a vault that already has keys is never overwritten by a library', () => {
  const dir = tmp();
  const keys = { tmdb: 'mine', rapidapi: '' };
  const loadUser = () => ({ records: { kv: { 'settings:tmdbKey': { v: 'theirs' } } } });
  assert.strictEqual(catalog.adoptKeysFromLibrary(dir, keys, ['alex'], loadUser), null);
  assert.strictEqual(keys.tmdb, 'mine');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a user whose library cannot be read is skipped, not fatal', () => {
  const dir = tmp();
  const keys = { tmdb: '', rapidapi: '' };
  const loadUser = (u) => { if (u === 'broken') throw new Error('corrupt'); return { records: { kv: { 'settings:tmdbKey': { v: 'ok' } } } }; };
  assert.strictEqual(catalog.adoptKeysFromLibrary(dir, keys, ['broken', 'fine'], loadUser), 'fine');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- capabilities ----------------

test('capabilities say what works without revealing the keys', () => {
  assert.deepStrictEqual(catalog.capabilities(KEYS), { tmdb: true, availability: true });
  assert.deepStrictEqual(catalog.capabilities({ tmdb: 'x', rapidapi: '' }), { tmdb: true, availability: false });
  assert.deepStrictEqual(catalog.capabilities({ tmdb: '', rapidapi: '' }), { tmdb: false, availability: false });
  const serialized = JSON.stringify(catalog.capabilities(KEYS));
  assert.ok(!serialized.includes('secret'), 'a key must never ride along in capabilities');
});

// ---------------- the allowlist ----------------

test('only the named operations exist', () => {
  assert.deepStrictEqual(Object.keys(catalog.OPS).sort(), [
    'availability', 'external_ids', 'find_by_imdb', 'movie_recs', 'search_movie', 'tv_recs',
  ]);
});

test('an unknown operation is refused', async () => {
  for (const op of ['', 'nope', 'search_tv', '../../etc/passwd', 'constructor', '__proto__']) {
    await assert.rejects(() => catalog.run(KEYS, op, {}), (e) => {
      assert.strictEqual(e.status, 400);
      return true;
    }, `should refuse ${JSON.stringify(op)}`);
  }
});

// The whole point of an allowlist: there is no field that turns this into a
// general proxy. If one is ever added, this test should start failing.
test('no operation accepts a caller-supplied host, url or path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'catalog.js'), 'utf8');
  const ops = src.slice(src.indexOf('const OPS = {'), src.indexOf('// Runs one allowlisted'));
  for (const bad of ['p.url', 'p.host', 'p.path', 'p.endpoint', 'params.url']) {
    assert.ok(!ops.includes(bad), `catalog operations must not read ${bad} from the caller`);
  }
});

test('malformed parameters are rejected before any upstream call', async () => {
  const cases = [
    ['external_ids', { id: 'abc' }],
    ['external_ids', {}],
    ['movie_recs', { id: 'x' }],
    ['tv_recs', { id: null }],
    ['find_by_imdb', { imdbId: 'not-an-imdb-id' }],
    ['find_by_imdb', { imdbId: '../../secrets' }],
    ['availability', { imdbId: 'tt' }],
    ['availability', { imdbId: '' }],
  ];
  for (const [op, params] of cases) {
    await assert.rejects(() => catalog.run(KEYS, op, params), (e) => e.status === 400,
      `${op} ${JSON.stringify(params)} should be refused`);
  }
});

test('a missing key gives a clear 503 rather than an upstream error', async () => {
  await assert.rejects(() => catalog.run({ tmdb: '', rapidapi: 'x' }, 'search_movie', { query: 'dune' }),
    (e) => { assert.strictEqual(e.status, 503); assert.match(e.message, /TMDB/); return true; });
  await assert.rejects(() => catalog.run({ tmdb: 'x', rapidapi: '' }, 'availability', { imdbId: 'tt1160419' }),
    (e) => { assert.strictEqual(e.status, 503); assert.match(e.message, /availability/); return true; });
});

test('an error message never contains a key', async () => {
  for (const [op, params] of [['search_movie', { query: 'x' }], ['nope', {}]]) {
    try {
      await catalog.run({ tmdb: '', rapidapi: '' }, op, params);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(!e.message.includes('secret'), e.message);
    }
  }
});

// ---------------- caching, which is what protects the quota ----------------
// run() is exercised with a stub upstream by swapping the op's run function —
// the allowlist itself is what is under test everywhere else.

function withStub(op, impl, fn) {
  const real = catalog.OPS[op].run;
  catalog.OPS[op].run = impl;
  return Promise.resolve(fn()).finally(() => { catalog.OPS[op].run = real; });
}

test('a repeated lookup is served from cache, costing one upstream call', async () => {
  let calls = 0;
  await withStub('search_movie', async () => { calls++; return { results: [{ id: 1 }] }; }, async () => {
    const q = { query: `dune-${Math.random()}` };
    const a = await catalog.run(KEYS, 'search_movie', q);
    const b = await catalog.run(KEYS, 'search_movie', q);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(calls, 1, 'ten users opening one show must not cost ten calls');
  });
});

test('different parameters are cached separately', async () => {
  let calls = 0;
  await withStub('search_movie', async () => { calls++; return { results: [] }; }, async () => {
    const n = Math.random();
    await catalog.run(KEYS, 'search_movie', { query: `a-${n}` });
    await catalog.run(KEYS, 'search_movie', { query: `b-${n}` });
    assert.strictEqual(calls, 2);
  });
});

test('the cache key ignores case, so "Dune" and "dune" share a call', async () => {
  let calls = 0;
  await withStub('search_movie', async () => { calls++; return { results: [] }; }, async () => {
    const n = Math.random();
    await catalog.run(KEYS, 'search_movie', { query: `Dune-${n}` });
    await catalog.run(KEYS, 'search_movie', { query: `dune-${n}` });
    assert.strictEqual(calls, 1);
  });
});

test('concurrent identical lookups share one upstream flight', async () => {
  let calls = 0;
  await withStub('search_movie', async () => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    return { results: [] };
  }, async () => {
    const q = { query: `concurrent-${Math.random()}` };
    await Promise.all([1, 2, 3, 4, 5].map(() => catalog.run(KEYS, 'search_movie', q)));
    assert.strictEqual(calls, 1, 'five devices syncing at once is one call, not five');
  });
});

test('a failed lookup is not cached for hours', async () => {
  let calls = 0;
  await withStub('search_movie', async () => { calls++; return calls === 1 ? null : { results: [1] }; }, async () => {
    const q = { query: `flaky-${Math.random()}` };
    assert.strictEqual(await catalog.run(KEYS, 'search_movie', q), null);
    assert.deepStrictEqual(await catalog.run(KEYS, 'search_movie', q), { results: [1] });
    assert.strictEqual(calls, 2, 'a blip must not suppress the next hour of lookups');
  });
});

test('an upstream that throws does not poison the cache', async () => {
  let calls = 0;
  await withStub('search_movie', async () => { calls++; if (calls === 1) throw new Error('boom'); return { ok: 1 }; }, async () => {
    const q = { query: `throwy-${Math.random()}` };
    await assert.rejects(() => catalog.run(KEYS, 'search_movie', q));
    assert.deepStrictEqual(await catalog.run(KEYS, 'search_movie', q), { ok: 1 });
  });
});
