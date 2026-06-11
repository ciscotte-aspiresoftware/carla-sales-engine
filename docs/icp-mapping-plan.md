# ICP-Driven Region Mapping

**Status**: planning
**Owner**: Shehryar
**Last updated**: 2026-05-07

> Goal: turn Carla from a one-off "search a city" tool into a system that systematically maps every car-rental business in a region (UK first, then anywhere), assigns survivors to sales reps overnight, and visualizes coverage on the existing 3D globe — green = mapped, red = mapping in progress. Once the substrate works for Carla, swap the ICP config and re-point at Thermeon, Navotar, or any future Valsoft portfolio company.

---

## 1. Why

Today's pipeline scans **one city per click**, with the user picking the city. To map an entire country we'd run 50+ manual searches and still miss leads in dense areas (Google Maps caps at ~20 results per Search call — a single query at central London returns 20 of ~100+ rentals).

What we want:

- **Systematic coverage** of a target region — eventually every car-rental business in the UK gets seen at least once
- **Density-aware grid** — fine cells in cities (so we catch all 100+ rentals), coarse cells in rural areas (no wasted credits scanning empty fields)
- **Overnight automation** — sales team wakes up to fresh assignments, no manual searches
- **Visual progress** — the globe goes green city-by-city as coverage completes
- **ICP-pluggable** — same pipeline works for Thermeon/Navotar/NedFox by swapping a config

---

## 2. Concepts

### ICP (Ideal Customer Profile)

A config object describing **what we're looking for** and **how to qualify it**. Each portfolio company gets its own ICP. Stored in a `icps` table or, initially, as a JSON file checked into the repo.

```jsonc
{
  "id": "carla",
  "name": "Carla Auto Rental Software",
  "vertical": "Car Rental",
  "regions": ["UK", "US", "CA"],          // which Tier-1 city lists to use
  "searchTerms": [
    "car rental",
    "vehicle hire",                          // UK terminology
    "auto rental"
  ],
  "chainBlocklist": ["hertz", "avis", "enterprise", ...],  // already in chains.js
  "targetTypes": ["car_rental_agency", "car_rental"],      // already in chains.js
  "classifyPrompt": "Is this an independent car rental or vehicle-hire business serving end customers? Answer yes/no with a 1-sentence reason.",
  "filters": {
    "grata": { "employees": { "min": 5, "max": 500 } },    // optional firmographic gate
    "site": []                                                // optional GPT-extracted attributes (fleet size etc — Phase 4)
  }
}
```

Phase 1 ships with **just the Carla ICP**. Other portfolio companies get added once the pipeline proves out.

### Grid cell

A geographic search target. Two tiers:

| Tier | Use | Cell size | Source |
|---|---|---|---|
| **1** | Major cities (London, Manchester, Birmingham, …) | 5 km radius | Hand-curated city list per region, sub-divided into a small hex grid for full coverage |
| **2** | Country fill | 25 km radius | Generated from country bounding box, populated only after Tier-1 completes |

A cell is one row in `grid_cells` with: `id, icp_id, tier, lat, lng, radius_km, parent_city, state, …`

### Cell state machine

```
pending  →  scanning  →  complete            (cell had places worth qualifying)
             (red)         (green)
                       →  empty               (no non-chain car rentals here)
                          (gray)
```

The cron reads `pending` cells, marks them `scanning` (turns red on the globe), runs the pipeline, then transitions to `complete` or `empty` based on what the search returned.

### Completion criteria

A cell flips to `complete` (or `empty`) when the search **returned ≤3 new non-chain places after dedupe**. "Ran once" is too eager — Google Maps results shift slightly between calls and a single low-result search could miss real businesses.

---

## 3. Pipeline (per cell)

```
Pick next pending cell  (Tier-1 first; major-city order)
       │
       ▼
Mark state = scanning           ← cell turns RED on globe
       │
       ▼
Scrapingdog Search (5 credits)
  → {query: ICP.searchTerms[0], ll: cell.ll, country: cell.country}
       │
       ▼
Filter: chains.js blocklist  (free)
Filter: target types         (free)
Filter: dedupe vs companies  (free, place_id check)
       │
       ▼
For each NEW survivor:
  Firecrawl scrape           (~3 credits)
  GPT classify (ICP.classifyPrompt)
  If positive →
    upsert companies row (icp_id, classify=true)
    create leads (Apollo search-only, 0 credits)
    queue assignment (rotation-aware)
  If negative →
    upsert companies row (icp_id, classify=false)  // future runs skip via vms-style cache
       │
       ▼
Update cell:
  state = complete OR empty
  last_scanned_at = now
  places_found, leads_qualified counts
       │
       ▼
Sleep N seconds, next cell.
```

Reuses **everything already in Carla**:
- `scrapingdog.js` Search wrapper
- `firecrawl.js` scrape wrapper
- `openai.js` classify wrapper
- `chains.js` blocklist + target types
- `companies` / `leads` upsert pattern (mirrored from valsource's `jobHelper.js`)
- The chain-of-API-calls error handling already proven in valsource's VMS queue

New code:
- Cell scheduler (pick next pending cell)
- Cell scanning lifecycle (state transitions, completion criteria)
- Per-ICP cron (schedule, budget cap)
- Globe layer rendering cells

---

## 4. Globe dashboard (the visualization)

**Reuse the existing react-globe.gl component** in `web/src/components/sourcing/globe-picker.tsx`. Add a layer that renders grid cells as colored polygons.

### Layout

```
┌───────────────────────────────────────────┐
│ ICP: [Carla ▼]   Region: [UK ▼]   📊   │  ← header, switches ICP/region
├───────────────────────────────────────────┤
│                                           │
│            (3D globe, pre-zoomed          │
│             on the active region)         │
│                                           │
│    ▓▓▓ green cells = complete             │
│    ░░░ red cells   = scanning now         │
│    ··· gray cells  = pending              │
│                                           │
├───────────────────────────────────────────┤
│ Coverage: 22 / 84 cells (26%)             │
│ Leads found this week: 47                 │
│ Last scan: 12 min ago                     │
└───────────────────────────────────────────┘
```

### Pre-zoom

When the page loads with ICP=Carla, region=UK selected:
- Globe rotates to UK center (~54°N, -2°W) at altitude 1.2
- 3D `pointOfView` animation, ~1.4 sec
- User can still drag to rotate / zoom out

When ICP changes to e.g. Navotar (regions: ["US", "CA"]):
- Re-zoom to North America bounding box

### Cell rendering

Each cell = one entry in `polygonsData`, with the H3 hex boundary as its geometry. The cell colors:

```js
function cellColor(cell) {
  switch (cell.state) {
    case 'complete': return 'rgba(74, 222, 128, 0.55)'   // emerald
    case 'scanning': return 'rgba(248, 113, 113, 0.65)'  // red, pulsing via CSS animation
    case 'empty':    return 'rgba(148, 163, 184, 0.25)'  // gray, very subtle
    case 'pending':  return 'rgba(125, 211, 252, 0.20)'  // sky, very subtle
  }
}
```

`scanning` cells get a slow pulse via `polygonAltitude` interpolating up/down (or just inline CSS keyframes if we render via htmlElementsData like NL animation).

### Click a cell

→ side-drawer with:
- Last scan timestamp
- Places found / leads qualified
- Sales reps the leads were assigned to
- Manual "rescan" button (for stale cells)

### Stat strip

- Coverage %: complete cells / total cells
- Leads-found-today + leads-found-week
- Estimated days to full coverage at current rate (cells/night × cells remaining)

---

## 5. Data model

### `icps` (or JSON file in Phase 1)

| column | type | notes |
|---|---|---|
| id | text PK | `'carla'` |
| name | text | Display name |
| vertical | text | `'Car Rental'` |
| search_terms | text[] | rotated through Scrapingdog queries |
| chain_blocklist | text[] | merged with global chains.js |
| target_types | text[] | merged with global target types |
| classify_prompt | text | passed to GPT |
| regions | text[] | which Tier-1 city sets to seed |
| filters | jsonb | grata + site filter config (Phase 4) |
| created_at | timestamptz | |

### `grid_cells`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| icp_id | text | FK → icps |
| tier | int | 1 or 2 |
| lat | numeric | center |
| lng | numeric | center |
| radius_km | int | 5 for Tier-1, 25 for Tier-2 |
| h3_cell | text | optional, for hex-grid rendering on globe |
| parent_city | text | nullable, for Tier-1 cells (e.g. `'London'`) |
| country | text | ISO-2 |
| state | text | `'pending' \| 'scanning' \| 'complete' \| 'empty'` |
| last_scanned_at | timestamptz | nullable |
| places_found | int | total non-chain places returned |
| leads_qualified | int | survivors that passed classify |
| created_at | timestamptz | |
| updated_at | timestamptz | |

Indexes: `(icp_id, state, tier)` for the scheduler's "pick next pending Tier-1" query.

### Existing tables (reused, with one new column)

- `companies` — add `icp_id` text column. Already has place_id/domain/grata fields.
- `leads` — already has `company` FK, no change needed.
- `account_assignments` — already has assigned_to, just gets new rows from this pipeline. Add a `source` column or use existing `assigned_by` to label these as `'Carla sweep'` / `'Carla ICP'` / etc.

---

## 6. Cron + scheduling

- **One cron per ICP**, runs nightly at the same time the sales team is offline (e.g. 02:00 ET — TBD per region's timezone).
- Pulls the next batch of `pending` cells, ordered by `(tier ASC, parent_city, created_at)`.
- Stops when a budget cap is hit (default 30 cells/night ≈ 150 Scrapingdog credits + ~100 Firecrawl + ~100 GPT calls — order of magnitude).
- Per-rep assignment cap: max 30 new accounts per person per night so sales reps don't get drowned.

When the cron starts, it can optionally surface a "scanning now" indicator on the globe if anyone's looking at it overnight — `scanning` cells go red, transition to green/gray as they complete.

---

## 7. Region seeding (Tier-1 city lists)

Hand-curated per region. UK seeding to start:

```
London, Manchester, Birmingham, Glasgow, Edinburgh, Leeds,
Liverpool, Bristol, Newcastle, Sheffield, Nottingham, Cardiff,
Belfast, Aberdeen, Brighton, Reading, Cambridge, Oxford,
Southampton, Plymouth, Norwich, Bournemouth, ...
```

For each city: take the city center lat/lng, generate a 5-km hex sub-grid covering the metro footprint (~10-30 sub-cells per major metro). Stored as Tier-1 cells.

After all Tier-1 for a region completes, schedule fills in Tier-2 (25-km grid over the country bounding box, skipping cells inside any Tier-1 area). Tier-2 cells that return 0 results auto-flip to `empty` (no follow-up needed for an empty 25km square in Wales).

---

## 8. Phasing

**Phase 1 — Carla MVP (no globe yet)**
- `grid_cells` table
- Hand-seed UK Tier-1 cities
- Cron + cell scheduler
- Pipeline: Scrapingdog → chains → Firecrawl → GPT classify → companies/leads/assignments
- New `companies.icp_id` column
- Output goes to existing My Accounts–style page

**Phase 2 — Globe dashboard**
- Add cells layer to existing globe-picker
- Pre-zoom on active region
- Color by state (green/red/gray/pending)
- Stat strip + click-cell-for-details drawer

**Phase 3 — Tier-2 country fill**
- Generate Tier-2 grid from country bounding box
- Skip cells overlapping Tier-1
- Empty-cell auto-completion

**Phase 4 — ICP abstraction**
- Move ICP from JSON to DB table
- ICP picker in UI
- Add Thermeon, Navotar, NedFox configs
- Optional: site-scrape filters (fleet size etc) for ICPs that need them

**Phase 5 — Refresh cycle**
- Re-open complete cells after N months for delta scan
- Diff: only assign places we hadn't seen before

---

## 9. Open questions

- **Cron frequency vs nightly batch**: nightly is the default but a slower-paced "5 cells per hour" might be better for credit smoothing. Decide once we see Phase 1 throughput.
- **Authentication**: who can switch ICPs / trigger manual rescans? Admin-gated like the VMS queue's arm flow?
- **Multi-region ICPs** (e.g. Navotar = US+CA): does the cron round-robin between regions or finish one before moving on? Default: finish one.
- **Failure recovery**: what happens if Firecrawl 403s mid-cell? Mark the cell `scanning`-paused, retry next night? Skip-with-warning?
- **Auth on the globe page**: same gate as the rest of Carla (whatever that ends up being).
- **ICP changes invalidate state?**: if I change Carla's `searchTerms` from "car rental" to "vehicle hire", do all `complete` cells reopen? (Probably yes — should be user-confirmed.)

---

## 10. Why this matches Carla's existing shape

- Already has Scrapingdog + Firecrawl + GPT classify wired
- Already has the 3D globe + react-globe.gl + h3-js for cell tessellation
- Already has companies/leads/sources-store + the assignments concept (mirrored from valsource)
- Already has the cron pattern + Supabase client (port from valsource)

Everything new in this plan is **schema + scheduler + globe layer**. The hard infrastructure (API integrations, classification prompts, chain filter, dedupe, assignment rotation) is already proven in valsource's VMS queue and just needs to be wired into a new orchestrator.
