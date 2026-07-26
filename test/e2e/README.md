# Phone end-to-end tests

The app as a phone meets it: mobile-emulated Chromium (390×844, touch, mobile
UA), the real `index.html`/`js/*`/`sw.js`, served by the real `server/server.js`.
Nothing is stubbed or built specially for the tests, and every interaction is a
real tap on a real element. IndexedDB is only ever *read*, to assert on state.

```bash
npm run test:e2e                       # all of it
python3 test/e2e/test_phone.py -k skew # one test
python3 test/e2e/test_phone.py --headed
```

Needs `playwright` (Python) with Chromium installed:

```bash
pip install playwright && playwright install chromium
```

Each test gets a fresh server on a throwaway `DATA_DIR`, so your real library is
never touched and no state leaks between tests.

## What it covers

These exist because the client sync path can't be tested under Node — there is
no IndexedDB, no service worker, no second device.

| Test | Guards against |
|---|---|
| `boots_with_no_errors` | a broken ES module import or a throwing top-level handler |
| `restore_backup_then_browse` | restore + render + navigation |
| `filter_with_no_matches_says_so` | a filter matching nothing rendering a blank grid |
| `marking_watched_keeps_rewatch_dates` | `setEpProgress` rebuilding the record and dropping `rewatches` |
| `library_syncs_between_two_phones` | the basic upload/download round trip |
| `a_fast_peer_clock_does_not_strand_local_edits` | a peer's fast clock poisoning the push watermark, so this device silently stops uploading |
| `removing_a_show_propagates_to_the_other_phone` | deletes not travelling, and tombstones never being dropped |
| `edits_sync_without_tapping_sync_now` | `queueSync` missing on a mutation path |
| `upgrading_from_the_old_watermark_uploads_pending_edits` | `migrateDirty` stranding edits made by the previous version |
| `a_library_larger_than_one_page_arrives_whole` | dropping records at a pull page boundary (4000/page, 5000/chunk) |
| `the_later_edit_wins_when_two_phones_disagree` | last-writer-wins breaking (the merge compares `>=`) |
| `sign_out_everywhere_cuts_off_the_other_phone` | revocation not actually revoking |
| `service_worker_never_takes_over_api_calls` | the SW handing API POSTs to `Cache.put()` |
| `app_still_opens_with_no_network` | the offline shell |

## Two things worth knowing

**Simulated device clock.** `a_fast_peer_clock_does_not_strand_local_edits`
shifts one phone's `Date.now` forward a week via an init script. The app is
untouched; this reproduces a phone whose clock has drifted, which is the
precondition for the bug.

**The service worker is asked directly.** `Cache.put()` rejecting on a POST
happens inside the worker: no page console event, no change in what `fetch()`
returns, nothing cached to inspect (`Cache.keys()` only ever lists GETs). So the
test dispatches a real `FetchEvent` at the shipped handler inside the worker and
checks whether it calls `respondWith`. An earlier version of this test asserted
on cache contents and passed against the broken code — it was decoration.

## Keeping them honest

Every test here was checked by re-introducing the bug it targets and confirming
it fails. A test that passes against the broken code is worse than no test. If
you add one, do the same.
