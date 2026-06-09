-- Per-cell checkpoint so a mid-sweep pause can resume from the same company
-- it stopped on instead of restarting the whole cell.
--
-- Shape (json):
--   {
--     "stage": "companies",
--     "survivors": [ { ...place... }, ... ],  // fresh list at last pause
--     "nextIdx": 4,                            // 0-based index to resume from
--     "cumulative": {
--       "placesFound": N, "leadsQualified": N, "chainsFiltered": N,
--       "nonTargetFiltered": N, "alreadyKnown": N, "touchedDomains": [...]
--     },
--     "pausedAt": 1780622400000                // epoch ms
--   }
--
-- Cell `state` stays as 'pending' when paused (no enum-constraint change),
-- and the presence of a checkpoint is what sweepCell uses to decide
-- "resume from inside" vs "fresh sweep". NULL on completion / non-paused.

ALTER TABLE grid_cells
    ADD COLUMN IF NOT EXISTS pause_checkpoint jsonb DEFAULT NULL;