# Device test script — Spotify carry + SoundCloud rebuild, 2026-08-05

Companion to `2026-08-05-player-verification-handoff.md`. That doc says what is
unverified; this one says exactly what to do on the phone, in what order, and
what each outcome means. Two tests: Spotify against the in-place advance, and
SoundCloud after `refreshDeckInPlace`.

## Deployment is confirmed current

Checked before writing this: `ray-festival.vercel.app` serves
`CACHE_VERSION = 'festival-nav-v65'`, and `js/discovery/player.js` and
`js/discovery/deck.js` are byte-identical to `main` (md5 match, both files).
Nothing here is being tested against a stale deploy.

The service worker calls `skipWaiting()` then `clients.claim()`, so a NEW SW
takes over the moment it installs — which is why the second load is the one
that runs the new JS, and the first is guaranteed not to.

## Setup

1. Open `https://ray-festival.vercel.app/design/seed-qa-crew`, then **reload it
   once** before touching anything.
2. Leave "Test as" on **Ray**, tap **Seed & open Ubbi Dubbi '26**.
3. Discover → filter → **Sort: A–Z**, Genres: **Techno** + **Drum & Bass**.

That yields exactly 8 cards, in this order:

| # | artist | YT | SC | SP |
|---|--------|----|----|----|
| 1 | Jade Cicada | ✓ | ✓ | ✓ |
| 2 | Joyhauser | ✓ | ✓ | ✓ |
| 3 | Marie Vaunt | ✓ | ✓ | ✓ |
| 4 | Obskür | ✓ | ✓ | ✓ |
| 5 | Of The Trees | ✓ | ✓ | ✓ |
| 6 | Starjunk 95 | ✓ | ✓ | ✓ |
| 7 | Trym | ✓ | ✓ | ✓ |
| 8 | Wilkinson | ✓ | ✓ | ✓ |

Verified by running the real `applyFilters` against
`data/festivals/ubbi-dubbi-2026.json` with the seeded crew doc as Ray
(A–Z sort makes the order deterministic; `show: undecided` drops Ray's two
seeded picks and his one pass).

### Why the filter, and not just swiping the default deck

**Ubbi Dubbi '26 is not fully enriched on all three sources** — the handoff says
it is, and it isn't. Of 50 artists, **11 have no `spotifyId`** (DOT, Deluluz,
Riordan, Omar+, SLAMM, Bakkus, BUNT., Taylol, Packet Loss, DØMINA, Høldën) and
**11 have no `soundcloudSlug`** (Deluluz, Omar+, Bakkus, Skilah, Taylol,
Funkbox, Packet Loss, Mish, DØMINA, Alyssa Jolee, Høldën).

Land on one of those mid-test and the remembered source falls back down
PRIORITY (`yt` → `sc` → `sp`), `snap.currentSource !== prevSource`, `canCarry`
is false, and the player correctly tears down and rebuilds. Sound stops — for
an entirely legitimate reason that looks exactly like the bug being hunted.
The 8-card block above cannot produce that artifact.

## Test 1 — Spotify

### Read this before running it

The code says playback will stop on advance, and **not because iOS refused
anything.** On the Spotify tab the deck draws Spotify's full embed and no
control of ours (`player.js:457` — `useNowPlayingRow` is false for `sp`).
`core.togglePlay()` has exactly one caller in the codebase (`player.js:752`),
the compact now-playing button, which is only built for `yt`/`sc`.

So on Spotify `snap.play` is never true; `soundIntent` (`deck.js:411`) never
becomes true; `refreshDeckInPlace` calls `remountFor` with `autoplay: false`
(`deck.js:1954`); and `loadArtist` runs `controller.loadUri(...)` and skips
`controller.play()` (`player.js:1289–1294`). **We never ask the new artist to
play.**

The device still answers something worth knowing, just narrower than the
handoff frames it: *does Spotify's controller keep playing across `loadUri` on
its own?*

### Run the probe's Spotify pass FIRST

Because of the above, the app-level test cannot answer the platform question —
we never ask the new artist to play, so a silent result proves nothing about
iOS. `/design/ios-playback-probe` → **Test with Spotify** → steps 1, 2, 3, 4
does ask, and its step 4 runs the app's exact sequence. Five minutes there
decides whether fixing the app's wiring is worth doing at all. Then run the
app-level steps below to see what today's build actually does.

### Steps

1. Card 1 (Jade Cicada) → **Spotify** tab.
2. Tap play **inside the Spotify embed** (its own transport — we draw none).
3. Let it run ~5 seconds. Anonymous embeds are 30-second previews; advance well
   before that or the preview ending reads as a stop.
4. Swipe or pick to advance to Joyhauser.

### Record

- (a) Did sound continue?
- (b) Did the embed show the new artist **without a visible reload/flash**?
- (c) If silent — does the embed sit there with a normal play button, or draw a
  gate ("open in Spotify" / a login wall)?
- (d) Does **one** tap on the embed's play button start the new artist?

### Interpretation

| observed | means |
|---|---|
| sound continues | Spotify auto-resumes across `loadUri`; the unlock rides along. Nothing to fix. |
| silent, new artist in the same embed, one tap starts it | Carry works; we simply never ask. Small, safe fix: a `playback_update` listener on the controller plus a play control of ours on the Spotify stage. |
| silent, embed visibly reloads, or two taps needed | Carry broke at the iframe level — the SoundCloud shape. Spotify would lose `loadArtist` the same way SC did. |

### Two things that will corrupt this test

- **Do not test YouTube and then switch to the Spotify tab in the same deck
  session.** `soundIntent` is a module global in deck.js; a `true` carried over
  from YouTube means the next advance *does* call Spotify's `play()`, and then
  the 2500ms watchdog fires — Spotify never reports playing, so `playingNow`
  stays false — and pauses it. Sound that starts and dies at ~2.5s is that
  artifact, not Spotify's behaviour. Re-seed or reopen Discover between tests.
- **Undo takes the full rebuild path** (`deck.js:758` calls `renderDeckBody`,
  not `refreshDeckInPlace`). Sound stopping after an undo is by design.

### If it fails

`design/ios-playback-probe` now has a **Spotify** source (probe-2). Steps 1–3
work as they do for the other two; step 4 is the one that matters, and it is
two-phase: it runs the app's exact `loadUri()` → `play()` sequence, and if that
is silent it calls `play()` again on a delay with no new tap. Moving only on the
second try means the app is losing a race with `loadUri` and the fix is to defer
the play call. Silent both ways means the unlock does not survive `loadUri` and
Spotify has to drop `loadArtist`, the way SoundCloud did.

Step 5 stays YouTube-only, correctly: the deck gives Spotify the full stage and
never reparents or shrinks it, so neither variable applies.

**Measured on the phone, 2026-08-05:** both SoundCloud's `widget.load()` and
Spotify's `loadUri` keep the same `<iframe>` node and **navigate it** — the src
changes to the new artist. A navigation is a new document, and a new document
has never been touched by a finger, so it loses the unlock for the same reason
a reload does. This is now the single shared mechanism behind both failures,
rather than two unrelated ones.

(An earlier version of this doc claimed SoundCloud drives its widget by
postMessage and never touches src. That was asserted, not measured, and the
device trace shows it is wrong. YouTube's `loadVideoById` has still not been
checked against this line — it is the one source known to carry, so it is the
interesting control and worth one run.)

## Test 2 — SoundCloud

Expected to pass, by construction. SC deliberately has no `loadArtist`, so
`canCarry` is false and every artist takes `rebuildChrome(snap, true)` →
`teardownEmbed()` → `mountEmbed()` — a fresh widget each time.

**There is no `widget.load()` call anywhere in player.js** (grepped). The
orange "Play on SoundCloud" interstitial therefore cannot come from our code on
this path; if it appears, SoundCloud is gating a *freshly built* widget, which
would be new information and worth the probe's step 4.

### Steps

Same 8-card run, **SoundCloud** tab, at least 4 consecutive cards. On each:

- Does it open **silent**?
- Is the glyph **▶**, not ⏸?
- Does **one** tap start sound?
- Any orange interstitial?

Then, on a card where it is playing, advance and **watch the glyph for ~3
seconds**: it should flip ⏸ → ▶ within 2.5s. That is the honest-icon watchdog
(`player.js:212`) reporting a refused autoplay, and it is the correct
behaviour, not a fault.

The two-tap signature is the glyph still reading ⏸ when you tap it — the first
tap then only withdraws a request that was never granted.

## Still open, not covered here

Handoff item 3 — the desktop three-pane Discover at ≥1200px. `refreshDeckInPlace`
returns false there (its `.dd-shell` query fails against the desktop tree), so
the pane still takes the full-rebuild path, but that has not been looked at
since the player work.

## Note on the seed page

Its intro copy still says "The token is fake — nothing syncs, nothing touches a
real database." That is stale: since `d1651c2` the page mints a **real** crew
through `/api/crew`, and preview and production both write to the production
Neon database. One real row per seed, no delete endpoint. The copy should be
corrected.
