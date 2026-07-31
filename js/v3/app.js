// v3 app shell: boot flow, screen switching (landing / create / join / wall /
// settings / lost states — all six render HERE), wall wiring, sync cadence,
// sheets (share moment, add member), and the server-side v4 migration call.
// wall.js renders the wall's CONTENT; settings.js and notes.js own their
// surfaces and mount into hosts this shell controls.
import * as state from '../state.js';
import * as crew from '../crew.js';
import * as sync from '../sync.js';
import * as spotify from '../spotify.js';
import * as model from './model.js';
import { loadFestivalIndex, loadFestival, loadCustomFestivals, FESTIVAL_INDEX, defaultFestivalId } from '../festivals.js';
import { renderWall, refreshCard, showUndoToast, showToast, wireScrollspy, colorIndexOf, groupByDay, knownDaysOf } from './wall.js';
import { disclosureFold, eqLoader, festRow } from './tools.js';
import { openArtistSheet, openDayNotes, openAllNotes, closeSheet, refreshOpenSheet, sheetChrome, dialogize, rememberOpener } from './notes.js';
import { openArtistPage, closeArtistPage, refreshOpenArtistPage } from '../discovery/artist-page.js';
import { renderSettings, appSettings, openSubviewByKey } from './settings.js';
import { onStorageWriteFail, saveLS } from '../util.js';
import { router } from './router.js';
import { createSortControl } from './sort-control.js';
import { nameProblem } from '../name-rules.mjs';
import { startFavicon, stopFavicon } from './favicon.js';
import { hslOf, strokeOf, nextColorIndex } from './palette.js';

const $ = (id) => document.getElementById(id);

// ---- view context ---------------------------------------------------------------
const ctx = {
  fid: null,
  meName: null,
  picks: {},
  affinity: null,
  query: '',
  sort: 'billing',
  lowPower: false,
  migrationPending: false,
  onTap: handleTap,
  onOpenNotes: (artist) => {
    openArtistSheet(artist, ctx, onNotesChange);
    router.push(`sheet:notes:${artist}`);
  },
  onOpenDayNotes: (day) => {
    openDayNotes(day, ctx, onNotesChange);
    router.push(`sheet:day:${day}`);
  },
  onNotesChange: () => onNotesChange(),
};

function onNotesChange() {
  sync.scheduleSync();
  repaintWall();
  // The notes sheet can be stacked ON TOP of an open artist page (its
  // "Add a note" button opens the same existing sheet) — a note added there
  // must show up in the page's own inline notes preview without a manual
  // reopen, same as the wall repaints underneath it.
  refreshOpenArtistPage();
}

function refreshCtx() {
  ctx.fid = state.activeFestivalId;
  ctx.meName = crew.me(state.getCrewToken());
  ctx.picks = model.picksFor(state.crewDoc, ctx.fid);
  ctx.affinity = state.affinityLookup(ctx.meName);
  // Weekend view is a device-local preference per fest (ST-3): set it once
  // ("I'm going W2") and wrong-weekend picks announce themselves.
  ctx.weekend = localStorage.getItem(`fn_weekend_v1_${ctx.fid}`) || 'all';
}

// ---- tap cycle -------------------------------------------------------------------
// Flow change (Discovery M3, build spec 7.1): tapping an artist name — wall
// row, timetable set, or any other renderCard consumer, since they all route
// through ctx.onTap — no longer cycles the pick inline. It opens the artist
// page instead; the pick cycle now lives on the page's headline tick. Every
// tap path (click AND the card's Enter/Space keydown) already calls
// ctx.onTap, so this one function change is the whole flow change.
function handleTap(artistName) {
  if (!ctx.meName) return;
  if (ctx.migrationPending) {
    showToast($('toast-root'), 'Updating this crew — picks unlock in a moment');
    return;
  }
  openArtistPage(artistName, ctx, artistPageActions);
  router.push('artist:' + artistName);
}

// recordSelection(For) writes pending only; mirror into the local doc for
// instant render — the artist page's pick/pass writes reuse this exact
// function (passed through artistPageActions) rather than duplicating it.
export function applyLocalPick(artist, person, level) {
  state.ensureFestivalState(ctx.fid);
  const sels = state.crewDoc.festivals[ctx.fid].selections;
  (sels[artist] = sels[artist] || {})[person] = level;
  state.persist();
}

// What the artist page needs from app.js that it can't reach without a
// circular import: the local-doc mirror above, and an undo toast bound to
// this shell's toast-root. Built once; ctx (also referenced) is the same
// live object the rest of the shell mutates in place via refreshCtx.
const artistPageActions = {
  applyLocalPick,
  showUndoToast: (message, onUndo) => showUndoToast($('toast-root'), message, onUndo),
};

// ---- header / toolbar / dock ------------------------------------------------------
function applyFestTheme() {
  const fest = state.fest();
  document.body.style.setProperty('--fest', fest.accent || '192, 132, 252');
  $('fest-name').textContent = fest.name.toUpperCase();
  $('fest-year').textContent = fest.year || '';
  $('fest-sub').textContent = [fest.subtitle, fest.dates].filter(Boolean).join(' · ');
  // Dock (mobile bottom) and day rail (desktop top) carry the same fest
  // name + sync dot — one component vocabulary, two positions (note 1.1).
  $('dock-fest-name').textContent = `${fest.name.toUpperCase()} ${fest.year || ''}`.trim();
  $('rail-fest-name').textContent = `${fest.name.toUpperCase()} ${fest.year || ''}`.trim();
  document.title = `${fest.name} — Festival Navigator`;
  startFavicon(fest.accent, { lowPower: ctx.lowPower });
}

// Chips switch identity through the app's two-tap confirm (FLOW-8 evolved,
// Kevin 2026-07-12): one stray thumb still can't reassign the device — the
// first tap only ARMS the chip ("Pick as Drew?"), the second within 3s
// switches. Shared-phone crews pick for each other without a settings trip.
function renderPersonChips() {
  const row = $('person-chips');
  row.textContent = '';
  for (const [name, p] of state.activePeople()) {
    const isMe = name === ctx.meName;
    // You are already you: your own chip is a label, not a switch. `static`
    // carries that (one mechanism, shared with Settings) instead of an inline
    // cursor override doing the same job a second way.
    const chip = document.createElement(isMe ? 'span' : 'button');
    chip.className = 'person-chip' + (isMe ? ' you static' : '');
    const ci = colorIndexOf(name, p);
    chip.style.background = hslOf(ci, 0.5);
    chip.style.border = '1px solid ' + strokeOf(ci, isMe);
    chip.textContent = name;
    if (!isMe && ctx.meName) {
      chip.setAttribute('aria-label', `Switch to picking as ${name}`);
      let armed = false;
      chip.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          chip.textContent = `Pick as ${name}?`;
          setTimeout(() => { armed = false; chip.textContent = name; }, 3000);
          return;
        }
        switchIdentity(name);
        repaintWall();
      });
    }
    row.appendChild(chip);
  }
  // Add-on-their-behalf lives right where the crew is visible (note 5) —
  // only for claimed devices; a spectator can't grow the crew.
  if (ctx.meName) {
    const add = document.createElement('button');
    add.className = 'person-chip add';
    add.textContent = '+ Add';
    add.setAttribute('aria-label', 'Add someone to the crew');
    add.style.cursor = 'pointer';
    add.addEventListener('click', () => { openAddMember(); router.push('sheet:add-member'); });
    row.appendChild(add);
  }
}

// The explicit identity switch (FLOW-8), called from Settings.
function switchIdentity(name) {
  crew.setMe(state.getCrewToken(), name);
  refreshCtx();
  renderPersonChips();
  renderYou();
  showToast($('toast-root'), `You’re ${name} on this device now.`);
}

// Paints BOTH "you" avatars — mobile dock and desktop day rail — from the
// same identity fact (unified chrome, note 1.1).
function renderYou() {
  for (const id of ['dock-you', 'rail-you']) {
    const you = $(id);
    you.textContent = '';
    if (!ctx.meName) continue;
    const p = state.people()[ctx.meName];
    const ci = colorIndexOf(ctx.meName, p);
    you.style.background = hslOf(ci, 0.5);
    you.textContent = ctx.meName.charAt(0).toUpperCase();
    you.title = ctx.meName;
    you.setAttribute('aria-label', `${ctx.meName} — jump to top`);
  }
}

// Sticky-chrome geometry, measured not hardcoded: the stage strip pins below
// the day rail (--rail-h; 0 on mobile where the rail is display:none), and
// day jumps land headers below rail + strip (--jump-offset via
// scroll-margin-top). Re-measured every repaint and on resize — fluid type
// makes both heights breakpoint-dependent.
function measureStickyChrome() {
  const rail = $('day-rail');
  const railH = rail && rail.offsetHeight ? rail.offsetHeight : 0;
  const strip = document.querySelector('.stage-strip');
  const stripH = strip ? strip.offsetHeight : 0;
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--rail-h', `${railH}px`);
  rootStyle.setProperty('--jump-offset', `${railH + stripH + 6}px`);
}

let unspy = () => {};
// One day list feeds BOTH navigations: the mobile dock and the desktop day
// rail (DT-1). Scheduled fests: tabs from days{} keys (labels via dayMeta
// weekday). Lineup fests: the same split-aware grouping the wall renders —
// a "Saturday & Sunday" artist must not mint its own tab (ST-1).
function renderDayNav() {
  const dock = $('dock-days');
  const rail = $('rail-days');
  dock.textContent = '';
  rail.textContent = '';
  const fest = state.fest();
  const scheduled = fest.days && Object.keys(fest.days).length;
  const groups = scheduled
    ? Object.keys(fest.days)
    : [...groupByDay(fest.artists || [], knownDaysOf(fest)).keys()].filter(Boolean);
  for (const day of groups) {
    const meta = (fest.dayMeta || {})[day];
    const jump = () => {
      const target = document.querySelector(`.day-rule[data-day="${CSS.escape(day)}"]`);
      if (target) target.scrollIntoView({ behavior: ctx.lowPower ? 'auto' : 'smooth', block: 'start' });
    };
    const mkTab = (label) => {
      const tab = document.createElement('button');
      tab.className = 'day-tab';
      tab.dataset.day = day;
      tab.textContent = label;
      tab.addEventListener('click', jump);
      return tab;
    };
    dock.appendChild(mkTab((meta?.wd || day).slice(0, 3).toUpperCase()));
    // Rail tabs stay compact: drop parenthetical asides from verbose day keys
    // ("Wednesday, Sept 16 (Early Arrival pre-party)" -> "WEDNESDAY, SEPT 16").
    const railLabel = meta?.wd ? `${meta.wd} ${meta.num || ''}`.trim() : day.replace(/\s*\(.*\)\s*$/, '');
    rail.appendChild(mkTab(railLabel.toUpperCase()));
  }
  unspy();
  unspy = wireScrollspy([dock, rail], $('wall-root'));
}

function repaintWall() {
  refreshCtx();
  renderWall($('wall-root'), ctx);
  renderDayNav();
  $('notes-count').textContent = String(model.totalNoteCount(state.crewDoc, ctx.fid));
  // A timetable has one true order — a sort control there would be a lie
  // (CORE-5). Searching a scheduled fest sorts chronologically by design.
  const scheduled = !!(state.fest().days && Object.keys(state.fest().days).length);
  $('sort-control').style.display = scheduled ? 'none' : '';
  updateMigrationBanner();
  updateWeekendRow();
  updateArchiveNote();
  maybeShowCoachMark();
  measureStickyChrome();
}

// Multi-weekend fests (ACL) get a weekend view (ST-3): pick yours once and
// the wall shows who's actually playing it; W1/W2-only artists carry a tag
// in the Both view so a wrong-weekend must can't sneak in.
function updateWeekendRow() {
  const existing = document.getElementById('weekend-row');
  const fest = state.fest();
  const has = (fest.artists || []).some((a) => a.weekends === 'W1' || a.weekends === 'W2');
  if (!has) { if (existing) existing.remove(); return; }
  let row = existing;
  if (!row) {
    row = document.createElement('div');
    row.id = 'weekend-row';
    row.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-top: 11px;';
    const lbl = document.createElement('span');
    lbl.className = 'micro-label';
    lbl.style.marginRight = '4px';
    lbl.textContent = 'Weekend';
    row.appendChild(lbl);
    for (const [val, label] of [['all', 'Both'], ['W1', 'One'], ['W2', 'Two']]) {
      const b = document.createElement('button');
      b.className = 'seg';
      b.dataset.w = val;
      b.textContent = label;
      b.addEventListener('click', () => {
        localStorage.setItem(`fn_weekend_v1_${ctx.fid}`, val);
        repaintWall();
      });
      row.appendChild(b);
    }
    document.querySelector('#screen-app .toolbar').after(row);
  }
  row.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.w === (ctx.weekend || 'all')));
}

// First-wall coach mark (CT-1): the pick mechanic and long-press are
// un-inferable — one dismissible line, once per device, pointing at the
// full legend for more.
const LS_COACH = 'fn_coach_v1';
function maybeShowCoachMark() {
  if (document.getElementById('coach-mark')) return;
  try { if (localStorage.getItem(LS_COACH)) return; } catch { return; }
  if (!ctx.meName) return;
  const bar = document.createElement('div');
  bar.id = 'coach-mark';
  bar.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-top: 11px; padding: 10px 13px; border: 1px solid var(--notes-chip-stroke); border-radius: var(--r-row); background: rgba(139, 123, 255, .07);';
  const msg = document.createElement('span');
  msg.style.cssText = 'flex: 1; color: var(--text-body); font-size: 12px; font-weight: 600; line-height: 1.45;';
  // Copy tracks the Discovery flow change: a tap OPENS the artist now; the
  // pick cycle lives on the page's tick.
  msg.append('Tap an artist to open it — sample a set, see the crew, and pick right there. ');
  const how = document.createElement('button');
  how.style.cssText = 'background: none; border: none; padding: 0; cursor: pointer; color: var(--notes-chip-text); font-size: 12px; font-weight: 700; text-decoration: underline; text-underline-offset: 2px;';
  how.textContent = 'How it works';
  how.addEventListener('click', () => {
    openSettings();
    router.push('settings');
    openSubviewByKey('sub:how', ctx, settingsActions);
    router.push('sub:how');
  });
  msg.appendChild(how);
  const dismiss = document.createElement('button');
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.style.cssText = 'background: none; border: none; cursor: pointer; color: var(--text-tertiary); font-size: 13px; flex: none; padding: 2px 4px;';
  dismiss.textContent = '✕';
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem(LS_COACH, '1'); } catch { /* private mode */ }
    bar.remove();
  });
  bar.append(msg, dismiss);
  insertStrip(bar);
}

// An archived fest reads as a memory, not a live plan (ST-5).
//
// The banner is keyed to the fest it was written for. It used to bail out with
// `if (existing) return`, so switching from one archived festival straight to
// another left the PREVIOUS festival's name sitting above the new one's wall —
// the screen calmly saying you were looking at Electric Forest while showing
// you Lollapalooza (finish pass, 2026-07-12).
function updateArchiveNote() {
  const existing = document.getElementById('archive-note');
  const fest = state.fest();
  if (fest.status !== 'archived') { if (existing) existing.remove(); return; }

  const text = `${fest.name} ${fest.year || ''} already happened — this wall is the memory. Picks still work for the record.`.replace('  ', ' ');
  if (existing) {
    if (existing.dataset.fid !== fest.id) {
      existing.dataset.fid = fest.id;
      existing.textContent = text;
    }
    return;
  }
  const bar = document.createElement('div');
  bar.id = 'archive-note';
  bar.dataset.fid = fest.id;
  bar.style.cssText = 'margin-top: 11px; padding: 9px 13px; border: 1px solid var(--border-card); border-radius: var(--r-row); color: var(--text-secondary); font-size: 12px; font-weight: 600; line-height: 1.45; background: var(--card);';
  bar.textContent = text;
  insertStrip(bar);
}


// Toolbar strips insert in call order (audit 1.4): each lands after the last
// existing strip, so priority order in code IS priority order on screen.
function insertStrip(bar) {
  bar.classList.add('toolbar-strip');
  const strips = document.querySelectorAll('#screen-app .toolbar-strip');
  const anchor = strips.length ? strips[strips.length - 1] : document.querySelector('#screen-app .toolbar');
  anchor.after(bar);
}

// While a legacy crew's server-side migration is pending, picking is gated —
// a persistent banner says so instead of leaving taps mysteriously dead
// (CORE-18). Notes and reading work throughout.
function updateMigrationBanner() {
  const existing = document.getElementById('migration-banner');
  if (!ctx.migrationPending) { if (existing) existing.remove(); return; }
  let bar = existing;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'migration-banner';
    bar.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-top: 11px; padding: 10px 13px; border: 1px solid rgba(245, 158, 11, .35); border-radius: var(--r-row); background: rgba(245, 158, 11, .08);';
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.style.cssText = 'flex: 1; color: var(--text-body); font-size: 12px; font-weight: 600; line-height: 1.45;';
    const retry = document.createElement('button');
    retry.className = 'btn-tonal';
    retry.style.cssText = 'font-size: 11.5px; padding: 7px 13px; flex: none;';
    retry.textContent = 'Try now';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      await sync.requestMigration();
      ctx.migrationPending = model.needsMigration(state.crewDoc);
      retry.disabled = false;
      if (!ctx.migrationPending) repaintWall();
      else updateMigrationBanner();
    });
    bar.append(msg, retry);
    insertStrip(bar);
  }
  bar.querySelector('.msg').textContent = navigator.onLine
    ? 'Updating this crew to the new pick format — picks unlock in a moment.'
    : 'You’re offline — picks unlock after one online update. Notes and reading work now.';
}

// ---- screens ----------------------------------------------------------------------
const SCREENS = ['screen-landing', 'screen-join', 'screen-create', 'screen-app', 'screen-settings', 'screen-badlink', 'screen-error'];
function show(screen) {
  for (const id of SCREENS) {
    $(id).style.display = id === screen ? '' : 'none';
  }
}
const anyScreenVisible = () => SCREENS.some((id) => $(id).style.display !== 'none');

// ---- create (spec F2, reshaped 2026-07-14): multi-pick fests, name once ------------

// The shared row (tools.js). This used to be a second hand-built copy, and the
// copy is how Settings ended up showing past festivals at full weight while
// this screen muted them.
function festPickRow(f, { muted = false, onPick }) {
  return festRow(f, { muted, onPick });
}

// Multi-pick (fests × circles × you, decision 2): tap toggles a fest into the
// selection, one button creates a board per fest. "Add all the fests I'm
// going to, then quickly add people to them" — the people step is gone from
// here entirely; people questions live on each fest's + Add.
const createSel = new Set();
function renderCreate() {
  show('screen-create');
  createSel.clear();
  $('create-step-1').style.display = 'flex';
  $('create-step-2').style.display = 'none';
  $('create-status').textContent = '';
  const list = $('create-fests');
  list.textContent = '';
  const goBtn = document.createElement('button');
  goBtn.id = 'create-go-multi';
  goBtn.className = 'btn-tonal';
  goBtn.style.cssText = 'font-size: 15px; padding: 13px 24px; width: 100%;';
  const paintGo = () => {
    const n = createSel.size;
    // The server rate-limits crew creation at 10/hour per IP — a batch it
    // cannot finish must not start (Codex reshape gate, P2). 8 leaves
    // headroom for singles in the same hour.
    goBtn.disabled = !n || n > 8;
    goBtn.textContent = !n ? 'Pick your fests'
      : n > 8 ? '8 at a time is the max'
        : `ADD ${n} FESTIVAL${n === 1 ? '' : 'S'} →`;
  };
  const pick = (f, rowEl) => {
    if (createSel.has(f.id)) createSel.delete(f.id);
    else createSel.add(f.id);
    rowEl.classList.toggle('sel-fest', createSel.has(f.id));
    paintGo();
  };
  for (const f of FESTIVAL_INDEX.filter((x) => x.status !== 'archived')) {
    const rowEl = festPickRow(f, { onPick: () => pick(f, rowEl) });
    list.appendChild(rowEl);
  }
  // Past festivals stay reachable (spec F2/F12) but folded: full-size rows
  // gave history the same weight as the fests you'd actually plan — the
  // wrong emphasis on the doorway screen (Kevin note 8).
  const past = FESTIVAL_INDEX.filter((x) => x.status === 'archived');
  if (past.length) {
    list.appendChild(disclosureFold(`Past festivals · ${past.length}`, (rows) => {
      for (const f of past) {
        const rowEl = festPickRow(f, { muted: true, onPick: () => pick(f, rowEl) });
        rows.appendChild(rowEl);
      }
    }));
  }
  list.appendChild(goBtn);
  paintGo();
  goBtn.addEventListener('click', () => {
    if (!createSel.size || createInFlight) return;
    // A device that already knows who it is skips the name step forever.
    const p = crew.myPerson();
    if (p && p.name) { batchCreateFlow(p.name); return; }
    createStepName();
  });
}

function chosenFestChip(f) {
  const chip = document.createElement('span');
  chip.style.cssText = `display: inline-flex; align-items: baseline; gap: 6px; border: 1.5px solid rgba(${f.accent || '192, 132, 252'}, .55); border-radius: var(--r-pill); padding: 8px 16px; font-family: var(--font-display); letter-spacing: .04em; font-size: 15px; color: rgb(${f.accent || '237, 234, 244'});`;
  chip.textContent = `${f.name.toUpperCase()} ${f.year || ''}`.trim();
  return chip;
}

// Name step — only ever seen ONCE per device (no person record yet). After
// that, the me link knows who you are and multi-pick goes straight to boards.
function createStepName() {
  $('create-step-1').style.display = 'none';
  $('create-step-2').style.display = 'flex';
  $('create-status').textContent = '';
  const chosen = $('create-chosen');
  chosen.textContent = '';
  for (const fid of createSel) {
    const meta = FESTIVAL_INDEX.find((f) => f.id === fid);
    if (meta) chosen.appendChild(chosenFestChip(meta));
  }
  $('create-name-input').focus();
}

// One board per picked fest, each its own circle of one (decision 2 — a fest
// never lands in an existing circle from here; deliberate multi-fest circles
// use Settings → Your festivals → + Add a festival). Sequential creates so
// a mid-batch failure reports exactly what made it and what didn't.
// Re-entrancy: guarded module-wide — a double-tap must never mint duplicate
// circles (Codex reshape gate, P1). Cross-tab double-creates remain possible
// (no server idempotency key yet) — accepted at this app's scale, the rate
// limiter caps the damage.
let createInFlight = false;
async function batchCreateFlow(myName) {
  if (createInFlight) return;
  const status = $('create-status');
  const problem = nameProblem(myName);
  if (problem) { createStepName(); status.textContent = problem; return; }
  createInFlight = true;
  const goBtns = ['create-go-multi', 'create-go-btn'].map((id) => $(id)).filter(Boolean);
  goBtns.forEach((b) => { b.disabled = true; });
  try {
    const fids = [...createSel];
    const made = [];
    let failed = null;
    status.textContent = '';
    status.appendChild(eqLoader('Setting the stage…'));
    // AWAITED, not fire-and-forget: every board must land on the person
    // record before we leave this screen, or a My-link restore can't recover
    // unopened boards (Codex reshape gate, P1). Born linked when possible —
    // the create body carries the pid.
    const person = await crew.ensurePerson(myName);
    for (const fid of fids) {
      const meta = FESTIVAL_INDEX.find((f) => f.id === fid);
      if (!meta) continue;
      try {
        // SAFE_NAME_RE bans apostrophes — "'26" becomes "26" in the crew name.
        const crewName = `${meta.name} ${(meta.year || '').replace(/'/g, '')}`.trim().slice(0, 40);
        const { token, doc } = await crew.createCrew(crewName, myName,
          { colorIndex: 0, ...(person ? { pid: person.id } : {}) }, fid);
        crew.setMe(token, myName);
        crew.rememberCrew(token, crewName);
        saveLS(state.LS.fest(token), fid);
        // Cache the doc so the landing can render this fest's row immediately
        // (the fest-first landing reads cached docs for its pairs).
        saveLS(state.LS.doc(token), JSON.stringify(doc));
        // The stamp returns false on failure rather than throwing — check it,
        // retry once, and never report a board as recovery-linked when it
        // isn't (Codex verify round, high). An unstamped board still lives on
        // this device; the enterApp backfill stamps it on first open — the
        // only true loss window is device-wipe-before-open, and the toast
        // below says so instead of pretending.
        let stamped = false;
        if (person) {
          stamped = await crew.stampPersonCrew(token, myName, crewName)
            || await crew.stampPersonCrew(token, myName, crewName);
        }
        made.push({ token, doc, fid, name: meta.name, stamped });
      } catch (e) {
        failed = { name: meta.name, err: String(e.message || e) };
        break; // stop the batch — the same failure would repeat (rate limit, offline)
      }
    }
    if (!made.length) {
      const raw = failed ? failed.err : 'Nothing was created.';
      status.textContent = /fetch|network|load/i.test(raw) && !/crew|name|festival/i.test(raw)
        ? 'Couldn’t reach the crew service — check your connection and try again.'
        : raw;
      return;
    }
    if (made.length === 1 && !failed) {
      // Single fest keeps today's arc: straight onto the board, share moment
      // up. The board EXISTS by now — an activation failure (fest asset
      // uncached + offline) must not strand the create screen inviting a
      // duplicate retry (Codex reshape gate, P2): fall back to the landing,
      // where the new row already is.
      const { token, doc, fid } = made[0];
      try {
        await enterApp(token, doc);
        state.recordInviteFest(fid); // invites resolve on fresh devices (FLOW-1)
        sync.scheduleSync();
        openShareMoment();
        router.push('sheet:share');
      } catch {
        history.replaceState(null, '', '/');
        renderLanding();
        showToast($('toast-root'), 'Board created — it couldn’t open just now, but it’s on your list.', 6000);
      }
      return;
    }
    // Several boards born: land on the festival list where they all are —
    // "add all the fests I'm going to, then quickly add people to them."
    history.replaceState(null, '', '/');
    renderLanding();
    const unstamped = made.filter((m) => !m.stamped).length;
    let note = failed
      ? `${made.length} ready — ${failed.name} didn’t make it (${failed.err}). It’s still in the picker.`
      : `${made.length} festivals ready — tap one and add your people.`;
    if (unstamped) note += ` (${unstamped} not on your My link yet — opening each fixes that.)`;
    showToast($('toast-root'), note, 8000);
  } finally {
    createInFlight = false;
    goBtns.forEach((b) => { b.disabled = false; });
  }
}


// ---- the share moment (FLOW-7/FLOW-12) ----------------------------------------------
// One centered dialog right after create (and re-openable from Settings):
// the link is VISIBLE — share sheets fail silently, a printed URL never does.
function openShareMoment() {
  rememberOpener();
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'sheet-backdrop';
  backdrop.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'artist-sheet'; // closeSheet + the router's sheet kind own this id
  // The shared chrome from notes.js — grabber that really swipes, title, and a
  // real ✕. This sheet used to hand-copy the markup, which is exactly how it
  // drifted into having no close button and no dialog semantics while looking
  // pixel-identical to the ones that do.
  sheetChrome(sheet, 'ONE LINK MAKES IT A CREW');
  const sub = document.createElement('div');
  sub.style.cssText = 'color: var(--text-secondary); font-size: 12.5px; line-height: 1.55;';
  sub.textContent = `Anyone who opens it lands in ${state.crewName()} — no accounts, no setup.`;
  const link = crew.crewLink(state.getCrewToken(), state.activeFestivalId);
  if ((state.crewDoc.meta || {}).inviteFestId !== state.activeFestivalId) {
    state.recordInviteFest(state.activeFestivalId);
    sync.scheduleSync();
  }
  const linkRowEl = document.createElement('div');
  linkRowEl.style.cssText = 'display: flex; gap: 8px; align-items: center;';
  const linkBox = document.createElement('input');
  linkBox.readOnly = true;
  linkBox.value = link;
  linkBox.setAttribute('aria-label', 'Crew invite link');
  linkBox.style.cssText = 'flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--border-input); border-radius: var(--r-card); padding: 10px 12px; color: var(--text-body); font-size: 12px; font-family: var(--font-ui);';
  linkBox.addEventListener('focus', () => linkBox.select());
  const copy = document.createElement('button');
  copy.className = 'btn-tonal';
  copy.style.cssText = 'font-size: 12px; padding: 9px 15px; flex: none;';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1800); }
    catch { linkBox.select(); }
  });
  linkRowEl.append(linkBox, copy);
  const actionsRow = document.createElement('div');
  actionsRow.style.cssText = 'display: flex; gap: 8px;';
  if (navigator.share) {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-tonal';
    shareBtn.style.cssText = 'flex: 1; font-size: 13px; padding: 11px;';
    shareBtn.textContent = 'Share the link';
    shareBtn.addEventListener('click', async () => {
      try { await navigator.share({ title: 'Festival Navigator', url: link }); }
      catch { /* dismissed — the visible link is the fallback */ }
    });
    actionsRow.appendChild(shareBtn);
  }
  const later = document.createElement('button');
  later.className = 'btn-ghost';
  later.style.cssText = 'font-size: 12px; padding: 11px 16px;' + (navigator.share ? '' : ' flex: 1;');
  later.textContent = 'Later';
  later.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
  actionsRow.appendChild(later);
  sheet.append(sub, linkRowEl, actionsRow); // chrome (grabber + title + ✕) is already on
  dialogize(sheet, 'Share your crew link');
  document.body.append(backdrop, sheet);
}

// ---- add a member on their behalf (Kevin note 5, 2026-07-12) -----------------------
// Shared-phone crews: one person tracks for everyone; not everyone joins via
// a link. Server-first like the join screen (FLOW-5) so the people-cap
// answers here; offline falls back to the local doc + sync. Success mints the
// per-person claim link (&me=) — opening it lands them on THEIR circle with
// every pick already theirs.
function openAddMember() {
  rememberOpener();
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'sheet-backdrop';
  backdrop.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'artist-sheet'; // closeSheet + the router's sheet kind own this id
  sheetChrome(sheet, 'ADD SOMEONE'); // one sheet anatomy, everywhere (see openShareMoment)
  const sub = document.createElement('div');
  sub.style.cssText = 'color: var(--text-secondary); font-size: 12.5px; line-height: 1.55;';
  sub.textContent = 'You pick for them until they claim it — their link makes it theirs the moment they open it.';
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 8px; align-items: center;';
  const input = document.createElement('input');
  input.maxLength = 24;
  input.placeholder = 'Their name';
  input.setAttribute('aria-label', 'Their name');
  input.style.cssText = 'flex: 1; min-width: 0; background: var(--page); border: 1px solid var(--border-input); border-radius: var(--r-card); padding: 11px 12px; color: #fff; font-size: 14px; font-family: var(--font-ui);';
  const addBtn = document.createElement('button');
  addBtn.className = 'btn-tonal';
  addBtn.style.cssText = 'font-size: 13px; padding: 11px 20px; flex: none;';
  addBtn.textContent = 'Add';
  row.append(input, addBtn);
  const status = document.createElement('div');
  status.style.cssText = 'color: var(--text-tertiary); font-size: 11.5px; font-weight: 600;';
  sheet.append(sub, row, status); // chrome (grabber + title + ✕) is already on
  // Recurring humans, one tap (fests × circles × you, decision 4): the people
  // from your OTHER fests — Drew doesn't get retyped a third time.
  const others = model.otherFestPeople(
    state.getCrewToken(), crew.knownCrews(), state.cachedDoc, state.people(), ctx.meName,
  );
  if (others.length) {
    const pickWrap = document.createElement('div');
    const pickLabel = document.createElement('div');
    pickLabel.className = 'micro-label';
    pickLabel.style.cssText = 'margin-bottom: 7px;';
    pickLabel.textContent = 'From your other fests';
    const chips = document.createElement('div');
    chips.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
    for (const { name } of others.slice(0, 12)) {
      const chip = document.createElement('button');
      chip.className = 'btn-tonal';
      chip.style.cssText = 'font-size: 12.5px; padding: 7px 13px;';
      chip.textContent = `+ ${name}`;
      chip.addEventListener('click', () => { input.value = name; doAdd(); });
      chips.appendChild(chip);
    }
    pickWrap.append(pickLabel, chips);
    sheet.appendChild(pickWrap);
  }
  dialogize(sheet, 'Add someone to the crew');
  document.body.append(backdrop, sheet);
  input.focus();

  const succeed = (canonical) => {
    refreshCtx();
    renderPersonChips();
    repaintWall();
    sheet.textContent = '';
    // Re-chrome the success state too, or it loses the ✕ and the swipe-to-close
    // the moment it becomes the thing you are actually looking at.
    sheetChrome(sheet, `${canonical.toUpperCase()} IS IN`);
    const explain = document.createElement('div');
    explain.style.cssText = 'color: var(--text-secondary); font-size: 12.5px; line-height: 1.55;';
    explain.textContent = `Pick for ${canonical} by switching to them in Settings → You. Or send them their own link — opening it puts your picks in their hands:`;
    const link = crew.crewLink(state.getCrewToken(), state.activeFestivalId, canonical);
    const linkRowEl = document.createElement('div');
    linkRowEl.style.cssText = 'display: flex; gap: 8px; align-items: center;';
    const linkBox = document.createElement('input');
    linkBox.readOnly = true;
    linkBox.value = link;
    linkBox.setAttribute('aria-label', `${canonical}'s personal invite link`);
    linkBox.style.cssText = 'flex: 1; min-width: 0; background: var(--card); border: 1px solid var(--border-input); border-radius: var(--r-card); padding: 10px 12px; color: var(--text-body); font-size: 12px; font-family: var(--font-ui);';
    linkBox.addEventListener('focus', () => linkBox.select());
    const copy = document.createElement('button');
    copy.className = 'btn-tonal';
    copy.style.cssText = 'font-size: 12px; padding: 9px 15px; flex: none;';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1800); }
      catch { linkBox.select(); }
    });
    linkRowEl.append(linkBox, copy);
    const actionsRow = document.createElement('div');
    actionsRow.style.cssText = 'display: flex; gap: 8px;';
    if (navigator.share) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'btn-tonal';
      shareBtn.style.cssText = 'flex: 1; font-size: 13px; padding: 11px;';
      shareBtn.textContent = `Share ${canonical}’s link`;
      shareBtn.addEventListener('click', async () => {
        try { await navigator.share({ title: 'Festival Navigator', url: link }); }
        catch { /* dismissed — the visible link is the fallback */ }
      });
      actionsRow.appendChild(shareBtn);
    }
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn-ghost';
    doneBtn.style.cssText = 'font-size: 12px; padding: 11px 16px;' + (navigator.share ? '' : ' flex: 1;');
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => { if (!router.requestClose()) closeSheet(); });
    actionsRow.appendChild(doneBtn);
    sheet.append(explain, linkRowEl, actionsRow);
  };

  const doAdd = async () => {
    const name = input.value.trim();
    const problem = nameProblem(name);
    if (problem) { status.textContent = problem; return; }
    // Never apply one crew's add to another crew's state (sync.js's own
    // convention): switching crews while the request is in flight must
    // abandon the result, or the person lands in the WRONG crew — and the
    // offline branch would even persist + push it there (Codex arc gate P1).
    const tokenAtStart = state.getCrewToken();
    const people = state.people();
    const activeMatch = Object.entries(people)
      .find(([n, p]) => n.toLowerCase() === name.toLowerCase() && state.isActivePerson(p));
    if (activeMatch) { status.textContent = `${activeMatch[0]} is already in this crew.`; return; }
    // A removed member returning keeps their old key — resurrecting brings
    // their history back, same as the join screen's reclaim path.
    const removedMatch = Object.entries(people)
      .find(([n]) => n.toLowerCase() === name.toLowerCase());
    const canonical = removedMatch ? removedMatch[0] : name;
    const taken = Object.values(people).map((p) => p.colorIndex).filter(Number.isInteger);
    const person = { colorIndex: nextColorIndex(taken), removed: false };
    addBtn.disabled = true;
    status.textContent = '';
    status.appendChild(eqLoader(`Adding ${canonical}…`));
    try {
      const res = await fetch(`/api/crew?t=${encodeURIComponent(tokenAtStart)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { people: { [canonical]: person } }, sv: 4 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (state.getCrewToken() !== tokenAtStart) return; // crew switched mid-flight
        status.textContent = body.error || 'The crew service hiccuped — give it a second and try again.';
        return;
      }
      const merged = await res.json();
      // The switch check comes AFTER the last await, or a crew change during
      // the json() parse still slips the old crew's doc into the new crew's
      // state (TOCTOU — commit security review, 2026-07-12).
      if (state.getCrewToken() !== tokenAtStart) return;
      state.applyRemoteDoc(merged);
      succeed(canonical);
    } catch {
      if (state.getCrewToken() !== tokenAtStart) return; // crew switched mid-flight
      // Offline: local-first add, sync catches up — same as every pick.
      state.recordPerson(canonical, person);
      state.crewDoc.people[canonical] = person;
      state.persist();
      sync.scheduleSync();
      succeed(canonical);
    } finally {
      addBtn.disabled = false;
    }
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
}

// The heading's ‹ returns to the fest list (Kevin note 5, "like we had
// before") as a REAL history entry — browser back from the landing returns
// to the wall you left.
function goToFestList() {
  closeSheet();
  router.reset();
  history.pushState(null, '', '/');
  renderLanding();
}

// ---- settings (one page, two doors) -----------------------------------------------
function applyLowPower(on) {
  ctx.lowPower = !!on;
  document.body.classList.toggle('low-power', ctx.lowPower);
  if (ctx.lowPower) stopFavicon();
  else if (state.getCrewToken()) startFavicon(state.fest()?.accent, { lowPower: false });
}

// The most recent settings actions object — the router's forward re-open of
// a settings drill needs it (openSettings rebuilds it on every render).
let settingsActions = null;
function closeSettings() { show('screen-app'); repaintWall(); }

function openSettings() {
  closeSheet();
  refreshCtx();
  show('screen-settings');
  settingsActions = {
    close: () => { if (!router.requestClose()) closeSettings(); },
    rerender: openSettings,
    switchFestival: async (fid) => {
      // Load BEFORE persisting the switch: an offline device must never be
      // left pointing at a festival it cannot render (CORE-12).
      try { await loadFestival(fid); }
      catch {
        showToast($('toast-root'), 'Can’t open that festival offline yet — it loads once you’re back online.');
        return;
      }
      state.setActiveFestivalId(fid);
      state.ensureFestivalState(fid);
      state.setCurrentDay(null);
      // Drop the search query with the festival it belonged to. It used to
      // survive the switch, so arriving at a festival you had never searched
      // showed you "No artists match" over a full lineup — the app reporting an
      // empty festival because of something you typed on a different one.
      ctx.query = '';
      const searchBox = $('search-input');
      if (searchBox) searchBox.value = '';
      // The scanned library is a device asset — switching fests badges the
      // new lineup from the cache, no rescan (SPOT-5).
      // A festival you just added (or switched to) badges itself from the
      // library already on this device — no reconnect, no rescan, no trip to
      // Settings. "If I add fests later Spotify should just pull" (Kevin,
      // 2026-07-12); this is the "just pull".
      if (ctx.meName && spotify.isConnected() && spotify.libraryMap()) {
        try {
          const names = spotify.artistNamesOf(state.fest());
          if (spotify.applyAffinityToCrew(ctx.meName, [...names]) > 0) sync.scheduleSync();
        } catch { /* stale map — "Read it again" in the drill is the recovery */ }
      }
      applyFestTheme();
      if (!router.requestClose()) closeSettings();
      sync.pollSync();
    },
    onLowPower: (on) => { applyLowPower(on); },
    onStayOffline: (on) => { sync.setStayOffline(on); if (!on) sync.pushSync(); },
    recordPick: (artist, person, level) => {
      if (ctx.migrationPending) return false; // same gate as handleTap (bulk paste path)
      state.recordSelection(artist, person, level);
      applyLocalPick(artist, person, level);
      return true;
    },
    afterBulk: () => { sync.scheduleSync(); refreshCtx(); },
    // FLOW-8: identity change is an explicit, named action — never a chip tap.
    switchIdentity: (name) => switchIdentity(name),
    // Add-on-their-behalf (note 5): the sheet opens OVER settings.
    addMember: () => { openAddMember(); router.push('sheet:add-member'); },
    // FLOW-6: the landing is the crew switcher; the current crew stays remembered.
    switchCrew: () => {
      router.reset();
      history.replaceState(null, '', '/');
      renderLanding();
    },
    // Fest-first: settings lists YOUR boards; adding goes to the shared
    // multi-pick page, and a board in another circle opens like a landing row.
    addFestival: () => {
      router.reset();
      location.hash = '#new';
      boot();
    },
    openBoard: (token, fid) => {
      saveLS(state.LS.fest(token), fid);
      let stored = null;
      try { stored = localStorage.getItem(state.LS.fest(token)); } catch { /* read denied */ }
      if (stored !== fid) {
        showToast($('toast-root'), 'This device’s storage is blocked — couldn’t point the board at that festival.', 6000);
        return;
      }
      router.reset();
      location.hash = `#g=${token}`;
      boot();
    },
    leaveCrew: () => {
      const t = state.getCrewToken();
      crew.forgetCrew(t);
      router.reset();
      history.replaceState(null, '', '/');
      renderLanding();
      showToast($('toast-root'), 'Crew forgotten on this device — the invite link gets you back in.', 6000);
    },
    // Self-rename (FLOW-11): a person IS their key in the doc, so renaming is
    // new person + tombstone old + picks (and Spotify badges) migrated through
    // the normal additive merge. Old notes keep the old byline — honest history.
    renameSelf: (newName) => {
      const old = ctx.meName;
      const person = state.people()[old];
      state.recordPerson(newName, { colorIndex: colorIndexOf(old, person) });
      // recordPerson writes pending only — mirror into the local doc so the
      // rename is visible before the sync round-trip (recorder convention).
      state.crewDoc.people[newName] = { colorIndex: colorIndexOf(old, person) };
      for (const [fid, entry] of Object.entries(state.crewDoc.festivals || {})) {
        for (const [artist, byPerson] of Object.entries(entry.selections || {})) {
          const level = model.readLevel(state.crewDoc, byPerson[old]);
          if (level > 0) {
            state.recordSelectionFor(fid, artist, newName, level);
            // Tombstone the OLD name's pick too (level 0) — "your picks move
            // with you" means MOVE: without this, Export Likes ghosts the old
            // name forever and a reused name would double-render picks
            // (Codex ship gate, P2).
            state.recordSelectionFor(fid, artist, old, 0);
            state.ensureFestivalState(fid);
            const sels = state.crewDoc.festivals[fid].selections;
            (sels[artist] = sels[artist] || {})[newName] = level;
            sels[artist][old] = 0;
          }
        }
      }
      const aff = state.affinityFor(old);
      if (aff) state.recordAffinity(newName, aff);
      state.recordPerson(old, { removed: true });
      if (state.crewDoc.people[old]) state.crewDoc.people[old].removed = true;
      state.persist();
      crew.setMe(state.getCrewToken(), newName);
      sync.scheduleSync();
      refreshCtx();
      renderPersonChips();
      renderYou();
      stampIdentity(state.getCrewToken(), () => true, { renameFrom: old }); // the record follows a self-rename
      showToast($('toast-root'), `You’re ${newName} now — picks came with you.`);
    },
    changeColor: (idx) => {
      // Spread the queued entry: recordPerson REPLACES pending.people[name],
      // and a color change must not eat a not-yet-pushed pid stamp (or vice
      // versa — stampIdentity spreads for the same reason).
      const queuedColor = (state.pendingChanges.people || {})[ctx.meName] || {};
      state.recordPerson(ctx.meName, { ...queuedColor, colorIndex: idx });
      const mine = state.people()[ctx.meName];
      if (mine) mine.colorIndex = idx; // local doc mirror for instant render
      state.persist();
      sync.scheduleSync();
      refreshCtx();
      renderPersonChips();
      renderYou();
    },
  };
  renderSettings($('settings-root'), ctx, settingsActions);
}

// Union a fetched person doc into this device: remember every crew, claim
// unclaimed names, store the person. Never removes anything. Shared by the
// me-link restore (renders landing after) and the canonical-host hop absorb
// (falls through into the crew flow instead).
function absorbPersonDoc(token, fetched, { replaceIdentity = true } = {}) {
  const doc = fetched.doc || {};
  if (replaceIdentity || !crew.myPerson()) {
    crew.setMyPerson({ token, id: fetched.id, name: doc.name || '', crews: doc.crews || {} });
  }
  for (const [ct, entry] of Object.entries(doc.crews || {})) {
    const known = crew.knownCrews().find((c) => c.token === ct);
    crew.rememberCrew(ct, (entry && entry.crewName) || (known && known.name) || '');
    if (entry && entry.name && !crew.me(ct)) crew.setMe(ct, entry.name);
  }
  return Object.keys(doc.crews || {}).length;
}

// Opening a me link on any device: pull the person record, register every
// crew it lists (union — never removes anything this device already knows),
// claim the names, land on the landing with the lot. boot() strips the hash
// before calling this — the master key never survives past the first frame.
// `current` is boot's generation guard: a stale restore racing a newer boot
// must not write a word (the sync.js tokenAtStart convention).
async function restoreFromMeLink(token, current = () => true) {
  let fetched = null, failed = false;
  try { fetched = await crew.fetchPerson(token); } catch { failed = true; }
  if (!current()) return;
  if (!fetched) {
    renderLanding();
    showToast($('toast-root'), failed
      ? 'Couldn’t reach the server — open your link again once you’re online.'
      : 'That link doesn’t work anymore.', 6000);
    return;
  }
  const total = absorbPersonDoc(token, fetched);
  const doc = fetched.doc || {};
  renderLanding();
  showToast($('toast-root'), total
    ? `Welcome back${doc.name ? ', ' + doc.name : ''} — ${total} crew${total === 1 ? '' : 's'} on this device now.`
    : 'Link saved — crews you join will follow you from here.', 6000);
}

function renderLanding() {
  show('screen-landing');
  document.title = 'Festival Navigator';

  // YOU card (21a + me link): who this device is, and the one link that
  // rebuilds everything on a new one. Only renders once a person exists —
  // a fresh visitor sees the pitch, not plumbing.
  const youBox = $('landing-you');
  youBox.textContent = '';
  const person = crew.myPerson();
  if (person) {
    const card = document.createElement('div');
    card.className = 'landing-you-card';
    const av = document.createElement('span');
    av.className = 'avatar lg';
    av.style.background = 'rgba(192, 132, 252, .28)';
    av.style.border = '1px solid rgba(192, 132, 252, .6)';
    av.textContent = (person.name || 'Y').charAt(0).toUpperCase();
    const mid = document.createElement('div');
    mid.style.cssText = 'flex: 1; min-width: 0;';
    const nm = document.createElement('div');
    nm.style.cssText = 'color: #fff; font-weight: 700; font-size: 14px;';
    nm.textContent = person.name || 'You';
    const hint = document.createElement('div');
    hint.className = 'mini-copy';
    hint.textContent = 'Open your link on a new phone and everything comes back — every crew, every pick. Sharing it makes someone else you, so don’t.';
    mid.append(nm, hint);
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-tonal';
    copyBtn.style.cssText = 'font-size: 12px; padding: 9px 14px; flex: none;';
    copyBtn.textContent = 'My link';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(crew.meLink());
        copyBtn.textContent = 'Copied ✓';
      } catch {
        copyBtn.textContent = crew.meLink() ? 'See below' : 'No link yet';
        if (crew.meLink()) hint.textContent = crew.meLink();
      }
      setTimeout(() => { copyBtn.textContent = 'My link'; }, 1800);
    });
    card.append(av, mid, copyBtn);
    youBox.appendChild(card);
  }

  // FESTIVAL rows, not crew rows (fests × circles × you, 2026-07-14): every
  // (crew, fest) pair is one row in festival-index order — tapping Seismic
  // opens Seismic, whatever circle it lives in. Two circles at one fest =
  // two rows, told apart by their people (unfused until the merged-board arc).
  const list = $('landing-fests');
  list.textContent = '';
  const crews = crew.knownCrews();
  for (const pair of model.landingPairs(crews, state.cachedDoc, FESTIVAL_INDEX)) {
    const row = document.createElement('button');
    row.className = 'fest-row';
    row.style.width = '100%';
    if (pair.past) row.style.opacity = '.55'; // past fests stay, quietly (Kevin, 2026-07-14)
    const left = document.createElement('div');
    left.style.cssText = 'flex: 1; min-width: 0; text-align: left;';
    const nm = document.createElement('span');
    nm.className = 'fest-name';
    const label = pair.fid ? model.festLabelFor(pair.fid, FESTIVAL_INDEX) : null;
    const festColor = label && label.accent ? `rgb(${label.accent})` : 'var(--text-header)';
    nm.style.cssText = `font-family: var(--font-display); letter-spacing: .04em; font-size: var(--fs-day); color: ${festColor};`;
    if (label) {
      nm.textContent = label.name;
      if (label.year) {
        const yr = document.createElement('span');
        yr.className = 'yr';
        yr.textContent = ` ${label.year}`;
        nm.appendChild(yr);
      }
    } else {
      nm.textContent = pair.crewName || 'Your crew';
    }
    left.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'fest-dates';
    const names = pair.people.map((x) => x.name);
    sub.textContent = pair.fid
      ? (names.length > 1
        ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')
        : 'just you — add your people inside')
      : 'tap to open';
    left.appendChild(sub);
    const cluster = document.createElement('span');
    cluster.className = 'avatar-cluster';
    for (const { name, p } of pair.people.slice(0, 5)) {
      const a = document.createElement('span');
      a.className = 'avatar';
      const ci = colorIndexOf(name, p);
      a.style.background = hslOf(ci, 0.5);
      a.style.border = '1px solid ' + strokeOf(ci, false);
      a.textContent = name.charAt(0).toUpperCase();
      cluster.appendChild(a);
    }
    if (pair.people.length > 5) {
      const more = document.createElement('span');
      more.className = 'avatar';
      more.style.background = 'rgba(255,255,255,.08)';
      more.textContent = `+${pair.people.length - 5}`;
      cluster.appendChild(more);
    }
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';
    row.append(left, cluster, chev);
    row.addEventListener('click', () => {
      // Land on THIS fest, not the crew's last-open one — the row's whole
      // promise is "tap Seismic, get Seismic" (Kevin, 2026-07-14). The write
      // is VERIFIED before navigating: with storage full/blocked, booting
      // anyway would open whatever fest the crew last had — the row lying.
      // Stop and say so instead (Codex reshape gate, P2).
      if (pair.fid) {
        saveLS(state.LS.fest(pair.token), pair.fid);
        // The read-back is guarded too: storage-denied browsers throw on
        // READS as well as writes, and an uncaught throw here would kill
        // every row (Codex verify round). Write-fail, read-fail, and
        // mismatch all take the same honest exit.
        let stored = null;
        try { stored = localStorage.getItem(state.LS.fest(pair.token)); } catch { /* read denied */ }
        if (stored !== pair.fid) {
          showToast($('toast-root'), 'This device’s storage is blocked — couldn’t point the board at that festival.', 6000);
          return;
        }
      }
      location.hash = `#g=${pair.token}`;
      boot();
    });
    list.appendChild(row);
  }
  $('landing-empty').style.display = crews.length ? 'none' : '';
}

function renderJoin(token, doc) {
  show('screen-join');
  // The invite names the FESTIVAL (FLOW-10) — the fest is why you came; the
  // crew is who with. Fest context comes from the link's &f= or the doc stamp.
  const hintId = pendingFestHint || (doc.meta && doc.meta.inviteFestId) || null;
  const festMeta = hintId ? FESTIVAL_INDEX.find((f) => f.id === hintId) : null;
  const crewLabel = (doc.meta && doc.meta.name) || 'your crew';
  const headline = $('join-fest-name');
  if (festMeta) {
    headline.textContent = `${festMeta.name.toUpperCase()} ${festMeta.year || ''}`.trim();
    headline.style.color = `rgb(${festMeta.accent || '192, 132, 252'})`;
    $('join-crew-sub').textContent = `with ${crewLabel}`;
  } else {
    headline.textContent = crewLabel;
    headline.style.color = '';
    $('join-crew-sub').textContent = '';
  }
  $('join-status').textContent = '';
  const list = $('join-people');
  list.textContent = '';
  // A personal link (&me=Drew) floats Drew's circle to the top and marks it —
  // their picks are already waiting behind that tap (Kevin note 5).
  const meHint = pendingMeHint ? pendingMeHint.toLowerCase() : null;
  const entries = Object.entries(doc.people || {}).filter(([, p]) => !(p && p.removed));
  entries.sort(([a], [b]) => (b.toLowerCase() === meHint) - (a.toLowerCase() === meHint));
  for (const [name, p] of entries) {
    const row = document.createElement('button');
    row.className = 'fest-row';
    row.style.width = '100%';
    const av = document.createElement('span');
    av.className = 'avatar lg';
    const ci = colorIndexOf(name, p);
    av.style.background = hslOf(ci, 0.5);
    av.style.border = '1px solid ' + strokeOf(ci, false);
    av.textContent = name.charAt(0).toUpperCase();
    const nm = document.createElement('span');
    nm.style.cssText = 'color: #fff; font-weight: 700; font-size: 15px;';
    nm.textContent = name;
    row.append(av, nm);
    if (meHint && name.toLowerCase() === meHint) {
      // --brand: "this link is yours" is about a PERSON, on the join screen,
      // before any festival is even on screen. Not one of the accent's four.
      row.style.border = '1.5px solid rgba(var(--brand), .7)';
      const hint = document.createElement('span');
      hint.style.cssText = 'margin-left: auto; color: rgb(var(--brand)); font-size: 11px; font-weight: 800; flex: none;';
      hint.textContent = 'this link is yours';
      row.appendChild(hint);
    }
    row.addEventListener('click', () => { crew.setMe(token, name); enterApp(token, doc); });
    list.appendChild(row);
  }
  $('join-add-btn').onclick = async () => {
    const name = $('join-name-input').value.trim();
    const status = $('join-status');
    // Same rule the server enforces (FLOW-5): the form answers, never a 400.
    const problem = nameProblem(name);
    if (problem) { status.textContent = problem; return; }
    // Typing an existing member's name is a returning member recognizing
    // themselves — claim it, same as tapping the row. Case-insensitive:
    // "drew" typing in must claim Drew, never fork a second member.
    const existingEntry = Object.entries(doc.people || {})
      .find(([n, p]) => n.toLowerCase() === name.toLowerCase() && p && !p.removed);
    if (existingEntry) { crew.setMe(token, existingEntry[0]); enterApp(token, doc); return; }
    const btn = $('join-add-btn');
    btn.disabled = true;
    status.textContent = '';
    status.appendChild(eqLoader('Finding your people…'));
    const taken = Object.values(doc.people || {})
      .map((p) => p.colorIndex).filter(Number.isInteger);
    // removed:false explicitly: deep-merge can't delete a tombstone, so a
    // joiner reclaiming a previously-removed name would otherwise merge onto
    // removed:true and enter the crew invisible. Holding the link IS the
    // capability — rejoining resurrects.
    const person = { colorIndex: nextColorIndex(taken), removed: false };
    const festHint = pendingFestHint || (doc.meta && doc.meta.inviteFestId) || null;
    try {
      // The first write happens BEFORE entry (FLOW-5): if the server says no
      // (people cap, doc size), the joiner hears it here — not as a forever-
      // gray sync dot after picking twenty artists that never left the phone.
      const res = await fetch(`/api/crew?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { people: { [name]: person } }, sv: 4 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        status.textContent = body.error || 'The crew service hiccuped — give it a second and tap Join again.';
        btn.disabled = false;
        return;
      }
      const merged = await res.json();
      crew.setMe(token, name);
      await enterApp(token, merged);
    } catch {
      // Network failure: offline-first join, sync catches up (old behavior).
      state.activateCrew(token, doc, festHint);
      state.recordPerson(name, person);
      crew.setMe(token, name);
      enterApp(token, state.crewDoc);
      sync.scheduleSync();
    } finally {
      btn.disabled = false;
    }
  };
}

// `current` threads boot's generation guard through the awaits: if a newer
// boot started (rapid crew-link switch), this activation aborts instead of
// swapping page-level state under a wall the user can still see and tap —
// which could attribute a tap on the OLD crew's card to the NEW crew's
// pendingChanges (Codex P6 gate, finding P1-2).
// Me link: every crew this device enters stamps itself onto the person
// record — create, join, and every pre-existing crew alike, so the registry
// backfills one open at a time with no migration event. Silent and
// non-blocking: identity plumbing never stands between a person and their
// wall; a failure here just retries on the next open.
async function stampIdentity(token, current = () => true, { renameFrom = null } = {}) {
  const name = ctx.meName;
  if (!name) return;
  try {
    const p = await crew.ensurePerson(name);
    // Re-check EVERYTHING after the await: crew switched, boot superseded,
    // or the picker changed mid-flight — any of those and this stamp would
    // write the wrong identity into the wrong place (Codex gate, P1).
    if (!p || !current() || state.getCrewToken() !== token || ctx.meName !== name) return;
    // Shared-phone guard: the record belongs to one human; switchIdentity
    // must never rewrite the owner's claim or take their pid. A rename is
    // honored only FROM the currently-claimed name (renameSelf passes it).
    if (!crew.mayStampPerson(p, token, name, { renameFrom })) return;
    crew.stampPersonCrew(token, name, state.crewName());
    // The crew doc points back with the PUBLIC id only — never the person
    // token (crew docs are readable by everyone holding that crew's link).
    // And only into an EMPTY slot: a differing pid belongs to someone else's
    // person record, and overwriting it would merge two humans.
    const me = state.people()[name];
    if (me && !me.removed && !me.pid) {
      const queued = (state.pendingChanges.people || {})[name] || {};
      state.recordPerson(name, { ...queued, pid: p.id });
      me.pid = p.id; // local doc mirror, recorder convention
      sync.scheduleSync();
    }
  } catch { /* next open retries */ }
}

async function enterApp(token, doc, current = () => true) {
  crew.setActiveCrew(token);
  crew.rememberCrew(token, (doc.meta && doc.meta.name) || '');
  await loadCustomFestivals(token); // crew-private fests join the catalog first
  if (!current()) return;
  // Invite festival context (FLOW-1): the link's &f= wins (freshest), then the
  // doc's stamp. Consumed once — only fills the void on a fest-less device.
  const festHint = pendingFestHint || (doc.meta && doc.meta.inviteFestId) || null;
  pendingFestHint = null;
  state.activateCrew(token, doc, festHint);
  // Backfill (audit re-run finding): crews older than the fix never got the
  // stamp, so THEIR links — the ones already in group chats — still showed
  // joiners no festival. Any claimed member's boot heals the doc once, from
  // the crew's busiest fest (where the picks live), through the sanctioned
  // carve-out field. Share invite keeps refreshing it afterwards.
  if (crew.me(token) && !(state.crewDoc.meta && state.crewDoc.meta.inviteFestId)) {
    const stamp = model.busiestFestival(state.crewDoc, FESTIVAL_INDEX.map((f) => f.id))
      || state.activeFestivalId;
    if (FESTIVAL_INDEX.some((f) => f.id === stamp)) {
      state.recordInviteFest(stamp);
      sync.scheduleSync();
    }
  }
  // Migrate BEFORE the wall becomes interactive: a raw 3 written onto a
  // still-v3 doc would later be rewritten to 4 by the migrate op — silently
  // corrupting a genuine "picked x3" into "must" (Codex P6 gate, finding 1).
  // Offline/failed migration -> writes stay gated (ctx.migrationPending) and
  // the poll loop retries; reads are safe throughout (readLevel maps by v).
  if (model.needsMigration(state.crewDoc)) {
    await sync.requestMigration();
    if (!current()) return;
    ctx.migrationPending = model.needsMigration(state.crewDoc);
  } else {
    ctx.migrationPending = false;
  }
  try {
    await loadFestival(state.activeFestivalId);
  } catch {
    // Offline with this fest uncached: fall back to a loadable fest rather
    // than stranding a blank wall (CORE-12). If the default also fails,
    // boot's error boundary takes over.
    const fallback = defaultFestivalId();
    if (state.activeFestivalId === fallback) throw new Error(`festival ${fallback} failed to load`);
    const wantedName = FESTIVAL_INDEX.find((f) => f.id === state.activeFestivalId)?.name || 'that festival';
    state.setActiveFestivalId(fallback);
    state.ensureFestivalState(fallback);
    await loadFestival(fallback);
    showToast($('toast-root'), `Couldn’t load ${wantedName} offline — it opens once you’re back online.`, 6000);
  }
  if (!current()) return;
  // Captured before replaceState rewrites the entry: which layers were open
  // when the page was refreshed (spec F10 — refresh restores the same
  // surface). The entry must KEEP representing those layers — writing null
  // here made one Back collapse the whole restored stack and killed Forward
  // (Codex trailing review, P1, reproduced).
  const savedLayers = (history.state && history.state.layers) || null;
  show('screen-app');
  applyFestTheme();
  refreshCtx();
  renderPersonChips();
  renderYou();
  repaintWall();
  history.replaceState(savedLayers ? { layers: savedLayers } : null, '', `/#g=${token}`);
  sync.pollSync();
  router.reset();
  if (savedLayers) router.restore(savedLayers);
  // Badges are per-crew, the scanned library is per-device: opening a crew
  // this library has never badged fills it in right here — connect on one
  // crew and every crew you open follows (Kevin's report, 2026-07-13: The
  // Crew showed no likes after he connected on another crew). No-op when
  // nothing changed; badgeAllCrewFests skips the write itself.
  if (ctx.meName && spotify.isConnected() && spotify.libraryMap()) {
    spotify.badgeAllCrewFests(ctx.meName).then(({ changed }) => {
      if (changed && current()) { sync.scheduleSync(); refreshCtx(); repaintWall(); }
    }).catch((e) => console.warn('crew badge sweep:', e));
  }
  stampIdentity(token, current); // me link — fire-and-forget by design
  // A hop from an alias domain mid-Spotify-setup (SPOT-1): reopen the drill
  // so the member lands exactly where they left off.
  if (pendingSpotifyOpen) {
    const auto = pendingSpotifyOpen === 'connect';
    pendingSpotifyOpen = false;
    openSettings();
    router.push('settings');
    openSubviewByKey('sub:spotify', ctx, settingsActions);
    router.push('sub:spotify');
    // They already pressed Connect on the other host. Do not make them press it
    // again — the hop is our plumbing, not their errand.
    if (auto && !spotify.isConnected()) {
      spotify.connect().catch((e) => {
        showToast($('toast-root'), String(e.message || e), 6000);
      });
    }
  }
}

// ---- lost states (spec F16) --------------------------------------------------------
// A link that doesn't resolve gets a real screen with a way forward — never a
// silent fall to landing (FLOW-3). `gone` = the server said 404 (deleted or
// retyped). Otherwise: offline OR a server error — and the copy must not
// blame the user's connection for the server's problem (audit re-run finding:
// a 500 used to read as "you're offline" while navigator.onLine was true).
function renderBadLink(token, { gone, malformed }) {
  show('screen-badlink');
  document.title = 'Festival Navigator';
  $('badlink-msg').textContent = malformed
    // The commonest cause by far: a chat app clipped the link, or only half of
    // it got pasted. Name that, and give them the one thing that fixes it.
    ? 'That crew link looks cut off — messaging apps sometimes clip long links. Paste the whole thing here, ending in a long jumble of letters.'
    : gone
      ? 'It may have been retyped, or the crew was deleted. Ask your crew for a fresh link and paste it here.'
      : (navigator.onLine
        ? 'The crew service hit an error — it’s not you, and your link is probably fine. Try again in a minute.'
        : 'You’re offline and this crew isn’t saved on this device yet. Reconnect, then open the link again.');
  if (gone) crew.forgetCrew(token); // dead crews don't haunt the landing list
  else if (!malformed) $('badlink-input').value = crew.crewLink(token);
  else $('badlink-input').value = ''; // nothing worth pre-filling from a broken link
  $('badlink-status').textContent = '';
  $('badlink-open').onclick = () => {
    const m = ($('badlink-input').value || '').match(/g=([A-Za-z0-9_-]{20,40})/);
    if (!m) { $('badlink-status').textContent = 'That doesn’t look like a crew link — it has a #g= part.'; return; }
    const target = `#g=${m[1]}`;
    if (location.hash === target) boot();
    else location.hash = target; // hashchange boots
  };
  $('badlink-home').onclick = () => { history.replaceState(null, '', '/'); renderLanding(); };
}

// The last-resort screen (FLOW-4): an exception escaping boot/enterApp used
// to leave every screen display:none — a permanently blank page.
function renderFatal() {
  try {
    show('screen-error');
    document.title = 'Festival Navigator';
    $('error-retry').onclick = () => location.reload();
    $('error-home').onclick = () => { history.replaceState(null, '', '/'); renderLanding(); };
  } catch { /* even the error screen failed — nothing safe left to render */ }
}

// ---- boot -----------------------------------------------------------------------
let bootGeneration = 0;
let firstBoot = true; // cold start resumes the active crew; later boots don't (note 2)
let pendingFestHint = null; // &f= from the opened invite link, consumed by enterApp
let pendingMeHint = null; // &me= from a personal invite link, consumed by renderJoin
let pendingSpotifyOpen = false; // &sp=1 from the canonical-domain hop (SPOT-1)
export async function boot() {
  const gen = ++bootGeneration;
  const current = () => gen === bootGeneration;
  const isFirst = firstBoot;
  firstBoot = false;
  router.reset();
  // Capture before any await: enterApp's replaceState strips the hash to #g=.
  pendingFestHint = crew.festFromHash();
  pendingMeHint = crew.meFromHash();
  // sp=1 -> reopen the drill. sp=connect -> reopen it AND continue the connect
  // the person already asked for on the other host.
  const spMatch = /[#&]sp=(connect|1)(?:&|$)/.exec(location.hash || '');
  pendingSpotifyOpen = spMatch ? spMatch[1] : false;
  // The me link is a MASTER KEY: capture and strip it synchronously, before
  // the first await can leave it sitting in the address bar and history while
  // the network dawdles (Codex gate, P1). Routed before crew links; a broken
  // one says so — same contract as broken crew links. A URL carrying BOTH a
  // person and a crew token is a canonical-host hop (Spotify OAuth): the
  // strip keeps the crew part so the connect flow continues after the absorb.
  const personToken = crew.personFromHash();
  const personLinkBroken = crew.hashHasBrokenPersonLink();
  const hopCrewToken = personToken ? crew.tokenFromHash() : null;
  if (personToken || personLinkBroken) {
    history.replaceState(null, '', hopCrewToken ? `/#g=${hopCrewToken}` : '/');
  }
  try {
    try { await loadFestivalIndex(); } catch { /* offline with cache: proceed */ }

    if (personLinkBroken) {
      if (!current()) return;
      renderLanding();
      showToast($('toast-root'), 'That link looks cut off — copy it again from your other device.', 6000);
      return;
    }
    if (personToken && !hopCrewToken) { await restoreFromMeLink(personToken, current); return; }
    // Quiet absorb — from the hop URL, or from a previous boot's absorb that
    // failed offline (the token waits in sessionStorage: session-scoped
    // master-key hygiene, dies with the tab, never re-enters a URL). Landing
    // on the canonical host with one crew and none of the rest is how a
    // whole map "disappeared" (2026-07-14); a swallowed absorb failure would
    // re-open that trap wearing an offline costume (Codex round 4, P2).
    const pendingAbsorb = personToken && hopCrewToken
      ? personToken
      : (() => { try { return sessionStorage.getItem('fn_pending_absorb'); } catch { return null; } })();
    if (pendingAbsorb) {
      // Park FIRST, synchronously: the URL is already stripped, so if a newer
      // boot supersedes this one mid-fetch, the parked copy is the only one
      // left anywhere (Codex round 5, P2). Success — by whichever generation
      // survives — clears it.
      try { sessionStorage.setItem('fn_pending_absorb', pendingAbsorb); } catch { /* private mode — me link reopens */ }
      let fetched = null;
      let failed = false;
      try { fetched = await crew.fetchPerson(pendingAbsorb); } catch { failed = true; }
      // The generation guard comes BEFORE any mutation: a stale response
      // must not replace the device's identity after a newer boot started
      // (Codex round 4, P1 — same law as restoreFromMeLink).
      if (!current()) return;
      if (fetched) {
        // Quiet absorb unions the boards but never DETHRONES an identity the
        // destination already holds — replacing is the explicit me-link
        // restore's job, not a side effect of connecting Spotify.
        absorbPersonDoc(pendingAbsorb, fetched, { replaceIdentity: false });
        try { sessionStorage.removeItem('fn_pending_absorb'); } catch { /* fine */ }
      } else if (failed) {
        showToast($('toast-root'), 'Couldn’t bring your other boards over yet — they’ll follow once you’re online.', 6000);
      } else {
        // The server SAID the person doesn't exist — retrying a dead link
        // every boot would just re-toast forever.
        try { sessionStorage.removeItem('fn_pending_absorb'); } catch { /* fine */ }
      }
    }

    if (location.hash === '#new') { renderCreate(); return; }
    // A crew link that is present but malformed (truncated by a chat app, half
    // pasted) must say so. Falling through to the landing page told the person
    // nothing at all — the app quietly acting as if they had never clicked.
    if (crew.hashHasBrokenToken()) { renderBadLink('', { gone: false, malformed: true }); return; }
    const token = crew.bootTokenFor(crew.tokenFromHash(), crew.activeCrewToken(), isFirst);
    if (!token) { renderLanding(); return; }

    let doc = null;
    let gone = false;
    try {
      doc = await crew.fetchCrew(token);
      gone = doc === null;
    } catch { /* network failure — try the cache below */ }
    if (!current()) return;
    // A deleted crew is deleted NOW — don't re-enter the app on a stale
    // cached doc just to bounce out one sync later (Codex trailing review).
    if (gone) { renderBadLink(token, { gone: true }); return; }
    if (!doc) doc = state.cachedDoc(token);
    if (!doc) { renderBadLink(token, { gone }); return; }
    if (!crew.me(token)) { renderJoin(token, doc); return; }
    await enterApp(token, doc, current);
  } catch (e) {
    console.error('boot failed', e);
    if (current()) renderFatal();
  }
}

// ---- wiring ----------------------------------------------------------------------
export function init() {
  sync.initSync({
    // Everything that renders identity/state repaints together — the dock
    // avatar was the one holdout showing a stale color (audit 1.5).
    onRemoteChange: () => { repaintWall(); renderPersonChips(); renderYou(); refreshOpenSheet(); refreshOpenArtistPage(); },
    onCrewGone: (token) => {
      // The server said this crew no longer exists — a dead row on the
      // landing list would just 404 again (FLOW-3).
      crew.forgetCrew(token);
      renderLanding();
      showToast($('toast-root'), 'That crew link no longer works — removed from your festivals.', 6000);
    },
    // A limit/validation rejection stops the retry loop (sync.js) — the
    // human hears the server's own reason instead of a forever-gray dot.
    // The server's reason is a sentence fragment as often as not, so punctuate
    // it here rather than running two sentences together ("...hit a limit Your
    // changes are safe").
    onSyncBlocked: (reason) => {
      const said = /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
      showToast($('toast-root'), `${said} Your picks are safe on this phone — they'll sync as soon as the crew has room.`, 8000);
    },
  });

  // A localStorage write that fails is the one way a pick can vanish without a
  // trace: the edit is in memory, the push is 1.2s away, and the on-disk copy
  // that would survive a reload never happened. It used to console.warn. Now
  // the person holding the phone finds out.
  onStorageWriteFail(() => {
    showToast($('toast-root'), 'This phone’s storage is full, so picks can’t be saved offline. They still sync while you have signal.', 9000);
  });

  // Browser navigation models the layer stack (FLOW-2): back closes the top
  // layer, forward re-opens it, refresh restores it (spec F10).
  router.registerKind('settings', () => openSettings(), () => closeSettings());
  router.registerKind('sub:', (key) => { openSettings(); openSubviewByKey(key, ctx, settingsActions); }, () => openSettings());
  router.registerKind('sheet:', (key) => {
    refreshCtx();
    if (key === 'sheet:all') openAllNotes(ctx);
    else if (key === 'sheet:share') openShareMoment();
    else if (key === 'sheet:add-member') openAddMember();
    else if (key.startsWith('sheet:day:')) openDayNotes(key.slice('sheet:day:'.length), ctx, onNotesChange);
    else if (key.startsWith('sheet:notes:')) openArtistSheet(key.slice('sheet:notes:'.length), ctx, onNotesChange);
  }, () => closeSheet());
  // The one overlay element persists across artist-to-artist navigation
  // (tapping a Similar row re-renders it in place, per artist-page.js), but
  // the router still gets one stack entry PER artist — so back steps
  // artist-by-artist. Closing the top 'artist:' entry must therefore check
  // whether another one is still underneath before tearing the page down:
  // if so, step back to ITS content instead of closing (idempotent either
  // way — openArtistPage never creates a second overlay).
  router.registerKind('artist:', (key) => openArtistPage(key.slice('artist:'.length), ctx, artistPageActions), () => {
    const top = router.top();
    if (top && top.startsWith('artist:')) openArtistPage(top.slice('artist:'.length), ctx, artistPageActions);
    else closeArtistPage();
  });
  window.addEventListener('popstate', (e) => router.onPopState(e.state));
  $('search-input').addEventListener('input', (e) => {
    ctx.query = e.target.value;
    renderWall($('wall-root'), ctx);
    renderDayNav(); // scrollspy re-wires against the filtered day rules (gate F8)
    measureStickyChrome(); // search mode drops the stage strip — jump offset shrinks
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      measureStickyChrome();
      // Each scroller clamps its own scrollLeft during a resize, which can
      // desync the mirrored columns from the strip (Kevin's wide-screen
      // wonk screenshot, 2026-07-12) — re-mirror everyone to the first.
      const scrollers = [...document.querySelectorAll('#wall-root .times-scroll')];
      for (const sc of scrollers.slice(1)) {
        if (sc.scrollLeft !== scrollers[0].scrollLeft) sc.scrollLeft = scrollers[0].scrollLeft;
      }
    }, 150);
  });
  const sortCtl = createSortControl({ initial: ctx.sort, onChange: (v) => { ctx.sort = v; repaintWall(); } });
  $('sort-control').appendChild(sortCtl.el);
  const dock = $('dock');
  $('search-input').addEventListener('focus', () => dock.classList.add('hidden'));
  $('search-input').addEventListener('blur', () => dock.classList.remove('hidden'));
  const jumpTop = () => window.scrollTo({ top: 0, behavior: ctx.lowPower ? 'auto' : 'smooth' });
  $('dock-you').addEventListener('click', jumpTop);
  $('rail-you').addEventListener('click', jumpTop);
  const openSettingsLayer = () => { openSettings(); router.push('settings'); };
  $('gear-btn').addEventListener('click', openSettingsLayer);
  $('dock-fest-link').addEventListener('click', openSettingsLayer);
  $('rail-fest-link').addEventListener('click', openSettingsLayer);
  $('fest-list-btn').addEventListener('click', goToFestList);
  $('notes-chip').addEventListener('click', () => { refreshCtx(); openAllNotes(ctx); router.push('sheet:all'); });
  $('create-go-btn').addEventListener('click', () => batchCreateFlow($('create-name-input').value.trim()));
  $('create-back').addEventListener('click', () => { history.replaceState(null, '', '/'); renderLanding(); });
  $('create-back-2').addEventListener('click', () => renderCreate());
  // Enter submits every entry form (FLOW-13) — the keyboard's Go button on
  // mobile is the same event.
  const enterClicks = (inputId, btnId) => {
    $(inputId).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(btnId).click(); });
  };
  enterClicks('create-name-input', 'create-go-btn');
  enterClicks('join-name-input', 'join-add-btn');
  enterClicks('badlink-input', 'badlink-open');
  const saved = appSettings();
  // prefers-reduced-motion rides the same path as Low power (quality floor):
  // the aura/favicon animations stop without the user hunting for a setting.
  applyLowPower(saved.lowPower || window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  sync.setStayOffline(saved.stayOffline);
  // Poll every 25s normally; low power stretches to every 5 min (design 21h).
  let lowTick = 0;
  setInterval(async () => {
    if (ctx.lowPower && (lowTick = (lowTick + 1) % 12) !== 0) return;
    // Retry the one-shot migration until it lands (offline first-open case),
    // then unlock writes.
    if (ctx.migrationPending && navigator.onLine) {
      if (await sync.requestMigration()) {
        ctx.migrationPending = model.needsMigration(state.crewDoc);
        if (!ctx.migrationPending) repaintWall();
      }
    }
    sync.pollSync();
  }, 25000);
  document.addEventListener('visibilitychange', () => {
    // Respect low power: returning to the tab does not bypass the 5-min throttle.
    if (!document.hidden && !ctx.lowPower) sync.pollSync();
    // Going away is the dangerous direction: a pick made inside the 1.2s
    // debounce dies with a backgrounded tab. Beacon it out before we lose the
    // chance — this is the last code that is guaranteed to run.
    if (document.hidden) sync.flushOnHide();
  });
  // pagehide covers the cases visibilitychange does not: bfcache, tab close,
  // and iOS Safari, where it is often the only one that fires at all.
  window.addEventListener('pagehide', () => sync.flushOnHide());
  window.addEventListener('hashchange', () => { closeSheet(); boot(); });
  window.addEventListener('online', () => { sync.pushSync(); updateMigrationBanner(); });
  // The dot goes gray the moment the radio does — not five minutes later at
  // the next poll (PS-3).
  window.addEventListener('offline', () => { sync.setSyncStatus('offline'); updateMigrationBanner(); });
  // Escape is universal back: pops the top layer through history so the
  // browser's back button and the keyboard always agree (FLOW-2).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !router.requestClose()) closeSheet();
  });
  // Last-resort net (FLOW-4): an early crash used to leave every screen
  // display:none. Only fires when nothing is rendered — a background sync
  // hiccup must never nuke a working wall.
  window.addEventListener('error', () => { if (!anyScreenVisible()) renderFatal(); });
  window.addEventListener('unhandledrejection', () => { if (!anyScreenVisible()) renderFatal(); });
  boot();
}

init();
