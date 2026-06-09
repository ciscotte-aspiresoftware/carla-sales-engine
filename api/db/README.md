# Bluebird → Supabase migration (scaffolded, disabled)

This folder holds the **target Postgres/Supabase schema** + the connection
and import scaffolding for Bluebird. The app today persists to JSON files
under `api/data/`; this is the schema to move to when you want Supabase like
valsource. **Supabase is OFF by default** (`USE_SUPABASE=false`) and nothing
in the running app imports the client - applying the migration and even
flipping the flag won't change runtime behaviour until each store's
data-access layer is ported (see "Wiring it up later").

## Files
- `migrations/0001_initial_schema.sql` - full DDL: tables, FKs, indexes,
  the coverage-queue priority column, `updated_at` triggers.
- `index.js` - flag-gated Supabase client (`isEnabled()` / `getClient()` /
  `getStatus()`). Lazy-requires `@supabase/supabase-js`; throws clearly when
  disabled or unconfigured. This is the seam stores will adopt.
- `import-json.js` - one-time uploader: `api/data/*.json` → Supabase tables
  (`npm run db:import`). Idempotent (upsert on natural keys), FK-safe order.
- `status.js` - connection check (`npm run db:status`).

## Enabling Supabase + importing the existing data

This is the "make a Supabase account and upload our data" flow:

1. Create a Supabase project.
2. In the Supabase **SQL editor**, paste + run
   `migrations/0001_initial_schema.sql`.
3. In `.env` (repo root) set:
   ```
   USE_SUPABASE=true
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_KEY=<service-role key>   # server-only, bypasses RLS
   ```
4. From `api/`:
   ```
   npm install          # pulls @supabase/supabase-js
   npm run db:status     # → "Connected ✓ (icps table reachable)."
   npm run db:import     # uploads icps, companies+leads, grid cells, cache, …
   ```

### Scoping the import to one portfolio company

To upload **just one portfolio's** data (e.g. NedFox, leaving Bluebird +
Thermeon out) - no files moved or deleted, purely an import-time filter:

```
npm run db:import -- --portfolio NedFox
# or by explicit ICP ids:
npm run db:import -- --icps nedfox-garden,nedfox-thrift,nedfox-camping
```

Keeps only the matching ICPs and everything tied to them - companies
classified under those ICPs, their per-ICP classifications/reviews, leads,
grid cells, plus scrape-cache + search-log for those ICPs' verticals, and
matching email templates. Sourcing `scans`/`place_details` are skipped (not
ICP-scoped); `geocoded_cities` + `app_settings` are neutral infra and always
included. Run with no flag later to backfill the rest. (Verified on the
current data: `--portfolio NedFox` → 5 ICPs, 121/394 companies, 13/50 cells.)

Importing is safe to re-run (rows upsert, not duplicate). Note: the app
**still reads JSON** even with the flag on - the import just stages the data
in Supabase ahead of porting the stores.

## JSON store → table map

| Today (`api/data/…`) | Table(s) | Notes |
|---|---|---|
| `companies.json` (record) | `companies` | one row per company, `domain` unique (the upsert key) |
| `companies.json` → `classifications{icpId}` | `company_classifications` | one row per (company, ICP); `report` markdown lives here |
| `companies.json` → `reviews{icpId}` | `company_reviews` | Accounts lanes; `(company,icp)` unique |
| `companies.json` → `leads[]` | `leads` | `(company, apollo_id)` unique; LI scrape inline as jsonb |
| `companies.json` → `scrapedContacts` | `companies.scraped_contacts` (jsonb) | emails/phones/LinkedIn from the site |
| `icps.json` | `icps` | text-slug PK, arrays as `text[]`, coverage as jsonb |
| `email-templates.json` | `email_templates` | text-slug PK, `sender` as jsonb |
| `grid.json` → `cells[]` | `grid_cells` | **the coverage queue** - see below |
| `scrape-cache/<domain>.json` | `scrape_cache` | one row per domain |
| `search-log.json` | `search_log` | `(vertical, lat_bucket, lng_bucket, term)` unique |
| `sources.json` → `scans[]` | `scans` | kept results as jsonb for free replay |
| `sources.json` → `placeDetails{}` | `place_details` | keyed by scrapingdog `data_id` |
| `geocoded-cities.json` | `geocoded_cities` | Photon geocode cache |
| `settings.json` | `app_settings` | one row per group (`cellGeneration`/`firecrawl`/`ai`/`linkedin`) |
| `mode.json` | - | dropped (demo mode was removed) |
| activity-log (in-memory) | `activity_events` (optional) | ephemeral today; persist only if you want history |

## The coverage queue (what you specifically asked about)

`grid_cells` IS the coverage queue. A cell's lifecycle:
`pending → scanning → complete | no_new | empty`. Pending cells are the
work queue; the sweep cron pulls the highest-priority pending cell per ICP.

Today `nextPendingCell(icpId)` reads the whole `grid.json` and sorts in JS
by `tier → density-priority → parent_city → created_at`. In Postgres that
becomes one indexed query - and crucially, you can claim a cell
**atomically** so two workers never grab the same one:

```sql
-- Claim the next pending cell for an ICP (concurrency-safe).
with next as (
  select id
  from grid_cells
  where icp_id = $1 and state = 'pending'
  order by tier, priority, parent_city, created_at
  limit 1
  for update skip locked          -- the magic: other workers skip a locked row
)
update grid_cells g
set state = 'scanning', last_scanned_at = now()
from next
where g.id = next.id
returning g.*;
```

`priority` is a generated column (urban=1, airport=2, suburban=3,
rural/sparse=4) mirroring `cellPriority()`, and
`grid_cells_queue_idx (icp_id, state, tier, priority, parent_city, created_at)`
makes the claim O(log n). On completion:

```sql
update grid_cells
set state = $2,                    -- 'complete' | 'no_new' | 'empty'
    places_found = $3, leads_qualified = $4, chains_filtered = $5,
    non_target_filtered = $6, already_known = $7, last_scanned_at = now()
where id = $1;
```

Orphan rescue (the boot-time `rescuOrphanedScanningCells`) becomes:
```sql
update grid_cells set state = 'pending' where state = 'scanning';
```
Run it on startup, or rely on `FOR UPDATE SKIP LOCKED` + a stale-`scanning`
sweeper (`where state='scanning' and last_scanned_at < now() - interval '15 min'`).

`FOR UPDATE SKIP LOCKED` is what lets you eventually run **multiple sweep
workers in parallel** (the per-survivor parallelism idea from the deferred
list) without double-scanning - something the single JSON file can't do.

## Type/convention notes
- **Timestamps**: code uses epoch-millis; tables use `timestamptz`. Convert
  on migration with `to_timestamp(ms / 1000.0)`; convert back in the data
  layer if any callers still expect ms.
- **IDs**: `companies` + `grid_cells` keep uuid (matches `crypto.randomUUID`);
  `icps` + `email_templates` keep text slugs.
- **lat/lng**: plain `double precision`. If the disc-conflict prune or
  coverage stats ever need real spatial queries, add PostGIS
  (`create extension postgis`) and a `geography(Point)` column + GiST index -
  then "cells within X km" becomes `ST_DWithin` instead of haversine in JS.
- **RLS**: disabled (internal tool, backend uses the service role). Enable +
  add policies before letting the browser hit Supabase directly.

## Wiring it up later (the actual switch)

The data access is already isolated in small modules, so the swap is
contained - replace the `fs` body of each, keep the function signatures:

1. ✅ Done - client lives at `db/index.js` (`getClient()`, service-role key,
   flag-gated). Use it from the ported stores.
2. Port store-by-store (each maps to tables above), gating on
   `require('../db').isEnabled()` so a store falls back to JSON when the flag
   is off:
   - `routes/companies.js` (readAll/upsertCompany/attach/upsert lead/
     set classification/review/report) → `companies` + `company_*` + `leads`
   - `utils/grid-store.js` → `grid_cells` (use the claim query above)
   - `utils/icps.js`, `utils/email-templates.js`, `utils/settings.js`
   - `utils/scrape-cache.js`, `utils/search-log.js`, `utils/sources-store.js`,
     `utils/cities.js` (geocode cache)
3. ✅ Done - one-time backfill is `db/import-json.js` (`npm run db:import`):
   reads each `api/data/*.json`, converts millis→timestamptz, expands
   `classifications{}`/`reviews{}` maps → rows and `leads[]` → rows.
4. Keep the JSON files as a fallback/export until the cutover is verified.

Because every store is behind a function boundary today, the routes and the
sweep pipeline don't change - only the store internals do.
