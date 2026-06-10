-- Persisted sweep session tracking.
--
-- One row per "Resume sweeping" click. Survives server restarts so the
-- operator can see what was happening last time even after a crash, and
-- so the Coverage page can render a "Recent sessions" panel with real
-- totals (not just the ephemeral in-memory ones the Socket.IO feed
-- already shows).
--
-- Lifecycle:
--   started_at, status='running'  - row inserted when resetBudget() fires
--   counters updated per tick     - cells_attempted/succeeded/errored,
--                                   places_found, leads_qualified
--   ended_at, status=...          - row finalized on pause/completion/crash
--
-- pause_reason values:
--   'manual'      - operator clicked Pause
--   'budget'      - per-ICP BUDGET cap was reached on every active ICP
--   'no_work'     - no pending cells remained in scope
--   'crashed'     - server died with the session still 'running'
--                   (reconciled on next boot by markCrashedSessions())

CREATE TABLE IF NOT EXISTS sweep_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    icp_id text,                              -- null when scope was 'all'
    scope_type text,                          -- 'city' | 'country' | 'all'
    scope_value text,                         -- e.g. 'Manchester', 'UK'; null when scope_type='all'
    cells_attempted integer NOT NULL DEFAULT 0,
    cells_succeeded integer NOT NULL DEFAULT 0,
    cells_errored integer NOT NULL DEFAULT 0,
    places_found integer NOT NULL DEFAULT 0,
    leads_qualified integer NOT NULL DEFAULT 0,
    already_known integer NOT NULL DEFAULT 0,
    chains_filtered integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'running',   -- 'running' | 'paused' | 'completed' | 'crashed'
    pause_reason text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sweep_sessions_started_at_idx ON sweep_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS sweep_sessions_status_idx ON sweep_sessions (status);
CREATE INDEX IF NOT EXISTS sweep_sessions_icp_idx ON sweep_sessions (icp_id, started_at DESC);
