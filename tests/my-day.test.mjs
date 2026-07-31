// My day + Decide (Discovery M6, js/discovery/my-day.js + decide.js). jsdom
// harness mirrors tests/deck.test.mjs/artist-page.test.mjs: a real crew doc
// through state.js, a fixture SCHEDULED festival (fest.days with real times)
// dropped straight into state.FESTIVALS, DOM assertions against the
// rendered overlays. Network-free: genre canon and the sample player are
// both INJECTED via `actions` (renderMyDayForTest/openDecide), same
// convention as every other Discovery surface.
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
const { renderMyDayForTest, closeMyDay, refreshOpenMyDay } = await import('../js/discovery/my-day.js');
const { closeDecide, getClashDismissal } = await import('../js/discovery/decide.js');

const FID = 'myday-fest';
FESTIVAL_INDEX.push({ id: FID, status: 'scheduled' });
const TOKEN = 'mydaytesttoken_012345678901234567';
const DAY = 'Day 1';

const PRISTINE_SELECTIONS = {
  FourTet: { Kevin: 4 },
  GRiZ: { Kevin: 2 },
  Skrillex: { Kevin: 4, Ren: 4 },
  AlisonWonderland: { Kevin: 4 },
};

state.activateCrew(TOKEN, {
  v: 4,
  meta: {},
  spotify: {},
  people: { Kevin: { colorIndex: 0 }, Ren: { colorIndex: 1 } },
  festivals: {
    [FID]: {
      selections: JSON.parse(JSON.stringify(PRISTINE_SELECTIONS)),
      passes: {},
      notes: {},
    },
  },
  affinity: {},
}, FID);

state.FESTIVALS[FID] = {
  id: FID,
  name: 'My Day Fest',
  dayMeta: { [DAY]: { wd: 'Sat', num: 1, date: 'Jul 1' } },
  days: {
    [DAY]: {
      stages: ['Main', 'Second'],
      artists: [
        { name: 'FourTet', stage: 'Main', time: '2:00 PM - 3:00 PM' },
        { name: 'SanHolo', stage: 'Main', time: '4:30 PM - 5:15 PM' }, // undecided — gap candidate
        { name: 'GRiZ', stage: 'Main', time: '6:30 PM - 8:00 PM' },
        { name: 'Skrillex', stage: 'Main', time: '9:00 PM - 10:15 PM' },
        { name: 'AlisonWonderland', stage: 'Second', time: '9:15 PM - 10:30 PM' }, // overlaps Skrillex
      ],
    },
  },
  artists: [
    { name: 'FourTet', day: DAY, stage: 'Main', genres: ['idm'] },
    { name: 'SanHolo', day: DAY, stage: 'Main', genres: ['future bass'] },
    { name: 'GRiZ', day: DAY, stage: 'Main', genres: ['future bass'] },
    { name: 'Skrillex', day: DAY, stage: 'Main', genres: ['dubstep'] },
    { name: 'AlisonWonderland', day: DAY, stage: 'Second', genres: ['future bass'] },
  ],
};

const CANON = { canon: ['IDM', 'Future Bass', 'Dubstep'], synonyms: {}, suppress: [] };
const ctx = { fid: FID, meName: 'Kevin', onNotesChange: () => {}, onOpenNotes: () => {}, onTap: () => {} };

function mkActions() {
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
    mountPlayer: () => ({ destroy: () => {}, getState: () => ({}), handoverTo: () => {} }),
    refreshMyDay: () => refreshOpenMyDay(),
  };
}

function overlay() { return document.getElementById('my-day-overlay'); }
function decideOverlay() { return document.getElementById('decide-overlay'); }

test.beforeEach(() => {
  state.crewDoc.festivals[FID].selections = JSON.parse(JSON.stringify(PRISTINE_SELECTIONS));
  state.crewDoc.festivals[FID].passes = {};
  store.clear();
});
test.afterEach(() => { closeMyDay(); closeDecide(); });

test('renders marked sets, a gap with a candidate chip, and a clash card', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);

  const setNames = [...overlay().querySelectorAll('.md-set .md-set-name')].map((n) => n.textContent);
  assert.deepEqual(setNames, ['FourTet', 'GRiZ'], 'FourTet and GRiZ are solo marked sets; Skrillex/Alison are clashed, not solo');

  const gapRow = overlay().querySelector('.md-gap');
  assert.ok(gapRow, 'the 3:00-6:30 PM window renders as an open gap');
  assert.match(gapRow.querySelector('.md-gap-label').textContent, /Open · 3:00 – 6:30 PM/);
  const chip = gapRow.querySelector('.md-gap-chip');
  assert.ok(chip, 'SanHolo is an undecided candidate inside the gap');
  assert.match(chip.textContent, /SanHolo/);

  const clashRow = overlay().querySelector('.md-clash');
  assert.ok(clashRow, 'Skrillex/Alison overlap renders as a clash');
  assert.match(clashRow.querySelector('.md-clash-label').textContent, /2 of your musts/);
  assert.match(clashRow.querySelector('.md-clash-names').textContent, /Skrillex/);
  assert.match(clashRow.querySelector('.md-clash-names').textContent, /AlisonWonderland/);
});

test('tapping a set card opens the artist page via ctx.onTap', () => {
  const tapped = [];
  const actions = mkActions();
  const localCtx = { ...ctx, onTap: (name) => tapped.push(name) };
  renderMyDayForTest(localCtx, actions, CANON, DAY);
  overlay().querySelector('.md-set').click();
  assert.deepEqual(tapped, ['FourTet']);
});

test('clicking the clash card routes to Decide with both clashing artists', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();

  const dOverlay = decideOverlay();
  assert.ok(dOverlay, 'Decide opens on top of My day');
  const names = [...dOverlay.querySelectorAll('.dc-card-name')].map((n) => n.textContent).sort();
  assert.deepEqual(names, ['AlisonWonderland', 'Skrillex']);
  assert.ok(dOverlay.querySelector('.dc-choose'), 'a Choose button renders for the card');
});

test('Decide: choosing demotes the OTHER clashing artist to level 1, mirrored into the local doc', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();

  const chooseButtons = [...decideOverlay().querySelectorAll('.dc-choose')];
  const chooseSkrillex = chooseButtons.find((b) => b.textContent === 'Choose Skrillex');
  assert.ok(chooseSkrillex);
  chooseSkrillex.click();

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4, 'the chosen artist keeps its level');
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 1, 'the other clash member is demoted to level 1, not cleared');
});

test('Decide: undo restores the demoted artist to its prior level', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  const chooseSkrillex = [...decideOverlay().querySelectorAll('.dc-choose')].find((b) => b.textContent === 'Choose Skrillex');
  chooseSkrillex.click();
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 1);

  const undo = actions.getLastUndo();
  assert.equal(typeof undo, 'function', 'choosing offers an undo callback');
  undo();

  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 4, 'undo restores the prior must level atomically');
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4, 'the chosen artist is untouched by the whole round-trip');
});

test('Decide: "Split it" is a device-local dismissal (never a doc write) that re-renders My day as resolved', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();

  decideOverlay().querySelector('.dc-split').click();

  assert.equal(getClashDismissal(FID, DAY, ['Skrillex', 'AlisonWonderland']), 'split');
  // Never written to the shared crew doc — selections are untouched.
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4);
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 4);

  // actions.refreshMyDay() (wired to refreshOpenMyDay) re-rendered My day live.
  const clashRow = overlay().querySelector('.md-clash');
  assert.ok(clashRow.classList.contains('is-resolved'));
  assert.match(clashRow.querySelector('.md-clash-label').textContent, /Split planned/);
});

test('Decide: "keep both starred, decide on-site" dismisses as onsite, independently of split', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  decideOverlay().querySelector('.dc-onsite').click();

  assert.equal(getClashDismissal(FID, DAY, ['Skrillex', 'AlisonWonderland']), 'onsite');
  const clashRow = overlay().querySelector('.md-clash');
  assert.match(clashRow.querySelector('.md-clash-label').textContent, /Deciding on-site/);
});

test('dismissal persists in localStorage keyed by day + sorted artist names, and survives a fresh render', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  decideOverlay().querySelector('.dc-split').click();

  const raw = localStorage.getItem('fp.clashResolved.' + FID);
  assert.ok(raw, 'a fake-localStorage entry was written');
  const parsed = JSON.parse(raw);
  const key = Object.keys(parsed)[0];
  assert.match(key, /^Day 1\|/);
  assert.equal(parsed[key], 'split');

  // A totally fresh render (simulating a reload) reads the same dismissal back.
  closeMyDay();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  const clashRow = overlay().querySelector('.md-clash');
  assert.ok(clashRow.classList.contains('is-resolved'));
});

test('empty state: nothing marked yet renders the friendly Discover-deck card, not gap/clash noise', () => {
  state.crewDoc.festivals[FID].selections = {};
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  assert.ok(overlay().querySelector('.md-empty'), 'the empty state renders');
  assert.equal(overlay().querySelector('.md-set'), null);
  assert.equal(overlay().querySelector('.md-clash'), null);
});
