-- Persisted per-cell sweep errors.
--
-- Recorded by the cron's catch block + the per-service wrappers. Lets the
-- operator see exactly which Scrapingdog / Firecrawl / OpenAI calls failed
-- inside a session without having to scrape Render logs. Surfaces on the
-- Coverage page as an "Errors this session: N" chip on each session row,
-- expandable to a per-error timeline.
--
-- error_type values:
--   'transient_5xx'      - 502/503/504 from an upstream service
--   'credit_exhausted'   - 402/credits-out from Apollo, Scrapingdog, etc.
--   'rate_limit'         - 429 / explicit "too many requests"
--   'permanent'          - 4xx that isn't credit/rate (auth issue,
--                          malformed request, account suspended)
--   'internal'           - error in Atlas's own code, not the upstream
--   'unknown'            - couldn't classify; check error_message
--
-- service values:
--   'scrapingdog' | 'firecrawl' | 'openai' | 'apollo' | 'apify' | 'internal'
--
-- recovered=true means a retry in the same call succeeded (logged for
-- visibility but not blocking). recovered=false means the cell ultimately
-- failed and went back to pending for the next tick.

CREATE TABLE IF NOT EXISTS sweep_errors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    session_id uuid REFERENCES sweep_sessions(id) ON DELETE CASCADE,
    cell_id uuid,                             -- soft FK; cell may be reset before error is reviewed
    icp_id text,
    error_type text,                          -- see header doc
    service text,                             -- see header doc
    error_message text,
    recovered boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sweep_errors_session_idx ON sweep_errors (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS sweep_errors_occurred_at_idx ON sweep_errors (occurred_at DESC);
CREATE INDEX IF NOT EXISTS sweep_errors_service_idx ON sweep_errors (service);
