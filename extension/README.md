# Endless Watch Scrobbler (browser extension)

Auto-marks episodes you watch on streaming sites into your Endless Watch app, and
tags them with the platform you watched on. It uses the browser's standard Media
Session API as its backbone (works on most sites) plus tailored detection for
Netflix, Prime Video, Disney+, and Crunchyroll. Supported sites: **Netflix,
Prime Video, Hulu, Crunchyroll, Paramount+, Apple TV+, Disney+, Max, Peacock**.

YouTube is deliberately *not* included. Almost nothing there is a TV episode, so
it produced junk matches, and it meant the title of every video you finished was
sent to the server. Add `*://*.youtube.com/*` to `host_permissions` and
`content_scripts` in `manifest.json` if you want it back.

**It only sees what you watch in this browser on this computer** — phone apps and
TVs can't be tracked (no service exposes that). Use it on the desktop where you
watch in a browser; everything syncs to your phone through your Endless Watch server.

## Install (Chrome / Edge / Brave — unpacked)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and pick this `extension/` folder
4. Click the Endless Watch icon in the toolbar → sign in with the **same username and
   password** as your Endless Watch app, and the **server address** (your Tailscale
   `https://…ts.net` URL). Approve the permission prompt for your server.

Firefox: use `about:debugging` → This Firefox → Load Temporary Add-on → pick
`manifest.json` (temporary add-ons clear on restart; Chrome is stickier).

## How it works

While a video plays, the extension reads the show/episode from the page. When
you pass ~92% of the episode, it sends it to your server, which matches it on
TVmaze and marks it watched (platform set to the site you watched on). Open the
Endless Watch app and it's there after the next sync. A green ✓ badge on the icon
means a scrobble just landed.

## Tuning

Detection is layered in `content.js`: the Media Session API (`fromMediaSession`)
is the cross-site backbone, per-site DOM selectors live in the `SITE` registry
(Netflix, Prime Video, Disney+, Crunchyroll), and `derive()` falls back to the
page title. If a site changes its layout and detection drifts, add or fix its
entry in `SITE`, or rely on the Media Session / title fallback which needs no
site-specific code.
