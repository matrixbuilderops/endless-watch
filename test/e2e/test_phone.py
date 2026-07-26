#!/usr/bin/env python3
"""End-to-end tests on a virtual phone.

Real app, real sync server, real taps. See harness.py for the ground rules.
Run: python3 test/e2e/test_phone.py  [-k substring] [--headed]
"""

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from playwright.sync_api import sync_playwright          # noqa: E402
from harness import Server, Phone, seed_library, seed_big_library, REPO   # noqa: E402

SHOTS = Path(__file__).parent / "screenshots"
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


# --------------------------------------------------------------------------
# booting and rendering
# --------------------------------------------------------------------------

@test
def boots_with_no_errors(browser, server):
    """The app loads on a phone and logs nothing to the error console.

    This is the cheap catch-all: a broken ES module import (js/html.js, say)
    or a throwing top-level handler shows up here and nowhere else.
    """
    phone = Phone(browser, server, "boot")
    try:
        phone.open()
        assert phone.page.text_content("#view-title") == "Watch Next"
        assert phone.page.is_visible("#tabbar")
        SHOTS.mkdir(exist_ok=True)
        phone.page.screenshot(path=str(SHOTS / "01-boot.png"))
        assert not phone.errors, f"errors on a clean boot: {phone.errors}"
    finally:
        phone.close()


@test
def restore_backup_then_browse(browser, server):
    """Seed through the real file chooser, then navigate with real taps."""
    phone = Phone(browser, server, "restore")
    try:
        phone.open()
        phone.tab("more")
        phone.restore_backup(seed_library())

        phone.tab("shows")
        phone.page.wait_for_selector('.show-tile[data-open="1001"]')
        assert "Test Show Alpha" in phone.page.text_content("#shows-grid")

        # E1 watched of 3 aired -> 2 left, and Watch Next offers S01E02
        phone.tab("next")
        phone.page.wait_for_selector(".ep-card")
        card = phone.page.text_content("#next-list")
        assert "S01E02" in card, f"expected next episode S01E02, got: {card}"
        assert "Test Show Alpha" in card
        phone.page.screenshot(path=str(SHOTS / "02-watch-next.png"))
        assert not phone.errors, phone.errors
    finally:
        phone.close()


@test
def filter_with_no_matches_says_so(browser, server):
    """Regression: a filter matching nothing rendered a blank grid silently."""
    phone = Phone(browser, server, "filter")
    try:
        phone.open()
        phone.tab("more")
        phone.restore_backup(seed_library())
        phone.tab("shows")
        phone.page.wait_for_selector(".show-tile")

        # the seeded show is mid-watch, so "Up to date" matches nothing
        phone.page.click('.seg[data-filter="done"]')
        phone.page.wait_for_function(
            "() => document.querySelector('#shows-grid').textContent.includes('No shows match')")
        assert phone.page.is_hidden("#shows-empty"), "library is not empty, so that panel must stay hidden"
        phone.page.screenshot(path=str(SHOTS / "03-empty-filter.png"))
    finally:
        phone.close()


# --------------------------------------------------------------------------
# data integrity through the UI
# --------------------------------------------------------------------------

@test
def marking_watched_keeps_rewatch_dates(browser, server):
    """Regression: setEpProgress rebuilt the record and dropped `rewatches`.

    Seeded S1E1 has been watched three times with the dates recorded. Marking
    it watched again from the episode sheet must not lose them.
    """
    phone = Phone(browser, server, "rewatch")
    try:
        phone.open()
        phone.tab("more")
        phone.restore_backup(seed_library())

        phone.tab("shows")
        phone.page.click('.show-tile[data-open="1001"]')
        phone.page.wait_for_selector("#detail-content .season-block")

        phone.page.click(".season-head")                    # expand season 1
        phone.page.wait_for_selector(".season-eps:not(.hidden)")
        phone.page.click('.ep-row[data-ep="2001"] .nm')     # tap the episode name
        phone.sheet_choose("✓ Watched")

        phone.page.wait_for_function(
            "() => !document.querySelector('#sheet').classList.contains('hidden') === false")
        rec = next(w for w in phone.db("watched") if w["epId"] == 2001)
        assert rec["progress"] == 100
        assert rec.get("rewatchCount") == 2, f"rewatch count lost: {rec}"
        assert rec.get("rewatches") == [
            "2021-06-01T00:00:00.000Z", "2022-01-01T00:00:00.000Z"], f"rewatch dates lost: {rec}"
    finally:
        phone.close()


# --------------------------------------------------------------------------
# sync between two phones
# --------------------------------------------------------------------------

@test
def library_syncs_between_two_phones(browser, server):
    """Phone A uploads its library; phone B signs in and receives it."""
    a = Phone(browser, server, "a-basic")
    b = Phone(browser, server, "b-basic")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("pair", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("pair", "hunter22")
        b.sync_now()

        b.tab("shows")
        b.page.wait_for_selector('.show-tile[data-open="1001"]')
        assert len(b.db("episodes")) == 3
        assert not a.errors, a.errors
        assert not b.errors, b.errors
    finally:
        a.close(); b.close()


@test
def a_fast_peer_clock_does_not_strand_local_edits(browser, server):
    """The flagship regression.

    Phone B's clock runs a week fast. Once phone A pulls B's records, the old
    timestamp watermark jumped a week into the future, and A silently stopped
    uploading its own edits until its clock caught up. A `_dirty` marker
    replaced that watermark; this proves A's edit still reaches B.
    """
    WEEK = 7 * 24 * 60 * 60 * 1000
    a = Phone(browser, server, "a-skew")
    b = Phone(browser, server, "b-skew", clock_offset_ms=WEEK)
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("skew", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("skew", "hunter22")
        b.sync_now()

        # B (fast clock) marks S1E2 watched and uploads it
        b.tab("next")
        b.page.wait_for_selector(".check-btn")
        b.page.click('.check-btn[data-watch="2002"]')
        b.sync_now()

        # A pulls B's future-stamped records — this is what poisoned the watermark
        a.sync_now()
        assert any(w["epId"] == 2002 for w in a.db("watched")), "A should have pulled B's edit"

        # ...and now A makes an edit of its own, with a *normal* timestamp
        a.tab("next")
        a.page.wait_for_selector('.check-btn[data-watch="2003"]')
        a.page.click('.check-btn[data-watch="2003"]')
        a.sync_now()

        b.sync_now()
        watched = {w["epId"]: w for w in b.db("watched")}
        assert 2003 in watched, (
            "A's edit never reached B — a peer's fast clock stranded local changes "
            f"(B has {sorted(watched)})")
        assert watched[2003]["progress"] == 100
    finally:
        a.close(); b.close()


@test
def removing_a_show_propagates_to_the_other_phone(browser, server):
    """Deletes travel as tombstones, which sync now drops once the server has
    them. Removing a show must still reach the other device."""
    a = Phone(browser, server, "a-del")
    b = Phone(browser, server, "b-del")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("deletes", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("deletes", "hunter22")
        b.sync_now()
        b.tab("shows")
        b.page.wait_for_selector('.show-tile[data-open="1001"]')

        a.tab("shows")
        a.page.click('.show-tile[data-open="1001"]')
        a.page.wait_for_selector("#detail-unfollow")
        a.page.click("#detail-unfollow")          # confirm() is auto-accepted
        a.wait_toast("Removed")
        a.sync_now()

        b.sync_now()
        b.tab("shows")
        b.page.wait_for_function(
            "() => !document.querySelector('.show-tile[data-open=\"1001\"]')")
        assert not any(s["id"] == 1001 for s in b.db("shows")), "the delete never arrived"
        # and the local tombstone is cleared once the server has it
        assert not a.db("_tombstones"), f"tombstones should be dropped after push: {a.db('_tombstones')}"
    finally:
        a.close(); b.close()


@test
def edits_sync_without_tapping_sync_now(browser, server):
    """queueSync: archiving a show used to sit on the device until the app was
    backgrounded. It should upload on its own."""
    a = Phone(browser, server, "a-queue")
    b = Phone(browser, server, "b-queue")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("queued", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("queued", "hunter22")
        b.sync_now()

        a.tab("shows")
        a.page.click('.show-tile[data-open="1001"]')
        a.page.wait_for_selector("#detail-archive")
        a.page.click("#detail-archive")
        a.wait_toast("Stopped watching")

        # no Sync now tap: queueSync debounces ~4s, then pushes by itself
        a.page.wait_for_timeout(7000)

        b.sync_now()
        show = next(s for s in b.db("shows") if s["id"] == 1001)
        assert show["archived"] is True, "archive never left the device on its own"
    finally:
        a.close(); b.close()


@test
def upgrading_from_the_old_watermark_uploads_pending_edits(browser, server):
    """migrateDirty: a device upgrading from the timestamp-watermark version may
    hold edits it never uploaded. The one-time migration must mark those dirty,
    or they are stranded forever once the watermark is gone.
    """
    a = Phone(browser, server, "a-upgrade")
    b = Phone(browser, server, "b-upgrade")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("upgrade", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("upgrade", "hunter22")
        b.sync_now()

        # Rewind this device to how the previous version left things: a record
        # edited locally (new _t, no _dirty marker, which did not exist yet) and
        # a push watermark from before that edit. Written straight to storage —
        # this is prior on-disk state, not a change to the app.
        a.page.evaluate("""async () => {
            const db = await new Promise(res => {
              const r = indexedDB.open('showtrack'); r.onsuccess = () => res(r.result);
            });
            const store = db.transaction('shows', 'readwrite').objectStore('shows');
            const rec = await new Promise(res => {
              const g = store.get(1001); g.onsuccess = () => res(g.result);
            });
            rec.platform = 'Edited before upgrading';
            rec._t = Date.now();
            delete rec._dirty;                       // the old version had no such field
            store.put(rec);
            localStorage.setItem('showtrack:sync:lastPushT', JSON.stringify(rec._t - 60000));
            localStorage.removeItem('showtrack:migratedDirty');
        }""")

        a.page.reload(wait_until="load")             # boot runs migrateDirty()
        a.page.wait_for_function("() => !!document.querySelector('#view-title').textContent")
        a.sync_now()

        b.sync_now()
        show = next(s for s in b.db("shows") if s["id"] == 1001)
        assert show.get("platform") == "Edited before upgrading", (
            f"the pre-upgrade edit was never uploaded: {show.get('platform')!r}")
        assert a.page.evaluate("() => localStorage.getItem('showtrack:sync:lastPushT')") is None, \
            "the old watermark should be cleaned up after migrating"
    finally:
        a.close(); b.close()


@test
def a_library_larger_than_one_page_arrives_whole(browser, server):
    """Multi-page pull. The server pages at 4000 records and now finds each
    page's start by binary-searching a memoized, seq-ordered change list. An
    off-by-one there would silently drop records mid-library, so this counts
    them: 9000 episodes is three pages, and the push side chunks at 5000 too.
    """
    a = Phone(browser, server, "a-big")
    b = Phone(browser, server, "b-big")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_big_library(9000))
        assert len(a.db("episodes")) == 9000
        a.sign_up("bigone", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("bigone", "hunter22")
        b.sync_now()

        got = b.db("episodes")
        assert len(got) == 9000, f"expected 9000 episodes across pages, got {len(got)}"
        # no gaps: every id from the seed must be present exactly once
        ids = sorted(e["id"] for e in got)
        assert ids == list(range(3000, 12000)), "records were dropped at a page boundary"
        assert len(b.db("shows")) == 1
    finally:
        a.close(); b.close()


@test
def the_later_edit_wins_when_two_phones_disagree(browser, server):
    """Two phones change the same field before either syncs. Last writer by
    timestamp should win, and both devices should agree afterwards."""
    a = Phone(browser, server, "a-lww")
    b = Phone(browser, server, "b-lww")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("conflict", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("conflict", "hunter22")
        b.sync_now()

        def set_platform(phone, name):
            phone.prompt_answer = name
            phone.tab("shows")
            phone.page.click('.show-tile[data-open="1001"]')
            phone.page.wait_for_selector("#detail-platform")
            phone.page.click("#detail-platform")
            phone.sheet_choose("＋ New platform…")
            phone.page.wait_for_function(
                """([n]) => document.querySelector('#detail-platform').textContent.includes(n)""",
                arg=[name])

        set_platform(a, "AlphaPlatform")      # earlier
        set_platform(b, "BetaPlatform")       # later — this one should win

        a.sync_now(); b.sync_now(); a.sync_now()

        for phone, label in ((a, "A"), (b, "B")):
            show = next(s for s in phone.db("shows") if s["id"] == 1001)
            assert show["platform"] == "BetaPlatform", (
                f"phone {label} settled on {show['platform']!r}, expected the later edit")
    finally:
        a.close(); b.close()


@test
def sign_out_everywhere_cuts_off_the_other_phone(browser, server):
    """Lost-device recovery: revoking from one phone kills the other's session."""
    a = Phone(browser, server, "a-out")
    b = Phone(browser, server, "b-out")
    try:
        a.open()
        a.tab("more")
        a.restore_backup(seed_library())
        a.sign_up("revoke", "hunter22")
        a.sync_now()

        b.open()
        b.sign_in("revoke", "hunter22")
        b.sync_now()

        a.tab("more")
        a.page.click("#btn-signout")
        a.sheet_choose("Sign out everywhere — lost or stolen device")
        a.wait_toast("Signed out on every device")
        a.page.wait_for_selector("#sync-signedout:not(.hidden)")

        b.tab("more")
        b.page.click("#btn-sync")
        b.wait_toast("Sync failed")
        assert "sign in again" in b.toast().lower(), f"unexpected message: {b.toast()}"
    finally:
        a.close(); b.close()


# --------------------------------------------------------------------------
# PWA behaviour
# --------------------------------------------------------------------------

@test
def service_worker_never_takes_over_api_calls(browser, server):
    """Regression: the fetch handler only skipped cross-origin requests, so when
    the app is served by the sync server (the documented setup) every /api/ POST
    was handed to Cache.put() — which rejects for non-GET — on every sync.

    Asked of the worker directly: the rejection is internal to the SW, produces
    no page console event, and leaves fetch() behaving identically, so there is
    nothing to observe from the page side.
    """
    phone = Phone(browser, server, "sw")
    try:
        phone.open()
        assert not phone.sw_handles("/api/push", "POST"), "API POSTs must not reach Cache.put()"
        assert not phone.sw_handles("/api/health", "GET"), "API GETs would serve a stale library"
        assert not phone.sw_handles("https://api.tvmaze.com/shows/1"), "cross-origin stays on the network"
        # ...while the app shell is still served from cache, or offline breaks
        assert phone.sw_handles("/index.html"), "shell must stay cached"
        assert phone.sw_handles("/js/app.js"), "shell must stay cached"

        phone.tab("more")
        phone.restore_backup(seed_library())
        phone.sign_up("swtest", "hunter22")
        phone.sync_now()

        cached = phone.cached_urls()
        assert not [u for u in cached if u.startswith("/api/")], f"nothing under /api/ may be cached: {cached}"
        assert any(u.endswith("/js/app.js") for u in cached), f"app shell should be cached: {cached}"
        assert not phone.errors, phone.errors
    finally:
        phone.close()


@test
def app_still_opens_with_no_network(browser, server):
    """It is a PWA: the shell must come off the service worker when offline."""
    phone = Phone(browser, server, "offline")
    try:
        phone.open()
        phone.tab("more")
        phone.restore_backup(seed_library())

        phone.context.set_offline(True)
        phone.page.reload(wait_until="load")
        phone.page.wait_for_function(
            "() => document.querySelector('#view-title').textContent === 'Watch Next'")

        phone.tab("shows")
        phone.page.wait_for_selector('.show-tile[data-open="1001"]')
        phone.page.screenshot(path=str(SHOTS / "04-offline.png"))
        phone.context.set_offline(False)
    finally:
        phone.close()


# --------------------------------------------------------------------------

def main():
    only = None
    if "-k" in sys.argv:
        only = sys.argv[sys.argv.index("-k") + 1]
    headed = "--headed" in sys.argv

    selected = [t for t in TESTS if not only or only in t.__name__]
    SHOTS.mkdir(exist_ok=True)
    passed, failed = [], []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        for t in selected:
            # a fresh server per test: no cross-test state, ever
            with Server() as server:
                try:
                    t(browser, server)
                    passed.append(t.__name__)
                    print(f"  ok   {t.__name__}")
                except Exception:
                    failed.append(t.__name__)
                    print(f"  FAIL {t.__name__}")
                    traceback.print_exc()
        browser.close()

    print(f"\n{len(passed)} passed, {len(failed)} failed, {len(selected)} total")
    if failed:
        print("failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
