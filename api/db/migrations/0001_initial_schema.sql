-- Bluebird → Supabase (Postgres) schema, v1.
--
-- This mirrors every JSON-file store Bluebird uses today (api/data/*.json
-- + scrape-cache/) as proper relational tables. It is NOT yet wired into
-- the running app - the API still reads/writes the JSON files. This file
-- is the target schema for the future migration; apply it to a Supabase
-- instance when you're ready to flip the persistence layer.
--
-- Design notes:
--   • IDs match today's code: companies + grid_cells use uuid
--     (crypto.randomUUID); icps + email_templates use text slugs.
--   • The per-ICP maps in companies.json (classifications{}, reviews{})
--     and the embedded leads[] become their own tables, keyed by
--     (company_id, icp_id) / (company_id, apollo_id) to match the current
--     dedupe keys.
--   • Timestamps: code stores epoch-millis; here we use timestamptz. The
--     migration script converts via to_timestamp(ms / 1000.0).
--   • lat/lng are plain double precision (no PostGIS) to keep Supabase
--     setup dependency-free. See README for the optional PostGIS upgrade
--     that would accelerate the disc-conflict prune + coverage queries.
--   • RLS: Bluebird is internal/no-auth today. RLS is left DISABLED here;
--     access goes through the service role from the backend. Enable + add
--     policies if the frontend ever talks to Supabase directly.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- Shared updated_at trigger ------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─── ICPs ────────────────────────────────────────────────────────────────
-- Mirrors api/data/icps.json (utils/icps.js validateIcp shape).
create table icps (
  id                 text primary key,                 -- slug
  name               text not null,
  vertical           text not null default '',
  portfolio_company  text not null default '',
  countries          text[] not null default '{}',
  search_terms       text[] not null default '{}',
  cities             text[] not null default '{}',
  coverage           jsonb  not null default '{"urban":true,"suburban":false,"rural":false,"airports":true}',
  -- structured classifier criteria
  target_description text not null default '',
  customer_types     text[] not null default '{}',
  exclude_types      text[] not null default '{}',
  exclude_companies  text[] not null default '{}',
  extra_notes        text not null default '',
  classify_prompt    text not null default '',
  use_custom_prompt  boolean not null default false,
  -- markdown report (per-ICP)
  report_enabled     boolean not null default false,
  report_template    text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index icps_portfolio_idx on icps (portfolio_company);
create index icps_vertical_idx  on icps (vertical);
create trigger icps_updated before update on icps
  for each row execute function set_updated_at();

-- ─── Email templates ─────────────────────────────────────────────────────
-- Mirrors api/data/email-templates.json (utils/email-templates.js).
create table email_templates (
  id                text primary key,                  -- slug
  name              text not null,
  portfolio_company text not null default '',
  default_for_icps  text[] not null default '{}',      -- which ICPs use this
  language          text not null default 'English',
  sender            jsonb not null,                    -- {firstName,lastName,title,company,email,signoff}
  voice             text not null default '',
  system_prompt     text not null,
  linkedin_guidance text not null default '',
  example_subject   text not null default '',
  example_body      text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index email_templates_portfolio_idx on email_templates (portfolio_company);
create trigger email_templates_updated before update on email_templates
  for each row execute function set_updated_at();

-- ─── Companies ───────────────────────────────────────────────────────────
-- Mirrors api/data/companies.json top-level records. The per-ICP
-- classifications{} and reviews{} maps + embedded leads[] are split out
-- into their own tables below. `domain` is the natural dedupe key
-- (upsertCompany matches on it), enforced unique.
create table companies (
  id               uuid primary key default gen_random_uuid(),
  domain           text unique,                        -- nullable: no-website Maps records
  url              text,
  name             text,                               -- surfaced from Maps title / classification
  vertical         text,
  city             text,
  lat              double precision,
  lng              double precision,
  -- source provenance: string form "icpId:city[:flag]" OR the sourcing
  -- promotion object. Kept as jsonb so either shape round-trips.
  source           jsonb,
  scraped_at       timestamptz,                        -- null/epoch-0 = seeded, never classified
  -- contacts harvested from the scraped site (utils/contact-extractor.js)
  scraped_contacts jsonb,                              -- {emails[],phones[],linkedinPersonUrls[],linkedinCompanyUrls[],extractedAt}
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  leads_updated_at timestamptz
);
create index companies_vertical_idx on companies (vertical);
create index companies_city_idx     on companies (city);
create index companies_loc_idx      on companies (lat, lng);
create trigger companies_updated before update on companies
  for each row execute function set_updated_at();

-- ─── Per-ICP classifications ─────────────────────────────────────────────
-- Replaces companies.json `classifications: { [icpId]: {...} }`.
-- One row per (company, ICP). The pinned legacy `classification` field is
-- just "the most recently classified row" - query order by classified_at.
create table company_classifications (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  icp_id        text not null references icps(id) on delete cascade,
  is_match      boolean,                               -- null = no-website / scrape-error
  reason        text,
  title         text,                                  -- from Google Maps
  phone         text,
  address       text,
  rating        numeric,
  reviews       integer,
  report        text,                                  -- GPT markdown report
  -- any extra structured fields the classifier emits (legacy rich shape:
  -- tagline, languages, signals, reasoning, etc.) live here untyped.
  details       jsonb,
  classified_at timestamptz not null default now(),
  unique (company_id, icp_id)
);
create index company_classifications_company_idx on company_classifications (company_id);
create index company_classifications_icp_idx     on company_classifications (icp_id);
create index company_classifications_match_idx   on company_classifications (icp_id, is_match);

-- ─── Per-ICP sales-rep reviews ───────────────────────────────────────────
-- Replaces companies.json `reviews: { [icpId]: {...} }` (setReviewForIcp).
-- Drives the Accounts page Pending / Confirmed / Rejected lanes.
create table company_reviews (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id) on delete cascade,
  icp_id      text not null references icps(id) on delete cascade,
  decision    text not null check (decision in ('confirmed','rejected')),
  reason      text,
  note        text,
  reviewed_at timestamptz not null default now(),
  unique (company_id, icp_id)
);
create index company_reviews_company_idx on company_reviews (company_id);
create index company_reviews_lane_idx    on company_reviews (icp_id, decision);

-- ─── Leads ───────────────────────────────────────────────────────────────
-- Replaces companies.json embedded leads[]. Dedupe key (company, apolloId)
-- matches upsertLeadInCompany. LI scrape cache lives inline as jsonb.
create table leads (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  apollo_id     text,
  first_name    text,
  last_name     text,
  title         text,
  email         text,
  email_status  text,
  linkedin_url  text,
  phone         text,
  has_email     boolean not null default false,
  enriched      boolean not null default false,
  enriched_at   timestamptz,
  phone_checked_at timestamptz,
  li_summary    jsonb,
  li_posts      jsonb,
  li_scraped_at timestamptz,
  added_at      timestamptz not null default now(),
  unique (company_id, apollo_id)
);
create index leads_company_idx on leads (company_id);
create index leads_email_idx   on leads (email);

-- ─── Grid cells (the coverage queue) ─────────────────────────────────────
-- Mirrors api/data/grid.json cells (utils/grid-store.js). This IS the
-- coverage queue: `pending` rows are the work queue, claimed by the sweep
-- cron in priority order. See README for the FOR UPDATE SKIP LOCKED claim
-- pattern that replaces nextPendingCell() safely for concurrent workers.
create table grid_cells (
  id                  uuid primary key default gen_random_uuid(),
  icp_id              text not null references icps(id) on delete cascade,
  tier                smallint not null,                  -- 1 = city scope, 2 = country fill
  lat                 double precision not null,
  lng                 double precision not null,
  ll                  text not null,                      -- scrapingdog "@lat,lng,zoom" string (zoom baked in)
  radius_km           integer,                            -- cosmetic / advertised radius
  parent_city         text,
  country             text,
  domain              text,                               -- google domain (google.co.uk, etc)
  language            text,
  place_source        text,                               -- populated | airport | sparse | null (tier-1)
  place_tier          text,                               -- urban | suburban | rural | airport | sparse
  population          integer not null default 0,
  state               text not null default 'pending'
                        check (state in ('pending','scanning','complete','no_new','empty')),
  -- outcome counts (filled on sweep completion)
  places_found        integer not null default 0,
  leads_qualified     integer not null default 0,
  chains_filtered     integer not null default 0,
  non_target_filtered integer not null default 0,
  already_known       integer not null default 0,
  last_scanned_at     timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Density priority, matching grid-store.js cellPriority(): lower = swept
  -- sooner. Generated so the queue ORDER BY can use it directly.
  priority            integer generated always as (
    case
      when place_tier = 'urban' then 1
      when place_source = 'airport' or place_tier = 'airport' then 2
      when place_tier = 'suburban' then 3
      when place_tier = 'rural' or place_source = 'sparse' then 4
      else 0
    end
  ) stored,
  -- Same physical cell can't exist twice for one ICP (addCells dedupe on
  -- icpId + lat/lng rounded to 4dp). Enforced here at full precision; the
  -- migration/insert path should round to 4dp to match exactly.
  unique (icp_id, lat, lng)
);
-- Hot path: nextPendingCell() = pick the next pending cell for an ICP in
-- (tier, priority, parent_city, created_at) order.
create index grid_cells_queue_idx
  on grid_cells (icp_id, state, tier, priority, parent_city, created_at);
create index grid_cells_icp_state_idx on grid_cells (icp_id, state);
create trigger grid_cells_updated before update on grid_cells
  for each row execute function set_updated_at();

-- ─── Scrape cache ────────────────────────────────────────────────────────
-- Replaces api/data/scrape-cache/<domain>.json (utils/scrape-cache.js).
-- One row per domain; cross-ICP reuse of Firecrawl markdown.
create table scrape_cache (
  domain      text primary key,
  vertical    text,
  url         text,
  page_title  text,
  markdown    text not null default '',
  scraped_at  timestamptz not null default now()
);

-- ─── Search log ──────────────────────────────────────────────────────────
-- Replaces api/data/search-log.json (utils/search-log.js). Dedupes
-- Scrapingdog Maps queries by (vertical, ~1km lat/lng bucket, term).
create table search_log (
  id           uuid primary key default gen_random_uuid(),
  vertical     text not null,
  lat_bucket   numeric not null,                        -- lat rounded to 0.01
  lng_bucket   numeric not null,
  term         text not null,                            -- normalized lower-case
  ran_at       timestamptz not null default now(),
  cell_id      uuid references grid_cells(id) on delete set null,
  icp_id       text references icps(id) on delete set null,
  result_count integer,
  unique (vertical, lat_bucket, lng_bucket, term)
);
create index search_log_lookup_idx on search_log (vertical, lat_bucket, lng_bucket);

-- ─── Sourcing scans + place details ──────────────────────────────────────
-- Replaces api/data/sources.json (utils/sources-store.js).
create table scans (
  id                  uuid primary key default gen_random_uuid(),
  city                text,
  country             text,
  ll                  text,
  query               text,
  page                integer,
  ran_at              timestamptz not null default now(),
  total_raw           integer,
  chains_filtered     integer,
  non_target_filtered integer,
  results             jsonb not null default '[]'        -- kept rows (replay without re-spending credits)
);
create index scans_ran_at_idx on scans (ran_at desc);

create table place_details (
  data_id    text primary key,                           -- scrapingdog data_id
  fetched_at timestamptz not null default now(),
  data       jsonb not null
);

-- ─── Geocoded cities cache ───────────────────────────────────────────────
-- Replaces api/data/geocoded-cities.json (utils/cities.js Photon cache).
create table geocoded_cities (
  key             text primary key,                      -- lowercased input slug
  label           text,
  country         text,
  domain          text,
  language        text,
  lat             double precision,
  lng             double precision,
  ll              text,
  metro_radius_km integer,
  geocoded        boolean not null default true,
  geocode_source  text,
  props           jsonb,                                 -- raw Photon props (debug provenance)
  created_at      timestamptz not null default now()
);

-- ─── Admin settings ──────────────────────────────────────────────────────
-- Replaces api/data/settings.json (utils/settings.js). One row per group
-- (cellGeneration, firecrawl, ai, linkedin) with the {useDefault, custom}
-- shape. Defaults live in code (DEFAULTS); only overrides need persisting.
create table app_settings (
  key         text primary key,                          -- 'cellGeneration' | 'firecrawl' | 'ai' | 'linkedin'
  use_default boolean not null default true,
  custom      jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);
create trigger app_settings_updated before update on app_settings
  for each row execute function set_updated_at();

-- ─── Activity events (optional) ──────────────────────────────────────────
-- The sweep activity feed is an in-memory ring today (utils/activity-log.js)
-- and is intentionally ephemeral. Persist here ONLY if you want durable
-- history / multi-instance fan-out. Safe to skip in v1.
create table activity_events (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  type        text,
  icp_id      text,
  cell_id     uuid,
  parent_city text,
  domain      text,
  title       text,
  reason      text,
  message     text,
  payload     jsonb                                       -- per-type extra fields
);
create index activity_events_icp_idx on activity_events (icp_id, id desc);
