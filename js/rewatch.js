// What counts as a rewatch.
//
// Shared by the TV Time importer (js/import.js) and the one-off repair script
// (server/repair_rewatches.mjs) so the two cannot disagree about the same data.
// They used to: the importer collapsed only byte-identical timestamps while the
// repair required a minimum gap, so the same export produced different rewatch
// counts depending on which one touched it.
//
// A TV Time export logs each viewing as its own row, but marking a run of
// episodes in one sitting also produces one row per episode, seconds to hours
// apart. In the real 32,130-row export the 44 episodes logged more than once
// split cleanly into those two shapes:
//
//   11 pairs   4s - 10s apart    a season marked watched in one action
//   16 pairs   1.5h - 23h apart  a bulk marking session spread over a day
//   17 pairs   2d - 904d apart   an actual second viewing
//
// Byte-identical timestamps are rare (they exist, but as fully duplicated rows,
// not as near-misses), so deduping on exact equality kept all 44 as rewatches —
// including the 7-second ones. Requiring a minimum gap is what actually
// separates the shapes.

// One day. Two viewings closer together than this are treated as one viewing
// logged twice. Chosen because the real data has nothing between 23h and 2d:
// the gap distribution is bimodal and the threshold sits in the empty band.
export const DEFAULT_MIN_GAP_MS = 86400000;

// Start a new sitting wherever a viewing is at least `gap` after the one
// immediately before it; anything closer than that joins the sitting in
// progress. A run of viewings each within `gap` of its neighbour is therefore
// one sitting however long the run gets.
//
// This used to measure from the last *kept* viewing instead, which made whether
// a viewing counted depend on which earlier ones happened to survive rather than
// on its own neighbours: six viewings 20 hours apart came out as three sittings,
// so someone rewatching an episode nightly had half their history deleted.
export function keepBeyond(sorted, gap) {
  if (!sorted.length) return [];
  const out = [sorted[0]];
  let prev = sorted[0];
  for (const d of sorted.slice(1)) {
    if (new Date(d) - new Date(prev) >= gap) out.push(d);
    prev = d;
  }
  return out;
}

// The distinct viewings of one episode, oldest first, after collapsing repeats
// that are too close together to be separate sittings.
export function viewings(whens, minGapMs = DEFAULT_MIN_GAP_MS) {
  return keepBeyond([...new Set(whens)].sort(), minGapMs);
}

// Group `hits` ({ epId, when }) by episode and emit one watch record each,
// carrying rewatchCount and — unless the user turned dates off — the repeat
// viewing dates. Shape matches what bumpEpRewatch writes in the app: `watchedAt`
// is the most recent viewing and `rewatches` holds the repeats after the first.
export function collapseWatches(showId, hits, keepDates = true, minGapMs = DEFAULT_MIN_GAP_MS) {
  const byEp = new Map();
  for (const { epId, when } of hits) {
    if (!byEp.has(epId)) byEp.set(epId, new Set());
    byEp.get(epId).add(when);
  }
  return [...byEp.entries()].map(([epId, set]) => {
    const logged = [...set].sort();
    const dates = keepBeyond(logged, minGapMs);
    const rec = {
      epId, showId, progress: 100,
      watchedAt: dates[dates.length - 1],
      rewatchCount: dates.length - 1,
      source: 'tvtime',
    };
    if (keepDates && dates.length > 1) rec.rewatches = dates.slice(1);
    // Say how many viewings this one record was computed from, whenever that is
    // more than survived. Without it a record that absorbed a duplicate log is
    // byte-identical to an episode genuinely watched once, and the discarded
    // stamps exist nowhere but the original export — so a wrong threshold is
    // unrecoverable rather than merely wrong.
    if (logged.length !== dates.length) rec.viewingsLogged = logged.length;
    return rec;
  });
}
