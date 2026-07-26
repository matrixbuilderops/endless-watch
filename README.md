# The Endless Watch

A personal TV & movie tracker — a self-hosted replacement for the shut-down
TV Time app. Your watch history lives on **your** devices (and your own optional
sync server), not on anyone's cloud. No subscription, nothing that can be shut down.

**What it does:** track episodes with partial-progress and rewatch history, movies,
custom lists, per-platform stats and "how fast will I finish" estimates, "where to
watch" + alerts when a show is leaving a service you use, cross-device sync, a
browser extension that auto-marks what you watch, and one-tap import of your TV
Time or Netflix history.

## Read next

- **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** — what the pieces are and how they fit
  together (the app, the sync server, the extension, data sources, privacy).
- **[SETUP.md](SETUP.md)** — step-by-step setup for your computer and your phone,
  including the browser extension and importing your history.

## Try it without setting anything up

Open **https://matrixbuilderops.github.io/showtrack/** on your phone and add it to
your home screen. It works standalone (single device); the sync server unlocks
cross-device sync, auto-tracking, and notifications. See SETUP.md.

## Components

| Folder | What it is |
|---|---|
| `/` (root) | The PWA — plain HTML/JS/CSS, no build step. |
| `server/` | The zero-dependency Node sync server (accounts, sync, availability, push). |
| `extension/` | The browser scrobbler (Netflix, Prime Video, Hulu, Crunchyroll, Paramount+, Apple TV+, Disney+, Max, Peacock, YouTube). |

Episode data by [TVmaze](https://www.tvmaze.com); movie data by
[TMDB](https://www.themoviedb.org).
