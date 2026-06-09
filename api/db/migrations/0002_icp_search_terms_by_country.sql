-- Per-country search-terms support on ICPs.
--
-- Previously every searchTerm ran on every cell, so a Dutch ICP targeting
-- NL+UK would fire "tuincentrum" against UK Maps (Dutch term, English
-- market - wasted Scrapingdog credits, polluted candidate pool) and
-- "garden centre" against NL Maps (English term, Dutch market - same
-- problem in reverse).
--
-- New column lets an ICP specify a different term list per country.
-- Shape: { "NL": ["tuincentrum", "plantenkwekerij"], "UK": ["garden centre"], ... }
-- The sweep falls back to the existing flat `search_terms` array when this
-- column is null OR the cell's country has no entry, so legacy ICPs keep
-- working unchanged.
--
-- Safe to re-run.

ALTER TABLE icps
  ADD COLUMN IF NOT EXISTS search_terms_by_country jsonb DEFAULT NULL;