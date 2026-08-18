#!/usr/bin/env node
// Endless Watch — Social Server
// Runs alongside the personal sync server (server.js) on a separate port.
// Holds only the social layer: profiles, threads, groups, activity, support.
// Nothing private (watch history, API keys) ever touches this server.
//
// Run:  node social.js
// Env:  SOCIAL_PORT (default 8571), SOCIAL_HOST (default 127.0.0.1),
//       SOCIAL_DATA_DIR (default ./social-data), SOCIAL_ALLOW_ORIGIN,
//       TRUST_PROXY (set to 1 behind tailscale serve)

'use strict';
const http    = require('http');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

// ---- config ----

const PORT       = parseInt(process.env.SOCIAL_PORT || '8571', 10);
const HOST       = process.env.SOCIAL_HOST || '127.0.0.1';
const DATA_DIR   = process.env.SOCIAL_DATA_DIR || path.join(__dirname, 'social-data');
const ALLOW_ORIGIN = process.env.SOCIAL_ALLOW_ORIGIN || '';

// The one account that can approve groups, see all tickets, and remove any post.
// Set at deploy time — never changes at runtime.
const ADMIN_USER = 'alexander-sorrell-it';

const MAX_BODY         = 256 * 1024;   // 256 KB — posts are text, not uploads
const TOKEN_TTL_MS     = 180 * 24 * 60 * 60 * 1000; // 6 months
const AUTH_MAX         = 20;
const AUTH_WINDOW_MS   = 10 * 60 * 1000;
const POST_MAX         = 60;           // posts per user per window
const POST_WINDOW_MS   = 60 * 1000;
const TICKET_ESCALATE_MS = 24 * 60 * 60 * 1000; // 24 h no reply → escalate to admin

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(DATA_DIR, 'posts'), { recursive: true, mode: 0o700 });

// ---- persistence helpers ----

const readJSON  = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

function writeJSON(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Coalesced async writes — same pattern as server.js so bursts don't thrash disk.
const WRITE_DELAY_MS = 400;
const pendingWrites  = new Map();
let   writeTimer = null, flushing = null;

function queueWrite(file, getObj) {
  pendingWrites.set(file, getObj);
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flushWrites(); }, WRITE_DELAY_MS);
  writeTimer.unref();
}

function flushWrites() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (pendingWrites.size) {
      const batch = [...pendingWrites];
      pendingWrites.clear();
      for (const [file, getObj] of batch) {
        try {
          const tmp = file + '.tmp';
          await fs.promises.writeFile(tmp, JSON.stringify(getObj()), { mode: 0o600 });
          await fs.promises.rename(tmp, file);
        } catch (e) { console.error('write failed', file, e.message); }
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

function flushWritesSync() {
  if (!pendingWrites.size) return;
  for (const [file, getObj] of pendingWrites) {
    try { writeJSON(file, getObj()); } catch (e) { console.error('write failed', file, e.message); }
  }
  pendingWrites.clear();
}

// ---- file paths ----

const F = {
  users:    () => path.join(DATA_DIR, 'users.json'),
  tokens:   () => path.join(DATA_DIR, 'tokens.json'),
  groups:   () => path.join(DATA_DIR, 'groups.json'),
  activity: () => path.join(DATA_DIR, 'activity.json'),
  tickets:  () => path.join(DATA_DIR, 'tickets.json'),
  follows:  () => path.join(DATA_DIR, 'follows.json'),
  modlog:   () => path.join(DATA_DIR, 'modlog.json'),
  posts:    (ctx) => path.join(DATA_DIR, 'posts', `${ctx}.json`),
};

// ---- in-memory state ----
// Null-prototype objects: client-controlled keys (username, token) can't reach
// inherited props like 'toString', preventing prototype-pollution attacks.

const nullMap = (src) => Object.assign(Object.create(null), src || {});

let users    = nullMap(readJSON(F.users(),    {})); // username -> { hash, salt, createdAt, bio, avatar, serverUrl, banned }
let tokens   = nullMap(readJSON(F.tokens(),   {})); // token    -> { u: username, at: issuedAt }
let groups   = readJSON(F.groups(),   []);          // array of group objects
let activity = readJSON(F.activity(), []);          // array of activity events (most recent first, capped)
let tickets  = readJSON(F.tickets(),  []);          // support tickets
let follows  = readJSON(F.follows(),  []);          // { followerId, followedId, createdAt }
let modlog   = readJSON(F.modlog(),   []);          // mod action log

// Post files are loaded on demand (one file per thread context).
const postCache = new Map(); // ctx -> array of posts

function loadPosts(ctx) {
  if (postCache.has(ctx)) return postCache.get(ctx);
  const arr = readJSON(F.posts(ctx), []);
  postCache.set(ctx, arr);
  return arr;
}

function savePosts(ctx) {
  const arr = postCache.get(ctx) || [];
  queueWrite(F.posts(ctx), () => arr);
}

// ---- auth helpers ----

function hashPw(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function newToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens[token] = { u: username, at: Date.now() };
  pruneTokens();
  writeJSON(F.tokens(), tokens);
  return token;
}

function pruneTokens() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  let gone = 0;
  for (const t in tokens) if ((tokens[t].at || 0) < cutoff) { delete tokens[t]; gone++; }
  return gone;
}

function userFor(token) {
  const e = typeof token === 'string' ? tokens[token] : undefined;
  if (!e) throw err(401, 'Not signed in');
  if (Date.now() - (e.at || 0) > TOKEN_TTL_MS) {
    delete tokens[token]; writeJSON(F.tokens(), tokens);
    throw err(401, 'Session expired — sign in again');
  }
  const u = users[e.u];
  if (!u) throw err(401, 'Account not found');
  if (u.banned) throw err(403, 'Account suspended');
  return e.u;
}

function adminOnly(token) {
  const u = userFor(token);
  if (u !== ADMIN_USER) throw err(403, 'Admin only');
  return u;
}

// ---- rate limiting ----

const buckets = new Map();
function rateLimit(bucket, key, max, windowMs, message) {
  let b = buckets.get(bucket);
  if (!b) { b = new Map(); buckets.set(bucket, b); }
  const now = Date.now();
  let e = b.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; b.set(key, e); }
  if (++e.count > max) throw err(429, message);
}
setInterval(() => {
  const now = Date.now();
  for (const b of buckets.values()) for (const [k, e] of b) if (now > e.resetAt) b.delete(k);
}, AUTH_WINDOW_MS).unref();

// ---- id generation ----

const uid = () => crypto.randomBytes(12).toString('hex');

// ---- HTTP helpers ----

function err(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json' };
  if (ALLOW_ORIGIN) Object.assign(headers, {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  });
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_BODY) return Promise.reject(err(413, 'Body too large'));
  return new Promise((resolve, reject) => {
    let size = 0, aborted = false; const chunks = [];
    req.on('data', c => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) { aborted = true; reject(err(413, 'Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(err(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

function publicProfile(username) {
  const u = users[username];
  if (!u || u.banned) return null;
  return { username, bio: u.bio || '', avatar: u.avatar || '', joinedAt: u.createdAt, serverUrl: u.serverUrl || '' };
}

// ---- input validation ----

function validUsername(s) { return typeof s === 'string' && /^[a-z0-9_.-]{3,32}$/.test(s); }
function validPassword(s) { return typeof s === 'string' && s.length >= 6; }
function validBody(s)     { return typeof s === 'string' && s.trim().length > 0 && s.length <= 4000; }

// ---- routes ----

const routes = {};

// POST /social/register
routes['/social/register'] = (b, ip) => {
  rateLimit('auth', ip, AUTH_MAX, AUTH_WINDOW_MS, 'Too many attempts — wait a few minutes');
  const username = (b.username || '').trim().toLowerCase();
  if (!validUsername(username)) throw err(400, 'Username must be 3–32 chars: letters, numbers, . _ -');
  if (!validPassword(b.password)) throw err(400, 'Password must be at least 6 characters');
  if (users[username]) throw err(409, 'That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = {
    salt, hash: hashPw(b.password, salt), createdAt: new Date().toISOString(),
    bio: '', avatar: '', serverUrl: (b.serverUrl || '').trim().slice(0, 200), banned: false,
  };
  writeJSON(F.users(), users);
  return { token: newToken(username), username };
};

// POST /social/login
routes['/social/login'] = (b, ip) => {
  rateLimit('auth', ip, AUTH_MAX, AUTH_WINDOW_MS, 'Too many attempts — wait a few minutes');
  const username = (b.username || '').trim().toLowerCase();
  const u = users[username];
  if (!u) throw err(401, 'No such user');
  if (u.banned) throw err(403, 'Account suspended');
  const h = hashPw(b.password, u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex')))
    throw err(401, 'Wrong password');
  return { token: newToken(username), username };
};

// POST /social/logout
routes['/social/logout'] = (b) => {
  const t = b.token;
  if (typeof t === 'string' && tokens[t]) { delete tokens[t]; writeJSON(F.tokens(), tokens); }
  return { ok: true };
};

// POST /social/profile/update
routes['/social/profile/update'] = (b) => {
  const u = userFor(b.token);
  if (b.bio     !== undefined) users[u].bio       = String(b.bio     || '').slice(0, 300);
  if (b.avatar  !== undefined) users[u].avatar    = String(b.avatar  || '').slice(0, 500);
  if (b.serverUrl !== undefined) users[u].serverUrl = String(b.serverUrl || '').slice(0, 200);
  writeJSON(F.users(), users);
  return { ok: true, profile: publicProfile(u) };
};

// POST /social/users/get  { username }
routes['/social/users/get'] = (b) => {
  const p = publicProfile((b.username || '').trim().toLowerCase());
  if (!p) throw err(404, 'User not found');
  return { profile: p };
};

// POST /social/follow  { token, username }
routes['/social/follow'] = (b) => {
  const me = userFor(b.token);
  const them = (b.username || '').trim().toLowerCase();
  if (!users[them]) throw err(404, 'User not found');
  if (them === me) throw err(400, 'Cannot follow yourself');
  if (follows.find(f => f.followerId === me && f.followedId === them))
    return { ok: true }; // already following — idempotent
  follows.push({ followerId: me, followedId: them, createdAt: new Date().toISOString() });
  queueWrite(F.follows(), () => follows);
  return { ok: true };
};

// POST /social/unfollow  { token, username }
routes['/social/unfollow'] = (b) => {
  const me = userFor(b.token);
  const them = (b.username || '').trim().toLowerCase();
  follows = follows.filter(f => !(f.followerId === me && f.followedId === them));
  queueWrite(F.follows(), () => follows);
  return { ok: true };
};

// POST /social/follows/list  { token }  → who I follow + who follows me
routes['/social/follows/list'] = (b) => {
  const me = userFor(b.token);
  return {
    following: follows.filter(f => f.followerId === me).map(f => f.followedId),
    followers: follows.filter(f => f.followedId === me).map(f => f.followerId),
  };
};

// POST /social/activity/post  { token, type, showName, showId, season?, episode? }
routes['/social/activity/post'] = (b) => {
  const u = userFor(b.token);
  rateLimit('activity', u, 120, 60 * 1000, 'Too many activity events — slow down');
  const VALID_TYPES = ['finished_episode','finished_season','finished_show','started_show'];
  if (!VALID_TYPES.includes(b.type)) throw err(400, 'Unknown activity type');
  if (!b.showName || typeof b.showName !== 'string') throw err(400, 'showName required');
  const event = {
    id: uid(), userId: u, type: b.type,
    showName: String(b.showName).slice(0, 120),
    showId: b.showId || null,
    season: b.season || null,
    episode: b.episode || null,
    createdAt: new Date().toISOString(),
  };
  activity.unshift(event);
  if (activity.length > 5000) activity.length = 5000; // cap memory
  queueWrite(F.activity(), () => activity);
  return { ok: true };
};

// POST /social/activity/feed  { token, since? }  → events from followed users
routes['/social/activity/feed'] = (b) => {
  const me = userFor(b.token);
  const followingSet = new Set(follows.filter(f => f.followerId === me).map(f => f.followedId));
  followingSet.add(me); // include own activity
  const since = b.since ? new Date(b.since).getTime() : 0;
  const feed = activity
    .filter(e => followingSet.has(e.userId) && new Date(e.createdAt).getTime() > since)
    .slice(0, 200);
  return { events: feed };
};

// POST /social/thread/post  { token, type:'show'|'movie'|'group', refId, body, parentId? }
routes['/social/thread/post'] = (b) => {
  const u = userFor(b.token);
  rateLimit('post', u, POST_MAX, POST_WINDOW_MS, 'Too many posts — wait a minute');
  if (!['show', 'movie', 'group'].includes(b.type)) throw err(400, 'type must be show, movie, or group');
  if (!b.refId || typeof b.refId !== 'string') throw err(400, 'refId required');
  if (!validBody(b.body)) throw err(400, 'Post body required (max 4000 chars)');
  // validate group exists and is approved
  if (b.type === 'group') {
    const g = groups.find(g => g.id === b.refId);
    if (!g || g.status !== 'approved') throw err(404, 'Group not found');
  }
  const ctx = `${b.type}_${b.refId}`;
  const posts = loadPosts(ctx);
  const post = {
    id: uid(), authorId: u, body: b.body.trim(),
    createdAt: new Date().toISOString(), editedAt: null,
    parentId: b.parentId || null,
    context: { type: b.type, refId: b.refId },
    removed: false, removedBy: null, removedAt: null, removedReason: null,
  };
  posts.push(post);
  savePosts(ctx);
  return { ok: true, post };
};

// POST /social/thread/get  { type, refId, since? }  → posts (no auth required to read)
routes['/social/thread/get'] = (b) => {
  if (!['show', 'movie', 'group'].includes(b.type)) throw err(400, 'Invalid type');
  if (!b.refId || typeof b.refId !== 'string') throw err(400, 'refId required');
  if (b.type === 'group') {
    const g = groups.find(g => g.id === b.refId);
    if (!g || g.status !== 'approved') throw err(404, 'Group not found');
  }
  const ctx = `${b.type}_${b.refId}`;
  const posts = loadPosts(ctx);
  const since = b.since ? new Date(b.since).getTime() : 0;
  const visible = posts
    .filter(p => !p.removed && new Date(p.createdAt).getTime() > since)
    .slice(-200); // most recent 200
  return { posts: visible };
};

// POST /social/thread/remove  { token, postId, type, refId, reason? }
routes['/social/thread/remove'] = (b) => {
  const u = userFor(b.token);
  if (!b.postId || !b.type || !b.refId) throw err(400, 'postId, type, refId required');
  const ctx = `${b.type}_${b.refId}`;
  const posts = loadPosts(ctx);
  const post = posts.find(p => p.id === b.postId);
  if (!post) throw err(404, 'Post not found');
  if (post.removed) return { ok: true }; // already removed — idempotent

  // who can remove: the author, a group mod (for group posts), or admin
  const isAuthor  = post.authorId === u;
  const isAdmin   = u === ADMIN_USER;
  let   isMod     = false;
  if (b.type === 'group') {
    const g = groups.find(g => g.id === b.refId);
    isMod = g && (g.moderators || []).includes(u);
  }
  if (!isAuthor && !isMod && !isAdmin) throw err(403, 'Not allowed to remove this post');

  post.removed = true; post.removedBy = u;
  post.removedAt = new Date().toISOString();
  post.removedReason = (b.reason || '').slice(0, 200);
  savePosts(ctx);

  // log mod/admin removals (not self-removals)
  if (!isAuthor) {
    modlog.push({ id: uid(), modId: u, action: 'remove_post', targetId: b.postId,
      groupId: b.type === 'group' ? b.refId : null,
      reason: post.removedReason, createdAt: post.removedAt });
    queueWrite(F.modlog(), () => modlog);
  }
  return { ok: true };
};

// ---- groups ----

// POST /social/groups/list  { status? }  → approved groups (no auth to read)
routes['/social/groups/list'] = (b) => {
  const status = b.status || 'approved';
  // only admin can see pending/rejected
  if (status !== 'approved') adminOnly(b.token);
  return { groups: groups.filter(g => g.status === status) };
};

// POST /social/groups/create  { token, name, description, rules? }
routes['/social/groups/create'] = (b) => {
  const u = userFor(b.token);
  rateLimit('group_create', u, 5, 24 * 60 * 60 * 1000, 'Too many group requests today');
  if (!b.name || typeof b.name !== 'string' || b.name.trim().length < 2)
    throw err(400, 'Group name required (min 2 chars)');
  if (!b.description || typeof b.description !== 'string' || b.description.trim().length < 10)
    throw err(400, 'Description required (min 10 chars)');
  const name = b.name.trim().slice(0, 80);
  if (groups.find(g => g.name.toLowerCase() === name.toLowerCase() && g.status !== 'rejected'))
    throw err(409, 'A group with that name already exists or is pending');
  const group = {
    id: uid(), name, description: b.description.trim().slice(0, 500),
    rules: (b.rules || '').trim().slice(0, 1000),
    createdBy: u, createdAt: new Date().toISOString(),
    status: 'pending',
    moderators: [u],
  };
  groups.push(group);
  queueWrite(F.groups(), () => groups);
  return { ok: true, group };
};

// POST /social/groups/mod/appoint  { token, groupId, username }
routes['/social/groups/mod/appoint'] = (b) => {
  const u = userFor(b.token);
  const g = groups.find(g => g.id === b.groupId);
  if (!g || g.status !== 'approved') throw err(404, 'Group not found');
  if (g.createdBy !== u && u !== ADMIN_USER) throw err(403, 'Only the group creator or admin can appoint moderators');
  const them = (b.username || '').trim().toLowerCase();
  if (!users[them]) throw err(404, 'User not found');
  if (!(g.moderators || []).includes(them)) g.moderators = [...(g.moderators || []), them];
  queueWrite(F.groups(), () => groups);
  return { ok: true };
};

// POST /social/groups/mod/ban  { token, groupId, username, reason? }
routes['/social/groups/mod/ban'] = (b) => {
  const u = userFor(b.token);
  const g = groups.find(g => g.id === b.groupId);
  if (!g || g.status !== 'approved') throw err(404, 'Group not found');
  const isMod = (g.moderators || []).includes(u) || u === ADMIN_USER;
  if (!isMod) throw err(403, 'Moderators only');
  const them = (b.username || '').trim().toLowerCase();
  if (!users[them]) throw err(404, 'User not found');
  g.banned = g.banned || [];
  if (!g.banned.includes(them)) g.banned.push(them);
  queueWrite(F.groups(), () => groups);
  modlog.push({ id: uid(), modId: u, action: 'ban_from_group', targetId: them,
    groupId: g.id, reason: (b.reason || '').slice(0, 200), createdAt: new Date().toISOString() });
  queueWrite(F.modlog(), () => modlog);
  return { ok: true };
};

// ---- admin ----

// POST /social/admin/groups/approve  { token, groupId }
routes['/social/admin/groups/approve'] = (b) => {
  adminOnly(b.token);
  const g = groups.find(g => g.id === b.groupId);
  if (!g) throw err(404, 'Group not found');
  g.status = 'approved'; g.approvedAt = new Date().toISOString();
  queueWrite(F.groups(), () => groups);
  return { ok: true, group: g };
};

// POST /social/admin/groups/reject  { token, groupId, reason? }
routes['/social/admin/groups/reject'] = (b) => {
  adminOnly(b.token);
  const g = groups.find(g => g.id === b.groupId);
  if (!g) throw err(404, 'Group not found');
  g.status = 'rejected'; g.rejectedAt = new Date().toISOString();
  g.rejectedReason = (b.reason || '').slice(0, 300);
  queueWrite(F.groups(), () => groups);
  return { ok: true };
};

// POST /social/admin/ban_user  { token, username, reason? }
routes['/social/admin/ban_user'] = (b) => {
  adminOnly(b.token);
  const username = (b.username || '').trim().toLowerCase();
  if (!users[username]) throw err(404, 'User not found');
  if (username === ADMIN_USER) throw err(400, 'Cannot ban the admin');
  users[username].banned = true;
  users[username].bannedReason = (b.reason || '').slice(0, 300);
  users[username].bannedAt = new Date().toISOString();
  writeJSON(F.users(), users);
  modlog.push({ id: uid(), modId: ADMIN_USER, action: 'ban_user', targetId: username,
    groupId: null, reason: users[username].bannedReason, createdAt: users[username].bannedAt });
  queueWrite(F.modlog(), () => modlog);
  return { ok: true };
};

// POST /social/admin/modlog  { token }
routes['/social/admin/modlog'] = (b) => {
  adminOnly(b.token);
  return { entries: modlog.slice(-500) };
};

// ---- support tickets ----

// POST /social/support/open  { token, subject, body }
routes['/social/support/open'] = (b) => {
  const u = userFor(b.token);
  rateLimit('support', u, 5, 60 * 60 * 1000, 'Too many support tickets — wait an hour');
  if (!b.subject || typeof b.subject !== 'string' || b.subject.trim().length < 3)
    throw err(400, 'Subject required');
  if (!validBody(b.body)) throw err(400, 'Body required');
  const ticket = {
    id: uid(), authorId: u,
    subject: b.subject.trim().slice(0, 120),
    createdAt: new Date().toISOString(),
    status: 'open',
    messages: [{ authorId: u, body: b.body.trim(), createdAt: new Date().toISOString() }],
    escalatedAt: null, resolvedAt: null, lastReplyAt: new Date().toISOString(),
  };
  tickets.push(ticket);
  queueWrite(F.tickets(), () => tickets);
  return { ok: true, ticket };
};

// POST /social/support/reply  { token, ticketId, body }
routes['/social/support/reply'] = (b) => {
  const u = userFor(b.token);
  const ticket = tickets.find(t => t.id === b.ticketId);
  if (!ticket) throw err(404, 'Ticket not found');
  // only the author or admin can reply
  if (ticket.authorId !== u && u !== ADMIN_USER) throw err(403, 'Not your ticket');
  if (ticket.status === 'resolved') throw err(400, 'Ticket is already resolved');
  if (!validBody(b.body)) throw err(400, 'Body required');
  ticket.messages.push({ authorId: u, body: b.body.trim(), createdAt: new Date().toISOString() });
  ticket.lastReplyAt = new Date().toISOString();
  if (ticket.status === 'open') ticket.status = 'in_progress';
  queueWrite(F.tickets(), () => tickets);
  return { ok: true };
};

// POST /social/support/escalate  { token, ticketId }  — user forces early escalation
routes['/social/support/escalate'] = (b) => {
  const u = userFor(b.token);
  const ticket = tickets.find(t => t.id === b.ticketId);
  if (!ticket) throw err(404, 'Ticket not found');
  if (ticket.authorId !== u) throw err(403, 'Not your ticket');
  ticket.status = 'escalated';
  ticket.escalatedAt = new Date().toISOString();
  queueWrite(F.tickets(), () => tickets);
  return { ok: true };
};

// POST /social/support/resolve  { token, ticketId }
routes['/social/support/resolve'] = (b) => {
  const u = userFor(b.token);
  const ticket = tickets.find(t => t.id === b.ticketId);
  if (!ticket) throw err(404, 'Ticket not found');
  if (ticket.authorId !== u && u !== ADMIN_USER) throw err(403, 'Not your ticket');
  ticket.status = 'resolved';
  ticket.resolvedAt = new Date().toISOString();
  queueWrite(F.tickets(), () => tickets);
  return { ok: true };
};

// POST /social/support/list  { token }  — user sees their tickets; admin sees all
routes['/social/support/list'] = (b) => {
  const u = userFor(b.token);
  const mine = u === ADMIN_USER ? tickets : tickets.filter(t => t.authorId === u);
  return { tickets: mine.slice(-100) };
};

// ---- 24-hour auto-escalation ----

function runEscalation() {
  const cutoff = Date.now() - TICKET_ESCALATE_MS;
  let changed = false;
  for (const t of tickets) {
    if (t.status !== 'open' && t.status !== 'in_progress') continue;
    if (new Date(t.lastReplyAt || t.createdAt).getTime() < cutoff) {
      t.status = 'escalated';
      t.escalatedAt = new Date().toISOString();
      changed = true;
      console.log(`[social] ticket ${t.id} auto-escalated (no reply in 24h)`);
    }
  }
  if (changed) queueWrite(F.tickets(), () => tickets);
}

setInterval(runEscalation, 60 * 60 * 1000).unref(); // check every hour

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/social/health')
    return send(res, 200, {
      ok: true, app: 'endless-watch-social',
      users: Object.keys(users).length,
      groups: groups.filter(g => g.status === 'approved').length,
      pendingGroups: groups.filter(g => g.status === 'pending').length,
      openTickets: tickets.filter(t => t.status === 'open' || t.status === 'in_progress').length,
      escalatedTickets: tickets.filter(t => t.status === 'escalated').length,
    });

  const route = routes[url];
  if (req.method === 'POST' && route) {
    const ip = (process.env.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',')[0].trim())
      || req.socket.remoteAddress || 'unknown';
    try {
      send(res, 200, await route(await readBody(req), ip));
    } catch (e) {
      send(res, e.status || 500, { error: e.message || 'Server error' });
    }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Endless Watch social server on ${HOST}:${PORT}  data=${DATA_DIR}  users=${Object.keys(users).length}`);
});

process.on('SIGTERM', () => { flushWritesSync(); process.exit(0); });
process.on('SIGINT',  () => { flushWritesSync(); process.exit(0); });

module.exports = { _routes: routes, _state: { users, tokens, groups, activity, tickets, follows, modlog } };
