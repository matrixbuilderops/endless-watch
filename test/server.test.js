// Integration tests for the sync server. Spawns a real server on a throwaway
// port against a temp DATA_DIR, so nothing here touches your real library.
// Run: node --test test/

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir;

// Raw request helper: sends `rawPath` verbatim so traversal/NUL probes reach the
// server un-normalized (fetch() would rewrite them before they ever leave).
function raw(rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(route, payload) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-watch-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  // poll until it answers
  for (let i = 0; i < 100; i++) {
    try { await raw('/api/health'); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('server did not start');
});

after(() => {
  if (proc) proc.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------- accounts ----------------

test('health responds before anyone registers', async () => {
  const res = await fetch(BASE + '/api/health');
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.users, 0);
});

test('register issues a token', async () => {
  const { status, body } = await post('/api/register', { username: 'Alex', password: 'correct-horse' });
  assert.strictEqual(status, 200);
  assert.match(body.token, /^[a-f0-9]{32,}$/);
  assert.strictEqual(body.username, 'alex');   // normalized to lowercase
});

test('the same username cannot be registered twice', async () => {
  const { status } = await post('/api/register', { username: 'alex', password: 'another' });
  assert.notStrictEqual(status, 200);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const ok = await post('/api/login', { username: 'alex', password: 'correct-horse' });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.token);

  const bad = await post('/api/login', { username: 'alex', password: 'wrong' });
  assert.notStrictEqual(bad.status, 200);
  assert.ok(!bad.body.token);
});

test('an unknown token cannot read anyone data', async () => {
  const { status } = await post('/api/pull', { token: 'deadbeef'.repeat(8), since: 0 });
  assert.notStrictEqual(status, 200);
});

// ---------------- sync ----------------

let token;

test('push then pull round-trips a record', async () => {
  token = (await post('/api/login', { username: 'alex', password: 'correct-horse' })).body.token;

  const rec = { id: 82, name: 'Game of Thrones', _t: Date.now() };
  const pushed = await post('/api/push', { token, store: 'shows', records: [rec], deletes: [] });
  assert.strictEqual(pushed.status, 200);
  assert.strictEqual(pushed.body.ok, true);

  const pulled = await post('/api/pull', { token, since: 0 });
  assert.strictEqual(pulled.status, 200);
  const shows = pulled.body.records.shows || [];
  assert.strictEqual(shows.length, 1);
  assert.strictEqual(shows[0].name, 'Game of Thrones');
  assert.strictEqual(shows[0].id, 82);          // numeric id keeps its type
});

test('a delete propagates as a tombstone', async () => {
  await post('/api/push', { token, store: 'shows', records: [], deletes: [{ id: 82, _t: Date.now() + 1 }] });
  const pulled = await post('/api/pull', { token, since: 0 });
  assert.ok(pulled.body.deletes.some(d => d.id === 82 && d.store === 'shows'));
  assert.strictEqual((pulled.body.records.shows || []).length, 0);
});

// Regression: the push watermark relies on re-pushing a record the server
// already holds being a no-op. When the merge used `>` instead of `>=` it
// re-stamped _seq, so every device pulled a "change" that wasn't one.
test('re-pushing an unchanged record is a no-op', async () => {
  const rec = { id: 99, name: 'Severance', _t: 1700000000000 };
  await post('/api/push', { token, store: 'shows', records: [rec], deletes: [] });
  const first = await post('/api/pull', { token, since: 0 });
  const seqAfterFirst = first.body.serverSeq;

  await post('/api/push', { token, store: 'shows', records: [rec], deletes: [] });
  const second = await post('/api/pull', { token, since: seqAfterFirst });
  assert.strictEqual(second.body.serverSeq, seqAfterFirst, 'seq should not move');
  assert.strictEqual((second.body.records.shows || []).length, 0, 'nothing new to pull');
});

// A device whose clock runs behind its peers must still be able to publish. The
// server keeps per-record last-writer-wins, so an older _t on a *different*
// record is accepted normally — only the same record is protected.
test('a record from a slow-clocked device still syncs', async () => {
  const future = { id: 501, name: 'From the fast device', _t: Date.now() + 7 * 86400000 };
  await post('/api/push', { token, store: 'shows', records: [future], deletes: [] });

  const behind = { id: 502, name: 'From the slow device', _t: Date.now() - 60000 };
  const res = await post('/api/push', { token, store: 'shows', records: [behind], deletes: [] });
  assert.strictEqual(res.status, 200);

  const pulled = await post('/api/pull', { token, since: 0 });
  const names = (pulled.body.records.shows || []).map(s => s.name);
  assert.ok(names.includes('From the slow device'), 'slow device record must be stored');
});

test('pushing to an unknown store is rejected', async () => {
  const { status } = await post('/api/push', { token, store: 'not_a_store', records: [], deletes: [] });
  assert.strictEqual(status, 400);
});

test('malformed JSON is rejected without killing the server', async () => {
  const res = await fetch(BASE + '/api/push', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await (await fetch(BASE + '/api/health')).json()).ok, true);
});

// ---------------- static serving / hardening ----------------

test('the app itself is served', async () => {
  const { status, body } = await raw('/index.html');
  assert.strictEqual(status, 200);
  assert.match(body, /<html|<!doctype/i);
});

// Regression: GET /%00 decoded to a NUL, which made fs.readFile throw
// synchronously inside an async handler -> unhandled rejection -> exit(1).
// Any web page could fetch it and drop the sync server.
test('a NUL in the path is rejected and the server survives a barrage', async () => {
  for (let i = 0; i < 25; i++) {
    const { status } = await raw('/%00');
    assert.strictEqual(status, 400);
  }
  const health = await (await fetch(BASE + '/api/health')).json();
  assert.strictEqual(health.ok, true);
});

test('path traversal out of the app directory is forbidden', async () => {
  for (const p of ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const { status } = await raw(p);
    assert.strictEqual(status, 403, `expected 403 for ${p}`);
  }
});

test('the server directory is not reachable over HTTP', async () => {
  // secrets live here: users.json, tokens.json, vapid.json
  for (const p of ['/server/server.js', '/server/data/users.json', '/server/data/vapid.json']) {
    const { status } = await raw(p);
    assert.strictEqual(status, 403, `expected 403 for ${p}`);
  }
});

// Regression: the guard only blocked server/, but APP_DIR is the repo root, so
// GET /.git/config returned 200 — the whole history was downloadable.
test('nothing outside the web app is served', async () => {
  for (const p of ['/.git/config', '/.git/HEAD', '/.git/logs/HEAD', '/package.json', '/SETUP.md', '/test/server.test.js']) {
    const { status } = await raw(p);
    assert.strictEqual(status, 403, `expected 403 for ${p}`);
  }
});

test('the app shell is still reachable', async () => {
  for (const p of ['/', '/index.html', '/js/app.js', '/css/style.css', '/sw.js', '/manifest.webmanifest']) {
    const { status } = await raw(p);
    assert.strictEqual(status, 200, `expected 200 for ${p}`);
  }
});

test('CORS is not opened to every origin by default', async () => {
  const res = await fetch(BASE + '/api/health');
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
});

// ---------------- session revocation ----------------

test('logout revokes the session it presents', async () => {
  const t = (await post('/api/login', { username: 'alex', password: 'correct-horse' })).body.token;
  assert.strictEqual((await post('/api/pull', { token: t, since: 0 })).status, 200);

  const out = await post('/api/logout', { token: t });
  assert.strictEqual(out.body.revoked, 1);
  assert.strictEqual((await post('/api/pull', { token: t, since: 0 })).status, 401);
});

test('logout all cuts off every device, including ones you no longer hold', async () => {
  const lost = (await post('/api/login', { username: 'alex', password: 'correct-horse' })).body.token;
  const kept = (await post('/api/login', { username: 'alex', password: 'correct-horse' })).body.token;

  await post('/api/logout', { token: kept, all: true });
  assert.strictEqual((await post('/api/pull', { token: lost, since: 0 })).status, 401);
  assert.strictEqual((await post('/api/pull', { token: kept, since: 0 })).status, 401);
});

test('logging out with an unknown token is a harmless no-op', async () => {
  const { status, body } = await post('/api/logout', { token: 'nope'.repeat(16) });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.revoked, undefined);
});

test('an unknown API route 404s', async () => {
  const res = await fetch(BASE + '/api/nope', { method: 'POST', body: '{}' });
  assert.strictEqual(res.status, 404);
});
