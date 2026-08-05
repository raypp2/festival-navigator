# NOW — festival-navigator: LIVE on ray-festival.vercel.app (SW v65)

## 2026-08-05 (session close) — the player carries, the genre gap closes

Everything below is on `main` and deployed. `main` is git-connected, so a push
IS a release.

**Discovery's sample player now keeps playing across an artist change** —
device-confirmed on an iPhone. Getting there took four wrong answers, and the
two rules that governed it are the kind no laptop can check: iOS will not start
audio on an element no finger has touched, and WebKit re-creates an iframe's
browsing context on ANY reparent, including `appendChild` onto the parent it is
already in. `refreshDeckInPlace` (deck.js) and `rebuildChromeAroundEmbed` /
`remountFor` (player.js) exist for exactly that and look like over-engineering
locally. Do not simplify them without reading
`claude-plans/2026-08-05-player-verification-handoff.md`.

Also shipped: the nav strip from design frames 6a/6b/6e (Wall · Discover · My
Day, search demoted to an icon, strip + stage rail pin); a carried playback
INTENT that survives a swipe but not a pause; a play/pause glyph keyed on the
PLAYHEAD rather than on a PLAY event, because both embeds fire PLAY while being
refused; YouTube finally getting a play control of its own in compact; and iOS
focus-zoom suppression.

**Enrichment**: the genre gap went 570 → 176 rows via Last.fm, after Spotify
(no longer returns `genres`) and Deezer (never had them) both turned out to be
closed. A 429-backoff fix means a YouTube tranche can now actually spend its
daily budget — before it, a 69-search budget bought 4.

**What still needs a phone**, and it is the reason the handoff doc exists:
Spotify has NEVER been device-tested against the new advance, and SoundCloud's
pass predates it. Details, test steps and the probe to use are in that doc.


## 2026-08-01 (session close) — Discovery M0-M7, built and verified

The full Discovery build spec (claude-plans/2026-07-30-discovery-build-spec.md,
design of record in design/discovery-handoff/) landed on branch `discovery`:
19 commits, 376 tests, every designed surface implemented and browser-verified.
Orchestration: Fable planned/reviewed, Sonnet agents implemented, every slice
re-verified live before commit.

- **What exists now:** enrichment pipeline (MusicBrainz + oEmbed + quota-cached
  YouTube search) with 3 lineups enriched (EF, Lolla, Ubbi Dubbi) · genre canon +
  client canonicalization · passes + recommend-ahead in the crew doc (reversible
  tombstones, merge-tested against the real SQL bytes) · deterministic scoring
  with exactly-one-reason ribbons · sample player v2 (one instance, seek
  everywhere, SoundCloud monetization honesty — MONETIZE tracks dropped, SNIP
  badged) · the artist page + THE flow change (every artist tap opens the page;
  the pick cycle lives on its tick) · Discover deck + filter · For-you wall ·
  My day (gaps/clashes, cross-midnight honest) · Decide (never auto-picks) ·
  all four desktop layouts (5b/5c/5d/5e).
- **Data honesty fix worth knowing:** EF + Lolla artist arrays are SCHEDULE-
  ordered, not billing-ordered — festivals now declare `artistOrder`, and
  schedule-ordered ones derive popularity from set lateness x length. EF's
  derivation is limited by absent end times (documented in commit 5fcd8ed).
- **Testing traps that bit this session** (all also in fork docs): the SW serves
  stale modules origin-wide (unregister + clear caches before believing a local
  check); the ES-module map and heuristic HTTP cache survive more than you think
  (serve QA with Cache-Control: no-store); browser-pane coordinate clicks
  mis-hit — use element refs or JS .click(). QA data: open
  /design/seed-qa-crew.html on any static server, one click seeds a throwaway
  crew (never syncs).
- **Next session's list:** Vercel preview deploy + a PHONE pass (the wall-tap
  flow change is the thing to feel) · YouTube enrichment tail
  (`node --env-file=<workspace>/.env scripts/enrich-artists.mjs <fid>`,
  ~100 searches/day quota; no-results are cached and never re-billed) · enrich
  the remaining 7 lineups · design the rec-queue surfacing (spec §11.2) ·
  then Epic B (taste profile + seen-log) per PORT_REQUIREMENTS §11.


## 2026-07-14 (session close, v35) — Kevin's staging round + gate rounds 4-5

Kevin live-tested the reshape on staging, found the Spotify canonical-host
hop trap (his boards "disappeared" — he'd changed ORIGINS: OAuth hopped him
from stage.fest to fest.kevinhg.com, which ran old prod code and knew one
crew; nothing was lost, staging and prod share the DB), and asked for:
connect fills ALL fests · settings shows MY fests not the catalog · dates
on the home list. All shipped, then two more Codex gate rounds (identity
boundaries, races, honesty of partial-failure reporting) fixed in full:

- **badgeEveryKnownCrew**: one connect fills EVERY board — identity resolved
  from the PERSON RECORD's claim (sweepIdentityFor, 7-case tested; never the
  device picker), sparse-leaf direct POSTs per crew, skips surfaced ("N
  boards couldn't fill yet — each catches up when you open it"; the
  enterApp per-open sweep is the durable retry).
- **The hop announces itself and carries the me link**: boot parks the
  token in sessionStorage FIRST, absorbs quietly (union, never dethrones an
  existing identity), generation-guarded, retries offline, drops dead links.
- **Settings = your boards** (landingPairs rows; + Add → the shared multi-
  pick page; AI/custom add keeps its quiet door). **Landing tells time**:
  `startsOn` in index.json (validator round-trip-enforced, documented),
  date sort, "Sep '26" labels, past fests sink muted.
- **Kevin's morning list**: eyeball staging on a FRESH browser (or
  SW-unregister) · add `https://stage.fest.kevinhg.com/spotify-callback` in
  the Spotify dashboard (staging then OAuths on-origin, no hop) · promote
  call · Portola/Seismic crew split still on my queue post-promote.
- 176 tests / 175 pass. Five gate rounds total tonight; every NO SHIP
  caught something real.

## 2026-07-14 (later) — THE FEST-FIRST RESHAPE — built, gated twice, staged

Kevin's "go" on the direction doc → built in the same session (main-loop,
legibility guide re-read; the other three ground-it docs deferred as
out-of-territory — deliberate, stated).

- **Landing = festivals** (landingPairs over (crew × fest) pairs, index
  order, fest accents, avatar clusters, "just you — add your people
  inside"). Tap Seismic → GET Seismic (the row writes the fest key,
  verify-after-write, refuses to boot ambiguously on blocked storage).
- **Create = multi-pick** (≤8/batch — the 10/hr create limit must not be
  outrun), name step survives only for a device with no person record —
  once, ever. Boards are BORN knowing their fest (api/crew.js create now
  accepts `festivals`) and born linked (create body carries pid); each
  board is stamped onto the person record before leaving the screen
  (checked + retried; failures TOLD to the user, enterApp backfill is the
  durable catch-up). WHO'S THIS WITH? deleted wholesale.
- **+ Add grew the recurring-humans picker** ("From your other fests" —
  otherFestPeople, tested) and settings member links say linked (pid) vs
  placeholder.
- **Gate round 1 (NO SHIP, 2 high + 3 med)**: batch boards missed the me
  link; create was re-entrant (double-tap = duplicate circles); stranded
  loader after post-create activation failure; batch could outrun the
  create quota; unverified fest-key write. All five fixed. **Verify round
  2** still failed two — the stamp's boolean was ignored (false ≠ throw)
  and the read-back could throw on storage-denied browsers — both fixed;
  final two touch-ups shipped self-verified (mechanical, walked each path).
- 175 tests / 174 pass. Live-walked end to end on vercel dev (multi-pick →
  boards → tap-fest-get-fest → typed add → one-tap picker add), throwaway
  rows deleted after. **Lesson re-learned live: hash-only navigations keep
  the browser's module map — verifying edited JS needs a REAL document
  reload (about:blank hop), not just SW-unregister.**
- **Staging = v35 (v33 + Kevin's staging round + gate rounds 4-5), awaiting
  his eyeball. Prod promote = Kevin's call.**
- Accepted, documented in code: cross-tab create-spam (no server
  idempotency key; rate limiter caps damage) · server-side batch quota
  reservation · both filed under Phase-2 hardening with the person-create
  twins.

## 2026-07-14 — FESTS × CIRCLES × YOU: the model pivot (direction locked, reshape SHIPPED same day — see above)

Kevin live-tested v32 on staging and rejected the "WHO'S THIS WITH?" framing
(a people question answered with crew names that read as festivals; a crew
named Portola opening on Seismic with the fest switcher buried). His model:
**festival-first, ego-centric circles** — everyone is the center of their own
map. Talked through his real festival year, mapped it in an artifact, aligned.

- **Canonical direction doc: `claude-plans/2026-07-14-fests-circles-you-direction.md`**
  (the locked model, the 8 decisions, the reshape checklist). Read it before
  touching landing/create/join/share code.
- **v32 stays on staging by Kevin's call** — the reshape (fest-first home,
  multi-pick add, kill step 1.5, + Add people sheet) lands on top, then
  promote. Nothing from v32 is wasted: the me-link/pid plumbing is the
  foundation the circle model runs on.
- Reshape kickoff = plan mode + FULL hg-ground-it read (tonight only the
  legibility guide was read — deliberate budget call). Merged-board +
  join-picker/mute engine is its own later arc (Phase B).
- Docs grounded tonight: user-flows.md carries the pivot banner; the executed
  me-link plan archived to `claude-plans/2026-07-13-me-link-phase-1.md`
  (its Phase 2 Spotify-summary design still applies under circles).

## 2026-07-13/14 — THE ME LINK (Phase 1) — staged; UI layer superseded same night

Kevin's frame: "I am me, friends are friends, and we mix and match across
crews." Plan-mode approved; Kevin picked fest-first→"WHO'S THIS WITH?" for
the landing CTA and Phase-1-now/bank-Phase-2 for scope.

- **Person record**: `persons` table (id public/"pid" — the only person
  identifier a crew doc may hold — vs token = master-key credential,
  DISJOINT length ranges), api/person.js (create/read/atomic merge,
  X-Person-Token HEADER only — never a query param). Doc: {v, name, crews:
  {<crewToken>: {name, crewName}}}. LIMITS.personDocBytes 32KB (Phase 2
  raises for the library summary).
- **Client**: enterApp stamps identity fire-and-forget (create, join, and
  old crews backfill one open at a time); renameSelf follows with
  renameFrom; #p= me link restores a wiped device (union-only, hash
  stripped before boot's first await). Landing rebuilt: YOU card (avatar,
  My-link copy, consequence copy), crew rows w/ fest names + avatar
  cluster (the unbuilt 21a spec). Create step 1.5 lists existing crews.
- **TWO Codex gate rounds, both earned their keep.** Round 1 (NO SHIP, 4×P1
  +1×P2): master key in URLs → header auth; restore lacked boot-generation
  guard; shared-phone stamp conflation; double-create race (and MY first
  race fix had a TOCTOU the demanded concurrency test caught — the re-check
  sat before res.json()); PID/TOKEN regex overlap. Round 2 verify: headers/
  boot-strip/XSS/offline-path PASS, but my ownership guard had two open
  doors (empty-mirror inheritance, unconditional rename bypass) — both
  closed; schema.sql now retightens the pid CHECK idempotently on pre-v32
  DBs (upgrade-path test builds the old schema and proves it).
- **Accepted for Phase 1, documented in code**: cross-TAB double-create can
  orphan one unreferenced person row (same-tab collapsed by in-flight
  memo, tested); server-side ownership conditions + idempotent create =
  Phase 2 hardening, designed in the plan doc.
- **Live-verified on vercel dev against real Neon** (throwaway rows deleted
  after): create → silent person record → pid in crew doc → step 1.5 adds
  fest to SAME crew → wipe → #p= restores crew+claim+YOU card. 170 tests.
- **Phase 2 banked** (plan doc): library summary on person record,
  client-composed via a crew-scoped endpoint — crew GET hot path untouched.
- ~~Kevin's moves: eyeball staging → promote~~ **OVERTAKEN 2026-07-14**: he
  eyeballed, the who's-with framing failed the test, direction pivoted (see
  the section above). Promote waits for the reshape. Still true after it
  ships: open each crew once to backfill the me link, then stash My link.

# Previous: v3.1 PROMOTED + Spotify polish live (v31)

## 2026-07-13 (round 3, v31) — merge twins now replace arrays like the SQL

- **Kevin's "dunno if it matters" toast was a P1**: "playlist: artists must be
  an array (max 500)" = the server refusing EVERY push from his device for the
  EF crew. The client deepMerge index-merged arrays — an array landing on a
  key holding nothing came back `{"0":..}` — and the playlist artists ledger
  is the first array ever sent through pending sync. persistPending wrote the
  corruption to disk; each boot reloaded and re-pushed it; deterministic 400
  forever. Picks were safe locally, invisible to the crew.
- **Fix**: both JS twins (js/merge.js, api/_lib/crew-shared.mjs) early-return
  array overlays as copies, matching jsonb_deep_merge (object×object is its
  only recursing case). db-merge.test.mjs now holds client JS, server JS, and
  the real SQL to byte-identical output — the twins can't drift silently.
- **Self-heal**: activateCrew rebuilds corrupted blobs AND writes them back to
  disk — memory-only healing left a zombie (subtractLeaves can't match a
  corrupted-disk leaf against the healed-pushed leaf) that re-pushed the same
  meta every boot. Kevin's device needs only a reload (×2 for SW handover).
- 153/154 tests. Codex gate: SHIP, zero findings, regression tests verified
  to fail against pre-fix code. SW v31 on staging + all three prod domains.
- **Open product question (Kevin deciding)**: one-link-restores-all-crews.
  Options on the table: (A) consolidate solo fests into one personal crew
  (feature exists — Settings → Your festivals → + Add a festival — needs a
  one-time picks migration between crew docs), (B) "save all my crews" bundle
  link (new build, all tokens in one URL = louder blast radius), (C) leave it.
  Related regardless of choice: the landing page teaches one-fest-per-crew
  ("ADD A FESTIVAL →" creates a CREW; the crew list is headed "YOUR
  FESTIVALS") — that copy/IA steered Kevin into four single-fest crews.

## 2026-07-13 — PROMOTED TO PRODUCTION + Spotify live-tested + polish shipped

- **v31-polish merged to main** (Kevin's go): prod went v14 → v28 → v29 on all
  three domains, verified by served CACHE_VERSION each time. 145/146 tests.
- **Spotify OAuth verified LIVE end to end** — Kevin registered the redirect
  URI, connected, scanned 6,180 artists, EF badged 38. The one flow no session
  could verify is now proven on production.
- **Polish batch (Kevin's first-connect feedback, all shipped same day):**
  scan ticker (real counter + bar + album covers, fest-find highlights, wall
  pill when you leave the drill, reduced-motion safe) · playlist card rebuilt
  (name-first input, inline progress/success/errors, Open-in-Spotify link —
  its old status line rendered BELOW the Advanced fold, invisible) ·
  Everyone-playlists are collaborative + recorded in crew doc
  (spotify.playlists, validated; later-connecting members auto-join their
  picks; "Add new picks" top-up) · affinity glow (followed + 5+ songs = green
  corner mini-aura; followed-only artists now chip at all) · spotifyStats
  write restored (dropped in the 07-12 rebuild).
- **Dead BLOB_READ_WRITE_TOKEN removed** from all three Vercel envs.
- **Round 2 same day (v30):** Kevin's resync test exposed three real bugs —
  ghost festivals (ensureFestivalState never queued the new key for sync; The
  Crew's server doc held 1 fest vs his device's 6), crews never badging on
  open (per-crew badges vs per-device library — enterApp now sweeps from
  cache, write-skipped when unchanged), and mid-scan crew-switch writes
  landing on the wrong crew (token captured at start; mismatch = no writes;
  the "Kevin HG" ghost stats on EF26's doc are that bug's fossil — additive
  merge can't delete it, cosmetic, ignore). Playlist logic re-specced by
  Kevin: top-3 search + the maker's saved tracks per artist (fest-artist URIs
  cached at scan), track-level dedupe vs the LIVE playlist on append.
  148/149 tests incl. empty-fest merge vs production SQL bytes.
- **UNVERIFIED, next live test:** the collaborative auto-join path needs a
  SECOND member's account (Spotify dev-mode may refuse cross-user adds even
  on collab playlists — the drill reports and offers retry if so). Also the
  "Electric Forest 26"/"Portola 26" crews are Kevin's own (with Ross) — keep.
- **Still Kevin's call:** The Crew token rotation (public git history) ·
  refresh-after-back sign-off · dev-mode 5-user allowlist vs The Crew's 6
  members · rotate the screenshotted client secret.

## SPOTIFY FLOW REBUILD (2026-07-12 — superseded by the above; kept for context)

Kevin's live screenshots showed the Spotify connect flow was broken end to end:
OAuth `redirect_uri: Not matching configuration`, a two-step hop with a second
"Connect" button on a sparse page showing raw plumbing (`CREW APP · ...d26734`),
and the gear icon stranded alone on the far left under Lost Lands' long date
string. His model — "connect once, all my fests fill in; add a fest later and
Spotify should just pull" — was correct; the app didn't do that.

**Shipped and verified:**
- **Gear pin fix** (`index.html`): the header wraps on long date strings, and a
  `≥720px` rule was stripping the gear's `margin-left: auto`, parking it far-left
  alone. Now `order: 3; flex: none`, pinned right at every width. **Verified live
  on staging on Lost Lands itself** — the exact festival from Kevin's screenshot.
- **One-press connect** (`js/spotify.js` `canonicalHopUrl({autoConnect})`,
  `js/v3/app.js` boot): the hop to `fest.kevinhg.com` now carries `sp=connect`
  and auto-continues on arrival — no second "Connect" button on a second screen.
- **Badge every festival, one write** (`js/spotify.js` `badgeAllCrewFests`,
  `artistNamesOf`): connecting reads the library once and badges every festival
  the crew has, in a single `recordAffinity` call — not the one-fest-at-a-time
  "Open other fests to badge them too" chore it was. A festival added later
  self-badges via the existing `switchFestival` path (now calling the same
  shared `artistNamesOf`), no reconnect needed.
- **Drill rebuilt** (`js/v3/settings.js`): every not-yet-connected state now
  shares one `connectCard` that says what connecting does; the raw client-ID row
  moved behind an "Advanced" fold (also holds the exact redirect URI string for
  whoever owns the app); the connected state shows a per-festival badge count
  instead of telling you to go do more work.
- **5 new unit tests** (`tests/spotify-flow.test.mjs`) prove: badging reaches a
  NON-active festival, a newly-added festival self-badges from the cached
  library, badging one fest never wipes another's badges, the whole sweep is one
  write not N, and the hop URL carries `sp=connect` + the crew token.
- Full suite: 141 passing + 1 correctly skipped (Neon-only concurrency test).
  Fork/BYO drill path (the only one exercisable on staging — see below) visually
  confirmed clean, no naked client-ID plumbing outside the fold.

**NOT verified — could not be, not skipped by choice:**
- The main "Connect my Spotify" 3-door flow (owner app / request access / BYO)
  is what Kevin will actually hit in production, but **staging has no Spotify
  env vars** (`SLACK_WEBHOOK_URL` etc. are Production-only — confirmed earlier
  this session), so that exact card only renders on `fest.kevinhg.com`. And the
  real OAuth round-trip needs Kevin's own Spotify login, which nothing here can
  simulate. Code-reviewed + unit-tested, not eyeballed live.
- **The one thing that was never a code bug**: `redirect_uri: Not matching
  configuration` is Spotify refusing because `https://fest.kevinhg.com/spotify-callback`
  isn't registered in the app's dashboard. That's a field only Kevin can edit —
  see "KEVIN ACTIONS QUEUED" below, unchanged from earlier in this session.

**If Kevin hits anything else in the Spotify flow**: the natural next move is a
Codex pass on `js/spotify.js` + the `openSpotifyDrill` function in
`js/v3/settings.js` specifically, since that's the one surface this session
could not fully browser-verify.

## CURRENT STATE (2026-07-12, late)

The finish pass ran and is **complete**. A 12-agent audit (6 browser walkers
across every surface at 390 and 1440, 6 code/test/doc dimensions) produced **86
findings**; everything that mattered is fixed, tested, deployed to staging, and
verified in a real browser. Tests **95 → 131**. Branch `v31-polish`, live at
https://stage.fest.kevinhg.com (SW v25).

**The honest headline:** almost nothing here was crashing. Nearly everything
found was the app *quietly saying something untrue* — or quietly losing a tap.

### The four ways a pick could vanish (all closed)
1. `saveLS()` swallowed every localStorage failure with a `console.warn`. A full
   or private-mode store meant the edit lived only in memory, and the push is
   debounced 1.2s behind it. Lock the phone in that window — the single most
   ordinary thing anyone does at a festival — and the pick was gone, with nothing
   on screen ever having said so.
2. That 1.2s debounce was itself a grave: a backgrounded tab gets reaped and an
   in-flight `fetch()` dies with it. `sync.flushOnHide()` now beacons pending
   picks out on pagehide — the one send the browser promises to finish.
3. A 400/413 **permanently poisoned the pending queue**. The code comment claimed
   "the retry loop stops"; it did not — `pollSync` re-armed it every 25s, forever
   re-POSTing the same doomed payload and blocking every *other* edit on that
   device behind it. It now remembers the refused payload and waits for a new one.
4. `clearPending()` blind-wrote `'{}'`, erasing a second tab's un-pushed edits —
   re-opening on the clear path the exact race `persistPending()` had been fixed
   to close.

Plus: two members named "Drew" and "drew" forked into two permanent identities,
splitting their picks down the middle. Now refused *in the merge* — the only
place both concurrent writes are visible.

### The thing that should have scared us most
`jsonb_deep_merge` — the SQL function every concurrency guarantee in this app
rests on — **was executed by zero tests.** "6 of 6 concurrent merges survive" had
been a comment, not a fact, since July. The SQL now lives in
`api/_lib/crew-sql.mjs` and `tests/db-merge.test.mjs` runs *those exact bytes*
against real Postgres (PGlite — in-process, no server, no secrets, runs in CI).
The 6-of-6 claim is now **proven**, along with arrays-are-replaced-wholesale
(which is *why* notes must be keyed objects) and every WHERE-clause invariant.

### Calibration worth keeping
An agent claimed the 256KB doc cap was "structurally guaranteed" to be hit. I
checked the live store: the busiest **real** crew is 1,643 bytes — **0.6% of the
cap**. The failure mode was real; the stated cause was not. No compaction was
built. (Verify before building on a claim, including an agent's.)

### The Codex gate (independent review, after all of the above)

It found two P1s and a P2 — and its best finding was aimed at the test I was
proudest of. Full write-up: `claude-plans/2026-07-12-codex-finish-gate.md`.

- **My touch-target fix could have armed "Forget this crew."** Settings rows stack
  with no gaps, so a universal `button::after { inset: -15px }` grew every row's
  hit area 15px into its neighbours — and the later-painted sibling wins. A tap
  near the bottom of "Switch crew" could hit the destructive Forget. Fixed by
  inverting the default: real `min-height: 44px` (which cannot overlap) unless a
  control opts out, and borrowed space only for small controls with room around
  them. **Verified in-browser: zero overlaps across all 31 Settings controls.**
- **A sync block never lifted.** The toast promises "they'll sync as soon as the
  crew has room" — but nothing retried unchanged pending bytes, so if another
  member DID free up room, that phone stayed stuck. A poll that sees a changed
  remote document now clears the refusal. (It also leaked across crews. It no
  longer does.)
- **My concurrency test was a rubber stamp.** Codex *proved* it: it swapped in the
  banned pre-lock CTE — the shape that lost 2/6 writes in production — reran my
  six-way `Promise.all` for 50 rounds, and lost zero writes. PGlite is a single
  connection; `Promise.all` just serialises. `tests/db-concurrency.test.mjs` is
  the real one (Neon, independent sessions, 8/8 survive) and it carries a
  **control** asserting the banned CTE *does* lose writes — so we know the harness
  can see a lost write instead of trusting another green tick.

And one P0 I found in my own new code before Codex did: `subtractLeaves` recursed
into note objects, so editing a note mid-push sent back a `{text}` fragment
without `author`/`ts` — which the server rejects, which the new refusal guard then
turns into a permanently blocked device. Notes travel whole now.

## ⚠️ KEVIN'S CALL

1. **Promote to production.** Walk staging first:
   `https://stage.fest.kevinhg.com` — then
   `git checkout main && git merge v31-polish && git push`
   (Vercel auto-deploys main; SW v25 force-refreshes every installed client.)
2. **Spotify dashboard (still queued, unchanged):** add redirect URI
   `https://fest.kevinhg.com/spotify-callback` to the MCP HG app at
   developer.spotify.com/dashboard. The code side is done — every non-canonical
   host now hops to fest.kevinhg.com, so this one URI covers staging too.
   Note the Feb-2026 rules: dev-mode apps are capped at **5 authorized users**,
   **one dev-mode app per developer**, owner needs Premium.
3. **`BLOB_READ_WRITE_TOKEN` is live in all three Vercel environments and read by
   zero lines of code.** Vercel Blob is banned here. It is a dead write
   credential — say the word and I will remove it.
4. **The Crew's token rotation** — still pending from the 2026-07-09 NOW.md leak.
   Unrelated to this arc; your call.
5. **Refresh-after-back** — after "‹ back to fest list", a hard refresh on the
   bare URL cold-start-resumes the crew you just left. Codex called it
   design-coherent (PWA resume philosophy) and wants your sign-off.
6. **Two crews in the store I did not create and did not touch:** "Electric Forest
   26" (2 people) and a second "Portola 26" (2 people), both from ~19:30 today —
   before this session started. They look like test crews from the earlier arc,
   but they are not mine to delete. Say the word and they go. (Everything I DID
   create — the audit rig and two crews the walkers made — is deleted. No real
   crew was ever written to.)

## Deliberately NOT done (and why)

- **Splitting app.js / settings.js.** They are 1,272 and 1,032 lines. The audit's
  own verdict was that file length is not the real pain — one 184-line, 6-branch
  Spotify state machine is — and a split at ship time trades a legibility problem
  for a circular-import problem. The duplicated *components* (festRow, sheet
  chrome) were extracted instead, which is where the actual bugs lived.
- **Doc compaction.** See the calibration above: 0.6% of cap.
- **Wiring Spotify env vars into staging.** `enabled()` needs all four, and a
  test there would fire a real Slack message at you. Production has them; the
  fork-deployment fallback (BYO client ID only) is what staging correctly shows.

## Standing facts

- Rig crew for this audit: **deleted at teardown** (see DEVLOG). Real crews were
  never written to.
- The service worker will serve you a STALE app after a deploy — unregister it
  and delete its caches before believing any browser check. Cost me a full round
  of "the fix didn't work" today.
- Token scans GATE commits (`&&`, never `;`). `.gitignore` now denies `*.png` by
  default — a walker run dumped 50 screenshots into the repo root.

**Updated:** 2026-07-12 late · **Branch:** `v31-polish` (pushed) ·
**History:** DEVLOG.md · **Rubric:** `claude-plans/2026-07-12-taste-rubric.md`
