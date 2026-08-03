// Decide — resolve a schedule clash (Discovery M6, build spec section 7.5,
// frames 4a/5e). Opened from a my-day.js clash card; router key
// `decide:<day>:<idx>`, `idx` an index into that day's findClashes() output
// (js/discovery/gaps.js) — deterministic given the current picks, so a
// refresh (F10 restore) recomputes the same clash from the doc rather than
// carrying any state of its own.
//
// Full-screen layer like the artist page / deck (same fixed-overlay,
// created/destroyed dynamically, idempotent open/close convention).
//
// Player singleton constraint (js/discovery/player.js: "ONE PLAYER, ALWAYS" —
// mounting a new embed destroys whatever was previously live, everywhere).
// Two clashing artists cannot both have a LIVE player at once, so only one
// card's player is ever mounted; the other renders a paused "tap to sample"
// trigger that, on tap, mounts its own player (tearing down the first).
//
// SECURITY RULE (mirrors artist-page.js / deck.js): every artist/person
// string renders via textContent / createElement, never innerHTML.
//
// Callers pass ctx (app.js's shared view context) and `actions` — same shape
// artist-page.js/deck.js take, plus:
//   actions.refreshMyDay() — optional; app.js wires this to
//     js/discovery/my-day.js's refreshOpenMyDay so a choose/split/on-site
//     resolution updates the day view underneath without a circular import
//     between the two Discovery modules.
import * as state from '../state.js';
import * as model from '../v3/model.js';
import { router } from '../v3/router.js';
import { dialogize } from '../v3/notes.js';
import { canonicalize } from './genres.js';
import { mountPlayer as realMountPlayer } from './player.js';
import { dayPlan, findClashes, clockLabel } from './gaps.js';

const OVERLAY_ID = 'decide-overlay';
const LS_CLASH_PREFIX = 'fp.clashResolved.';

let playerHandle = null;
let activeSlot = 0; // which card index currently owns the live player
let decideOpen = false;
let currentKey = null;

// ---- router key -------------------------------------------------------------------
export function keyFor(day, idx) { return `decide:${day}:${idx}`; }
export function parseKey(key) {
  const raw = key.slice('decide:'.length);
  const sep = raw.lastIndexOf(':');
  return { day: raw.slice(0, sep), idx: Number(raw.slice(sep + 1)) };
}

// ---- device-local clash dismissals ('split' | 'onsite') --------------------------
// Never written to the shared crew doc — viewer-side, same discipline as
// dismissed clashes/mutes elsewhere in the app.
function dismissalKey(day, names) { return `${day}|${[...names].sort().join('||')}`; }
function loadDismissals(fid) {
  try { return JSON.parse(localStorage.getItem(LS_CLASH_PREFIX + fid) || '{}'); } catch { return {}; }
}
function saveDismissals(fid, all) {
  try { localStorage.setItem(LS_CLASH_PREFIX + fid, JSON.stringify(all)); } catch { /* private mode / full */ }
}
export function getClashDismissal(fid, day, names) {
  return loadDismissals(fid)[dismissalKey(day, names)] || null;
}
export function setClashDismissal(fid, day, names, kind) {
  const all = loadDismissals(fid);
  all[dismissalKey(day, names)] = kind;
  saveDismissals(fid, all);
}
export function clearClashDismissal(fid, day, names) {
  const all = loadDismissals(fid);
  delete all[dismissalKey(day, names)];
  saveDismissals(fid, all);
}

// ---- doc reads --------------------------------------------------------------------
function levelOf(name, ctx) {
  const raw = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[name]?.[ctx.meName];
  return model.readLevel(state.crewDoc, raw);
}

function findArtistMeta(fest, name) {
  return (fest?.artists || []).find((a) => a && a.name === name) || { name };
}

// Recompute the clash fresh from the doc — never trusted stale, since a
// remote pick change or the choose/undo flow itself can shift indices.
function resolveClash(day, idx, ctx) {
  const fest = state.FESTIVALS[ctx.fid] || {};
  const dayData = fest.days?.[day];
  if (!dayData) return null;
  const dayArtists = state.getDayArtists(day);
  const picks = model.picksFor(state.crewDoc, ctx.fid);
  const plan = dayPlan({ dayArtists, picks, me: ctx.meName });
  const clashes = findClashes(plan);
  return clashes[idx] || null;
}

function dayLabel(fest, day) {
  const meta = (fest.dayMeta || {})[day];
  return (meta?.wd || day || '').toUpperCase();
}

// "Plays again": the same artist name at another day/time in this festival,
// excluding the exact occurrence in this clash — the cheap-skip signal.
function playsAgainText(fest, name, excludeSet) {
  for (const day of Object.keys(fest.days || {})) {
    const dayArtists = state.getDayArtists(day);
    for (const a of dayArtists) {
      if (a.name !== name) continue;
      if (day === excludeSet.day && a.startMin === excludeSet.startMin) continue;
      const dLabel = dayLabel(fest, day);
      return a.stage ? `${dLabel} ${clockLabel(a.startMin)} · ${a.stage}` : `${dLabel} ${clockLabel(a.startMin)}`;
    }
  }
  return 'never this festival';
}

// Crewmates' lean on this artist, excluding me (mirrors score.js's
// crewSignal but produces Decide's own prose rather than a ribbon reason).
function crewLeanText(name, ctx) {
  const byPerson = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[name] || {};
  const musts = [];
  const others = [];
  for (const [person, raw] of Object.entries(byPerson)) {
    if (person === ctx.meName) continue;
    const p = state.people()[person];
    if (!state.isActivePerson(p)) continue;
    const level = model.readLevel(state.crewDoc, raw);
    if (level < 1) continue;
    if (level >= 4) musts.push(person); else others.push(person);
  }
  musts.sort(); others.sort();
  if (musts.length === 1 && others.length === 0) return `${musts[0]} has this as a must too`;
  if (musts.length >= 1) return `${musts.length} of the crew have it as a must`;
  if (others.length >= 1) return `${others.length} of the crew picked`;
  return null;
}

function levelText(level) {
  if (level >= 4) return 'must';
  if (level >= 1) return `×${level}`;
  return 'not picked';
}

// ---- one clashing-artist card ------------------------------------------------------
function buildCard(setEntry, day, clash, ctx, actions, canonData, fest, slotIdx) {
  const meta = findArtistMeta(fest, setEntry.name);
  const card = document.createElement('div');
  card.className = 'dc-card';
  card.dataset.artist = setEntry.name;

  const head = document.createElement('div');
  head.className = 'dc-card-head';
  const nm = document.createElement('span');
  nm.className = 'dc-card-name';
  nm.textContent = setEntry.name;
  head.appendChild(nm);
  const { primary, secondary } = canonicalize(meta.genres, canonData);
  const genres = [primary, ...secondary].filter(Boolean);
  if (genres.length) {
    const g = document.createElement('span');
    g.className = 'dc-card-genre';
    g.textContent = genres.join(' · ');
    head.appendChild(g);
  }
  card.appendChild(head);

  const playerHost = document.createElement('div');
  playerHost.className = 'dc-card-player';
  card.appendChild(playerHost);
  const mount = (actions && actions.mountPlayer) || realMountPlayer;
  if (slotIdx === activeSlot) {
    const sources = {
      youtubeVideoIds: meta.youtubeVideoIds,
    youtubeLabels: meta.youtubeLabels,
      soundcloudSlug: meta.soundcloudSlug,
      spotifyId: meta.spotifyId,
    };
    playerHandle = mount({
      host: playerHost, artist: { name: setEntry.name, genres }, sources, layout: 'full', showHeader: false,
    });
  } else {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dc-play-trigger';
    trigger.textContent = `▶ Tap to sample ${setEntry.name}`;
    trigger.setAttribute('aria-label', `Load the sample player for ${setEntry.name}`);
    trigger.addEventListener('click', () => {
      activeSlot = slotIdx;
      renderBody(day, clash, ctx, actions, canonData, fest);
    });
    playerHost.appendChild(trigger);
  }

  const crewRow = document.createElement('div');
  crewRow.className = 'dc-card-crew';
  const pill = document.createElement('span');
  pill.className = 'dc-pill';
  pill.textContent = 'You';
  const lvl = document.createElement('span');
  lvl.className = 'dc-card-level';
  lvl.textContent = levelText(setEntry.level);
  crewRow.append(pill, lvl);
  const lean = crewLeanText(setEntry.name, ctx);
  if (lean) {
    const leanSpan = document.createElement('span');
    leanSpan.className = 'dc-card-crewline';
    leanSpan.textContent = `· ${lean}`;
    crewRow.appendChild(leanSpan);
  }
  card.appendChild(crewRow);

  const metaRow = document.createElement('div');
  metaRow.className = 'dc-card-meta';
  const others = clash.sets.filter((s) => s.name !== setEntry.name).map((s) => s.name);
  const giveUp = document.createElement('span');
  const giveUpB = document.createElement('b'); giveUpB.textContent = 'Give up: ';
  giveUp.append(giveUpB, document.createTextNode(others.length ? others.join(', ') : 'nothing else marked'));
  const playsAgain = document.createElement('span');
  const playsAgainB = document.createElement('b'); playsAgainB.textContent = 'Plays again: ';
  playsAgain.append(playsAgainB, document.createTextNode(playsAgainText(fest, setEntry.name, { day, startMin: setEntry.startMin })));
  metaRow.append(giveUp, playsAgain);
  card.appendChild(metaRow);

  const chooseBtn = document.createElement('button');
  chooseBtn.type = 'button';
  chooseBtn.className = 'dc-choose';
  chooseBtn.textContent = `Choose ${setEntry.name}`;
  chooseBtn.addEventListener('click', () => chooseArtist(day, clash, setEntry.name, ctx, actions, fest));
  card.appendChild(chooseBtn);

  return card;
}

// ---- choose / split / on-site actions ---------------------------------------------
function chooseArtist(day, clash, chosenName, ctx, actions, fest) {
  const before = {};
  for (const s of clash.sets) before[s.name] = levelOf(s.name, ctx);

  const commit = () => {
    for (const s of clash.sets) {
      if (s.name === chosenName) continue;
      state.applyPickLevel(ctx.fid, s.name, ctx.meName, 1);
      actions.applyLocalPick(s.name, ctx.meName, 1);
    }
  };
  const revert = () => {
    for (const s of clash.sets) {
      if (s.name === chosenName) continue;
      state.applyPickLevel(ctx.fid, s.name, ctx.meName, before[s.name]);
      actions.applyLocalPick(s.name, ctx.meName, before[s.name]);
    }
  };

  commit();
  if (ctx.onNotesChange) ctx.onNotesChange();
  if (actions.refreshMyDay) actions.refreshMyDay();
  if (actions.showUndoToast) {
    actions.showUndoToast(`Chose ${chosenName} — undo`, () => {
      revert();
      if (ctx.onNotesChange) ctx.onNotesChange();
      if (actions.refreshMyDay) actions.refreshMyDay();
    });
  }
  if (!router.requestClose()) closeDecide();
}

function dismissClash(day, clash, kind, ctx, actions) {
  const names = clash.sets.map((s) => s.name);
  setClashDismissal(ctx.fid, day, names, kind);
  if (actions.refreshMyDay) actions.refreshMyDay();
  if (!router.requestClose()) closeDecide();
}

// ---- body / lifecycle ---------------------------------------------------------------
function renderBody(day, clash, ctx, actions, canonData, fest) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.textContent = '';
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }

  const shell = document.createElement('div');
  shell.className = 'dc-shell';

  const topbar = document.createElement('div');
  topbar.className = 'dc-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'dc-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => { if (!router.requestClose()) closeDecide(); });
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'dc-title';
  title.textContent = 'DECIDE';
  const sub = document.createElement('div');
  sub.className = 'dc-sub';
  const startMin = Math.min(...clash.sets.map((s) => s.startMin));
  const mustCount = clash.sets.filter((s) => s.level === 4).length;
  sub.textContent = `${dayLabel(fest, day)} · ${clockLabel(startMin)} · ${clash.sets.length} sets, 1 slot` +
    (mustCount >= 2 ? `, ${mustCount} musts` : '');
  titleWrap.append(title, sub);
  topbar.append(back, titleWrap);
  shell.appendChild(topbar);

  const scroll = document.createElement('div');
  scroll.className = 'dc-scroll';

  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'dc-cards';
  clash.sets.forEach((setEntry, i) => {
    if (i > 0) {
      const vs = document.createElement('div');
      vs.className = 'dc-vs';
      vs.textContent = 'VS';
      vs.setAttribute('aria-hidden', 'true');
      cardsWrap.appendChild(vs);
    }
    cardsWrap.appendChild(buildCard(setEntry, day, clash, ctx, actions, canonData, fest, i));
  });
  scroll.appendChild(cardsWrap);

  const footer = document.createElement('div');
  footer.className = 'dc-footer';
  const splitBtn = document.createElement('button');
  splitBtn.type = 'button';
  splitBtn.className = 'dc-split';
  splitBtn.textContent = 'Split it — 45 min each';
  splitBtn.addEventListener('click', () => dismissClash(day, clash, 'split', ctx, actions));
  const onsiteBtn = document.createElement('button');
  onsiteBtn.type = 'button';
  onsiteBtn.className = 'dc-onsite';
  onsiteBtn.textContent = 'keep both starred and decide on-site';
  onsiteBtn.addEventListener('click', () => dismissClash(day, clash, 'onsite', ctx, actions));
  footer.append(splitBtn, onsiteBtn);
  scroll.appendChild(footer);

  const foot = document.createElement('div');
  foot.className = 'dc-foot';
  foot.textContent = 'Every option is informed: why it’s worth it, what you give up, whether it plays again, and where the crew leans. It never picks for you.';
  scroll.appendChild(foot);

  shell.appendChild(scroll);
  overlay.appendChild(shell);
}

function renderGone(day, ctx) {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.textContent = '';
  const shell = document.createElement('div');
  shell.className = 'dc-shell';
  const topbar = document.createElement('div');
  topbar.className = 'dc-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'dc-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => { if (!router.requestClose()) closeDecide(); });
  topbar.appendChild(back);
  shell.appendChild(topbar);
  const empty = document.createElement('div');
  empty.className = 'dc-gone';
  empty.textContent = 'This clash is already resolved.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dc-gone-back';
  btn.textContent = 'Back to your day';
  btn.addEventListener('click', () => { if (!router.requestClose()) closeDecide(); });
  empty.appendChild(document.createElement('br'));
  empty.appendChild(btn);
  shell.appendChild(empty);
  overlay.appendChild(shell);
}

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'decide-screen';
  document.body.appendChild(overlay);
  dialogize(overlay, 'Decide');
  return overlay;
}

export function openDecide(day, idx, ctx, actions = {}) {
  ensureOverlay();
  decideOpen = true;
  currentKey = keyFor(day, idx);
  activeSlot = 0;
  const canonData = actions.canonData || { canon: [], synonyms: {}, suppress: [] };
  const fest = state.FESTIVALS[ctx.fid] || {};
  const clash = resolveClash(day, idx, ctx);
  if (!clash) { renderGone(day, ctx); return; }
  renderBody(day, clash, ctx, actions, canonData, fest);
}

export function closeDecide() {
  if (playerHandle) { try { playerHandle.destroy(); } catch { /* best-effort teardown */ } playerHandle = null; }
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  decideOpen = false;
  currentKey = null;
}

export function isDecideOpen() { return decideOpen; }
export function currentDecideKey() { return currentKey; }

// Exposed for tests only — bypasses the router, callable synchronously.
export function renderDecideForTest(day, idx, ctx, actions, canonData) {
  ensureOverlay();
  decideOpen = true;
  activeSlot = 0;
  const fest = state.FESTIVALS[ctx.fid] || {};
  const clash = resolveClash(day, idx, ctx);
  if (!clash) { renderGone(day, ctx); return document.getElementById(OVERLAY_ID); }
  renderBody(day, clash, ctx, actions, canonData || { canon: [], synonyms: {}, suppress: [] }, fest);
  return document.getElementById(OVERLAY_ID);
}
