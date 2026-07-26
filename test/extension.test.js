// Unit tests for the extension's pure scrape parsers.
//
// These are the most breakage-prone code in the project: streaming sites change
// their DOM and page titles constantly, and a silent parser regression marks the
// WRONG episode watched rather than failing loudly. Run: node --test test/

const { test } = require('node:test');
const assert = require('node:assert');

const { derive, parseSE, SUFFIX } = require('../extension/content.js');

// ---------------- parseSE ----------------

test('parseSE reads the common season/episode spellings', () => {
  const want = { season: 1, episode: 3 };
  assert.deepStrictEqual(parseSE('S1:E3'), want);
  assert.deepStrictEqual(parseSE('S1E3'), want);
  assert.deepStrictEqual(parseSE('Season 1 Episode 3'), want);
  assert.deepStrictEqual(parseSE('S1 · E3'), want);
  assert.deepStrictEqual(parseSE('S1 E3 - Chapter Three'), want);
});

test('parseSE scans its arguments in order and skips empties', () => {
  assert.deepStrictEqual(parseSE(null, undefined, '', 'S2E5'), { season: 2, episode: 5 });
});

test('parseSE prefers a full S/E match over an episode-only one', () => {
  // 'Episode 9' would match the second pass; 'S4E2' must win from the first.
  assert.deepStrictEqual(parseSE('Episode 9', 'S4E2'), { season: 4, episode: 2 });
});

// Regression: an episode-only label used to default season to 1, which marked
// S1Ex watched on a show the viewer was several seasons into. season must be
// null so the server falls back to matching by episode NAME.
test('parseSE returns season null (not 1) when there is no season signal', () => {
  assert.deepStrictEqual(parseSE('Episode 7'), { season: null, episode: 7 });
  assert.deepStrictEqual(parseSE('E12'), { season: null, episode: 12 });
});

test('parseSE returns nulls when nothing looks like an episode', () => {
  assert.deepStrictEqual(parseSE('Stranger Things'), { season: null, episode: null });
  assert.deepStrictEqual(parseSE(), { season: null, episode: null });
});

// ---------------- derive ----------------

test('derive prefers Media Session metadata for the show name', () => {
  assert.deepStrictEqual(
    derive({ msTitle: 'S2 E4 - Chapter Four', msArtist: 'The Boys', pageTitle: 'Prime Video' }),
    { title: 'The Boys', season: 2, episode: 4, epName: 'S2 E4 - Chapter Four' });
});

test('derive picks up a bare "Season N" when there is no S/E code', () => {
  const got = derive({ msTitle: 'The Pilot', msArtist: 'Doctor Who', msAlbum: 'Season 10' });
  assert.strictEqual(got.title, 'Doctor Who');
  assert.strictEqual(got.season, 10);
  assert.strictEqual(got.episode, null);   // name-matching path on the server
  assert.strictEqual(got.epName, 'The Pilot');
});

test('derive falls back to the page title and strips the site suffix', () => {
  const got = derive({ pageTitle: 'Stranger Things - Netflix', siteSuffix: SUFFIX });
  assert.strictEqual(got.title, 'Stranger Things');
});

test('derive strips a leading Watch/Stream verb', () => {
  const got = derive({ pageTitle: 'Watch Severance | Apple TV+', siteSuffix: SUFFIX });
  assert.strictEqual(got.title, 'Severance');
});

test('derive does not let the show name leak into the episode name', () => {
  const got = derive({ msTitle: 'Breaking Bad', msArtist: 'Breaking Bad' });
  assert.strictEqual(got.title, 'Breaking Bad');
  assert.strictEqual(got.epName, null);
});

test('derive returns an empty title when there is nothing to go on', () => {
  assert.strictEqual(derive({}).title, '');
});
