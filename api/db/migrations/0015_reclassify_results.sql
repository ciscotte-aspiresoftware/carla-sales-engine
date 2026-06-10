-- Per-domain outcomes for a reclassify_jobs row.
--
-- One row per (job, domain) pair. Inserted UP-FRONT when the job is
-- enqueued so the worker can simply query for status='pending' rows and
-- claim them - no separate "plan" step, no temporal coupling between the
-- enqueue path and the worker tick. Order is preserved via order_idx so
-- the recent-jobs panel can render the work-list deterministically.
--
-- Status state machine:
--   pending    - waiting for the worker to pick it up
--   in_flight  - claimed by the worker; GPT call in progress
--   classified - GPT returned a verdict; new_is_match / reason populated
--   skipped    - no cached scrape, or force=false and already classified
--   errored    - GPT call threw / returned non-JSON; error_message set
--   cancelled  - job-level cancel hit before this row was claimed
--
-- Persists the BEFORE-state (old_is_match / old_reason) so the UI can
-- render "flipped" rows without joining company_classifications, and so
-- a job survives a stale snapshot of the underlying company row.
--
-- Index choices:
--   (job_id, status, order_idx) - the worker's hot query: "next pending row in this job"
--   (job_id, order_idx)         - render the job's full work-list in order
--   (job_id, status)            - counter recompute on resume / reconciliation

CREATE TABLE IF NOT EXISTS reclassify_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES reclassify_jobs(id) ON DELETE CASCADE,
    order_idx integer NOT NULL,                     -- 0-based position in the job's input list
    domain text NOT NULL,
    company_name text,                              -- snapshotted at enqueue time for display
    city text,
    -- 'pending' | 'in_flight' | 'classified' | 'skipped' | 'errored' | 'cancelled'
    status text NOT NULL DEFAULT 'pending',
    -- BEFORE state (snapshotted at enqueue so the diff is stable across
    -- concurrent company edits).
    old_is_match boolean,
    old_reason text,
    -- AFTER state (filled in by the worker on a successful classify).
    new_is_match boolean,
    new_reason text,
    flipped boolean NOT NULL DEFAULT false,         -- true when old_is_match XOR new_is_match
    -- Operational metadata for the recent-jobs panel.
    model_used text,
    skip_reason text,                               -- 'no cached scrape' | 'already classified' | ...
    error_message text,
    attempted_at timestamptz,                       -- when status flipped pending → in_flight
    completed_at timestamptz,                       -- when status hit a terminal value
    UNIQUE (job_id, order_idx)
);

CREATE INDEX IF NOT EXISTS reclassify_results_worker_idx ON reclassify_results (job_id, status, order_idx);
CREATE INDEX IF NOT EXISTS reclassify_results_status_idx ON reclassify_results (job_id, status);
