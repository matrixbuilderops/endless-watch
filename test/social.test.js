// Integration tests for the social server (social.js).
// Spawns a real server on a throwaway port against a temp DATA_DIR.
// Run: node --test test/social.test.js
//      (or as part of:  npm test)

'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const PORT = 19000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc, dataDir;

// ---- helpers ----

async function post(route, payload) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function get(route) {
  const res = await fetch(BASE + route);
  return { status: res.status, body: await res.json() };
}

// shared tokens across tests
const T = {};  // T.alice, T.bob, T.admin

// ---- lifecycle ----

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-social-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'social.js')], {
    env: {
      ...process.env,
      SOCIAL_PORT: String(PORT),
      SOCIAL_HOST: '127.0.0.1',
      SOCIAL_DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  });
  // poll health until server is up
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/social/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('social server did not start in time');
});

after(() => {
  if (proc) proc.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- health ----

test('health endpoint returns ok before any users', async () => {
  const { status, body } = await get('/social/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.users, 0);
  assert.strictEqual(body.groups, 0);
});

// ---- register ----

test('register creates a new account and returns a token', async () => {
  const { status, body } = await post('/social/register', { username: 'Alice', password: 'hunter2' });
  assert.strictEqual(status, 200);
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.strictEqual(body.username, 'alice');  // lowercased
  T.alice = body.token;
});

test('register lowercases the username', async () => {
  const { status, body } = await post('/social/register', { username: 'BOB99', password: 'passw0rd' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.username, 'bob99');
  T.bob = body.token;
});

test('register the admin account', async () => {
  const { status, body } = await post('/social/register', {
    username: 'alexander-sorrell-it', password: 'adminpass99',
  });
  assert.strictEqual(status, 200);
  T.admin = body.token;
});

test('register rejects duplicate username', async () => {
  const { status, body } = await post('/social/register', { username: 'alice', password: 'otherpass' });
  assert.strictEqual(status, 409);
  assert.ok(body.error);
});

test('register rejects short username', async () => {
  const { status } = await post('/social/register', { username: 'ab', password: 'validpass' });
  assert.strictEqual(status, 400);
});

test('register rejects short password', async () => {
  const { status } = await post('/social/register', { username: 'newguy99', password: '12345' });
  assert.strictEqual(status, 400);
});

test('register rejects invalid username chars', async () => {
  const { status } = await post('/social/register', { username: 'bad user!', password: 'validpass' });
  assert.strictEqual(status, 400);
});

// ---- login ----

test('login succeeds with correct credentials', async () => {
  const { status, body } = await post('/social/login', { username: 'alice', password: 'hunter2' });
  assert.strictEqual(status, 200);
  assert.match(body.token, /^[a-f0-9]{64}$/);
});

test('login fails with wrong password', async () => {
  const { status } = await post('/social/login', { username: 'alice', password: 'wrongpass' });
  assert.strictEqual(status, 401);
});

test('login fails for unknown user', async () => {
  const { status } = await post('/social/login', { username: 'nobody', password: 'anything' });
  assert.strictEqual(status, 401);
});

// ---- logout ----

test('logout invalidates a token', async () => {
  // create a fresh token just for this test
  const { body: lb } = await post('/social/login', { username: 'alice', password: 'hunter2' });
  const tmpToken = lb.token;
  const { body: out } = await post('/social/logout', { token: tmpToken });
  assert.strictEqual(out.ok, true);
  // using the invalidated token should now fail
  const { status } = await post('/social/profile/update', { token: tmpToken, bio: 'x' });
  assert.strictEqual(status, 401);
});

test('logout with unknown token is harmless', async () => {
  const { body } = await post('/social/logout', { token: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });
  assert.strictEqual(body.ok, true);
});

// ---- profile ----

test('profile/update updates bio and avatar', async () => {
  const { status, body } = await post('/social/profile/update', {
    token: T.alice,
    bio: 'I love drama',
    avatar: 'https://example.com/avatar.png',
    serverUrl: 'https://myserver.example.com',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.profile.bio, 'I love drama');
  assert.strictEqual(body.profile.username, 'alice');
  assert.strictEqual(body.profile.serverUrl, 'https://myserver.example.com');
});

test('users/get returns public profile', async () => {
  const { status, body } = await post('/social/users/get', { username: 'alice' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.profile.username, 'alice');
  assert.strictEqual(body.profile.bio, 'I love drama');
});

test('users/get returns 404 for unknown user', async () => {
  const { status } = await post('/social/users/get', { username: 'ghost' });
  assert.strictEqual(status, 404);
});

test('profile/update rejects invalid token', async () => {
  const { status } = await post('/social/profile/update', { token: 'badtoken', bio: 'x' });
  assert.strictEqual(status, 401);
});

// ---- follows ----

test('follow another user', async () => {
  const { status, body } = await post('/social/follow', { token: T.alice, username: 'bob99' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test('follow is idempotent', async () => {
  const { status, body } = await post('/social/follow', { token: T.alice, username: 'bob99' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test('cannot follow yourself', async () => {
  const { status } = await post('/social/follow', { token: T.alice, username: 'alice' });
  assert.strictEqual(status, 400);
});

test('cannot follow nonexistent user', async () => {
  const { status } = await post('/social/follow', { token: T.alice, username: 'nobody' });
  assert.strictEqual(status, 404);
});

test('follows/list shows who you follow and your followers', async () => {
  // bob follows alice back
  await post('/social/follow', { token: T.bob, username: 'alice' });
  const { status, body } = await post('/social/follows/list', { token: T.alice });
  assert.strictEqual(status, 200);
  assert.ok(body.following.includes('bob99'));
  assert.ok(body.followers.includes('bob99'));
});

test('unfollow removes a follow', async () => {
  await post('/social/unfollow', { token: T.alice, username: 'bob99' });
  const { body } = await post('/social/follows/list', { token: T.alice });
  assert.ok(!body.following.includes('bob99'));
});

// ---- activity ----

test('activity/post emits an event', async () => {
  const { status, body } = await post('/social/activity/post', {
    token: T.alice,
    type: 'finished_episode',
    showName: 'Breaking Bad',
    showId: '169',
    season: 5,
    episode: 14,
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test('activity/feed includes own events', async () => {
  const { status, body } = await post('/social/activity/feed', { token: T.alice });
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.events));
  const ev = body.events.find(e => e.showName === 'Breaking Bad');
  assert.ok(ev, 'own event should appear in feed');
  assert.strictEqual(ev.type, 'finished_episode');
});

test('activity/feed includes followed users\' events', async () => {
  // alice follows bob; bob posts an event; alice's feed should include it
  await post('/social/follow', { token: T.alice, username: 'bob99' });
  await post('/social/activity/post', {
    token: T.bob, type: 'started_show', showName: 'The Wire', showId: '1871',
  });
  const { body } = await post('/social/activity/feed', { token: T.alice });
  const ev = body.events.find(e => e.showName === 'The Wire');
  assert.ok(ev, 'followed user\'s event should appear in feed');
});

test('activity/post rejects unknown type', async () => {
  const { status } = await post('/social/activity/post', {
    token: T.alice, type: 'watched_trailer', showName: 'Stranger Things',
  });
  assert.strictEqual(status, 400);
});

// ---- threads ----

// Create an approved group first for group-thread tests
let groupId;
test('create a group (goes to pending)', async () => {
  const { status, body } = await post('/social/groups/create', {
    token: T.alice,
    name: 'Crime Dramas',
    description: 'A fan group for the best crime dramas on TV.',
    rules: 'Be civil.',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.group.status, 'pending');
  groupId = body.group.id;
});

test('admin approves the group', async () => {
  const { status, body } = await post('/social/admin/groups/approve', {
    token: T.admin, groupId,
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.group.status, 'approved');
});

test('thread/post creates a post in a show thread', async () => {
  const { status, body } = await post('/social/thread/post', {
    token: T.alice, type: 'show', refId: '169', body: 'What a finale!',
  });
  assert.strictEqual(status, 200);
  assert.ok(body.post.id);
  assert.strictEqual(body.post.body, 'What a finale!');
  assert.strictEqual(body.post.authorId, 'alice');
});

test('thread/get returns posts for a show (no auth required)', async () => {
  const { status, body } = await post('/social/thread/get', { type: 'show', refId: '169' });
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.posts));
  assert.ok(body.posts.some(p => p.body === 'What a finale!'));
});

test('thread/post creates a post in an approved group', async () => {
  const { status, body } = await post('/social/thread/post', {
    token: T.bob, type: 'group', refId: groupId, body: 'Love this group!',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.post.authorId, 'bob99');
});

test('thread/get returns group posts', async () => {
  const { status, body } = await post('/social/thread/get', { type: 'group', refId: groupId });
  assert.strictEqual(status, 200);
  assert.ok(body.posts.some(p => p.body === 'Love this group!'));
});

test('thread/post fails for non-existent group', async () => {
  const { status } = await post('/social/thread/post', {
    token: T.alice, type: 'group', refId: 'nonexistentid', body: 'Hello',
  });
  assert.strictEqual(status, 404);
});

test('thread/post fails with empty body', async () => {
  const { status } = await post('/social/thread/post', {
    token: T.alice, type: 'show', refId: '169', body: '   ',
  });
  assert.strictEqual(status, 400);
});

test('thread/post requires valid auth', async () => {
  const { status } = await post('/social/thread/post', {
    token: 'badtoken', type: 'show', refId: '169', body: 'Hello',
  });
  assert.strictEqual(status, 401);
});

// ---- thread remove ----

let removePostId;
test('thread/remove: author can remove own post', async () => {
  // alice posts, then removes it
  const { body: pb } = await post('/social/thread/post', {
    token: T.alice, type: 'show', refId: '169', body: 'Please delete me',
  });
  removePostId = pb.post.id;
  const { status, body } = await post('/social/thread/remove', {
    token: T.alice, postId: removePostId, type: 'show', refId: '169',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  // removed post should not appear in thread/get
  const { body: tb } = await post('/social/thread/get', { type: 'show', refId: '169' });
  assert.ok(!tb.posts.some(p => p.id === removePostId));
});

test('thread/remove: non-author non-mod cannot remove', async () => {
  // alice's original post is in the show thread — bob tries to remove it
  const { body: tb } = await post('/social/thread/get', { type: 'show', refId: '169' });
  const alicePost = tb.posts.find(p => p.authorId === 'alice');
  assert.ok(alicePost, 'need alice post for this test');
  const { status } = await post('/social/thread/remove', {
    token: T.bob, postId: alicePost.id, type: 'show', refId: '169',
  });
  assert.strictEqual(status, 403);
});

test('thread/remove: admin can remove any post', async () => {
  const { body: tb } = await post('/social/thread/get', { type: 'show', refId: '169' });
  const alicePost = tb.posts.find(p => p.authorId === 'alice');
  assert.ok(alicePost);
  const { status } = await post('/social/thread/remove', {
    token: T.admin, postId: alicePost.id, type: 'show', refId: '169', reason: 'test removal',
  });
  assert.strictEqual(status, 200);
});

test('thread/remove: remove of already-removed post is idempotent', async () => {
  const { status } = await post('/social/thread/remove', {
    token: T.admin, postId: removePostId, type: 'show', refId: '169',
  });
  assert.strictEqual(status, 200);
});

// ---- groups ----

test('groups/list returns only approved groups (no auth)', async () => {
  const { status, body } = await post('/social/groups/list', {});
  assert.strictEqual(status, 200);
  assert.ok(body.groups.every(g => g.status === 'approved'));
  assert.ok(body.groups.some(g => g.id === groupId));
});

test('groups/list pending requires admin token', async () => {
  const { status } = await post('/social/groups/list', { status: 'pending', token: T.alice });
  assert.strictEqual(status, 403);
});

test('admin can list pending groups', async () => {
  // create a second pending group
  await post('/social/groups/create', {
    token: T.bob,
    name: 'Sci-Fi Fans',
    description: 'Science fiction TV shows discussion hub.',
  });
  const { status, body } = await post('/social/groups/list', { status: 'pending', token: T.admin });
  assert.strictEqual(status, 200);
  assert.ok(body.groups.length >= 1);
  assert.ok(body.groups.every(g => g.status === 'pending'));
});

test('groups/create rejects duplicate name', async () => {
  const { status } = await post('/social/groups/create', {
    token: T.bob,
    name: 'Crime Dramas',
    description: 'Another group with the same name should fail.',
  });
  assert.strictEqual(status, 409);
});

test('groups/create rejects short description', async () => {
  const { status } = await post('/social/groups/create', {
    token: T.alice,
    name: 'Unique Name 12345',
    description: 'Short',
  });
  assert.strictEqual(status, 400);
});

test('admin rejects a group', async () => {
  // find the Sci-Fi Fans pending group
  const { body: lb } = await post('/social/groups/list', { status: 'pending', token: T.admin });
  const g = lb.groups.find(g => g.name === 'Sci-Fi Fans');
  assert.ok(g);
  const { status, body } = await post('/social/admin/groups/reject', {
    token: T.admin, groupId: g.id, reason: 'Duplicate topic',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test('groups/mod/appoint: group creator can appoint a mod', async () => {
  const { status } = await post('/social/groups/mod/appoint', {
    token: T.alice, groupId, username: 'bob99',
  });
  assert.strictEqual(status, 200);
});

test('groups/mod/appoint: non-creator non-admin cannot appoint', async () => {
  // register a third user and try
  const { body: rb } = await post('/social/register', { username: 'carol99', password: 'carolpass' });
  const { status } = await post('/social/groups/mod/appoint', {
    token: rb.token, groupId, username: 'carol99',
  });
  assert.strictEqual(status, 403);
});

test('groups/mod/ban: mod can ban a user from a group', async () => {
  const { status } = await post('/social/groups/mod/ban', {
    token: T.alice, groupId, username: 'carol99', reason: 'spam',
  });
  assert.strictEqual(status, 200);
});

test('groups/mod/ban: non-mod cannot ban', async () => {
  const { body: rb } = await post('/social/register', { username: 'dave99', password: 'davepass' });
  const { status } = await post('/social/groups/mod/ban', {
    token: rb.token, groupId, username: 'bob99', reason: 'test',
  });
  assert.strictEqual(status, 403);
});

// ---- admin routes ----

test('admin/ban_user bans a user', async () => {
  const { status, body } = await post('/social/admin/ban_user', {
    token: T.admin, username: 'carol99', reason: 'spammer',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
  // banned user cannot log in
  const { status: ls } = await post('/social/login', { username: 'carol99', password: 'carolpass' });
  assert.strictEqual(ls, 403);
});

test('admin/ban_user cannot ban the admin', async () => {
  const { status } = await post('/social/admin/ban_user', {
    token: T.admin, username: 'alexander-sorrell-it',
  });
  assert.strictEqual(status, 400);
});

test('admin/ban_user requires admin token', async () => {
  const { status } = await post('/social/admin/ban_user', {
    token: T.alice, username: 'bob99',
  });
  assert.strictEqual(status, 403);
});

test('admin/modlog returns log entries (admin only)', async () => {
  const { status, body } = await post('/social/admin/modlog', { token: T.admin });
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.entries));
  // should have at least the ban + post removals we did
  assert.ok(body.entries.length >= 1);
});

test('admin/modlog denied to non-admin', async () => {
  const { status } = await post('/social/admin/modlog', { token: T.alice });
  assert.strictEqual(status, 403);
});

// ---- support tickets ----

let ticketId;
test('support/open creates a ticket', async () => {
  const { status, body } = await post('/social/support/open', {
    token: T.alice,
    subject: 'Cannot post in group',
    body: 'I get an error every time I try to post in the Crime Dramas group. Please help.',
  });
  assert.strictEqual(status, 200);
  assert.ok(body.ticket.id);
  assert.strictEqual(body.ticket.status, 'open');
  ticketId = body.ticket.id;
});

test('support/reply adds a message', async () => {
  const { status, body } = await post('/social/support/reply', {
    token: T.alice, ticketId, body: 'Still happening after a reload.',
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.ok, true);
});

test('support/reply by admin moves ticket to in_progress', async () => {
  const { status } = await post('/social/support/reply', {
    token: T.admin, ticketId, body: 'Looking into it.',
  });
  assert.strictEqual(status, 200);
  const { body: lb } = await post('/social/support/list', { token: T.alice });
  const t = lb.tickets.find(t => t.id === ticketId);
  assert.strictEqual(t.status, 'in_progress');
});

test('support/reply rejected for wrong user', async () => {
  const { status } = await post('/social/support/reply', {
    token: T.bob, ticketId, body: 'I am not involved',
  });
  assert.strictEqual(status, 403);
});

test('support/escalate lets the user force early escalation', async () => {
  const { status } = await post('/social/support/escalate', { token: T.alice, ticketId });
  assert.strictEqual(status, 200);
  const { body: lb } = await post('/social/support/list', { token: T.alice });
  const t = lb.tickets.find(t => t.id === ticketId);
  assert.strictEqual(t.status, 'escalated');
});

test('support/escalate rejected for wrong user', async () => {
  const { status } = await post('/social/support/escalate', { token: T.bob, ticketId });
  assert.strictEqual(status, 403);
});

test('support/resolve closes the ticket', async () => {
  const { status } = await post('/social/support/resolve', { token: T.alice, ticketId });
  assert.strictEqual(status, 200);
  const { body: lb } = await post('/social/support/list', { token: T.alice });
  const t = lb.tickets.find(t => t.id === ticketId);
  assert.strictEqual(t.status, 'resolved');
});

test('support/reply on a resolved ticket is rejected', async () => {
  const { status } = await post('/social/support/reply', {
    token: T.alice, ticketId, body: 'One more thing',
  });
  assert.strictEqual(status, 400);
});

test('support/list: user sees only their own tickets', async () => {
  const { body } = await post('/social/support/list', { token: T.bob });
  assert.ok(body.tickets.every(t => t.authorId === 'bob99'));
});

test('support/list: admin sees all tickets', async () => {
  const { body } = await post('/social/support/list', { token: T.admin });
  assert.ok(body.tickets.some(t => t.authorId === 'alice'));
});

// ---- health reflects state ----

test('health reflects user/group/ticket counts', async () => {
  const { body } = await get('/social/health');
  assert.ok(body.users >= 3);       // alice, bob99, admin, carol99, dave99
  assert.ok(body.groups >= 1);      // Crime Dramas
  assert.strictEqual(body.openTickets, 0); // the one we opened was resolved
});

// ---- unknown routes ----

test('unknown route returns 404', async () => {
  const { status } = await post('/social/unknown/route', {});
  assert.strictEqual(status, 404);
});

test('GET on a POST-only route returns 404', async () => {
  const res = await fetch(BASE + '/social/register');
  assert.strictEqual(res.status, 404);
});

// ---- rate limiting (light probe) ----

test('auth rate limit triggers after AUTH_MAX attempts', async () => {
  // fire 21 failed logins from the same IP — the 21st should be 429
  let lastStatus;
  for (let i = 0; i < 21; i++) {
    const { status } = await post('/social/login', { username: 'alice', password: 'wrong' });
    lastStatus = status;
  }
  // should have been rate-limited at some point
  assert.strictEqual(lastStatus, 429);
});
