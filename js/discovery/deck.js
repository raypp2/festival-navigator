// Discover deck + filter sheet (Discovery M4, build spec section 7.2, frames
// 2a/2e/4d). Full-screen layer like the artist page (js/discovery/artist-page.js
// is the pattern this mirrors): a fixed overlay div, created/destroyed
// dynamically, router kind `discover` (idempotent open/close, exactly like
// `artist:`). The filter sheet is a bottom sheet OVER the deck, router kind
// `sheet:discover-filter`, built with the same sheetChrome/dialogize/
// closeSheet chrome every other sheet in the app uses (js/v3/notes.js).
//
// Session state (position within the pool, decided count) lives in module
// state and is per-open only — closing the deck and reopening it deals a
// fresh session. Filter state persists in localStorage, ONE key per
// festival (fp.discoverFilter.<fid>) — a VIEWER preference, never written to
// the shared crew doc (repo law).
//
// SECURITY RULE (mirrors wall.js / artist-page.js): every artist/reason
// string renders via textContent / createElement, never innerHTML.
//
// Callers pass ctx (app.js's shared view context: fid, meName, onNotesChange)
// and an `actions` object — same shape artist-page.js takes:
//   actions.applyLocalPick(artist, person, level) — REQUIRED; the local-doc
//     mirror for pending-only pick writes (js/v3/app.js).
//   actions.showUndoToast(message, onUndo) — optional; wraps the toast root.
//   actions.canonData — optional; a pre-loaded genre canon, for tests.
//   actions.mountPlayer — optional; injectable in place of player.js's
//     mountPlayer, so tests never touch third-party embed SDKs.
import * as state from '../state.js';
import * as model from '../v3/model.js';
import { router } from '../v3/router.js';
import { sheetChrome, dialogize, rememberOpener, closeSheet } from '../v3/notes.js';
import { loadGenreCanon, canonicalize } from './genres.js';
import { findSetInfo, formatSetLinePlain } from './setinfo.js';
import { mountPlayer as realMountPlayer } from './player.js';
import { applyFilters, activeFacetCount, availableGenres, availableDays, DEFAULT_FACETS } from './filter.js';
import { colorIndexOf } from '../v3/wall.js';
import { hslOf, strokeOf } from '../v3/palette.js';
import { auraBackground, whoCorner, nameColor, subColor } from '../v3/aura.js';
// openMyDay is loaded lazily (see buildDesktopHeader's My-day tab) rather than
// imported statically: my-day.js itself imports openDeck from THIS module, so
// a static import here would be a real circular edge. The codebase already
// steers around this exact cycle once (decide.js -> my-day.js goes through an
// injected actions.refreshMyDay callback rather than an import) — a lazy
// dynamic import is the same discipline without needing a new ctx/actions
// field from app.js, which is out of scope for this file.

const OVERLAY_ID = 'discover-deck-overlay';
const LS_FILTER_PREFIX = 'fp.discoverFilter.';

// Carried playback intent, for the length of ONE visit to Discover.
//
// The deck tears the player down and builds a new one on every artist, so
// without something outside the player nothing can remember that sound was
// wanted, and every swipe lands in silence. This is that something: false
// while nobody has asked for audio, true from the moment they press play or
// tap a track or a source tab, false again the moment they pause.
//
// It is deliberately an INTENT, not a play/pause mirror. Opening Discover is
// not a request for sound, so it starts false and the first artist is silent
// until asked. After that the rule reads the same in both directions: someone
// who is listening keeps listening as they swipe (they already told us), and
// someone who paused stays paused (they told us that too). Resets on close —
// the next visit starts silent, like the first one.
let soundIntent = false;
// Desktop three-pane (frame 5c) kicks in at the same 1200px breakpoint the
// artist page's own desktop layout (5b) uses. Unlike 5b — which is a pure CSS
// reflow of one identical DOM (grid-template-areas over .ap-body's children)
// — 5c is a genuinely different DOM shape (a persistent rail + ranked grid +
// sticky focus pane replaces the card-stack/session chrome entirely), so this
// is a real render branch, not a media query. A matchMedia listener re-renders
// on crossing the boundary; jsdom has no real matchMedia, so `forcedLayout`
// is the test-only escape hatch (renderDeckForTest forces 'mobile',
// renderDesktopForTest forces 'desktop') — mirrors how REDUCED_MOTION() below
// already guards a matchMedia call that jsdom doesn't implement.
const DESKTOP_MQ = '(min-width: 1200px)';

// ---- module state: one deck instance, ever ---------------------------------------
let playerHandle = null;

// Mount the sample player for an artist — carrying the LIVE embed over from
// the previous artist whenever the player can manage it.
//
// This is not an optimisation. iOS refuses to start audio on an element no
// finger has touched, and the ordinary mount builds a brand-new cross-origin
// iframe per artist, arriving on the advance timer rather than inside the tap
// — so "keep playing as I swipe" could not work at all, and every swipe left a
// Pause icon over silence. Reusing the embed keeps the unlock the person
// already granted, which is the only thing that makes the carried intent real
// on a phone. player.js's remountFor returns false when it could not carry
// (different source, or an adapter with nowhere to load into), and then this
// is exactly the mount it always was.
// Park the live player somewhere the coming wipe cannot reach — WITHOUT ever
// taking it out of the document.
//
// That distinction is the whole bug. Safari reloads an <iframe> that has been
// disconnected from the document, even briefly, and a reloaded YouTube embed
// loses its gesture unlock (taps do nothing), redraws its poster (a play button
// over the thumbnail that never starts) and desyncs from the API object we hold
// (loadVideoById goes nowhere). Every one of those was reported off the phone
// on 2026-08-04, and the file this parks for had already written the warning:
// "a mid-teardown removeChild followed by a later, separate re-insertion risks
// exactly that."
//
// So the root moves between two CONNECTED parents — the card it is leaving and
// this holder — which is an atomic move, not a removal. The holder lives on
// <body>, outside the overlay, so overlay.textContent = '' cannot touch it, and
// it stays rendered (offscreen, not display:none) because a hidden subtree is
// its own way of stopping media.
const PARK_ID = 'dd-player-park';
function playerPark() {
  let park = document.getElementById(PARK_ID);
  if (!park) {
    park = document.createElement('div');
    park.id = PARK_ID;
    park.setAttribute('aria-hidden', 'true');
    park.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;'
      + 'overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(park);
  }
  return park;
}
function parkPlayerRoot() {
  const el = document.querySelector('#' + OVERLAY_ID + ' .sample-player');
  if (el) playerPark().appendChild(el); // connected -> connected: a move, never a detach
}
function removePlayerPark() {
  const park = document.getElementById(PARK_ID);
  if (park && park.parentNode) park.parentNode.removeChild(park);
}

function mountOrCarry(actions, opts) {
  if (playerHandle && typeof playerHandle.remountFor === 'function') {
    try {
      playerHandle.remountFor(opts);
      return playerHandle;
    } catch {
      // A player that cannot re-point itself is not one to keep.
      try { playerHandle.destroy(); } catch { /* best-effort teardown */ }
      playerHandle = null;
    }
  }
  const mount = (actions && actions.mountPlayer) || realMountPlayer;
  return mount(opts);
}
let session = null;      // { pool, position, decided } — reset per open (or per filter commit); MOBILE only
let deckOpen = false;
let pendingOpenGen = 0;  // guards a stale async canon-load landing after a newer navigation
let forcedLayout = null; // test-only: 'mobile' | 'desktop' | null (real matchMedia governs)
let layoutMq = null;     // the live matchMedia handle while the deck is open
// Desktop-only: the right pane's current artist. `focusedSnapshot` is the last
// ranked entry we had for it — kept so the pane can stay put ("never yank the
// pane mid-thought") after a decision drops the artist out of a still-nonempty
// pool (e.g. picked while Show=Undecided), even though it no longer has a live
// pool entry to read reason/genre text from.
let focusedName = null;
let focusedSnapshot = null;
// DESKTOP session state. The desktop deck is a PASS THROUGH a set of artists,
// not a live query — the same thing `session` models on mobile, and it is here
// for the same two reasons. `desktopOrder` is the ranked pool frozen when the
// session starts, so deciding on one artist cannot reshuffle the cards under
// the cursor (a pick moves the taste signal, which re-ranks everyone else).
// Freezing it is also what lets a decided card STAY on screen, marked, instead
// of evaporating out of the Undecided filter the instant you act: "we don't
// remove it from consideration within the count when the user decides — there's
// value in them seeing what they covered" (2026-08-04). A facet edit is a
// genuinely different question, so it starts a new session.
let desktopOrder = null;       // Array<pool entry> | null — the frozen session order
let desktopFacetKey = null;    // the facets that order was built from
let desktopSettleTimer = null; // cancel fn: the hold/idle before the pane moves on
let desktopExitTimer = null;   // cancel fn: the exit animation -> next artist

function isDesktopLayout() {
  if (forcedLayout) return forcedLayout === 'desktop';
  try { return !!(window.matchMedia && window.matchMedia(DESKTOP_MQ).matches); }
  catch { return false; } // jsdom / no matchMedia support
}

function watchLayout(ctx, actions) {
  try {
    layoutMq = window.matchMedia(DESKTOP_MQ);
    const handler = () => renderDeckBody(ctx, actions);
    if (layoutMq.addEventListener) layoutMq.addEventListener('change', handler);
    else if (layoutMq.addListener) layoutMq.addListener(handler); // older Safari
    layoutMq._handler = handler;
  } catch { layoutMq = null; }
}
function unwatchLayout() {
  if (!layoutMq) return;
  try {
    if (layoutMq.removeEventListener) layoutMq.removeEventListener('change', layoutMq._handler);
    else if (layoutMq.removeListener) layoutMq.removeListener(layoutMq._handler);
  } catch { /* best-effort */ }
  layoutMq = null;
}

function setFocus(entry) {
  focusedName = entry ? entry.name : null;
  focusedSnapshot = entry || null;
}

// pool -> the entry the right pane should show. Empty pool -> null (zero
// state, build spec: "empty pool -> the pane shows the zero-state"). A
// non-empty pool that still contains focusedName refreshes the snapshot to
// the live entry (reason text tracks the current ranking); one that no longer
// contains it falls back to the frozen snapshot rather than reassigning focus
// out from under the user. No prior focus at all -> the pool's top entry.
function resolveFocusEntry(pool) {
  if (!pool.length) return null;
  const live = pool.find((e) => e.name === focusedName);
  if (live) { focusedSnapshot = live; return live; }
  if (focusedName && focusedSnapshot) return focusedSnapshot;
  const top = pool[0];
  focusedName = top.name;
  focusedSnapshot = top;
  return top;
}

// ---- filter persistence (device-local; never the shared doc) ---------------------
function loadFacets(fid) {
  try {
    const raw = localStorage.getItem(LS_FILTER_PREFIX + fid);
    if (!raw) return { ...DEFAULT_FACETS, genres: [] };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FACETS, ...parsed, genres: Array.isArray(parsed.genres) ? parsed.genres : [] };
  } catch { return { ...DEFAULT_FACETS, genres: [] }; }
}
function saveFacets(fid, facets) {
  try { localStorage.setItem(LS_FILTER_PREFIX + fid, JSON.stringify(facets)); } catch { /* private mode / full */ }
}

// ---- doc reads (mirror artist-page.js's own small helpers) -----------------------
function myLevel(artistName, ctx) {
  const raw = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[artistName]?.[ctx.meName];
  return model.readLevel(state.crewDoc, raw);
}
function findArtistMeta(fest, name) {
  return (fest?.artists || []).find((a) => a && a.name === name) || { name };
}

function personHasAnyActivity(fid, person) {
  const picks = model.picksFor(state.crewDoc, fid);
  for (const byPerson of Object.values(picks)) if (byPerson[person]) return true;
  const passes = model.passesFor(state.crewDoc, fid);
  for (const byPerson of Object.values(passes)) if (byPerson[person]) return true;
  return false;
}

// ---- pool build --------------------------------------------------------------------
function buildPool(ctx, facets, canonData) {
  const fest = state.FESTIVALS[ctx.fid] || {};
  const picks = model.picksFor(state.crewDoc, ctx.fid);
  const passes = model.passesFor(state.crewDoc, ctx.fid);
  return applyFilters(fest.artists || [], picks, passes, facets, ctx.meName, canonData, fest);
}

function startSession(ctx, facets, canonData) {
  // A new pool means new cards at every index — any pending pick or in-flight
  // celebrate belongs to a card that is about to stop existing.
  clearDeckTimers();
  session = { pool: buildPool(ctx, facets, canonData), position: 0, decided: 0 };
}

function clearDesktopTimers() {
  for (const cancel of [desktopSettleTimer, desktopExitTimer]) {
    if (typeof cancel === 'function') cancel();
  }
  desktopSettleTimer = desktopExitTimer = null;
}

function resetDesktopSession() {
  clearDesktopTimers();
  desktopOrder = null;
  desktopFacetKey = null;
}

// ONE place decides whether the frozen order is still the right one, so every
// path that renders the desktop body — facet commit, layout switch, undo, a
// grid click — gets the same answer without each having to remember to ask.
function ensureDesktopSession(ctx, facets) {
  const key = JSON.stringify(facets);
  if (desktopOrder && key === desktopFacetKey) return desktopOrder;
  clearDesktopTimers();
  desktopFacetKey = key;
  desktopOrder = buildPool(ctx, facets, currentCanonData);
  return desktopOrder;
}

// Decided = you have said something about this artist, either way. Read from
// the DOC rather than from a "seen this session" set, so an undo un-marks the
// card for free and an already-decided artist surfaced by Show=All reads
// correctly on its very first render.
function isDecided(artistName, ctx) {
  return myLevel(artistName, ctx) >= 1
    || model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);
}

function decisionKind(artistName, ctx) {
  if (model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName)) return 'pass';
  const lvl = myLevel(artistName, ctx);
  if (lvl === 4) return 'must';
  return lvl >= 1 ? 'pick' : null;
}


// ---- card build ---------------------------------------------------------------------
// The part of a card that is ABOUT THIS ARTIST — everything except the player.
//
// Split out so an advance can replace it without rebuilding the card, because
// the player must not move: WebKit re-creates an iframe's browsing context on
// ANY reparent, even one that never leaves the document (measured on an iPhone,
// design/ios-playback-probe step 5B — onReady fired a second time and the
// unlock was gone). Everything here is REPLACED wholesale rather than patched
// field by field, so there is no way for one artist's detail to survive onto
// the next; the exception list is exactly one element long.
function paintCard(card, entry, ctx) {
  const fest = state.FESTIVALS[ctx.fid] || {};
  const meta = findArtistMeta(fest, entry.name);
  for (const el of [...card.children]) {
    if (!el.classList.contains('dd-player-host')) el.remove();
  }
  card.dataset.artist = entry.name;
  const before = card.querySelector('.dd-player-host');
  const add = (el) => { if (el) card.insertBefore(el, before); };

  const chips = document.createElement('div');
  chips.className = 'dd-chips';
  const genreList = [entry.primary, ...(entry.secondary || [])].filter(Boolean);
  for (const g of genreList) {
    const c = document.createElement('span');
    c.className = 'dd-chip';
    c.textContent = g;
    chips.appendChild(c);
  }
  add(chips);

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'dd-name';
  nameBtn.textContent = entry.name;
  nameBtn.setAttribute('aria-label', `Open ${entry.name}`);
  // The one flow change (build spec §1): every artist name opens the artist
  // page, stacked on top via the `artist:` router layer — same ctx.onTap
  // every other surface (wall, timetable) already routes through.
  nameBtn.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(entry.name); });
  add(nameBtn);

  // When they play, right under the name — the same DAY · TIME · STAGE line the
  // artist page carries, from the same findSetInfo, so a card and the page it
  // opens never disagree. Absent for a lineup with no schedule yet: no set
  // info, no line (never a placeholder, same rule the reason ribbon follows).
  // Plain text throughout, including the stage: the festival accent has exactly
  // four homes (repo law) and a deck card is not one of them.
  const setLine = formatSetLinePlain(fest, findSetInfo(fest, entry.name, meta));
  if (setLine) {
    const when = document.createElement('div');
    when.className = 'dd-setline';
    when.textContent = setLine;
    add(when);
  }

  // Exactly one reason ribbon — no reason, no ribbon (score.js's guarantee).
  if (entry.reason) {
    const ribbon = document.createElement('div');
    ribbon.className = 'dd-reason';
    ribbon.textContent = entry.reason.text;
    add(ribbon);
  }
}

function buildCard(entry, ctx, actions, canonData) {
  const fest = state.FESTIVALS[ctx.fid] || {};
  const meta = findArtistMeta(fest, entry.name);

  const stack = document.createElement('div');
  stack.className = 'dd-stack';
  const ghost2 = document.createElement('div');
  ghost2.className = 'dd-ghost dd-ghost-2';
  ghost2.setAttribute('aria-hidden', 'true');
  const ghost1 = document.createElement('div');
  ghost1.className = 'dd-ghost dd-ghost-1';
  ghost1.setAttribute('aria-hidden', 'true');

  const card = document.createElement('div');
  card.className = 'dd-card';

  const playerHost = document.createElement('div');
  playerHost.className = 'dd-player-host';
  card.appendChild(playerHost);
  paintCard(card, entry, ctx);  const { primary, secondary } = canonicalize(meta.genres, canonData);
  const playerGenres = [primary, ...secondary].filter(Boolean);
  const sources = {
    youtubeVideoIds: meta.youtubeVideoIds,
    youtubeLabels: meta.youtubeLabels,
    soundcloudSlug: meta.soundcloudSlug,
    spotifyId: meta.spotifyId,
  };
  playerHandle = mountOrCarry(actions, {
    host: playerHost, artist: { name: entry.name, genres: playerGenres }, sources, layout: 'compact',
    autoplay: soundIntent,
    // A refusal is the platform's answer, not the person's — it corrects the
    // icon without withdrawing the intent, so the next artist still gets a try.
    onStateChange: (snap, meta) => { if (!meta || !meta.autoplayRefused) soundIntent = snap.play; },
  });

  // The drag hint and the confirmation overlay are siblings of the card, not
  // children of it: .dd-card is a scroll container (`overflow: hidden auto`),
  // and an inset:0 child of a scrolled container is positioned from the top of
  // its CONTENT — so on a card scrolled down to the player, the overlay would
  // render off-screen. As siblings inside the non-scrolling .dd-stack they
  // always cover the card exactly; beginDecision carries them off with it.
  const hint = document.createElement('div');
  hint.className = 'dd-hint';
  hint.setAttribute('aria-hidden', 'true');

  stack.append(ghost2, ghost1, card, hint, buildCelebrateOverlay());
  return stack;
}

// ---- completion state ----------------------------------------------------------------
function buildCompletion(ctx, facets, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'dd-done';
  const title = document.createElement('div');
  title.className = 'dd-done-title';
  title.textContent = 'That’s the pool';
  // Live counts, not the ranked snapshot's stale .passed: decisions made
  // DURING this session must show up in the summary.
  const counts = session.pool.reduce((acc, e) => {
    const lvl = myLevel(e.name, ctx);
    if (lvl >= 4) acc.must++;
    else if (lvl >= 1) acc.picked++;
    else if (model.isPassed(state.crewDoc, ctx.fid, e.name, ctx.meName)) acc.passed++;
    return acc;
  }, { picked: 0, must: 0, passed: 0 });
  const summary = document.createElement('div');
  summary.className = 'dd-done-summary';
  summary.textContent = `${counts.picked + counts.must} picked · ${counts.must} musts · ${counts.passed} passed`;
  wrap.append(title, summary);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'dd-done-actions';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn-tonal dd-done-btn';
  resetBtn.textContent = 'Reset filters';
  resetBtn.addEventListener('click', () => {
    saveFacets(ctx.fid, { ...DEFAULT_FACETS, genres: [] });
    startSession(ctx, loadFacets(ctx.fid), currentCanonData);
    renderDeckBody(ctx, actions);
  });
  actionsRow.appendChild(resetBtn);

  const currentFacets = loadFacets(ctx.fid);
  if (currentFacets.show !== 'passed') {
    const showPassedBtn = document.createElement('button');
    showPassedBtn.type = 'button';
    showPassedBtn.className = 'btn-ghost dd-done-btn';
    showPassedBtn.textContent = 'Show passed';
    showPassedBtn.addEventListener('click', () => {
      const next = { ...currentFacets, show: 'passed' };
      saveFacets(ctx.fid, next);
      startSession(ctx, next, currentCanonData);
      renderDeckBody(ctx, actions);
    });
    actionsRow.appendChild(showPassedBtn);
  }
  wrap.appendChild(actionsRow);
  return wrap;
}

// ---- header -------------------------------------------------------------------------
// Filter rides the title row, next to Back and DISCOVER (2026-08-04). It used
// to own a row of its own alongside a "DISCOVERY SESSION" micro-label, which
// spent a whole row of a phone screen saying what the screen already says —
// and pushed the progress bar and the card down with it. The counter kept its
// job and moved to the end of the sub-line, where it sits next to the "N
// unheard left" it is counting.
function buildFilterButton(ctx, facets, actions) {
  const filterBtn = document.createElement('button');
  filterBtn.type = 'button';
  filterBtn.className = 'dd-filter-btn';
  filterBtn.setAttribute('aria-label', 'Filter the discovery pool');
  const filterLabel = document.createElement('span');
  filterLabel.textContent = 'Filter';
  filterBtn.appendChild(filterLabel);
  const count = activeFacetCount(facets);
  if (count > 0) {
    const badge = document.createElement('span');
    badge.className = 'dd-filter-badge';
    badge.textContent = String(count);
    filterBtn.appendChild(badge);
  }
  filterBtn.addEventListener('click', () => {
    // The router only records history (js/v3/router.js: "UI open paths call
    // push(key) AFTER opening") — the caller opens the surface directly,
    // same as every other sheet-opening callsite in the app.
    openDiscoverFilterSheet(ctx, actions);
    router.push('sheet:discover-filter');
  });
  return filterBtn;
}


// ---- the decision flow ----------------------------------------------------------------
// Modelled directly on "Discovery - Swipe Demo.dc.html", which is the deck's
// interaction reference (its begin/pickTap/renderVals). Three things there that
// a reading of the style guide alone misses, and that this file shipped without:
//
//  1. PICK IS NOT ONE TAP. Tapping Pick opens a pending cycle — ×1 → ×2 → ×3 →
//     back to ×1 — and locks in after 1s of no further taps. The prototype's
//     `pickTap`: `pending ? (pending.level % 3) + 1 : 1`, committed on a 1000ms
//     idle timer. Pass and Must are immediate; only Pick negotiates.
//  2. EVERY DECISION SHOWS A CONFIRMATION OVERLAY over the card — ★ MUST, 👎 NOT
//     FOR ME, or the filling tick with ×N and pips. For Pick it is not
//     decoration: it IS the level control, which is why one-tap-commit left it
//     with nothing to say.
//  3. The card then EXITS — translate ±520px, dy 40, rotate ±16° — and the deck
//     advances. The prototype's timings, kept exactly.
//
// Reduced motion is faster overall (520+0 vs 420+300), not slower: the celebrate
// holds a beat longer so it is still readable without the exit animation to sell
// it, and there is no exit to wait on. Pick skips most of it (160ms) because the
// 1s cycle already confirmed the choice.
const CELEBRATE_MS = 420;
const CELEBRATE_RM_MS = (kind) => (kind === 'pick' ? 160 : 520);
const EXIT_MS = 300;
const PICK_IDLE_MS = 1000;

const REDUCED_MOTION = () => {
  try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

// Timers are module state because the deck is a singleton overlay. Every path
// that tears the deck down or jumps cards MUST clear them — a pending pick that
// fires after its card is gone would write a level onto the wrong artist.
let pendingPick = null;   // { level } while the Pick cycle is open
let celebrating = null;   // { kind, level } while the confirmation overlay is up
let pickTimer = null, celebrateTimer = null, exitTimer = null;

export function clearDeckTimers() {
  for (const cancel of [pickTimer, celebrateTimer, exitTimer]) {
    if (typeof cancel === 'function') cancel();
  }
  pickTimer = celebrateTimer = exitTimer = null;
  pendingPick = null; celebrating = null;
}

// schedule() always returns a CANCEL FUNCTION, never a timer id. An injected
// scheduler cannot produce an id that clearTimeout understands, so cancelling
// through clearTimeout would silently do nothing under a test scheduler — and
// the one thing this flow must get right is cancelling a superseded pick timer.
// Tests inject a scheduler to control (or collapse) the chain; production gets
// setTimeout.
function schedule(actions, fn, ms) {
  if (actions && typeof actions.schedule === 'function') return actions.schedule(fn, ms);
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

// The deck cycles ×1 → ×2 → ×3 → ×1. It never cycles to clear the way the
// artist page's tick does — "not picked" is a decision the deck spells Pass,
// and a tick that silently emptied would leave the card undecided while looking
// like it had been acted on.
export function nextPickLevel(current) {
  return current ? (current % 3) + 1 : 1;
}

// ---- the confirmation overlay ---------------------------------------------------------
function buildCelebrateOverlay() {
  const el = document.createElement('div');
  el.className = 'dd-celebrate';
  el.setAttribute('aria-hidden', 'true'); // the undo toast + tick state carry this to AT
  return el;
}

// Mutated IN PLACE, never re-rendered through renderDeckBody: re-rendering
// remounts the sample player, so a second Pick tap would restart the audio
// mid-listen. The overlay changes; the card underneath it does not move.
function paintCelebrate(root, ctx) {
  const el = root.querySelector('.dd-celebrate');
  if (!el) return;
  const cardEl = root.querySelector('.dd-card');
  const state_ = celebrating || (pendingPick ? { kind: 'pick', level: pendingPick.level } : null);
  if (!state_) {
    el.classList.remove('is-on');
    el.textContent = '';
    if (cardEl) cardEl.dataset.intent = '';
    paintPickButton(root);
    return;
  }
  el.textContent = '';
  el.classList.add('is-on');
  if (cardEl) cardEl.dataset.intent = state_.kind;

  if (state_.kind === 'must') {
    const g = document.createElement('div');
    g.className = 'dd-cel-star';
    g.textContent = '★';
    const l = document.createElement('div');
    l.className = 'dd-cel-label';
    l.textContent = 'MUST';
    el.append(g, l);
  } else if (state_.kind === 'pass') {
    const g = document.createElement('div');
    g.className = 'dd-cel-thumb';
    g.textContent = '👎';
    const l = document.createElement('div');
    l.className = 'dd-cel-label dd-cel-label-quiet';
    l.textContent = 'NOT FOR ME';
    el.append(g, l);
  } else {
    const level = state_.level || 1;
    const tick = document.createElement('div');
    tick.className = 'dd-cel-tick';
    const fill = document.createElement('div');
    fill.className = 'dd-cel-tick-fill';
    fill.style.height = `${level * 33.4}%`; // prototype's tickFill
    tick.appendChild(fill);
    const times = document.createElement('div');
    times.className = 'dd-cel-times';
    times.textContent = `×${level}`;
    const pips = document.createElement('div');
    pips.className = 'dd-cel-pips';
    for (let n = 1; n <= 3; n++) {
      const p = document.createElement('span');
      p.className = n <= level ? 'dd-cel-pip is-on' : 'dd-cel-pip';
      pips.appendChild(p);
    }
    el.append(tick, times, pips);
    // The hint only makes sense while the cycle is still open — once it has
    // locked in, telling someone to tap again would be a lie.
    if (pendingPick && !celebrating) {
      const hint = document.createElement('div');
      hint.className = 'dd-cel-hint';
      hint.textContent = 'tap Pick again to raise · locks in 1s';
      el.appendChild(hint);
    }
  }
  paintPickButton(root);
}

// `Pick` becomes `Picked ×N` and lights the next segment while the cycle is
// open, so the level is legible from the button too — not only the overlay.
// The overlay is the celebration; the segments are the state.
function paintPickButton(root, bump = false) {
  // The bar lives inside the deck overlay alongside the card, so the overlay
  // root reaches it directly.
  paintPrimaryActions(root.querySelector('.dd-actions-row'), pendingPick ? pendingPick.level : 0, bump);
}

// ---- committing a decision ------------------------------------------------------------
function beginDecision(kind, level, ctx, actions) {
  if (!session || session.position >= session.pool.length) return;
  if (celebrating) return; // a decision is already playing out
  const entry = session.pool[session.position];
  const name = entry.name;
  const prevLevel = myLevel(name, ctx);
  const prevPassed = model.isPassed(state.crewDoc, ctx.fid, name, ctx.meName);
  const decidedAt = session.position;

  if (pickTimer) pickTimer();
  pickTimer = null;
  pendingPick = null;
  celebrating = { kind, level };

  const commit = () => {
    if (kind === 'pass') {
      state.applyPass(ctx.fid, name, ctx.meName, true);
      // applyPass's own pick-clearing write (recordSelectionFor) is pending-only —
      // mirror it into the rendered doc, same discipline as artist-page.js.
      actions.applyLocalPick(name, ctx.meName, 0);
    } else {
      state.applyPickLevel(ctx.fid, name, ctx.meName, level);
      actions.applyLocalPick(name, ctx.meName, level);
    }
  };
  const revert = () => {
    if (kind === 'pass') {
      state.applyPass(ctx.fid, name, ctx.meName, false);
      if (prevLevel >= 1) {
        state.applyPickLevel(ctx.fid, name, ctx.meName, prevLevel);
        actions.applyLocalPick(name, ctx.meName, prevLevel);
      }
    } else {
      state.applyPickLevel(ctx.fid, name, ctx.meName, prevLevel);
      actions.applyLocalPick(name, ctx.meName, prevLevel);
      if (prevPassed) state.applyPass(ctx.fid, name, ctx.meName, true);
    }
  };

  // The write lands NOW, not when the animation ends. The prototype can afford
  // to record its decision at the end of the sequence because its deck is
  // local state; ours is a synced crew doc, and 720ms of animation is 720ms in
  // which a backgrounded tab or a closed lid would lose the pick outright.
  commit();
  ctx.onNotesChange();

  const overlay = document.getElementById(OVERLAY_ID);
  const rm = REDUCED_MOTION();
  if (overlay) paintCelebrate(overlay, ctx);

  const advance = () => {
    session.decided++;
    session.position++;
    celebrating = null;
    // In place if we can — moving the player would cost it its embed (see
    // refreshDeckInPlace). The full rebuild is the fallback, not the default.
    if (!refreshDeckInPlace(ctx, actions)) renderDeckBody(ctx, actions);

    // Vocabulary matches the buttons: the control says "Not for me", so the
    // confirmation does too.
    const label = kind === 'pass' ? `Not for me — ${name}`
      : kind === 'must' ? `Made ${name} a must`
        : `Picked ${name} ×${level}`;
    // In the bar, not over it (style guide §07). renderDeckBody has already
    // rebuilt the bar above, so this attaches to the live one.
    const ov = document.getElementById(OVERLAY_ID);
    showBarUndo(ov && ov.querySelector('.dd-actions'), label, () => {
      clearDeckTimers();
      revert();
      session.decided--;
      session.position = decidedAt;
      ctx.onNotesChange();
      renderDeckBody(ctx, actions);
    });
  };

  celebrateTimer = schedule(actions, () => {
    const ov = document.getElementById(OVERLAY_ID);
    const card = ov && ov.querySelector('.dd-card');
    if (card && !rm) {
      // Prototype exit: ±520px out, 40px down, ±16°, fading. The overlay rides
      // along so the confirmation leaves with the card it confirmed.
      const t = `translate(${kind === 'pass' ? -520 : 520}px, 40px) rotate(${kind === 'pass' ? -16 : 16}deg)`;
      for (const el of [card, ov.querySelector('.dd-celebrate')]) {
        if (!el) continue;
        el.classList.add('is-exiting');
        el.style.transform = t;
        el.style.opacity = '0';
      }
    }
    exitTimer = schedule(actions, advance, rm ? 0 : EXIT_MS);
  }, rm ? CELEBRATE_RM_MS(kind) : CELEBRATE_MS);
}

// Pass and Must are immediate. Pick opens the cycle.
function pickTap(ctx, actions) {
  if (!session || session.position >= session.pool.length || celebrating) return;
  if (pickTimer) pickTimer(); // a new tap supersedes the previous idle timer
  pendingPick = { level: nextPickLevel(pendingPick && pendingPick.level) };
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    paintCelebrate(overlay, ctx);
    paintPickButton(overlay, true); // the 1.05x tap bump — a tap always answers
  }
  const level = pendingPick.level;
  pickTimer = schedule(actions, () => {
    // Read the level off the pending state at fire time, not the closure — a
    // later tap raised it and did not get its own timer.
    const lvl = pendingPick ? pendingPick.level : level;
    beginDecision('pick', lvl, ctx, actions);
  }, PICK_IDLE_MS);
}

// ---- in-bar undo ----------------------------------------------------------------------
// "Undo EXPANDS the action bar — a row grows in above the buttons, then the
// bar collapses back." And: "Never a floating snackbar over the deck or over
// the action bar — undo has a place of its own, so it never covers content."
// (Style guide §07.)
//
// The build had kept the app-wide toast, which is exactly the floating
// snackbar the design rules out — on the deck it landed on top of the bar it
// was describing. The toast stays for surfaces with no action bar (the wall),
// where it remains the right component.
//
// The row USED to carry a 5s countdown hairline, and it was read as a deadline:
// a draining bar under a decision looks like the decision is the thing being
// timed, so people felt hurried into choosing rather than informed that an
// escape hatch was expiring (reported 2026-08-04). The 5s dismissal stays —
// the row simply leaves when it is done. Nothing was lost: the countdown was
// never the only carrier of anything, and the row disappearing was always the
// real signal.
//
// Exported so the artist page's bar gets the same treatment.
const UNDO_MS = 5000;
export function showBarUndo(bar, message, onUndo) {
  if (!bar) return;
  clearBarUndo(bar);
  const row = document.createElement('div');
  row.className = 'dd-undo';
  const msg = document.createElement('span');
  msg.className = 'dd-undo-msg';
  msg.textContent = message;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-undo-btn';
  btn.textContent = 'Undo';
  row.append(msg, btn);
  bar.insertBefore(row, bar.firstChild); // above the buttons, per the design
  const done = () => { clearBarUndo(bar); };
  btn.addEventListener('click', () => { done(); onUndo(); });
  row._t = setTimeout(done, UNDO_MS);
}

export function clearBarUndo(bar) {
  const old = bar && bar.querySelector('.dd-undo');
  if (!old) return;
  clearTimeout(old._t);
  old.remove();
}

// ---- action bar -----------------------------------------------------------------------
// "Not for me · pick · must, in that order, along the bottom on every surface"
// (style guide §05). Exported so the artist page and the desktop focus pane
// build the SAME control rather than three lookalikes — the design's whole
// point is that nothing moves between screens.
export function buildPrimaryActions({ onPass, onPick, onMust, level = 0 }) {
  const row = document.createElement('div');
  row.className = 'dd-actions-row';

  const pass = document.createElement('button');
  pass.type = 'button';
  pass.className = 'dd-btn dd-btn-pass';
  pass.innerHTML = '<span class="dd-btn-glyph">✕</span><span class="dd-btn-label">NOT<br>FOR ME</span>';
  pass.setAttribute('aria-label', 'Not for me');
  pass.addEventListener('click', onPass);

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'dd-btn dd-btn-pick';
  const label = document.createElement('span');
  label.className = 'dd-btn-pick-label';
  const segs = document.createElement('span');
  segs.className = 'dd-btn-pick-segs';
  for (let n = 1; n <= 3; n++) {
    const s = document.createElement('span');
    s.className = 'dd-btn-seg';
    segs.appendChild(s);
  }
  pick.append(label, segs);
  pick.addEventListener('click', onPick);

  const must = document.createElement('button');
  must.type = 'button';
  must.className = 'dd-btn dd-btn-must';
  must.innerHTML = '<span class="dd-btn-glyph">★</span><span class="dd-btn-label">MUST</span>';
  must.setAttribute('aria-label', 'Must see');
  must.addEventListener('click', onMust);

  row.append(pass, pick, must);
  paintPrimaryActions(row, level);
  return row;
}

// Repaints label + segments from a pick level (0 = unpicked, 1–3 = ×N, 4 =
// must). The segments are drawn either way — an unpicked Pick still shows
// three dark segments, which is how the multi-tap is legible before the first
// tap. `bump` fires the 1.05x tap animation; motion never carries the state.
export function paintPrimaryActions(row, level, bump = false) {
  if (!row) return;
  const pick = row.querySelector('.dd-btn-pick');
  const label = row.querySelector('.dd-btn-pick-label');
  const must = row.querySelector('.dd-btn-must');
  if (label) label.textContent = level >= 1 && level <= 3 ? `Picked ×${level}` : 'Pick';
  const segs = row.querySelectorAll('.dd-btn-seg');
  segs.forEach((s, i) => s.classList.toggle('is-on', level >= 1 && level <= 3 && i < level));
  if (pick) pick.classList.toggle('is-pending', level >= 1 && level <= 3);
  // Only ONE of the two ever wears the bright outline. Pick carries the violet
  // treatment by default (it is the primary action, and the design's unpicked
  // frames draw it that way), but a must moves the selection to Must — and
  // leaving Pick lit there made the screen claim two selections at once
  // (reported 2026-08-02).
  if (pick) pick.classList.toggle('is-muted', level === 4);
  if (must) must.classList.toggle('is-on', level === 4);
  if (pick && bump) {
    pick.classList.remove('is-bumping');
    void pick.offsetWidth; // restart the animation on a repeat tap
    pick.classList.add('is-bumping');
  }
}

// Skip: move on without recording anything.
//
// Still not a fourth PRIMARY action — the design's three are "not for me ·
// pick · must" and a decline already has a home. This is the escape from being
// made to decide at all, and the distinction matters to the data: "not for me"
// is considered-and-rejected and is visible to the crew, while a skip says
// nothing about the artist, so they stay in the pool and come back in a later
// session.
//
// It IS a button now, sitting left of "not for me" (requested 2026-08-04). As
// a bare text link under the bar it read as a caption rather than a control —
// people did not find it, and the one escape from a screen that otherwise
// insists on a decision has to be findable. It keeps a quieter treatment than
// the three (see .dd-btn-skip) and stays OUTSIDE buildPrimaryActions, which is
// the component the artist page and the desktop focus pane share verbatim:
// skip is a property of a deck session, and neither of those surfaces has one.
function skipCurrent(ctx, actions) {
  if (!session || session.position >= session.pool.length || celebrating) return;
  clearDeckTimers();
  pendingPick = null;
  const name = session.pool[session.position].name;
  const from = session.position;

  // Claim the decision lock for the length of the exit, exactly as a real
  // decision does: every guard in this file already reads `celebrating`, so a
  // second skip tap — or a Pick landing mid-flight — cannot advance twice. The
  // kind is inert; nothing paints a confirmation overlay for a skip, because
  // there is nothing to confirm.
  celebrating = { kind: 'skip' };

  const advance = () => {
    celebrating = null;
    session.position = from + 1;
    if (!refreshDeckInPlace(ctx, actions)) renderDeckBody(ctx, actions);
    const ov = document.getElementById(OVERLAY_ID);
    showBarUndo(ov && ov.querySelector('.dd-actions'), `Skipped ${name}`, () => {
      clearDeckTimers();
      session.position = from;
      renderDeckBody(ctx, actions);
    });
  };

  const overlay = document.getElementById(OVERLAY_ID);
  const card = overlay && overlay.querySelector('.dd-card');
  const rm = REDUCED_MOTION();
  if (card && !rm) {
    // A skip leaves DOWNWARD, and the direction is the message: left, right and
    // up are spoken for by pass, pick and must, so a fourth exit borrowing any
    // of them would read as a decision that got recorded. Straight down, no
    // rotation — the card drops back onto the pile it came from, which is
    // exactly what a skip does to the artist. The distance is measured rather
    // than the ±520 the sideways exits hard-code: those only have to clear a
    // 375px-wide phone, while this has to clear whatever height the device has.
    // It passes BEHIND the action bar on the way out (.dd-actions carries the
    // higher z-index), so the controls are never covered by a leaving card.
    const drop = Math.ceil(window.innerHeight - card.getBoundingClientRect().top) + 24;
    card.classList.add('is-exiting');
    card.style.transform = `translate(0, ${drop}px)`;
    card.style.opacity = '0';
  }
  exitTimer = schedule(actions, advance, rm ? 0 : EXIT_MS);
}

function buildActionBar(ctx, actions) {
  const bar = document.createElement('div');
  bar.className = 'dd-actions';

  const line = document.createElement('div');
  line.className = 'dd-actions-line';

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'dd-btn dd-btn-skip';
  skip.innerHTML = '<span class="dd-btn-glyph">»</span><span class="dd-btn-label">SKIP</span>';
  skip.setAttribute('aria-label', 'Skip this artist without deciding');
  skip.addEventListener('click', () => skipCurrent(ctx, actions));

  line.append(skip, buildPrimaryActions({
    onPass: () => beginDecision('pass', 0, ctx, actions),
    onPick: () => pickTap(ctx, actions),
    onMust: () => beginDecision('must', 4, ctx, actions),
  }));
  bar.appendChild(line);
  return bar;
}

// ---- swipe gestures --------------------------------------------------------------------
// Prototype thresholds exactly: must = dy < -90 with the vertical dominant,
// pick = dx > 90, pass = dx < -90. Every one of them also has a button.
function wireSwipe(cardStack, ctx, actions) {
  const card = cardStack.querySelector('.dd-card');
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const THRESHOLD = 90;

  const intentOf = (x, y) => {
    if (y < -40 && Math.abs(y) > Math.abs(x)) return 'must';
    if (x > 40) return 'pick';
    if (x < -40) return 'pass';
    return null;
  };

  const hint = cardStack.querySelector('.dd-hint');
  const paintHint = () => {
    if (!hint) return;
    const intent = dragging ? intentOf(dx, dy) : null;
    if (!intent || celebrating || pendingPick) { hint.style.opacity = '0'; return; }
    hint.textContent = intent === 'must' ? 'MUST' : intent === 'pick' ? 'PICK' : 'PASS';
    hint.dataset.intent = intent;
    // The prototype's ramp: nothing below 25px, full by 105px.
    const mag = Math.max(Math.abs(dx), Math.abs(dy));
    hint.style.opacity = String(Math.min(1, Math.max(0, (mag - 25) / 80)));
    card.dataset.intent = intent;
  };

  const clearDrag = () => {
    dragging = false;
    if (!REDUCED_MOTION() && card.style.transform) {
      card.classList.add('is-settling');
      const done = () => { card.classList.remove('is-settling'); card.removeEventListener('transitionend', done); };
      card.addEventListener('transitionend', done);
    }
    card.style.transform = '';
    if (!celebrating && !pendingPick) card.dataset.intent = '';
    dx = 0; dy = 0;
    paintHint();
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // player controls, name button
    if (celebrating) return;
    // Touching the card abandons an open Pick cycle rather than letting its
    // timer fire mid-gesture — same as the prototype's onDown clearing pending.
    if (pendingPick) {
      if (pickTimer) pickTimer();
      pickTimer = null; pendingPick = null;
      const ov = document.getElementById(OVERLAY_ID);
      if (ov) paintCelebrate(ov, ctx);
    }
    dragging = true; startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
    card.classList.remove('is-settling');
    try { card.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (REDUCED_MOTION()) { paintHint(); return; }
    // "card follows the finger" — the prototype translates on both axes at once
    // and rotates off dx, so a diagonal drag reads as the gesture it is.
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    paintHint();
  });
  const release = () => {
    if (!dragging) return;
    const fx = dx, fy = dy;
    clearDrag();
    if (fy < -THRESHOLD && Math.abs(fy) > Math.abs(fx)) beginDecision('must', 4, ctx, actions);
    else if (fx > THRESHOLD) beginDecision('pick', 1, ctx, actions);
    else if (fx < -THRESHOLD) beginDecision('pass', 0, ctx, actions);
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', clearDrag);
}
// ---- desktop three-pane (frame 5c) --------------------------------------------------
// "For you" stacked list — distinct from the sheet/rail's `segRow` (5c draws
// Sort as a vertical list, Show as a segmented pill; segRow is reused below
// for Show/Day since those ARE segmented pills in the mock).
function sortListRow(current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'dd-filter-field';
  const lbl = document.createElement('div');
  lbl.className = 'dd-filter-label';
  lbl.textContent = 'Sort — top picks first';
  const list = document.createElement('div');
  list.className = 'dd2-sort-list';
  const opts = [
    { value: 'foryou', label: 'For you' },
    { value: 'popularity', label: 'Popularity' },
    { value: 'az', label: 'A–Z' },
  ];
  for (const opt of opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd2-sort-opt' + (opt.value === current ? ' active' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => onPick(opt.value));
    list.appendChild(btn);
  }
  wrap.append(lbl, list);
  return wrap;
}

// Commits a facet change straight to localStorage (no draft/Apply step — the
// rail is live, per spec) and restarts the mobile session too, so a resize
// back down to the deck picks up the same facets rather than a stale pool.
function commitFacets(ctx, actions, next) {
  saveFacets(ctx.fid, next);
  startSession(ctx, next, currentCanonData);
  renderDeckBody(ctx, actions);
}

function resetFiltersAndRerender(ctx, actions) {
  commitFacets(ctx, actions, { ...DEFAULT_FACETS, genres: [] });
}

// The desktop rail's search box (design 6e). Same quiet field as the wall's
// (.wall-search in assets/v3.css), reused verbatim so the two ends of the app
// keep one search vocabulary. The value lives here rather than in `facets`
// because it is per-visit, and re-rendering the whole body on every keystroke
// is what renderDeckBody's caret restore exists for.
let deckQuery = '';
function buildRailSearch(ctx, actions, fest) {
  const wrap = document.createElement('span');
  wrap.className = 'wall-search dd2-rail-search';
  wrap.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">'
    + '<circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"></circle>'
    + '<line x1="10.2" y1="10.2" x2="14.4" y2="14.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></line></svg>';
  const input = document.createElement('input');
  input.id = 'dd2-search-input';
  input.value = deckQuery;
  const n = (fest.artists || []).length;
  input.placeholder = n ? `Search ${n} artist${n === 1 ? '' : 's'}` : 'Search artists';
  input.setAttribute('aria-label', 'Search artists');
  input.addEventListener('input', (e) => {
    deckQuery = e.target.value;
    renderDeckBody(ctx, actions);
  });
  wrap.appendChild(input);
  return wrap;
}

// LEFT RAIL — the identical facets object + localStorage key the mobile sheet
// edits (openDiscoverFilterSheet below); segRow/toggleField are the same
// builders the sheet uses, just wired to commit immediately instead of into a
// draft. One source of truth, two renderings.
function buildRail(ctx, actions, facets, fest, canonData, scheduled) {
  const rail = document.createElement('div');
  rail.className = 'dd2-rail';

  // Search sits at the top of the pane where narrowing the lineup already
  // happens (design 6e) — the top bar is navigation, identity and status only.
  // Deliberately NOT part of `facets`: a facet is a preference and survives to
  // the next session in localStorage, a query is a moment and must not.
  rail.appendChild(buildRailSearch(ctx, actions, fest));

  rail.appendChild(sortListRow(facets.sort, (v) => commitFacets(ctx, actions, { ...facets, sort: v })));

  rail.appendChild(segRow('Show', [
    { value: 'undecided', label: 'Undecided' },
    { value: 'passed', label: 'Passed' },
    { value: 'all', label: 'All' },
  ], facets.show, (v) => commitFacets(ctx, actions, { ...facets, show: v })));

  const genresField = document.createElement('div');
  genresField.className = 'dd-filter-field';
  const gLabel = document.createElement('div');
  gLabel.className = 'dd-filter-label';
  gLabel.textContent = 'Genres';
  genresField.appendChild(gLabel);
  const chipsRow = document.createElement('div');
  chipsRow.className = 'dd-chip-row';
  const genres = availableGenres(fest.artists || [], canonData);
  for (const g of genres) {
    const on = facets.genres.includes(g);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dd-filter-chip' + (on ? ' active' : '');
    chip.textContent = on ? `${g} ✓` : g;
    chip.addEventListener('click', () => {
      const nextGenres = on ? facets.genres.filter((x) => x !== g) : [...facets.genres, g];
      commitFacets(ctx, actions, { ...facets, genres: nextGenres });
    });
    chipsRow.appendChild(chip);
  }
  genresField.appendChild(chipsRow);
  rail.appendChild(genresField);

  const days = availableDays(fest.artists || []);
  if (days.length) {
    const dayLabel = (d) => {
      const wd = (fest.dayMeta || {})[d]?.wd;
      return wd ? wd.slice(0, 3).toUpperCase() : d;
    };
    rail.appendChild(segRow('Day', [
      { value: 'all', label: 'All' },
      ...days.map((d) => ({ value: d, label: dayLabel(d) })),
    ], facets.day, (v) => commitFacets(ctx, actions, { ...facets, day: v })));
  }

  const togglesWrap = document.createElement('div');
  togglesWrap.className = 'dd-toggles';
  togglesWrap.appendChild(toggleField(
    'Picked by the crew', null, facets.crewPicked,
    (v) => commitFacets(ctx, actions, { ...facets, crewPicked: v }),
  ));
  togglesWrap.appendChild(toggleField(
    'Has a live set to sample', null, facets.hasLiveSet,
    (v) => commitFacets(ctx, actions, { ...facets, hasLiveSet: v }),
  ));
  if (scheduled) {
    togglesWrap.appendChild(toggleField(
      'Playing in my open gaps', null, facets.gap,
      (v) => commitFacets(ctx, actions, { ...facets, gap: v }),
    ));
  }
  rail.appendChild(togglesWrap);

  return rail;
}

// people who picked this artist — same cardPeople shape aura.js expects
// (mirrors wall.js's private cardPeople / artist-page.js's cardPeopleFor;
// each surface keeps its own small copy rather than sharing one).
function cardPeopleFor(artistName, ctx) {
  const byPerson = model.picksFor(state.crewDoc, ctx.fid)[artistName] || {};
  const peopleObj = state.people();
  const out = [];
  for (const [person, level] of Object.entries(byPerson)) {
    const p = peopleObj[person];
    if (!state.isActivePerson(p)) continue;
    out.push({ name: person, colorIndex: colorIndexOf(person, p), isYou: person === ctx.meName, level });
  }
  return out;
}

// MIDDLE — the ranked wall. A simplified card (no notes/Spotify chips, no
// player, no long-press): reason strip for a taste/billing reason, crew
// reasons show as a who-corner glyph only — same rule wall.js's renderCard
// applies to .card-reason-ribbon. Click FOCUSES the right pane; never writes,
// never opens the artist page (unlike the mobile deck's dd-name).
function buildGridCard(entry, ctx, actions) {
  const people = cardPeopleFor(entry.name, ctx);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card dd2-gridcard';
  btn.dataset.artist = entry.name;
  const lvl = myLevel(entry.name, ctx);
  // Live doc reads, not entry.passed: the pool entry is frozen at session
  // start, and this card now OUTLIVES its own decision — it has to be able to
  // show a state its own entry has never heard of.
  const kind = decisionKind(entry.name, ctx);
  const passed = kind === 'pass';
  const undecided = !kind;
  const showRibbon = undecided && entry.reason && entry.reason.type !== 'crew';
  if (showRibbon) btn.classList.add('has-reason');
  if (passed) btn.classList.add('wall-passed');
  btn.setAttribute('aria-label', undecided
    ? `Focus ${entry.name} in the sample pane`
    : `${entry.name} — ${passed ? 'not for me' : kind === 'must' ? 'a must' : `picked ×${lvl}`}. Focus in the sample pane`);

  const { background, animated } = auraBackground(people);
  btn.style.background = background;
  if (animated && !ctx.lowPower) {
    btn.classList.add('animated');
    const grain = document.createElement('span');
    grain.className = 'card-grain';
    btn.appendChild(grain);
  }
  if (showRibbon) {
    const ribbon = document.createElement('span');
    ribbon.className = 'card-reason-ribbon';
    ribbon.textContent = entry.reason.text;
    btn.appendChild(ribbon);
  }
  if (passed) {
    const chip = document.createElement('span');
    chip.className = 'card-passed-chip';
    // The tag says what the button said. "Passed" was internal vocabulary
    // leaking to users who had only ever seen "Not for me" (2026-08-02).
    chip.textContent = 'NOT FOR ME';
    btn.appendChild(chip);
  }
  const nm = document.createElement('span');
  nm.className = 'name';
  nm.style.color = nameColor(people);
  nm.textContent = entry.name;
  btn.appendChild(nm);
  const genreLine = [entry.primary, ...(entry.secondary || [])].filter(Boolean).join(' · ');
  if (genreLine) {
    const sub = document.createElement('span');
    sub.className = 'dd2-gridcard-genre';
    sub.style.color = subColor(people);
    sub.textContent = genreLine;
    btn.appendChild(sub);
  }
  const who = document.createElement('span');
  who.className = 'corner-who';
  for (const m of whoCorner(people)) {
    const s = document.createElement('span');
    s.className = 'mark' + (m.kind === 'ghost' ? ' ghost' : '');
    if (m.kind !== 'ghost') {
      s.style.width = m.width + 'px';
      s.style.background = m.fill;
      s.style.border = '1px solid ' + m.stroke;
      s.style.fontSize = m.kind === 'must' ? '7.5px' : '0px';
    }
    s.textContent = m.label;
    who.appendChild(s);
  }
  btn.appendChild(who);

  // A decided card STAYS in the grid and says so, rather than disappearing.
  // Losing it mid-session was disorienting — the thing you just acted on was
  // the one thing that vanished — and it hid your own progress. The card dims
  // and takes a stamp; the who-corner tick underneath still carries the exact
  // level, so the stamp is never the only place a state is legible.
  if (kind) {
    btn.classList.add('is-decided');
    const stamp = document.createElement('span');
    stamp.className = 'dd2-gridcard-stamp';
    stamp.dataset.kind = kind;
    stamp.textContent = passed ? '✕' : kind === 'must' ? '★' : '✓';
    btn.appendChild(stamp);
  }

  btn.addEventListener('click', () => {
    // Clicking the card you are ALREADY sampling is a no-op, not a re-render.
    // Focusing a different artist genuinely needs a new player; re-focusing the
    // current one would tear down a playing embed and start it over, which is
    // the same interruption refreshDesktopAfterDecision exists to prevent.
    if (focusedName === entry.name) return;
    // Picking a card by hand overrides a succession already in flight —
    // otherwise the pane you just asked for gets replaced a beat later by
    // whatever the auto-advance had queued up.
    clearDesktopTimers();
    setFocus(entry);
    renderDeckBody(ctx, actions);
  });
  return btn;
}

function buildGridZeroState(ctx, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'dd2-empty';
  const title = document.createElement('div');
  title.className = 'dd2-empty-title';
  title.textContent = 'Nothing matches these filters';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn-tonal dd2-empty-btn';
  resetBtn.textContent = 'Reset filters';
  resetBtn.addEventListener('click', () => resetFiltersAndRerender(ctx, actions));
  wrap.append(title, resetBtn);
  return wrap;
}

function buildMiddle(ctx, actions, pool, fest) {
  const middle = document.createElement('div');
  middle.className = 'dd2-middle';
  const head = document.createElement('div');
  head.className = 'dd2-middle-head';
  const label = document.createElement('span');
  label.className = 'dd2-middle-title';
  label.textContent = 'For you';
  const count = document.createElement('span');
  count.className = 'dd2-middle-count';
  const total = (fest.artists || []).length;
  // Once you have decided anything, the line becomes progress THROUGH the
  // session rather than the size of a shrinking pool — the denominator holds
  // still on purpose, the same way the mobile progress bar does not shorten
  // the track every time you answer.
  const decided = pool.reduce((n, e) => n + (isDecided(e.name, ctx) ? 1 : 0), 0);
  count.textContent = decided
    ? `${decided} of ${pool.length} decided · every card shows why`
    : `${pool.length} of ${total} · every card shows why`;
  head.append(label, count);
  middle.appendChild(head);

  if (!pool.length) {
    middle.appendChild(buildGridZeroState(ctx, actions));
    return middle;
  }

  const grid = document.createElement('div');
  grid.className = 'dd2-grid';
  for (const entry of pool) grid.appendChild(buildGridCard(entry, ctx, actions));
  middle.appendChild(grid);
  return middle;
}

// RIGHT PANE — "pick without leaving the grid": the same bottom action bar as
// the artist page (buildPrimaryActions), sized down, writing through
// the identical state.applyPickLevel/applyPass + actions.applyLocalPick +
// actions.showUndoToast wiring. A decision here re-renders the WHOLE desktop
// body (grid aura updates live) but never touches focusedName/focusedSnapshot
// — the pane stays put by construction.
// Pick cycles ×1 → ×2 → ×3 → clear. From a must it drops straight to ×1:
// Pick and Must are TOGGLES between two states, not a ladder with a locked
// top. It used to return `level` unchanged at 4, which made Pick simply dead
// while a must was set — you had to know to clear Must first, and nothing on
// screen said so (reported 2026-08-02).
function tickNextDesktop(level) {
  if (level === 4) return 1;
  if (level >= 3) return 0;
  return level + 1;
}

// A decision on the desktop pane repaints WHAT THE DECISION CHANGED and
// nothing else. It used to call renderDeckBody, which wipes the overlay and
// destroys the live player — so every pick, must and pass stopped the audio
// and reset the video mid-listen (reported 2026-08-04). The pane is where you
// are listening; reaching a verdict on an artist is not a reason to interrupt
// them, and on desktop the deck is explicitly a "pick without leaving the
// grid" surface, which the restart made a lie.
//
// Surgical rather than a re-render that hands the player over to the new host.
// player.js does expose handoverTo, but the embed is a live <iframe> and
// reparenting one reloads it in every engine that matters — and renderDeckBody
// detaches it from the document first anyway, which is fatal on its own. The
// only guaranteed way to keep a stream alive is to leave its DOM subtree
// completely alone, so this never touches .dd2-pane-body.
//
// What a decision actually changes: the grid (aura, who-corner, the NOT FOR ME
// chip, which cards carry a reason ribbon, pool membership and the count
// line), the pane's hero aura, the pane's reason ribbon — an undecided-only
// affordance — and the pick control itself. The rail and the header read
// facets and the full artist list, and a decision moves neither.
function refreshDesktopAfterDecision(ctx, actions) {
  const overlay = document.getElementById(OVERLAY_ID);
  const body = overlay && overlay.querySelector('.dd2-body');
  const pane = body && body.querySelector('.dd2-pane');
  // No desktop body or no pane means there is no live player to protect (the
  // mobile layout, or a pane showing its zero state). The ordinary path is
  // correct there and cheaper to trust than a second set of edge cases.
  if (!body || !pane) { renderDeckBody(ctx, actions); return; }

  const facets = loadFacets(ctx.fid);
  const fest = state.FESTIVALS[ctx.fid] || {};
  // Same merged shape renderDesktopBody uses. Dropping the query here would
  // change the session key on every decision, rebuilding the succession from
  // the WHOLE lineup while the rail's search box still shows the words that
  // narrowed it.
  const pool = ensureDesktopSession(ctx, { ...facets, q: deckQuery });

  const oldMiddle = body.querySelector('.dd2-middle');
  if (oldMiddle) body.replaceChild(buildMiddle(ctx, actions, pool, fest), oldMiddle);

  const name = focusedName;
  if (!name) return;
  // Keep the snapshot tracking the live ranking exactly as resolveFocusEntry
  // would have. A decision can drop the artist out of the pool (Show =
  // Undecided), and when it does the frozen snapshot is what the pane keeps
  // reading — the same "never yank the pane mid-thought" rule that already
  // governs which artist is focused.
  const live = pool.find((e) => e.name === name);
  if (live) focusedSnapshot = live;
  const entry = focusedSnapshot;

  const heroBg = pane.querySelector('.dd2-pane-hero-bg');
  if (heroBg) heroBg.style.background = auraBackground(cardPeopleFor(name, ctx)).background;

  // The reason ribbon STAYS through a decision. It used to be undecided-only,
  // so the instant you picked, the tag vanished, the pane got shorter and the
  // action bar jumped up under the cursor — in the middle of a multi-tap Pick,
  // the one interaction on this surface that cannot afford a moving target
  // (reported 2026-08-04). It is also still TRUE: "Byron has this as a must"
  // does not stop being why we put this artist in front of you because you
  // agreed with it.
  const paneBody = pane.querySelector('.dd2-pane-body');
  const oldReason = pane.querySelector('.dd2-pane-reason');
  if (entry && entry.reason) {
    if (oldReason) oldReason.textContent = entry.reason.text;
    else if (paneBody) {
      const ribbon = document.createElement('div');
      ribbon.className = 'dd2-pane-reason';
      ribbon.textContent = entry.reason.text;
      paneBody.insertBefore(ribbon, paneBody.firstChild); // above the player, as buildFocusPane places it
    }
  }

  // REBUILT, not repainted through paintPrimaryActions: the control's handlers
  // close over the level they were built with, so a repainted row would
  // compute its next tick from a stale base and the second tap would go
  // somewhere nobody asked for.
  const oldActions = pane.querySelector('.dd2-pane-actions');
  if (oldActions) pane.replaceChild(buildPanePickControl(name, ctx, actions), oldActions);
}

// ---- desktop succession ---------------------------------------------------------------
// "The idea of the discover experience is that we're going through the artists
// in succession" (2026-08-04). The desktop pane used to just sit there after a
// decision, which made the grid the thing you had to drive by hand; now a
// decision holds for a beat so you SEE it land, the pane leaves in the same
// direction the mobile card would have, and the next undecided artist arrives.
//
// Pick gets the full 1s idle window instead of the short hold, and that is not
// a detail: Pick is a CYCLE here (×1 → ×2 → ×3 → clear), so advancing on the
// first tap would put every level above ×1 out of reach. Same reasoning as the
// mobile deck's PICK_IDLE_MS, which is the constant it reuses.
const DESKTOP_HOLD_MS = 420;
const DESKTOP_EXIT_MS = 300;

// The next artist you have NOT decided on, wrapping once so a session that was
// worked out of order still finds the gaps. Null when everything is decided —
// there is nowhere to go, and yanking the pane somewhere arbitrary would be
// worse than staying put.
function nextDesktopEntry(list, fromName, ctx) {
  if (!list.length) return null;
  const at = list.findIndex((e) => e.name === fromName);
  const start = at < 0 ? -1 : at;
  for (let i = 1; i <= list.length; i++) {
    const cand = list[(start + i + list.length) % list.length];
    if (!isDecided(cand.name, ctx)) return cand;
  }
  return null;
}

function advanceDesktopFocus(ctx, actions, kind) {
  const overlay = document.getElementById(OVERLAY_ID);
  const body = overlay && overlay.querySelector('.dd2-body');
  const pane = body && body.querySelector('.dd2-pane');
  if (!body || !pane) return;
  const next = nextDesktopEntry(desktopOrder || [], focusedName, ctx);
  if (!next || next.name === focusedName) return;

  // Only the PANE is replaced. The grid and the rail are already correct — the
  // decision repainted them — and rebuilding them would throw away scroll
  // position for no reason.
  const swap = () => {
    desktopExitTimer = null;
    setFocus(next);
    const fresh = buildFocusPane(ctx, actions, next, currentCanonData);
    if (!REDUCED_MOTION()) {
      fresh.classList.add('is-entering');
      // Drop the class once it has done its job. A finished no-fill animation
      // is inert, but leaving it on means the NEXT decision adds is-exiting to
      // a node still carrying an animation rule, and the two would be arguing
      // over transform on the same element.
      fresh.addEventListener('animationend', () => fresh.classList.remove('is-entering'), { once: true });
    }
    if (pane.parentNode === body) body.replaceChild(fresh, pane);
  };

  if (REDUCED_MOTION()) { swap(); return; }
  // The mobile card's directions, so the two surfaces mean the same thing by
  // the same movement: a decline leaves LEFT, a pick or a must leaves RIGHT.
  // Motion carries no meaning on its own here either — the grid stamp and the
  // undo toast are what actually say what happened.
  pane.dataset.exit = kind === 'pass' ? 'left' : 'right';
  pane.classList.add('is-exiting');
  desktopExitTimer = schedule(actions, swap, DESKTOP_EXIT_MS);
}

// Every decision routes through here so there is exactly one rule about when
// the deck moves on — and exactly one place that cancels a move already queued.
function scheduleDesktopAdvance(ctx, actions, artistName, kind, delay) {
  clearDesktopTimers();
  // A tap that leaves the artist UNDECIDED is a correction, not a decision:
  // cycling Pick round to clear, or toggling a must back off. Moving on from
  // one would strand you on the next artist with the thing you just undid
  // sitting behind you.
  if (!isDecided(artistName, ctx)) return;
  desktopSettleTimer = schedule(actions, () => {
    desktopSettleTimer = null;
    advanceDesktopFocus(ctx, actions, kind);
  }, delay);
}

function paneWritePick(artistName, level, ctx, actions) {
  const before = myLevel(artistName, ctx);
  state.applyPickLevel(ctx.fid, artistName, ctx.meName, level);
  actions.applyLocalPick(artistName, ctx.meName, level);
  if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  ctx.onNotesChange();
  refreshDesktopAfterDecision(ctx, actions);
  // A must lands immediately; a pick waits out the cycle it just opened.
  scheduleDesktopAdvance(ctx, actions, artistName, level === 4 ? 'must' : 'pick',
    level === 4 ? DESKTOP_HOLD_MS : PICK_IDLE_MS);
  if (before === 4 && level === 0 && actions.showUndoToast) {
    actions.showUndoToast(`Cleared your must for ${artistName}`, () => {
      clearDesktopTimers(); // an undo cancels the move it was about to trigger
      state.applyPickLevel(ctx.fid, artistName, ctx.meName, 4);
      actions.applyLocalPick(artistName, ctx.meName, 4);
      if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
      ctx.onNotesChange();
      refreshDesktopAfterDecision(ctx, actions);
    });
  }
}

function paneWritePass(artistName, on, ctx, actions) {
  state.applyPass(ctx.fid, artistName, ctx.meName, on);
  if (on) actions.applyLocalPick(artistName, ctx.meName, 0);
  if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  ctx.onNotesChange();
  refreshDesktopAfterDecision(ctx, actions);
  scheduleDesktopAdvance(ctx, actions, artistName, 'pass', DESKTOP_HOLD_MS);
  if (on && actions.showUndoToast) {
    actions.showUndoToast(`Passed on ${artistName}`, () => {
      clearDesktopTimers(); // an undo cancels the move it was about to trigger
      state.applyPass(ctx.fid, artistName, ctx.meName, false);
      if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
      ctx.onNotesChange();
      refreshDesktopAfterDecision(ctx, actions);
    });
  }
}

// The focus pane "closes with the same bottom action bar as the artist page:
// one pick vocabulary across deck, pane and page" (screens 5c, 2026-08-01).
// It sits at the FOOT of the pane, under the player — the pane's headline
// tick is gone for the same reason the artist page's is.
function buildPanePickControl(artistName, ctx, actions) {
  const level = myLevel(artistName, ctx);
  const passed = model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);

  const wrap = document.createElement('div');
  wrap.className = 'dd2-pane-actions';
  const row = buildPrimaryActions({
    onPass: () => paneWritePass(artistName, !passed, ctx, actions),
    onPick: () => {
      const next = tickNextDesktop(level);
      if (next === level) return;
      paneWritePick(artistName, next, ctx, actions);
    },
    onMust: () => paneWritePick(artistName, level === 4 ? 0 : 4, ctx, actions),
    level,
  });
  const pass = row.querySelector('.dd-btn-pass');
  if (pass) pass.classList.toggle('is-on', passed);
  wrap.appendChild(row);
  return wrap;
}

function buildPaneEmptyState(ctx, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'dd2-pane-empty';
  const title = document.createElement('div');
  title.className = 'dd2-pane-empty-title';
  title.textContent = 'Nothing to sample';
  const sub = document.createElement('div');
  sub.className = 'dd2-pane-empty-sub';
  sub.textContent = 'No artists match these filters.';
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn-tonal dd2-pane-empty-btn';
  resetBtn.textContent = 'Reset filters';
  resetBtn.addEventListener('click', () => resetFiltersAndRerender(ctx, actions));
  wrap.append(title, sub, resetBtn);
  return wrap;
}

function buildFocusPane(ctx, actions, focusEntry, canonData) {
  const pane = document.createElement('div');
  pane.className = 'dd2-pane';
  if (!focusEntry) {
    pane.appendChild(buildPaneEmptyState(ctx, actions));
    return pane;
  }

  const fest = state.FESTIVALS[ctx.fid] || {};
  const meta = findArtistMeta(fest, focusEntry.name);

  const hero = document.createElement('div');
  hero.className = 'dd2-pane-hero';
  const bg = document.createElement('div');
  bg.className = 'dd2-pane-hero-bg';
  const people = cardPeopleFor(focusEntry.name, ctx);
  bg.style.background = auraBackground(people).background;
  const grain = document.createElement('div');
  grain.className = 'hero-grain';
  const content = document.createElement('div');
  content.className = 'dd2-pane-hero-content';

  const label = document.createElement('div');
  label.className = 'dd2-pane-label';
  label.textContent = 'NOW SAMPLING';

  const row = document.createElement('div');
  row.className = 'dd2-pane-hero-row';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'dd2-pane-namewrap';
  const nm = document.createElement('div');
  nm.className = 'dd2-pane-name';
  nm.textContent = focusEntry.name;
  nameWrap.appendChild(nm);
  const genreLine = [focusEntry.primary, ...(focusEntry.secondary || [])].filter(Boolean).join(' · ');
  if (genreLine) {
    const genre = document.createElement('div');
    genre.className = 'dd2-pane-genre';
    genre.textContent = genreLine;
    nameWrap.appendChild(genre);
  }
  row.append(nameWrap);
  content.append(label, row);
  hero.append(bg, grain, content);
  pane.appendChild(hero);

  const body = document.createElement('div');
  body.className = 'dd2-pane-body';

  // Shown whether or not you have decided — see refreshDesktopAfterDecision:
  // a ribbon that disappears on decision moves the action bar mid-multi-tap,
  // and the reason is still the reason.
  if (focusEntry.reason) {
    const ribbon = document.createElement('div');
    ribbon.className = 'dd2-pane-reason';
    ribbon.textContent = focusEntry.reason.text;
    body.appendChild(ribbon);
  }

  const playerHost = document.createElement('div');
  body.appendChild(playerHost);
  const { primary, secondary } = canonicalize(meta.genres, canonData);
  const playerGenres = [primary, ...secondary].filter(Boolean);
  const sources = {
    youtubeVideoIds: meta.youtubeVideoIds,
    youtubeLabels: meta.youtubeLabels,
    soundcloudSlug: meta.soundcloudSlug,
    spotifyId: meta.spotifyId,
  };
  // "The pane runs the FULL player, not the mini one — the first 30 seconds
  // of a set tells you nothing, so a draggable scrubber is non-negotiable"
  // (screens 5c, 2026-08-01). The pane has the room for a 16:9 stage; the
  // 82x46 thumb was a mobile compromise being paid for on a 1440 canvas.
  playerHandle = mountOrCarry(actions, {
    host: playerHost, artist: { name: focusEntry.name, genres: playerGenres }, sources, layout: 'full',
    autoplay: soundIntent,
    onStateChange: (snap, meta) => { if (!meta || !meta.autoplayRefused) soundIntent = snap.play; },
  });

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'dd2-pane-open';
  openBtn.textContent = 'Open full artist page ›';
  openBtn.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(focusEntry.name); });
  body.appendChild(openBtn);

  pane.appendChild(body);
  pane.appendChild(buildPanePickControl(focusEntry.name, ctx, actions));
  return pane;
}

// HEADER — festival name (Anton, the fest accent: this surface's one allowed
// place for it, per repo law), then the same three destinations the phone's
// nav strip carries: Wall (closes back to the app screen), Discover (active),
// My Day (scheduled fests only). "Wall" is one destination before and after
// set times drop — the lineup list becomes a timetable, it does not become a
// different place — so the tab that used to relabel itself "Timetable" was
// naming a view, not a destination (design 6e). Right: the sync
// dot and a crew chip. The dot is a bare `.sync-dot` — sync.js's own
// setSyncStatus() does `querySelectorAll('.sync-dot')` on every status
// change, so this element gets the SAME live updates the dock/rail dots get
// for free; its class is seeded from an existing dot so the very first paint
// (before the next sync tick) isn't wrong either.
function buildDesktopHeader(ctx, actions, fest, scheduled) {
  const header = document.createElement('div');
  header.className = 'dd2-header';

  const left = document.createElement('div');
  left.className = 'dd2-header-left';
  const festName = document.createElement('span');
  festName.className = 'dd2-fest-name';
  festName.textContent = `${fest.name || ''} ${fest.year || ''}`.trim().toUpperCase();
  left.appendChild(festName);

  const nav = document.createElement('nav');
  nav.className = 'dd2-nav';
  nav.setAttribute('aria-label', 'Views');

  const wallTab = document.createElement('button');
  wallTab.type = 'button';
  wallTab.className = 'dd2-navtab';
  wallTab.textContent = 'Wall';
  wallTab.setAttribute('aria-label', `Close Discover — back to the ${scheduled ? 'timetable' : 'wall'}`);
  wallTab.addEventListener('click', () => { if (!router.requestClose()) closeDeck(); });
  nav.appendChild(wallTab);

  const discoverTab = document.createElement('span');
  discoverTab.className = 'dd2-navtab dd2-navtab-active';
  discoverTab.setAttribute('aria-current', 'page');
  discoverTab.textContent = 'Discover';
  nav.appendChild(discoverTab);

  if (scheduled) {
    const myDayTab = document.createElement('button');
    myDayTab.type = 'button';
    myDayTab.className = 'dd2-navtab';
    myDayTab.textContent = 'My Day';
    myDayTab.setAttribute('aria-label', 'Open your day — gaps and clashes');
    myDayTab.addEventListener('click', () => {
      if (!ctx.meName || ctx.migrationPending) return;
      // Lazy import — see the top-of-file note on why this isn't static.
      import('./my-day.js').then(({ openMyDay }) => {
        openMyDay(ctx, actions);
        router.push('myday');
      });
    });
    nav.appendChild(myDayTab);
  }
  left.appendChild(nav);

  const right = document.createElement('div');
  right.className = 'dd2-header-right';
  const existingDot = document.querySelector('.sync-dot');
  const dot = document.createElement('span');
  dot.className = existingDot ? existingDot.className : 'sync-dot';
  right.appendChild(dot);

  const crewChip = document.createElement('span');
  crewChip.className = 'dd2-crew-chip';
  if (ctx.meName) {
    const pill = document.createElement('span');
    pill.className = 'dd2-crew-pill';
    pill.setAttribute('aria-hidden', 'true');
    const ci = colorIndexOf(ctx.meName, state.people()[ctx.meName]);
    pill.style.background = hslOf(ci, 0.5);
    pill.style.border = '1px solid ' + strokeOf(ci, true);
    pill.textContent = ctx.meName.charAt(0).toUpperCase();
    crewChip.appendChild(pill);
  }
  const crewNameEl = document.createElement('span');
  crewNameEl.textContent = state.crewName();
  crewChip.appendChild(crewNameEl);
  right.appendChild(crewChip);

  header.append(left, right);
  return header;
}

function renderDesktopBody(overlay, ctx, actions, facets) {
  const fest = state.FESTIVALS[ctx.fid] || {};
  const scheduled = !!(fest.days && Object.keys(fest.days).length);
  // The rail's query rides alongside the persisted facets, never inside them —
  // and it goes THROUGH the desktop session rather than around it. The session
  // is keyed on the facets object, so a typed query re-derives the succession's
  // order instead of quietly handing the grid a pool the succession never saw.
  const pool = ensureDesktopSession(ctx, { ...facets, q: deckQuery });
  const focusEntry = resolveFocusEntry(pool);

  const shell = document.createElement('div');
  shell.className = 'dd2-shell';
  shell.appendChild(buildDesktopHeader(ctx, actions, fest, scheduled));

  const body = document.createElement('div');
  body.className = 'dd2-body';
  body.appendChild(buildRail(ctx, actions, facets, fest, currentCanonData, scheduled));
  body.appendChild(buildMiddle(ctx, actions, pool, fest));
  body.appendChild(buildFocusPane(ctx, actions, focusEntry, currentCanonData));
  shell.appendChild(body);

  overlay.appendChild(shell);
}

// Back · DISCOVER · Filter. Extracted so the in-place advance below can rebuild
// it without going through a full render.
function buildTopBar(ctx, facets, actions) {
  const topBar = document.createElement('div');
  topBar.className = 'dd-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'dd-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Close Discover');
  back.addEventListener('click', () => { if (!router.requestClose()) closeDeck(); });
  const title = document.createElement('div');
  title.className = 'dd-title';
  title.textContent = 'DISCOVER';
  // The counter rides with Filter instead of owning a row below. It is the one
  // piece of the old header worth its pixels — "where am I in this stack" — and
  // it costs nothing here because the row already exists.
  const right = document.createElement('div');
  right.className = 'dd-topbar-right';
  if (session && session.pool.length) {
    const counter = document.createElement('span');
    counter.className = 'dd-counter';
    counter.textContent = `${Math.min(session.position + 1, session.pool.length)} / ${session.pool.length}`;
    right.appendChild(counter);
  }
  right.appendChild(buildFilterButton(ctx, facets, actions));
  topBar.append(back, title, right);
  return topBar;
}

// ---- advancing WITHOUT moving the player ------------------------------------------
// The deck used to answer every change by wiping the overlay and building it
// again, which meant the sample player was reparented into a fresh card on
// every advance. On iOS that is fatal to playback: WebKit re-creates an
// iframe's browsing context on ANY reparent, even one where the element never
// leaves the document (measured, design/ios-playback-probe step 5B — onReady
// fired a second time and the gesture unlock was gone with it). Rebuilding also
// made every card pay for a fresh embed load, and SoundCloud re-walk its
// getSounds() list from scratch, on the surface people move through fastest.
//
// So the mobile deck now has two paths. When only the ARTIST changed, this one
// keeps the two elements the embed hangs from — the stage and the player host —
// and replaces everything else wholesale. Wholesale is the point: nothing is
// patched field by field, so no detail of the previous artist can survive onto
// the next. The exception list is two elements long and written down here.
//
// Returns false when it cannot do it in place, and the caller falls back to the
// full build that has always worked.
function refreshDeckInPlace(ctx, actions) {
  const overlay = document.getElementById(OVERLAY_ID);
  const shell = overlay && overlay.querySelector('.dd-shell');
  const stage = shell && shell.querySelector('.dd-stage');
  const card = stage && stage.querySelector('.dd-card');
  const host = card && card.querySelector('.dd-player-host');
  const stack = stage && stage.querySelector('.dd-stack');
  if (!shell || !stage || !card || !host || !stack) return false;
  if (!playerHandle || typeof playerHandle.remountFor !== 'function') return false;
  if (!session || !session.pool.length || session.position >= session.pool.length) return false;

  const entry = session.pool[session.position];
  const facets = loadFacets(ctx.fid);

  // Everything above and below the stage is cheap and owns no embed.
  for (const el of [...shell.children]) if (el !== stage) el.remove();
  shell.insertBefore(buildTopBar(ctx, facets, actions), stage);
  shell.appendChild(buildActionBar(ctx, actions));

  // The card carried the exit transform out of the last decision; it comes back
  // to rest here, and the ghosts/hint/celebrate around it are rebuilt fresh.
  // The card ELEMENT is reused, so every per-card flag the last decision left on
  // it has to come off by hand — the full rebuild got this for free by building
  // a new node, and that is exactly why the in-place path keeps losing one.
  //
  // data-intent is the one that shows: it paints the intent a drag is ABOUT to
  // commit, and a stale "pass" carries `filter: grayscale(.7) brightness(.82)`
  // onto the NEXT artist, which arrives looking washed out and black instead of
  // purple, for no reason a reader could ever find in that artist's data
  // (reported 2026-08-06 against Westend, whose genres and reason were both
  // fine — the artist was never the variable, the previous swipe was). A stale
  // "pick"/"must" is the same bug wearing the opposite colour: an undecided
  // card showing the aura of a decision nobody made on it.
  //
  // is-settling is the snap-back transition and would otherwise animate the
  // incoming card's first transform.
  card.classList.remove('is-exiting', 'is-settling');
  card.dataset.intent = '';
  card.style.transform = '';
  card.style.opacity = '';
  card.scrollTop = 0;
  for (const el of [...stack.children]) if (el !== card) el.remove();
  const ghost2 = document.createElement('div');
  ghost2.className = 'dd-ghost dd-ghost-2';
  ghost2.setAttribute('aria-hidden', 'true');
  const ghost1 = document.createElement('div');
  ghost1.className = 'dd-ghost dd-ghost-1';
  ghost1.setAttribute('aria-hidden', 'true');
  stack.insertBefore(ghost2, card);
  stack.insertBefore(ghost1, card);
  const hint = document.createElement('div');
  hint.className = 'dd-hint';
  hint.setAttribute('aria-hidden', 'true');
  stack.append(hint, buildCelebrateOverlay());

  paintCard(card, entry, ctx);

  // Same host object, so the player is not moved at all — remountFor sees a
  // host it is already inside and re-points the embed without touching the DOM
  // above it.
  const fest = state.FESTIVALS[ctx.fid] || {};
  const meta = findArtistMeta(fest, entry.name);
  const { primary, secondary } = canonicalize(meta.genres, currentCanonData);
  playerHandle.remountFor({
    host, layout: 'compact',
    artist: { name: entry.name, genres: [primary, ...secondary].filter(Boolean) },
    sources: {
      youtubeVideoIds: meta.youtubeVideoIds,
      youtubeLabels: meta.youtubeLabels,
      soundcloudSlug: meta.soundcloudSlug,
      spotifyId: meta.spotifyId,
    },
    autoplay: soundIntent,
  });

  wireSwipe(stack, ctx, actions);
  return true;
}

// ---- deck body (re-rendered on every advance/undo/filter change) -------------------
let currentCanonData = null;
function renderDeckBody(ctx, actions) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const facets = loadFacets(ctx.fid);
  // Typing in the rail's search box re-renders this whole tree, which throws
  // away the element the caret was in — the same problem wall.js solves with
  // harvestEphemera. One input, so one small copy of it rather than a shared
  // helper: remember where the caret was, put it back after the rebuild.
  const active = document.activeElement;
  const caret = (active && active.id === 'dd2-search-input')
    ? { id: active.id, pos: active.selectionStart } : null;
  // Detach the live player BEFORE the tree is wiped, so wiping it does not
  // take the embed with it. It is re-hosted a few lines later by mountOrCarry
  // -> remountFor, whose appendChild MOVES the still-connected node; that is
  // what preserves the iframe (and, on iOS, the gesture unlock that lets it
  // keep playing). "ONE PLAYER, ALWAYS" is unchanged — there is still exactly
  // one, it just outlives the DOM around it now instead of being rebuilt with
  // it. If anything below fails to re-home it, destroy() still runs on the
  // next close and the orphan is a detached node, not a second player.
  const carried = playerHandle && typeof playerHandle.remountFor === 'function';
  if (carried) parkPlayerRoot();
  overlay.textContent = '';
  if (!carried && playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }

  if (isDesktopLayout()) {
    renderDesktopBody(overlay, ctx, actions, facets);
    if (caret) {
      const back = document.getElementById(caret.id);
      if (back) {
        back.focus();
        try { back.setSelectionRange(caret.pos, caret.pos); } catch { /* type quirks */ }
      }
    }
    return;
  }

  const shell = document.createElement('div');
  shell.className = 'dd-shell';

  shell.appendChild(buildTopBar(ctx, facets, actions));

  const stageWrap = document.createElement('div');
  stageWrap.className = 'dd-stage';

  if (!session.pool.length || session.position >= session.pool.length) {
    stageWrap.appendChild(buildCompletion(ctx, facets, actions));
    shell.appendChild(stageWrap);
    overlay.appendChild(shell);
    return;
  }

  const entry = session.pool[session.position];
  const cardStack = buildCard(entry, ctx, actions, currentCanonData);
  stageWrap.appendChild(cardStack);
  shell.appendChild(stageWrap);
  shell.appendChild(buildActionBar(ctx, actions));
  overlay.appendChild(shell);
  wireSwipe(cardStack, ctx, actions);
}

// ---- overlay lifecycle ----------------------------------------------------------------
function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'discover-deck';
  document.body.appendChild(overlay);
  dialogize(overlay, 'Discover');
  return overlay;
}

// The mobile dock (person / day tabs / fest name) sits at z-index 30 and the
// deck overlay at 34, so while the deck is open the dock is painted over and
// invisible — but still rendered, still laying out, still repainting behind a
// full-screen overlay nobody can see it through. Hiding it is the honest
// statement of what is already true on screen.
//
// A NOTE ON HEIGHT, because it is the obvious thing to assume and it is wrong:
// this reclaims none. The overlay is position:fixed over the whole viewport and
// .dd-actions already runs to the bottom edge (measured 2026-08-06: action bar
// bottom gap = 0), so the deck was never yielding those 45px to begin with.
// `.dock.hidden` is v3's own mechanism — app.js already uses it when the wall's
// search field takes focus — so this is that switch, not a new one.
function setDockHidden(hidden) {
  const dock = document.getElementById('dock');
  if (dock) dock.classList.toggle('hidden', hidden);
}

export function openDeck(ctx, actions = {}) {
  ensureOverlay();
  deckOpen = true;
  setDockHidden(true);
  forcedLayout = null; // real usage always defers to the real matchMedia, regardless of any test residue
  watchLayout(ctx, actions);
  const gen = ++pendingOpenGen;
  const finish = (canonData) => {
    if (gen !== pendingOpenGen) return; // superseded by a newer open/close
    currentCanonData = canonData;
    if (!session) startSession(ctx, loadFacets(ctx.fid), canonData);
    renderDeckBody(ctx, actions);
  };
  if (actions.canonData) finish(actions.canonData);
  else loadGenreCanon().then(finish);
}

export function closeDeck() {
  // Before anything else: a pick timer that fires after the deck is gone would
  // write a level onto whatever card the next session deals at that index.
  clearDeckTimers();
  setDockHidden(false);
  resetDesktopSession(); // a fresh open deals a fresh session on desktop too
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }
  unwatchLayout();
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  deckOpen = false;
  session = null; // a fresh open deals a fresh session, per spec
  deckQuery = ''; // and a fresh search box — the query was for this visit
  soundIntent = false; // opening Discover is never itself a request for sound
  removePlayerPark();
  setFocus(null); // desktop's right-pane focus is per-open too
  pendingOpenGen++;
}

export function isDeckOpen() { return deckOpen; }

// Re-render the open deck in place, preserving session/focus module state.
// The artist page's close path calls this: stacking the page tore down the
// deck's live player (one instance, always), and the router's layer diff
// never re-invokes open() for a layer that didn't change — so without this
// the card/pane resurfaced with an empty player host. Latent since M4,
// surfaced by the 5c focus pane. The remounted player is paused, per the
// no-autoplay-on-mount rule.
export function refreshOpenDeck(ctx, actions = {}) {
  if (!deckOpen || !currentCanonData) return;
  renderDeckBody(ctx, actions);
}

// ---- filter sheet -------------------------------------------------------------------
function segRow(labelText, options, current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'dd-filter-field';
  const lbl = document.createElement('div');
  lbl.className = 'dd-filter-label';
  lbl.textContent = labelText;
  const seg = document.createElement('div');
  seg.className = 'dd-seg';
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg' + (opt.value === current ? ' active' : '');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => onPick(opt.value));
    seg.appendChild(btn);
  }
  wrap.append(lbl, seg);
  return wrap;
}

function toggleField(titleText, subText, checked, onFlip) {
  const row = document.createElement('div');
  row.className = 'list-row dd-toggle-row';
  const left = document.createElement('div');
  left.style.flex = '1';
  const t = document.createElement('div');
  t.className = 'row-title';
  t.textContent = titleText;
  left.appendChild(t);
  if (subText) {
    const s = document.createElement('div');
    s.className = 'row-sub';
    s.textContent = subText;
    left.appendChild(s);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(!!checked));
  toggle.setAttribute('aria-label', titleText);
  const knob = document.createElement('span');
  knob.className = 'toggle-knob';
  toggle.appendChild(knob);
  toggle.addEventListener('click', () => {
    const now = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(now));
    onFlip(now);
  });
  row.append(left, toggle);
  return row;
}

export function openDiscoverFilterSheet(ctx, actions = {}) {
  rememberOpener();
  const existingBackdrop = document.getElementById('sheet-backdrop');
  if (existingBackdrop) closeSheet();
  const backdrop = document.createElement('div');
  // dd-scrim opts this backdrop into the style guide's scrim fade. Scoped to
  // Discovery rather than applied to .sheet-backdrop globally: the app's other
  // sheets (notes, settings, tools) are Kevin's v3 chrome and are not this
  // design's to restyle.
  backdrop.className = 'sheet-backdrop dd-scrim';
  backdrop.id = 'sheet-backdrop';
  backdrop.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
  const sheet = document.createElement('div');
  // dd-sheet swaps v3's scale-fade for the spec'd slide-up at the sheet token.
  sheet.className = 'sheet dd-sheet';
  sheet.id = 'artist-sheet';
  sheetChrome(sheet, 'NARROW WHAT YOU’RE SHOWN');

  const fest = state.FESTIVALS[ctx.fid] || {};
  const canonData = currentCanonData || { canon: [], synonyms: {}, suppress: [] };
  let draft = { ...loadFacets(ctx.fid) };

  const body = document.createElement('div');
  body.className = 'dd-filter-body';
  sheet.appendChild(body);

  const footer = document.createElement('button');
  footer.type = 'button';
  footer.className = 'dd-filter-cta';
  sheet.appendChild(footer);

  function liveCount() {
    return buildPool({ ...ctx }, draft, canonData).length;
  }

  function paint() {
    body.textContent = '';

    body.appendChild(segRow('Sort — top picks first', [
      { value: 'foryou', label: 'For you' },
      { value: 'popularity', label: 'Popularity' },
      { value: 'az', label: 'A–Z' },
    ], draft.sort, (v) => { draft = { ...draft, sort: v }; paint(); }));

    body.appendChild(segRow('Show', [
      { value: 'undecided', label: 'Undecided' },
      { value: 'passed', label: 'Passed' },
      { value: 'all', label: 'All' },
    ], draft.show, (v) => { draft = { ...draft, show: v }; paint(); }));

    const genresField = document.createElement('div');
    genresField.className = 'dd-filter-field';
    const gLabel = document.createElement('div');
    gLabel.className = 'dd-filter-label';
    gLabel.textContent = 'Genres';
    genresField.appendChild(gLabel);
    const chipsRow = document.createElement('div');
    chipsRow.className = 'dd-chip-row';
    const genres = availableGenres(fest.artists || [], canonData);
    for (const g of genres) {
      const on = draft.genres.includes(g);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dd-filter-chip' + (on ? ' active' : '');
      chip.textContent = on ? `${g} ✓` : g;
      chip.addEventListener('click', () => {
        draft = { ...draft, genres: on ? draft.genres.filter((x) => x !== g) : [...draft.genres, g] };
        paint();
      });
      chipsRow.appendChild(chip);
    }
    genresField.appendChild(chipsRow);
    body.appendChild(genresField);

    const days = availableDays(fest.artists || []);
    if (days.length) {
      // Prefer the curated weekday abbreviation (fest.dayMeta) over the raw
      // day token — "Day 1" reads fine full-length, but a scheduled fest's
      // dayMeta gives "THU" etc., matching the day rail elsewhere in the app.
      const dayLabel = (d) => {
        const wd = (fest.dayMeta || {})[d]?.wd;
        return wd ? wd.slice(0, 3).toUpperCase() : d;
      };
      body.appendChild(segRow('Day', [
        { value: 'all', label: 'All' },
        ...days.map((d) => ({ value: d, label: dayLabel(d) })),
      ], draft.day, (v) => { draft = { ...draft, day: v }; paint(); }));
    }

    const togglesWrap = document.createElement('div');
    togglesWrap.className = 'dd-toggles';
    togglesWrap.appendChild(toggleField(
      'Picked by the crew', 'someone else picked, you haven’t decided',
      draft.crewPicked, (v) => { draft = { ...draft, crewPicked: v }; paint(); },
    ));
    togglesWrap.appendChild(toggleField(
      'Has a live set to sample', null,
      draft.hasLiveSet, (v) => { draft = { ...draft, hasLiveSet: v }; paint(); },
    ));
    // Live on timed festivals (build spec 7.4/M6 — js/discovery/gaps.js);
    // stays hidden entirely on a lineup-only festival, which has no set
    // times to compute a gap against (never a control that silently does
    // nothing).
    const scheduled = !!(fest.days && Object.keys(fest.days).length);
    if (scheduled) {
      togglesWrap.appendChild(toggleField(
        'Playing in my open gaps', 'undecided artists actually on then',
        draft.gap, (v) => { draft = { ...draft, gap: v }; paint(); },
      ));
    }
    body.appendChild(togglesWrap);

    const n = liveCount();
    footer.textContent = n === 0 ? '0 artists — Reset filters' : `Show ${n} artist${n === 1 ? '' : 's'}`;
    footer.classList.toggle('dd-filter-cta-empty', n === 0);
  }

  footer.addEventListener('click', () => {
    const n = liveCount();
    // Zero results: the tap itself resets AND commits — the escape hatch has
    // to actually get you unstuck in one tap, not just repaint the sheet.
    const toCommit = n === 0 ? { ...DEFAULT_FACETS, genres: [] } : draft;
    saveFacets(ctx.fid, toCommit);
    if (session) startSession(ctx, toCommit, canonData);
    renderDeckBody(ctx, actions);
    if (!router.requestClose()) closeSheet();
  });

  paint();
  document.body.append(backdrop, sheet);
  dialogize(sheet, 'Filter the discovery pool');
}

// Exposed for tests only — the pure-ish render core, callable without the
// async canon load or the router. Mirrors artist-page.js's
// renderArtistPageForTest. Forces the mobile layout explicitly — jsdom has no
// real matchMedia, so without this every existing mobile-deck test would be
// at the mercy of isDesktopLayout()'s try/catch fallback rather than an
// intentional choice.
export function renderDeckForTest(ctx, actions, canonData) {
  ensureOverlay();
  deckOpen = true;
  forcedLayout = 'mobile';
  currentCanonData = canonData || { canon: [], synonyms: {}, suppress: [] };
  session = null;
  setFocus(null);
  startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  renderDeckBody(ctx, actions);
  return document.getElementById(OVERLAY_ID);
}

// Exposed for tests only — same idea as renderDeckForTest, forced to the
// desktop three-pane (frame 5c) instead. jsdom can't cross a real matchMedia
// boundary, so this is the "callable directly" seam the desktop render path
// needs for coverage (build spec's own test-plan note).
export function renderDesktopForTest(ctx, actions, canonData) {
  ensureOverlay();
  deckOpen = true;
  forcedLayout = 'desktop';
  currentCanonData = canonData || { canon: [], synonyms: {}, suppress: [] };
  session = null;
  setFocus(null);
  startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  renderDeckBody(ctx, actions);
  return document.getElementById(OVERLAY_ID);
}
