-- User-action activity log. One row per operator action (ICP edit, sweep
-- resume, reclassify run, email gen, etc.). Distinct from the existing
-- `activity_events` table which captures sweep-pipeline events (per-cell,
-- per-company). This table is for "what did the operator do" - the audit
-- trail surfaced on the new /activity page.
--
-- Mirrors the shape valsource uses (user_id, action, details jsonb,
-- created_at). Bluebird has no user auth so user_id is always 'operator'
-- today; keeping the column lets us light up multi-user later without a
-- schema change.

CREATE TABLE IF NOT EXISTS user_activity (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL,
    action     text NOT NULL,
    details    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Frequent access pattern: "show me the last N days, newest first".
-- Index on created_at DESC keeps the activity page fast as the table grows.
CREATE INDEX IF NOT EXISTS user_activity_created_at_idx
    ON user_activity (created_at DESC);

-- Optional per-action filter (icp_updated, sweep_resumed, etc.) - the
-- activity page lets the user toggle by action, so an index here helps
-- the per-chip filter query stay snappy.
CREATE INDEX IF NOT EXISTS user_activity_action_idx
    ON user_activity (action);