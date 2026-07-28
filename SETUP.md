# Setting up Endless Watch

This walks you through the whole thing: the server on your computer, importing
your history, your phone, and the browser extension. Do them in order.

If you only want the app on your phone with no sync/extension, skip to
**[Just the phone, no server](#shortcut-just-the-phone-no-server)** at the bottom.

---

## Before you begin — what to bring to the computer

Two separate things travel to the machine you're setting up:

1. **The code** — cloned from the repo in Part 1b below. This is the app, the
   server, and the extension. It contains **none of your data**.
2. **Your library backup** — the ~27 MB JSON export (1,700+ shows, movies,
   watchlist, custom lists). This is **not** in the repo; copy it across
   separately (USB, a private transfer, etc.). **Your three API keys — TMDB,
   RapidAPI, and TheTVDB — are baked inside this file**, so treat it as a
   secret. Loading it (Part 2) both restores your library *and* configures every
   "where to watch" and movie-search feature. There is no separate key-entry
   step — you never type an API key anywhere.

   The app names new exports `endless-watch-backup-YYYY-MM-DD.json`. Files
   exported before the rename are called `showtrack-backup.json` and still load
   fine — the marker inside them is unchanged on purpose.

If you have the repo but not that backup file, stop and get it first: without it
the app runs but has no library and no working API keys.

## Part 1 — The server (on your computer)

The server keeps your devices in sync and powers the extension and notifications.
Best on a computer that's usually on (a desktop, a home server, etc.).

### 1a. Install Node.js 18+
Check with `node --version`. If you don't have it:
- **Ubuntu/Debian:** `sudo apt install nodejs`
- Or download from https://nodejs.org

### 1b. Get the code and start it
```bash
git clone https://github.com/matrixbuilderops/endless-watch.git
cd endless-watch/server
node server.js
```
You'll see `Endless Watch sync server on 127.0.0.1:8570`. Leave it running. Test it:
open **http://localhost:8570** in a browser on that computer — you should see the app.

The server listens on **localhost only** by default, so it isn't exposed on cafe
or hotel Wi-Fi. Tailscale (next step) connects to it locally, so the recommended
setup needs no change. If you'd rather reach it directly by LAN IP, start it with
`HOST=0.0.0.0 node server.js` — only do that on a network you trust.

### 1c. Reach it from your phone, securely (Tailscale — recommended)
Your phone needs HTTPS to install the app and talk to the server. Tailscale gives
you that with a private connection that even works away from home.

1. Install Tailscale on the **computer** and sign in:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Install the **Tailscale app** on your phone; sign in with the same account.
3. On the computer, put HTTPS in front of the server:
   ```bash
   sudo tailscale serve --bg 8570
   ```
   It prints a URL like `https://your-computer.tailXXXX.ts.net`. **That URL is
   your Endless Watch address** — use it everywhere below.

### 1d. Keep it running (optional but recommended)
So it starts on boot and restarts if it crashes:
```bash
cd endless-watch/server
sudo cp endless-watch-sync.service /etc/systemd/system/
sudo nano /etc/systemd/system/endless-watch-sync.service   # set User= and the paths
sudo systemctl daemon-reload
sudo systemctl enable --now endless-watch-sync
```
Already running the old `showtrack-sync` unit? Retire it first, or you'll have
two servers fighting over the same data directory:
```bash
sudo systemctl disable --now showtrack-sync
sudo rm /etc/systemd/system/showtrack-sync.service
sudo systemctl daemon-reload
```
Also make sure the computer doesn't sleep, or background alerts won't run.

---

## Part 2 — Load your history onto the server

You have your converted library in `showtrack-backup.json`. Two ways in:

**Option A — server-side import (best for a big library).** Stop the server, run
the import, start it again:
```bash
# from endless-watch/server, with the server stopped:
node import_backup.js <your-username> /path/to/showtrack-backup.json
```
(Create `<your-username>` first in Part 3, step 3b, then come back and run this.)

**Option B — restore in the app.** Do it once on any signed-in device:
More → **Restore from backup** → pick the JSON file. It uploads to the server and
syncs everywhere.

---

## Part 3 — Your phone

### 3a. Install the app
1. Open your Endless Watch address (the `https://…ts.net` URL) in **Safari** (iPhone)
   or **Chrome** (Android).
2. Tap **Share → Add to Home Screen** (iPhone) or **menu → Install app / Add to
   Home screen** (Android).
3. Open it from the new home-screen icon.

### 3b. Create your account
In the app: **More → Account & sync**. The server address is pre-filled. Pick a
username + password → **Create account**. (This is the username for Part 2A.)

### 3c. Turn on notifications (optional)
More → **Enable phone notifications** → allow. You'll get alerted when a show
you're watching is leaving a platform, even with the phone locked.
*iPhone note: notifications only work after you've added the app to your home
screen (step 3a) — not in a plain Safari tab.*

### 3d. Other devices
On any other phone/computer, open the same address and **Sign in** — it downloads
your library and stays in sync.

---

## Part 4 — The browser extension (auto-track what you watch)

On the computer where you watch streaming in a browser:

1. Open `chrome://extensions` (Chrome/Edge/Brave).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder from the cloned repo.
4. Click the Endless Watch icon → enter your **server address** and **sign in** with
   your account. Approve the permission prompt.

Now play something on **Netflix, Prime Video, Hulu, Crunchyroll, Paramount+,
Apple TV+, Disney+, Max, Peacock, or YouTube**. When you pass ~92% of an episode,
it marks it watched and tags the platform. A green ✓ on the icon means it landed;
open the app and it's there after the next sync.

*Firefox: use `about:debugging` → This Firefox → Load Temporary Add-on → pick
`manifest.json`.*

---

## Shortcut: just the phone, no server

Don't want a server? The app works standalone:
1. Open **https://matrixbuilderops.github.io/endless-watch/** on your phone.
2. Add it to your home screen.
3. More → **Restore from backup** (or Import TV Time) to load your library.

Your data lives on that one device — use **Download backup** now and then to keep
a copy safe. You won't get cross-device sync, auto-tracking, or push notifications
(those need the server), but everything else works.

---

## Troubleshooting

- **Can't reach the server from the phone** — both devices must be signed into the
  same Tailscale account. Confirm the `…ts.net` URL opens the app in the phone
  browser first. Reaching it by LAN IP instead needs `HOST=0.0.0.0` (see 1b);
  hosting the app somewhere other than the server itself (e.g. GitHub Pages) also
  needs `ALLOW_ORIGIN=https://your-page-host` so the browser permits the calls.
- **Signed out unexpectedly** — sessions expire after about six months. Sign in
  again; nothing is lost. If a device is lost or stolen, use **More → Account &
  sync → Sign out → Sign out everywhere** on a device you still have, which
  revokes every session on the account, then sign back in.
- **Extension isn't marking episodes** — make sure it's signed in (click the icon),
  the server is running and reachable, and you actually reached ~92% of the
  episode. Some sites need you to be on the main video page, not a preview.
- **Notifications not arriving on iPhone** — the app must be installed to the home
  screen, and notifications allowed in that installed app.
- **A show imported to the wrong episodes** — open the show, tap **Update
  episodes**, then fix any episode by tapping it.
