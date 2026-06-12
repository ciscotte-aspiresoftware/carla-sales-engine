-- Per-ICP "auto-associate leads" toggle.
--
-- When ON, the sweep pipeline cross-references Apollo (search-only) for people
-- at every company the AI classifier marks is_match=true: people found are
-- attached as leads so the Accounts "pending" lane arrives pre-populated with
-- named contacts; companies with no Apollo people are auto-rejected for that ICP
-- (they stay in the database, in the Rejected lane).
--
-- In the default JSON-file mode this lives as icp.autoAssociateLeads. This
-- migration adds the matching column for when USE_SUPABASE=true. Inert until
-- then; safe to run on an existing database (additive, defaulted, IF NOT EXISTS).
-- Reads are safe before this runs (column-missing → undefined → coerced false);
-- icpObjToRow only writes the column when the toggle is actually enabled.

ALTER TABLE icps ADD COLUMN IF NOT EXISTS auto_associate_leads boolean NOT NULL DEFAULT false;
