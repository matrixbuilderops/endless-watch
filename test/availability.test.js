// The background availability checker: which shows get an API call (quota), and
// what alert the user ends up seeing. apiGet and the pacing gap arrive through
// `helpers` like every other side effect in the module, so none of this touches
// the network or the RapidAPI allowance.

const { test } = require('node:test');
const assert = require('node:assert');

const { currentlyWatching, checkUser } = require('../server/availability.js');

const STORES = ['shows', 'episodes', 'watched', 'movies', 'watchlist', 'lists', 'kv'];
const DAY = 86400000;

function state({ kv = {}, alerts = [], pushSubs = [], lastCheck = {} } = {}) {
  const st = { records: {}, alerts, pushSubs, lastCheck, seq: 0 };
  for (const s of STORES) st.records[s] = {};
  for (const [k, v] of Object.entries(kv)) st.records.kv[k] = { k, v };
  return st;
}

function addShow(st, id, props = {}) {
  st.records.shows[id] = {
    id, name: props.name || `Show ${id}`, platform: props.platform ?? 'Netflix',
    imdbId: props.imdbId ?? `tt${id}`, archived: !!props.archived, ...props,
  };
  return st.records.shows[id];
}

// aired yesterday unless told otherwise
function addEpisode(st, id, showId, props = {}) {
  st.records.episodes[id] = {
    id, showId, season: 1, number: props.number ?? id,
    type: props.type ?? 'regular',
    airstamp: props.airstamp ?? new Date(Date.now() - DAY).toISOString(),
    ...props,
  };
}

const markWatched = (st, epId, showId, progress = 100) => {
  st.records.watched[epId] = { epId, showId, progress };
};

// records what the checker did, so tests can assert on calls as well as output
function spyHelpers(responses = {}, { pushStatus = 201 } = {}) {
  const calls = { api: [], push: [], persistUser: 0, persistAlerts: 0, persistPush: 0 };
  return {
    calls,
    gapMs: 0,
    apiGet: async (pathAndQuery) => {
      calls.api.push(pathAndQuery);
      const m = /^\/shows\/([^?]+)/.exec(pathAndQuery);
      return responses[m && m[1]] ?? null;
    },
    sendPush: async (sub, payload) => {
      calls.push.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { status: typeof pushStatus === 'function' ? pushStatus(sub) : pushStatus };
    },
    persistUser: () => { calls.persistUser++; },
    persistAlerts: () => { calls.persistAlerts++; },
    persistPush: () => { calls.persistPush++; },
  };
}

const svc = (name, type = 'subscription', extra = {}) =>
  ({ service: { id: name.toLowerCase(), name }, type, ...extra });

const BACKGROUND = { 'settings:rapidApiKey': 'k', 'settings:availMode': 'background' };

// ---------------- which shows are worth an API call ----------------

test('a show you are part-way through is picked up', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  markWatched(st, 11, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()).map(s => s.id), [1]);
});

test('a show you have not started is ignored', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()), []);
});

test('a show you have finished is ignored', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  markWatched(st, 11, 1); markWatched(st, 12, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()), []);
});

test('an archived show is ignored even mid-watch', () => {
  const st = state();
  addShow(st, 1, { archived: true });
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  markWatched(st, 11, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()), []);
});

test('a partially-watched episode counts as started', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  markWatched(st, 11, 1, 40);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()).map(s => s.id), [1]);
});

test('unaired episodes do not make a finished show look unfinished', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1);
  addEpisode(st, 12, 1, { airstamp: new Date(Date.now() + 30 * DAY).toISOString() });
  markWatched(st, 11, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()), [],
    'you are up to date; next week is not a backlog');
});

test('specials and unnumbered episodes are excluded', () => {
  const st = state();
  addShow(st, 1);
  addEpisode(st, 11, 1);
  addEpisode(st, 12, 1, { type: 'special' });
  addEpisode(st, 13, 1, { number: null });
  markWatched(st, 11, 1);
  assert.deepStrictEqual(currentlyWatching(st, Date.now()), []);
});

// ---------------- quota discipline ----------------

test('no API call at all without a key', async () => {
  const st = state({ kv: { 'settings:availMode': 'background' } });
  addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers();
  await checkUser('u', st, h);
  assert.deepStrictEqual(h.calls.api, []);
});

test('no API call unless background checking is switched on', async () => {
  for (const mode of ['app', 'none', undefined]) {
    const st = state({ kv: { 'settings:rapidApiKey': 'k', ...(mode ? { 'settings:availMode': mode } : {}) } });
    addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
    const h = spyHelpers();
    await checkUser('u', st, h);
    assert.deepStrictEqual(h.calls.api, [], `mode=${mode}`);
  }
});

test('both "background" and "both" do check', async () => {
  for (const mode of ['background', 'both']) {
    const st = state({ kv: { 'settings:rapidApiKey': 'k', 'settings:availMode': mode } });
    addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
    const h = spyHelpers();
    await checkUser('u', st, h);
    assert.strictEqual(h.calls.api.length, 1, `mode=${mode}`);
  }
});

test('a single run is capped, oldest-checked first', async () => {
  const st = state({ kv: BACKGROUND });
  for (let i = 1; i <= 20; i++) {
    addShow(st, i);
    addEpisode(st, 100 + i, i); addEpisode(st, 200 + i, i);
    markWatched(st, 100 + i, i);
    st.lastCheck[i] = i * 1000;          // show 1 is the most stale
  }
  const h = spyHelpers();
  await checkUser('u', st, h);
  assert.strictEqual(h.calls.api.length, 15, 'CAP_PER_RUN protects the free tier');
  assert.ok(h.calls.api[0].includes('tt1'), 'least-recently-checked goes first');
  assert.ok(!h.calls.api.some(p => p.includes('tt20')), 'the freshest show waits for the next run');
});

test('every checked show has its lastCheck stamped, so the round-robin advances', async () => {
  const st = state({ kv: BACKGROUND });
  addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers();
  await checkUser('u', st, h);
  assert.ok(st.lastCheck[1] > 0);
  assert.strictEqual(h.calls.persistUser, 1, 'lastCheck must be persisted');
});

// ---------------- the alerts themselves ----------------

function watchingOne(extra = {}) {
  const st = state({ kv: { ...BACKGROUND, ...extra.kv }, alerts: extra.alerts, pushSubs: extra.pushSubs });
  addShow(st, 1, { name: 'Severance', platform: extra.platform ?? 'Apple TV+', imdbId: 'tt1' });
  addEpisode(st, 11, 1); addEpisode(st, 12, 1);
  markWatched(st, 11, 1);
  return st;
}

test('a leaving-soon option becomes an alert with its date', async () => {
  const expiresOn = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
  const st = watchingOne();
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true, expiresOn })] } } });
  await checkUser('u', st, h);

  assert.strictEqual(st.alerts.length, 1);
  assert.strictEqual(st.alerts[0].kind, 'leaving');
  assert.strictEqual(st.alerts[0].expiresOn, expiresOn);
  const expected = new Date(expiresOn * 1000).toLocaleDateString();
  assert.strictEqual(st.alerts[0].message, `Severance is leaving Apple TV+ on ${expected}`);
});

test('leaving with no date says "soon" rather than "on undefined"', async () => {
  const st = watchingOne();
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } });
  await checkUser('u', st, h);
  assert.strictEqual(st.alerts[0].message, 'Severance is leaving Apple TV+ soon');
});

test('still on your tagged platform means no "left" alert', async () => {
  const st = watchingOne();
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+')] } } });
  await checkUser('u', st, h);
  assert.deepStrictEqual(st.alerts, []);
});

test('gone from your platform points you at a service you pay for', async () => {
  const st = watchingOne({ kv: { 'settings:myPlatforms': ['Hulu'] } });
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Hulu'), svc('Peacock')] } } });
  await checkUser('u', st, h);

  const left = st.alerts.find(a => a.kind === 'left');
  assert.ok(left, 'should warn that it left Apple TV+');
  assert.strictEqual(left.message, 'Severance left Apple TV+ — you can watch it on Hulu');
  assert.ok(!left.message.includes('Peacock'), 'services you do not pay for are not the headline');
});

test('gone from your platform and none of yours: still says where it is', async () => {
  const st = watchingOne({ kv: { 'settings:myPlatforms': ['Netflix'] } });
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Hulu'), svc('Peacock')] } } });
  await checkUser('u', st, h);
  assert.strictEqual(st.alerts.find(a => a.kind === 'left').message,
    'Severance left Apple TV+ — now on Hulu, Peacock');
});

test('gone everywhere says so plainly', async () => {
  const st = watchingOne();
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('SomeStore', 'buy')] } } });
  await checkUser('u', st, h);
  assert.strictEqual(st.alerts.find(a => a.kind === 'left').message,
    'Severance left Apple TV+ — not on any subscription now');
});

test('re-running replaces a stale alert instead of stacking duplicates', async () => {
  const st = watchingOne();
  const resp = { tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } };
  await checkUser('u', st, spyHelpers(resp));
  await checkUser('u', st, spyHelpers(resp));
  assert.strictEqual(st.alerts.length, 1, 'one show, one warning');
});

test('a show that is fine again has its old alert cleared', async () => {
  const st = watchingOne();
  await checkUser('u', st, spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } }));
  assert.strictEqual(st.alerts.length, 1);
  await checkUser('u', st, spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+')] } } }));
  assert.deepStrictEqual(st.alerts, [], 'no longer leaving, so no longer warned about');
});

test('a failed lookup leaves existing alerts alone', async () => {
  const st = watchingOne({ alerts: [{ showId: 1, name: 'Severance', kind: 'leaving', message: 'kept' }] });
  const h = spyHelpers({});      // null response
  await checkUser('u', st, h);
  assert.deepStrictEqual(st.alerts.map(a => a.message), ['kept']);
});

// ---------------- push delivery ----------------

test('a new alert is pushed to every subscribed device', async () => {
  const st = watchingOne({ pushSubs: [{ endpoint: 'https://push.example/a' }, { endpoint: 'https://push.example/b' }] });
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } });
  await checkUser('u', st, h);

  assert.strictEqual(h.calls.push.length, 2);
  assert.strictEqual(h.calls.push[0].payload.body, 'Severance is leaving Apple TV+ soon');
  assert.strictEqual(h.calls.push[0].payload.tag, 'endless-watch-alert');
});

test('an alert you were already told about is not pushed again', async () => {
  const st = watchingOne({ pushSubs: [{ endpoint: 'https://push.example/a' }] });
  const resp = { tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } };
  await checkUser('u', st, spyHelpers(resp));
  const second = spyHelpers(resp);
  await checkUser('u', st, second);
  assert.deepStrictEqual(second.calls.push, [], 'no nagging on every 12-hour run');
});

test('several new alerts collapse into one summary notification', async () => {
  const st = state({ kv: BACKGROUND, pushSubs: [{ endpoint: 'https://push.example/a' }] });
  for (const [id, name] of [[1, 'Severance'], [2, 'The Bear']]) {
    addShow(st, id, { name, platform: 'Hulu', imdbId: `tt${id}` });
    addEpisode(st, 10 + id, id); addEpisode(st, 20 + id, id);
    markWatched(st, 10 + id, id);
  }
  const leaving = { streamingOptions: { us: [svc('Hulu', 'subscription', { expiresSoon: true })] } };
  const h = spyHelpers({ tt1: leaving, tt2: leaving });
  await checkUser('u', st, h);

  assert.strictEqual(h.calls.push.length, 1);
  assert.strictEqual(h.calls.push[0].payload.body, '2 shows are leaving a platform');
});

test('expired subscriptions are pruned on 404/410', async () => {
  const st = watchingOne({
    pushSubs: [{ endpoint: 'https://push.example/gone' }, { endpoint: 'https://push.example/live' }],
  });
  const h = spyHelpers(
    { tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } },
    { pushStatus: (sub) => sub.endpoint.endsWith('/gone') ? 410 : 201 });
  await checkUser('u', st, h);

  assert.deepStrictEqual(st.pushSubs.map(s => s.endpoint), ['https://push.example/live']);
  assert.strictEqual(h.calls.persistPush, 1);
});

test('no devices subscribed is not an error', async () => {
  const st = watchingOne();
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Apple TV+', 'subscription', { expiresSoon: true })] } } });
  await checkUser('u', st, h);
  assert.deepStrictEqual(h.calls.push, []);
  assert.strictEqual(st.alerts.length, 1, 'the in-app alert still lands');
});

// ---------------- robustness of the upstream payload ----------------

test('a streaming option with no service name does not kill the run', async () => {
  // the API is third-party; one malformed entry used to throw inside the
  // platform comparison and abort every remaining show for this user
  const st = watchingOne();
  const h = spyHelpers({
    tt1: { streamingOptions: { us: [{ service: { id: 'x' }, type: 'subscription' }, svc('Hulu')] } },
  });
  await checkUser('u', st, h);
  assert.strictEqual(h.calls.persistAlerts, 1, 'the run completed');
});

test('an empty or missing streamingOptions block is handled', async () => {
  for (const data of [{}, { streamingOptions: {} }, { streamingOptions: { us: [] } }]) {
    const st = watchingOne();
    const h = spyHelpers({ tt1: data });
    await checkUser('u', st, h);
    assert.strictEqual(st.alerts.length, 1, 'nowhere to stream means it left your platform');
  }
});

test('a show with no imdbId is skipped rather than queried blindly', async () => {
  const st = state({ kv: BACKGROUND });
  addShow(st, 1, { imdbId: null });
  addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers();
  await checkUser('u', st, h);
  assert.deepStrictEqual(h.calls.api, []);
});

// ---------------- country setting ----------------

test('the API call uses the country from settings:country, not always "us"', async () => {
  const st = state({ kv: { ...BACKGROUND, 'settings:country': 'gb' } });
  addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers({ tt1: { streamingOptions: { gb: [svc('BBC iPlayer')] } } });
  await checkUser('u', st, h);
  assert.ok(h.calls.api[0].includes('country=gb'), 'request must target the user\'s country');
});

test('country defaults to us when settings:country is absent', async () => {
  const st = state({ kv: BACKGROUND });
  addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Netflix')] } } });
  await checkUser('u', st, h);
  assert.ok(h.calls.api[0].includes('country=us'), 'default must be us');
});

test('country code is normalised to lowercase and truncated to 2 chars', async () => {
  const st = state({ kv: { ...BACKGROUND, 'settings:country': 'AU' } });
  addShow(st, 1); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  const h = spyHelpers({ tt1: { streamingOptions: { au: [svc('Stan')] } } });
  await checkUser('u', st, h);
  assert.ok(h.calls.api[0].includes('country=au'), 'must be lowercase and exactly 2 chars');
});

test('streamingOptions falls back to us key when the country key is absent', async () => {
  // API may not have options for some countries yet; fall back so alerts still work.
  const st = state({ kv: { ...BACKGROUND, 'settings:country': 'nz' } });
  addShow(st, 1, { platform: 'Netflix' }); addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  // response has 'us' key but not 'nz'
  const h = spyHelpers({ tt1: { streamingOptions: { us: [svc('Netflix')] } } });
  await checkUser('u', st, h);
  // Netflix is present in the us fallback, so no "left" alert
  assert.deepStrictEqual(st.alerts.filter(a => a.kind === 'left'), [], 'us fallback prevents a spurious left-platform alert');
});

test('a show that left the platform in the user\'s country triggers an alert', async () => {
  const st = state({ kv: { ...BACKGROUND, 'settings:country': 'ca' } });
  addShow(st, 1, { name: 'Schitt\'s Creek', platform: 'Netflix', imdbId: 'tt1' });
  addEpisode(st, 11, 1); addEpisode(st, 12, 1); markWatched(st, 11, 1);
  // show is on Netflix in us but NOT in ca
  const h = spyHelpers({ tt1: { streamingOptions: { ca: [], us: [svc('Netflix')] } } });
  await checkUser('u', st, h);
  const left = st.alerts.find(a => a.kind === 'left');
  assert.ok(left, 'must alert when the show left the user\'s country\'s Netflix');
});

