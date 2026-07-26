// Store files are written on a short delay so a chunked upload or a scrobble
// doesn't rewrite tens of MB per record (episodes.json is ~23 MB in a real
// library). That delay must not cost durability: a clean shutdown has to flush,
// and the data has to come back after a restart. Spawns its own servers because
// it needs to stop and start them.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

function start(dataDir, port) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    let tries = 0;
    const poll = setInterval(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`);
        clearInterval(poll); resolve(proc);
      } catch {
        if (++tries > 100) { clearInterval(poll); reject(new Error('server did not start')); }
      }
    }, 50);
  });
}

function stop(proc, signal = 'SIGTERM') {
  return new Promise((resolve) => { proc.once('exit', resolve); proc.kill(signal); });
}

const post = async (port, route, payload) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

test('a push survives an immediate shutdown and a restart', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrack-persist-'));
  const portA = 19000 + Math.floor(Math.random() * 500);
  const portB = portA + 1;
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let proc = await start(dataDir, portA);
  const { body } = await post(portA, '/api/register', { username: 'dura', password: 'hunter22' });
  const token = body.token;

  await post(portA, '/api/push', {
    token, store: 'shows',
    records: [{ id: 42, name: 'Durability Test', _t: Date.now() }],
    deletes: [],
  });
  // no delay here on purpose: kill inside the write window
  await stop(proc);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'u_dura', 'shows.json'), 'utf8'));
  assert.strictEqual(onDisk['42'].name, 'Durability Test', 'shutdown must flush pending writes');

  proc = await start(dataDir, portB);
  t.after(() => stop(proc, 'SIGKILL'));
  const pulled = await post(portB, '/api/pull', { token, since: 0 });
  assert.strictEqual((pulled.body.records.shows || [])[0].name, 'Durability Test');
});

test('a token issued before a restart still works after it', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrack-persist-'));
  const portA = 19600 + Math.floor(Math.random() * 300);
  const portB = portA + 1;
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  let proc = await start(dataDir, portA);
  const { body } = await post(portA, '/api/register', { username: 'sess', password: 'hunter22' });
  await stop(proc);

  proc = await start(dataDir, portB);
  t.after(() => stop(proc, 'SIGKILL'));
  const pulled = await post(portB, '/api/pull', { token: body.token, since: 0 });
  assert.strictEqual(pulled.status, 200, 'session must outlive a restart');
});
