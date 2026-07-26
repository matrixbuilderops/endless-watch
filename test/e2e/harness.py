"""Shared plumbing for the phone end-to-end tests.

Ground rules, so these tests mean something:

  * The app under test is the real one, served by the real sync server. Nothing
    is stubbed, shimmed, or built specially for the tests — index.html, js/*,
    sw.js and server/server.js are byte-for-byte what ships.
  * The server gets a throwaway DATA_DIR, so your actual library is never
    touched.
  * Interactions are real: taps on real elements, the real file chooser, the
    real on-screen forms. IndexedDB is only ever *read* to assert on state.
  * http://127.0.0.1 counts as a secure context, so service workers, the Cache
    API and IndexedDB all behave as they do over HTTPS on a phone.
"""

import json
import socket
import subprocess
import tempfile
import shutil
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SERVER_JS = REPO / "server" / "server.js"

# A phone. Chromium device emulation: 390x844 at 3x, touch events, mobile UA.
PHONE = {
    "viewport": {"width": 390, "height": 844},
    "device_scale_factor": 3,
    "is_mobile": True,
    "has_touch": True,
    "user_agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                   "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    """The real sync server, on a throwaway data dir."""

    def __init__(self):
        self.data_dir = tempfile.mkdtemp(prefix="showtrack-e2e-")
        self.port = free_port()
        self.origin = f"http://127.0.0.1:{self.port}"
        self.proc = None

    def start(self):
        self.proc = subprocess.Popen(
            ["node", str(SERVER_JS)],
            env={"PATH": "/usr/bin:/bin", "PORT": str(self.port), "DATA_DIR": self.data_dir},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{self.origin}/api/health", timeout=1)
                return self
            except Exception:
                if self.proc.poll() is not None:
                    raise RuntimeError("server exited:\n" + self.proc.stdout.read())
                time.sleep(0.05)
        raise RuntimeError("server did not come up")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.stop()


class Phone:
    """One device: its own browser context, so it gets its own IndexedDB,
    localStorage, service worker and session — exactly like a separate phone."""

    def __init__(self, browser, server, name, clock_offset_ms=0):
        self.name = name
        self.server = server
        self.errors = []          # page errors + console errors, for assertions
        self.context = browser.new_context(**PHONE, base_url=server.origin)

        # Simulate a device whose clock is wrong. The app is untouched; this is
        # the same thing that happens when a phone's clock drifts or is set by
        # hand, and it is the precondition for the sync bug being regressed on.
        if clock_offset_ms:
            self.context.add_init_script(
                f"(() => {{ const real = Date.now; Date.now = () => real() + {clock_offset_ms}; }})()"
            )

        self.page = self.context.new_page()
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.on("console", self._on_console)
        # the app uses confirm()/prompt(); a real user answers them
        self.prompt_answer = ""
        self.page.on("dialog", lambda d: d.accept(self.prompt_answer))

    def _on_console(self, msg):
        if msg.type == "error":
            self.errors.append(f"console: {msg.text}")

    def open(self):
        self.page.goto("/", wait_until="load")
        # boot() is async: wait until it has rendered and the SW is active
        self.page.wait_for_function("() => !!document.querySelector('#view-title').textContent")
        self.page.evaluate("() => navigator.serviceWorker.ready.then(() => true)")
        return self

    # ---- normal interactions ----

    def tab(self, view):
        self.page.click(f'#tabbar .tab[data-view="{view}"]')
        self.page.wait_for_selector(f"#view-{view}.active")

    def tap(self, selector):
        self.page.click(selector)

    def toast(self):
        return self.page.text_content("#toast") or ""

    def wait_toast(self, contains, timeout=15000):
        self.page.wait_for_function(
            """([txt]) => { const t = document.querySelector('#toast');
                 return t && !t.classList.contains('hidden') && t.textContent.includes(txt); }""",
            arg=[contains], timeout=timeout)

    def sheet_choose(self, label):
        """Tap an option in the bottom action sheet by its exact visible label
        (:text-is, not :has-text — 'Watched' is a prefix of 'Watched again')."""
        self.page.wait_for_selector("#sheet:not(.hidden)")
        self.page.click(f'#sheet .sheet-btn:text-is("{label}")')

    def restore_backup(self, data):
        """Tap 'Restore from backup' and pick a file, through the file chooser."""
        path = Path(self.server.data_dir) / f"seed-{self.name}.json"
        path.write_text(json.dumps(data))
        with self.page.expect_file_chooser() as fc:
            self.page.click("#btn-restore")
        fc.value.set_files(str(path))
        self.wait_toast("Backup restored")

    def sign_up(self, user, password):
        self.tab("more")
        self.page.fill("#acc-server", self.server.origin)
        self.page.fill("#acc-user", user)
        self.page.fill("#acc-pass", password)
        self.page.click("#btn-register")
        self.page.wait_for_selector("#sync-signedin:not(.hidden)")

    def sign_in(self, user, password):
        self.tab("more")
        self.page.fill("#acc-server", self.server.origin)
        self.page.fill("#acc-user", user)
        self.page.fill("#acc-pass", password)
        self.page.click("#btn-login")
        self.page.wait_for_selector("#sync-signedin:not(.hidden)")

    def sync_now(self):
        self.tab("more")
        self.page.click("#btn-sync")
        # the button re-labels itself while working and resets when done
        self.page.wait_for_function(
            "() => { const b = document.querySelector('#btn-sync'); return b && !b.disabled; }",
            timeout=30000)

    # ---- observation only ----

    def db(self, store):
        """Read an IndexedDB store out of the live app."""
        return self.page.evaluate(
            """async (store) => {
                 const db = await new Promise((res, rej) => {
                   const r = indexedDB.open('showtrack');
                   r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                 });
                 return await new Promise((res, rej) => {
                   const t = db.transaction(store, 'readonly').objectStore(store).getAll();
                   t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
                 });
               }""", store)

    def sw_handles(self, url, method="GET"):
        """Does the real service worker take over this request?

        Dispatches a genuine FetchEvent at the shipped sw.js handler inside the
        worker and reports whether it called respondWith. The Cache.put()
        rejection this guards against happens inside the worker and is invisible
        from the page — no console event, no difference in what fetch() returns —
        so the routing decision is asked for directly.
        """
        worker = self.context.service_workers[0]
        return worker.evaluate(
            """([url, method]) => {
                 const ev = new FetchEvent('fetch', { request: new Request(url, { method }) });
                 let responded = false;
                 ev.respondWith = (r) => { responded = true; if (r && r.catch) r.catch(() => {}); };
                 self.dispatchEvent(ev);
                 return responded;
               }""", [url, method])

    def cached_urls(self):
        return self.page.evaluate(
            """async () => {
                 const names = await caches.keys();
                 const out = [];
                 for (const n of names) {
                   const c = await caches.open(n);
                   for (const req of await c.keys()) out.push(new URL(req.url).pathname);
                 }
                 return out;
               }""")

    def close(self):
        self.context.close()


def seed_library(**overrides):
    """A small, deterministic library in the app's real backup format.

    status 'Ended' on purpose: syncStaleShows() skips ended shows, so seeding
    does not reach out to TVmaze and the tests stay hermetic.
    """
    data = {
        "app": "showtrack",
        "version": 3,
        "exportedAt": "2026-01-01T00:00:00.000Z",
        "shows": [{
            "id": 1001, "name": "Test Show Alpha", "image": None, "imageBig": None,
            "status": "Ended", "premiered": "2020-01-01", "ended": "2020-03-01",
            "network": "TestNet", "genres": ["Drama"], "summary": "",
            "tvdbId": None, "imdbId": "tt1000001",
            "followedAt": "2020-01-01T00:00:00.000Z", "archived": False, "private": False,
            "platform": "Netflix", "lastEpisodeSync": "2026-01-01T00:00:00.000Z",
        }],
        "episodes": [
            {"id": 2001, "showId": 1001, "season": 1, "number": 1, "name": "Pilot",
             "airdate": "2020-01-01", "airstamp": "2020-01-01T01:00:00Z", "runtime": 30, "type": "regular"},
            {"id": 2002, "showId": 1001, "season": 1, "number": 2, "name": "Second",
             "airdate": "2020-01-08", "airstamp": "2020-01-08T01:00:00Z", "runtime": 30, "type": "regular"},
            {"id": 2003, "showId": 1001, "season": 1, "number": 3, "name": "Third",
             "airdate": "2020-01-15", "airstamp": "2020-01-15T01:00:00Z", "runtime": 30, "type": "regular"},
        ],
        # E1 already finished twice, with the dates recorded — the thing that
        # used to get wiped by marking it watched again.
        "watched": [{
            "epId": 2001, "showId": 1001, "watchedAt": "2022-01-01T00:00:00.000Z",
            "progress": 100, "rewatchCount": 2,
            "rewatches": ["2021-06-01T00:00:00.000Z", "2022-01-01T00:00:00.000Z"],
            "source": "app",
        }],
        "movies": [], "watchlist": [], "lists": [], "kv": [],
    }
    data.update(overrides)
    return data


def seed_big_library(episode_count):
    """A library big enough to force multi-page pulls (PAGE_LIMIT is 4000) and
    chunked pushes (CHUNK is 5000)."""
    data = seed_library()
    data["episodes"] = [{
        "id": 3000 + i, "showId": 1001,
        "season": 1 + i // 100, "number": 1 + i % 100, "name": f"Episode {i}",
        "airdate": "2020-01-01", "airstamp": "2020-01-01T01:00:00Z",
        "runtime": 30, "type": "regular",
    } for i in range(episode_count)]
    data["watched"] = []
    return data
