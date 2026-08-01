// Artist page (Discovery M3, build spec section 7.1, frames 5a/5b) — an
// APP-WIDE surface, not a Discovery screen: it works the same for someone who
// never opens the deck. Opened from wall rows, timetable sets, deck names,
// and its own "Similar" rows. This is also the flow change landing point:
// tapping an artist name anywhere in the app now opens this page instead of
// cycling a pick inline — the pick cycle lives on the page's tick.
//
// Rendered as a fixed full-screen overlay div, created/destroyed dynamically
// (no static markup in index.html — same "build it in JS" convention as the
// share-moment/add-member sheets in app.js). One overlay element persists
// across artist-to-artist navigation (tapping a Similar row replaces its
// content in place); the router still pushes one stack entry per artist so
// browser back steps artist-by-artist before leaving the page entirely.
//
// SECURITY RULE (mirrors wall.js): every artist/person/note string goes
// through textContent / createElement — no innerHTML of doc-derived text.
//
// Callers pass ctx (the shared app.js view context: fid, meName, onNotesChange,
// onOpenNotes) and an `actions` object carrying the handful of things this
// module cannot reach on its own without a circular import back into app.js:
//   actions.applyLocalPick(artist, person, level) — REQUIRED for real usage;
//     app.js's own local-doc mirror for pending-only pick writes (recordSelectionFor
//     writes pending only — see js/v3/app.js's applyLocalPick and js/state.js's
//     comment on recordSelection). Reused here, not duplicated.
//   actions.showUndoToast(message, onUndo) — optional; wraps wall.js's showUndoToast
//     bound to app.js's toast-root, so a mis-tap on ★/✕ stays reversible.
//   actions.canonData — optional; a pre-loaded genre canon (data/genres.json shape).
//     Tests inject this to stay synchronous and network-free; real usage omits it
//     and this module lazily loads + caches it via genres.js.
//   actions.mountPlayer — optional; injectable in place of the real
//     js/discovery/player.js mountPlayer, so tests can stub the sample player
//     without touching third-party embed SDKs.
import * as state from '../state.js';
import * as model from '../v3/model.js';
import { router } from '../v3/router.js';
import { hslOf, strokeOf } from '../v3/palette.js';
import { colorIndexOf } from '../v3/wall.js';
import { auraBackground, initialFor } from '../v3/aura.js';
import { dialogize } from '../v3/notes.js';
import { computeDayArtists } from '../time.js';
import { loadGenreCanon, canonicalize } from './genres.js';
import { similarArtists } from './score.js';
import { mountPlayer as realMountPlayer } from './player.js';
import { buildPrimaryActions, paintPrimaryActions } from './deck.js';

const OVERLAY_ID = 'artist-page-overlay';

// ---- module state: one page instance, ever (mirrors player.js's ONE PLAYER rule) ----
let playerHandle = null;
let currentArtist = null;
let pendingOpenName = null; // guards a stale async canon-load landing after a newer navigation
let currentRefresh = null;  // { heroPick(), crew(), notes() } — targeted repaints that never touch the player

// ---- helpers: festival data lookups (pure; testable without a live app) -------------
function findArtistMeta(fest, name) {
  return (fest?.artists || []).find((a) => a && a.name === name) || { name };
}

// Set info for the hero/set-line and similar-artist rows. Two shapes exist in
// the wild: a lineup entry carries day/stage/time directly on the artists[]
// record (build spec 3.1's example); a SCHEDULED festival's real times live
// under fest.days[day].artists instead (electric-forest-2026.json etc.) — so
// this checks the direct fields first, then searches every day's computed
// sets for a match. Pure: uses time.js's computeDayArtists directly rather
// than state.getDayArtists's cache, which is keyed to the global
// activeFestivalId and would tie this function to app boot state.
function findSetInfo(fest, name, meta) {
  if (meta?.day && meta?.stage && meta?.time) {
    return { day: meta.day, stage: meta.stage, time: meta.time };
  }
  for (const day of Object.keys(fest?.days || {})) {
    const dayData = fest.days[day];
    if (!dayData?.artists?.length) continue;
    const hit = computeDayArtists(dayData).find((a) => a.name === name);
    if (hit) return { day, stage: hit.stage, time: hit.startStr };
  }
  if (meta?.day) return { day: meta.day, stage: meta.stage || null, time: null };
  return null;
}

function dayLabel(fest, day) {
  const meta = (fest?.dayMeta || {})[day];
  return (meta?.wd || day || '').toUpperCase();
}

function formatSetLinePlain(fest, setInfo) {
  if (!setInfo) return '';
  const bits = [];
  if (setInfo.day) bits.push(dayLabel(fest, setInfo.day));
  if (setInfo.time) bits.push(setInfo.time);
  if (setInfo.stage) bits.push(setInfo.stage);
  return bits.join(' · ');
}

// ---- helpers: doc reads --------------------------------------------------------------
// Mirrors wall.js's private cardPeople — the crew-aura hero reuses the exact
// same input shape aura.js already expects (people with level 1-4).
function cardPeopleFor(artistName, ctx) {
  const byPerson = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[artistName] || {};
  const peopleObj = state.people();
  const out = [];
  for (const [person, raw] of Object.entries(byPerson)) {
    const p = peopleObj[person];
    if (!state.isActivePerson(p)) continue;
    const level = model.readLevel(state.crewDoc, raw);
    if (level < 1) continue;
    out.push({ name: person, colorIndex: colorIndexOf(person, p), isYou: person === ctx.meName, level });
  }
  return out;
}

// A member with zero activity ANYWHERE in this crew doc (not just this
// artist) gets the dashed "hasn't opened" + recommend treatment (spec 7.1).
function personHasAnyActivity(fid, person) {
  const picks = model.picksFor(state.crewDoc, fid);
  for (const byPerson of Object.values(picks)) if (byPerson[person]) return true;
  const passes = model.passesFor(state.crewDoc, fid);
  for (const byPerson of Object.values(passes)) if (byPerson[person]) return true;
  return false;
}

function myLevel(artistName, ctx) {
  const raw = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[artistName]?.[ctx.meName];
  return model.readLevel(state.crewDoc, raw);
}

// ---- the headline pick control (hero, right side) -------------------------------------
// Tick cycles ×1 -> ×2 -> ×3 -> clear ONLY (never through must — design note,
// spec 7.1); ★ toggles must (level 4) independently; ✕ toggles pass. Tapping
// the tick while a must is active is a no-op — must is cleared via ★ first,
// so the two controls never fight over the same tap.
function tickNext(level) {
  if (level === 4) return level;
  if (level >= 3) return 0;
  return level + 1;
}

function writePick(artistName, level, ctx, actions, refreshPick) {
  const before = myLevel(artistName, ctx);
  state.applyPickLevel(ctx.fid, artistName, ctx.meName, level);
  actions.applyLocalPick(artistName, ctx.meName, level);
  refreshPick();
  if (currentRefresh) currentRefresh.crew();
  ctx.onNotesChange();
  // Same undo-toast condition as the old wall tap cycle (app.js handleTap):
  // only the must-cleared case gets an undo offer.
  if (before === 4 && level === 0 && actions.showUndoToast) {
    actions.showUndoToast(`Cleared your must for ${artistName}`, () => {
      state.applyPickLevel(ctx.fid, artistName, ctx.meName, 4);
      actions.applyLocalPick(artistName, ctx.meName, 4);
      refreshPick();
      if (currentRefresh) currentRefresh.crew();
      ctx.onNotesChange();
    });
  }
}

function writePassAction(artistName, on, ctx, actions, refreshPick) {
  state.applyPass(ctx.fid, artistName, ctx.meName, on);
  // applyPass's own pick-clearing write (recordSelectionFor) is pending-only —
  // mirror it into the rendered doc the same way pick writes are mirrored.
  if (on) actions.applyLocalPick(artistName, ctx.meName, 0);
  refreshPick();
  if (currentRefresh) currentRefresh.crew();
  ctx.onNotesChange();
  if (on && actions.showUndoToast) {
    actions.showUndoToast(`Passed on ${artistName}`, () => {
      state.applyPass(ctx.fid, artistName, ctx.meName, false);
      refreshPick();
      if (currentRefresh) currentRefresh.crew();
      ctx.onNotesChange();
    });
  }
}

// The hero's read-only state chip. The pick CONTROL moved to the pinned
// bottom bar (2026-08-01 design corrections); what stays up here is a quiet
// indicator, not a target — "the hero keeps a quiet read-only PICKED ×2 chip;
// the vertical tick stays what it was built for, the who-corner on cards."
function buildPickChip(host, artistName, ctx) {
  function paint() {
    host.textContent = '';
    const level = myLevel(artistName, ctx);
    const passed = model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);
    if (!passed && level <= 0) return; // unpicked says nothing — the bar already does
    const chip = document.createElement('span');
    chip.className = 'ap-pick-chip' + (passed ? ' is-passed' : '');
    chip.textContent = passed ? 'PASSED' : level === 4 ? '★ MUST' : `PICKED ×${level}`;
    if (!passed) {
      const myIdx = colorIndexOf(ctx.meName, state.people()[ctx.meName]);
      const alpha = level === 1 ? 0.5 : level === 2 ? 0.75 : 1;
      chip.style.borderColor = hslOf(myIdx, alpha);
    }
    host.appendChild(chip);
  }
  paint();
  return paint;
}

// The pinned bottom bar — the same component the deck and the focus pane use
// (deck.js's buildPrimaryActions), so the three primary actions never move
// between screens. On the artist page Pick cycles ×1 → ×2 → ×3 → clear on
// each tap and writes immediately; there is no deck to advance, so there is
// nothing to debounce.
function buildActionBar(host, artistName, ctx, actions, onChange) {
  let row = null;
  function paint(bump = false) {
    const level = myLevel(artistName, ctx);
    const passed = model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);
    if (!row) {
      row = buildPrimaryActions({
        onPass: () => {
          const nowPassed = !model.isPassed(state.crewDoc, ctx.fid, artistName, ctx.meName);
          writePassAction(artistName, nowPassed, ctx, actions, () => { paint(); onChange(); });
        },
        onPick: () => {
          const cur = myLevel(artistName, ctx);
          const next = tickNext(cur);
          if (next === cur) return;
          writePick(artistName, next, ctx, actions, () => { paint(true); onChange(); });
        },
        onMust: () => {
          const cur = myLevel(artistName, ctx);
          writePick(artistName, cur === 4 ? 0 : 4, ctx, actions, () => { paint(); onChange(); });
        },
        level,
      });
      host.appendChild(row);
    }
    paintPrimaryActions(row, level, bump);
    const pass = row.querySelector('.dd-btn-pass');
    if (pass) pass.classList.toggle('is-on', passed);
  }
  paint();
  return paint;
}

// ---- crew section -----------------------------------------------------------------
function writeRecommend(artistName, forPerson, ctx, refreshCrew) {
  state.recordRec(ctx.fid, artistName, forPerson, { by: ctx.meName, ts: new Date().toISOString() });
  refreshCrew();
  ctx.onNotesChange();
}

function buildCrewRow(artistName, person, personObj, peopleForInitials, ctx, refreshCrew) {
  const row = document.createElement('div');
  row.className = 'ap-crew-row';
  const kind = model.effectiveState(state.crewDoc, ctx.fid, artistName, person);
  const ci = colorIndexOf(person, personObj);
  const isYou = person === ctx.meName;
  const hasActivity = personHasAnyActivity(ctx.fid, person);

  const pill = document.createElement('span');
  pill.className = 'ap-pill';
  pill.textContent = initialFor({ name: person }, peopleForInitials);
  if (kind === 'none' && !hasActivity) {
    pill.classList.add('ap-pill-dashed');
    pill.style.borderColor = strokeOf(ci, isYou);
    pill.style.color = strokeOf(ci, isYou);
  } else {
    pill.style.background = hslOf(ci, 0.5);
    pill.style.border = '1px solid ' + strokeOf(ci, isYou);
  }

  const nm = document.createElement('span');
  nm.className = 'ap-crew-name';
  nm.textContent = person;
  if (kind === 'none' && !hasActivity) {
    const hint = document.createElement('span');
    hint.className = 'ap-crew-hint';
    hint.textContent = ' · hasn’t opened';
    nm.appendChild(hint);
  }

  const right = document.createElement('span');
  right.className = 'ap-crew-status';

  if (kind === 'must') {
    right.textContent = '★ must';
  } else if (kind === 'picked') {
    const level = myLevelOf(artistName, person, ctx);
    const mini = document.createElement('span');
    mini.className = 'ap-mini-tick';
    mini.style.borderColor = strokeOf(ci, isYou);
    const fill = document.createElement('span');
    fill.className = 'ap-mini-tick-fill';
    fill.style.height = (level === 1 ? 33.4 : level === 2 ? 66.8 : 100) + '%';
    fill.style.background = hslOf(ci, level === 1 ? 0.5 : level === 2 ? 0.75 : 1);
    mini.appendChild(fill);
    const lvlText = document.createElement('span');
    lvlText.textContent = `×${level}`;
    right.append(mini, lvlText);
  } else if (kind === 'passed') {
    row.classList.add('ap-crew-row-passed');
    right.textContent = 'passed';
  } else if (!hasActivity) {
    row.classList.add('ap-crew-row-dashed');
    const recLeaf = (model.recsFor(state.crewDoc, ctx.fid)[artistName] || {})[person];
    if (recLeaf) {
      right.textContent = recLeaf.by === ctx.meName ? 'recommended ✓' : `recommended by ${recLeaf.by}`;
    } else if (ctx.meName && !isYou) {
      const rec = document.createElement('button');
      rec.type = 'button';
      rec.className = 'ap-recommend';
      rec.textContent = 'recommend →';
      rec.setAttribute('aria-label', `Recommend ${artistName} to ${person}`);
      rec.addEventListener('click', () => writeRecommend(artistName, person, ctx, refreshCrew));
      right.appendChild(rec);
    }
  }
  // kind === 'none' && hasActivity: an active member with no opinion on THIS
  // artist yet — quiet, no trailing label (they've clearly opened the app).

  row.append(pill, nm, right);
  return row;
}

function myLevelOf(artistName, person, ctx) {
  const raw = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[artistName]?.[person];
  return model.readLevel(state.crewDoc, raw);
}

function buildCrewSection(artistName, ctx) {
  const section = document.createElement('div');
  section.className = 'ap-section ap-crew';
  const head = document.createElement('div');
  head.className = 'ap-section-head';
  const label = document.createElement('span');
  label.className = 'ap-section-label';
  label.textContent = 'The crew';
  const sub = document.createElement('span');
  sub.className = 'ap-section-sub';
  sub.textContent = 'picks + recommend-ahead';
  head.append(label, sub);
  const list = document.createElement('div');
  list.className = 'ap-crew-list';
  function paint() {
    list.textContent = '';
    const activeEntries = state.activePeople();
    const peopleForInitials = activeEntries.map(([n]) => ({ name: n }));
    for (const [person, personObj] of activeEntries) {
      list.appendChild(buildCrewRow(artistName, person, personObj, peopleForInitials, ctx, paint));
    }
  }
  paint();
  section.append(head, list);
  return { el: section, refresh: paint };
}

// ---- notes section (read-only preview; authoring happens in the existing sheet) ----
function buildNoteBubble(note, ctx) {
  const row = document.createElement('div');
  row.className = 'note-row';
  const av = document.createElement('span');
  av.className = 'avatar';
  const p = state.people()[note.author];
  const ci = colorIndexOf(note.author, p);
  av.style.background = hslOf(ci, 0.5);
  av.style.border = '1px solid ' + strokeOf(ci, note.author === ctx.meName);
  av.textContent = (note.author || '?').charAt(0).toUpperCase();
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const text = document.createElement('span');
  text.textContent = note.text;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = note.author === ctx.meName ? 'you' : note.author;
  bubble.append(text, meta);
  row.append(av, bubble);
  return row;
}

function buildNotesSection(artistName, ctx) {
  const section = document.createElement('div');
  section.className = 'ap-section ap-notes';
  const head = document.createElement('div');
  head.className = 'ap-section-head';
  const label = document.createElement('span');
  label.className = 'ap-section-label';
  head.appendChild(label);
  const list = document.createElement('div');
  list.className = 'ap-notes-list';
  function paint() {
    const notes = model.notesFor(state.crewDoc, ctx.fid, 'artist', artistName);
    label.textContent = `Notes · ${notes.length}`;
    list.textContent = '';
    for (const n of notes) list.appendChild(buildNoteBubble(n, ctx));
  }
  paint();
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ap-add-note';
  addBtn.textContent = '✎ Add a note…';
  addBtn.addEventListener('click', () => { if (ctx.onOpenNotes) ctx.onOpenNotes(artistName); });
  section.append(head, list, addBtn);
  return { el: section, refresh: paint };
}

// ---- sample section -----------------------------------------------------------------
function buildSampleSection(artistName, meta, canonData, actions) {
  const section = document.createElement('div');
  section.className = 'ap-section ap-sample';
  const host = document.createElement('div');
  section.appendChild(host);
  const { primary, secondary } = canonicalize(meta.genres, canonData);
  const genres = [primary, ...secondary].filter(Boolean);
  const sources = {
    youtubeVideoIds: meta.youtubeVideoIds,
    soundcloudSlug: meta.soundcloudSlug,
    spotifyId: meta.spotifyId,
  };
  const mount = (actions && actions.mountPlayer) || realMountPlayer;
  // mount() always runs — player.js's own state machine collapses to
  // "Nothing to sample yet" internally when zero sources resolve (frame 4b);
  // no need to branch on source presence here.
  // showHeader:false — the hero above already carries name + genres (frame
  // 5a draws the sample block headerless; repeating them read as a bug in
  // the first browser pass).
  playerHandle = mount({ host, artist: { name: artistName, genres }, sources, layout: 'full', showHeader: false });
  return section;
}

// ---- similar section -----------------------------------------------------------------
function buildSimilarRow(rName, fest, setInfo, ctx, actions) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'ap-similar-row';
  const left = document.createElement('span');
  left.className = 'ap-similar-left';
  const nm = document.createElement('span');
  nm.className = 'ap-similar-name';
  nm.textContent = rName;
  left.appendChild(nm);
  const lineText = formatSetLinePlain(fest, setInfo);
  if (lineText) {
    const sub = document.createElement('span');
    sub.className = 'ap-similar-sub';
    sub.textContent = lineText;
    left.appendChild(sub);
  }
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '›';
  row.append(left, chev);
  row.addEventListener('click', () => {
    openArtistPage(rName, ctx, actions);
    router.push('artist:' + rName);
  });
  return row;
}

function buildSimilarSection(artistName, fest, meta, canonData, ctx, actions) {
  const { primary } = canonicalize(meta.genres, canonData);
  if (!primary) return null; // "Omit the section entirely when the artist has no canonical genres" (spec 7.1)
  const results = similarArtists({ name: artistName, artists: fest.artists || [], canonData, limit: 4 });
  if (!results.length) return null;
  const section = document.createElement('div');
  section.className = 'ap-section ap-similar';
  const head = document.createElement('div');
  head.className = 'ap-section-head';
  const label = document.createElement('span');
  label.className = 'ap-section-label';
  label.textContent = 'Similar · and when they play';
  head.appendChild(label);
  const list = document.createElement('div');
  list.className = 'ap-similar-list';
  for (const r of results) {
    const rMeta = findArtistMeta(fest, r.name);
    const setInfo = findSetInfo(fest, r.name, rMeta);
    list.appendChild(buildSimilarRow(r.name, fest, setInfo, ctx, actions));
  }
  section.append(head, list);
  return section;
}

// ---- hero -----------------------------------------------------------------------
function buildHero(artistName, fest, meta, ctx, actions, canonData) {
  const hero = document.createElement('div');
  hero.className = 'ap-hero';
  const bg = document.createElement('div');
  bg.className = 'ap-hero-bg';
  const { background } = auraBackground(cardPeopleFor(artistName, ctx));
  bg.style.background = background;
  const grain = document.createElement('div');
  grain.className = 'hero-grain'; // shared v3 token class — hero grain at .4, per v3-tokens.css
  const content = document.createElement('div');
  content.className = 'ap-hero-content';

  const top = document.createElement('div');
  top.className = 'ap-hero-top';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'ap-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => { if (!router.requestClose()) closeArtistPage(); });
  top.appendChild(back);

  const bottom = document.createElement('div');
  bottom.className = 'ap-hero-bottom';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'ap-hero-name-wrap';
  const h1 = document.createElement('h1');
  h1.className = 'ap-name';
  h1.textContent = artistName;
  nameWrap.appendChild(h1);

  const { primary, secondary } = canonicalize(meta.genres, canonData);
  if (primary) {
    const chipsRow = document.createElement('div');
    chipsRow.className = 'ap-chips';
    for (const g of [primary, ...secondary]) {
      const c = document.createElement('span');
      c.className = 'ap-chip';
      c.textContent = g;
      chipsRow.appendChild(c);
    }
    nameWrap.appendChild(chipsRow);
  } else {
    const none = document.createElement('div');
    none.className = 'ap-no-genres';
    none.textContent = 'No genres tagged yet';
    nameWrap.appendChild(none);
  }

  const setInfo = findSetInfo(fest, artistName, meta);
  if (setInfo && (setInfo.day || setInfo.time || setInfo.stage)) {
    const line = document.createElement('div');
    line.className = 'ap-setline';
    const bits = [];
    if (setInfo.day) bits.push(dayLabel(fest, setInfo.day));
    if (setInfo.time) bits.push(setInfo.time);
    if (bits.length) line.appendChild(document.createTextNode(bits.join(' · ')));
    if (setInfo.stage) {
      if (bits.length) line.appendChild(document.createTextNode(' · '));
      const stageSpan = document.createElement('span');
      stageSpan.className = 'ap-stage'; // fest-accent — one of the four allowed places (spec 7.1/7.7)
      stageSpan.textContent = setInfo.stage;
      line.appendChild(stageSpan);
    }
    nameWrap.appendChild(line);
  }

  const pickHost = document.createElement('div');
  pickHost.className = 'ap-pick-chip-host';
  const pickRefresh = buildPickChip(pickHost, artistName, ctx);

  bottom.append(nameWrap, pickHost);
  content.append(top, bottom);
  hero.append(bg, grain, content);
  return { el: hero, refresh: pickRefresh };
}

// ---- overlay lifecycle ----------------------------------------------------------------
function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'artist-page';
  document.body.appendChild(overlay);
  dialogize(overlay, 'Artist'); // role=dialog, aria-modal, Tab-trap, focus-on-open — set ONCE per overlay
  return overlay;
}

function renderInto(artistName, ctx, actions, canonData) {
  currentArtist = artistName;
  const overlay = ensureOverlay();
  overlay.setAttribute('aria-label', artistName);
  overlay.textContent = '';
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }

  const fest = state.FESTIVALS[ctx.fid] || {};
  const meta = findArtistMeta(fest, artistName);

  const scroll = document.createElement('div');
  scroll.className = 'ap-scroll';
  const heroBuilt = buildHero(artistName, fest, meta, ctx, actions, canonData);
  const body = document.createElement('div');
  body.className = 'ap-body';
  body.appendChild(buildSampleSection(artistName, meta, canonData, actions));
  const crewBuilt = buildCrewSection(artistName, ctx);
  body.appendChild(crewBuilt.el);
  const notesBuilt = buildNotesSection(artistName, ctx);
  body.appendChild(notesBuilt.el);
  const similar = buildSimilarSection(artistName, fest, meta, canonData, ctx, actions);
  if (similar) body.appendChild(similar);
  // The primary actions sit at the bottom of the SCROLL, sticky — "along the
  // bottom on every surface ... never in a header". Inside the scroll rather
  // than over it so the desktop grid below can re-place them into the left
  // rail without a second DOM shape. They must stay reachable without
  // scrolling back to the hero, which is exactly what the old headline tick
  // required on a long artist page.
  const actionHost = document.createElement('div');
  actionHost.className = 'ap-actions';
  const barRefresh = buildActionBar(actionHost, artistName, ctx, actions, () => {
    if (currentRefresh && currentRefresh.heroPick) currentRefresh.heroPick();
    if (currentRefresh && currentRefresh.crew) currentRefresh.crew();
  });

  scroll.append(heroBuilt.el, body, actionHost);
  overlay.appendChild(scroll);

  currentRefresh = {
    heroPick: heroBuilt.refresh, crew: crewBuilt.refresh, notes: notesBuilt.refresh, bar: barRefresh,
  };
}

// Open (or navigate an already-open page to) an artist. Idempotent: calling
// this repeatedly for the same overlay never creates a second one — it just
// (re)renders content into the one persistent overlay element, exactly the
// settings-layer pattern (openSettings always just re-shows/re-renders).
export function openArtistPage(name, ctx, actions = {}) {
  ensureOverlay();
  pendingOpenName = name;
  const finish = (canonData) => {
    if (pendingOpenName !== name) return; // superseded by a newer navigation mid-fetch
    renderInto(name, ctx, actions, canonData);
  };
  if (actions.canonData) finish(actions.canonData);
  else loadGenreCanon().then(finish);
}

export function closeArtistPage() {
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  currentArtist = null;
  pendingOpenName = null;
  currentRefresh = null;
}

// Sync repaint hook (mirrors notes.js's refreshOpenSheet): a remote doc
// landing must re-render the open page's crew + notes sections — a
// crewmate's pick, pass, rec, or note should show up live without the
// person having to close and reopen the page.
export function refreshOpenArtistPage() {
  if (!currentArtist || !currentRefresh) return;
  currentRefresh.crew();
  currentRefresh.notes();
}

export function isArtistPageOpen() {
  return !!currentArtist;
}

// Exposed for tests only: the pure-ish render core, callable without going
// through the async genre-canon load or the router. Mirrors wall.js's
// renderCard being directly testable.
export function renderArtistPageForTest(name, ctx, actions, canonData) {
  renderInto(name, ctx, actions, canonData || { canon: [], synonyms: {}, suppress: [] });
  return document.getElementById(OVERLAY_ID);
}
