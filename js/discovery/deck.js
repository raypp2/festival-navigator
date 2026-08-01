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
  session = { pool: buildPool(ctx, facets, canonData), position: 0, decided: 0 };
}

// ---- sub-line copy -----------------------------------------------------------------
function subLineText(ctx, facets) {
  const coldStart = !personHasAnyActivity(ctx.fid, ctx.meName) && activeFacetCount(facets) === 0;
  if (coldStart) return 'Starting from the top of the bill — the names you know';
  const remaining = Math.max(0, session.pool.length - session.position);
  const genres = facets.genres || [];
  if (genres.length) {
    return `${remaining} unheard left — sampling ${genres.join(' & ')}`;
  }
  return `${remaining} unheard left`;
}

// ---- card build ---------------------------------------------------------------------
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
  card.dataset.artist = entry.name;

  const chips = document.createElement('div');
  chips.className = 'dd-chips';
  const genreList = [entry.primary, ...(entry.secondary || [])].filter(Boolean);
  for (const g of genreList) {
    const c = document.createElement('span');
    c.className = 'dd-chip';
    c.textContent = g;
    chips.appendChild(c);
  }
  card.appendChild(chips);

  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'dd-name';
  nameBtn.textContent = entry.name;
  nameBtn.setAttribute('aria-label', `Open ${entry.name}`);
  // The one flow change (build spec §1): every artist name opens the artist
  // page, stacked on top via the `artist:` router layer — same ctx.onTap
  // every other surface (wall, timetable) already routes through.
  nameBtn.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(entry.name); });
  card.appendChild(nameBtn);

  // Exactly one reason ribbon — no reason, no ribbon (score.js's guarantee).
  if (entry.reason) {
    const ribbon = document.createElement('div');
    ribbon.className = 'dd-reason';
    ribbon.textContent = entry.reason.text;
    card.appendChild(ribbon);
  }

  const playerHost = document.createElement('div');
  playerHost.className = 'dd-player-host';
  card.appendChild(playerHost);
  const { primary, secondary } = canonicalize(meta.genres, canonData);
  const playerGenres = [primary, ...secondary].filter(Boolean);
  const sources = {
    youtubeVideoIds: meta.youtubeVideoIds,
    soundcloudSlug: meta.soundcloudSlug,
    spotifyId: meta.spotifyId,
  };
  const mount = (actions && actions.mountPlayer) || realMountPlayer;
  playerHandle = mount({
    host: playerHost, artist: { name: entry.name, genres: playerGenres }, sources, layout: 'compact',
  });

  stack.append(ghost2, ghost1, card);
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
function buildHeader(ctx, facets, actions) {
  const header = document.createElement('div');
  header.className = 'dd-header';

  const top = document.createElement('div');
  top.className = 'dd-header-top';
  const label = document.createElement('div');
  label.className = 'dd-session-label';
  const micro = document.createElement('span');
  micro.className = 'dd-micro-label';
  micro.textContent = 'DISCOVERY SESSION';
  const counter = document.createElement('span');
  counter.className = 'dd-counter';
  counter.textContent = `${Math.min(session.position + 1, session.pool.length)} / ${session.pool.length}`;
  label.append(micro, counter);

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

  top.append(label, filterBtn);

  const bar = document.createElement('div');
  bar.className = 'dd-progress';
  const fill = document.createElement('div');
  fill.className = 'dd-progress-fill';
  const pct = session.pool.length ? Math.min(100, Math.round((session.position / session.pool.length) * 100)) : 0;
  fill.style.width = pct + '%';
  bar.appendChild(fill);

  const sub = document.createElement('div');
  sub.className = 'dd-subline';
  sub.textContent = subLineText(ctx, facets);

  header.append(top, bar, sub);
  return header;
}

// ---- deck-advance motion --------------------------------------------------------------
// "Deck advance — the acted card leaves, the next rises from the stack."
//
// The re-render is synchronous and stays that way: state and DOM move together,
// which is what the deck tests assert on and what keeps a fast tapper from
// racing an animation. So the exit is a CLONE of the outgoing card, layered
// over the freshly-rendered deck and thrown away when it finishes. If it never
// runs — reduced motion, no live card, a browser that skips the event — the
// deck has already advanced correctly and nothing is lost but the flourish.
function captureExitCard() {
  if (REDUCED_MOTION()) return null;
  const live = document.querySelector(`#${OVERLAY_ID} .dd-card`);
  if (!live) return null;
  const rect = live.getBoundingClientRect();
  if (!rect.height) return null;
  const clone = live.cloneNode(true);
  // The clone must never be reachable: no controls, no tab stops, nothing for
  // a screen reader to find. It is a picture of a card that no longer exists.
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  for (const el of clone.querySelectorAll('button, a, input, select, textarea, iframe')) {
    el.setAttribute('tabindex', '-1');
    // An iframe clone would spawn a SECOND embed — one player, always.
    if (el.tagName === 'IFRAME') el.remove();
  }
  return { clone, rect };
}

function spawnExitGhost(captured, kind) {
  if (!captured) return;
  const { clone, rect } = captured;
  const stage = document.querySelector(`#${OVERLAY_ID} .dd-stage`);
  if (!stage) return;
  const layer = document.createElement('div');
  layer.className = `dd-exit dd-exit--${kind === 'must' ? 'must' : kind === 'pass' ? 'pass' : 'pick'}`;
  layer.setAttribute('aria-hidden', 'true');
  layer.appendChild(clone);
  // Geometry comes from the card we actually measured, not from re-deriving
  // the stage's padding in CSS — the stage pads asymmetrically, the completion
  // screen has no card-shaped slot at all, and a ghost that is 20px shorter
  // than the card it replaces squashes visibly at the moment of the swap.
  // (Absolute positioning resolves against the padding box; .dd-stage has no
  // border, so its border-box origin from getBoundingClientRect is that box.)
  const stageRect = stage.getBoundingClientRect();
  layer.style.left = `${rect.left - stageRect.left}px`;
  layer.style.top = `${rect.top - stageRect.top}px`;
  layer.style.width = `${rect.width}px`;
  layer.style.height = `${rect.height}px`;
  layer.style.right = 'auto';
  layer.style.bottom = 'auto';
  stage.appendChild(layer);
  const remove = () => layer.remove();
  layer.addEventListener('animationend', remove);
  // animationend can be skipped entirely (background tab, zero duration, a
  // browser that never fires it) — a ghost that outlives its animation would
  // sit on top of the live deck forever, so time it out regardless.
  setTimeout(remove, 1000);
}

// ---- action bar -----------------------------------------------------------------------
function decide(kind, level, ctx, actions) {
  if (!session || session.position >= session.pool.length) return;
  const entry = session.pool[session.position];
  const name = entry.name;
  const prevLevel = myLevel(name, ctx);
  const prevPassed = model.isPassed(state.crewDoc, ctx.fid, name, ctx.meName);
  const decidedAt = session.position;

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

  // Snapshot the outgoing card BEFORE the re-render blows it away, so it can
  // fly off over the new one. Decorative only — see spawnExitGhost.
  const exiting = captureExitCard();

  commit();
  session.decided++;
  session.position++;
  ctx.onNotesChange();
  renderDeckBody(ctx, actions);
  spawnExitGhost(exiting, kind);

  const label = kind === 'pass' ? `Passed on ${name} — undo`
    : kind === 'must' ? `Made ${name} a must — undo`
      : `Picked ${name} ×1 — undo`;
  if (actions.showUndoToast) {
    actions.showUndoToast(label, () => {
      revert();
      session.decided--;
      session.position = decidedAt;
      ctx.onNotesChange();
      renderDeckBody(ctx, actions);
    });
  }
}

function buildActionBar(ctx, actions) {
  const bar = document.createElement('div');
  bar.className = 'dd-actions';

  const pass = document.createElement('button');
  pass.type = 'button';
  pass.className = 'dd-btn dd-btn-pass';
  pass.textContent = 'Pass';
  pass.addEventListener('click', () => decide('pass', 0, ctx, actions));

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'dd-btn dd-btn-pick';
  pick.textContent = '＋ Pick ×1';
  pick.addEventListener('click', () => decide('pick', 1, ctx, actions));

  const must = document.createElement('button');
  must.type = 'button';
  must.className = 'dd-btn dd-btn-must';
  must.textContent = '★ Must';
  must.addEventListener('click', () => decide('must', 4, ctx, actions));

  bar.append(pass, pick, must);
  return bar;
}

// ---- swipe gestures (feel per Discovery - Swipe Demo.dc.html; every action also
// works as a plain tap — nothing here is load-bearing) ------------------------------
const REDUCED_MOTION = () => {
  try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

function wireSwipe(cardStack, ctx, actions) {
  const card = cardStack.querySelector('.dd-card');
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const THRESHOLD = 90;
  // Up = must is a bigger commitment than a sideways flick and the card has a
  // scrollable body above it, so it asks for a longer, more deliberate pull.
  const UP_THRESHOLD = 110;

  // Which gesture a drag currently IS — decided by the dominant axis, and
  // re-evaluated every move so a drag that starts ambiguous can resolve.
  const gestureOf = (x, y) => (Math.abs(y) > Math.abs(x) ? (y < 0 ? 'up' : null) : (x > 0 ? 'right' : 'left'));

  const clearDrag = () => {
    dragging = false;
    // Settle back under the base token instead of snapping. The class is
    // removed once the transition lands so the next drag is untransitioned.
    if (!REDUCED_MOTION() && card.style.transform) {
      card.classList.add('is-settling');
      const done = () => { card.classList.remove('is-settling'); card.removeEventListener('transitionend', done); };
      card.addEventListener('transitionend', done);
    }
    card.style.transform = '';
    dx = 0; dy = 0;
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // player controls, name button
    dragging = true; startX = e.clientX; startY = e.clientY; dx = 0; dy = 0;
    card.classList.remove('is-settling');
    try { card.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (REDUCED_MOTION()) return;
    // "card follows the finger" — on whichever axis is currently in charge.
    // A downward drag is the card's own scroll (touch-action: pan-y), never a
    // gesture, so it moves nothing.
    const g = gestureOf(dx, dy);
    if (g === 'up') card.style.transform = `translateY(${dy}px) scale(${Math.max(.94, 1 + dy / 2600)})`;
    else if (g) card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    else card.style.transform = '';
  });
  const release = () => {
    if (!dragging) return;
    const g = gestureOf(dx, dy);
    const passed = g === 'up' ? -dy > UP_THRESHOLD : Math.abs(dx) > THRESHOLD;
    clearDrag();
    if (!passed || !g) return;
    // Swipe left = pass, right = pick, up = must — and each is exactly the
    // action its always-visible button performs. No gesture is ever required.
    if (g === 'up') decide('must', 4, ctx, actions);
    else if (g === 'right') decide('pick', 1, ctx, actions);
    else decide('pass', 0, ctx, actions);
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

// LEFT RAIL — the identical facets object + localStorage key the mobile sheet
// edits (openDiscoverFilterSheet below); segRow/toggleField are the same
// builders the sheet uses, just wired to commit immediately instead of into a
// draft. One source of truth, two renderings.
function buildRail(ctx, actions, facets, fest, canonData, scheduled) {
  const rail = document.createElement('div');
  rail.className = 'dd2-rail';

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
  const undecided = lvl < 1 && !entry.passed;
  const showRibbon = undecided && entry.reason && entry.reason.type !== 'crew';
  if (showRibbon) btn.classList.add('has-reason');
  if (entry.passed) btn.classList.add('wall-passed');
  btn.setAttribute('aria-label', `Focus ${entry.name} in the sample pane`);

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
  if (entry.passed) {
    const chip = document.createElement('span');
    chip.className = 'card-passed-chip';
    chip.textContent = 'PASSED';
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

  btn.addEventListener('click', () => {
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
  count.textContent = `${pool.length} of ${total} · every card shows why`;
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

// RIGHT PANE — "pick without leaving the grid": the same headline tick/★/✕
// contract as artist-page.js's buildPickControl, sized down, writing through
// the identical state.applyPickLevel/applyPass + actions.applyLocalPick +
// actions.showUndoToast wiring. A decision here re-renders the WHOLE desktop
// body (grid aura updates live) but never touches focusedName/focusedSnapshot
// — the pane stays put by construction.
function tickNextDesktop(level) {
  if (level === 4) return level;
  if (level >= 3) return 0;
  return level + 1;
}

function paneWritePick(artistName, level, ctx, actions) {
  const before = myLevel(artistName, ctx);
  state.applyPickLevel(ctx.fid, artistName, ctx.meName, level);
  actions.applyLocalPick(artistName, ctx.meName, level);
  if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  ctx.onNotesChange();
  renderDeckBody(ctx, actions);
  if (before === 4 && level === 0 && actions.showUndoToast) {
    actions.showUndoToast(`Cleared your must for ${artistName}`, () => {
      state.applyPickLevel(ctx.fid, artistName, ctx.meName, 4);
      actions.applyLocalPick(artistName, ctx.meName, 4);
      if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
      ctx.onNotesChange();
      renderDeckBody(ctx, actions);
    });
  }
}

function paneWritePass(artistName, on, ctx, actions) {
  state.applyPass(ctx.fid, artistName, ctx.meName, on);
  if (on) actions.applyLocalPick(artistName, ctx.meName, 0);
  if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  ctx.onNotesChange();
  renderDeckBody(ctx, actions);
  if (on && actions.showUndoToast) {
    actions.showUndoToast(`Passed on ${artistName}`, () => {
      state.applyPass(ctx.fid, artistName, ctx.meName, false);
      if (session) startSession(ctx, loadFacets(ctx.fid), currentCanonData);
      ctx.onNotesChange();
      renderDeckBody(ctx, actions);
    });
  }
}

function buildPanePickControl(artistName, ctx, actions) {
  const level = myLevel(artistName, ctx);
  const passed = model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);
  const myIdx = colorIndexOf(ctx.meName, state.people()[ctx.meName]);

  const tick = document.createElement('button');
  tick.type = 'button';
  tick.className = 'ap-tick dd2-pane-tick';
  tick.setAttribute('aria-label', `Pick level for ${artistName} — currently ${level >= 4 ? 'must' : level >= 1 ? `×${level}` : 'not picked'}`);
  const fillPct = level <= 0 ? 0 : level === 1 ? 33.4 : level === 2 ? 66.8 : 100;
  const alpha = level <= 0 ? 0 : level === 1 ? 0.5 : level === 2 ? 0.75 : 1;
  const fill = document.createElement('span');
  fill.className = 'ap-tick-fill';
  fill.style.height = fillPct + '%';
  fill.style.background = hslOf(myIdx, alpha);
  const lbl = document.createElement('span');
  lbl.className = 'ap-tick-label';
  lbl.textContent = level >= 1 && level <= 3 ? `×${level}` : '';
  tick.append(fill, lbl);
  tick.addEventListener('click', () => {
    const next = tickNextDesktop(level);
    if (next === level) return;
    paneWritePick(artistName, next, ctx, actions);
  });

  const must = document.createElement('button');
  must.type = 'button';
  must.className = 'ap-must dd2-pane-must' + (level === 4 ? ' is-on' : '');
  must.setAttribute('aria-label', level === 4 ? `Clear must for ${artistName}` : `Mark ${artistName} a must`);
  must.textContent = '★';
  must.addEventListener('click', () => paneWritePick(artistName, level === 4 ? 0 : 4, ctx, actions));

  const pass = document.createElement('button');
  pass.type = 'button';
  pass.className = 'ap-pass dd2-pane-pass' + (passed ? ' is-on' : '');
  pass.setAttribute('aria-label', passed ? `Undo pass on ${artistName}` : `Pass on ${artistName}`);
  pass.textContent = '✕';
  pass.addEventListener('click', () => paneWritePass(artistName, !passed, ctx, actions));

  const side = document.createElement('div');
  side.className = 'ap-pick-side';
  side.append(must, pass);

  const wrap = document.createElement('div');
  wrap.className = 'dd2-pane-pick';
  wrap.append(tick, side);
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
  const lvl = myLevel(focusEntry.name, ctx);
  const passed = model.isPassed(state.crewDoc, ctx.fid, focusEntry.name, ctx.meName);
  const undecided = lvl < 1 && !passed;

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
  row.append(nameWrap, buildPanePickControl(focusEntry.name, ctx, actions));
  content.append(label, row);
  hero.append(bg, grain, content);
  pane.appendChild(hero);

  const body = document.createElement('div');
  body.className = 'dd2-pane-body';

  if (undecided && focusEntry.reason) {
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
    soundcloudSlug: meta.soundcloudSlug,
    spotifyId: meta.spotifyId,
  };
  const mount = (actions && actions.mountPlayer) || realMountPlayer;
  // compact layout, mounted paused (tap-to-play) — same call the grid's
  // sibling mobile card build (buildCard) already makes.
  playerHandle = mount({
    host: playerHost, artist: { name: focusEntry.name, genres: playerGenres }, sources, layout: 'compact',
  });

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'dd2-pane-open';
  openBtn.textContent = 'Open full artist page ›';
  openBtn.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(focusEntry.name); });
  body.appendChild(openBtn);

  pane.appendChild(body);
  return pane;
}

// HEADER — festival name (Anton, the fest accent: this surface's one allowed
// place for it, per repo law), Wall/Timetable (closes back to the app
// screen), Discover (active), My day (scheduled fests only). Right: the sync
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

  const nav = document.createElement('div');
  nav.className = 'dd2-nav';

  const wallTab = document.createElement('button');
  wallTab.type = 'button';
  wallTab.className = 'dd2-navtab';
  wallTab.textContent = scheduled ? 'Timetable' : 'Wall';
  wallTab.setAttribute('aria-label', `Close Discover — back to the ${scheduled ? 'timetable' : 'wall'}`);
  wallTab.addEventListener('click', () => { if (!router.requestClose()) closeDeck(); });
  nav.appendChild(wallTab);

  const discoverTab = document.createElement('span');
  discoverTab.className = 'dd2-navtab dd2-navtab-active';
  discoverTab.textContent = 'Discover';
  nav.appendChild(discoverTab);

  if (scheduled) {
    const myDayTab = document.createElement('button');
    myDayTab.type = 'button';
    myDayTab.className = 'dd2-navtab';
    myDayTab.textContent = 'My day';
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
  const pool = buildPool(ctx, facets, currentCanonData);
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

// ---- deck body (re-rendered on every advance/undo/filter change) -------------------
let currentCanonData = null;
function renderDeckBody(ctx, actions) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const facets = loadFacets(ctx.fid);
  overlay.textContent = '';
  // Both layouts mount their own fresh player (grid's sibling desktop pane,
  // or the mobile card) — always tear down whatever was live first, same
  // "ONE PLAYER, ALWAYS" discipline player.js itself enforces.
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }

  if (isDesktopLayout()) {
    renderDesktopBody(overlay, ctx, actions, facets);
    return;
  }

  const shell = document.createElement('div');
  shell.className = 'dd-shell';

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
  topBar.append(back, title);

  shell.appendChild(topBar);
  shell.appendChild(buildHeader(ctx, facets, actions));

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

export function openDeck(ctx, actions = {}) {
  ensureOverlay();
  deckOpen = true;
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
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }
  unwatchLayout();
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  deckOpen = false;
  session = null; // a fresh open deals a fresh session, per spec
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
