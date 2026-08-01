// Discover deck (js/discovery/deck.js). jsdom harness mirrors
// tests/artist-page.test.mjs: a real crew doc through state.js, a fixture
// festival dropped straight into state.FESTIVALS, DOM assertions against the
// rendered overlay. Network-free: the genre canon and the sample player are
// both INJECTED via the `actions`/canonData params (renderDeckForTest), same
// convention artist-page.js's renderArtistPageForTest uses.
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
const {
  renderDeckForTest, renderDesktopForTest, closeDeck, openDiscoverFilterSheet,
} = await import('../js/discovery/deck.js');
const { activeFacetCount } = await import('../js/discovery/filter.js');

const FID = 'deck-fest';
FESTIVAL_INDEX.push({ id: FID, status: 'lineup' });
const TOKEN = 'decktesttoken_01234567890123456789';

const PRISTINE_SELECTIONS = { SeedMust: { Kevin: 4 }, TranceSeed: { Kevin: 4 } };
const PRISTINE_PASSES = { PassSeed: { Kevin: { ts: '2026-07-01T00:00:00.000Z' } } };

state.activateCrew(TOKEN, {
  v: 4,
  meta: {},
  spotify: {},
  people: { Kevin: { colorIndex: 0 }, Drew: { colorIndex: 1 } },
  festivals: {
    [FID]: {
      selections: JSON.parse(JSON.stringify(PRISTINE_SELECTIONS)),
      passes: JSON.parse(JSON.stringify(PRISTINE_PASSES)),
      notes: {},
    },
  },
  affinity: {},
}, FID);

state.FESTIVALS[FID] = {
  id: FID,
  name: 'Deck Fest',
  artists: [
    { name: 'SeedMust', genres: ['bass house'] },   // already my must -> excluded from the pool
    { name: 'RankTarget', genres: ['bass house'] }, // shares a genre with my must -> ranks #1, taste reason
    { name: 'PassSeed', genres: [] },               // already passed by me -> excluded from the pool
    { name: 'PickFlow1', genres: [] },
    { name: 'PickFlow2', genres: [] },
    { name: 'PickFlow3', genres: [] },
    { name: 'ExA', genres: [] },
    { name: 'ExB', genres: [] },
    // Registers 'Trance' in availableGenres() (it scans every artist) while
    // never appearing in the deck's own default pool — already my must, same
    // as SeedMust — so filtering TO it is a genuine zero-result case.
    { name: 'TranceSeed', genres: ['trance'] },
  ],
};

const CANON = { canon: ['Bass House', 'Trance'], synonyms: {}, suppress: [] };
const ctx = { fid: FID, meName: 'Kevin', onNotesChange: () => {}, onTap: () => {} };

function mkActions(mountCalls = [], destroyCounter = { n: 0 }) {
  let lastUndo = null;
  return {
    applyLocalPick: (artist, person, level) => {
      state.ensureFestivalState(ctx.fid);
      const sels = state.crewDoc.festivals[ctx.fid].selections;
      (sels[artist] = sels[artist] || {})[person] = level;
      state.persist();
    },
    showUndoToast: (message, onUndo) => { lastUndo = onUndo; },
    getLastUndo: () => lastUndo,
    canonData: CANON,
    mountPlayer: (opts) => {
      mountCalls.push(opts);
      return { destroy: () => { destroyCounter.n++; }, getState: () => ({}), handoverTo: () => {} };
    },
  };
}

function overlay() { return document.getElementById('discover-deck-overlay'); }
function cardName() { return overlay().querySelector('.dd-name')?.textContent; }

// Every test starts from the same pristine decision state — state.crewDoc is
// a module-level singleton shared across the whole file (same convention
// tests/artist-page.test.mjs uses), and deck.js's own actions write straight
// into it. Without a reset, a later test would inherit an earlier test's
// picks/passes and silently rank a different card into position 0.
test.beforeEach(() => {
  state.crewDoc.festivals[FID].selections = JSON.parse(JSON.stringify(PRISTINE_SELECTIONS));
  state.crewDoc.festivals[FID].passes = JSON.parse(JSON.stringify(PRISTINE_PASSES));
  localStorage.removeItem('fp.discoverFilter.' + FID);
});
test.afterEach(() => { closeDeck(); });

test('deck renders the top-ranked card with exactly one reason ribbon', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');
  const ribbon = overlay().querySelector('.dd-reason');
  assert.ok(ribbon, 'a producible reason renders a ribbon');
  assert.match(ribbon.textContent, /bass house/i);
  assert.equal(overlay().querySelectorAll('.dd-reason').length, 1, 'exactly one ribbon, never more');
  const chips = [...overlay().querySelectorAll('.dd-chip')].map((c) => c.textContent);
  assert.deepEqual(chips, ['Bass House']);
  assert.equal(overlay().querySelector('.dd-counter').textContent, '1 / 6');
});

test('Pick writes applyPickLevel(1) through the state layer, mirrors, and advances', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');
  overlay().querySelector('.dd-btn-pick').click();

  const level = model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin);
  assert.equal(level, 1);
  assert.equal(cardName(), 'PickFlow1', 'advanced to the next card in the pool');
  assert.equal(overlay().querySelector('.dd-counter').textContent, '2 / 6');
});

test('Pass writes applyPass(true), tombstones any pick, and advances', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pass').click();

  assert.ok(model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.equal(cardName(), 'PickFlow1');
});

test('Must writes applyPickLevel(4) and advances', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-must').click();

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 4);
  assert.equal(cardName(), 'PickFlow1');
});

test('undo restores the previous pick state AND returns the same card', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');
  overlay().querySelector('.dd-btn-pick').click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 1);
  assert.equal(cardName(), 'PickFlow1');

  const undo = actions.getLastUndo();
  assert.ok(typeof undo === 'function', 'a decision offers an undo callback');
  undo();

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.equal(cardName(), 'RankTarget', 'the card comes back, not just the state');
  assert.equal(overlay().querySelector('.dd-counter').textContent, '1 / 6');
});

test('undo after a Pass restores the prior pass-free state', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pass').click();
  assert.ok(model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));

  actions.getLastUndo()();
  assert.ok(!model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));
  assert.equal(cardName(), 'RankTarget');
});

test('pool-exhausted renders a completion state — never a dead blank pane', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  // Walk the whole pool (RankTarget, PickFlow1-3, ExA, ExB — 6 undecided
  // artists) with Pass, re-querying the button fresh each time (the deck body
  // is rebuilt on every advance).
  for (let i = 0; i < 6; i++) {
    const passBtn = overlay().querySelector('.dd-btn-pass');
    assert.ok(passBtn, `card ${i} should still be showing a Pass button`);
    passBtn.click();
  }
  assert.ok(overlay().querySelector('.dd-done'), 'completion state renders once the pool is exhausted');
  assert.equal(overlay().querySelector('.dd-actions'), null, 'no action bar once there is no card to decide on');
  const doneButtons = [...overlay().querySelectorAll('.dd-done-btn')].map((b) => b.textContent);
  assert.ok(doneButtons.includes('Reset filters'));
  assert.ok(doneButtons.includes('Show passed'));
});

test('filter badge counts active facets, and a committed genre filter narrows the live pool', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(overlay().querySelector('.dd-filter-badge'), null, 'no badge at zero active facets');

  openDiscoverFilterSheet(ctx, actions);
  const sheet = document.getElementById('artist-sheet');
  assert.ok(sheet, 'the filter sheet renders');
  const bassHouseChip = [...sheet.querySelectorAll('.dd-filter-chip')]
    .find((c) => c.textContent.replace(' ✓', '') === 'Bass House');
  assert.ok(bassHouseChip, 'Bass House is offered — it is present in the pool');
  bassHouseChip.click();

  const cta = sheet.querySelector('.dd-filter-cta');
  assert.match(cta.textContent, /^Show 1 artist$/, 'live count reflects the draft facets before commit');
  cta.click();

  assert.equal(activeFacetCount(JSON.parse(localStorage.getItem('fp.discoverFilter.' + FID))), 1);
  assert.equal(overlay().querySelector('.dd-filter-badge').textContent, '1');
  assert.equal(cardName(), 'RankTarget', 'the narrowed pool still deals RankTarget — the only Bass House artist');
  assert.equal(overlay().querySelector('.dd-counter').textContent, '1 / 1');
});

test('zero-result facets show the 0-artists reset affordance and committing it restores the pool', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  openDiscoverFilterSheet(ctx, actions);
  const sheet = document.getElementById('artist-sheet');
  const trance = [...sheet.querySelectorAll('.dd-filter-chip')].find((c) => c.textContent === 'Trance');
  assert.ok(trance, 'Trance is offered even though nothing in the pool currently carries it');
  trance.click();
  const cta = sheet.querySelector('.dd-filter-cta');
  assert.equal(cta.textContent, '0 artists — Reset filters');
  cta.click(); // tap resets AND commits
  assert.equal(activeFacetCount(JSON.parse(localStorage.getItem('fp.discoverFilter.' + FID))), 0);
  assert.equal(overlay().querySelector('.dd-filter-badge'), null);
  assert.equal(cardName(), 'RankTarget');
});

// ---- desktop three-pane (frame 5c) ---------------------------------------------
// forced via renderDesktopForTest — jsdom has no real matchMedia, so this is
// the "callable directly" seam build spec asked for, mirroring
// renderDeckForTest's own mobile-forcing convention above.
function gridCard(name) { return overlay().querySelector(`.dd2-gridcard[data-artist="${name}"]`); }
function paneName() { return overlay().querySelector('.dd2-pane-name')?.textContent; }

test('desktop render shows the rail, the ranked grid, and the sticky focus pane, focused on the top-ranked artist', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  assert.ok(overlay().querySelector('.dd2-rail'), 'the facets rail renders');
  assert.ok(overlay().querySelector('.dd2-grid'), 'the ranked grid renders');
  assert.ok(overlay().querySelector('.dd2-pane'), 'the focus pane renders');
  assert.equal(gridCard('RankTarget')?.textContent.includes('RankTarget'), true, 'the ranked grid carries the top-ranked card');
  assert.equal(paneName(), 'RankTarget', 'default focus is the pool\'s top-ranked artist');
  // mobile-only chrome must not leak into the desktop tree
  assert.equal(overlay().querySelector('.dd-actions'), null);
  assert.equal(overlay().querySelector('.dd-stack'), null);
});

test('clicking a grid card focuses the pane and writes nothing', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  const before = model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow1?.Kevin);
  gridCard('PickFlow1').click();
  assert.equal(paneName(), 'PickFlow1', 'the click focused the pane');
  const after = model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow1?.Kevin);
  assert.equal(after, before, 'focusing a card never writes a pick');
  assert.ok(!model.isPassed(state.crewDoc, FID, 'PickFlow1', 'Kevin'), 'focusing a card never writes a pass');
});

test('the pane tick writes a pick through the state layer and does not move focus', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  assert.equal(paneName(), 'PickFlow1');
  overlay().querySelector('.dd2-pane-tick').click(); // ×0 -> ×1
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow1?.Kevin), 1);
  assert.equal(paneName(), 'PickFlow1', 'the pane stayed on the same artist through the decision');
});

test('the pane must (★) and pass (✕) controls write through the state layer and do not move focus', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow2').click();
  overlay().querySelector('.dd2-pane-must').click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow2?.Kevin), 4);
  assert.equal(paneName(), 'PickFlow2');

  gridCard('PickFlow3').click();
  overlay().querySelector('.dd2-pane-pass').click();
  assert.ok(model.isPassed(state.crewDoc, FID, 'PickFlow3', 'Kevin'));
  assert.equal(paneName(), 'PickFlow3', 'a pass — like a pick — never yanks the pane to another card');
});

test('a pane decision that drops the focused artist out of the pool keeps the pane on it (never yank mid-thought)', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  overlay().querySelector('.dd2-pane-tick').click(); // picked -> leaves the default Undecided pool
  assert.equal(gridCard('PickFlow1'), null, 'the decided artist drops out of the (still nonempty) grid');
  assert.equal(paneName(), 'PickFlow1', 'the pane keeps showing it anyway');
});

test('a rail facet edit narrows the grid live and persists to the same localStorage key the sheet uses', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  const before = overlay().querySelectorAll('.dd2-gridcard').length;
  assert.ok(before > 1, 'sanity: more than one card before narrowing');
  const bassHouseChip = [...overlay().querySelectorAll('.dd-filter-chip')]
    .find((c) => c.textContent.replace(' ✓', '') === 'Bass House');
  assert.ok(bassHouseChip, 'the rail offers the same genre chips the sheet does');
  bassHouseChip.click();
  const after = overlay().querySelectorAll('.dd2-gridcard');
  assert.equal(after.length, 1, 'the grid narrowed immediately — no Apply step');
  assert.equal(after[0].dataset.artist, 'RankTarget');
  assert.equal(
    activeFacetCount(JSON.parse(localStorage.getItem('fp.discoverFilter.' + FID))), 1,
    'the rail commits to the exact same localStorage key the mobile sheet writes',
  );
});

test('an empty pool shows the zero state in both the grid and the pane, with a working reset', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  const tranceChip = [...overlay().querySelectorAll('.dd-filter-chip')].find((c) => c.textContent === 'Trance');
  assert.ok(tranceChip, 'Trance is offered even though nothing in the pool currently carries it');
  tranceChip.click();
  assert.equal(overlay().querySelectorAll('.dd2-gridcard').length, 0);
  assert.ok(overlay().querySelector('.dd2-empty'), 'the grid shows its zero state');
  assert.ok(overlay().querySelector('.dd2-pane-empty'), 'the pane shows its zero state too');

  overlay().querySelector('.dd2-empty .dd2-empty-btn').click();
  assert.equal(activeFacetCount(JSON.parse(localStorage.getItem('fp.discoverFilter.' + FID))), 0);
  assert.equal(paneName(), 'RankTarget', 'resetting restores the pool and its top-ranked focus');
});
