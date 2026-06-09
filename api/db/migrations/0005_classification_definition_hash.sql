-- Stamp each per-ICP classification with the hash of the ICP's classifier
-- definition (api/utils/icps.js#computeIcpDefinitionHash) at the moment the
-- verdict was written. Lets the Reclassify tab tell "this verdict was made
-- under the current ICP definition" vs "the ICP has been edited since this
-- was classified - it's stale".
--
-- Survives editor close/reopen, page reload, multiple users, multiple
-- sessions - which the client-side baseline-snapshot approach didn't.
--
-- NULL on existing rows is treated as "stale" by the targets endpoint, so
-- the first time the user opens Reclassify after this migration they'll see
-- every prior classification flagged for re-run. Intentional: once they
-- reclassify those rows, the hash gets stamped and they're fresh from then on.

ALTER TABLE company_classifications
    ADD COLUMN IF NOT EXISTS definition_hash text DEFAULT NULL;