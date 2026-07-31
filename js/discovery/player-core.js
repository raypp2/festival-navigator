// Sample Player v2 — pure state machine (Discovery M2, build spec section 6).
// NO DOM, NO globals, NO fetch. Everything a UI needs to decide what to show
// is derived here and returned as a plain snapshot object; js/discovery/player.js
// owns the DOM + the three embed adapters and reacts to snapshots.
//
// Normative behavior source: design/discovery-handoff/project/Discovery -
// Sample Player.dc.html (its inline <script type="text/x-dc"> state logic —
// setSrc/setClip/toggle — is the reference this mirrors), and the validated
// findings in specifications/player-research/TEST-PLAN.md.
//
// PRIORITY doubles as both the tab display order AND the fallback order when
// a source errors or when the remembered source isn't available for the
// current artist — this is called out explicitly in the design sheet's "For
// engineering" box, so don't let the two lists drift apart.
export const PRIORITY = ['yt', 'sc', 'sp'];

// One shared localStorage key for the last-used source, honored across
// artists and reloads (falls back down PRIORITY when the current artist
// lacks that source). player.js is responsible for the actual localStorage
// object; this module only ever talks to the injected `storage` param so
// tests need no browser.
export const STORAGE_KEY = 'fp.sampleSource';

// Static labels/colors keyed the same as PRIORITY. This is data, not DOM —
// sharing it here means player.js and any future consumer render the same
// three names/colors without redeclaring them.
export const SOURCE_META = {
  yt: { label: 'YouTube', color: '#FF4E45' },
  sc: { label: 'SoundCloud', color: '#FF7A2F' },
  sp: { label: 'Spotify', color: '#67B98A' },
};

function isValidStorage(storage) {
  return !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function';
}

function readRemembered(storage) {
  if (!isValidStorage(storage)) return null;
  try {
    const v = storage.getItem(STORAGE_KEY);
    return PRIORITY.includes(v) ? v : null;
  } catch {
    // Storage can throw (Safari private mode quirks, blocked cookies, etc.)
    // — that's a degrade-gracefully case, not a crash.
    return null;
  }
}

function writeRemembered(storage, src) {
  if (!isValidStorage(storage)) return;
  try {
    storage.setItem(STORAGE_KEY, src);
  } catch {
    // Full/blocked storage shouldn't break playback — the session still
    // works, it just won't be remembered next time.
  }
}

// Which sources this artist actually resolved, in PRIORITY order. A tab only
// exists for a source with real data (presence-driven — DISC-3 / AC-8: no
// dead controls).
function presentSources(sources) {
  const present = [];
  if (Array.isArray(sources?.youtubeVideoIds) && sources.youtubeVideoIds.length > 0) present.push('yt');
  if (typeof sources?.soundcloudSlug === 'string' && sources.soundcloudSlug.trim()) present.push('sc');
  if (typeof sources?.spotifyId === 'string' && sources.spotifyId.trim()) present.push('sp');
  return PRIORITY.filter((k) => present.includes(k));
}

// YouTube alternates are known synchronously at mount (cached youtubeVideoIds
// per META-1/enrich-artists.mjs); labels come from the optional parallel
// youtubeLabels array, else "Set N". SoundCloud/Spotify alternates are either
// fetched live (SC getSounds()) or don't exist (Spotify) — player.js pushes
// those in later via setAlternates().
function ytAlternates(sources) {
  const ids = Array.isArray(sources?.youtubeVideoIds) ? sources.youtubeVideoIds : [];
  const labels = Array.isArray(sources?.youtubeLabels) ? sources.youtubeLabels : [];
  return ids.map((id, i) => ({ id, label: labels[i] || `Set ${i + 1}` }));
}

function resolveInitialSource(present, remembered) {
  if (present.length === 0) return null;
  if (remembered && present.includes(remembered)) return remembered;
  return present[0]; // present is already PRIORITY-ordered — highest-priority fallback
}

/**
 * Create one player-core instance. `storage` is optional (an object with
 * getItem/setItem, e.g. window.localStorage) — pass a fake in tests, pass
 * nothing to run without persistence.
 */
export function createPlayerCore({ storage } = {}) {
  let artistKey = null;
  let present = []; // sources this artist resolved, PRIORITY order
  let failed = new Set(); // sources whose embed errored this mount (strikethrough + Retry)
  let alternates = {}; // sourceKey -> [{ id, label }]
  let currentSource = null;
  let clipIndex = 0;
  let play = false;
  let online = true;

  function clampClipIndex() {
    const list = currentSource ? alternates[currentSource] || [] : [];
    if (list.length === 0) {
      clipIndex = 0;
      return;
    }
    if (clipIndex < 0) clipIndex = 0;
    if (clipIndex > list.length - 1) clipIndex = list.length - 1;
  }

  // A collapsed player has nothing to show as a stage: either the artist
  // resolved zero sources at all ("Nothing to sample yet", frame 4b), or
  // every resolved source has failed in this session (yt fails -> sc fails
  // -> sp fails -> nothing left to fall through to).
  function isCollapsed() {
    if (present.length === 0) return true;
    return present.every((s) => failed.has(s));
  }

  function snapshot() {
    const collapsed = isCollapsed();
    return {
      artistKey,
      present: [...present],
      failed: [...failed],
      currentSource: collapsed ? null : currentSource,
      clipIndex,
      play: collapsed ? false : play,
      online,
      collapsed,
      alternates: !collapsed && currentSource ? [...(alternates[currentSource] || [])] : [],
    };
  }

  // Ordered tab view-model: one entry per present source (regardless of
  // failed state — a failed tab still renders, struck through, with Retry;
  // it only disappears from the UI when the artist never had it at all).
  function tabs() {
    return present.map((key) => ({
      key,
      label: SOURCE_META[key].label,
      color: SOURCE_META[key].color,
      current: key === currentSource && !isCollapsed(),
      failed: failed.has(key),
    }));
  }

  // mount() is the only place play resets to false — tap-to-play, iOS-
  // gesture-safe: an artist card/page appearing on screen must never start
  // audio on its own (build spec section 6 / design sheet "For engineering").
  function mount(newArtistKey, sources) {
    artistKey = newArtistKey;
    present = presentSources(sources);
    failed = new Set();
    alternates = { yt: ytAlternates(sources) };
    currentSource = resolveInitialSource(present, readRemembered(storage));
    clipIndex = 0;
    play = false;
    clampClipIndex();
    return snapshot();
  }

  // Tapping a tab. Mirrors the design sheet's setSrc: switching source always
  // starts playback of that source's first clip. Re-selecting the already-
  // current source, or a source this artist doesn't have, or a source that
  // has already failed, is a no-op (failed sources only come back via retry).
  function setSource(src) {
    if (!present.includes(src)) return snapshot();
    if (failed.has(src)) return snapshot();
    if (src === currentSource) return snapshot();
    currentSource = src;
    clipIndex = 0;
    play = true;
    writeRemembered(storage, src);
    return snapshot();
  }

  // Tapping an alternate row. Mirrors the design sheet's setClip.
  function setClip(index) {
    if (currentSource == null) return snapshot();
    clipIndex = index;
    clampClipIndex();
    play = true;
    return snapshot();
  }

  function togglePlay() {
    if (currentSource == null) return snapshot();
    play = !play;
    return snapshot();
  }

  // SoundCloud's getSounds() lazy-loads (placeholder rows fill in as the
  // widget is scrolled) — player.js calls this every time it gets a fresher
  // list. Also used once at mount time for YouTube's cached ids, but that
  // path goes through mount() directly since it's synchronous.
  function setAlternates(src, items) {
    alternates = { ...alternates, [src]: Array.isArray(items) ? items : [] };
    clampClipIndex();
    return snapshot();
  }

  // A source's embed reported a hard error (YouTube onError 101/150/153 =
  // embedding disabled). Strike that tab and fall through to the next
  // present, non-failed source in PRIORITY order. Exhausting every present
  // source collapses the player — distinct from the zero-sources collapse
  // only in how you got there, identical in what's shown.
  function markFailed(src) {
    if (!present.includes(src)) return snapshot();
    failed.add(src);
    if (currentSource === src) {
      const next = PRIORITY.find((k) => present.includes(k) && !failed.has(k));
      currentSource = next || null;
      clipIndex = 0;
      // Falling through continues an already-live playback attempt (the
      // user's original tap), not a fresh unprompted autoplay — so unlike
      // mount(), a successful fallthrough keeps playing.
      play = !!next;
      if (next) writeRemembered(storage, next);
    }
    return snapshot();
  }

  // The design sheet's state-4 "Retry" affordance: clear the failed flag and
  // re-select that source, same semantics as a fresh tab tap (play:true —
  // it's a direct user gesture).
  function retry(src) {
    if (!present.includes(src)) return snapshot();
    failed.delete(src);
    currentSource = src;
    clipIndex = 0;
    play = true;
    writeRemembered(storage, src);
    return snapshot();
  }

  // navigator.onLine + online/offline listeners live in player.js (browser
  // globals); this just records the flag so snapshot()/UI can dim/disable.
  function setOnline(isOnline) {
    online = !!isOnline;
    return snapshot();
  }

  function getState() {
    return snapshot();
  }

  function getTabs() {
    return tabs();
  }

  return { mount, setSource, setClip, togglePlay, setAlternates, markFailed, retry, setOnline, getState, getTabs };
}
