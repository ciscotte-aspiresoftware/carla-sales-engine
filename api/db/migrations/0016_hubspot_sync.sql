-- HubSpot sync state on companies + leads.
--
-- The /api/hubspot push route is one-way (Atlas → HubSpot) and idempotent:
-- companies dedupe by domain, contacts by email. To make a re-push UPDATE the
-- existing HubSpot record (rather than create a duplicate) we persist the
-- HubSpot object id and the last sync time back onto the Atlas record.
--
-- In the default JSON-file mode these live as company.hubspotId /
-- company.hubspotSyncedAt and lead.hubspotId / lead.hubspotSyncedAt. This
-- migration adds the matching columns for when USE_SUPABASE=true. Inert until
-- then; safe to run on an existing database (additive, nullable, IF NOT EXISTS).
--
--   hubspot_id        - HubSpot company/contact object id (text; null until first push)
--   hubspot_synced_at - timestamp of the last successful push; the note-staleness
--                       check re-creates the company Note only when the
--                       classification is newer than this.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS hubspot_synced_at timestamptz;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS hubspot_id text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hubspot_synced_at timestamptz;

-- Look up a company by its HubSpot id (e.g. reconciling a webhook later).
CREATE INDEX IF NOT EXISTS companies_hubspot_id_idx ON companies (hubspot_id);
CREATE INDEX IF NOT EXISTS leads_hubspot_id_idx ON leads (hubspot_id);
