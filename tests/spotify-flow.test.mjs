// The Spotify promise: connect ONCE, and every festival in the crew fills in —
// including ones added later.
//
// It did not do that. Scanning badged only the festival you happened to be
// looking at, and then handed you the rest as homework: "Badged 42 artists on
// this fest. Open other fests to badge them too." Kevin's model is the correct
// one, and these tests hold the app to it (2026-07-12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
globalThis.sessionStorage = { ...globalThis.localStorage };
globalThis.location = { origin: 'https://fest.kevinhg.com', host: 'fest.kevinhg.com', hostname: 'fest.kevinhg.com', hash: '' };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

const state = await import('../js/state.js');
const spotify = await import('../js/spotify.js');
const { FESTIVALS, FESTIVAL_INDEX } = await import('../js/festivals.js');

// Two festivals in the crew, plus one the crew adds later.
const mkFest = (id, name, artists) => ({
  id, name, year: "'26", status: 'lineup', stages: [], days: {},
  artists: artists.map((n) => ({ name: n })),
});
FESTIVALS['sp-a'] = mkFest('sp-a', 'Fest A', ['GRiZ', 'Lane 8', 'Nobody I Know']);
FESTIVALS['sp-b'] = mkFest('sp-b', 'Fest B', ['Excision', 'GRiZ', 'Stranger']);
FESTIVALS['sp-c'] = mkFest('sp-c', 'Fest C (added later)', ['Lane 8', 'Excision']);
for (const id of ['sp-a', 'sp-b', 'sp-c']) FESTIVAL_INDEX.push({ id, status: 'lineup' });

// A library where I clearly listen to GRiZ, Lane 8 and Excision.
const LIB = {
  clientId: 'x'.repeat(32),
  userId: 'kev',
  fetchedAt: '2026-07-12T00:00:00.000Z',
  artists: {
    griz: { songs: 120, followed: true },
    'lane 8': { songs: 8 },
    excision: { songs: 42, followed: true },
  },
};

const freshCrew = (fests) => {
  store.clear();
  localStorage.setItem('fn_spotify_libmap_v1', JSON.stringify(LIB));
  state.activateCrew('sptoken_flow_01234567890', {
    v: 4, meta: {}, spotify: {}, people: { Kev: { colorIndex: 0 } },
    festivals: Object.fromEntries(fests.map((f) => [f, { selections: {} }])),
    affinity: {},
  });
  state.setActiveFestivalId(fests[0]);
};

test('connecting badges EVERY festival in the crew, not just the one on screen', async () => {
  freshCrew(['sp-a', 'sp-b']);

  const { total, perFest } = await spotify.badgeAllCrewFests('Kev');

  const aff = state.affinityFor('Kev');
  // Fest A's artists
  assert.equal(aff['GRiZ'].songs, 120, 'GRiZ badged (Fest A, the active one)');
  assert.equal(aff['Lane 8'].songs, 8);
  // Fest B's artists — the whole point. This is what used to require you to go
  // and open Fest B by hand.
  assert.equal(aff['Excision'].songs, 42, 'Excision badged (Fest B, NOT the active fest)');
  assert.equal(aff['Excision'].followed, true);
  // Artists I don't listen to stay unbadged.
  assert.equal(aff['Nobody I Know'], undefined);
  assert.equal(aff['Stranger'], undefined);

  assert.equal(total, 4, 'GRiZ + Lane 8 (A), Excision + GRiZ (B)');
  assert.deepEqual(Object.keys(perFest).sort(), ['sp-a', 'sp-b']);
  assert.equal(perFest['sp-b'].hits, 2);
});

test('a festival added later badges itself from the library already on the device', async () => {
  freshCrew(['sp-a']);
  await spotify.badgeAllCrewFests('Kev');
  assert.equal(state.affinityFor('Kev')['Excision'], undefined, 'Excision is not in Fest A');

  // The crew adds Fest C. No reconnect, no rescan — this is what switchFestival
  // does with the cached library map.
  state.ensureFestivalState('sp-c');
  state.setActiveFestivalId('sp-c');
  const n = spotify.applyAffinityToCrew('Kev', [...spotify.artistNamesOf(FESTIVALS['sp-c'])]);

  const aff = state.affinityFor('Kev');
  assert.equal(n, 2, 'Lane 8 + Excision badged on the new festival');
  assert.equal(aff['Excision'].songs, 42, 'the new festival just pulled — nobody had to do anything');
  assert.equal(aff['Lane 8'].songs, 8, 'and the badges it already had survive');
});

test('badging one festival never wipes another festival’s badges', async () => {
  freshCrew(['sp-a', 'sp-b']);
  await spotify.badgeAllCrewFests('Kev');

  // Switch to a festival with NO overlap at all.
  FESTIVALS['sp-empty'] = mkFest('sp-empty', 'No Overlap', ['Someone Else']);
  state.ensureFestivalState('sp-empty');
  state.setActiveFestivalId('sp-empty');
  spotify.applyAffinityToCrew('Kev', [...spotify.artistNamesOf(FESTIVALS['sp-empty'])]);

  const aff = state.affinityFor('Kev');
  assert.equal(aff['GRiZ'].songs, 120, 'the other festivals keep their badges');
  assert.equal(aff['Excision'].songs, 42);
});

test('the whole sweep is ONE write to the crew doc, not one per festival', async () => {
  freshCrew(['sp-a', 'sp-b', 'sp-c']);
  const before = state.getEditSeq();
  await spotify.badgeAllCrewFests('Kev');
  const writes = state.getEditSeq() - before;
  assert.equal(writes, 1, `badging 3 festivals should record once, not ${writes} times`);
});

test('the connect hop carries sp=connect, so one press means one connect', () => {
  freshCrew(['sp-a']);
  globalThis.location = { origin: 'https://stage.fest.kevinhg.com', host: 'stage.fest.kevinhg.com', hostname: 'stage.fest.kevinhg.com', hash: '' };

  const hop = spotify.canonicalHopUrl({ autoConnect: true });
  // Asserted against the CONSTANT, not a literal host: this fork's whole
  // Spotify bug was a hardcoded upstream host, and a test hardcoding the same
  // string would have gone green while sending our crew + person tokens to
  // someone else's domain.
  assert.match(hop, new RegExp(`^https://${spotify.CANONICAL_HOST.replace(/\./g, '\\.')}/`), 'OAuth happens on the one registered origin');
  assert.ok(!/kevinhg\.com/.test(hop), 'and never hops to the upstream author’s host — the tokens ride along in this URL');
  assert.match(hop, /sp=connect/, 'and continues by itself — the hop is our plumbing, not the user’s errand');
  // Built, not written: a token-shaped literal after `#g=` is exactly what the
  // pre-commit scan exists to stop, and a scanner that cries wolf on its own
  // fixtures is one people learn to wave through.
  assert.ok(hop.includes('#g=' + state.getCrewToken()), 'carrying the crew');

  // On the canonical host there is nothing to hop to.
  globalThis.location = { origin: `https://${spotify.CANONICAL_HOST}`, host: spotify.CANONICAL_HOST, hostname: spotify.CANONICAL_HOST, hash: '' };
  assert.equal(spotify.canonicalHopUrl({ autoConnect: true }), null);
});
