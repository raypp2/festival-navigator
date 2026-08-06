// Sample Player v2 — DOM + embed adapters (Discovery M2, build spec section 6).
// State logic lives in js/discovery/player-core.js (pure, tested); this module
// owns the DOM, the three embed SDKs, and the ONE PLAYER, ALWAYS singleton.
//
// Normative behavior source: design/discovery-handoff/project/Discovery -
// Sample Player.dc.html. Embed mechanics (keyless YT, SC Widget API,
// Spotify iframe-api, error codes, lazy getSounds()) are validated in
// specifications/player-research/TEST-PLAN.md and its harnesses
// (01-soundcloud.html, 02-spotify.html, 03-youtube.html, 04-integration.html,
// 06-player.html) — this file mirrors their proven SDK calls, not guesses.
//
// This module cannot be exercised by `node --test` (it needs a DOM + three
// third-party iframes) — design/player-harness.html is the manual test
// surface for it.

import { createPlayerCore, PRIORITY, SOURCE_META, mapSoundcloudSounds, isUnplayableSound, seekFraction } from './player-core.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// How long the rail keeps showing the position we ASKED for before conceding
// the embed is not going to get there. Generous enough for a YouTube buffer
// on a festival LTE connection; short enough that a refused seek self-heals.
const SEEK_SETTLE_MS = 2500;
const SEEK_SETTLE_EPS = 0.01; // "arrived" = within 1% of the track

// How the SoundCloud track list is waited out. getSounds() returns a growing
// prefix of the profile rather than one complete list, so both questions we
// ask of it — "which track will actually play?" and "is this profile dead?" —
// have to be answered against a list that has stopped changing. Measured on
// the four profiles that misbehaved on-device (2026-08-04): rufusdusol went
// 18 sounds at READY → 146 at +6s, and its first streamable track is at index
// 54.
//
// SC_STABLE_POLLS is 3 and that number is load-bearing. The list does not fill
// smoothly — it arrives in BURSTS SEPARATED BY PLATEAUS, and consecutive polls
// of snowstrippers measured 9, 9, 20, 20, 25, 45 (700ms apart, same on an
// 82x46 iframe and a 400x200 one — the widget's own paging, not a visibility
// effect). So "the length didn't change since last time" is true twice while
// the list is still loading, and a single-comparison stability test declares
// a profile dead mid-load. Three consecutive identical readings means the
// widget has genuinely done nothing for 2.1s.
const SC_POLL_MS = 700;
const SC_MAX_POLLS = 10;
const SC_STABLE_POLLS = 3;

// ---------------------------------------------------------------------------
// Lazy SDK loaders — each third-party script is injected at most once per
// page, cached as a promise so repeated mounts don't re-inject it.
// ---------------------------------------------------------------------------

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

let scApiPromise = null;
function loadSoundCloudApi() {
  if (window.SC && window.SC.Widget) return Promise.resolve(window.SC);
  if (scApiPromise) return scApiPromise;
  scApiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://w.soundcloud.com/player/api.js';
    s.onload = () => resolve(window.SC);
    s.onerror = () => reject(new Error('SoundCloud widget API failed to load'));
    document.head.appendChild(s);
  });
  return scApiPromise;
}

let spApiPromise = null;
function loadSpotifyApi() {
  if (window.__fpSpotifyIframeApi) return Promise.resolve(window.__fpSpotifyIframeApi);
  if (spApiPromise) return spApiPromise;
  spApiPromise = new Promise((resolve) => {
    const prevReady = window.onSpotifyIframeApiReady;
    window.onSpotifyIframeApiReady = (api) => {
      window.__fpSpotifyIframeApi = api;
      if (typeof prevReady === 'function') prevReady(api);
      resolve(api);
    };
    const s = document.createElement('script');
    s.src = 'https://open.spotify.com/embed/iframe-api/v1';
    s.async = true;
    document.head.appendChild(s);
  });
  return spApiPromise;
}

function safeLocalStorage() {
  try {
    const probeKey = '__fp_player_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    // Private-mode / disabled storage: fall back to an in-memory stand-in so
    // tabs still work for this page load, just without cross-reload memory.
    const mem = new Map();
    return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  }
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// ONE PLAYER, ALWAYS — a single module-level instance. Mounting a new player
// destroys whatever was previously live, across all three embed types.
// ---------------------------------------------------------------------------
let ACTIVE = null;

/**
 * mountPlayer({ host, artist, sources, layout, onStateChange })
 *
 * host          — element to render into.
 * artist        — { id?, name, genres? } (genres: string or string[]).
 * sources       — { youtubeVideoIds?, youtubeLabels?, soundcloudSlug?, spotifyId? }.
 * layout        — 'full' | 'compact' | 'desktop'.
 * showHeader    — default true; false suppresses the name/genres head (the
 *                 artist page already carries both in its hero — frame 5a
 *                 draws the sample block headerless). Offline status still
 *                 renders either way.
 * autoplay      — default FALSE, and the only way a freshly mounted player
 *                 opens playing. Pass the caller's carried playback intent:
 *                 true only when this person already pressed play on the
 *                 artist they just came from. Never a way to start sound
 *                 nobody asked for.
 * onStateChange — optional (snapshot) => void, called after every render.
 *                 Read snap.play here to keep a carried intent up to date —
 *                 it is true after a play/tab/track tap and false after a
 *                 pause, which is exactly the signal.
 *
 * Returns { destroy, getState, handoverTo(newHost, newLayout) }.
 */
export function mountPlayer({ host, artist, sources, layout = 'full', showHeader = true, autoplay = false, onStateChange } = {}) {
  if (!host) throw new Error('mountPlayer: host element is required');
  if (ACTIVE) ACTIVE.destroy(); // tear down the previous embed FIRST, always

  const instance = createInstance({ host, artist, sources, layout, showHeader, autoplay, onStateChange });
  ACTIVE = instance;
  instance.init();

  return {
    destroy: () => {
      instance.destroy();
      if (ACTIVE === instance) ACTIVE = null;
    },
    getState: () => instance.core.getState(),
    handoverTo: (newHost, newLayout) => instance.handoverTo(newHost, newLayout),
    remountFor: (opts) => instance.remountFor(opts),
  };
}

function createInstance({ host, artist, sources, layout, showHeader = true, autoplay = false, onStateChange }) {
  const core = createPlayerCore({ storage: safeLocalStorage() });
  // `let`, not `const`: remountFor() re-points this instance at a NEW ARTIST
  // without tearing the embed down (see the note on remountFor below), so the
  // artist identity has to be able to move.
  let curArtist = artist;
  let curSources = sources;
  let artistKey = artist?.id || artist?.name || 'unknown-artist';
  let genresLine = Array.isArray(artist?.genres) ? artist.genres.join(' · ') : artist?.genres || '';

  let curLayout = layout;
  let curHost = host;
  let root = null;
  let embedHost = null; // the persistent DOM node that owns the live <iframe> — reparented, never rebuilt, across renders/layouts
  let embedAdapter = null; // { destroy, play, pause, loadClip? } for whatever is currently mounted
  let lastSnap = null;
  let destroyed = false;
  let ytTicker = null; // interval id for the full/desktop custom progress bar
  let seekDragging = false; // a finger owns the scrubber — ticker frames must not fight it
  let lastSeekFrac = 0; // last painted position, 0..1 (the keyboard step reads from it)
  let seekTarget = null; // fraction we asked the embed for, until it gets there
  let seekTargetAt = 0; // when we asked (ms) — bounds the wait on a refused seek
  let seekTeardown = null; // ends a live drag if the row is rebuilt under it
  let playingNow = false; // the EMBED says it is playing — not merely that we asked it to

  function notify(snap, meta) {
    if (typeof onStateChange === 'function') onStateChange(snap, meta);
  }

  // ---- the honest-icon watchdog -------------------------------------------
  // Asking an embed to play is not the same as it playing, and on iOS the gap
  // between the two is a rule, not a glitch: Safari refuses to start audio on
  // an element no finger has touched. When that happens the glyph used to
  // paint from what we ASKED for, so it showed Pause over silence — and the
  // next tap only turned off a request that had never been granted, which is
  // why starting sound took two taps (device report, 2026-08-04).
  //
  // So: after every request to play, wait. If no real PLAY event arrives, the
  // platform said no, and the player says so too — back to a Play glyph, and
  // the very next tap is a genuine user gesture that will be honored.
  // 2500, not 1500: measured on an iPhone (design/ios-playback-probe, trace
  // 2026-08-04), a carried YouTube embed reports playing ~1.16s after the load
  // and the playhead moves shortly after. A shorter fuse would call a slow
  // start a refusal.
  const PLAY_REFUSED_MS = 2500;
  let playWatchdog = null;
  let lastKnownPos = 0;     // seconds, as last reported by whatever is mounted
  let watchdogBase = null;  // the position we were at when we started waiting
  function clearPlayWatchdog() {
    if (playWatchdog) { clearTimeout(playWatchdog); playWatchdog = null; }
    watchdogBase = null;
  }
  // IDEMPOTENT, and that is the point. It used to clear and re-arm on every
  // call, resetting the baseline with it — and applyState calls this on every
  // render, so a surface that re-renders while waiting (a clip sync, a chrome
  // patch) kept moving the goalposts and the movement check could never
  // complete. A watch already running is left alone.
  function armPlayWatchdog() {
    if (playWatchdog) return;
    watchdogBase = lastKnownPos;
    playWatchdog = setTimeout(() => {
      playWatchdog = null;
      if (destroyed || playingNow) return;
      if (!lastSnap || !lastSnap.play || lastSnap.collapsed) return;
      // Reconcile to what is true. The carried INTENT is deliberately not
      // withdrawn here — the caller is told this was a refusal, not a person
      // pausing, so the next artist still gets its try. Only the icon changes.
      applyState(core.togglePlay(), { autoplayRefused: true });
    }, PLAY_REFUSED_MS);
  }

  function onlineHandler() { applyState(core.setOnline(true)); }
  function offlineHandler() { applyState(core.setOnline(false)); }

  function init() {
    root = document.createElement('div');
    setLayoutClass();
    curHost.appendChild(root);

    core.setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);

    applyState(core.mount(artistKey, curSources || {}, { autoplay }));
  }

  // -------------------------------------------------------------------------
  // Top-level render orchestrator.
  //
  // Three tiers, cheapest first:
  //  1. collapsed            -> tear down embed, show the one-liner.
  //  2. chrome-affecting     -> source switched / online flipped / a source
  //                             failed-or-retried. Rebuild the chrome, and
  //                             remount the embed only if the SOURCE changed.
  //  3. clip/play only       -> patch the few DOM bits that show it (clip
  //                             row highlight, now-playing title, play glyph)
  //                             without ever touching embedHost's parent
  //                             chain, and reconcile the live embed via its
  //                             own API (loadClip / play / pause).
  //
  // Tier 3 existing specifically so a clip tap or a play/pause toggle never
  // goes through innerHTML='' — that's what makes the "one player, always"
  // promise hold up for iframes: an iframe reloads if it's fully removed
  // from the document and reattached later, so anything that can avoid that
  // path, does.
  // -------------------------------------------------------------------------
  function applyState(snap, meta) {
    if (destroyed) return;
    const prev = lastSnap;
    lastSnap = snap;
    root.classList.toggle('is-offline', !snap.online);
    // Every transition into "playing" is a claim that has to be checked.
    if (snap.play && !snap.collapsed) armPlayWatchdog();
    else clearPlayWatchdog();

    if (snap.collapsed) {
      teardownEmbed();
      renderCollapsed();
      notify(snap);
      return;
    }

    const sourceChanged = !prev || prev.collapsed || prev.currentSource !== snap.currentSource;
    const chromeChanged = sourceChanged || !prev || prev.online !== snap.online || prev.failed.length !== snap.failed.length;

    if (chromeChanged) {
      rebuildChrome(snap, sourceChanged);
      if (sourceChanged) mountEmbed(snap.currentSource, snap);
    } else {
      patchClipAndPlay(snap);
      reconcileEmbed(snap, prev, meta);
    }
    notify(snap, meta);
  }

  function reconcileEmbed(snap, prev, meta) {
    if (!embedAdapter) return;
    if (snap.clipIndex !== prev.clipIndex) {
      const item = snap.alternates[snap.clipIndex];
      if (item && embedAdapter.loadClip) embedAdapter.loadClip(item);
    } else if (snap.play !== prev.play) {
      // The embed REPORTED this; it is already in the state we just recorded,
      // and telling it again is not a no-op. Spotify's controller.play() starts
      // the track from the BEGINNING — resume() is the one that continues — so
      // echoing its own play back at it restarted the clip about a second in,
      // which is exactly when playback_update first arrives (device report,
      // 2026-08-06). Record what we were told; do not answer it.
      if (meta && meta.fromEmbed) return;
      if (snap.play) embedAdapter.play && embedAdapter.play();
      else embedAdapter.pause && embedAdapter.pause();
    }
  }

  // ---- tier 3: touch only the DOM that reflects clipIndex/play, never embedHost ----
  function patchClipAndPlay(snap) {
    if (snap.currentSource !== 'sp') {
      const oldClips = root.querySelector('.sample-player-clips');
      if (oldClips) oldClips.replaceWith(renderClips(snap));
    }
    if (curLayout === 'compact') {
      const meta = root.querySelector('.sample-player-np-meta');
      if (meta) meta.innerHTML = npMetaHtml(snap);
      const btn = root.querySelector('.sample-player-np-btn');
      if (btn) setPlayGlyph(btn, snap.play);
    } else {
      const overlayBtn = root.querySelector('.sample-player-yt-overlay button');
      if (overlayBtn) setPlayGlyph(overlayBtn, snap.play);
    }
  }

  function setPlayGlyph(btn, playing) {
    btn.textContent = playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function npMetaHtml(snap) {
    const item = snap.alternates[snap.clipIndex];
    const title = snap.currentSource === 'sp' ? (curArtist?.name || '') : item?.label || 'Loading…';
    const sub = snap.currentSource === 'sp'
      ? 'Top track · Spotify'
      : `${SOURCE_META[snap.currentSource].label} · ${snap.clipIndex + 1} of ${Math.max(snap.alternates.length, 1)}`;
    return `<div class="sample-player-np-title">${esc(title)}</div><div class="sample-player-np-sub">${esc(sub)}</div>`;
  }

  // -------------------------------------------------------------------------
  // Tier 2: full chrome rebuild. embedHost, if it must survive this render
  // (sourceChanged === false — e.g. an offline flip or a background-tab
  // failure while a different source keeps playing), is explicitly detached
  // BEFORE root.innerHTML is wiped and reattached at the very end, all
  // within this one synchronous call — no other DOM mutation, no
  // await/setTimeout, runs in between. That keeps the iframe's disconnected
  // window as small as technically possible; browsers do not reload an
  // <iframe> on a same-tick reparent, but a mid-teardown removeChild
  // followed by a later, separate re-insertion risks exactly that. UNVERIFIED
  // without a real browser — see design/player-harness.html.
  // -------------------------------------------------------------------------
  // Where a live embed waits out a chrome rebuild. It has to be IN the document
  // — Safari discards an iframe's browsing context the moment it leaves, and it
  // does not wait for the end of the tick to do it, whatever the note above
  // hoped. Measured consequence on an iPhone: the carried YouTube embed came
  // back reloaded, which cost it the gesture unlock, redrew its poster, and
  // left our API object talking to a player that no longer existed
  // (2026-08-04). Offscreen but rendered — display:none stops media by itself.
  function embedPark() {
    let park = document.getElementById('sp-embed-park');
    if (!park) {
      park = document.createElement('div');
      park.id = 'sp-embed-park';
      park.setAttribute('aria-hidden', 'true');
      park.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;'
        + 'overflow:hidden;opacity:0;pointer-events:none;';
      document.body.appendChild(park);
    }
    return park;
  }

  // Rebuild the chrome AROUND a live embed without the embed changing parents.
  //
  // The ordinary rebuild wipes root and puts the embed host back afterwards,
  // which is a reparent — and WebKit re-creates an iframe's browsing context on
  // any reparent at all, losing the gesture unlock with it (measured,
  // design/ios-playback-probe step 5B). So when there is a live embed to
  // protect, every sibling is replaced and the stage that holds it is left
  // exactly where it is. The stage's own per-artist details are the only things
  // updated in place, and there are two of them.
  //
  // Returns false if the shape is not what it expects, and the caller does the
  // ordinary rebuild instead — correct, just costly to whatever was playing.
  function rebuildChromeAroundEmbed(snap) {
    const body = root.querySelector('.sample-player-body');
    const stageEl = root.querySelector('.sample-player-np') || root.querySelector('.sample-player-stage');
    if (!body || !stageEl || !embedHost || !stageEl.contains(embedHost)) return false;

    if (seekTeardown) { seekTeardown(); seekTeardown = null; }

    for (const el of [...root.children]) if (el !== body) el.remove();
    const head = curLayout !== 'compact' ? renderHead(snap) : renderCompactBadge(snap);
    if (head) root.insertBefore(head, body);
    root.insertBefore(renderTabs(snap), body);

    for (const el of [...body.children]) if (el !== stageEl) el.remove();
    if (snap.currentSource !== 'sp') body.appendChild(renderClips(snap));

    if (snap.failed.length > 0) root.appendChild(renderErrorBanner(snap));
    if (!snap.online) root.appendChild(renderOfflineNote());

    // The two things inside the stage that are about the artist rather than
    // about the embed.
    const meta = stageEl.querySelector('.sample-player-np-meta');
    if (meta) meta.innerHTML = npMetaHtml(snap);
    const btn = stageEl.querySelector('.sample-player-np-btn');
    if (btn) { btn.disabled = !snap.online; setPlayGlyph(btn, snap.play); }
    return true;
  }

  function rebuildChrome(snap, sourceChanged) {
    // Move, never remove: appendChild between two connected parents relocates
    // the node without it ever being out of the document.
    const preserved = !sourceChanged && embedHost ? embedHost : null;
    if (preserved) embedPark().appendChild(preserved);

    // The old seek row is about to be discarded; if a finger is still down on
    // it, its window listeners would outlive the element they were painting.
    if (seekTeardown) { seekTeardown(); seekTeardown = null; }
    // A rebuild drops the class with the old DOM; re-assert it from the flag
    // below so a chrome rebuild mid-playback does not silently stop the eq.
    // fromEmbed:false — this is bookkeeping, not the embed telling us anything,
    // and reconciling from it would withdraw the play intent on every rebuild.
    setPlaying(false, false);
    if (sourceChanged) { seekTarget = null; lastSeekFrac = 0; }

    root.innerHTML = '';

    if (curLayout !== 'compact') {
      root.appendChild(renderHead(snap));
    } else {
      // null when there is nothing to report — an empty row still costs its
      // margin, and this one sits directly above the stage.
      const badge = renderCompactBadge(snap);
      if (badge) root.appendChild(badge);
    }

    root.appendChild(renderTabs(snap));

    const body = document.createElement('div');
    body.className = 'sample-player-body';
    if (curLayout === 'desktop' && (snap.currentSource === 'yt' || snap.currentSource === 'sc')) body.classList.add('is-split');

    // Spotify draws its REAL embed on every surface, deck card included. The
    // 82x46 now-playing row works for a source we drive ourselves (a video
    // thumbnail, a waveform we scrub) but Spotify's iframe IS the control
    // surface — squeezed into a thumbnail it became a black box behind an
    // orange button of ours, which is strictly less than the artist page shows
    // for the same artist. Same embed, same format, every layout
    // (device feedback, 2026-08-04).
    // NOBODY keeps the 82x46 thumb now. Spotify escaped it on 2026-08-04
    // because its iframe IS the control surface; SoundCloud's is too, and it
    // was still paying the thumb's price — at 82x46 the widget has room for
    // nothing but its own "Privacy policy" link, so the deck showed a grey box
    // with a legal notice where the artwork should be (reported 2026-08-06).
    // On the full stage the same widget draws artwork, title and its own
    // clickable waveform, which is the artist page's treatment and the reason
    // that surface reads better. --disc-stage-sc-h (166px) already sized this;
    // nothing new is invented here, the height was waiting for a caller.
    const stageWrap = buildFullStage(snap);
    body.appendChild(stageWrap);
    // Compact can't fit usable native chrome (YT at 82x46) and SC compact has
    // no visible widget at all — a full-width seek row is the scrubber there.
    // Full/desktop YT has native controls; full/desktop SC has the widget's
    // own clickable waveform; Spotify's embed is self-contained.
    // YouTube only: its native chrome is unusable at 82x46, which is what this
    // row is for. SoundCloud now brings its own waveform on the full stage, and
    // a second scrubber under the first is just noise.
    // Spotify draws no alternates block at all. Its embed already lists its own
    // top tracks, so a panel restating that — plus a preview caveat the chip on
    // the row already carries — was pure vertical cost on the surface with the
    // least room to spare. (Removed on device feedback, 2026-08-02.)
    if (snap.currentSource !== 'sp') body.appendChild(renderClips(snap));
    root.appendChild(body);

    if (snap.failed.length > 0) root.appendChild(renderErrorBanner(snap));
    if (!snap.online) root.appendChild(renderOfflineNote());

    if (preserved) {
      const target = embedContainer();
      if (target) {
        target.insertBefore(preserved, target.firstChild);
        const stage = root.querySelector('.sample-player-stage');
        if (stage) stage.dataset.state = 'ready';
      }
    }
  }

  // The mini player's scrubber: elapsed · draggable rail · duration.
  //
  // Redrawn 2026-08-01 from the design corrections. Two things changed and
  // both are load-bearing: the rail carries a VISIBLE handle (a bare hairline
  // reads as a progress readout, not a control), and the row is genuinely
  // DRAGGABLE, not tap-only. The design's line is that the front of a set
  // tells you nothing, so jumping into the middle is the primary way to
  // sample — which makes a tap-only scrubber a decorative bar with extra
  // steps. Position/time still arrive from the yt ticker or SC's
  // PLAY_PROGRESS via updateSeekRow().
  //
  // While a drag is live the fill/handle follow the FINGER, not the embed:
  // seekTo is async on both YT and the SC widget, so painting from the
  // adapter would drag the handle backwards under the user's own thumb.
  function buildSeekRow(snap) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'sample-player-seek';
    row.setAttribute('aria-label', 'Seek');
    row.disabled = !snap.online;
    row.innerHTML = '<span class="sample-player-seek-time" data-seek-cur>0:00</span>' +
      '<span class="sample-player-seek-rail" data-seek-rail>' +
        '<span class="sample-player-seek-track"></span>' +
        '<span class="sample-player-seek-fill" data-seek-fill style="width:0%"></span>' +
        '<span class="sample-player-seek-handle" data-seek-handle style="left:0%"></span>' +
      '</span>' +
      '<span class="sample-player-seek-dur" data-seek-dur>0:00</span>';

    const rail = row.querySelector('[data-seek-rail]');
    const fracAt = (clientX) => {
      const rect = rail.getBoundingClientRect();
      return seekFraction(clientX - rect.left, rect.width);
    };
    const commit = (frac) => {
      // Remember what we asked for. updateSeekRow refuses to paint the embed's
      // stale playhead until it has actually arrived here — see seekSettling.
      seekTarget = frac;
      seekTargetAt = Date.now();
      if (embedAdapter && embedAdapter.seekTo) embedAdapter.seekTo(frac);
    };

    // The drag listens on WINDOW, not on the row. setPointerCapture is
    // best-effort (it throws on some engines and is silently dropped by
    // others), and without it the moves retarget to whatever is under the
    // finger the instant it leaves the 26px rail — which is most of a real
    // drag. The row would then stop tracking mid-gesture and the handle would
    // stick: half of the "erratic scrubbing" reported on-device 2026-08-02.
    let dragId = null;
    const onMove = (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      e.preventDefault();
      const frac = fracAt(e.clientX);
      paintSeek(frac);
      commit(frac);
    };
    const onEnd = (e) => {
      if (dragId === null || e.pointerId !== dragId) return;
      if (e.type === 'pointerup') {
        // Paint AND commit: the rail has to end where the finger left it.
        // Without the paint it keeps whatever the last move drew, and while
        // the seek settles nothing else repaints it — so releasing after a
        // drag past the rail's edge left the handle parked at the clamp.
        const frac = fracAt(e.clientX);
        paintSeek(frac);
        commit(frac);
      }
      dragId = null;
      seekDragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    row.addEventListener('pointerdown', (e) => {
      if (row.disabled) return;
      // The deck card's swipe handler already skips anything inside a button,
      // but stop here anyway: this row is a horizontal drag living inside a
      // surface whose whole gesture vocabulary is horizontal drags, and one
      // stray listener upstream turns a scrub into a pass.
      e.stopPropagation();
      e.preventDefault();
      dragId = e.pointerId;
      seekDragging = true;
      try { row.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      const frac = fracAt(e.clientX);
      paintSeek(frac);
      commit(frac);
    });
    // Teardown can strand these if a drag is live when the source switches.
    seekTeardown = () => { if (dragId !== null) onEnd({ pointerId: dragId, type: 'pointercancel' }); };
    // Keyboard parity — the drag is a mouse/touch affordance, not the only one.
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = (e.key === 'ArrowRight' ? 1 : -1) * 0.02;
      const frac = Math.min(1, Math.max(0, lastSeekFrac + step));
      paintSeek(frac);
      commit(frac);
    });
    return row;
  }

  // Paints the rail to a 0..1 fraction. Split out so the drag can drive it
  // directly, without waiting for the embed's next progress frame.
  function paintSeek(frac) {
    lastSeekFrac = Math.min(1, Math.max(0, frac));
    const pct = `${lastSeekFrac * 100}%`;
    const fill = root.querySelector('[data-seek-fill]');
    if (fill) fill.style.width = pct;
    const handle = root.querySelector('[data-seek-handle]');
    if (handle) handle.style.left = pct;
  }

  // True while a seek has been requested but the embed still reports the old
  // playhead. seekTo is async on BOTH backends (YT resolves on its own clock;
  // the SC widget round-trips through postMessage), and the yt ticker runs
  // every 500ms — so without this the handle snaps back to where the track
  // was, then jumps forward when the seek lands. That visible bounce was the
  // other half of the erratic scrubbing reported on-device 2026-08-02.
  // Bounded by time as well as convergence: if a seek is refused outright
  // (an ad roll, a dead embed) the row must start following the real playhead
  // again rather than lying about a position it never reached.
  function seekSettling(cur, dur) {
    if (seekTarget === null) return false;
    if (Date.now() - seekTargetAt > SEEK_SETTLE_MS) { seekTarget = null; return false; }
    if (dur > 0 && Math.abs(cur / dur - seekTarget) < SEEK_SETTLE_EPS) { seekTarget = null; return false; }
    return true;
  }

  // The equaliser beside the current set is a claim that sound is coming out.
  // It used to render off `.is-current` alone, so it danced on a mounted-paused
  // player before anyone pressed anything (reported 2026-08-02). Only the
  // embed's own play/pause events move it now — asking a player to start is
  // not the same as it having started.
  // The ONE place root's className is written. Resetting it to base + layout is
  // the point, but the STATE classes have to come back with it. `is-offline`
  // was already re-asserted by hand at the call sites; `is-playing` was not,
  // and it could never recover on its own — setPlaying() early-returns when
  // playingNow is unchanged, so once the class was dropped mid-playback nothing
  // ever put it back. Measured in the desktop pane 2026-08-06: after a pick the
  // video was demonstrably still running (frames advancing four seconds apart)
  // while the equaliser sat dark. That is the honest-icon rule broken from the
  // other direction — the UI claiming silence over sound.
  function setLayoutClass() {
    root.className = 'sample-player sample-player--' + curLayout;
    if (playingNow) root.classList.add('is-playing');
  }

  // `fromEmbed` false means WE are resetting the flag as part of a re-render,
  // not the embed reporting. That distinction is load-bearing: rebuildChrome
  // clears the flag on every chrome rebuild, and reconciling from that would
  // withdraw a live play intent for no reason.
  function setPlaying(on, fromEmbed = true) {
    if (playingNow === on) return;
    playingNow = on;
    if (root) root.classList.toggle('is-playing', on);
    if (!fromEmbed) return;
    // EVERY source is now driven by its own embed's transport — the deck draws
    // no play control of its own since all three moved to the full stage. So
    // the state machine can only learn what is happening by being told.
    //
    // This is not cosmetic. `soundIntent` in deck.js follows snap.play, and it
    // is what asks the NEXT artist to keep playing — so without it the one
    // carry that works on iOS (YouTube) would never be requested.
    //
    // UPWARD ONLY, and that restriction is the whole lesson. Reconciling a
    // report of "not playing" looked symmetrical and broke the carry outright
    // (device report, 2026-08-06): YouTube fires ENDED/PAUSED transiently while
    // loadVideoById swaps the video, so an advance produced setPlaying(false) ->
    // togglePlay -> snap.play false -> reconcileEmbed -> pause() ON THE VIDEO
    // THAT WAS STILL LOADING. Black frame, no autoplay, and soundIntent now
    // false so the NEXT advance called cueVideoById instead of loadVideoById —
    // a poster, silent, for every artist after.
    //
    // Losing the downward direction costs nothing here: no source draws a glyph
    // of ours any more, so there is no icon left to tell a lie, and a genuine
    // refusal is already the watchdog's job — which withdraws the ICON without
    // ever withdrawing the intent, for exactly this reason.
    if (on && lastSnap && !lastSnap.collapsed && !lastSnap.play) {
      applyState(core.togglePlay(), { fromEmbed: true });
    }
  }

  function updateSeekRow(cur, dur) {
    // A PLAY event is a claim; a playhead that has MOVED is evidence. iOS
    // refuses the SoundCloud widget by firing PLAY and then sitting at zero
    // (measured, probe step 1), which is exactly how a watchdog keyed on the
    // event got itself stood down over silence. This is keyed on the clock.
    if (Number.isFinite(cur) && cur >= 0) {
      if (playWatchdog && watchdogBase !== null && cur > watchdogBase + 0.15) {
        clearPlayWatchdog();
        setPlaying(true);
      }
      lastKnownPos = cur;
    }
    // A live drag owns the position outright; a settling seek owns it until
    // the embed catches up. Only then does the playhead drive the rail.
    if (!seekDragging && !seekSettling(cur, dur) && dur > 0) paintSeek(cur / dur);
    const curEl = root.querySelector('[data-seek-cur]');
    const durEl = root.querySelector('[data-seek-dur]');
    // The clock follows the rail, not the embed, while either of those holds —
    // a handle at 40:00 over a readout saying 12:04 reads as a broken player.
    const shown = (seekDragging || seekTarget !== null) && dur > 0 ? lastSeekFrac * dur : cur;
    if (curEl) curEl.textContent = fmtTime(shown);
    if (durEl) durEl.textContent = fmtTime(dur);
  }

  function renderHead(snap) {
    const head = document.createElement('div');
    head.className = 'sample-player-head';
    if (showHeader) {
      head.innerHTML = `<h2 class="sample-player-head-name">${esc(curArtist?.name || '')}</h2>` +
        (genresLine ? `<div class="sample-player-head-genres">${esc(genresLine)}</div>` : '');
    }
    if (!snap.online) {
      const status = document.createElement('span');
      status.className = 'sample-player-status';
      status.innerHTML = '<span class="sample-player-status-dot"></span>offline';
      head.appendChild(status);
    }
    return head;
  }

  // Offline, and nothing else. This row used to carry a "Sample" label plus
  // one of two honesty chips — "30-sec preview" on Spotify, "plays in full ·
  // no account" everywhere else — and on a phone all three were paying rent in
  // the scarcest space in the app (device feedback, 2026-08-04). "Sample" only
  // restated the surface you were already on. The Spotify chip is a claim the
  // embed makes for itself the moment it draws Spotify's own transport, and
  // the SoundCloud per-track "30-sec preview" badges stay, so the one case
  // where preview-vs-full is a real question is still answered where the
  // choice is actually made. Returns null when there is nothing to say, and
  // the caller then spends no vertical space at all.
  function renderCompactBadge(snap) {
    if (snap.online) return null;
    const badge = document.createElement('div');
    badge.className = 'sample-player-head';
    badge.innerHTML = '<span class="sample-player-status"><span class="sample-player-status-dot"></span>offline</span>';
    return badge;
  }

  function renderTabs(snap) {
    const wrap = document.createElement('div');
    wrap.className = 'sample-player-tabs';
    wrap.setAttribute('role', 'tablist');
    for (const tab of core.getTabs()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sample-player-tab' + (tab.current ? ' is-current' : '') + (tab.failed ? ' is-failed' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tab.current));
      btn.disabled = !snap.online;
      btn.innerHTML = `<span class="sample-player-tab-dot" style="background:${tab.color}"></span>${esc(tab.label)}`;
      btn.addEventListener('click', () => {
        if (tab.failed) return; // struck tabs only come back via the Retry link, not a re-tap
        applyState(core.setSource(tab.key));
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  // Where the live <iframe> hangs. Compact uses the 82x46 thumbnail for the
  // sources we drive ourselves; every other case — full, desktop, and Spotify
  // on ANY layout — hangs it in the fixed-shape stage. Asking the DOM which
  // one got built keeps this from having to re-derive that rule.
  function embedContainer() {
    return root.querySelector('.sample-player-np-thumb') || root.querySelector('.sample-player-stage');
  }

  // ---- full / desktop stage: real fixed-shape embed, custom overlay for YT (empty placeholder — mountEmbed/rebuildChrome fill it) ----
  function buildFullStage(snap) {
    const stage = document.createElement('div');
    stage.className = 'sample-player-stage';
    stage.dataset.shape = snap.currentSource;
    stage.dataset.state = 'mounting';
    return stage;
  }

  // NO transport row of ours for Spotify, and none for SoundCloud either. One
  // shipped on 2026-08-06 on the strength of probe step 6 (a tap on our own
  // control DOES start Spotify after a load, where SoundCloud's gate refuses
  // one). The measurement stands; the control did not. Spotify's stage is
  // --disc-stage-sp-h (352px), so on a deck card the row landed past the
  // card's own overflow — clipped, not merely below the fold, verified in the
  // Simulator. And once SoundCloud moved to its full widget the same day, the
  // rule that was already written for Spotify covered all three: an embed that
  // draws its own transport IS the control surface, and we only draw one where
  // the native chrome is unusable — YouTube at 82x46, and nowhere else.
  //
  // What that work was actually worth is the playback_update listener in
  // buildSpotify: without it the app was deaf to this source and the watchdog
  // would pause a healthy embed 2500ms after any request. That stays.

  // ---- compact: 82x46 now-playing row (empty placeholder — mountEmbed/rebuildChrome fill it).
  // YouTube and SoundCloud only: Spotify takes the full stage on every layout,
  // so nothing here has an 'sp' branch any more. ----
  function buildCompactStage(snap) {
    const wrap = document.createElement('div');
    wrap.className = 'sample-player-np';

    const thumb = document.createElement('span');
    thumb.className = 'sample-player-np-thumb';
    wrap.appendChild(thumb);

    // BOTH driven sources get the round control now, and YouTube needed it more
    // than SoundCloud did. The rule here used to be "a video source never hides
    // behind our button" — which left YouTube in compact with no control of
    // OURS at all, relying on its native chrome inside an 82x46 frame that this
    // very file calls too small to be usable. On a phone that means: a poster
    // play button that does nothing, no glyph we can paint (patchClipAndPlay
    // looks for this element and found none, so the honest-icon watchdog had
    // nowhere to show), and playback reachable only by the seek row or a track
    // row — every symptom reported on 2026-08-04. Covering unusable controls
    // with a usable one is not hiding the video; scrubbing still lives in the
    // seek row directly beneath.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample-player-np-btn is-' + snap.currentSource;
    btn.disabled = !snap.online;
    setPlayGlyph(btn, snap.play);
    btn.addEventListener('click', () => applyState(core.togglePlay()));
    thumb.appendChild(btn);

    const meta = document.createElement('div');
    meta.className = 'sample-player-np-meta';
    meta.innerHTML = npMetaHtml(snap);
    wrap.appendChild(meta);
    return wrap;
  }

  // (The old controls:0 YT overlay — fake progress bar, no seeking — is gone;
  // YouTube's native chrome is the full/desktop scrubber now.)

  function renderClips(snap) {
    const box = document.createElement('div');
    box.className = 'sample-player-clips';
    const isYt = snap.currentSource === 'yt';
    const label = isYt ? 'Live sets' : 'Tracks';
    const head = document.createElement('div');
    head.className = 'sample-player-clips-head';
    // No hint text. "tap to switch set" narrated a list — people know what a
    // list of numbered rows does — and "live from their profile" answered a
    // question nobody was asking. YouTube spends the reclaimed slot on
    // something that does work: a way out to the real app, where the video can
    // go fullscreen, queue, and cast. On a phone this URL opens the YouTube
    // app itself rather than the browser.
    head.innerHTML = `<span>${esc(label)}</span>`;
    if (isYt) {
      const item = snap.alternates[snap.clipIndex];
      if (item && item.id) {
        const out = document.createElement('a');
        out.className = 'sample-player-clips-out';
        out.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(item.id);
        out.target = '_blank';
        out.rel = 'noopener';
        out.textContent = 'Open in YouTube ↗';
        head.appendChild(out);
      }
    }
    box.appendChild(head);

    const rows = document.createElement('div');
    rows.className = 'sample-player-cliprow';
    const maxRows = curLayout === 'compact' ? 3 : 6;
    const items = snap.alternates.slice(0, maxRows);
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isCur = i === snap.clipIndex;
      const loading = !item.label;
      btn.className = 'sample-player-clip' + (isCur ? ' is-current' : '');
      btn.disabled = loading || !snap.online;
      btn.innerHTML = `<span class="sample-player-clip-n">${i + 1}</span>` +
        `<span class="sample-player-clip-t">${esc(item.label || '(loading…)')}</span>` +
        (item.preview ? '<span class="sample-player-clip-preview">30-sec preview</span>' : '') +
        `<span class="sample-player-clip-eq"><i></i><i></i><i></i></span>`;
      btn.addEventListener('click', () => applyState(core.setClip(i)));
      rows.appendChild(btn);
    });
    box.appendChild(rows);

    // The attribution line names what is playing — which is worth a row only
    // when you cannot already see it. The rows above are capped at maxRows, so
    // the widget can be parked on a track that is off the end of the list (its
    // own auto-advance does this); THAT is when this line is the only place
    // the track name appears. When the current track is one of the rows on
    // screen, highlighted, the line just says it again (device feedback,
    // 2026-08-04) and is skipped.
    if (!isYt) {
      const item = snap.alternates[snap.clipIndex];
      const listed = snap.clipIndex >= 0 && snap.clipIndex < items.length;
      if (item && item.label && !listed) {
        const attr = document.createElement('div');
        attr.className = 'sample-player-attr';
        const slug = curSources?.soundcloudSlug;
        attr.innerHTML = slug
          ? `${esc(item.label)} — <a href="https://soundcloud.com/${esc(slug)}" target="_blank" rel="noopener">${esc(curArtist?.name || slug)} · SoundCloud</a>`
          : `${esc(item.label)} — ${esc(curArtist?.name || '')}`;
        box.appendChild(attr);
      }
    }
    return box;
  }

  function renderErrorBanner(snap) {
    const box = document.createElement('div');
    box.className = 'sample-player-error';
    const failedKey = snap.failed[snap.failed.length - 1];
    const failedLabel = SOURCE_META[failedKey]?.label || failedKey;
    const curLabel = snap.currentSource ? SOURCE_META[snap.currentSource].label : 'nothing';
    box.textContent = `That set wouldn't load — we fell through to ${curLabel}. `;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'sample-player-retry';
    retry.textContent = `Retry ${failedLabel}`;
    retry.addEventListener('click', () => applyState(core.retry(failedKey)));
    box.appendChild(retry);
    return box;
  }

  function renderOfflineNote() {
    const row = document.createElement('div');
    row.className = 'sample-player-offline-row';
    row.innerHTML = '<span class="sample-player-offline-btn">▶</span>' +
      '<span class="sample-player-offline-note">Sampling resumes when you’re back</span>';
    return row;
  }

  function renderCollapsed() {
    if (root.firstElementChild?.className === 'sample-player-collapse') return; // already showing it
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'sample-player-collapse';
    box.innerHTML = '<div class="sample-player-collapse-title">Nothing to sample yet</div>' +
      '<div class="sample-player-collapse-sub">No source resolved for this artist. Picking is unaffected.</div>';
    root.appendChild(box);
  }

  // -------------------------------------------------------------------------
  // Embed lifecycle. mountEmbed always tears down whatever embed currently
  // exists first (across all three types) — this IS the "one player, always"
  // rule at the DOM/SDK layer; player-core.js only decides WHICH source.
  // Only called when sourceChanged — rebuildChrome has already built an
  // empty stage/np-thumb placeholder for us to fill.
  // -------------------------------------------------------------------------
  function mountEmbed(src, snap) {
    lastKnownPos = 0; // a fresh embed starts its clock over; so does what we compare against
    teardownEmbed();
    embedHost = document.createElement('div');
    embedHost.className = 'sample-player-stage-embed';

    const container = embedContainer();
    if (container) container.insertBefore(embedHost, container.firstChild);

    // "Player tabs — crossfade between the panes (fast)." The stage is faded
    // out while the new embed attaches and back in when it reports ready, so
    // the swap doesn't flash a black box. The tab's own fill already says
    // which source is current, so a skipped fade changes nothing — hence
    // clearing the flag from setReady AND from a timeout: a source that never
    // reports ready must not leave the stage invisible.
    const stageEl = root.querySelector('.sample-player-stage');
    if (stageEl) {
      stageEl.dataset.swapping = '1';
      setTimeout(() => { delete stageEl.dataset.swapping; }, 600);
    }

    const setReady = () => {
      const stage = root.querySelector('.sample-player-stage');
      if (stage) { stage.dataset.state = 'ready'; delete stage.dataset.swapping; }
    };
    const onError = () => applyState(core.markFailed(src));
    // Returns the resulting snapshot: buildSoundCloud needs to know which row
    // ended up current so it can park the widget on that exact track.
    const onSounds = ({ items, initialIndex }) => {
      const updated = core.setAlternates('sc', items, initialIndex);
      lastSnap = updated;
      if (updated.currentSource === 'sc') {
        const oldClips = root.querySelector('.sample-player-clips');
        if (oldClips) oldClips.replaceWith(renderClips(updated));
        const meta = root.querySelector('.sample-player-np-meta');
        if (meta) meta.innerHTML = npMetaHtml(updated);
      }
      notify(updated);
      return updated;
    };
    // The profile settled and not one track on it is streamable for an
    // anonymous listener — rows for them would all be dead controls. Same
    // treatment as an embed error: strike the tab, fall through to the next
    // source. Only ever called once the list has stopped growing (or the poll
    // budget is spent), never off a first partial fetch.
    const onNothingPlayable = () => applyState(core.markFailed('sc'));
    // The widget auto-advanced (or moved on its own): state follows reality,
    // and we must NOT drive the embed back (reconcileEmbed would loop) — so
    // this bypasses applyState on purpose.
    const onTrackSync = (index) => {
      const synced = core.syncClipIndex('sc', index);
      if (synced.clipIndex === lastSnap.clipIndex) return;
      lastSnap = synced;
      const oldClips = root.querySelector('.sample-player-clips');
      if (oldClips) oldClips.replaceWith(renderClips(synced));
      const meta = root.querySelector('.sample-player-np-meta');
      if (meta) meta.innerHTML = npMetaHtml(synced);
      notify(synced);
    };

    if (src === 'yt') embedAdapter = buildYouTube(embedHost, curSources, snap, { setReady, onError });
    else if (src === 'sc') embedAdapter = buildSoundCloud(embedHost, curSources, snap, { setReady, onError, onSounds, onTrackSync, onNothingPlayable });
    else if (src === 'sp') embedAdapter = buildSpotify(embedHost, curSources, snap, { setReady, onError });
  }

  function teardownEmbed() {
    stopYtTicker();
    if (embedAdapter) {
      try { embedAdapter.destroy(); } catch { /* best-effort teardown */ }
      embedAdapter = null;
    }
    if (embedHost) {
      if (embedHost.parentNode) embedHost.parentNode.removeChild(embedHost);
      embedHost = null;
    }
  }

  // ---- YouTube: keyless IFrame player. No origin/host pin on playerVars —
  // the embed must work unmodified on localhost, a LAN IP, and the deployed
  // domain (build spec section 6 / harness 03 comment). ----
  function buildYouTube(container, srcData, snap, { setReady, onError }) {
    const node = document.createElement('div');
    container.appendChild(node);
    const first = snap.alternates[snap.clipIndex] || snap.alternates[0];
    let player = null;
    let torn = false;

    loadYouTubeApi().then((YT) => {
      if (torn || !first) return;
      player = new YT.Player(node, {
        width: '100%',
        height: '100%',
        videoId: first.id,
        host: 'https://www.youtube.com', // the YT JS API server — NOT a same-origin pin (playerVars.origin is intentionally omitted)
        playerVars: {
          playsinline: 1,
          rel: 0,
          autoplay: snap.play ? 1 : 0,
          // Native chrome everywhere: the stage never lies, and YouTube's own
          // scrubber/fullscreen beats a drawn overlay (the old controls:0 +
          // decorative bar shipped with NO way to seek — reported in testing).
          // Compact's 82x46 frame is too small for that chrome to be usable,
          // which is what the seek row under the card row is for.
          controls: 1,
        },
        events: {
          onReady: () => { setReady(); if (snap.play) startYtTicker(player); },
          onStateChange: (e) => {
            if (e.data === 1) { startYtTicker(player); setPlaying(true); }
            if (e.data === 2 || e.data === 0) { stopYtTicker(); setPlaying(false); }
          },
          // 101/150/153 = uploader disabled embedding, 100 = removed, 2 = bad id
          onError: () => onError(),
        },
      });
    });

    return {
      destroy: () => { torn = true; stopYtTicker(); if (player && player.destroy) { try { player.destroy(); } catch { /* iframe may already be gone */ } } },
      play: () => player && player.playVideo && player.playVideo(),
      pause: () => player && player.pauseVideo && player.pauseVideo(),
      loadClip: (item) => player && player.loadVideoById && player.loadVideoById(item.id),
      // Same live player, different artist. This is what makes autoplay
      // possible on iOS at all: Safari refuses to start audio on an element
      // that has never been touched, and a brand-new iframe never has been —
      // but THIS one was unlocked by the tap that started the previous
      // artist, and the unlock survives a load. cue vs load is the whole
      // difference between honoring an intent and inventing one.
      loadArtist: (_srcData, snap, wantPlay) => {
        const first = snap.alternates[snap.clipIndex] || snap.alternates[0];
        if (!player || !first) return false;
        if (wantPlay && player.loadVideoById) { player.loadVideoById(first.id); return true; }
        if (player.cueVideoById) { player.cueVideoById(first.id); return true; }
        return false;
      },
      seekTo: (frac) => {
        if (!player || !player.getDuration) return;
        const dur = player.getDuration();
        if (dur > 0) player.seekTo(dur * frac, true);
      },
    };
  }

  function startYtTicker(player) {
    stopYtTicker();
    ytTicker = setInterval(() => {
      try {
        const dur = player.getDuration ? player.getDuration() : 0;
        const cur = player.getCurrentTime ? player.getCurrentTime() : 0;
        // updateSeekRow owns the rail, and it is the one that knows to stand
        // down while a finger is dragging it.
        updateSeekRow(cur, dur);
      } catch { /* embed may be mid-teardown */ }
    }, 500);
  }
  function stopYtTicker() {
    if (ytTicker) { clearInterval(ytTicker); ytTicker = null; }
  }

  // ---- SoundCloud: Widget API. Public tracks stream in full, no session. ----
  //
  // Two things this has to get right, both measured against the profiles that
  // misbehaved on-device (live widget probe, 2026-08-04, soundcloud.com/
  // {snowstrippers,sofitukker,clairerosinkranz,rufusdusol}):
  //
  //  1. getSounds() returns a GROWING PREFIX of the profile — not a complete
  //     list with placeholder rows, as this file used to assume. Every entry it
  //     hands back already carries a title, and more entries keep arriving for
  //     seconds (rufusdusol: 18 sounds at READY, 56 at +1s, 146 at +6s). On a
  //     label profile that prefix is 100% ad-supported, so reading
  //     `allUnplayable` off the FIRST fetch struck the tab on all four of those
  //     artists about a second after playback appeared to start — the
  //     strikethrough-and-Retry-SoundCloud report. Nothing terminal may be
  //     decided until the list stops growing.
  //  2. The first streamable track is DEEP: widget index 9 / 28 / 34 / 54 on
  //     those four. The widget opens parked at index 0, so a press of play
  //     makes it walk forward through every ad-supported track in between
  //     (each PLAYs then PAUSEs at 0ms) before landing on one it can stream —
  //     the row our own list has been showing as #1 the whole time. We already
  //     know where it will end up, so we skip() it there as soon as the list
  //     resolves, before anyone presses anything. auto_play stays off in the
  //     URL for the same reason: it would start that walk at load.
  function buildSoundCloud(container, srcData, snap, { setReady, onError, onSounds, onTrackSync, onNothingPlayable }) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.scrolling = 'no';
    iframe.frameBorder = 'no';
    const profileUrl = (d) => 'https://soundcloud.com/' + encodeURIComponent(d?.soundcloudSlug || '');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(profileUrl(srcData)) +
      '&color=%23c084fc&auto_play=false&hide_related=true&show_comments=false&show_user=true&visual=false';
    container.appendChild(iframe);

    let widget = null;
    let torn = false;

    let scDurMs = 0;
    let lastKnownItems = [];
    let wantPlay = !!snap.play; // play/pause INTENT, honored the moment we're parked
    let parked = false;         // the widget sits on a track we know it can stream
    let polls = 0;
    let lastTotal = -1;
    let unchangedRuns = 0; // consecutive polls that saw the same list length
    let pollTimer = null;

    loadSoundCloudApi().then((SC) => {
      if (torn) return;
      widget = SC.Widget(iframe);
      const E = SC.Widget.Events;
      widget.bind(E.READY, () => {
        setReady();
        fetchSounds();
      });
      // Whatever the widget actually plays is what our rows must show as
      // active — lying about the current track was the original reported bug.
      widget.bind(E.PLAY, () => {
        if (torn) return;
        // A PLAY event is not proof anyone asked for sound. parkOn() calls
        // skip() to move the widget onto the row we are already showing as
        // current, and skip() starts the widget by itself — on a phone the
        // browser then blocks the audio, so the widget sits there wearing a
        // PAUSE icon with nothing coming out, and the next tap only pauses
        // something that was never playing (device report, 2026-08-04: "the
        // pause icon shows but the track is not playing"). Racing it with a
        // pause() call after skip() is not enough; this is the check that
        // holds, because it runs on every PLAY the widget can emit.
        // ...but once we are PARKED, every skip() of ours has already landed,
        // so a PLAY we did not ask for is the person pressing SoundCloud's own
        // control. Adopt it. Before 2026-08-06 this branch could not tell the
        // two apart and did not need to: SoundCloud wore our round play button,
        // so a human press always arrived through adapter.play() with wantPlay
        // already true. Moving SC to its full widget took that button away and
        // left this guard swallowing genuine taps — press play, the widget
        // starts, we pause it inside the same tick, nothing comes out. Picking
        // a track row still worked, because loadClip() sets wantPlay itself,
        // which is exactly the shape of the bug reported on the device.
        if (!wantPlay && parked) {
          wantPlay = true;
        } else if (!wantPlay) {
          try { widget.pause(); } catch { /* widget may be mid-teardown */ }
          setPlaying(false);
          return;
        }
        widget.getCurrentSound((s) => {
          if (torn || !s) return;
          // It wandered onto a track we already know it cannot stream: its own
          // auto-advance off the end of a set, or a press on the widget's
          // native controls before our skip landed. Jump to the next row we
          // know plays rather than let it grind the gap one dead track at a
          // time — which is the whole point of knowing the list.
          if (isUnplayableSound(s)) { jumpPastUnplayable(s); return; }
          setPlaying(true);
          scDurMs = s.duration || 0;
          if (onTrackSync && lastKnownItems.length) {
            const i = lastKnownItems.findIndex((it) => it.id === s.permalink_url);
            if (i >= 0) onTrackSync(i);
          }
        });
      });
      widget.bind(E.PLAY_PROGRESS, (e) => {
        if (torn || !e) return;
        updateSeekRow((e.currentPosition || 0) / 1000, scDurMs / 1000);
      });
      widget.bind(E.PAUSE, () => { if (!torn) setPlaying(false); });
      widget.bind(E.FINISH, () => { if (!torn) setPlaying(false); });
      widget.bind(E.ERROR, () => onError());
    });

    function schedulePoll() {
      if (torn || pollTimer) return;
      pollTimer = setTimeout(() => { pollTimer = null; fetchSounds(); }, SC_POLL_MS);
    }

    function fetchSounds() {
      if (!widget || torn) return;
      widget.getSounds((sounds) => {
        if (torn) return;
        const arr = Array.isArray(sounds) ? sounds.filter(Boolean) : [];
        const mapped = mapSoundcloudSounds(arr);
        lastKnownItems = mapped.items;
        const updated = onSounds(mapped);
        polls += 1;
        unchangedRuns = arr.length === lastTotal ? unchangedRuns + 1 : 0;
        lastTotal = arr.length;
        const settled = unchangedRuns >= SC_STABLE_POLLS; // done filling, not merely between bursts

        if (!parked && mapped.items.some((i) => i.label)) parkOn(arr, updated);
        if (parked) {
          // Already playable; keep polling only while the panel can still gain
          // rows, then stop — nothing after this changes what plays.
          if (!settled && polls < SC_MAX_POLLS) schedulePoll();
          return;
        }
        // Nothing streamable YET. That is only a verdict once the list has
        // settled (or we've waited out the budget); until then, keep looking.
        if (polls < SC_MAX_POLLS && !(settled && mapped.allUnplayable)) { schedulePoll(); return; }
        onNothingPlayable();
      });
    }

    // Move the widget onto the row the UI is already showing as current, so the
    // first press of play starts THERE. skip() takes a WIDGET index and our
    // list is filtered, so the row's permalink is resolved against the widget's
    // own unfiltered array — the one we just fetched, no extra round trip.
    function parkOn(sounds, snapNow) {
      if (!widget || !snapNow || snapNow.currentSource !== 'sc') return;
      const item = snapNow.alternates[snapNow.clipIndex] || lastKnownItems.find((i) => i.label);
      if (!item || !item.label) return;
      const i = sounds.findIndex((s) => s.permalink_url === item.id);
      if (i < 0) return;
      parked = true;
      if (i > 0) widget.skip(i);
      // Tap-to-play is the rule everywhere: a player that has merely been
      // mounted must stay silent, and skip() can start the widget on its own.
      if (wantPlay) widget.play();
      else if (i > 0) widget.pause();
    }

    function jumpPastUnplayable(current) {
      if (!widget) return;
      widget.getSounds((sounds) => {
        if (torn) return;
        const arr = Array.isArray(sounds) ? sounds.filter(Boolean) : [];
        const at = arr.findIndex((s) => s.permalink_url === current.permalink_url);
        // Forward only — that is what makes this terminate.
        const next = arr.findIndex((s, i) => i > at && s.title && !isUnplayableSound(s));
        if (next >= 0) { parked = true; widget.skip(next); }
        else { widget.pause(); setPlaying(false); }
      });
    }

    return {
      destroy: () => {
        torn = true;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        try { widget && widget.pause && widget.pause(); } catch { /* widget may already be torn down */ }
      },
      // Deferred until parked: playing before we know where to start IS the
      // grind. The intent is remembered, so parkOn honors a press that landed
      // while the list was still resolving.
      play: () => { wantPlay = true; if (parked && widget && widget.play) widget.play(); },
      pause: () => { wantPlay = false; if (widget && widget.pause) widget.pause(); },
      loadClip: (item) => {
        if (!widget) return;
        wantPlay = true;
        widget.getSounds((sounds) => {
          const i = (sounds || []).findIndex((s) => s && s.permalink_url === item.id);
          if (i >= 0) { parked = true; widget.skip(i); widget.play(); }
        });
      },
      // NO loadArtist, deliberately — SoundCloud cannot carry playback across
      // artists on mobile web, and the absence of this method is what routes a
      // new artist back to a clean teardown-and-rebuild instead.
      //
      // Measured on an iPhone (design/ios-playback-probe step 4, 2026-08-04),
      // driving the raw widget with the app's exact sequence — load(), wait for
      // the callback, then play():
      //     SC load() callback — calling play() now
      //     SC PLAY event
      //     SC PAUSE event            <- at 0ms
      //     positions: [0 x13]        PLAY_PROGRESS fired at all? false
      // and the widget then draws SoundCloud's own "Play on SoundCloud /
      // Listen in browser" interstitial over itself. The gesture unlock does
      // not survive load(): it belongs to the loaded track, not to the iframe,
      // and SoundCloud re-gates the new one behind a tap of its own. That gate
      // is theirs, not iOS's, and nothing we can call gets past it — proven
      // both after a prior load and from a clean start.
      //
      // Carrying anyway would be worse than not carrying: it leaves a live
      // widget wearing an interstitial where a fresh one at least looks right
      // and takes one tap. YouTube DOES carry (same probe, step 3: same
      // iframe, playhead advancing), so that path keeps its loadArtist and
      // this one honestly does without.
      seekTo: (frac) => {
        if (!widget) return;
        widget.getDuration((d) => { if (d > 0) widget.seekTo(d * frac); });
      },
    };
  }

  // ---- Spotify: iframe-api. No alternates pane — its own embed lists top
  // tracks; we only ever mount the artist URI and show the honesty chip. ----
  //
  // height MUST be a NUMBER, and that is not a detail. Spotify picks which of
  // its two layouts to draw from the height it is HANDED, not from the box it
  // ends up in: given `'100%'` it falls back to the squat compact player and
  // draws it at ~150px, while the iframe still stretches to the full stage —
  // which is where the ~200px of dead space under the embed came from, on the
  // artist page as well as the deck (measured 2026-08-04, 352px stage). Given
  // the same 352 as a number it draws the full layout: artwork, artist, Follow,
  // transport AND the top-tracks list with durations, filling the stage. The
  // number is read off the stage the CSS already sized, so --disc-stage-sp-h
  // stays the one place the shape is decided.
  function buildSpotify(container, srcData, snap, { setReady, onError }) {
    const node = document.createElement('div');
    container.appendChild(node);
    let controller = null;
    let torn = false;
    let spDurSec = 0;
    // clientHeight of the STAGE, not of `container`: that is the content box
    // the CSS sized to --disc-stage-sp-h, which is the number the embed needs
    // to see. (The stage is content-box precisely so its hairlines can't shave
    // it under Spotify's 352 threshold — see assets/discovery.css.)
    const stage = container.closest('.sample-player-stage');
    const height = (stage || container).clientHeight || 352;

    loadSpotifyApi().then((api) => {
      if (torn) return;
      api.createController(node, { uri: 'spotify:artist:' + (srcData?.spotifyId || ''), width: '100%', height }, (c) => {
        if (torn) { try { c.destroy && c.destroy(); } catch { /* noop */ } return; }
        controller = c;
        setReady();
        c.addListener('ready', () => { if (snap.play && c.play) c.play(); });
        // The app was deaf to Spotify: no listener at all, so `playingNow` was
        // permanently false and `lastKnownPos` permanently 0. Two consequences,
        // both real. The equaliser could never light for this source, and the
        // honest-icon watchdog — which stands down only when it sees real
        // playback — would fire 2500ms after any request and PAUSE a Spotify
        // embed that was playing perfectly well.
        //
        // position/duration arrive in MILLISECONDS here; every other consumer
        // in this file works in seconds, so the conversion happens once, on the
        // way in. (Verified live in the iOS Simulator, 2026-08-06: the event
        // fires about once a second with a monotonic position.)
        c.addListener('playback_update', (e) => {
          const d = (e && e.data) || {};
          if (torn) return;
          setPlaying(!d.isPaused);
          spDurSec = (d.duration || 0) / 1000;
          updateSeekRow((d.position || 0) / 1000, spDurSec);
        });
        // Spotify's public iframe-api has no documented error event; a bad
        // or missing artist id renders an empty/broken embed rather than
        // firing something we can catch — unverified without a browser.
      });
    }).catch(() => onError());

    return {
      destroy: () => { torn = true; try { controller && controller.destroy && controller.destroy(); } catch { /* noop */ } },
      play: () => controller && controller.play && controller.play(),
      pause: () => controller && controller.pause && controller.pause(),
      // controller.seek takes SECONDS, unlike playback_update which reports
      // milliseconds. The scrubber hands out a fraction, so the duration it is
      // multiplied by has to be the one we already converted.
      seekTo: (frac) => {
        if (!controller || !controller.seek || !(spDurSec > 0)) return;
        controller.seek(spDurSec * frac);
      },
      // NO loadArtist, deliberately — the same absence, for the same reason, as
      // the SoundCloud adapter above. This one USED to be here, on the
      // reasoning that `loadUri` reuses the controller so "the iOS unlock rides
      // along exactly as it does for the other two". That was inference, and it
      // was wrong.
      //
      // Measured on an iPhone (design/ios-playback-probe, source=Spotify,
      // 2026-08-05), twice, on fresh pages with the preview nowhere near its
      // 27s end — so neither run is confounded by the item simply finishing:
      //
      //   STEP 3  loadUri, no play()      same iframe element? true
      //                                   same iframe src? false  <- NAVIGATED
      //                                   positions frozen  restarted=false
      //   STEP 4  loadUri + play()        positions frozen  climbed=false
      //           play() again, delayed   positions frozen  climbed=false
      //
      // `loadUri` keeps the same <iframe> NODE but CHANGES ITS SRC. That is a
      // navigation, the new document has never been touched by a finger, and
      // the unlock does not transfer to it — so neither an immediate play() nor
      // a later one is honored. It is SoundCloud's failure by a different
      // route: SC re-gates behind its own interstitial, Spotify simply
      // navigates out from under the unlock.
      //
      // The trap this cost two device sessions to find: when step 3 fires
      // quickly after step 2, the OLD document keeps making sound for several
      // seconds after the navigation, and its playhead keeps climbing. A probe
      // that judged on movement alone read that as a successful carry. It is
      // not — the incoming artist never started. Judge a carry on the playhead
      // RESTARTING, never on it merely moving.
      //
      // Without this method remountFor's canCarry is false, Spotify takes the
      // teardown-and-rebuild path, and each artist opens silent on its own
      // transport — which is honest, and is one tap.
    };
  }

  // -------------------------------------------------------------------------
  // handoverTo — moves the LIVE embed between hosts/layouts without
  // restarting. Reuses rebuildChrome's "preserve embedHost" path (same
  // detach-before-wipe, reattach-at-the-end, single-synchronous-call
  // discipline) — the only difference from an ordinary re-render is that
  // `root` itself also moves to a new parent host first. UNVERIFIED without
  // a real browser — exercise it manually via design/player-harness.html.
  // -------------------------------------------------------------------------
  function handoverTo(newHost, newLayout) {
    if (destroyed || !newHost) return false;
    curHost = newHost;
    if (newLayout) curLayout = newLayout;
    setLayoutClass();
    newHost.appendChild(root); // appendChild of an already-connected node is a MOVE, not remove+reinsert
    if (lastSnap && !lastSnap.collapsed) rebuildChrome(lastSnap, false);
    else if (lastSnap) renderCollapsed();
    return true;
  }

  // ---- remountFor: a NEW ARTIST through the SAME LIVE EMBED ---------------
  // The reason this exists is iOS. Safari will not start audio on an element
  // that has never received a user gesture, and mountPlayer's ordinary path
  // builds a brand-new cross-origin iframe per artist — one that has never
  // been touched, arriving on a timer well outside the tap that caused it. So
  // "keep playing as I swipe" was not merely unimplemented, it was
  // unreachable: the play() call was refused every time.
  //
  // Keeping the embed alive keeps its unlock. When the artist we are moving to
  // resolves to the SAME source, the iframe stays, its adapter loads the new
  // artist into it, and playback continues because as far as Safari is
  // concerned this is still the element the person tapped. When the source
  // differs (or the adapter cannot load in place), there is nothing to
  // preserve and we fall back to the ordinary teardown-and-build — correct,
  // just silent until the next tap.
  //
  // Returns false when it could not do it in place, so the caller knows the
  // difference. UNVERIFIED off-device: no desktop browser enforces the policy
  // this is written for.
  function remountFor({ artist: nextArtist, sources: nextSources, autoplay: nextAutoplay = false, host: nextHost, layout: nextLayout } = {}) {
    if (destroyed || !root) return false;
    const prevSource = lastSnap && !lastSnap.collapsed ? lastSnap.currentSource : null;

    curArtist = nextArtist;
    curSources = nextSources || {};
    artistKey = nextArtist?.id || nextArtist?.name || 'unknown-artist';
    genresLine = Array.isArray(nextArtist?.genres) ? nextArtist.genres.join(' · ') : nextArtist?.genres || '';

    if (nextLayout) curLayout = nextLayout;
    setLayoutClass();
    // The root must never leave the document — Safari reloads a disconnected
    // iframe and the reload costs us the gesture unlock (see deck.js's park).
    // The caller builds its new card detached and inserts it at the end of the
    // render, so the host we are handed is usually NOT connected yet. Moving
    // into it now would disconnect the very thing we are protecting. Wait
    // instead: the root stays parked (connected) and the move happens in a
    // microtask, once the render that created this host has finished putting it
    // in the document. Both parents connected at both ends — never a detach.
    // Re-home now if we can, otherwise as soon as the caller's tree lands.
    // `settle` runs whatever must wait for the player to be back on screen.
    let settle = (fn) => fn();
    if (nextHost) {
      curHost = nextHost;
      // Already where it belongs: do NOTHING. appendChild onto the parent a
      // node is already in still removes it from the child list and re-inserts
      // it, and that is the exact operation the probe proved fatal — WebKit
      // re-creates the iframe's browsing context for it (step 5B). The deck's
      // in-place advance hands us the very host the player is sitting in, so
      // this branch is the common case, not an edge one.
      if (root.parentNode === nextHost) { /* nothing to move, and moving would cost the embed */ }
      else if (nextHost.isConnected) curHost.appendChild(root);
      else {
        const wanted = nextHost;
        settle = (fn) => queueMicrotask(() => {
          if (destroyed || !root || curHost !== wanted) return;
          if (wanted.isConnected) wanted.appendChild(root);
          fn();
        });
      }
    }

    // `let`, not `const`: the refusal path below re-points this at the snapshot
    // core returns after withdrawing a play we know cannot be granted.
    let snap = core.mount(artistKey, curSources, { autoplay: nextAutoplay });
    lastSnap = snap;
    root.classList.toggle('is-offline', !snap.online);

    if (snap.collapsed) {
      clearPlayWatchdog();
      teardownEmbed();
      renderCollapsed();
      notify(snap);
      return true;
    }

    const canCarry = !!prevSource && snap.currentSource === prevSource
      && embedAdapter && typeof embedAdapter.loadArtist === 'function';

    // A source that cannot carry cannot start without a fresh tap. That is
    // measured, not assumed: SoundCloud re-gates behind its own interstitial
    // and Spotify navigates the iframe out from under the unlock (probe steps
    // 3/4, 2026-08-05 and 2026-08-06). Painting a PAUSE glyph over that
    // silence is a claim we already know to be false at the moment we draw it,
    // and it costs the person their first tap: tapping pause calls togglePlay,
    // which withdraws a request that was never granted, so the track then
    // needs a second tap to start. The watchdog only corrects the glyph 2500ms
    // later, which is no help at all to anyone who taps straight away —
    // reported from the deck, 2026-08-06.
    //
    // So do not make the claim. The INTENT is not withdrawn: this reports as a
    // refusal, exactly as the watchdog does, so the deck keeps soundIntent and
    // the next artist still gets its try.
    let refusedUpFront = false;
    if (!canCarry && snap.play) {
      snap = core.togglePlay();
      lastSnap = snap;
      refusedUpFront = true;
    }

    if (canCarry) {
      // Around the embed if the shape allows; the ordinary rebuild otherwise,
      // which reparents and therefore costs the embed on iOS.
      if (!rebuildChromeAroundEmbed(snap)) rebuildChrome(snap, false);
      // Load AFTER the player is back on screen, never while it is parked. The
      // holder is a 1x1 transparent box, and asking a video to start inside one
      // is asking to be refused or instantly paused — which comes back as an
      // embed sitting on its poster, the exact "play icon showing but nothing
      // playing" reported on 2026-08-04. Being visible is part of being able
      // to play.
      settle(() => {
        if (destroyed || !embedAdapter || !embedAdapter.loadArtist) return;
        lastKnownPos = 0; // the incoming artist starts at zero, and so does the baseline
        const carried = embedAdapter.loadArtist(curSources, snap, !!nextAutoplay);
        if (!carried) { teardownEmbed(); mountEmbed(snap.currentSource, snap); }
        if (snap.play) armPlayWatchdog();
      });
    } else {
      rebuildChrome(snap, true);
      teardownEmbed();
      settle(() => { if (!destroyed) mountEmbed(snap.currentSource, snap); });
    }
    if (snap.play) armPlayWatchdog(); else clearPlayWatchdog();
    notify(snap, refusedUpFront ? { autoplayRefused: true } : undefined);
    return canCarry;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearPlayWatchdog();
    teardownEmbed();
    window.removeEventListener('online', onlineHandler);
    window.removeEventListener('offline', offlineHandler);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    // The park only ever holds an embed mid-rebuild; by here teardownEmbed has
    // taken the host, so anything left is an empty holder to sweep.
    const park = document.getElementById('sp-embed-park');
    if (park && park.parentNode) park.parentNode.removeChild(park);
  }

  return { init, destroy, handoverTo, remountFor, core };
}

export { PRIORITY, SOURCE_META };
