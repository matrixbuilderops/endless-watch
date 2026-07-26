# How ShowTrack works

ShowTrack is a personal TV & movie tracker — a replacement for the shut-down
TV Time app. It's four pieces that work together, and the whole thing runs on
**your** devices. No company hosts your data, and there's no subscription.

For step-by-step setup, see **[SETUP.md](SETUP.md)**.

---

## 1. The app (what you touch)

A Progressive Web App (PWA) — a website that installs to your phone's home
screen and runs like a native app, offline included. It's plain HTML/JS with no
build step.

Your library lives in the browser's **IndexedDB** on each device:
- **shows / episodes / watched** — what you follow and how far you've watched,
  including partial progress (%) and rewatch counts with dates.
- **movies, watchlist, lists** — everything else you track.
- **kv** — your settings and API keys (stored on-device, never in the code).

Main screens: **Watch Next** (the next unwatched episode of each show),
**Upcoming** (air calendar), **Shows** (your library with progress), **Search**
(add shows & movies, plus recommendations), and **More** (stats, account, import,
settings).

## 2. The sync server (optional, but unlocks everything)

A small zero-dependency Node server you run on your own computer. It holds a copy
of your library so every device you sign into stays identical.

- **Accounts** — username + password (salted + hashed). Sessions expire after
  about six months and can be revoked (including "sign out everywhere", for a lost
  phone). Multiple people can each have their own separate library on one server.
- **Sync** — each record carries a last-modified timestamp; the newest edit wins,
  and deletions propagate. A fresh device pulls your whole library (for a large
  library, ~150,000 records in about 20 seconds). What a device *uploads* is
  tracked with a local "changed here, not yet sent" mark rather than by comparing
  timestamps — comparing them meant a device whose clock ran behind its peers
  quietly stopped uploading its own edits.
- It also **serves the app itself**, so the app and your account share one web
  address — which is what makes it work securely over HTTPS.

Without the server, the app still works fully — it's just single-device.

## 3. The browser extension (auto-tracking)

A Chrome/Firefox extension for the computer you watch on. While a video plays on
a streaming site, it reads what's playing and — at ~92% through an episode — tells
your server to mark it watched and tag the platform.

- It uses the browser's standard **Media Session API** (the same data that powers
  your OS "now playing" controls) as its backbone, so it works across most sites,
  with extra per-site detection for **Netflix, Prime Video, Disney+, Crunchyroll**
  and a general fallback for **Hulu, Paramount+, Apple TV+, Max, Peacock**, etc.
- It only sees what you watch **in that browser on that computer** — phone apps
  and TVs can't be tracked (no streaming service exposes that).

## 4. "Where to watch" & leaving-soon alerts

Using a streaming-availability API, the app can tell you where a show streams and
warn you when one is **leaving a platform you use** — so you finish it in time or
find it elsewhere on a service you already pay for. This runs either when you open
the app, or in the background on the server (your choice), and the background mode
can send a **push notification to your phone** even when it's locked.

---

## Where the data comes from (all free)

- **TVmaze** — shows, episodes, air dates, posters. Free, no key. Covers anime.
- **TMDB** — movie search and posters, plus recommendations. Free key.
- **TheTVDB** — fills in shows TVmaze doesn't have. Free key.
- **Streaming Availability (RapidAPI)** — where things stream / leaving-soon. Free tier.

Your API keys are stored on your device (and synced to your own server), never in
the public code.

## Privacy model

- Your watch history lives on your devices and, if you use it, your own server.
- The app's code is public on GitHub; **your data is not** — it never goes there.
- Keep the sync server on your home network or a private Tailscale network, not
  the open internet. Passwords are hashed; secret files are owner-only.
- Anything you mark **private** (e.g. adult content) is hidden from every list and
  from your stats until you toggle it visible.

## Importing your history

- **TV Time** — the GDPR export ZIP imports directly (More → Import).
- **Netflix** — your Netflix "Viewing Activity" CSV imports too, tagged as Netflix.
- **Backup/restore** — export your whole library to a JSON file anytime, and
  restore it on any device. The server also has a bulk-import script.
