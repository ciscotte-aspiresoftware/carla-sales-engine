-- API + LLM usage ledger.
--
-- One row per outbound call to a billable external service (OpenAI,
-- Scrapingdog, Firecrawl, Apollo, Apify). Drives the /costs page: per-model
-- spend, per-service breakdown, daily timeline, recent-calls table.
--
-- Written fire-and-forget by api/utils/api-cost.js so a logging failure
-- never blocks the main request. usd_cost is computed at write time from
-- the pricing table baked into api-cost.js, so historical rows survive
-- pricing changes (the rate at which we estimated cost is captured the
-- moment the call lands).
--
-- units / units_in / units_out is service-specific:
--   openai      → units_in = prompt_tokens, units_out = completion_tokens,
--                 units = prompt_tokens + completion_tokens
--   scrapingdog → units_in = 0, units_out = 0, units = credits spent (5 per call)
--   firecrawl   → units = credits spent (1 per page scraped)
--   apollo      → units = calls (1 per enrich or search)
--   apify       → units_in = profile scrapes, units_out = post scrapes,
--                 units = sum

CREATE TABLE IF NOT EXISTS api_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    service text NOT NULL,                 -- 'openai' | 'scrapingdog' | 'firecrawl' | 'apollo' | 'apify'
    operation text,                        -- 'classify' | 'email_gen' | 'maps_search' | 'enrich' | 'profile_scrape' | etc.
    model text,                            -- OpenAI model id; null for non-LLM services
    units_in integer NOT NULL DEFAULT 0,
    units_out integer NOT NULL DEFAULT 0,
    units integer NOT NULL DEFAULT 0,
    usd_cost numeric(12, 8) NOT NULL DEFAULT 0,
    duration_ms integer,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS api_usage_created_at_idx ON api_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_service_idx ON api_usage (service);
CREATE INDEX IF NOT EXISTS api_usage_model_idx ON api_usage (model);