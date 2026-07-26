// ShowTrack scrobbler content script.
//
// Strategy (most robust first):
//   1. Media Session API — navigator.mediaSession.metadata is the standard a
//      player fills for the OS "now playing" controls (title = episode,
//      artist/album = show). Works across most streaming sites without any
//      site-specific code.
//   2. Per-site DOM parsers — add the season/episode NUMBERS that Media Session
//      usually omits (Netflix "S1:E3", etc.).
//   3. document.title fallback — last resort.
//
// The server matches an episode by season+number when we have them, otherwise
// by episode NAME, so name-only signals (common) still scrobble correctly.

(() => {
  'use strict';
  const host = () => location.hostname;   // lazy: only read in the browser
  let lastKey = null, sent = false;

  const PLATFORMS = [
    [/netflix\./, 'Netflix'],
    [/primevideo\.|amazon\./, 'Prime Video'],
    [/hulu\./, 'Hulu'],
    [/crunchyroll\./, 'Crunchyroll'],
    [/paramountplus\.|paramount\./, 'Paramount+'],
    [/tv\.apple\./, 'Apple TV+'],
    [/disneyplus\./, 'Disney+'],
    [/max\.|hbomax\./, 'Max'],
    [/peacocktv\./, 'Peacock'],
    [/youtube\./, 'YouTube'],
  ];
  const platform = () => (PLATFORMS.find(([re]) => re.test(host())) || [, ''])[1];

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // ---- pure: pull season/episode numbers out of any label string ----
  function parseSE(...strings) {
    for (const s of strings) {
      if (!s) continue;
      // S1:E3 / S1E3 / Season 1 Episode 3 / S1 · E3
      const m = s.match(/S(?:eason)?\s*(\d+)\s*[^0-9A-Za-z]{0,3}E(?:pisode)?\s*(\d+)/i);
      if (m) return { season: +m[1], episode: +m[2] };
    }
    for (const s of strings) {
      if (!s) continue;
      const m = s.match(/(?:^|[^A-Za-z])E(?:pisode)?\s*(\d+)/i);
      if (m) {
        const sm = s.match(/S(?:eason)?\s*(\d+)/i);
        // no season signal -> null (not 1): let the server match by episode NAME instead of
        // guessing S1Ex and marking the wrong episode watched.
        return { season: sm ? +sm[1] : null, episode: +m[1] };
      }
    }
    return { season: null, episode: null };
  }

  // ---- pure: derive {title, season, episode, epName} from string signals ----
  // Exposed for unit testing via globalThis in a non-browser context.
  function derive({ pageTitle, msTitle, msArtist, msAlbum, siteSuffix }) {
    const se = parseSE(msTitle, msAlbum, pageTitle);
    if (se.season == null) {
      for (const s of [msTitle, msAlbum, pageTitle]) {
        const m = s && s.match(/Season\s+(\d+)/i);
        if (m) { se.season = +m[1]; break; }
      }
    }
    // show name: Media Session artist/album is the most reliable; else page title
    let show = clean(msArtist) || clean(msAlbum);
    let epName = clean(msTitle) || '';
    if (!show && pageTitle) {
      let t = pageTitle;
      if (siteSuffix) t = t.replace(siteSuffix, '');
      t = t.replace(/^(watch|stream)\s+/i, '').replace(/\s*[|\-–—:].*$/, '').trim();
      show = t;
      // if the page title had "Show: ... : Episode", take the tail as ep name
      const parts = pageTitle.replace(siteSuffix || '', '').split(/:\s*/).map(clean).filter(Boolean);
      if (!epName && parts.length >= 2) epName = parts[parts.length - 1];
    }
    // don't let the show name leak into the episode name
    if (epName && show && epName.toLowerCase() === show.toLowerCase()) epName = '';
    return { title: show, season: se.season, episode: se.episode, epName: epName || null };
  }

  // ---- Media Session snapshot ----
  function fromMediaSession() {
    try {
      const m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (!m) return {};
      return { msTitle: m.title, msArtist: m.artist, msAlbum: m.album };
    } catch { return {}; }
  }

  // ---- per-site DOM parsers: return any of {title, season, episode, epName} ----
  const SITE = {
    'Netflix': () => {
      const box = document.querySelector('[data-uia="video-title"]');
      if (!box) return {};
      const spans = [...box.querySelectorAll('span')].map(s => clean(s.textContent));
      const se = parseSE(...spans);
      return { title: clean(box.querySelector('h4')?.textContent), ...se, epName: spans[spans.length - 1] };
    },
    'Prime Video': () => ({
      title: clean(document.querySelector('.atvwebplayersdk-title-text')?.textContent),
      epName: clean(document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent),
      ...parseSE(document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent),
    }),
    'Disney+': () => ({
      title: clean(document.querySelector('.title-field, [data-testid="title"]')?.textContent),
      epName: clean(document.querySelector('.subtitle-field')?.textContent),
      ...parseSE(document.querySelector('.subtitle-field')?.textContent),
    }),
    'Crunchyroll': () => {
      const t = clean(document.querySelector('h1, .erc-current-media-info h4')?.textContent) || document.title;
      const m = t.match(/^(.*?)\s+Episode\s+(\d+)\s*[–-]\s*(.*)$/i);
      return m ? { title: clean(m[1]), season: 1, episode: +m[2], epName: clean(m[3]) } : {};
    },
  };

  const SUFFIX = /\s*[|\-–—]\s*(Netflix|Prime Video|Hulu|Crunchyroll|Paramount\+?|Apple TV\+?|Disney\+?|Max|Peacock|YouTube|Watch.*)\s*$/i;

  function detect() {
    const site = SITE[platform()] ? SITE[platform()]() : {};
    const base = derive({ ...fromMediaSession(), pageTitle: document.title, siteSuffix: SUFFIX });
    // site-specific values win where present; base fills the gaps
    return {
      title: site.title || base.title,
      season: site.season ?? base.season,
      episode: site.episode ?? base.episode,
      epName: site.epName || base.epName,
    };
  }

  function tick() {
    const video = document.querySelector('video');
    if (!video || !video.duration || isNaN(video.duration)) return;
    const info = detect();
    if (!info.title) return;

    const key = `${info.title}|${info.season ?? ''}|${info.episode ?? info.epName ?? ''}`;
    if (key !== lastKey) { lastKey = key; sent = false; }

    if (!sent && video.currentTime / video.duration >= 0.92) {
      sent = true;
      chrome.runtime.sendMessage({
        type: 'scrobble',
        data: { platform: platform(), title: info.title, season: info.season, episode: info.episode, epName: info.epName },
      });
    }
  }

  // expose the pure fns for the offline unit test
  if (typeof module !== 'undefined') module.exports = { derive, parseSE, SUFFIX };
  else setInterval(tick, 5000);
})();
