-- Per-city search-term overrides. Lets a multi-country ICP carry a single
-- outlier city (e.g. NL + UK ticked + Berlin in cities) and run city-specific
-- language-correct terms for that one cell - without ticking the whole country
-- (which would also trigger Tier-2 country-fill).
--
-- Shape: { "Berlin": ["Gartencenter", "Pflanzenmarkt"], "Lisbon": ["centro de jardinagem"] }
-- Keys are city names (case-insensitive match against cell.parentCity at sweep time).
--
-- Precedence at sweep time (see api/utils/icps.js#pickTermsForCell):
--   1. cityTerms[parentCity]               - per-city override wins
--   2. searchTermsByCountry[cellCountry]   - per-country bucket (only when country is ticked)
--   3. searchTerms (flat fallback)         - only when cellCountry is ticked or no countries set
--   4. skip                                 - outlier cell with no override → no Scrapingdog call

ALTER TABLE icps ADD COLUMN IF NOT EXISTS city_terms jsonb DEFAULT NULL;