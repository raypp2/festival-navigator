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
const { closeDecide } = await import('../js/discovery/decide.js');
const { getResolution } = await import('../js/discovery/resolutions.js');

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
  // .md-set is a wrapper now so the plan control can sit inside the card; the
  // card itself is the button that opens the artist page.
  overlay().querySelector('.md-set .md-set-card').click();
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

// Selecting and COMMITTING are two steps now, deliberately: the whole value of
// the window is watching the plan land on it before you agree to it. These
// helpers mirror what a person does.
function selectLead(name) {
  const btn = [...decideOverlay().querySelectorAll('.dc-choose')]
    .find((b) => b.textContent === `Choose ${name}`);
  assert.ok(btn, `a Choose ${name} button`);
  btn.click();
}
function commit() {
  const btn = decideOverlay().querySelector('.dc-commit');
  assert.ok(btn, 'a commit button appears once something is selected');
  assert.equal(btn.disabled, false, 'and it is live when the selection differs from what is saved');
  btn.click();
}

// SPIKE — these five used to pin the old semantics: choose DEMOTED everyone
// else to pick x1, and "split"/"on-site" wrote a dismissal. That is the exact
// behaviour the lead/keep model replaces, so they are rewritten rather than
// deleted — the assertion worth keeping from every one of them is "never a doc
// write", and it still holds, more strongly than before.

test('Decide: choosing records a LEAD and demotes nobody', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();

  selectLead('Skrillex');
  // selecting alone must NOT write — it is a preview
  assert.equal(getResolution(FID, DAY, ['Skrillex', 'AlisonWonderland']), null,
    'selecting previews the plan on the window; it does not save it');
  commit();

  assert.deepEqual(getResolution(FID, DAY, ['Skrillex', 'AlisonWonderland']),
    { kind: 'lead', lead: 'Skrillex' });
  // The whole point: pick level is TASTE and a resolution is PLAN. Choosing one
  // artist must not say you like the other one less.
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4,
    'the chosen artist keeps its level');
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 4,
    'and so does the one not chosen — nobody is demoted behind the person\'s back');
});

test('Decide: undo restores the previous plan, still touching no levels', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  selectLead('Skrillex'); commit();
  assert.equal(getResolution(FID, DAY, ['Skrillex', 'AlisonWonderland']).lead, 'Skrillex');

  const undo = actions.getLastUndo();
  assert.equal(typeof undo, 'function', 'choosing offers an undo callback');
  undo();

  assert.equal(getResolution(FID, DAY, ['Skrillex', 'AlisonWonderland']), null,
    'undo clears the plan it created');
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 4);
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4);
});

test('Decide: "Keep both" records a keep plan and writes nothing to the doc', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();

  [...decideOverlay().querySelectorAll('.dc-opt')].find((b) => /^Keep/.test(b.textContent)).click();
  commit();

  assert.deepEqual(getResolution(FID, DAY, ['Skrillex', 'AlisonWonderland']), { kind: 'keep' });
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.Skrillex.Kevin), 4);
  assert.equal(model.readLevel(state.crewDoc, state.crewDoc.festivals[FID].selections.AlisonWonderland.Kevin), 4);
});

test('a resolved window stops being a clash and its artists become rows', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  selectLead('Skrillex'); commit();

  // The complaint this whole change answers: the clash used to come straight
  // back after deciding.
  assert.equal(overlay().querySelectorAll('.md-clash').length, 0, 'no clash row survives the decision');
  const names = [...overlay().querySelectorAll('.md-set-name')].map((n) => n.textContent);
  assert.ok(names.some((n) => n.includes('Skrillex')), 'the lead is a row');
  assert.ok(names.some((n) => n.includes('AlisonWonderland')),
    'and so is the alternate — My Day must not drop an artist that was considered');
  // marked by the SHAPE of the row, not a tag you have to stop and read
  assert.ok(overlay().querySelector('.md-set.is-lead'), 'the lead is marked as such');
  assert.ok(overlay().querySelector('.md-set.is-alt'), 'the alternate is subordinate to it');
});

test('a decided window stays reachable — the plan strip reopens Decide', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  selectLead('Skrillex'); commit();

  // Once the undo toast goes, this strip is the ONLY route back to the
  // decision. Without it the choice is permanent by accident.
  // the control lives INSIDE the lead's card now, not in a strip above the group
  const lead = overlay().querySelector('.md-set.is-lead');
  assert.ok(lead, 'the lead row is marked as the lead');
  assert.ok(overlay().querySelector('.md-set.is-alt'), 'and the alternate is subordinate to it');
  const chg = lead.querySelector('.md-set-plan');
  assert.ok(chg, 'the lead card carries the plan control');
  assert.match(chg.textContent, /Leading/);
  assert.match(chg.textContent, /change/i);

  chg.click();
  assert.ok(decideOverlay(), 'and tapping it reopens Decide for that window');
  // reopening shows the SAVED plan, not a blank slate
  const commitBtn = decideOverlay().querySelector('.dc-commit');
  assert.ok(commitBtn.disabled, 'the saved plan is already selected, so committing it again is a no-op');
});

test('a plan persists in localStorage keyed by day + sorted artist names, and survives a fresh render', () => {
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  overlay().querySelector('.md-clash').click();
  [...decideOverlay().querySelectorAll('.dc-opt')].find((b) => /^Keep/.test(b.textContent)).click();
  commit();

  const raw = localStorage.getItem('fp.clashPlan.' + FID);
  assert.ok(raw, 'a fake-localStorage entry was written');
  const parsed = JSON.parse(raw);
  const key = Object.keys(parsed)[0];
  assert.match(key, /^Day 1\|/);
  assert.deepEqual(parsed[key], { kind: 'keep' });

  closeMyDay();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  assert.equal(overlay().querySelectorAll('.md-clash').length, 0, 'still resolved after a reload');
});

test('empty state: nothing marked yet renders the friendly Discover-deck card, not gap/clash noise', () => {
  state.crewDoc.festivals[FID].selections = {};
  const actions = mkActions();
  renderMyDayForTest(ctx, actions, CANON, DAY);
  assert.ok(overlay().querySelector('.md-empty'), 'the empty state renders');
  assert.equal(overlay().querySelector('.md-set'), null);
  assert.equal(overlay().querySelector('.md-clash'), null);
});
