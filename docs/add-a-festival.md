# Adding a festival

*Updated 2026-07-07.*

Two files, one command:

1. **Create `data/festivals/<id>.json`** — id is a lowercase slug like
   `acl-2026`. Minimum viable (lineup announced, no set times yet):

```json
{
  "id": "my-fest-2026",
  "name": "My Fest",
  "year": "'26",
  "subtitle": "Some Venue",
  "location": "Austin, TX",
  "dates": "October 2-4, 2026",
  "accent": "16, 185, 129",
  "status": "lineup",
  "artists": [
    { "name": "Headliner" },
    { "name": "Support Act", "day": "Friday" }
  ]
}
```

   - `status`: `lineup` (no set times yet — app shows the sortable artist
     list), `scheduled` (full grid), or `archived` (past).
   - `artists[]` is always required (it feeds the list view). Optional per
     artist: `day`, `stage`, `time`, `weekends` (`"W1"|"W2"|"both"`, for
     two-weekend festivals — enables the weekend filter).
   - When set times drop, add `dayMeta` and `days{}` — each day carries its own `stages[]`; there is no top-level stages field (the renderer and validator only read `fest.days.<day>.stages`) (see
     `electric-forest-2026.json` for the full scheduled shape) and flip
     `status` to `scheduled`. Times are `"6:30 PM"` or `"6:30 PM - 7:30 PM"`;
     a missing end is filled from the next set on that stage.
   - Optional `activities{}` for non-stage programming (workshops, silent
     disco) — renders as a time-sorted list under the grid.

2. **Add an entry to `data/festivals/index.json`** (keep it ordered by date,
   archived last — the first non-archived entry is the default festival).
   Every index entry needs `startsOn: "YYYY-MM-DD"` (the festival's first
   day) — it drives the landing's date sort and its "Sep '26" labels; the
   validator rejects entries without it.

3. **Validate:** `node scripts/validate-festivals.mjs` — errors block CI.
   `scripts/import-festival.mjs` helps convert pasted lineup text.

4. **Enrich:** `node scripts/enrich-artists.mjs <festival-id>` fills genres and
   link-outs from MusicBrainz.

5. **Backfill the SoundCloud links MusicBrainz doesn't have.** MusicBrainz
   carries no SoundCloud relation for most of this catalogue, so step 4 leaves
   a lot of `soundcloudSlug` gaps that are not real absences —
   `node scripts/backfill-soundcloud.mjs <festival-id>` searches SoundCloud
   itself and writes a report of what it would link. It is **dry run by
   default**: read the report, then re-run with `--apply` (auto rows only) or
   `--apply --include-review`. The `review` bucket exists because a match on
   an artist's free-text username is not proof of identity — decide those by
   eye. Set `SOUNDCLOUD_CLIENT_ID` if you have an official key; without one it
   borrows the public widget's id, which works but can rotate without notice.

Picks are keyed by artist name, so keep names stable between the lineup and
scheduled phases (fixing capitalization is safe — lookups are exact by name,
so a spelling change orphans existing picks for that artist).
