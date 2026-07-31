import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerCore, PRIORITY, STORAGE_KEY } from '../js/discovery/player-core.js';

// Fake storage — no localStorage/browser needed. Mirrors the getItem/setItem
// surface createPlayerCore expects.
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
}

const CDW = {
  youtubeVideoIds: ['MuuWGXVLrPc', 'XFLIztjVaR8', 'tgivYC2s6hs'],
  youtubeLabels: ['Tomorrowland 2022', 'Tomorrowland Brasil 2024', 'Tomorrowland Belgium 2025'],
  soundcloudSlug: 'charlottedewittemusic',
  spotifyId: '1lJhME1ZpzsEa5M0wW6Mso',
};

test('PRIORITY and STORAGE_KEY are the contract values', () => {
  assert.deepEqual(PRIORITY, ['yt', 'sc', 'sp']);
  assert.equal(STORAGE_KEY, 'fp.sampleSource');
});

// ---- tab presence ----------------------------------------------------------

test('tab presence: only sources with real data render, in PRIORITY order', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  const snap = core.mount('adam-beyer', { youtubeVideoIds: ['7R5yo5FznTI'], soundcloudSlug: 'adambeyer', spotifyId: null });
  assert.deepEqual(snap.present, ['yt', 'sc']);
  const tabs = core.getTabs();
  assert.deepEqual(tabs.map((t) => t.key), ['yt', 'sc']);
});

test('tab presence: zero sources collapses immediately, no tabs', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  const snap = core.mount('nobody', {});
  assert.equal(snap.collapsed, true);
  assert.equal(snap.currentSource, null);
  assert.deepEqual(core.getTabs(), []);
});

// ---- initial-source resolution --------------------------------------------

test('initial resolution: no remembered source -> highest-priority present source (yt)', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  const snap = core.mount('cdw', CDW);
  assert.equal(snap.currentSource, 'yt');
  assert.equal(snap.play, false); // never autoplay on mount
});

test('initial resolution: remembered source is honored when the artist has it', () => {
  const core = createPlayerCore({ storage: fakeStorage({ [STORAGE_KEY]: 'sc' }) });
  const snap = core.mount('cdw', CDW);
  assert.equal(snap.currentSource, 'sc');
});

// ---- fallback when artist lacks remembered source --------------------------

test('fallback: remembered source not present for this artist -> falls to highest-priority present', () => {
  const core = createPlayerCore({ storage: fakeStorage({ [STORAGE_KEY]: 'sp' }) });
  // Adam Beyer has no Spotify in the verified dataset
  const snap = core.mount('adam-beyer', { youtubeVideoIds: ['7R5yo5FznTI'], soundcloudSlug: 'adambeyer' });
  assert.equal(snap.currentSource, 'yt');
});

test('fallback: garbage/unknown remembered value is ignored', () => {
  const core = createPlayerCore({ storage: fakeStorage({ [STORAGE_KEY]: 'xx' }) });
  const snap = core.mount('cdw', CDW);
  assert.equal(snap.currentSource, 'yt');
});

// ---- error fallthrough ------------------------------------------------------

test('error fallthrough: yt fails -> sc; sc fails -> sp; all fail -> collapse state', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  let snap = core.mount('cdw', CDW);
  assert.equal(snap.currentSource, 'yt');

  snap = core.markFailed('yt');
  assert.equal(snap.currentSource, 'sc');
  assert.equal(snap.collapsed, false);
  assert.deepEqual(snap.failed, ['yt']);
  assert.equal(snap.play, true); // fallthrough continues the live attempt

  snap = core.markFailed('sc');
  assert.equal(snap.currentSource, 'sp');
  assert.deepEqual(snap.failed, ['yt', 'sc']);

  snap = core.markFailed('sp');
  assert.equal(snap.currentSource, null);
  assert.equal(snap.collapsed, true);
  assert.equal(snap.play, false);
});

test('error fallthrough: failing a source that is not current does not change currentSource', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW); // currentSource = yt
  const snap = core.markFailed('sp');
  assert.equal(snap.currentSource, 'yt');
  assert.deepEqual(snap.failed, ['sp']);
});

test('error fallthrough: a failed tab still appears in getTabs(), struck through', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.markFailed('yt');
  const tabs = core.getTabs();
  assert.deepEqual(tabs.map((t) => t.key), ['yt', 'sc', 'sp']);
  const ytTab = tabs.find((t) => t.key === 'yt');
  assert.equal(ytTab.failed, true);
  assert.equal(ytTab.current, false);
  const scTab = tabs.find((t) => t.key === 'sc');
  assert.equal(scTab.current, true);
});

test('retry: clears the failed flag and re-selects the source as a fresh user gesture', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.markFailed('yt'); // -> sc
  const snap = core.retry('yt');
  assert.equal(snap.currentSource, 'yt');
  assert.deepEqual(snap.failed, []);
  assert.equal(snap.play, true);
});

// ---- persistence -------------------------------------------------------------

test('persistence: setSource writes through the injected storage', () => {
  const storage = fakeStorage();
  const core = createPlayerCore({ storage });
  core.mount('cdw', CDW); // yt by default
  core.setSource('sc');
  assert.equal(storage.getItem(STORAGE_KEY), 'sc');
});

test('persistence: the remembered source carries to a different artist', () => {
  const storage = fakeStorage();
  const core = createPlayerCore({ storage });
  core.mount('cdw', CDW);
  core.setSource('sc');
  const snap = core.mount('amelie-lens', { youtubeVideoIds: ['_Dy_Cn0HEZU'], soundcloudSlug: 'amelielens', spotifyId: '5Ho1vKl1Uz8bJlk4vbmvmf' });
  assert.equal(snap.currentSource, 'sc');
});

test('persistence: mount does not itself write to storage, only explicit selection does', () => {
  const storage = fakeStorage();
  const core = createPlayerCore({ storage });
  core.mount('cdw', CDW);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('persistence: works with no storage injected at all (no crash)', () => {
  const core = createPlayerCore({});
  const snap = core.mount('cdw', CDW);
  assert.equal(snap.currentSource, 'yt');
  assert.doesNotThrow(() => core.setSource('sc'));
});

// ---- clip switching ----------------------------------------------------------

test('clip switching: setClip updates the index and implies play:true', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  const snap = core.setClip(2);
  assert.equal(snap.clipIndex, 2);
  assert.equal(snap.play, true);
  assert.equal(snap.alternates[2].id, 'tgivYC2s6hs');
});

test('clip switching: out-of-range index clamps into the alternates list', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW); // 3 yt alternates
  let snap = core.setClip(99);
  assert.equal(snap.clipIndex, 2);
  snap = core.setClip(-4);
  assert.equal(snap.clipIndex, 0);
});

test('clip switching: switching source resets clip index to 0', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.setClip(2);
  const snap = core.setSource('sc');
  assert.equal(snap.clipIndex, 0);
});

test('clip switching: setAlternates (live SoundCloud getSounds()) populates the alternates list', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.setSource('sc');
  let snap = core.setAlternates('sc', [
    { id: 't1', label: 'KNTXT Radio 041' },
    { id: 't2', label: 'Overdrive' },
  ]);
  assert.equal(snap.alternates.length, 2);
  snap = core.setClip(1);
  assert.equal(snap.clipIndex, 1);
  assert.equal(snap.alternates[1].id, 't2');
});

test('clip switching: a fresher (shorter) setAlternates clamps a now out-of-range index', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.setSource('sc');
  core.setAlternates('sc', [
    { id: 't1', label: 'A' },
    { id: 't2', label: 'B' },
    { id: 't3', label: 'C' },
  ]);
  core.setClip(2);
  const snap = core.setAlternates('sc', [{ id: 't1', label: 'A' }]); // list shrank
  assert.equal(snap.clipIndex, 0);
});

// ---- no-autoplay-on-mount flag semantics --------------------------------------

test('no-autoplay-on-mount: play is always false immediately after mount, regardless of remembered source', () => {
  const storage = fakeStorage({ [STORAGE_KEY]: 'sc' });
  const core = createPlayerCore({ storage });
  const snap = core.mount('cdw', CDW);
  assert.equal(snap.play, false);
});

test('no-autoplay-on-mount: remounting a second artist after playback was active also resets play:false', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.setClip(1); // play:true
  assert.equal(core.getState().play, true);
  const snap = core.mount('amelie-lens', { youtubeVideoIds: ['_Dy_Cn0HEZU'] });
  assert.equal(snap.play, false);
});

test('togglePlay flips play and is a no-op when collapsed', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  let snap = core.togglePlay();
  assert.equal(snap.play, true);
  snap = core.togglePlay();
  assert.equal(snap.play, false);

  const collapsedCore = createPlayerCore({ storage: fakeStorage() });
  collapsedCore.mount('nobody', {});
  const collapsedSnap = collapsedCore.togglePlay();
  assert.equal(collapsedSnap.play, false);
});

test('setSource is a no-op for a source the artist does not have', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  const before = core.mount('adam-beyer', { youtubeVideoIds: ['7R5yo5FznTI'], soundcloudSlug: 'adambeyer' });
  const after = core.setSource('sp');
  assert.equal(after.currentSource, before.currentSource);
  assert.equal(after.play, false);
});

test('setSource is a no-op for an already-failed source (must retry instead)', () => {
  const core = createPlayerCore({ storage: fakeStorage() });
  core.mount('cdw', CDW);
  core.markFailed('yt'); // -> sc, yt struck
  const snap = core.setSource('yt');
  assert.equal(snap.currentSource, 'sc');
});
