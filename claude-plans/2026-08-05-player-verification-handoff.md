# Handoff — what still needs a phone, 2026-08-05

Everything below is on `main` and deployed to `ray-festival.vercel.app`
(SW `festival-nav-v65`). Nothing here is broken as far as anyone knows; the
point of this doc is that **parts of it have never been tested on a device, and
this is a class of bug that no laptop can catch.**

## Why this needs a phone at all

Two platform rules govern Discovery's sample player, and **neither is enforced
by any desktop browser**:

1. **iOS will not start audio on an element no finger has touched.** A media
   element gets "unlocked" by a user gesture, and the unlock belongs to that
   element.
2. **WebKit re-creates an iframe's browsing context on ANY reparent** — even one
   where the element never leaves the document, and even `appendChild` onto the
   parent it is already in. Measured: `onReady` fired a second time and the
   unlock was gone.

Both are written up in the session memory (`ios-media-gesture-unlock`,
`webkit-iframe-reparent-reloads`) and are the reason `refreshDeckInPlace`
(deck.js) and `rebuildChromeAroundEmbed` / `remountFor` (player.js) exist. Those
functions look like premature optimisation on a laptop. They are not. **A
"simplification" there will pass every local check and silently kill playback on
a phone.**

Chrome will happily tell you all of this works. It is not qualified to.

## Not yet verified on a device

### 1. Spotify, against the in-place advance — NEVER TESTED

The highest-value gap. Spotify has a `loadArtist` (`controller.loadUri`) and
takes the same carry path YouTube does, so on paper it continues playing across
an artist change. It has never been checked on hardware.

It is not safe to assume it behaves like YouTube. **SoundCloud looked identical
on paper and turned out to be impossible** — its widget drops the gesture unlock
on `load()` and re-gates behind its own "Play on SoundCloud / Listen in browser"
interstitial, which is why the SC adapter deliberately has NO `loadArtist`.
Spotify could have an equivalent gate nobody has hit yet.

Test: Discover → Spotify tab → play → pick or swipe → does sound continue?
If it stops, check whether the embed redraws its own play button (a gate, like
SoundCloud) or just sits silent (a refused autoplay, which the watchdog should
already be correcting to a ▶ glyph).

### 2. SoundCloud, AFTER the persistent-card change — STALE PASS

SoundCloud was confirmed working on a device, but **that pass predates
`refreshDeckInPlace`**, which changed how the whole card is rebuilt on advance.
SC intentionally does not carry, so it should be unaffected — it takes the
teardown-and-rebuild path — but "should be" is exactly the phrase that has been
wrong three times in this area.

Test: SoundCloud tab → play → advance → each artist should open **silent with a
▶ glyph and start on ONE tap.** Two taps means the honest-icon watchdog is being
fooled again. The orange "Play on SoundCloud" interstitial should never appear
mid-deck; if it does, something is calling `widget.load()` when it should be
rebuilding.

### 3. The desktop three-pane Discover — UNTESTED SINCE THE PLAYER WORK

`refreshDeckInPlace` returns false on desktop, so the desktop pane still takes
the full-rebuild path and should be unchanged. Worth one look at ≥1200px that
picking in the pane still advances without killing the player.

## How to test without touching real data

`/design/seed-qa-crew` mints a **real** throwaway crew through `/api/crew` (it
used to invent a local token, which only ever worked against a static server —
see the commit for why). Pick **Ubbi Dubbi '26**: 50 artists, fully enriched on
all three sources. It creates one real row in the production database; there is
no delete endpoint, so "Clear" only clears the browser.

**Load any deployed URL twice.** The service worker serves cached JS on the
first load after a deploy, so a fresh fix reads as "no change". This wasted
three debugging rounds today, and a `?bust=` query on index.html does NOT bust
`/js/**`.

## The instrument, if a test fails

`/design/ios-playback-probe` drives the RAW YouTube and SoundCloud embeds
directly — not our player — so it separates "the platform refuses this" from
"our wiring is wrong". Steps 1–3 cover gesture and carry; 4 is SoundCloud's
load-then-play path; 5A/5B isolate size from movement. It judges on **playhead
position, never on a PLAY event**, because both embeds fire PLAY while being
refused. Every conclusion in the memory files came out of it.

## Data work still open

- **YouTube backfill**: 212 rows lack `youtubeVideoIds`. ~2 more quota-days now
  that the 429 backoff actually lets a tranche spend its budget. Runs are slower
  in wall-clock as a result — budget time, not just units.
- **Genres**: 176 rows have none. Last.fm took the gap from 542 to 176; what is
  left is mostly artists Last.fm has no tags for. Re-running is free and picks
  up artists as people tag them, so it is worth repeating occasionally.
- **Two unrenderable rows**: `Almost Heaven ["epic doom metal"]` needs a
  one-line synonym to the existing `Metal`; `Dixon's Violin ["avant-garde",
  "experimental","instrumental"]` needs a vocabulary decision, since
  `Experimental` is not one of the 40 canonical genres. Left alone deliberately.
- **SoundCloud slugs**: 144 review rows and the ACL/Lolla call are still open
  from an earlier session.

## Dead ends — do not re-attempt

- **Spotify for genres**: `/v1/artists` no longer returns `genres` (nor
  `popularity`/`followers`) on the standard access tier, and the batch `?ids=`
  endpoint 403s. Credentials authenticate fine; the field is simply gone.
- **Deezer for genres**: no artist-level genres at all.
- **MusicBrainz**: exhausted, not under-used. It skips any artist with a cached
  `mbid`, correctly — the id means the lookup already happened.

`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` and `LASTFM_SHARED_SECRET` in the
workspace `.env` are all unused and can be removed. `LASTFM_API_KEY` and
`YOUTUBE_API_KEY` are both live.
