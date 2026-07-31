# Reference data — use real content in mockups

All figures below are from the **actual** festival data shipping in the app today.

---

## 1. How big is a real lineup?

| Festival | Artists | Stages | Days | Phase |
|---|---:|---:|---:|---|
| Lollapalooza '25 | **176** | 13 | 4 | times published |
| Electric Forest '26 | **167** | 7 | 4 | times published |
| ACL Music Festival '26 | 124 | — | — | lineup only |
| Lost Lands '26 | 117 | — | — | lineup only |
| EDC Orlando '26 | 106 | — | — | lineup only |
| Wicked Oaks '25 | 68 | — | — | lineup only |
| Portola '26 | 62 | — | — | lineup only |
| Ubbi Dubbi '26 | 50 | — | — | lineup only |
| Seismic Dance Event 9.0 | 33 | — | — | lineup only |
| Tomorrowland Winter '27 | **0** | — | — | announced, no lineup yet |

**Design implications**
- **~60–180 artists is normal**; the Tomorrowland Belgium data we're porting next has
  **15 stages fully timed across 3 days**. A dense timetable is *15 stages × ~14 hours*.
- **Most festivals in the list are lineup-only** — Phase 1 is the common case, and the
  one people live in longest (lineups drop months before set times).
- **A festival can have zero artists** (announced, nothing released). That's a real
  state, not an error — see Tomorrowland Winter '27.

## 2. Real artist names — design against these

**Short (easy):** `Alok` · `Julie` · `Skrillex` · `Four Tet` · `Wooli` · `AAT` · `Sunami`
· `Yana` · `Prospa` · `Kaskade` · `Mau P` · `LAYZ` · `Sippy` · `GRiZ`

**Medium:** `Alison Wonderland` · `Martin Garrix` · `Vince Staples` · `The Strokes` ·
`Jessica Audiffred` · `Nourished by Time` · `Marlon Hoffstadt` · `Chris Lorenzo`

**Long / awkward — these are the ones that break layouts:**

```
Skull Machine (Black Tiger Sex Machine x Kai Wachi)   ← 51 chars
The Huston-Tillotson University Jazz Collective
Rumble in the Bumble Beatbox Battle
Solid Gold Disco / LCD Clownsystem
San Holo (Wholesome Riddim Set)
Bullet Tooth B2B Sidney Charles
Boys Noize B2B Brutalismus 3000
Torren Foot B2B Rawolf Paradiso
Deorro B2B DJ Diesel
Detroit Party Marching Band
Divinity Roxx & Divi Roxx Kids
```

**Patterns worth knowing**
- **`B2B`** ("back to back") = two DJs playing a joint set. Extremely common in dance
  lineups and always makes the name long. Sometimes three names.
- **Parenthetical set types** — `(Sunset Set)`, `(Wholesome Riddim Set)`,
  `(Black Tiger Sex Machine x Kai Wachi)`. The *same artist* may appear twice at one
  festival with different set types.
- **Non-ASCII and odd casing are normal** — `CØNTRA`, `Adrián Mills`, `Me n ü`,
  `half•alive`, `ALLEYCVT`, `AYYBO`, `phrva`. Names use the artist's own spelling; do
  not design around title-case.

## 3. Genres (Phase 1's primary lens)

Not yet in the data — this is part of what Discovery adds. Expect dance-music
granularity, which is finer than most people's mental model:

```
Big Room · Progressive House · Tech House · Melodic Techno · Hard Techno
Dubstep · Riddim · Drum & Bass · Jungle · Trance · Psytrance · Hardstyle
Future Bass · Bass House · Afro House · Disco · Garage · Trap
```

**Open problem you may want to design around:** an artist can carry 1–8 tags of wildly
varying usefulness (`"electronic"` is true and useless; `"riddim"` is specific and
valuable). A raw tag cloud will not work; some normalisation or ranking is needed.

## 4. What data exists to display

Per artist, on the wall today:

| Field | Always? | Notes |
|---|---|---|
| `name` | yes | see §2 |
| `day` | Phase 2 | e.g. `"Friday"`, `"Day 1"` |
| `stage` | Phase 2 | e.g. `"Ranch Arena"`, `"DOLLAPALOOZA"`, `"T-Mobile"` |
| `time` | Phase 2 | `"12:00 PM - 12:30 PM"` |
| **Array position** | yes | **= billing order.** Headliners at the top; also a free popularity signal. |

Coming with Discovery: `genres[]`, `spotifyId`, `soundcloudSlug`, `youtubeQuery`,
`bandsintownId`, plus per-person **taste**, **seen-log** and **passes**.

From the crew document: who picked (and at what level 1–4), **who passed**, note counts
per artist/day/festival, each member's colour slot and initial.

## 5. Crew size

Typically **2–8 people**. The colour board holds 24 and wraps after that. Members are
**colour + initial**, never a photo — two members sharing a first initial both show two
letters (`Dr`, `Da`). Assume 3–5 people for a realistic mockup, and check that 8 doesn't
break the who-corner (it caps at 2 musts + 2 ticks, then a `+n` ghost).

## 6. Real stage names

```
MAINSTAGE · Freedom by Bud · The Great Library · Crystal Garden     (Tomorrowland)
T-Mobile · Bud Light · Lakeshore · The Grove · Tito's · BMI · DOLLAPALOOZA  (Lolla)
Ranch Arena · Sherwood Court · Tripolee · The Observatory            (Electric Forest)
```

Note the casing is inconsistent and sponsor names are common — stage labels are
uppercased in the UI, and some are long.

## 7. Timing facts that shape Phase 2

- Festival days routinely run **12:00 PM → 2:00 AM**; sets **cross midnight**, so a
  "day" is not a calendar day.
- Set lengths vary **30 min → 2 hours**; short sets are the hard layout case (a 30-min
  set at the same visual scale as a 2-hour one).
- **Headliners play last.** Billing order and clock time correlate — early slots are
  where unknown artists live, which is exactly where gap-filling pays off most.
- Multiple sets run **simultaneously on every stage** — that's the whole planning
  problem. Overlap is the default, not the exception.
