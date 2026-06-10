-- Persisted reclassify-job tracking.
--
-- Until this migration, POST /api/icps/:id/reclassify ran the entire
-- classification loop INSIDE the HTTP request: a tight `for` over every
-- selected domain, each awaiting a GPT call. Wall time scaled linearly
-- with target count (~3s/domain on gpt-4o-mini), the request thread held
-- the connection open for minutes, any server restart silently dropped
-- in-flight work, and there was no rate-limit guard for thousands of
-- domains across multiple ICPs.
--
-- The new design enqueues the click as a row here. A background worker
-- (utils/reclassify-worker.js, ticked every second) pulls the oldest
-- non-terminal job, claims the next batch of pending result rows, and
-- runs them concurrently up to a small in-flight cap. Counters live on
-- the job row so progress survives crashes; per-domain outcomes live on
-- reclassify_results (migration 0015) so a resume picks up exactly where
-- it left off.
--
-- Lifecycle:
--   pending    - row created by POST /reclassify; not yet picked up
--   running    - worker has started processing pending result rows
--   paused     - reserved for future explicit-pause; same as pending for resume
--   cancelled  - operator hit Cancel; worker stops on next tick boundary
--   completed  - every result row reached a terminal status (classified|skipped|errored)
--   crashed    - boot reconciliation flipped a stale 'running' row here
--
-- Counters are denormalized for cheap progress display: the worker
-- updates them as it finalizes each result row instead of forcing the
-- UI to COUNT(*) results on every poll.

CREATE TABLE IF NOT EXISTS reclassify_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    icp_id text NOT NULL REFERENCES icps(id) ON DELETE CASCADE,
    -- 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'crashed'
    status text NOT NULL DEFAULT 'pending',
    -- Operator-supplied flags echoed back for the recent-jobs panel:
    force boolean NOT NULL DEFAULT false,           -- re-run already-classified rows
    cancel_requested boolean NOT NULL DEFAULT false,
    -- Counters (updated as result rows finalize). total = COUNT(*) results.
    total integer NOT NULL DEFAULT 0,
    processed integer NOT NULL DEFAULT 0,           -- classified + skipped + errored
    qualified integer NOT NULL DEFAULT 0,
    rejected integer NOT NULL DEFAULT 0,
    skipped integer NOT NULL DEFAULT 0,
    flipped integer NOT NULL DEFAULT 0,             -- verdict changed vs old classification
    errors integer NOT NULL DEFAULT 0,
    -- Last domain the worker started classifying. Used by the UI to
    -- render "running: example.com" while a tick is in flight.
    current_domain text,
    -- Captures the LAST fatal/non-recoverable error so the recent-jobs
    -- panel can show why a job ended up 'crashed' without joining results.
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,                         -- set when worker first picks it up
    finished_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS reclassify_jobs_status_idx ON reclassify_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS reclassify_jobs_icp_idx ON reclassify_jobs (icp_id, created_at DESC);
