# Handoff — 2026-08-06

Two separate bodies of work. **The player work is finished and live on `main`.**
**The clash work is a spike on a branch and has never been near production.**
Keep them apart in your head; the only thing they share is the day.

---

## 1. Live on `main` — the sample player, finished

`ray-festival.vercel.app`, SW `festival-nav-v77`. Suite 469, 0 fail.

Everything here was measured on an **iPhone**, not inferred. The mechanism
underneath all of it:

> **A source can carry playback across an artist change only if switching
> artists leaves the iframe's document alone.** YouTube swaps content by
> postMessage and its src never changes — it carries. SoundCloud's
> `widget.load()` and Spotify's `loadUri` both keep the same `<iframe>` NODE but
> **navigate it**. A navigation is a new document, a new document has never been
> touched by a finger, and iOS will not start audio on it. Neither carries, and
> no amount of calling `play()` afterwards helps.

What shipped, in order:

- `76e9dd0`, `a2703a8` — `design/ios-playback-probe` gained a **Spotify** source
  and, more importantly, learned to judge a carry on the playhead **restarting**
  rather than merely moving. For several seconds after the navigation the OLD
  document keeps playing and its clock keeps climbing; the probe called that a
  successful carry twice before this was fixed.
- `09bca15` — Spotify loses `loadArtist` and gains a `playback_update` listener.
- `31dae52`, `d529c3a` — no pause glyph over a silence we already predicted;
  `is-playing` survives a carry; SoundCloud's own play button actually plays.
- `3cb6e18` — **every source now draws its own player.** All three moved to the
  full stage: YouTube 150px, SoundCloud capped at exactly 350px wide (its
  artwork threshold — 345 draws a flat strip, 350 draws artwork), Spotify 352px.
  Our 82×46 thumb, our round play button and our scrubber all retired.
- `8483fd9` — `reconcileEmbed` never echoes an embed-REPORTED state back at the
  embed. Spotify's `controller.play()` restarts from zero (`resume()` continues),
  so answering its own `playback_update` restarted the clip a second in.
- `e8c324f` — **a clash is mutual overlap, not a chain.** A 10–11, B 10:45–12,
  C 11:30–1 used to become one group of three, so the app asked you to choose
  between two sets that never overlap.

### Rules with teeth, learned the hard way

**`tests/player-carry.test.mjs` guards them and was mutation-tested.** It asserts
SoundCloud and Spotify define **no** `loadArtist`, that YouTube **does**, that
the embed→state reconcile stays **upward only**, and that `reconcileEmbed` keeps
its `fromEmbed` bail-out. Each guard exists because the opposite shipped and
broke on a device.

The reconcile produced **three separate device bugs in two days** — a pause glyph
over predicted silence, a symmetrical reconcile that paused a video mid-load, and
an echo that restarted Spotify. Every time the wrong rule looked symmetrical or
harmless. Treat that function as load-bearing.

### Known and accepted on main

- **YouTube letterboxes** — a 350×150 stage is 2.33:1 against 16:9, so ~42px of
  black either side. Ray's call: keep it, it depends on the video.
- **`buildCompactStage` and `buildSeekRow` in `player.js` are unreferenced.**
  Deliberate: they are what we'd want back if the layout reverses, and removing
  them means taking the seek-drag machinery too. `updateSeekRow` still runs
  unseen and MUST stay — the honest-icon watchdog uses the playhead it reports
  as its evidence.
- **375pt phones don't get SoundCloud artwork** (they land at ~337px, under the
  350 threshold) and fall back to the strip. 390pt and up are fine.
- **The deck player sits at the card's bottom** via `margin-top: auto`, so a
  short player means a bigger gap above it on sparse cards.

---

## 2. `spike/clash-lead-split` — a prototype, NOT a feature

Ten commits ahead of main. Suite 470, 0 fail. **Nothing here has been near
production and it should not go there without the decisions in §3.**

Preview: `https://festival-navigator-git-spike-clash-lead-split-raypp2.vercel.app`

**To see it:** `/design/seed-qa-crew` → "Test as" **Mara** → *Electric Forest '26*
→ **My Day** → the ⚡ CLASH card. Mara's seeded picks (Effin ×2 / Eggy ×3) are
the only ones in the fixtures that genuinely overlap — 75 min across two stages.
Ray's picks don't clash at all. `/design/clash-spike` is the standalone
prototype with four hand-built scenarios, still worth reading for the cases the
real data doesn't produce (near-total overlap, three at once, crossing twice).

### The idea

**Pick level is TASTE. A resolution is a PLAN. They are different axes and the
old code conflated them.** `chooseArtist` used to demote every other artist to
pick ×1 — it said "I like them less" when the truth was "I like them the same,
but one wins this slot" — and because `dayPlan` keeps anything at level ≥ 1 the
clash came straight back, which is what made it feel like a no-op.

Now: choosing records `{kind:'lead', lead}` or `{kind:'keep'}` in
`js/discovery/resolutions.js` and **touches no pick levels at all**.

- **Decide** draws the overlap to scale above the cards, in the WALL's
  orientation (time down, stages as columns, 20px per 15 min). What's picked
  either side is named above and below with its level, because the real cost of
  a clash is usually the walk. The choices and the confirm sit directly under
  that picture; the per-card "Choose X" sets the selection and scrolls back to it.
- **My Day** stops flagging a decided window. The plan is carried by the SHAPE
  of the list — lead at full weight with a ring, alternates indented behind a
  rail and dimmed — because this is a list people scan in seconds in a field.
  The change control is a chip inside the lead's own card, one per window.

### Open design questions the spike does NOT answer

1. **`chooseBtn` still says "Choose {name}"** (`decide.js:418`) when it now
   *selects*. The radio above says "Lead with {name}". Two labels, one action,
   a screen apart. This is the next thing to fix and Ray has flagged it twice.
2. **Does "lead" read as a decision or as a demotion of the others**, despite the
   panel insisting nothing changed? Only users can answer.
3. **Does anyone open the alternates?** If not, the indent is enough and the
   disclosure is dead weight.
4. **Does the walk badge earn its space** on a screen people look at for four
   seconds?

### The thing that must be designed before this ships

**Resolutions are device-local `localStorage`, and that was a spike decision, not
a considered one.** It reuses the shape of the existing clash dismissals so
nothing touches the crew doc or the merge rules — the sharpest edge in this
codebase. The cost is stated at the top of `resolutions.js`: **picks sync, plans
do not**, so a second device sees the window unresolved.

If the concept survives testing, moving resolutions into the crew doc is the
first job, and it is a genuine multi-user question: two people in a circle can
hold different plans for the same window, and that is probably correct rather
than a conflict to resolve — but it needs deciding, and it needs to respect the
"nobody sees people in circles they're not in" law.

---

## 3. Testing — use the simulator, it is a real oracle

`CLAUDE.md` now documents this fully. The short version:

- **Automated taps arrive as `isTrusted=true`** and the simulator **enforces the
  autoplay policy** — both verified before trusting it. Desktop Chrome does not
  and is not qualified for any of this.
- `node scripts/probe-log-server.mjs` then
  `xcrun simctl openurl booted "http://localhost:8899/…?log=1&compact=1&src=sp"`,
  and read `.probe-traces/<id>.log`. **Reading the trace beats a screenshot** —
  a still frame cannot tell a working page from a frozen one.
- **Terminate Safari between runs.** `openurl` opens a new tab each time and
  every old tab keeps running; stale tabs overwrote each other's traces twice.
- **`ios_webkit_debug_proxy` does not work with simulators.** Don't re-attempt.

**One thing the simulator cannot do:** SoundCloud's play button now lives inside
a cross-origin iframe, and neither the simulator nor the browser harness can
click into one. A play-then-advance cycle on SoundCloud needs a human thumb. It
has not been verified since `3cb6e18`.

---

## Traps that cost real time today

- **The service worker will serve you the old JS.** Load twice. Three separate
  "the fix didn't work" moments this session were this, including one where I
  tested a fix against pre-fix bytes and nearly reported it as failing.
- **`refreshDeckInPlace` reuses the card ELEMENT**, so every per-card flag the
  last decision left on it lands on the next artist. It has now stranded three
  things (`is-playing`, `data-intent`, `is-settling`). If something looks wrong
  on a card and nothing in that artist's data explains it, look here first.
- **The QA seed page's own copy still says "the token is fake — nothing touches
  a real database."** That stopped being true at `d1651c2`; it mints a real crew
  through `/api/crew`, and preview deploys share the production `DATABASE_URL`.
  **Two dead QA rows were created in production today.** The copy should be
  corrected (`design/seed-qa-crew.html:26`).
- **Electric Forest set times live in `days[day].artists[]`, not the top-level
  `artists[]`.** The top-level entries have no `time` at all, so anything
  computing a schedule from them silently finds nothing.
