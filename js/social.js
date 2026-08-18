// Endless Watch — Social client
// Wraps every social server endpoint and persists the session token + server URL
// in the kv store so it survives page reloads.
//
// All functions throw on error (callers must try/catch).
// Nothing here touches the personal watch library — social data stays on the social server.

import { kv } from './db.js';

// ---- session state (loaded at init) ----

let _server = '';   // e.g. 'https://social.example.com'  (no trailing slash)
let _token  = '';
let _username = '';

export const social = {

  // ---- session ----

  async init() {
    _server   = (await kv.get('social:server',   '')) || '';
    _token    = (await kv.get('social:token',    '')) || '';
    _username = (await kv.get('social:username', '')) || '';
  },

  configured() { return Boolean(_server && _token); },
  username()   { return _username; },
  server()     { return _server; },

  async setServer(url) {
    _server = url.replace(/\/+$/, '');
    await kv.set('social:server', _server);
  },

  async register(server, username, password) {
    await social.setServer(server);
    const d = await _post('/social/register', { username, password });
    await _saveSession(d.token, d.username);
    return d;
  },

  async login(server, username, password) {
    await social.setServer(server);
    const d = await _post('/social/login', { username, password });
    await _saveSession(d.token, d.username);
    return d;
  },

  async logout() {
    try { await _post('/social/logout', { token: _token }); } catch { /* best-effort */ }
    await _clearSession();
  },

  // ---- profile ----

  async updateProfile({ bio, avatar, serverUrl }) {
    return _post('/social/profile/update', { token: _token, bio, avatar, serverUrl });
  },

  async getProfile(username) {
    return _post('/social/users/get', { username });
  },

  // ---- follows ----

  async follow(username)   { return _post('/social/follow',   { token: _token, username }); },
  async unfollow(username) { return _post('/social/unfollow', { token: _token, username }); },
  async listFollows()      { return _post('/social/follows/list', { token: _token }); },

  // ---- activity ----

  async postActivity({ type, showName, showId, season, episode }) {
    return _post('/social/activity/post', { token: _token, type, showName, showId, season, episode });
  },

  async getFeed(since) {
    return _post('/social/activity/feed', { token: _token, since });
  },

  // ---- threads ----

  async postToThread({ type, refId, body, parentId }) {
    return _post('/social/thread/post', { token: _token, type, refId, body, parentId });
  },

  async getThread({ type, refId, since }) {
    return _post('/social/thread/get', { type, refId, since });
  },

  async removePost({ postId, type, refId, reason }) {
    return _post('/social/thread/remove', { token: _token, postId, type, refId, reason });
  },

  // ---- groups ----

  async listGroups(status = 'approved') {
    const payload = status === 'approved' ? {} : { token: _token, status };
    if (status !== 'approved') payload.status = status;
    return _post('/social/groups/list', payload);
  },

  async createGroup({ name, description, rules }) {
    return _post('/social/groups/create', { token: _token, name, description, rules });
  },

  async appointMod({ groupId, username }) {
    return _post('/social/groups/mod/appoint', { token: _token, groupId, username });
  },

  async banFromGroup({ groupId, username, reason }) {
    return _post('/social/groups/mod/ban', { token: _token, groupId, username, reason });
  },

  // ---- support tickets ----

  async openTicket({ subject, body }) {
    return _post('/social/support/open', { token: _token, subject, body });
  },

  async replyTicket({ ticketId, body }) {
    return _post('/social/support/reply', { token: _token, ticketId, body });
  },

  async escalateTicket(ticketId) {
    return _post('/social/support/escalate', { token: _token, ticketId });
  },

  async resolveTicket(ticketId) {
    return _post('/social/support/resolve', { token: _token, ticketId });
  },

  async listTickets() {
    return _post('/social/support/list', { token: _token });
  },

  // ---- admin ----

  async approveGroup(groupId) {
    return _post('/social/admin/groups/approve', { token: _token, groupId });
  },

  async rejectGroup(groupId, reason) {
    return _post('/social/admin/groups/reject', { token: _token, groupId, reason });
  },

  async banUser(username, reason) {
    return _post('/social/admin/ban_user', { token: _token, username, reason });
  },

  async modLog() {
    return _post('/social/admin/modlog', { token: _token });
  },

  // ---- health ----

  async health() {
    if (!_server) throw new Error('Social server not configured');
    const res = await fetch(_server + '/social/health');
    if (!res.ok) throw new Error(`Social server error: ${res.status}`);
    return res.json();
  },
};

// ---- internals ----

async function _post(route, payload) {
  if (!_server) throw new Error('Social server not configured — set it in Social settings');
  const res = await fetch(_server + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

async function _saveSession(token, username) {
  _token    = token;
  _username = username;
  await kv.set('social:token',    token);
  await kv.set('social:username', username);
}

async function _clearSession() {
  _token = _username = '';
  await kv.set('social:token',    '');
  await kv.set('social:username', '');
}
