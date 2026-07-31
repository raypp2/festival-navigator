// Discovery M3 — artist page (js/discovery/artist-page.js). jsdom harness
// mirrors tests/wall-dom.test.mjs / tests/notes-edit.test.mjs: a real crew
// doc through state.js, a fixture festival dropped straight into
// state.FESTIVALS, and DOM assertions against the rendered overlay.
//
// Network-free by design: genre canon and the sample player are both
// INJECTED via the `actions` object (actions.canonData / actions.mountPlayer)
// rather than loaded — see artist-page.js's openArtistPage doc comment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = dom.window.CSS;
globalThis.requestAnimationFrame = (fn) => fn();
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.location = { origin: 'https://fest.kevinhg.com', hash: '' };

const state = await import('../js/state.js');
const model = await import('../js/v3/model.js');
const { FESTIVAL_INDEX } = await import('../js/festivals.js');
const { openArtistPage, closeArtistPage } = await import('../js/discovery/artist-page.js');

const FID = 'ap-fest';
FESTIVAL_INDEX.push({ id: FID, status: 'lineup' });
const TOKEN = 'artistpagetesttoken_0123456789';
const LONG_NAME = 'Skull Machine (Black Tiger Sex Machine x Kai Wachi)';

state.activateCrew(TOKEN, {
  v: 4,
  meta: {},
  spotify: {},
  people: {
    Kevin: { colorIndex: 0 },
    Ren: { colorIndex: 1 },
    Mara: { colorIndex: 2 },
    Sam: { colorIndex: 3 },
  },
  festivals: {
    [FID]: {
      selections: { GRiZ: { Kevin: 2, Ren: 4 }, PassArtist: { Kevin: 2 } },
      passes: { GRiZ: { Mara: { ts: '2026-07-01T00:00:00.000Z' } } },
      notes: {
        artist: {
          GRiZ: { 'kevin.100.abc': { author: 'Kevin', ts: '2026-07-01T00:00:00.000Z', text: 'test note' } },
        },
      },
    },
  },
  affinity: {},
}, FID);

state.FESTIVALS[FID] = {
  id: FID,
  name: 'Test Fest',
  artists: [
    {
      name: 'GRiZ', day: 'Day 1', stage: 'Lakeshore', time: '6:30 PM - 8:00 PM',
      genres: ['future bass', 'bass house'], soundcloudSlug: 'griz', spotifyId: 'griz-spotify-id',
    },
    { name: 'Similaro', day: 'Day 1', stage: 'Other Stage', time: '7:00 PM', genres: ['bass house'] },
    { name: 'NoGenreArtist', genres: [] },
    { name: 'TickArtist', genres: ['bass house'] },
    { name: 'PassArtist', genres: ['bass house'] },
    { name: LONG_NAME, genres: ['bass house'] },
  ],
};

const CANON = { canon: ['Bass House', 'Future Bass'], synonyms: {}, suppress: [] };

const ctx = { fid: FID, meName: 'Kevin', onNotesChange: () => {}, onOpenNotes: () => {} };

function mkActions(mountCalls = [], destroyCounter = { n: 0 }) {
  return {
    applyLocalPick: (artist, person, level) => {
      state.ensureFestivalState(ctx.fid);
      const sels = state.crewDoc.festivals[ctx.fid].selections;
      (sels[artist] = sels[artist] || {})[person] = level;
      state.persist();
    },
    showUndoToast: () => {},
    canonData: CANON,
    mountPlayer: (opts) => {
      mountCalls.push(opts);
      return { destroy: () => { destroyCounter.n++; }, getState: () => ({}), handoverTo: () => {} };
    },
  };
}

function overlay() { return document.getElementById('artist-page-overlay'); }

test('renders name and genre chips from a fixture doc + festival', () => {
  openArtistPage('GRiZ', ctx, mkActions());
  assert.equal(overlay().querySelector('.ap-name').textContent, 'GRiZ');
  const chips = [...overlay().querySelectorAll('.ap-chip')].map((c) => c.textContent);
  // canon order (most-specific-first) is the primary/secondary ranking: Bass
  // House sits before Future Bass in CANON, so it's primary.
  assert.deepEqual(chips, ['Bass House', 'Future Bass']);
  closeArtistPage();
});

test('no canonical genres -> "No genres tagged yet", never an empty chip row', () => {
  openArtistPage('NoGenreArtist', ctx, mkActions());
  assert.equal(overlay().querySelector('.ap-no-genres').textContent, 'No genres tagged yet');
  assert.equal(overlay().querySelector('.ap-chips'), null);
  closeArtistPage();
});

test('long artist name renders in full (no truncation/data loss)', () => {
  openArtistPage(LONG_NAME, ctx, mkActions());
  assert.equal(overlay().querySelector('.ap-name').textContent, LONG_NAME);
  closeArtistPage();
});

test('crew rows reflect effectiveState: must, picked, passed (reduced opacity), hasn’t-opened + recommend', () => {
  openArtistPage('GRiZ', ctx, mkActions());
  const rows = [...overlay().querySelectorAll('.ap-crew-row')];
  const byName = {};
  for (const row of rows) {
    const name = row.querySelector('.ap-crew-name').firstChild.textContent;
    byName[name] = row;
  }
  assert.match(byName.Ren.querySelector('.ap-crew-status').textContent, /must/);
  assert.match(byName.Kevin.querySelector('.ap-crew-status').textContent, /×2/);

  assert.ok(byName.Mara.classList.contains('ap-crew-row-passed'), 'passed row carries the reduced-opacity class');
  assert.equal(byName.Mara.querySelector('.ap-crew-status').textContent, 'passed');

  assert.ok(byName.Sam.classList.contains('ap-crew-row-dashed'));
  assert.ok(byName.Sam.textContent.includes('hasn’t opened'));
  const recBtn = byName.Sam.querySelector('.ap-recommend');
  assert.ok(recBtn, 'a member with zero activity anywhere gets a recommend button');
  closeArtistPage();
});

test('recommend button writes the rec through state/model, then shows recommended ✓', () => {
  const actions = mkActions();
  openArtistPage('GRiZ', ctx, actions);
  const rowFor = (name) => [...overlay().querySelectorAll('.ap-crew-row')]
    .find((r) => r.querySelector('.ap-crew-name').firstChild.textContent === name);
  rowFor('Sam').querySelector('.ap-recommend').click();

  const recs = model.recsFor(state.crewDoc, FID);
  assert.equal(recs.GRiZ.Sam.by, 'Kevin');

  const refreshedRow = rowFor('Sam');
  assert.equal(refreshedRow.querySelector('.ap-crew-status').textContent, 'recommended ✓');
  closeArtistPage();
});

test('tick tap cycles ×1 → ×2 → ×3 → clear through applyPickLevel, never through must', () => {
  const actions = mkActions();
  openArtistPage('TickArtist', ctx, actions);
  const levelFor = () => model.readLevel(
    state.crewDoc,
    state.crewDoc.festivals[FID].selections.TickArtist?.Kevin,
  );
  assert.equal(levelFor(), 0);

  overlay().querySelector('.ap-tick').click();
  assert.equal(levelFor(), 1);
  assert.equal(overlay().querySelector('.ap-tick-label').textContent, '×1');

  overlay().querySelector('.ap-tick').click();
  assert.equal(levelFor(), 2);

  overlay().querySelector('.ap-tick').click();
  assert.equal(levelFor(), 3);

  // 4th tap clears — the tick cycle never reaches must (4).
  overlay().querySelector('.ap-tick').click();
  assert.equal(levelFor(), 0);

  closeArtistPage();
});

test('★ toggles must (level 4) independently of the tick cycle', () => {
  const actions = mkActions();
  openArtistPage('TickArtist', ctx, actions);
  overlay().querySelector('.ap-must').click();
  assert.equal(
    model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.TickArtist.Kevin), 4,
  );
  overlay().querySelector('.ap-must').click();
  assert.equal(
    model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.TickArtist.Kevin), 0,
  );
  closeArtistPage();
});

test('✕ calls applyPass and tombstones an existing pick', () => {
  const actions = mkActions();
  openArtistPage('PassArtist', ctx, actions);
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PassArtist.Kevin), 2);

  overlay().querySelector('.ap-pass').click();
  assert.ok(model.isPassed(state.crewDoc, FID, 'PassArtist', 'Kevin'));
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PassArtist.Kevin), 0);

  overlay().querySelector('.ap-pass').click(); // toggle off
  assert.ok(!model.isPassed(state.crewDoc, FID, 'PassArtist', 'Kevin'));
  closeArtistPage();
});

test('sample player mounts through the injected mountPlayer with the artist’s sources', () => {
  const mountCalls = [];
  const destroyCounter = { n: 0 };
  const actions = mkActions(mountCalls, destroyCounter);
  openArtistPage('GRiZ', ctx, actions);
  assert.equal(mountCalls.length, 1);
  assert.equal(mountCalls[0].artist.name, 'GRiZ');
  assert.equal(mountCalls[0].sources.soundcloudSlug, 'griz');
  assert.equal(mountCalls[0].sources.spotifyId, 'griz-spotify-id');
  assert.equal(mountCalls[0].layout, 'full');
  assert.ok(overlay().querySelector('.ap-sample'));

  // Navigating to a similar artist tears the old player down and mounts a fresh one.
  openArtistPage('Similaro', ctx, actions);
  assert.equal(destroyCounter.n, 1);
  assert.equal(mountCalls.length, 2);
  assert.equal(mountCalls[1].artist.name, 'Similaro');

  closeArtistPage();
  assert.equal(destroyCounter.n, 2, 'closing the page destroys the live player');
});

test('similar-artist row navigates the page in place (replace content, no duplicate overlay)', () => {
  const actions = mkActions();
  openArtistPage('GRiZ', ctx, actions);
  const row = [...overlay().querySelectorAll('.ap-similar-row')]
    .find((r) => r.querySelector('.ap-similar-name').textContent === 'Similaro');
  assert.ok(row, 'GRiZ and Similaro share Bass House, so Similaro appears in Similar');
  row.click();
  assert.equal(document.querySelectorAll('#artist-page-overlay').length, 1, 'still exactly one overlay');
  assert.equal(overlay().querySelector('.ap-name').textContent, 'Similaro');
  closeArtistPage();
});
