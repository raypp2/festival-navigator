// My day — schedule assist: gaps & clashes (Discovery M6, build spec section
// 7.4, frames 2b/5d). An APP-WIDE, full-screen overlay layer, same
// created/destroyed-dynamically, idempotent-open/close convention as
// js/discovery/artist-page.js and js/discovery/deck.js. Router kind 'myday'
// (fixed key, no per-day suffix — the day tab is this module's OWN state,
// device-local, not part of the URL/router stack).
//
// Only reachable when the active festival has set times (js/v3/app.js hides
// the toolbar entry on a lineup-only fest) — this module still defends
// itself (renderNoSchedule) in case of a stale router restore across a
// festival switch.
//
// Gap/clash math is entirely js/discovery/gaps.js's job (pure) — this module
// only turns that output into DOM. Tapping any set opens the artist page
// (ctx.onTap, the same app-wide flow every other surface uses); tapping a
// clash card opens js/discovery/decide.js on top, one router layer up.
//
// SECURITY RULE (mirrors artist-page.js/deck.js): every artist/person string
// renders via textContent / createElement, never innerHTML.
//
// Callers pass ctx (app.js's shared view context) and `actions` — same shape
// artist-page.js/deck.js take (applyLocalPick, showUndoToast, canonData,
// mountPlayer — the last three passed straight through to decide.js), plus
// actions.refreshMyDay is filled in BY THIS MODULE (app.js wires it to
// refreshOpenMyDay below) so decide.js can ask for a repaint without a
// circular import back into this file.
import * as state from '../state.js';
import * as model from '../v3/model.js';
import { router } from '../v3/router.js';
import { dialogize } from '../v3/notes.js';
import { colorIndexOf } from '../v3/wall.js';
import { auraBackground, whoCorner } from '../v3/aura.js';
import { loadGenreCanon } from './genres.js';
import { rankLineup, derivePopularity } from './score.js';
import { getResolution } from './resolutions.js';
import { openDeck } from './deck.js';
import { openDecide, keyFor, getClashDismissal } from './decide.js';
import {
  dayPlan, computeDayBounds, findGaps, findClashes, gapCandidates,
  clockLabel, durationLabel,
} from './gaps.js';

const OVERLAY_ID = 'my-day-overlay';
const FULL_DAY_NAMES = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
};

let myDayOpen = false;
let pendingOpenGen = 0;
let lastArgs = null; // { ctx, actions, canonData } — for refreshOpenMyDay
const dayByFid = {}; // device-local per-festival tab memory, this session only

// ---- helpers --------------------------------------------------------------------
function scheduledDays(fest) { return Object.keys(fest?.days || {}); }

function fullDayName(fest, day) {
  const wd = (fest.dayMeta || {})[day]?.wd;
  if (wd && FULL_DAY_NAMES[wd]) return FULL_DAY_NAMES[wd];
  return (wd || day || '').toUpperCase();
}

function levelText(level) {
  if (level >= 4) return 'must';
  if (level >= 1) return `picked ×${level}`;
  return '';
}

function defaultDay(fest, ctx, days) {
  const picks = model.picksFor(state.crewDoc, ctx.fid);
  for (const day of days) {
    const dayArtists = state.getDayArtists(day);
    const plan = dayPlan({ dayArtists, picks, me: ctx.meName });
    if (plan.length) return day;
  }
  return days[0];
}

// ---- set (marked pick) row -------------------------------------------------------
function buildSetRow(setEntry, ctx, plan) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'md-row md-set';

  const time = document.createElement('span');
  time.className = 'md-time';
  time.textContent = clockLabel(setEntry.startMin);

  const card = document.createElement('div');
  card.className = 'md-set-card';

  const peopleObj = state.people();
  const byPerson = state.crewDoc?.festivals?.[ctx.fid]?.selections?.[setEntry.name] || {};
  const people = [];
  for (const [person, raw] of Object.entries(byPerson)) {
    const p = peopleObj[person];
    if (!state.isActivePerson(p)) continue;
    const level = model.readLevel(state.crewDoc, raw);
    if (level < 1) continue;
    people.push({ name: person, colorIndex: colorIndexOf(person, p), isYou: person === ctx.meName, level });
  }
  const { background } = auraBackground(people);
  card.style.background = background;

  const nm = document.createElement('div');
  nm.className = 'md-set-name';
  nm.textContent = setEntry.name;
  const sub = document.createElement('div');
  sub.className = 'md-set-sub';
  sub.textContent = `${setEntry.stage} · ${clockLabel(setEntry.startMin)}–${clockLabel(setEntry.endMin)} · ${levelText(setEntry.level)}`;
  card.append(nm, sub);

  // SPIKE — the plan for this window, if one was made. A badge says which, and
  // the alternates stay reachable: My Day summarises, it must not quietly drop
  // an artist that was considered.
  if (plan) {
    const badge = document.createElement('span');
    badge.className = `md-plan is-${plan.role}`;
    badge.textContent = plan.role === 'lead' ? 'leading'
      : plan.role === 'keep' ? 'your call' : 'alternate';
    nm.appendChild(badge);
    // walking out of this one? say so where the action is taken
    const next = plan.alternates
      .filter((o) => o.startMin >= setEntry.startMin && o.stage !== setEntry.stage)
      .sort((a, b) => a.startMin - b.startMin)[0];
    if (next && plan.role !== 'alt') {
      const walk = document.createElement('span');
      walk.className = 'md-plan is-walk';
      walk.textContent = `leave early \u2192 ${next.stage}`;
      nm.appendChild(walk);
    }
  }

  const who = document.createElement('span');
  who.className = 'md-set-who';
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
  card.appendChild(who);

  btn.append(time, card);
  btn.setAttribute('aria-label', `${setEntry.name} — ${levelText(setEntry.level) || 'picked'}, open artist page`);
  btn.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(setEntry.name); });
  return btn;
}

// ---- clash row --------------------------------------------------------------------
function buildClashRow(day, clash, idx, ctx, actions) {
  const startMin = Math.min(...clash.sets.map((s) => s.startMin));
  const names = clash.sets.map((s) => s.name);
  const dismissal = getClashDismissal(ctx.fid, day, names);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'md-row md-clash' + (dismissal ? ' is-resolved' : '');

  const time = document.createElement('span');
  time.className = 'md-time';
  time.textContent = clockLabel(startMin);

  const card = document.createElement('div');
  card.className = 'md-clash-card';

  const label = document.createElement('div');
  label.className = 'md-clash-label';
  if (dismissal) {
    label.textContent = dismissal === 'split' ? 'Split planned' : 'Deciding on-site';
  } else {
    const mustCount = clash.sets.filter((s) => s.level === 4).length;
    label.textContent = clash.severity === 'musts'
      ? `⚡ Clash · ${mustCount} of your musts`
      : `⚡ Clash · ${clash.sets.length} picks overlap`;
  }
  const namesEl = document.createElement('div');
  namesEl.className = 'md-clash-names';
  namesEl.textContent = names.join(' vs ');
  card.append(label, namesEl);

  if (!dismissal) {
    const decideChip = document.createElement('span');
    decideChip.className = 'md-clash-decide';
    decideChip.textContent = 'Decide ›';
    card.appendChild(decideChip);
  }

  btn.append(time, card);
  btn.setAttribute('aria-label', `Clash: ${names.join(' vs ')}${dismissal ? `, ${label.textContent}` : ', open Decide'}`);
  btn.addEventListener('click', () => {
    openDecide(day, idx, ctx, actions);
    router.push(keyFor(day, idx));
  });
  return btn;
}

// ---- gap row ------------------------------------------------------------------------
function buildGapRow(gap, dayArtists, ranked, ctx, actions, picks, passes) {
  const row = document.createElement('div');
  row.className = 'md-row md-gap';
  row.dataset.gapStart = String(gap.startMin);

  const time = document.createElement('span');
  time.className = 'md-time';
  time.textContent = clockLabel(gap.startMin);

  const card = document.createElement('div');
  card.className = 'md-gap-card';
  const label = document.createElement('div');
  label.className = 'md-gap-label';
  label.textContent = `Open · ${gap.label}`;
  card.appendChild(label);

  const candidates = gapCandidates({ gap, dayArtists, ranked, me: ctx.meName, picks, passes, limit: 12 });
  if (candidates.length) {
    const hint = document.createElement('div');
    hint.className = 'md-gap-hint';
    hint.textContent = `${candidates.length} you’d like ${candidates.length === 1 ? 'is' : 'are'} playing then`;
    card.appendChild(hint);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'md-gap-chips';
    const renderChips = (expanded) => {
      chipsRow.textContent = '';
      const shown = expanded ? candidates : candidates.slice(0, 3);
      for (const c of shown) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'md-gap-chip';
        chip.textContent = `${c.name} · ${clockLabel(c.startMin)} ›`;
        chip.setAttribute('aria-label', `Open ${c.name}`);
        chip.addEventListener('click', () => { if (ctx.onTap) ctx.onTap(c.name); });
        chipsRow.appendChild(chip);
      }
      if (!expanded && candidates.length > 3) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'md-gap-more';
        more.textContent = `${candidates.length} you’d like ›`;
        more.addEventListener('click', () => renderChips(true));
        chipsRow.appendChild(more);
      }
    };
    renderChips(false);
    card.appendChild(chipsRow);
  }

  row.append(time, card);
  return row;
}

// ---- empty state (nothing marked yet) ----------------------------------------------
function buildEmptyCard(ctx, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'md-empty';
  const title = document.createElement('div');
  title.className = 'md-empty-title';
  title.textContent = 'Nothing marked yet';
  const sub = document.createElement('div');
  sub.className = 'md-empty-sub';
  sub.textContent = 'Discover deals you the deck — pick a few and your day fills in here.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'md-empty-btn';
  btn.textContent = 'Open Discover';
  btn.addEventListener('click', () => { openDeck(ctx, actions); router.push('discover'); });
  wrap.append(title, sub, btn);
  return wrap;
}

// ---- desktop rail (>=1200px, CSS-first — the DOM is always built) -------------------
function buildRail(day, clashes, gaps, dayArtists, ranked, ctx, actions, picks, passes) {
  const rail = document.createElement('div');
  rail.className = 'md-rail';

  const gapsCard = document.createElement('div');
  gapsCard.className = 'md-rail-card';
  const gapsTitle = document.createElement('div');
  gapsTitle.className = 'md-rail-title';
  gapsTitle.textContent = 'Fill your gaps';
  gapsCard.appendChild(gapsTitle);

  if (gaps.length) {
    // Earliest-first: the structural bias from the build spec ("early-day
    // gaps rank as higher discovery value") — no scoring needed, ordering IS
    // the bias.
    const sortedGaps = [...gaps].sort((a, b) => a.startMin - b.startMin);
    sortedGaps.forEach((gap, i) => {
      const cands = gapCandidates({ gap, dayArtists, ranked, me: ctx.meName, picks, passes, limit: 12 });
      const row = document.createElement('div');
      row.className = 'md-rail-gap';
      const win = document.createElement('div');
      win.className = 'md-rail-gap-win';
      win.textContent = `${gap.label} · ${durationLabel(gap.startMin, gap.endMin)} free`;
      const note = document.createElement('div');
      note.className = 'md-rail-gap-note';
      const artistsPhrase = cands.length
        ? ` ${cands.length} artist${cands.length === 1 ? '' : 's'} you’d like ${cands.length === 1 ? 'is' : 'are'} on.`
        : '';
      note.textContent = i === 0
        ? `Early-day gap — highest discovery value.${artistsPhrase}`
        : (cands.length ? artistsPhrase.trim() : 'Late slot — mostly headliners you’ve already weighed.');
      row.append(win, note);
      if (cands.length) {
        const seeWho = document.createElement('button');
        seeWho.type = 'button';
        seeWho.className = 'md-rail-seewho';
        seeWho.textContent = 'See who ›';
        seeWho.addEventListener('click', () => {
          document.querySelector(`.md-spine [data-gap-start="${gap.startMin}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        row.appendChild(seeWho);
      }
      gapsCard.appendChild(row);
    });
  } else {
    const none = document.createElement('div');
    none.className = 'md-rail-empty';
    none.textContent = 'No open gaps today.';
    gapsCard.appendChild(none);
  }
  rail.appendChild(gapsCard);

  if (clashes.length) {
    const clashCard = document.createElement('div');
    clashCard.className = 'md-rail-card md-rail-clash';
    const title = document.createElement('div');
    title.className = 'md-rail-title md-rail-clash-title';
    title.textContent = `⚡ ${clashes.length} clash${clashes.length === 1 ? '' : 'es'} to resolve`;
    clashCard.appendChild(title);
    const first = clashes[0];
    const names = document.createElement('div');
    names.className = 'md-rail-clash-names';
    names.textContent = first.sets.map((s) => s.name).join(' vs ');
    clashCard.appendChild(names);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'md-rail-opendecide';
    openBtn.textContent = 'Open Decide';
    openBtn.addEventListener('click', () => { openDecide(day, 0, ctx, actions); router.push(keyFor(day, 0)); });
    clashCard.appendChild(openBtn);
    rail.appendChild(clashCard);
  }

  return rail;
}

// ---- header (back, title, day tabs) -------------------------------------------------
function buildHeader(shell, fest, day, days, ctx, actions, canonData) {
  const topbar = document.createElement('div');
  topbar.className = 'md-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'md-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => { if (!router.requestClose()) closeMyDay(); });
  const title = document.createElement('div');
  title.className = 'md-title';
  title.textContent = `YOUR ${fullDayName(fest, day)}`;
  topbar.append(back, title);
  shell.appendChild(topbar);

  const tabs = document.createElement('div');
  tabs.className = 'md-tabs';
  for (const d of days) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'md-tab' + (d === day ? ' active' : '');
    const meta = (fest.dayMeta || {})[d];
    tab.textContent = (meta?.wd || d).slice(0, 3).toUpperCase();
    tab.setAttribute('aria-label', `Switch to ${fullDayName(fest, d)}`);
    tab.addEventListener('click', () => {
      dayByFid[ctx.fid] = d;
      render(ctx, actions, canonData);
    });
    tabs.appendChild(tab);
  }
  shell.appendChild(tabs);
}

// ---- body ----------------------------------------------------------------------------
function buildBody(shell, day, fest, ctx, actions, canonData) {
  const scroll = document.createElement('div');
  scroll.className = 'md-scroll';

  const dayArtists = state.getDayArtists(day);
  const picks = model.picksFor(state.crewDoc, ctx.fid);
  const passes = model.passesFor(state.crewDoc, ctx.fid);
  const plan = dayPlan({ dayArtists, picks, me: ctx.meName });

  const layout = document.createElement('div');
  layout.className = 'md-layout';
  const spine = document.createElement('div');
  spine.className = 'md-spine';
  layout.appendChild(spine);

  if (!plan.length) {
    spine.appendChild(buildEmptyCard(ctx, actions));
    scroll.appendChild(layout);
    shell.appendChild(scroll);
    return;
  }

  const bounds = computeDayBounds(dayArtists);
  const clashes = findClashes(plan);
  const gaps = findGaps(plan, bounds);
  // Same schedule-order wiring as wall.js/filter.js — gap-fill ranking must
  // not trust array position on a schedule-ordered festival.
  const order = fest.artistOrder || 'billing';
  const ranked = rankLineup({
    artists: fest.artists || [], picks, passes, me: ctx.meName, canonData,
    order, popularity: order === 'schedule' ? derivePopularity(fest) : undefined,
  });

  // SPIKE — a RESOLVED window is no longer a clash. The person decided;
  // continuing to flag it is nagging, and it was the loudest complaint about
  // this screen. Resolved windows contribute their sets as ordinary rows,
  // annotated with the plan, so the summary never hides an artist that was
  // considered.
  const resolved = new Map();   // clash -> resolution
  const openClashes = [];
  for (const c of clashes) {
    const r = getResolution(ctx.fid, day, c.sets.map((s) => s.name));
    if (r) resolved.set(c, r); else openClashes.push(c);
  }
  const clashedNames = new Set(openClashes.flatMap((c) => c.sets.map((s) => s.name)));
  const soloSets = plan.filter((s) => !clashedNames.has(s.name));
  const planOf = new Map();     // set name -> { role, alternates }
  for (const [c, r] of resolved) {
    for (const st of c.sets) {
      planOf.set(st.name, {
        role: r.kind === 'keep' ? 'keep' : (r.lead === st.name ? 'lead' : 'alt'),
        alternates: c.sets.filter((o) => o.name !== st.name),
      });
    }
  }
  const items = [
    ...soloSets.map((s) => ({ type: 'set', startMin: s.startMin, set: s, plan: planOf.get(s.name) || null })),
    ...openClashes.map((c) => ({
      type: 'clash', startMin: Math.min(...c.sets.map((s) => s.startMin)), clash: c,
      idx: clashes.indexOf(c),
    })),
    ...gaps.map((g) => ({ type: 'gap', startMin: g.startMin, gap: g })),
  ];
  items.sort((a, b) => a.startMin - b.startMin);

  for (const item of items) {
    if (item.type === 'set') spine.appendChild(buildSetRow(item.set, ctx, item.plan));
    else if (item.type === 'clash') spine.appendChild(buildClashRow(day, item.clash, item.idx, ctx, actions));
    else spine.appendChild(buildGapRow(item.gap, dayArtists, ranked, ctx, actions, picks, passes));
  }

  layout.appendChild(buildRail(day, clashes, gaps, dayArtists, ranked, ctx, actions, picks, passes));
  scroll.appendChild(layout);
  shell.appendChild(scroll);
}

function renderNoSchedule(overlay) {
  overlay.textContent = '';
  const shell = document.createElement('div');
  shell.className = 'md-shell';
  const topbar = document.createElement('div');
  topbar.className = 'md-topbar';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'md-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.addEventListener('click', () => { if (!router.requestClose()) closeMyDay(); });
  topbar.appendChild(back);
  shell.appendChild(topbar);
  const empty = document.createElement('div');
  empty.className = 'md-empty';
  empty.textContent = 'This festival has no set times yet.';
  shell.appendChild(empty);
  overlay.appendChild(shell);
}

// ---- overlay lifecycle ------------------------------------------------------------------
function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'my-day';
  document.body.appendChild(overlay);
  dialogize(overlay, 'Your day');
  return overlay;
}

function render(ctx, actions, canonData) {
  lastArgs = { ctx, actions, canonData };
  const overlay = ensureOverlay();
  const fest = state.FESTIVALS[ctx.fid] || {};
  const days = scheduledDays(fest);
  if (!days.length) { renderNoSchedule(overlay); return; }
  if (!dayByFid[ctx.fid] || !days.includes(dayByFid[ctx.fid])) {
    dayByFid[ctx.fid] = defaultDay(fest, ctx, days);
  }
  const day = dayByFid[ctx.fid];

  overlay.textContent = '';
  const shell = document.createElement('div');
  shell.className = 'md-shell';
  buildHeader(shell, fest, day, days, ctx, actions, canonData);
  buildBody(shell, day, fest, ctx, actions, canonData);
  overlay.appendChild(shell);
}

export function openMyDay(ctx, actions = {}) {
  ensureOverlay();
  myDayOpen = true;
  const gen = ++pendingOpenGen;
  const finish = (canonData) => {
    if (gen !== pendingOpenGen) return; // superseded by a newer open/close
    render(ctx, actions, canonData);
  };
  if (actions.canonData) finish(actions.canonData);
  else loadGenreCanon().then(finish);
}

export function closeMyDay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  myDayOpen = false;
  lastArgs = null;
  pendingOpenGen++;
}

export function isMyDayOpen() { return myDayOpen; }

// Sync/decide repaint hook (mirrors artist-page.js's refreshOpenArtistPage):
// a remote doc landing, or a Decide resolution (choose/split/on-site), must
// re-render the open day view live.
export function refreshOpenMyDay() {
  if (!myDayOpen || !lastArgs) return;
  render(lastArgs.ctx, lastArgs.actions, lastArgs.canonData);
}

// Exposed for tests only — the pure-ish render core, callable without the
// async canon load or the router. Mirrors deck.js's renderDeckForTest.
export function renderMyDayForTest(ctx, actions, canonData, day) {
  myDayOpen = true;
  if (day) dayByFid[ctx.fid] = day;
  lastArgs = { ctx, actions, canonData };
  render(ctx, actions, canonData || { canon: [], synonyms: {}, suppress: [] });
  return document.getElementById(OVERLAY_ID);
}
