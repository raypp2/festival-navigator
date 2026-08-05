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
  let lastUndoMessage = null;
  return {
    applyLocalPick: (artist, person, level) => {
      state.ensureFestivalState(ctx.fid);
      const sels = state.crewDoc.festivals[ctx.fid].selections;
      (sels[artist] = sels[artist] || {})[person] = level;
      state.persist();
    },
    showUndoToast: (message, onUndo) => { lastUndo = onUndo; lastUndoMessage = message; },
    getLastUndo: () => lastUndo,
    getLastUndoMessage: () => lastUndoMessage,
    // The deck's decision flow is a timed chain: Pick opens a 1s cycle, then a
    // celebrate overlay holds, then the card exits, then the deck advances.
    // A synchronous scheduler collapses the whole chain into the calling tick
    // so these tests stay deterministic and assert on end state. Tests that
    // care about the INTERMEDIATE states drive the steps by hand instead
    // (see the pick-cycle block at the bottom of this file).
    schedule: (fn) => { fn(); return null; },
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

// The 2026-08-04 phone pass. Each of these is a thing a person hit on a real
// device, so each gets an assertion rather than a comment.
test('the top bar carries back, title and filter on ONE row', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  const topbar = overlay().querySelector('.dd-topbar');
  assert.ok(topbar.querySelector('.dd-back'), 'back stays');
  assert.equal(topbar.querySelector('.dd-title').textContent, 'DISCOVER');
  assert.ok(topbar.querySelector('.dd-filter-btn'),
    'filter moved up beside the title instead of owning a row below it');
  // The row it used to share with a "DISCOVERY SESSION" micro-label is gone
  // entirely — the label restated the title directly above it and cost the
  // card a row of height on a phone.
  assert.equal(overlay().querySelectorAll('.dd-filter-btn').length, 1, 'exactly one filter control');
  assert.ok(!/DISCOVERY SESSION/i.test(overlay().textContent), 'the micro-label is gone');
  // The counter kept its job and joined the sub-line.
  assert.ok(overlay().querySelector('.dd-header-meta .dd-counter'));
});

test('the card shows when the artist plays, and nothing when there is no set', () => {
  const fest = state.FESTIVALS[FID];
  const target = fest.artists.find((a) => a.name === 'RankTarget');
  const restore = { ...target };
  try {
    Object.assign(target, { day: 'Day 1', stage: 'Ranch Arena', time: '6:30 PM' });
    fest.dayMeta = { 'Day 1': { wd: 'Thu', num: 1, date: 'Jun 25' } };
    renderDeckForTest(ctx, mkActions(), CANON);
    assert.equal(cardName(), 'RankTarget');
    assert.equal(overlay().querySelector('.dd-setline').textContent, 'THU · 6:30 PM · Ranch Arena');
  } finally {
    for (const k of Object.keys(target)) if (!(k in restore)) delete target[k];
    Object.assign(target, restore);
    delete fest.dayMeta;
  }
  // Same fixture with the schedule taken back off: no line rather than an
  // empty one. A lineup with no times yet is the common case, not an edge one.
  closeDeck();
  renderDeckForTest(ctx, mkActions(), CANON);
  assert.equal(cardName(), 'RankTarget');
  assert.equal(overlay().querySelector('.dd-setline'), null);
});

test('the undo row states what happened and offers Undo — with no countdown bar', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-must').click();
  const undo = overlay().querySelector('.dd-actions .dd-undo');
  assert.ok(undo, 'a decision grows the undo row');
  assert.match(undo.querySelector('.dd-undo-msg').textContent, /RankTarget/);
  // A draining hairline under freshly-tapped controls read as a deadline on the
  // DECISION rather than on the undo. The 5s dismissal stays; the narration of
  // it does not.
  assert.equal(undo.querySelector('.dd-undo-countdown'), null);
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

test('Skip advances without recording anything, and is undoable', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');

  overlay().querySelector('.dd-btn-skip').click();
  assert.equal(cardName(), 'PickFlow1', 'the deck moved on');
  // The distinction that matters: a skip says NOTHING about the artist, so no
  // pick and no pass is written and they stay in the pool for a later session.
  assert.equal(
    model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.ok(!model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'),
    'skip is not a quiet "not for me"');

  overlay().querySelector('.dd-actions .dd-undo-btn').click();
  assert.equal(cardName(), 'RankTarget', 'undo brings the skipped card back');
});

test('undo restores the previous pick state AND returns the same card', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');
  overlay().querySelector('.dd-btn-pick').click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 1);
  assert.equal(cardName(), 'PickFlow1');

  // Undo lives IN the action bar now, not in a floating toast — the design
  // rules a snackbar over the deck out entirely (style guide §07).
  const undo = overlay().querySelector('.dd-actions .dd-undo-btn');
  assert.ok(undo, 'a decision grows an undo row inside the action bar');
  undo.click();

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.equal(cardName(), 'RankTarget', 'the card comes back, not just the state');
  assert.equal(overlay().querySelector('.dd-counter').textContent, '1 / 6');
});

test('undo after a Pass restores the prior pass-free state', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pass').click();
  assert.ok(model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));

  overlay().querySelector('.dd-actions .dd-undo-btn').click();
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

// Desktop is a SUCCESSION as of 2026-08-04: a decision lands, holds for a
// beat, and the pane moves to the next artist you have not decided on. These
// use the manual scheduler so the two halves — the decision, then the move —
// are separable; mkActions' collapsed scheduler runs them in one tick and can
// only ever see the end state.
test('the pane Pick button writes through the state layer, then moves on', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  assert.equal(paneName(), 'PickFlow1');
  overlay().querySelector('.dd2-pane-actions .dd-btn-pick').click(); // ×0 -> ×1
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow1?.Kevin), 1);
  assert.equal(paneName(), 'PickFlow1', 'the pane holds while the pick cycle is still open');
  actions.flush();
  assert.notEqual(paneName(), 'PickFlow1', 'once the cycle settles, the deck goes on to the next artist');
});

test('the pane must (★) and pass (✕) controls write through the state layer, then move on', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow2').click();
  overlay().querySelector('.dd2-pane-actions .dd-btn-must').click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow2?.Kevin), 4);
  assert.equal(paneName(), 'PickFlow2', 'the decision is visible before the move');
  actions.flush();
  assert.notEqual(paneName(), 'PickFlow2');

  gridCard('PickFlow3').click();
  overlay().querySelector('.dd2-pane-actions .dd-btn-pass').click();
  assert.ok(model.isPassed(state.crewDoc, FID, 'PickFlow3', 'Kevin'));
  actions.flush();
  assert.notEqual(paneName(), 'PickFlow3', 'a decline moves on too');
});

// The counterpart rule, and the one that keeps the succession from trapping
// you: a tap that leaves the artist UNDECIDED is a correction, not a decision.
test('undoing a decision from the pane does NOT move on', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  overlay().querySelector('.dd2-pane-actions .dd-btn-pass').click();     // pass
  overlay().querySelector('.dd2-pane-actions .dd-btn-pass').click();     // un-pass, same button
  assert.ok(!model.isPassed(state.crewDoc, FID, 'PickFlow1', 'Kevin'));
  actions.flush();
  assert.equal(paneName(), 'PickFlow1',
    'toggling a decision back off leaves you where you are — moving on would strand the correction behind you');
});

// "There's value in them seeing what they covered" (2026-08-04). A decided
// card used to evaporate out of the Undecided filter the instant you acted,
// taking the one thing you had just touched off the screen.
test('a decided card stays in the grid, marked, instead of disappearing', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  const before = overlay().querySelectorAll('.dd2-gridcard').length;
  gridCard('PickFlow1').click();
  overlay().querySelector('.dd2-pane-actions .dd-btn-must').click();

  const card = gridCard('PickFlow1');
  assert.ok(card, 'the decided artist is still on screen');
  assert.equal(overlay().querySelectorAll('.dd2-gridcard').length, before, 'and the grid did not shrink');
  assert.ok(card.classList.contains('is-decided'), 'it reads as decided');
  const stamp = card.querySelector('.dd2-gridcard-stamp');
  assert.ok(stamp, 'a stamp says so without relying on the dimming alone');
  assert.equal(stamp.dataset.kind, 'must');
  // The count becomes progress through the session, and its denominator holds.
  assert.match(overlay().querySelector('.dd2-middle-count').textContent, /1 of \d+ decided/);
});

// The pane is where you are LISTENING. Reaching a verdict used to call
// renderDeckBody, which wipes the overlay and destroys the live player — every
// pick, must and pass stopped the audio and reset the video mid-listen
// (reported 2026-08-04). destroyCounter/mountCalls are the honest assertion:
// "the pane still shows the artist" would have passed the whole time it was
// broken, because a re-render puts the same artist back with a new embed.
test('a pane decision never touches the live player before the deck moves on', () => {
  const mounts = [];
  const destroys = { n: 0 };
  const actions = mkManualActions(mounts, destroys);
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  const mountsAfterFocus = mounts.length;
  const destroysAfterFocus = destroys.n;
  assert.equal(mounts[mounts.length - 1].artist.name, 'PickFlow1', 'sanity: focusing mounted the player once');

  const pane = () => overlay().querySelector('.dd2-pane-actions');
  pane().querySelector('.dd-btn-pick').click();  // ×1
  pane().querySelector('.dd-btn-pick').click();  // ×2
  pane().querySelector('.dd-btn-pick').click();  // ×3

  assert.equal(destroys.n, destroysAfterFocus, 'the whole pick cycle destroyed the player zero times');
  assert.equal(mounts.length, mountsAfterFocus, 'and remounted it zero times — the stream plays through');
  assert.ok(overlay().querySelector('.dd2-pane-body'), 'the pane body (which owns the embed) is still mounted');

  // Moving to a DIFFERENT artist is the one time a new embed is correct.
  actions.flush();
  assert.equal(mounts.length, mountsAfterFocus + 1, 'the next artist gets its own player, exactly once');
});

test('a pane decision repaints the grid and the pick control around the player', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  overlay().querySelector('.dd2-pane-actions .dd-btn-must').click();

  // The control has to know its own new level, or the next tap ticks from a
  // stale base — this is why it is rebuilt rather than repainted.
  const row = overlay().querySelector('.dd2-pane-actions .dd-actions-row');
  assert.ok(row.querySelector('.dd-btn-must').classList.contains('is-on'), 'Must reads as chosen');
  overlay().querySelector('.dd2-pane-actions .dd-btn-pick').click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.PickFlow1?.Kevin), 1,
    'Pick from a must drops to x1 — computed from the CURRENT level, not the one the row was built with');
});

// The reason tag used to be undecided-only, so the instant you picked it
// vanished, the pane got shorter and the action bar jumped UP under the
// cursor — mid-way through a multi-tap Pick, which is the one interaction here
// that cannot afford a moving target (reported 2026-08-04).
test('the pane reason tag survives a decision, so the action bar cannot move under the cursor', () => {
  const actions = mkManualActions();
  renderDesktopForTest(ctx, actions, CANON);
  // RankTarget is the fixture with a producible reason (it shares Bass House
  // with a seeded must), which is why this test focuses it by name.
  gridCard('RankTarget').click();
  const before = overlay().querySelector('.dd2-pane-reason');
  assert.ok(before, 'sanity: this artist has a reason to show');
  const text = before.textContent;

  overlay().querySelector('.dd2-pane-actions .dd-btn-pick').click(); // ×1
  const after = overlay().querySelector('.dd2-pane-reason');
  assert.ok(after, 'the tag is still there after the pick');
  assert.equal(after.textContent, text, 'and still says the same thing — it is still why we showed you this artist');
  overlay().querySelector('.dd2-pane-actions .dd-btn-pick').click(); // ×2, the tap the jump used to break
  assert.ok(overlay().querySelector('.dd2-pane-reason'), 'and through the rest of the cycle');
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 2);
});

test('clicking the card you are already sampling does not restart the player', () => {
  const mounts = [];
  const destroys = { n: 0 };
  const actions = mkActions(mounts, destroys);
  renderDesktopForTest(ctx, actions, CANON);
  gridCard('PickFlow1').click();
  // Baselines AFTER the first focus: that click is a real focus change, so it
  // legitimately tears down the player the initial render mounted for the
  // pool's top entry. What must not move is what happens on the SECOND click.
  const n = mounts.length;
  const d = destroys.n;
  gridCard('PickFlow1').click();
  assert.equal(mounts.length, n, 're-focusing the current artist is a no-op, not a remount');
  assert.equal(destroys.n, d, 'and nothing was torn down');
  gridCard('PickFlow2').click();
  assert.equal(mounts.length, n + 1, 'but a DIFFERENT artist genuinely needs a new player');
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

// ---------------------------------------------------------------------------
// Swipe gestures (Discovery - Style Guide.dc.html, 07 · Interaction & motion:
// "swipe left = pass, right = pick, up = must; card follows the finger" —
// with the buttons always available as the canonical equivalent).
//
// jsdom has no PointerEvent, but the handlers only ever read clientX/clientY
// and e.target, so a MouseEvent carrying the pointer type name drives them
// exactly as a real pointer would.
// ---------------------------------------------------------------------------

function drag(card, fromX, fromY, toX, toY) {
  const ev = (type, x, y) => card.dispatchEvent(new dom.window.MouseEvent(type, {
    clientX: x, clientY: y, bubbles: true,
  }));
  ev('pointerdown', fromX, fromY);
  ev('pointermove', toX, toY);
  ev('pointerup', toX, toY);
}

test('swipe right past the threshold picks ×1 — the same write the Pick button makes', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  assert.equal(cardName(), 'RankTarget');
  drag(overlay().querySelector('.dd-card'), 100, 300, 260, 305);

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 1);
  assert.equal(cardName(), 'PickFlow1', 'the deck advanced');
});

test('swipe left past the threshold passes', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  drag(overlay().querySelector('.dd-card'), 260, 300, 100, 305);

  assert.ok(model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));
  assert.equal(cardName(), 'PickFlow1');
});

test('swipe UP past the threshold makes it a must (the third axis the style guide specifies)', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  drag(overlay().querySelector('.dd-card'), 180, 400, 184, 250);

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 4);
  assert.equal(cardName(), 'PickFlow1');
});

test('a drag short of the threshold decides nothing and leaves the card in place', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  drag(overlay().querySelector('.dd-card'), 100, 300, 150, 300); // 50px < 90px

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.ok(!model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));
  assert.equal(cardName(), 'RankTarget', 'no advance');
});

test('dragging DOWN is the card scrolling, never a gesture', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  drag(overlay().querySelector('.dd-card'), 180, 250, 184, 420); // well past any threshold

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.ok(!model.isPassed(state.crewDoc, FID, 'RankTarget', 'Kevin'));
  assert.equal(cardName(), 'RankTarget');
});

test('a swipe starting on a button is that button’s business, not the deck’s', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  const card = overlay().querySelector('.dd-card');
  const nameBtn = overlay().querySelector('.dd-name');
  // pointerdown lands on the artist-name button inside the card…
  nameBtn.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 100, clientY: 300, bubbles: true }));
  card.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 300, clientY: 300, bubbles: true }));
  card.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 300, clientY: 300, bubbles: true }));

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.RankTarget?.Kevin), 0);
  assert.equal(cardName(), 'RankTarget', 'dragging off a control never decides the card');
});

test('every swipe has a visible button equivalent — no gesture is ever required', () => {
  const actions = mkActions();
  renderDeckForTest(ctx, actions, CANON);
  for (const cls of ['.dd-btn-pass', '.dd-btn-pick', '.dd-btn-must']) {
    assert.ok(overlay().querySelector(cls), `${cls} is present alongside the gestures`);
  }
});

// ---------------------------------------------------------------------------
// The pick cycle and the confirmation overlay
// (design/discovery-handoff/project/Discovery - Swipe Demo.dc.html — its
// pickTap/begin/renderVals). Pick is NOT one tap: it opens a ×1 → ×2 → ×3
// cycle that locks in after 1s idle, and the overlay is where the level is
// read. These tests drive the scheduler by hand so the intermediate states —
// which the collapsed scheduler in mkActions skips straight past — are visible.
// ---------------------------------------------------------------------------

function mkManualActions(mountCalls = [], destroyCounter = { n: 0 }) {
  const queue = [];
  const a = mkActions(mountCalls, destroyCounter);
  a.schedule = (fn) => {
    const slot = { fn, cancelled: false };
    queue.push(slot);
    return () => { slot.cancelled = true; };
  };
  a.flush = () => {
    // Drain, including anything scheduled BY a callback (celebrate -> exit).
    while (queue.length) {
      const slot = queue.shift();
      if (!slot.cancelled) slot.fn();
    }
  };
  a.queued = () => queue.filter((s) => !s.cancelled).length;
  return a;
}

const cel = () => overlay().querySelector('.dd-celebrate');
const celOn = () => cel()?.classList.contains('is-on');
const levelOf = (name) => model.readLevel(
  state.crewDoc, state.crewDoc.festivals[FID].selections[name]?.Kevin,
);

test('nextPickLevel cycles 1 → 2 → 3 → 1 and never lands on clear', async () => {
  const { nextPickLevel } = await import('../js/discovery/deck.js');
  assert.equal(nextPickLevel(null), 1);
  assert.equal(nextPickLevel(1), 2);
  assert.equal(nextPickLevel(2), 3);
  assert.equal(nextPickLevel(3), 1, 'wraps to ×1 — Pass is how the deck says "not picked"');
});

test('one Pick tap opens the overlay at ×1 and commits NOTHING yet', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pick').click();

  assert.ok(celOn(), 'the confirmation overlay is up');
  assert.equal(cel().querySelector('.dd-cel-times').textContent, '×1');
  assert.equal(cel().querySelectorAll('.dd-cel-pip.is-on').length, 1);
  assert.match(cel().querySelector('.dd-cel-hint').textContent, /tap Pick again to raise/);
  assert.equal(overlay().querySelector('.dd-btn-pick-label').textContent, 'Picked ×1');
  assert.equal(overlay().querySelectorAll('.dd-actions .dd-btn-seg').length, 3, 'all three segments are always drawn');
  assert.equal(overlay().querySelectorAll('.dd-actions .dd-btn-seg.is-on').length, 1);
  assert.equal(levelOf('RankTarget'), 0, 'nothing written until the cycle locks in');
  assert.equal(cardName(), 'RankTarget', 'and the deck has not advanced');
});

test('tapping Pick again raises the level instead of deciding twice', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  const btn = () => overlay().querySelector('.dd-btn-pick');
  btn().click();
  btn().click();
  btn().click();

  assert.equal(cel().querySelector('.dd-cel-times').textContent, '×3');
  assert.equal(cel().querySelectorAll('.dd-cel-pip.is-on').length, 3);
  assert.equal(levelOf('RankTarget'), 0, 'still uncommitted');

  actions.flush();
  assert.equal(levelOf('RankTarget'), 3, 'the idle timer locks in the level that was showing');
  assert.equal(cardName(), 'PickFlow1');
});

test('a fourth tap wraps to ×1 rather than overflowing past must', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  const btn = () => overlay().querySelector('.dd-btn-pick');
  for (let i = 0; i < 4; i++) btn().click();

  assert.equal(cel().querySelector('.dd-cel-times').textContent, '×1');
  actions.flush();
  assert.equal(levelOf('RankTarget'), 1);
});

test('each Pick tap supersedes the previous timer — three taps decide once', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  const btn = () => overlay().querySelector('.dd-btn-pick');
  btn().click(); btn().click(); btn().click();

  assert.equal(actions.queued(), 1, 'two superseded timers were cancelled, not left armed');
  actions.flush();
  assert.equal(levelOf('RankTarget'), 3);
  assert.equal(levelOf('PickFlow1'), 0, 'no stray decision landed on the next card');
});

test('raising the level does not remount the sample player (the set keeps playing)', () => {
  const mounts = [];
  const actions = mkManualActions(mounts);
  renderDeckForTest(ctx, actions, CANON);
  const after = mounts.length;
  const btn = () => overlay().querySelector('.dd-btn-pick');
  btn().click(); btn().click(); btn().click();

  assert.equal(mounts.length, after, 'the overlay is painted in place, never through a re-render');
});

test('the undo message carries the level that was actually committed', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  const btn = () => overlay().querySelector('.dd-btn-pick');
  btn().click(); btn().click();
  actions.flush();

  assert.match(overlay().querySelector('.dd-undo-msg').textContent, /×2/);
});

test('Must shows the ★ MUST confirmation, Pass shows NOT FOR ME', () => {
  const a1 = mkManualActions();
  renderDeckForTest(ctx, a1, CANON);
  overlay().querySelector('.dd-btn-must').click();
  assert.ok(celOn());
  assert.equal(cel().querySelector('.dd-cel-star').textContent, '★');
  assert.equal(cel().querySelector('.dd-cel-label').textContent, 'MUST');
  a1.flush();
  closeDeck();

  state.crewDoc.festivals[FID].selections = JSON.parse(JSON.stringify(PRISTINE_SELECTIONS));
  state.crewDoc.festivals[FID].passes = JSON.parse(JSON.stringify(PRISTINE_PASSES));

  const a2 = mkManualActions();
  renderDeckForTest(ctx, a2, CANON);
  overlay().querySelector('.dd-btn-pass').click();
  assert.equal(cel().querySelector('.dd-cel-thumb').textContent, '👎');
  assert.equal(cel().querySelector('.dd-cel-label').textContent, 'NOT FOR ME');
});

test('Pass and Must commit immediately — only Pick negotiates', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-must').click();

  assert.equal(levelOf('RankTarget'), 4, 'written before any timer runs');
  assert.equal(cardName(), 'RankTarget', 'but the card is still on screen showing the confirmation');
  actions.flush();
  assert.equal(cardName(), 'PickFlow1', 'and only then does the deck advance');
});

test('touching the card abandons an open pick cycle instead of firing it mid-gesture', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pick').click();
  assert.ok(celOn());

  overlay().querySelector('.dd-card').dispatchEvent(
    new dom.window.MouseEvent('pointerdown', { clientX: 100, clientY: 300, bubbles: true }),
  );
  assert.equal(celOn(), false, 'the overlay is dismissed');
  assert.equal(overlay().querySelector('.dd-btn-pick-label').textContent, 'Pick');
  assert.equal(overlay().querySelectorAll('.dd-actions .dd-btn-seg.is-on').length, 0);

  actions.flush();
  assert.equal(levelOf('RankTarget'), 0, 'the abandoned cycle never commits');
  assert.equal(cardName(), 'RankTarget');
});

test('closing the deck cancels a pending pick — it cannot land on the next session', () => {
  const actions = mkManualActions();
  renderDeckForTest(ctx, actions, CANON);
  overlay().querySelector('.dd-btn-pick').click();
  closeDeck();
  actions.flush();

  assert.equal(levelOf('RankTarget'), 0, 'no write from a deck that is gone');
});

// ---- desktop header + rail search (design 6e) ------------------------------------
// The nav change: three destinations spelled the same way at both sizes, and
// search moved out of the top bar into the pane where narrowing already lives.
function navTabs() { return [...overlay().querySelectorAll('.dd2-navtab')].map((t) => t.textContent); }
function railSearch() { return overlay().querySelector('#dd2-search-input'); }
function gridNames() { return [...overlay().querySelectorAll('.dd2-gridcard .name')].map((n) => n.textContent); }

test('desktop header carries Wall · Discover, never a "Timetable" tab', () => {
  renderDesktopForTest(ctx, mkActions(), CANON);
  const tabs = navTabs();
  assert.equal(tabs.includes('Timetable'), false, 'the wall is one destination before and after set times drop');
  assert.deepEqual(tabs.slice(0, 2), ['Wall', 'Discover']);
  // Deck Fest carries no days{}, so My Day would open to a dead view — the tab
  // stays off rather than becoming a control that does nothing.
  assert.equal(tabs.includes('My Day'), false);
  assert.equal(overlay().querySelector('.dd2-navtab-active').getAttribute('aria-current'), 'page');
});

test('the search field lives at the top of the filter pane, above Sort', () => {
  renderDesktopForTest(ctx, mkActions(), CANON);
  const rail = overlay().querySelector('.dd2-rail');
  assert.equal(rail.firstElementChild.contains(railSearch()), true, 'first thing in the pane');
  // DOCUMENT_POSITION_FOLLOWING: Sort comes after the field, not before it.
  const followsSearch = railSearch().compareDocumentPosition(rail.querySelector('.dd2-sort-list'));
  assert.ok(followsSearch & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'Sort comes after it');
  // and nowhere near the top bar, which is navigation, identity and status only
  assert.equal(overlay().querySelector('.dd2-header input'), null);
});

test('typing in the rail search narrows the grid and keeps the caret', () => {
  const actions = mkActions();
  renderDesktopForTest(ctx, actions, CANON);
  assert.ok(gridNames().length > 1);

  const input = railSearch();
  input.focus();
  input.value = 'ranktar';
  input.setSelectionRange(7, 7);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.deepEqual(gridNames(), ['RankTarget'], 'the grid re-renders against the query');
  const after = railSearch();
  assert.equal(after.value, 'ranktar');
  assert.equal(document.activeElement, after, 'the rebuilt field takes focus back');
  assert.equal(after.selectionStart, 7, 'and the caret with it');
});

test('the rail query is per-visit: never persisted, gone on close', () => {
  renderDesktopForTest(ctx, mkActions(), CANON);
  const input = railSearch();
  input.value = 'ranktar';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.deepEqual(gridNames(), ['RankTarget']);
  // A facet is a preference and survives in localStorage; a query is a moment.
  assert.equal(localStorage.getItem('fp.discoverFilter.' + FID), null);

  closeDeck();
  renderDesktopForTest(ctx, mkActions(), CANON);
  assert.equal(railSearch().value, '', 'a fresh open opens on the whole pool');
  assert.ok(gridNames().length > 1);
});

// ---- carried playback intent across artists (device pass, 2026-08-04) -----------
// Opening Discover is silent. Pressing play is a decision that should survive
// the swipe to the next artist — and pausing is the same decision in reverse.
function lastMount(calls) { return calls[calls.length - 1]; }

test('the first artist of a visit mounts silent — Discover never opens playing', () => {
  const calls = [];
  renderDeckForTest(ctx, mkActions(calls), CANON);
  assert.equal(lastMount(calls).autoplay, false);
});

test('once playing, advancing to the next artist keeps playing', () => {
  const calls = [];
  const actions = mkActions(calls);
  renderDeckForTest(ctx, actions, CANON);
  // the player reports that sound was asked for (play tap, tab tap, track tap)
  lastMount(calls).onStateChange({ play: true });

  overlay().querySelector('.dd-btn-pick').click(); // a pick advances the deck
  assert.equal(cardName(), 'PickFlow1', 'we did advance');
  assert.equal(lastMount(calls).autoplay, true, 'and the next artist carries the intent');
});

test('a pause sticks — later artists open silent until asked again', () => {
  const calls = [];
  const actions = mkActions(calls);
  renderDeckForTest(ctx, actions, CANON);
  lastMount(calls).onStateChange({ play: true });
  lastMount(calls).onStateChange({ play: false }); // they pressed pause

  overlay().querySelector('.dd-btn-pick').click();
  assert.equal(lastMount(calls).autoplay, false, 'we do not restart sound they turned off');
});

test('the intent is per-visit: closing Discover resets it to silent', () => {
  const calls = [];
  renderDeckForTest(ctx, mkActions(calls), CANON);
  lastMount(calls).onStateChange({ play: true });
  closeDeck();

  const next = [];
  renderDeckForTest(ctx, mkActions(next), CANON);
  assert.equal(lastMount(next).autoplay, false, 'a fresh visit opens silent, like the first one');
});
