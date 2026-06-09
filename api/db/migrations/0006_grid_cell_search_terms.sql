-- Stamp each grid cell with the search-term list that was actually run on
-- it at sweep time. Lets Coverage tell "this cell ran terms A+B, but the
-- ICP's definition has since added term C - cell is stale, rescan with
-- search_log dedup so only C hits Scrapingdog".
--
-- NULL on legacy cells (pre-migration) - treated as "unknown, assume needs
-- rescan if any new terms appear in the ICP's current definition". The
-- first complete sweep after this migration stamps the column and the
-- staleness check stops being noisy.
--
-- Term REMOVALS don't trigger staleness (user's existing data still valid,
-- just not re-discoverable). Only ADDITIONS do - matches the user-facing
-- "we only run the new terms on the done cells" expectation.

ALTER TABLE grid_cells
    ADD COLUMN IF NOT EXISTS search_terms text[] DEFAULT NULL;