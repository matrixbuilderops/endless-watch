# Endless Watch Sync Server

Runs on your desktop and keeps your Endless Watch library identical across every
device you sign in on (phone, desktop, laptop…). It also does the background
"is this show leaving Netflix?" checks. **Zero dependencies** — just Node.

Your watch data still lives on each device (in the browser); the server holds a
copy so devices can catch up to each other. Passwords are salted+hashed; each
user's data is separate, so you can add family members later.

---

## 1. Requirements

- **Node.js 18 or newer.** Check with `node --version`.
  - Ubuntu/Debian: `sudo apt install nodejs`
  - Or from https://nodejs.org

## 2. Get the files onto the desktop

Clone the app repo (the server lives in the `server/` folder):

```bash
git clone https://github.com/matrixbuilderops/showtrack.git
cd showtrack/server
```

## 3. Run it

```bash
node server.js
```

You'll see: `Endless Watch sync server on :8570  data=…/data  users=0`

That's it — it's running. Leave this terminal open (or set up the service in
step 5 so it runs on its own). Test it in a browser on the desktop:
**http://localhost:8570** — you should see the Endless Watch app.

Config via environment variables (optional):
- `PORT` — port to listen on (default `8570`)
- `HOST` — interface to bind (default `127.0.0.1`, i.e. localhost only; `tailscale
  serve` proxies locally so it needs no change. Use `0.0.0.0` to reach it by LAN
  IP, on a trusted network only)
- `DATA_DIR` — where user data is stored (default `./data`)
- `ALLOW_ORIGIN` — one origin allowed to call the API cross-origin (default: none;
  the app is normally served by this server, so same-origin needs no CORS)
- `TRUST_PROXY` — set to `1` only behind a proxy you control, so `X-Forwarded-For`
  is used for auth rate limiting
- `MAX_USERS` — account cap (default `50`)
- `MAX_CACHED_USERS` — libraries held in memory at once (default `4`)

Only the web app itself is served over HTTP (`index.html`, `js/`, `css/`,
`icons/`, `sw.js`, the manifest). Everything else in the repo — including `.git/`
and `server/` — returns 403.

Sessions expire after about six months. `POST /api/logout` revokes the token it
presents; `{"token": "…", "all": true}` revokes every session on the account,
which is how you cut off a lost device.

## 4. Reach it from your phone

Your phone needs to load the app over **HTTPS** to install it and to talk to the
server without the browser blocking it. Easiest way that also works when you're
away from home:

### Recommended: Tailscale (free, ~10 min)

Tailscale puts your phone and desktop on a private network with real HTTPS.

1. Install Tailscale on the **desktop** and sign in: https://tailscale.com/download
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Install the **Tailscale app** on your phone, sign in with the same account.
3. On the desktop, put HTTPS in front of the server:
   ```bash
   sudo tailscale serve --bg 8570
   ```
   This prints a URL like `https://your-desktop.tailXXXX.ts.net`.
4. On your phone, open that `https://…ts.net` URL. You get the Endless Watch app,
   served securely from your own desktop. Add it to your Home Screen.
5. In the app: **More → Account & sync**. The server field is already filled in
   (it's this same address). Pick a username + password → **Create account**.
   Your library uploads. On any other device, open the same URL and **Sign in**.

Because it's Tailscale, this keeps working when you leave the house — no ports
opened on your router, nothing exposed to the public internet.

### Simple alternative: home Wi-Fi only (no HTTPS)

If you only ever use it at home and don't mind not having the installable app,
you can open `http://<desktop-lan-ip>:8570` on your phone while on the same
Wi-Fi (find the IP with `ip addr` — e.g. `192.168.1.135`). Note: some phone
browsers limit features on plain http, and you can't "Add to Home Screen" as a
real app. Tailscale is worth the 10 minutes.

## 5. Keep it running (systemd — Linux)

So the server starts on boot and restarts if it crashes:

```bash
sudo cp endless-watch-sync.service /etc/systemd/system/
# edit the file first: set User= and the paths to match your setup
sudo systemctl daemon-reload
sudo systemctl enable --now endless-watch-sync
systemctl status endless-watch-sync        # check it's running
```

Also make sure the desktop doesn't sleep (Settings → Power), or background
availability checks won't run.

## 6. Using it

- **First device:** create the account, your library uploads.
- **Every other device:** open the same URL, **Sign in** with that username +
  password. It downloads your library and stays in sync from then on.
- Changes sync automatically (when you open the app, when you background it, and
  a few seconds after you mark things). There's also a **Sync now** button.
- **Availability alerts:** in More, set "Check if shows are leaving a platform"
  to *Both* or *Only in the background*. The server checks your in-progress shows
  on a schedule and any warnings show up in the **Leaving soon** panel. (Uses
  your RapidAPI key, which syncs from the app — set it in More → Settings once.)

## Backups

All data is under `server/data/` — one folder per user. Back that folder up
however you like (it's small). You can also still use the app's own
**Download backup (JSON)** button on any device.

## Multi-user

Anyone can create their own account on your server (username + password); each
person's library is completely separate. To keep it private to people you invite,
run it behind Tailscale (as above) rather than exposing it publicly.

## Security notes

- Passwords are stored salted + scrypt-hashed, never in plain text.
- The server has no known remote-exploit surface, but it's built for a trusted
  network (your Tailscale tailnet or home LAN), not the open internet. Don't port-
  forward it to the public web; use Tailscale for remote access.
