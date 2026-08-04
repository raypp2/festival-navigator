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

// Map a click/drag position on a seek track to a playback fraction.
export function seekFraction(x, width) {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.min(1, Math.max(0, x / width));
}

// SoundCloud getSounds() → our alternates list, with the monetization truth
// baked in. The discriminator is monetization_model, NOT policy — policy
// 'MONETIZE' covers both the tracks the widget skips and the ones it plays in
// full, so keying on it alone drops the good ones too. Evidence (live widget
// probe, 2026-08-04, soundcloud.com/{kx5official,sanholobeats,loudluxury}):
//   MONETIZE + 'AD_SUPPORTED'  — PLAY then PAUSE at 0ms for anonymous
//                        listeners (this is the "plays then immediately skips"
//                        bug); a row for it is a dead control, so it's dropped.
//   MONETIZE + 'BLACKBOX' — streams in FULL (probed past 51s on Kx5, and it is
//                        what the widget auto-advances TO after skipping the
//                        ad-supported ones). These are usually the long live
//                        sets — the best rows on the page. KEPT.
//   policy 'SNIP'      — 30-second preview (duration 30000 vs full_duration
//                        ~162s on the probe) — kept, badged, honesty rule.
//   policy 'ALLOW'/absent — streams in full.
//   'BLOCK' / streamable:false — never plays; dropped.
// Keying on policy alone struck out 17 of 30 SoundCloud tabs on the Ubbi Dubbi
// 2026 lineup (Kx5 and San Holo were 100% dead); this rule leaves 3, all of
// which really are unplayable.
export function isUnplayableSound(s) {
  if (!s) return false;
  return s.policy === 'BLOCK' || s.streamable === false
    || (s.policy === 'MONETIZE' && s.monetization_model === 'AD_SUPPORTED');
}

// Sounds still lazy-loading (no title yet) can't be judged and stay as
// loading rows. initialIndex = the first full-play row (never auto-pick a
// preview when a full set is sitting right there); allUnplayable = every sound
// IN THIS LIST is known-unplayable.
//
// allUnplayable is a fact about the list it was handed, NOT a verdict on the
// artist — getSounds() hands back a growing PREFIX of the profile, so a `true`
// here on an early fetch means nothing until the list has stopped growing.
// player.js owns that wait; treating a first-fetch `true` as terminal is
// exactly the bug that struck SoundCloud dead a second after it started on
// snowstrippers / sofitukker / clairerosinkranz / rufusdusol (2026-08-04).
export function mapSoundcloudSounds(sounds) {
  const arr = Array.isArray(sounds) ? sounds.filter(Boolean) : [];
  const unplayable = isUnplayableSound;
  const kept = arr.filter((s) => !s.title || !unplayable(s));
  const items = kept.slice(0, 6).map((s) => ({
    id: s.permalink_url,
    label: s.title || null,
    preview: s.policy === 'SNIP',
  }));
  const firstFull = items.findIndex((i) => i.label && !i.preview);
  return {
    items,
    initialIndex: firstFull >= 0 ? firstFull : 0,
    allUnplayable: arr.length > 0 && arr.every((s) => s.title && unplayable(s)),
  };
}

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
  function setAlternates(src, items, defaultIndex) {
    alternates = { ...alternates, [src]: Array.isArray(items) ? items : [] };
    // A data-driven default pick (e.g. SC's first full-play track) applies
    // only while nothing is playing and the user hasn't chosen a row —
    // never yanks an in-progress selection.
    if (Number.isInteger(defaultIndex) && src === currentSource && !play && clipIndex === 0) {
      clipIndex = defaultIndex;
    }
    clampClipIndex();
    return snapshot();
  }

  // The widget told us what it's ACTUALLY playing (auto-advance off an
  // unplayable track, or its own internal next). State follows reality —
  // no play-state change, and the caller must NOT drive the embed off this
  // (that would loop). Distinct from setClip, which is a user gesture.
  function syncClipIndex(src, index) {
    if (src === currentSource && Number.isInteger(index)) {
      clipIndex = index;
      clampClipIndex();
    }
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

  return { mount, setSource, setClip, togglePlay, setAlternates, syncClipIndex, markFailed, retry, setOnline, getState, getTabs };
}
