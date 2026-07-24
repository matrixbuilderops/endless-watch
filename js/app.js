import { db, kv, uuid, exportAll, importAll, local, migrateStamps } from './db.js';
import { tvmaze, normalizeShow, normalizeEpisode, autoPlatform } from './api.js';
import { tmdb, tmdbImg } from './tmdb.js';
import { startImportUI } from './import.js';
import { sync, registerAccount, loginAccount, signOut, syncNow, fetchAlerts, clearAlerts } from './sync.js';
import { push } from './push.js';

// ---------- tiny helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Only allow http(s) image URLs, escaped for use inside style="...url('…')".
const imgCss = (url) => {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  return `background-image:url('${url.replace(/[\\'"()\s]/g, encodeURIComponent)}')`;
};

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// Bottom action sheet. options: [{label, value, danger}] → resolves value or null.
function sheet(title, options) {
  return new Promise(resolve => {
    const el = $('#sheet');
    el.innerHTML = `<div class="sheet-card">
      <h3>${esc(title)}</h3>
      ${options.map((o, i) =>
        `<button class="sheet-btn ${o.danger ? 'danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="sheet-btn cancel" data-i="-1">Cancel</button></div>`;
    el.classList.remove('hidden');
    el.onclick = (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b && ev.target !== el) return;
      el.classList.add('hidden');
      const i = b ? Number(b.dataset.i) : -1;
      resolve(i >= 0 ? options[i].value : null);
    };
  });
}

function fmtDate(iso) {
  if (!iso) return 'TBA';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function epCode(ep) {
  const s = String(ep.season).padStart(2, '0');
  const n = String(ep.number ?? 0).padStart(2, '0');
  return `S${s}E${n}`;
}
function hasAired(ep, now = Date.now()) {
  if (ep.airstamp) return new Date(ep.airstamp).getTime() <= now;
  if (ep.airdate) return new Date(ep.airdate + 'T23:59:59').getTime() <= now;
  return false; // no date = unaired/TBA
}
// watch-record accessors (older records have no progress/rewatchCount fields)
const wProg = (w) => w ? Math.min(100, w.progress ?? 100) : 0;
const wRe = (w) => w ? (w.rewatchCount ?? 0) : 0;
const fmtHours = (min) => min >= 1440 ? `${(min / 1440).toFixed(1)} days` : `${Math.round(min / 60)} h`;

const PLATFORM_DEFAULTS = ['Netflix', 'Hulu', 'Disney+', 'Max', 'Prime Video', 'Apple TV+', 'Crunchyroll', 'Paramount+', 'Peacock', 'YouTube'];

async function usedPlatforms() {
  const [shows, movies] = await Promise.all([db.all('shows'), db.all('movies')]);
  const used = new Set([...shows, ...movies].map(x => x.platform).filter(Boolean));
  return [...used].sort();
}

async function pickPlatform(current, suggestion) {
  const used = await usedPlatforms();
  const opts = [...new Set([...(suggestion ? [suggestion] : []), ...used, ...PLATFORM_DEFAULTS])]
    .map(p => ({ label: p + (p === current ? ' ✓' : ''), value: p }));
  opts.push({ label: '＋ New platform…', value: '__new__' });
  if (current) opts.push({ label: 'Clear platform', value: '__clear__', danger: true });
  let v = await sheet('Which platform?', opts);
  if (v === '__new__') v = (prompt('Platform name:') || '').trim() || null;
  if (v === '__clear__') return '';
  return v; // null = cancelled
}

// ---------- view switching ----------

const VIEW_TITLES = {
  next: 'Watch Next', upcoming: 'Upcoming', shows: 'My Shows',
  search: 'Search', more: 'More', detail: 'Show', import: 'Import TV Time',
};
let currentView = 'next';
let previousView = 'next';
let currentShowId = null;
let showsFilter = 'watching';
let platformFilter = '';
let privateVisible = false;
let nextLimit = 60;
let showsLimit = 120;
const isHidden = (x) => x.private && !privateVisible;

export function switchView(name) {
  if (name !== 'detail' && name !== 'import') previousView = name;
  if (name === 'next') nextLimit = 60;
  if (name === 'shows') showsLimit = 120;
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === name));
  $('#view-title').textContent = VIEW_TITLES[name] || 'ShowTrack';
  window.scrollTo(0, 0);
  render(name);
}

function render(name) {
  if (name === 'next') renderNext();
  else if (name === 'upcoming') renderUpcoming();
  else if (name === 'shows') renderShows();
  else if (name === 'more') renderMore();
  else if (name === 'detail') renderDetail(currentShowId);
  else if (name === 'search') doSearch($('#search-input').value);
}

// ---------- data assembly ----------

async function libraryState() {
  const [shows, episodes, watched] = await Promise.all([
    db.all('shows'), db.all('episodes'), db.all('watched'),
  ]);
  const watchedMap = new Map(watched.map(w => [w.epId, w]));
  const lastActivity = {};
  for (const w of watched) {
    const t = w.watchedAt ? new Date(w.watchedAt).getTime() : 0;
    if (!lastActivity[w.showId] || t > lastActivity[w.showId]) lastActivity[w.showId] = t;
  }
  const epsByShow = {};
  for (const e of episodes) (epsByShow[e.showId] ||= []).push(e);
  for (const id in epsByShow)
    epsByShow[id].sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0));
  return { shows, epsByShow, watchedMap, lastActivity };
}

// Progress model: an episode contributes fractionally (its % seen) to season/show
// percentages, but only counts as "done" at 100%.
function showProgress(show, epsByShow, watchedMap, now = Date.now()) {
  const eps = (epsByShow[show.id] || []).filter(e => e.type === 'regular' && e.number != null);
  const aired = eps.filter(e => hasAired(e, now));
  let seenUnits = 0, doneCount = 0, nextEp = null, resumePct = null;
  for (const e of aired) {
    const p = wProg(watchedMap.get(e.id));
    seenUnits += p / 100;
    if (p >= 100) doneCount++;
    else if (!nextEp) { nextEp = e; resumePct = p > 0 ? p : null; }
  }
  return {
    total: eps.length,
    aired: aired.length,
    watched: doneCount,
    behind: aired.length - doneCount,
    pct: aired.length ? Math.round(100 * seenUnits / aired.length) : 0,
    nextEp, resumePct,
  };
}

// ---------- Watch Next ----------

async function renderNext() {
  const { shows, epsByShow, watchedMap, lastActivity } = await libraryState();
  const items = [];
  for (const show of shows) {
    if (show.archived || isHidden(show)) continue;
    const p = showProgress(show, epsByShow, watchedMap);
    if (p.nextEp) items.push({ show, ...p, activity: lastActivity[show.id] || 0 });
  }
  items.sort((a, b) => b.activity - a.activity ||
    (b.nextEp.airstamp || '').localeCompare(a.nextEp.airstamp || ''));

  $('#next-empty').classList.toggle('hidden', items.length > 0);
  const shown = items.slice(0, nextLimit);
  $('#next-list').innerHTML = shown.map(({ show, nextEp, behind, resumePct }) => `
    <div class="ep-card" data-show="${show.id}">
      <div class="poster" data-open="${show.id}" style="${imgCss(show.image)}"></div>
      <div class="body">
        <div class="show-name" data-open="${show.id}">${esc(show.name)}</div>
        <div class="ep-code">${epCode(nextEp)}</div>
        <div class="ep-name">${esc(nextEp.name || '')}</div>
        <div class="ep-date">${fmtDate(nextEp.airdate || nextEp.airstamp)}${show.platform ? ` &middot; ${esc(show.platform)}` : ''}</div>
        ${resumePct ? `<div class="behind">Resume &mdash; ${resumePct}% watched</div>`
          : behind > 1 ? `<div class="behind">${behind} episodes to watch</div>` : ''}
      </div>
      <div class="actions">
        <button class="check-btn" data-watch="${nextEp.id}" data-watch-show="${show.id}"
                aria-label="Mark watched">&#10003;</button>
      </div>
    </div>`).join('')
    + (items.length > shown.length
      ? `<button class="big-btn" id="next-more">Show more (${items.length - shown.length} more shows)</button>` : '');
  const moreBtn = $('#next-more');
  if (moreBtn) moreBtn.onclick = () => { nextLimit += 120; renderNext(); };
}

// ---------- Upcoming ----------

async function renderUpcoming() {
  const { shows, epsByShow } = await libraryState();
  const now = Date.now();
  const horizon = now + 1000 * 60 * 60 * 24 * 90;
  const items = [];
  for (const show of shows) {
    if (show.archived || isHidden(show)) continue;
    for (const ep of epsByShow[show.id] || []) {
      if (hasAired(ep, now)) continue;
      const t = ep.airstamp ? new Date(ep.airstamp).getTime()
              : ep.airdate ? new Date(ep.airdate + 'T20:00:00').getTime() : null;
      if (t && t <= horizon) items.push({ show, ep, t });
    }
  }
  items.sort((a, b) => a.t - b.t);

  $('#upcoming-empty').classList.toggle('hidden', items.length > 0);
  let lastDay = '';
  $('#upcoming-list').innerHTML = items.map(({ show, ep, t }) => {
    const d = new Date(t);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
    const label = days === 0 ? 'Today' : days === 1 ? 'Tomorrow'
      : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const head = label !== lastDay ? `<div class="day-head">${label}</div>` : '';
    lastDay = label;
    return `${head}
    <div class="ep-card">
      <div class="poster" data-open="${show.id}" style="${imgCss(show.image)}"></div>
      <div class="body">
        <div class="show-name" data-open="${show.id}">${esc(show.name)}</div>
        <div class="ep-code">${epCode(ep)}</div>
        <div class="ep-name">${esc(ep.name || '')}</div>
        <div class="ep-date">${fmtDate(ep.airdate || ep.airstamp)}</div>
      </div>
    </div>`;
  }).join('');
}

// ---------- My Shows ----------

async function renderShows() {
  const { shows, epsByShow, watchedMap } = await libraryState();

  // platform filter dropdown
  const platforms = await usedPlatforms();
  const sel = $('#platform-filter');
  const selHTML = `<option value="">All platforms</option>` +
    platforms.map(p => `<option value="${esc(p)}" ${p === platformFilter ? 'selected' : ''}>${esc(p)}</option>`).join('');
  if (sel.innerHTML !== selHTML) sel.innerHTML = selHTML;
  sel.classList.toggle('hidden', platforms.length === 0);

  const tiles = [];
  for (const show of shows) {
    if (isHidden(show)) continue;
    if (platformFilter && show.platform !== platformFilter) continue;
    const p = showProgress(show, epsByShow, watchedMap);
    let bucket;
    if (show.archived) bucket = 'all';
    else if (p.behind > 0) bucket = 'watching';
    else if (show.status === 'Ended') bucket = 'ended';
    else bucket = 'done';
    if (showsFilter !== 'all' && bucket !== showsFilter) continue;
    tiles.push({ show, p });
  }
  tiles.sort((a, b) => a.show.name.localeCompare(b.show.name));

  $('#shows-empty').classList.toggle('hidden', shows.length > 0);
  const shownTiles = tiles.slice(0, showsLimit);
  $('#shows-grid').innerHTML = shownTiles.map(({ show, p }) => {
    const sub = show.archived ? 'Stopped'
      : p.behind > 0 ? `${p.behind} left` : (show.status === 'Ended' ? 'Finished' : 'Up to date');
    return `
    <div class="show-tile" data-open="${show.id}">
      <div class="poster" style="${imgCss(show.image)}">
        <div class="prog"><div style="width:${p.pct}%"></div></div>
      </div>
      <div class="t-name">${show.private ? '&#128274; ' : ''}${esc(show.name)}</div>
      <div class="t-sub">${sub} &middot; ${p.pct}%</div>
    </div>`;
  }).join('')
    + (tiles.length > shownTiles.length
      ? `<button class="big-btn" id="shows-more" style="grid-column:1/-1">Show more (${tiles.length - shownTiles.length} more)</button>` : '');
  const moreTiles = $('#shows-more');
  if (moreTiles) moreTiles.onclick = () => { showsLimit += 240; renderShows(); };
}

// ---------- Search ----------

let searchTimer = null;
let searchMode = 'shows';
async function doSearch(q) {
  if (!q.trim()) { renderRecommendations(); return; }
  if (searchMode === 'movies') return doMovieSearch(q.trim());

  let results;
  try { results = await tvmaze.search(q.trim()); }
  catch (e) { toast('Search failed — are you online?'); return; }
  const followed = new Set((await db.all('shows')).map(s => s.id));
  $('#search-results').innerHTML = results.map(({ show }) => {
    const year = show.premiered ? show.premiered.slice(0, 4) : '';
    const net = show.network?.name || show.webChannel?.name || '';
    const isF = followed.has(show.id);
    return `
    <div class="result-card">
      <div class="poster" style="${imgCss(show.image && show.image.medium)}"></div>
      <div class="body">
        <h3>${esc(show.name)}</h3>
        <div class="sub">${[year, net, show.status].filter(Boolean).map(esc).join(' &middot; ')}</div>
        <div class="sub">${(show.genres || []).slice(0, 3).map(esc).join(', ')}</div>
      </div>
      <div class="actions">
        <button class="follow-btn ${isF ? 'following' : ''}" data-follow="${show.id}">
          ${isF ? 'Following' : '+ Follow'}</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted center">No results.</p>';
}

async function doMovieSearch(q) {
  if (!(await tmdb.hasKey())) {
    $('#search-results').innerHTML = '<p class="muted center">Add your TMDB key in More → Settings to search movies.</p>';
    return;
  }
  let data;
  try { data = await tmdb.searchMovies(q); }
  catch (e) { toast(e.message); return; }
  const have = new Set((await db.all('movies')).map(m => m.tmdbId).filter(Boolean));
  $('#search-results').innerHTML = (data.results || []).map(m => {
    const year = (m.release_date || '').slice(0, 4);
    const added = have.has(m.id);
    return `
    <div class="result-card">
      <div class="poster" style="${imgCss(tmdbImg(m.poster_path, 'w185'))}"></div>
      <div class="body">
        <h3>${esc(m.title)}</h3>
        <div class="sub">${[year, 'Movie'].filter(Boolean).join(' &middot; ')}</div>
        <div class="sub">${esc((m.overview || '').slice(0, 90))}${m.overview && m.overview.length > 90 ? '…' : ''}</div>
      </div>
      <div class="actions">
        <button class="follow-btn ${added ? 'following' : ''}" data-add-movie="${m.id}">
          ${added ? 'Added' : '+ Add'}</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted center">No results.</p>';
}

// ---------- recommendations (empty-search "Discover") ----------

async function renderRecommendations() {
  const box = $('#search-results');
  if (!(await tmdb.hasKey())) {
    box.innerHTML = `<p class="muted center" style="padding:30px 16px">Search ${searchMode === 'movies' ? 'movies' : 'TV shows'} above.<br><span class="small">Add a TMDB key in More → Settings to get recommendations here.</span></p>`;
    return;
  }
  box.innerHTML = '<p class="muted center" style="padding:24px">Finding things you might like…</p>';
  try {
    if (searchMode === 'movies') {
      const movies = (await db.all('movies')).filter(m => m.tmdbId && !isHidden(m));
      if (!movies.length) { box.innerHTML = '<p class="muted center" style="padding:24px">Add a movie (via Movies search) and I\'ll recommend more like it.</p>'; return; }
      const seed = movies[Math.floor(Math.random() * movies.length)];
      const recs = (await tmdb.movieRecs(seed.tmdbId)).results || [];
      const have = new Set(movies.map(m => m.tmdbId));
      box.innerHTML = `<p class="muted small" style="margin-bottom:10px">More like <b>${esc(seed.title)}</b></p>` +
        recs.filter(m => !have.has(m.id)).slice(0, 12).map(m => movieCard(m)).join('') || '<p class="muted center">No recommendations right now.</p>';
    } else {
      const shows = (await db.all('shows')).filter(s => s.imdbId && !s.archived && !isHidden(s));
      if (!shows.length) { box.innerHTML = '<p class="muted center" style="padding:24px">Follow a show first, and I\'ll recommend more.</p>'; return; }
      const seed = shows[Math.floor(Math.random() * shows.length)];
      const found = await tmdb.findByImdb(seed.imdbId);
      const tvId = found.tv_results && found.tv_results[0] && found.tv_results[0].id;
      if (!tvId) { box.innerHTML = '<p class="muted center" style="padding:24px">No recommendations for these shows yet — try searching.</p>'; return; }
      const recs = (await tmdb.tvRecs(tvId)).results || [];
      box.innerHTML = `<p class="muted small" style="margin-bottom:10px">Because you watch <b>${esc(seed.name)}</b></p>` +
        (recs.slice(0, 12).map(t => `
          <div class="result-card">
            <div class="poster" style="${imgCss(tmdbImg(t.poster_path, 'w185'))}"></div>
            <div class="body">
              <h3>${esc(t.name)}</h3>
              <div class="sub">${[(t.first_air_date || '').slice(0, 4), 'TV'].filter(Boolean).join(' &middot; ')}</div>
              <div class="sub">${esc((t.overview || '').slice(0, 90))}${t.overview && t.overview.length > 90 ? '…' : ''}</div>
            </div>
            <div class="actions"><button class="follow-btn" data-follow-name="${esc(t.name)}">+ Follow</button></div>
          </div>`).join('') || '<p class="muted center">No recommendations right now.</p>');
    }
  } catch (e) { box.innerHTML = '<p class="muted center" style="padding:24px">Couldn\'t load recommendations.</p>'; }
}

function movieCard(m) {
  const year = (m.release_date || '').slice(0, 4);
  return `
    <div class="result-card">
      <div class="poster" style="${imgCss(tmdbImg(m.poster_path, 'w185'))}"></div>
      <div class="body">
        <h3>${esc(m.title)}</h3>
        <div class="sub">${[year, 'Movie'].filter(Boolean).join(' &middot; ')}</div>
        <div class="sub">${esc((m.overview || '').slice(0, 90))}${m.overview && m.overview.length > 90 ? '…' : ''}</div>
      </div>
      <div class="actions"><button class="follow-btn" data-add-movie="${m.id}">+ Add</button></div>
    </div>`;
}

async function followByName(name, btn) {
  try {
    const res = await tvmaze.search(name);
    if (!res.length) { toast('Not found on TVmaze'); return; }
    await followShow(res[0].show.id);
    btn.textContent = 'Following'; btn.classList.add('following'); queueSync();
  } catch { toast('Could not follow'); }
}

async function addMovieFromTmdb(tmdbId, btn) {
  const existing = (await db.all('movies')).find(m => m.tmdbId === tmdbId);
  if (existing) { toast('Already in your movies'); return; }
  // pull the search result data we already rendered, plus imdb id
  let imdbId = null;
  try { imdbId = (await tmdb.externalIds(tmdbId)).imdb_id || null; } catch {}
  const title = btn.closest('.result-card').querySelector('h3').textContent;
  const posterStyle = btn.closest('.result-card').querySelector('.poster').getAttribute('style') || '';
  const posterMatch = posterStyle.match(/url\('([^']+)'\)/);
  const movie = {
    id: uuid(), tmdbId, imdbId, title,
    poster: posterMatch ? decodeURIComponent(posterMatch[1]).replace('/w185', '/w342') : null,
    watchedAt: null, progress: 0, rewatchCount: 0, platform: '', private: false, rating: null, source: 'tmdb',
  };
  await db.put('movies', movie);
  toast(`Added "${title}"`);
  queueSync();
}

async function followShow(tvmazeId) {
  const existing = await db.get('shows', tvmazeId);
  if (existing) { toast('Already following'); return; }
  const raw = await tvmaze.show(tvmazeId);
  const show = { ...normalizeShow(raw), followedAt: new Date().toISOString(), archived: false, lastEpisodeSync: null, platform: autoPlatform(raw), private: false };
  await db.put('shows', show);
  toast(`Following ${show.name}`);
  syncShowEpisodes(tvmazeId).then(() => { if (currentView === 'next') renderNext(); });
}

// ---------- episode sync ----------

export async function syncShowEpisodes(showId) {
  if (String(showId).startsWith('tvt-')) return 0; // placeholder show: not on TVmaze, nothing to fetch
  const eps = await tvmaze.episodes(showId);
  await db.putMany('episodes', eps.map(e => normalizeEpisode(e, showId)));
  const show = await db.get('shows', showId);
  if (show) { show.lastEpisodeSync = new Date().toISOString(); await db.put('shows', show); }
  return eps.length;
}

async function syncStaleShows({ force = false } = {}) {
  const shows = await db.all('shows');
  const dayAgo = Date.now() - 86400000;
  const stale = shows.filter(s => {
    if (String(s.id).startsWith('tvt-')) return false; // placeholder: no TVmaze episodes to fetch
    if (!s.lastEpisodeSync) return true;
    if (force) return s.status !== 'Ended';
    return s.status !== 'Ended' && new Date(s.lastEpisodeSync).getTime() < dayAgo;
  });
  if (!stale.length) return 0;
  for (const s of stale) {
    try { await syncShowEpisodes(s.id); } catch (e) { console.warn('sync failed', s.name, e); }
  }
  return stale.length;
}

// ---------- watch record updates ----------

async function setEpProgress(epId, showId, progress) {
  const prev = await db.get('watched', epId);
  if (progress <= 0) { if (prev) await db.del('watched', epId); return; }
  await db.put('watched', {
    epId, showId,
    watchedAt: new Date().toISOString(),
    progress: Math.min(100, progress),
    rewatchCount: wRe(prev),
    source: 'app',
  });
}

async function bumpEpRewatch(epId, showId) {
  const prev = await db.get('watched', epId);
  const ts = new Date().toISOString();
  const keepDates = await kv.get('settings:recordRewatchDates', true);
  await db.put('watched', {
    epId, showId,
    watchedAt: ts,
    progress: 100,
    rewatchCount: wRe(prev) + 1,
    rewatches: keepDates ? [...(prev?.rewatches || []), ts] : (prev?.rewatches || []),
    source: 'app',
  });
}

function askPercent(currentPct) {
  const v = prompt('How much have you seen? (0–100%)', currentPct || '50');
  if (v === null) return null;
  const n = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
  return n;
}

// Shared action sheet for anything with progress/rewatch state.
async function progressSheet(title, current) {
  const p = wProg(current), r = wRe(current);
  const state = !current || p === 0 ? 'Not watched'
    : p < 100 ? `${p}% watched` : r > 0 ? `Watched ×${r + 1}` : 'Watched';
  return sheet(`${title} — ${state}`, [
    { label: '✓ Watched', value: 'watched' },
    ...(p >= 100 ? [{ label: `↻ Watched again (×${r + 2})`, value: 'rewatch' }] : []),
    { label: '◐ Partially watched…', value: 'partial' },
    { label: '✕ Not watched', value: 'clear', danger: true },
  ]);
}

// ---------- streaming availability (RapidAPI, in-app checks) ----------

async function fetchAvailability(show) {
  const key = await kv.get('settings:rapidApiKey', '');
  if (!key) { toast('Add your RapidAPI key in More \u2192 Settings first'); return null; }
  const cached = await kv.get('avail:' + show.id);
  if (cached && Date.now() - cached.at < 86400000) return cached.data; // 24h cache saves quota
  const base = 'https://streaming-availability.p.rapidapi.com';
  const headers = { 'x-rapidapi-key': key };
  let data = null;
  if (show.imdbId) {
    const res = await fetch(`${base}/shows/${show.imdbId}?country=us`, { headers });
    if (res.ok) data = await res.json();
  }
  if (!data) {
    const res = await fetch(`${base}/shows/search/title?title=${encodeURIComponent(show.name)}&country=us&show_type=series`, { headers });
    if (res.ok) { const arr = await res.json(); data = Array.isArray(arr) ? arr[0] || null : arr; }
  }
  await kv.set('avail:' + show.id, { at: Date.now(), data });
  return data;
}

// does a streaming-option service match one of the user's paid subscriptions?
function serviceOwned(opt, owned) {
  const name = (opt.service.name || '').toLowerCase();
  const id = (opt.service.id || '').toLowerCase();
  return owned.some(p => { const pl = p.toLowerCase(); return name.includes(pl) || pl.includes(name) || pl.includes(id); });
}

function showAvailabilitySheet(show, data, owned = []) {
  const el = $('#sheet');
  const opts = (data && data.streamingOptions && data.streamingOptions.us) || [];
  const seen = new Set();
  const rows = [];
  for (const o of opts) {
    const k = o.service.id + ':' + o.type;
    if (seen.has(k)) continue;
    seen.add(k);
    o._owned = serviceOwned(o, owned);
    rows.push(o);
  }
  // yours first, then subscriptions, then the rest
  rows.sort((a, b) => (b._owned - a._owned) || ((a.type === 'subscription' ? 0 : 1) - (b.type === 'subscription' ? 0 : 1)));
  el.innerHTML = `<div class="sheet-card">
    <h3>Where to watch \u2014 ${esc(show.name)}</h3>
    ${rows.length ? rows.map(o => `
      <div class="avail-row">
        <span class="svc">${esc(o.service.name)}${o._owned ? ' <span class="owned">\u2713 yours</span>' : ''}</span>
        <span>
          <span class="kind ${o.type === 'subscription' ? 'sub' : ''}">${esc(o.type)}</span>
          ${o.expiresSoon ? `<span class="leaving">\u26a0 leaving${o.expiresOn ? ' ' + new Date(o.expiresOn * 1000).toLocaleDateString() : ' soon'}</span>` : ''}
        </span>
      </div>`).join('')
      : '<p class="muted center" style="padding:12px 0">Not streaming anywhere in the US right now.</p>'}
    <button class="sheet-btn cancel" data-close="1">Close</button></div>`;
  el.classList.remove('hidden');
  el.onclick = (ev) => {
    if (ev.target.dataset.close || ev.target === el) el.classList.add('hidden');
  };
}

// ---------- Show detail ----------

async function renderDetail(showId) {
  const show = await db.get('shows', showId);
  if (!show) { switchView(previousView); return; }
  const [eps, watchedRows] = await Promise.all([
    db.allByIndex('episodes', 'showId', showId),
    db.allByIndex('watched', 'showId', showId),
  ]);
  const watchedMap = new Map(watchedRows.map(w => [w.epId, w]));
  eps.sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0));
  const seasons = {};
  for (const e of eps) { if (e.type === 'regular' && e.number != null) (seasons[e.season] ||= []).push(e); }
  const now = Date.now();
  const p = showProgress(show, { [showId]: eps }, watchedMap, now);

  const seasonBlock = ([sn, list]) => {
    const airedList = list.filter(e => hasAired(e, now));
    let units = 0, done = 0;
    for (const e of airedList) {
      const pr = wProg(watchedMap.get(e.id));
      units += pr / 100;
      if (pr >= 100) done++;
    }
    const sPct = airedList.length ? Math.round(100 * units / airedList.length) : 0;
    const allDone = airedList.length > 0 && done === airedList.length;
    return `
    <div class="season-block" data-season="${sn}">
      <div class="season-head">
        <span>Season ${sn} <span class="s-sub">${done}/${list.length} &middot; ${sPct}%</span></span>
        <button class="season-mark" data-season-mark="${sn}" ${allDone ? 'disabled' : ''}>
          ${allDone ? 'All watched' : 'Mark season'}</button>
      </div>
      <div class="season-eps hidden">
        ${list.map(e => {
          const w = watchedMap.get(e.id);
          const pr = wProg(w), r = wRe(w);
          const badge = pr > 0 && pr < 100 ? `<span class="pct-badge">${pr}%</span>`
            : r > 0 ? `<span class="pct-badge re">×${r + 1}</span>` : '';
          return `
          <div class="ep-row ${hasAired(e, now) ? '' : 'future'}" data-ep="${e.id}">
            <span class="num">${e.number}</span>
            <span class="nm">${esc(e.name || 'Episode ' + e.number)} ${badge}</span>
            <span class="dt">${fmtDate(e.airdate)}</span>
            <button class="mini-check ${pr >= 100 ? 'done' : ''}"
                    data-ep-toggle="${e.id}" aria-label="Toggle watched">&#10003;</button>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  };

  $('#detail-content').innerHTML = `
    <button class="back-btn" id="detail-back">&#8592; Back</button>
    <div class="detail-hero">
      <div class="poster" style="${imgCss(show.image)}"></div>
      <div class="info">
        <h2>${esc(show.name)}</h2>
        <div class="sub">${[show.network, show.status, show.premiered?.slice(0, 4)].filter(Boolean).map(esc).join(' &middot; ')}</div>
        <div class="sub">You&rsquo;ve seen <b style="color:var(--accent)">${p.pct}%</b> of this show &middot; ${p.watched}/${p.aired} episodes${p.behind ? ` &middot; ${p.behind} left` : ''}</div>
        <div class="detail-actions">
          <button class="pill-btn" id="detail-platform">&#128250; ${show.platform ? esc(show.platform) : 'Set platform'}</button>
          <button class="pill-btn" id="detail-avail">&#128225; Where to watch</button>
          <button class="pill-btn" id="detail-addlist">&#43; Add to list</button>
          <button class="pill-btn" id="detail-sync">&#8635; Update episodes</button>
          <button class="pill-btn" id="detail-archive">${show.archived ? '&#9654; Resume watching' : '&#9208; Stop watching'}</button>
          <button class="pill-btn" id="detail-private">${show.private ? '&#128275; Unmark private' : '&#128274; Make private'}</button>
          <button class="pill-btn warn" id="detail-unfollow">Remove show</button>
        </div>
      </div>
    </div>
    ${Object.entries(seasons).map(seasonBlock).join('')}
    <p class="muted small">Tip: tap an episode&rsquo;s name for more options — partial progress, rewatches.</p>`;

  $('#detail-back').onclick = () => switchView(previousView);
  $('#detail-platform').onclick = async () => {
    const v = await pickPlatform(show.platform, show.network);
    if (v === null) return;
    show.platform = v;
    await db.put('shows', show);
    renderDetail(showId);
  };
  $('#detail-avail').onclick = async () => {
    toast('Checking availability\u2026');
    try {
      const data = await fetchAvailability(show);
      const owned = await kv.get('settings:myPlatforms', []);
      if (data !== null || await kv.get('settings:rapidApiKey', '')) showAvailabilitySheet(show, data, owned);
    } catch (e) { toast('Availability check failed'); }
  };
  $('#detail-addlist').onclick = () => addToList({ type: 'series', tvmazeId: show.id, tvdbId: show.tvdbId, title: show.name });
  $('#detail-sync').onclick = async () => {
    toast('Updating…');
    try { await syncShowEpisodes(showId); toast('Episodes updated'); renderDetail(showId); }
    catch { toast('Update failed'); }
  };
  $('#detail-private').onclick = async () => {
    show.private = !show.private;
    await db.put('shows', show);
    toast(show.private ? 'Marked private — hidden from lists & stats when private mode is off' : 'No longer private');
    renderDetail(showId);
  };
  $('#detail-archive').onclick = async () => {
    show.archived = !show.archived;
    await db.put('shows', show);
    toast(show.archived ? 'Stopped watching' : 'Resumed');
    renderDetail(showId);
  };
  $('#detail-unfollow').onclick = async () => {
    if (!confirm(`Remove "${show.name}" and its watch history from your library?`)) return;
    await db.delMany('episodes', eps.map(e => e.id));
    await db.delMany('watched', watchedRows.map(w => w.epId));
    await db.del('shows', showId);
    toast('Removed');
    switchView(previousView);
  };

  // onclick assignment (not addEventListener) so re-renders don't stack handlers
  $('#detail-content').onclick = async (ev) => {
    const t = ev.target;
    if (t.dataset.seasonMark) {
      const sn = Number(t.dataset.seasonMark);
      const list = (seasons[sn] || []).filter(e => hasAired(e, now) && wProg(watchedMap.get(e.id)) < 100);
      const ts = new Date().toISOString();
      await db.putMany('watched', list.map(e => ({
        epId: e.id, showId, watchedAt: ts, progress: 100,
        rewatchCount: wRe(watchedMap.get(e.id)), source: 'app',
      })));
      toast(`Season ${sn}: ${list.length} marked watched`);
      queueSync();
      renderDetail(showId);
      return;
    }
    if (t.dataset.epToggle) {
      const epId = Number(t.dataset.epToggle);
      const pr = wProg(watchedMap.get(epId));
      await setEpProgress(epId, showId, pr >= 100 ? 0 : 100);
      queueSync();
      renderDetail(showId);
      return;
    }
    const row = t.closest('.ep-row');
    if (row && !t.closest('.mini-check')) {
      const epId = Number(row.dataset.ep);
      const ep = eps.find(e => e.id === epId);
      const w = watchedMap.get(epId);
      const action = await progressSheet(`${epCode(ep)} ${ep.name || ''}`, w);
      if (action === 'watched') await setEpProgress(epId, showId, 100);
      else if (action === 'rewatch') await bumpEpRewatch(epId, showId);
      else if (action === 'partial') {
        const n = askPercent(wProg(w));
        if (n !== null) await setEpProgress(epId, showId, n);
      }
      else if (action === 'clear') await setEpProgress(epId, showId, 0);
      if (action) { queueSync(); renderDetail(showId); }
      return;
    }
    const head = t.closest('.season-head');
    if (head) head.nextElementSibling.classList.toggle('hidden');
  };
}

export function openShow(showId) {
  // real shows have numeric ids (dataset gives strings -> Number() to match the numeric key);
  // TV-Time placeholder shows have string ids like "tvt-show-248580" -> keep them as strings,
  // else Number() -> NaN -> IDBObjectStore.get(NaN) throws and the detail view is stuck blank.
  currentShowId = /^\d+$/.test(showId) ? Number(showId) : showId;
  switchView('detail');
}

// ---------- More: stats, movies, watchlist ----------

async function renderMore() {
  const [shows, watched, episodes, movies, watchlist, lists] = await Promise.all([
    db.all('shows'), db.all('watched'), db.all('episodes'), db.all('movies'), db.all('watchlist'), db.all('lists'),
  ]);
  const epById = new Map(episodes.map(e => [e.id, e]));
  const showById = new Map(shows.map(s => [s.id, s]));
  const now = Date.now();
  const MOVIE_MIN = 110; // assumed avg movie runtime

  // total minutes seen (progress- and rewatch-aware)
  let seenMin = 0, doneEps = 0;
  const cutoff30 = now - 30 * 86400000;
  let recentMin = 0;
  for (const w of watched) {
    const wShow = showById.get(w.showId);
    if (wShow && isHidden(wShow)) continue;
    const rt = epById.get(w.epId)?.runtime || 40;
    const min = rt * (wProg(w) / 100) * (1 + wRe(w));
    seenMin += min;
    if (wProg(w) >= 100) doneEps++;
    if (w.watchedAt && new Date(w.watchedAt).getTime() >= cutoff30) recentMin += min;
  }
  for (const m of movies) {
    if (isHidden(m)) continue;
    const min = MOVIE_MIN * (wProg(m) / 100) * (1 + wRe(m));
    seenMin += min;
    if (m.watchedAt && new Date(m.watchedAt).getTime() >= cutoff30) recentMin += min;
  }

  // backlog: unseen minutes of aired episodes across followed, non-archived shows
  const watchedMap = new Map(watched.map(w => [w.epId, w]));
  const backlogByPlatform = new Map(); // platform -> {backlog, seen}
  let backlogMin = 0;
  for (const e of episodes) {
    const show = showById.get(e.showId);
    if (!show || show.archived || isHidden(show) || e.type !== 'regular' || e.number == null || !hasAired(e, now)) continue;
    const missing = (e.runtime || 40) * (1 - wProg(watchedMap.get(e.id)) / 100);
    backlogMin += missing;
    const key = show.platform || '(no platform)';
    const b = backlogByPlatform.get(key) || { backlog: 0, seen: 0 };
    b.backlog += missing;
    b.seen += (e.runtime || 40) * (wProg(watchedMap.get(e.id)) / 100);
    backlogByPlatform.set(key, b);
  }

  const pacePerDay = recentMin / 30; // your average min/day over the last 30 days
  const etaDays = pacePerDay > 0 ? Math.ceil(backlogMin / pacePerDay) : null;
  const fmtEta = (min) => pacePerDay > 0 ? `${Math.ceil(min / pacePerDay)} days at your pace` : '—';

  $('#stats').innerHTML = `
    <div class="stat"><div class="num">${shows.filter(s => !isHidden(s)).length}</div><div class="lbl">shows</div></div>
    <div class="stat"><div class="num">${doneEps.toLocaleString()}</div><div class="lbl">episodes watched</div></div>
    <div class="stat"><div class="num">${(seenMin / 1440).toFixed(1)}</div><div class="lbl">days of watching</div></div>
    <div class="stat"><div class="num">${movies.filter(m => !isHidden(m)).length}</div><div class="lbl">movies &amp; items</div></div>
    <div class="stat"><div class="num">${fmtHours(backlogMin)}</div><div class="lbl">left to watch (backlog)</div></div>
    <div class="stat"><div class="num">${etaDays != null ? etaDays + 'd' : '—'}</div><div class="lbl">to finish at your pace${pacePerDay ? ` (${Math.round(pacePerDay)} min/day)` : ''}</div></div>`;

  const platRows = [...backlogByPlatform.entries()].sort((a, b) => b[1].backlog - a[1].backlog);
  $('#platform-stats').innerHTML = platRows.length ? platRows.map(([plat, b]) => `
    <div class="simple-row"><span>${esc(plat)}</span>
      <span class="when">${fmtHours(b.backlog)} left &middot; ${fmtEta(b.backlog)}</span></div>`).join('')
    : '<p class="muted small">Set platforms on your shows (open a show → 📺 Set platform) to see per-platform breakdowns.</p>';

  const visMovies = movies.filter(m => !isHidden(m));
  const recentMovies = [...visMovies]
    .sort((a, b) => (b.watchedAt || '').localeCompare(a.watchedAt || '')).slice(0, 15);
  $('#movies-list').innerHTML = recentMovies.map(m => {
    const pr = wProg(m), r = wRe(m);
    const badge = pr > 0 && pr < 100 ? ` <span class="pct-badge">${pr}%</span>`
      : r > 0 ? ` <span class="pct-badge re">×${r + 1}</span>` : '';
    return `
    <div class="movie-row" data-movie="${m.id}">
      <div class="mini-poster" style="${imgCss(m.poster)}"></div>
      <div class="mr-body">
        <div class="mr-title">${m.private ? '&#128274; ' : ''}${esc(m.title)}${badge}</div>
        <div class="mr-sub">${m.watchedAt ? fmtDate(m.watchedAt) : 'not watched'}${m.platform ? ' &middot; ' + esc(m.platform) : ''}</div>
      </div>
    </div>`;
  }).join('') || '<p class="muted small">No movies yet — import TV Time, or add one manually below.</p>';
  if (visMovies.length > 15)
    $('#movies-list').innerHTML += `<p class="muted small center">…and ${visMovies.length - 15} more</p>`;

  $('#movies-list').onclick = async (ev) => {
    const row = ev.target.closest('[data-movie]');
    if (!row) return;
    const m = movies.find(x => x.id === row.dataset.movie);
    if (!m) return;
    const action = await sheet(m.title, [
      { label: '✓ Watched', value: 'watched' },
      ...(wProg(m) >= 100 ? [{ label: `↻ Watched again (×${wRe(m) + 2})`, value: 'rewatch' }] : []),
      { label: '◐ Partially watched…', value: 'partial' },
      { label: '📺 Set platform', value: 'platform' },
      { label: '＋ Add to list', value: 'addlist' },
      { label: m.private ? '🔓 Unmark private' : '🔒 Make private', value: 'private' },
      { label: '✕ Not watched', value: 'unwatch' },
      { label: 'Delete', value: 'delete', danger: true },
    ]);
    if (!action) return;
    if (action === 'watched') { m.progress = 100; m.watchedAt = new Date().toISOString(); }
    else if (action === 'rewatch') { const ts = new Date().toISOString(); const keep = await kv.get('settings:recordRewatchDates', true); m.progress = 100; m.rewatchCount = wRe(m) + 1; if (keep) m.rewatches = [...(m.rewatches || []), ts]; m.watchedAt = ts; }
    else if (action === 'partial') {
      const n = askPercent(wProg(m));
      if (n === null) return;
      m.progress = n; m.watchedAt = new Date().toISOString();
    }
    else if (action === 'platform') {
      const v = await pickPlatform(m.platform, null);
      if (v === null) return;
      m.platform = v;
    }
    else if (action === 'private') { m.private = !m.private; }
    else if (action === 'addlist') { await addToList({ type: 'movie', tmdbId: m.tmdbId, imdbId: m.imdbId, title: m.title }); return; }
    else if (action === 'unwatch') { m.progress = 0; m.watchedAt = null; m.rewatchCount = 0; }
    else if (action === 'delete') {
      if (!confirm(`Delete "${m.title}"?`)) return;
      await db.del('movies', m.id);
      renderMore();
      return;
    }
    await db.put('movies', m);
    renderMore();
  };

  $('#lists-list').innerHTML = lists.map(l => `
    <details class="list-block" data-list="${l.id}">
      <summary>${esc(l.name)} <span class="muted small">${(l.items || []).length} items</span></summary>
      <div class="list-actions">
        <button class="pill-btn" data-list-rename="${l.id}">Rename</button>
        <button class="pill-btn warn" data-list-delete="${l.id}">Delete list</button>
      </div>
      ${(l.items || []).map((i, idx) => `
      <div class="simple-row"><span>${i.private ? '&#128274; ' : ''}${esc(i.title || '#' + (i.tvdbId ?? i.tmdbId ?? '?'))}</span>
        <button class="mini-x" data-list-remove="${l.id}" data-idx="${idx}" aria-label="Remove">&times;</button></div>`).join('')
        || '<p class="muted small" style="padding:8px 0">Empty — add shows/movies from their page.</p>'}
    </details>`).join('')
    || '<p class="muted small">No lists yet. Make one below, or they import from TV Time.</p>';

  $('#set-tmdb').value = await kv.get('settings:tmdbKey', '');
  $('#set-rapid').value = await kv.get('settings:rapidApiKey', '');
  $('#set-tvdb').value = await kv.get('settings:tvdbKey', '');
  $('#set-availmode').value = await kv.get('settings:availMode', 'app');
  $('#set-rewatchdates').checked = await kv.get('settings:recordRewatchDates', true);
  await renderMyPlatforms();
  renderSyncUI();
  renderAlerts();

  $('#watchlist-list').innerHTML = watchlist.map(w => `
    <div class="simple-row"><span>${esc(w.title)}</span>
      <span class="when">${esc(w.type)}</span></div>`).join('')
    || '<p class="muted small">Watchlist is empty.</p>';
}

// ---------- backup / restore ----------

async function downloadBackup() {
  const data = await exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `showtrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup downloaded');
}

// ---------- global event wiring ----------

document.querySelectorAll('#tabbar .tab').forEach(t =>
  t.addEventListener('click', () => switchView(t.dataset.view)));

document.querySelectorAll('.seg[data-filter]').forEach(s => s.addEventListener('click', () => {
  document.querySelectorAll('.seg[data-filter]').forEach(x => x.classList.remove('active'));
  s.classList.add('active');
  showsFilter = s.dataset.filter;
  renderShows();
}));

document.querySelectorAll('.seg[data-searchmode]').forEach(s => s.addEventListener('click', () => {
  document.querySelectorAll('.seg[data-searchmode]').forEach(x => x.classList.remove('active'));
  s.classList.add('active');
  searchMode = s.dataset.searchmode;
  $('#search-input').placeholder = searchMode === 'movies' ? 'Search movies…' : 'Search TV shows…';
  doSearch($('#search-input').value);
}));

$('#platform-filter').addEventListener('change', (e) => {
  platformFilter = e.target.value;
  renderShows();
});

// ---------- my streaming services (subscriptions) ----------

async function renderMyPlatforms() {
  const mine = new Set(await kv.get('settings:myPlatforms', []));
  const used = await usedPlatforms();
  const all = [...new Set([...PLATFORM_DEFAULTS, ...used, ...mine])];
  $('#my-platforms').innerHTML = all.map(p =>
    `<button class="chip ${mine.has(p) ? 'on' : ''}" data-plat="${esc(p)}">${esc(p)}</button>`).join('') +
    `<button class="chip" data-plat-new="1">＋ Other…</button>`;
}
$('#my-platforms').addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-plat], [data-plat-new]');
  if (!t) return;
  const mine = new Set(await kv.get('settings:myPlatforms', []));
  if (t.dataset.platNew) {
    const p = (prompt('Streaming service name:') || '').trim();
    if (p) mine.add(p);
  } else {
    const p = t.dataset.plat;
    mine.has(p) ? mine.delete(p) : mine.add(p);
  }
  await kv.set('settings:myPlatforms', [...mine]);
  await renderMyPlatforms();
  queueSync();
});

// ---------- list management ----------

$('#btn-new-list').addEventListener('click', async () => {
  const name = (prompt('Name your new list:') || '').trim();
  if (!name) return;
  await db.put('lists', { id: uuid(), name, isPublic: false, createdAt: new Date().toISOString(), items: [] });
  toast(`List "${name}" created`);
  renderMore(); queueSync();
});
$('#lists-list').addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.dataset.listRename) {
    ev.preventDefault();
    const l = await db.get('lists', t.dataset.listRename);
    const name = (prompt('Rename list:', l.name) || '').trim();
    if (name) { l.name = name; await db.put('lists', l); renderMore(); queueSync(); }
  } else if (t.dataset.listDelete) {
    ev.preventDefault();
    const l = await db.get('lists', t.dataset.listDelete);
    if (confirm(`Delete the list "${l.name}"? (the shows themselves stay)`)) {
      await db.del('lists', t.dataset.listDelete); renderMore(); queueSync();
    }
  } else if (t.dataset.listRemove) {
    ev.preventDefault();
    const l = await db.get('lists', t.dataset.listRemove);
    l.items.splice(Number(t.dataset.idx), 1);
    await db.put('lists', l); renderMore(); queueSync();
  }
});

// add a show or movie to one of your lists (from a detail page)
async function addToList(item) {
  const lists = await db.all('lists');
  const opts = lists.map(l => ({ label: l.name + ` (${(l.items || []).length})`, value: l.id }));
  opts.push({ label: '＋ New list…', value: '__new__' });
  let choice = await sheet('Add to which list?', opts);
  if (!choice) return;
  let list;
  if (choice === '__new__') {
    const name = (prompt('Name your new list:') || '').trim();
    if (!name) return;
    list = { id: uuid(), name, isPublic: false, createdAt: new Date().toISOString(), items: [] };
  } else {
    list = await db.get('lists', choice);
  }
  list.items = list.items || [];
  if (list.items.some(i => i.title === item.title)) { toast('Already in that list'); return; }
  list.items.push(item);
  await db.put('lists', list);
  toast(`Added to "${list.name}"`);
  queueSync();
}

$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(e.target.value), 400);
});

document.body.addEventListener('click', async (ev) => {
  const t = ev.target;
  const opener = t.closest('[data-open]');
  if (opener) { openShow(opener.dataset.open); return; }
  if (t.dataset.follow) {
    const id = Number(t.dataset.follow);
    t.disabled = true;
    try { await followShow(id); t.textContent = 'Following'; t.classList.add('following'); queueSync(); }
    catch { toast('Could not follow — try again'); }
    t.disabled = false;
    return;
  }
  if (t.dataset.addMovie) {
    const id = Number(t.dataset.addMovie);
    t.disabled = true;
    try { await addMovieFromTmdb(id, t); t.textContent = 'Added'; t.classList.add('following'); }
    catch { toast('Could not add — try again'); }
    t.disabled = false;
    return;
  }
  if (t.dataset.followName) {
    t.disabled = true;
    await followByName(t.dataset.followName, t);
    t.disabled = false;
    return;
  }
  if (t.dataset.watch) {
    const epId = Number(t.dataset.watch);
    const showId = Number(t.dataset.watchShow);
    t.classList.add('done');
    await setEpProgress(epId, showId, 100);
    queueSync();
    setTimeout(renderNext, 350); // brief tick animation, then show the next episode
    return;
  }
});

$('#btn-refresh').addEventListener('click', async () => {
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  try {
    if (currentView === 'detail' && currentShowId) await syncShowEpisodes(currentShowId);
    else {
      const n = await syncStaleShows({ force: true });
      toast(n ? `Updated ${n} shows` : 'Everything is current');
    }
    render(currentView);
  } catch { toast('Refresh failed'); }
  btn.classList.remove('spinning');
});

$('#btn-add-item').addEventListener('click', async () => {
  const title = (prompt('Title of the movie/item:') || '').trim();
  if (!title) return;
  const item = { id: uuid(), title, imdbId: null, watchedAt: null, progress: 0, rewatchCount: 0, platform: '', rating: null, source: 'manual' };
  const plat = await pickPlatform('', null);
  if (plat) item.platform = plat;
  await db.put('movies', item);
  toast(`Added "${title}"`);
  renderMore();
});

function refreshPrivateBtn() {
  $('#btn-private').innerHTML = privateVisible
    ? '&#128275; Private items: <b>visible</b> — tap to hide'
    : '&#128274; Private items: <b>hidden</b> — tap to show';
}
$('#btn-private').addEventListener('click', async () => {
  privateVisible = !privateVisible;
  await kv.set('privateVisible', privateVisible);
  refreshPrivateBtn();
  render(currentView);
});

$('#btn-save-settings').addEventListener('click', async () => {
  await kv.set('settings:tmdbKey', $('#set-tmdb').value.trim());
  await kv.set('settings:rapidApiKey', $('#set-rapid').value.trim());
  await kv.set('settings:tvdbKey', $('#set-tvdb').value.trim());
  await kv.set('settings:recordRewatchDates', $('#set-rewatchdates').checked);
  toast('Settings saved');
  queueSync();
});

// ---------- account & sync ----------

function renderSyncUI() {
  const signedIn = sync.configured();
  $('#sync-signedout').classList.toggle('hidden', signedIn);
  $('#sync-signedin').classList.toggle('hidden', !signedIn);
  // when the app is served from the sync server itself, default to this origin
  const sf = $('#acc-server');
  if (!signedIn && sf && !sf.value && !/github\.io$/.test(location.hostname))
    sf.value = location.origin;
  if (signedIn) {
    const at = sync.lastSyncAt();
    $('#sync-status').textContent =
      `Signed in as ${sync.username()} · ${sync.server()}` +
      (at ? ` · last synced ${new Date(at).toLocaleString()}` : ' · not synced yet');
    refreshPushUI();
  }
}

async function refreshPushUI() {
  const btn = $('#btn-notifications'), note = $('#push-note');
  if (!btn) return;
  if (!push.supported()) {
    btn.classList.add('hidden');
    note.textContent = 'Notifications need this app installed to your home screen (on iPhone, add it via Share → Add to Home Screen first).';
    return;
  }
  btn.classList.remove('hidden');
  const on = await push.isSubscribed();
  btn.innerHTML = on ? '&#128276; Notifications on — tap to turn off' : '&#128276; Enable phone notifications';
  note.textContent = on ? 'This device will get alerted when a show is leaving a platform, even when the app is closed.' : '';
}

$('#btn-notifications').addEventListener('click', async () => {
  const btn = $('#btn-notifications');
  btn.disabled = true;
  try {
    if (await push.isSubscribed()) { await push.disable(); toast('Notifications off'); }
    else { await push.enable(); toast('Notifications on'); }
  } catch (e) { toast(e.message); }
  btn.disabled = false;
  refreshPushUI();
});

async function doSyncNow(silent = false) {
  if (!sync.configured()) return;
  const btn = $('#btn-sync');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  try {
    await syncNow((msg) => { if (btn) btn.textContent = msg; });
    if (!silent) toast('Synced');
    await renderAlerts();
    renderSyncUI();
    if (currentView !== 'more') render(currentView); // reflect pulled changes
  } catch (e) {
    if (!silent) toast('Sync failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '&#8635; Sync now'; }
  }
}

// debounced background sync after local edits
let syncTimer = null;
function queueSync() {
  if (!sync.configured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSyncNow(true), 4000);
}

async function renderAlerts() {
  let alerts = [];
  try { alerts = await fetchAlerts(); } catch { /* offline */ }
  const panel = $('#alerts-panel');
  panel.classList.toggle('hidden', alerts.length === 0);
  $('#alerts-list').innerHTML = alerts.map(a => `
    <div class="simple-row"><span>${a.kind === 'left' ? '&#10060;' : '&#9888;'} ${esc(a.message)}</span></div>`).join('');
}

$('#btn-register').addEventListener('click', async () => {
  const server = $('#acc-server').value.trim(), u = $('#acc-user').value.trim(), p = $('#acc-pass').value;
  if (!server || !u || !p) { toast('Fill in server, username, and password'); return; }
  try {
    await registerAccount(server, u, p);
    toast('Account created — uploading your library…');
    renderSyncUI();
    await doSyncNow();
  } catch (e) { toast(e.message); }
});
$('#btn-login').addEventListener('click', async () => {
  const server = $('#acc-server').value.trim(), u = $('#acc-user').value.trim(), p = $('#acc-pass').value;
  if (!server || !u || !p) { toast('Fill in server, username, and password'); return; }
  try {
    await loginAccount(server, u, p);
    toast('Signed in — syncing…');
    renderSyncUI();
    await doSyncNow();
  } catch (e) { toast(e.message); }
});
$('#btn-sync').addEventListener('click', () => doSyncNow());
$('#btn-signout').addEventListener('click', () => {
  if (!confirm('Sign out of this device? Your library stays on this device; it just stops syncing.')) return;
  signOut(); renderSyncUI(); $('#alerts-panel').classList.add('hidden');
  toast('Signed out');
});
$('#set-availmode').addEventListener('change', async (e) => {
  await kv.set('settings:availMode', e.target.value);
  queueSync();
});
$('#btn-clear-alerts').addEventListener('click', async () => {
  try { await clearAlerts(); await renderAlerts(); toast('Alerts cleared'); } catch (e) { toast('Failed'); }
});

$('#btn-backup').addEventListener('click', downloadBackup);
$('#btn-restore').addEventListener('click', () => $('#file-restore').click());
$('#file-restore').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!confirm('Replace everything in the app with this backup?')) return;
    await importAll(data);
    toast('Backup restored');
    render(currentView);
    if (sync.configured()) doSyncNow(true);
  } catch (err) { toast('Restore failed: ' + err.message); }
  e.target.value = '';
});

$('#btn-import-tvtime').addEventListener('click', () => $('#file-tvtime').click());
$('#file-tvtime').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  switchView('import');
  startImportUI(files, $('#import-content'), {
    onDone: () => { toast('Import complete!'); switchView('shows'); if (sync.configured()) doSyncNow(true); },
    onBack: () => switchView('more'),
  });
  e.target.value = '';
});

// ---------- boot ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// push local changes when the app is backgrounded/closed — good moment to sync
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') doSyncNow(true);
});

(async () => {
  privateVisible = await kv.get('privateVisible', false);
  refreshPrivateBtn();
  await migrateStamps();
  await renderNext();
  // background: refresh stale running shows once per day
  syncStaleShows().then(n => { if (n && currentView === 'next') renderNext(); });
  // sync on open (pulls changes made on other devices), then check alerts
  if (sync.configured()) doSyncNow(true);
})();
