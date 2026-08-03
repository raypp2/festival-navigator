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

import { createPlayerCore, PRIORITY, SOURCE_META, mapSoundcloudSounds, seekFraction } from './player-core.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// How long the rail keeps showing the position we ASKED for before conceding
// the embed is not going to get there. Generous enough for a YouTube buffer
// on a festival LTE connection; short enough that a refused seek self-heals.
const SEEK_SETTLE_MS = 2500;
const SEEK_SETTLE_EPS = 0.01; // "arrived" = within 1% of the track

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
 * onStateChange — optional (snapshot) => void, called after every render.
 *
 * Returns { destroy, getState, handoverTo(newHost, newLayout) }.
 */
export function mountPlayer({ host, artist, sources, layout = 'full', showHeader = true, onStateChange } = {}) {
  if (!host) throw new Error('mountPlayer: host element is required');
  if (ACTIVE) ACTIVE.destroy(); // tear down the previous embed FIRST, always

  const instance = createInstance({ host, artist, sources, layout, showHeader, onStateChange });
  ACTIVE = instance;
  instance.init();

  return {
    destroy: () => {
      instance.destroy();
      if (ACTIVE === instance) ACTIVE = null;
    },
    getState: () => instance.core.getState(),
    handoverTo: (newHost, newLayout) => instance.handoverTo(newHost, newLayout),
  };
}

function createInstance({ host, artist, sources, layout, showHeader = true, onStateChange }) {
  const core = createPlayerCore({ storage: safeLocalStorage() });
  const artistKey = artist?.id || artist?.name || 'unknown-artist';
  const genresLine = Array.isArray(artist?.genres) ? artist.genres.join(' · ') : artist?.genres || '';

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

  function notify(snap) {
    if (typeof onStateChange === 'function') onStateChange(snap);
  }

  function onlineHandler() { applyState(core.setOnline(true)); }
  function offlineHandler() { applyState(core.setOnline(false)); }

  function init() {
    root = document.createElement('div');
    root.className = 'sample-player sample-player--' + curLayout;
    curHost.appendChild(root);

    core.setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);

    applyState(core.mount(artistKey, sources || {}));
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
  function applyState(snap) {
    if (destroyed) return;
    const prev = lastSnap;
    lastSnap = snap;
    root.classList.toggle('is-offline', !snap.online);

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
      reconcileEmbed(snap, prev);
    }
    notify(snap);
  }

  function reconcileEmbed(snap, prev) {
    if (!embedAdapter) return;
    if (snap.clipIndex !== prev.clipIndex) {
      const item = snap.alternates[snap.clipIndex];
      if (item && embedAdapter.loadClip) embedAdapter.loadClip(item);
    } else if (snap.play !== prev.play) {
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
    const title = snap.currentSource === 'sp' ? (artist?.name || '') : item?.label || 'Loading…';
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
  function rebuildChrome(snap, sourceChanged) {
    const preserved = !sourceChanged && embedHost ? embedHost : null;
    if (preserved && preserved.parentNode) preserved.parentNode.removeChild(preserved);

    // The old seek row is about to be discarded; if a finger is still down on
    // it, its window listeners would outlive the element they were painting.
    if (seekTeardown) { seekTeardown(); seekTeardown = null; }
    // A rebuild drops the class with the old DOM; re-assert it from the flag
    // below so a chrome rebuild mid-playback does not silently stop the eq.
    setPlaying(false);
    if (sourceChanged) { seekTarget = null; lastSeekFrac = 0; }

    root.innerHTML = '';

    if (curLayout !== 'compact') {
      root.appendChild(renderHead(snap));
    } else {
      root.appendChild(renderCompactBadge(snap));
    }

    root.appendChild(renderTabs(snap));

    const body = document.createElement('div');
    body.className = 'sample-player-body';
    if (curLayout === 'desktop' && (snap.currentSource === 'yt' || snap.currentSource === 'sc')) body.classList.add('is-split');

    const stageWrap = curLayout === 'compact' ? buildCompactStage(snap) : buildFullStage(snap);
    body.appendChild(stageWrap);
    // Compact can't fit usable native chrome (YT at 82x46) and SC compact has
    // no visible widget at all — a full-width seek row is the scrubber there.
    // Full/desktop YT has native controls; full/desktop SC has the widget's
    // own clickable waveform; Spotify's embed is self-contained.
    if (curLayout === 'compact' && (snap.currentSource === 'yt' || snap.currentSource === 'sc')) {
      body.appendChild(buildSeekRow(snap));
    }
    // Spotify draws no alternates block at all. Its embed already lists its own
    // top tracks, so a panel restating that — plus a preview caveat the chip on
    // the row already carries — was pure vertical cost on the surface with the
    // least room to spare. (Removed on device feedback, 2026-08-02.)
    if (snap.currentSource !== 'sp') body.appendChild(renderClips(snap));
    root.appendChild(body);

    if (snap.failed.length > 0) root.appendChild(renderErrorBanner(snap));
    if (!snap.online) root.appendChild(renderOfflineNote());

    if (preserved) {
      const target = curLayout === 'compact' ? root.querySelector('.sample-player-np-thumb') : root.querySelector('.sample-player-stage');
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
  function setPlaying(on) {
    if (playingNow === on) return;
    playingNow = on;
    if (root) root.classList.toggle('is-playing', on);
  }

  function updateSeekRow(cur, dur) {
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
      head.innerHTML = `<h2 class="sample-player-head-name">${esc(artist?.name || '')}</h2>` +
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

  function renderCompactBadge(snap) {
    const badge = document.createElement('div');
    badge.className = 'sample-player-head';
    // Spotify says nothing here: the green chip on the now-playing row already
    // carries "30-sec preview", and printing it twice ~150px apart was the
    // same wasted space as the block removed below (device feedback,
    // 2026-08-02). The other sources' status is not duplicated anywhere, so
    // it stays.
    const status = !snap.online
      ? '<span class="sample-player-status"><span class="sample-player-status-dot"></span>offline</span>'
      : snap.currentSource === 'sp'
        ? ''
        : '<span class="sample-player-status">plays in full · no account</span>';
    badge.innerHTML = `<span class="sample-player-label">Sample</span>${status}`;
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

  // ---- full / desktop stage: real fixed-shape embed, custom overlay for YT (empty placeholder — mountEmbed/rebuildChrome fill it) ----
  function buildFullStage(snap) {
    const stage = document.createElement('div');
    stage.className = 'sample-player-stage';
    stage.dataset.shape = snap.currentSource;
    stage.dataset.state = 'mounting';
    return stage;
  }

  // ---- compact: 82x46 now-playing row (empty placeholder — mountEmbed/rebuildChrome fill it) ----
  function buildCompactStage(snap) {
    const wrap = document.createElement('div');
    wrap.className = 'sample-player-np';

    const thumb = document.createElement('span');
    thumb.className = 'sample-player-np-thumb';
    wrap.appendChild(thumb);

    if (snap.currentSource !== 'yt') {
      // Audio-only sources: our own round play/pause — never hides a video,
      // and there's no picture to hide here in the first place.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sample-player-np-btn';
      btn.disabled = !snap.online;
      setPlayGlyph(btn, snap.play);
      btn.addEventListener('click', () => applyState(core.togglePlay()));
      thumb.appendChild(btn);
    }
    // yt: the tiny live iframe keeps its own native controls/progress bar —
    // per the design sheet, a video source never hides behind our button here.

    const meta = document.createElement('div');
    meta.className = 'sample-player-np-meta';
    meta.innerHTML = npMetaHtml(snap);
    wrap.appendChild(meta);

    if (snap.currentSource === 'sp') {
      const chip = document.createElement('span');
      chip.className = 'sample-player-sp-chip';
      chip.textContent = '30-sec preview';
      wrap.appendChild(chip);
    }
    return wrap;
  }

  // (The old controls:0 YT overlay — fake progress bar, no seeking — is gone;
  // YouTube's native chrome is the full/desktop scrubber now.)

  function renderClips(snap) {
    const box = document.createElement('div');
    box.className = 'sample-player-clips';
    const isYt = snap.currentSource === 'yt';
    const label = isYt ? 'Live sets' : 'Tracks';
    const hint = isYt ? 'tap to switch set' : 'live from their profile';
    const head = document.createElement('div');
    head.className = 'sample-player-clips-head';
    head.innerHTML = `<span>${label}</span><span class="sample-player-clips-hint">${esc(hint)}</span>`;
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

    if (!isYt) {
      const item = snap.alternates[snap.clipIndex];
      if (item && item.label) {
        const attr = document.createElement('div');
        attr.className = 'sample-player-attr';
        const slug = sources?.soundcloudSlug;
        attr.innerHTML = slug
          ? `${esc(item.label)} — <a href="https://soundcloud.com/${esc(slug)}" target="_blank" rel="noopener">${esc(artist?.name || slug)} · SoundCloud</a>`
          : `${esc(item.label)} — ${esc(artist?.name || '')}`;
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
    teardownEmbed();
    embedHost = document.createElement('div');
    embedHost.className = 'sample-player-stage-embed';

    const container = curLayout === 'compact' ? root.querySelector('.sample-player-np-thumb') : root.querySelector('.sample-player-stage');
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
    const onSounds = ({ items, initialIndex, allUnplayable }) => {
      if (allUnplayable) {
        // Every posted track is monetization-gated for anonymous listeners —
        // rows for them would all be dead. Same treatment as an embed error:
        // strike the tab, fall through to the next source.
        applyState(core.markFailed('sc'));
        return;
      }
      const updated = core.setAlternates('sc', items, initialIndex);
      lastSnap = updated;
      if (updated.currentSource === 'sc') {
        const oldClips = root.querySelector('.sample-player-clips');
        if (oldClips) oldClips.replaceWith(renderClips(updated));
      }
      notify(updated);
    };
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

    if (src === 'yt') embedAdapter = buildYouTube(embedHost, sources, snap, { setReady, onError });
    else if (src === 'sc') embedAdapter = buildSoundCloud(embedHost, sources, snap, { setReady, onError, onSounds, onTrackSync });
    else if (src === 'sp') embedAdapter = buildSpotify(embedHost, sources, snap, { setReady, onError });
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
  function buildSoundCloud(container, srcData, snap, { setReady, onError, onSounds }) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.scrolling = 'no';
    iframe.frameBorder = 'no';
    const url = 'https://soundcloud.com/' + encodeURIComponent(srcData?.soundcloudSlug || '');
    iframe.src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(url) +
      '&color=%23c084fc&auto_play=' + (snap.play ? 'true' : 'false') + '&hide_related=true&show_comments=false&show_user=true&visual=false';
    container.appendChild(iframe);

    let widget = null;
    let torn = false;

    let scDurMs = 0;
    let lastKnownItems = [];

    loadSoundCloudApi().then((SC) => {
      if (torn) return;
      widget = SC.Widget(iframe);
      const E = SC.Widget.Events;
      widget.bind(E.READY, () => {
        setReady();
        fetchSounds();
        // getSounds() lazy-loads track titles as the widget's own internal
        // list scrolls — we can't script that scroll (cross-origin iframe),
        // so best-effort re-poll a couple of times to pick up titles that
        // arrive shortly after READY. Documented limitation, not guaranteed.
        setTimeout(fetchSounds, 1000);
        setTimeout(fetchSounds, 3000);
      });
      // Whatever the widget actually plays is what our rows must show as
      // active — it auto-advances off monetization-gated tracks, and lying
      // about the current track was exactly the reported bug.
      widget.bind(E.PLAY, () => {
        if (torn) return;
        setPlaying(true);
        widget.getCurrentSound((s) => {
          if (torn || !s) return;
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

    function fetchSounds() {
      if (!widget || torn) return;
      widget.getSounds((sounds) => {
        if (torn) return;
        const mapped = mapSoundcloudSounds(sounds);
        lastKnownItems = mapped.items;
        onSounds(mapped);
      });
    }

    return {
      destroy: () => { torn = true; try { widget && widget.pause && widget.pause(); } catch { /* widget may already be torn down */ } },
      play: () => widget && widget.play && widget.play(),
      pause: () => widget && widget.pause && widget.pause(),
      loadClip: (item) => {
        if (!widget) return;
        // skip() takes a WIDGET index, and our list is filtered — resolve the
        // row's id against the widget's own unfiltered list every time.
        widget.getSounds((sounds) => {
          const i = (sounds || []).findIndex((s) => s && s.permalink_url === item.id);
          if (i >= 0) { widget.skip(i); widget.play(); }
        });
      },
      seekTo: (frac) => {
        if (!widget) return;
        widget.getDuration((d) => { if (d > 0) widget.seekTo(d * frac); });
      },
    };
  }

  // ---- Spotify: iframe-api. No alternates pane — its own embed lists top
  // tracks; we only ever mount the artist URI and show the honesty chip. ----
  function buildSpotify(container, srcData, snap, { setReady, onError }) {
    const node = document.createElement('div');
    container.appendChild(node);
    let controller = null;
    let torn = false;

    loadSpotifyApi().then((api) => {
      if (torn) return;
      api.createController(node, { uri: 'spotify:artist:' + (srcData?.spotifyId || ''), width: '100%', height: '100%' }, (c) => {
        if (torn) { try { c.destroy && c.destroy(); } catch { /* noop */ } return; }
        controller = c;
        setReady();
        c.addListener('ready', () => { if (snap.play && c.play) c.play(); });
        // Spotify's public iframe-api has no documented error event; a bad
        // or missing artist id renders an empty/broken embed rather than
        // firing something we can catch — unverified without a browser.
      });
    }).catch(() => onError());

    return {
      destroy: () => { torn = true; try { controller && controller.destroy && controller.destroy(); } catch { /* noop */ } },
      play: () => controller && controller.play && controller.play(),
      pause: () => controller && controller.pause && controller.pause(),
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
    root.className = 'sample-player sample-player--' + curLayout;
    newHost.appendChild(root); // appendChild of an already-connected node is a MOVE, not remove+reinsert
    if (lastSnap && !lastSnap.collapsed) rebuildChrome(lastSnap, false);
    else if (lastSnap) renderCollapsed();
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    teardownEmbed();
    window.removeEventListener('online', onlineHandler);
    window.removeEventListener('offline', offlineHandler);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
  }

  return { init, destroy, handoverTo, core };
}

export { PRIORITY, SOURCE_META };
