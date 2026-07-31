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

const OVERLAY_ID = 'discover-deck-overlay';
const LS_FILTER_PREFIX = 'fp.discoverFilter.';

// ---- module state: one deck instance, ever ---------------------------------------
let playerHandle = null;
let session = null;      // { pool, position, decided } — reset per open (or per filter commit)
let deckOpen = false;
let pendingOpenGen = 0;  // guards a stale async canon-load landing after a newer navigation

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
  return applyFilters(fest.artists || [], picks, passes, facets, ctx.meName, canonData);
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

  commit();
  session.decided++;
  session.position++;
  ctx.onNotesChange();
  renderDeckBody(ctx, actions);

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
  let startX = 0, startY = 0, dx = 0, dragging = false;
  const THRESHOLD = 90;

  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // player controls, name button
    dragging = true; startX = e.clientX; startY = e.clientY; dx = 0;
    try { card.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < Math.abs(dy)) return; // vertical drag isn't a deck gesture
    if (!REDUCED_MOTION()) {
      card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    }
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    card.style.transform = '';
    if (dx > THRESHOLD) decide('pick', 1, ctx, actions);
    else if (dx < -THRESHOLD) decide('pass', 0, ctx, actions);
    dx = 0;
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', () => { dragging = false; card.style.transform = ''; dx = 0; });
}

// ---- deck body (re-rendered on every advance/undo/filter change) -------------------
let currentCanonData = null;
function renderDeckBody(ctx, actions) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const facets = loadFacets(ctx.fid);
  overlay.textContent = '';

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

  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }

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
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  deckOpen = false;
  session = null; // a fresh open deals a fresh session, per spec
  pendingOpenGen++;
}

export function isDeckOpen() { return deckOpen; }

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
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'sheet-backdrop';
  backdrop.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
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
    const scheduled = !!(fest.days && Object.keys(fest.days).length);
    if (!scheduled) {
      const gapRow = toggleField('Playing in my open gaps', 'needs set times', false, () => {});
      gapRow.classList.add('dd-toggle-disabled');
      gapRow.querySelector('.toggle').disabled = true;
      togglesWrap.appendChild(gapRow);
    }
    // Scheduled festivals hide the gap facet entirely: gap computation isn't
    // implemented yet (Phase 2 / M6), and showing it enabled-looking on a
    // festival that DOES have set times would read as a working control that
    // silently does nothing — worse than not showing it at all.
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
// renderArtistPageForTest.
export function renderDeckForTest(ctx, actions, canonData) {
  ensureOverlay();
  deckOpen = true;
  currentCanonData = canonData || { canon: [], synonyms: {}, suppress: [] };
  session = null;
  startSession(ctx, loadFacets(ctx.fid), currentCanonData);
  renderDeckBody(ctx, actions);
  return document.getElementById(OVERLAY_ID);
}
