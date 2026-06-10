-- Upgrade existing email_templates rows so the systemPrompt prefers
-- LinkedIn signals as PRIMARY personalization (was hardcoded to "open
-- from their site" which made the model ignore rich LI signals even when
-- they were present).
--
-- The runtime reads from this table at startup via hydrateFromSupabase()
-- in api/utils/email-templates.js - so without this UPDATE, only fresh
-- installs (DEFAULT_TEMPLATES seed) would carry the new wording. Existing
-- rows in the Supabase DB would stay on the old "open from site" rule.
--
-- Two narrow REPLACEs, scoped to the channel='email' rows (LI templates
-- are already LI-focused by definition and don't have the site-opener
-- rule). Idempotent: re-running is a no-op once the old strings are
-- gone. Wrapped in a transaction so a partial application doesn't leave
-- the table half-upgraded.
--
-- Companion changes in code:
--   - api/data/email-templates.json (JSON seed fallback)
--   - api/utils/email-templates.js DEFAULT_TEMPLATES (fresh-install seed)
--   - api/prompts/email.js LINKEDIN_UNIVERSAL_RULES + buildLinkedInBlock
--   - web/src/pages/templates.tsx mirror constant

BEGIN;

-- Rule 1: opener now prefers LinkedIn when available.
UPDATE email_templates
SET system_prompt = REPLACE(
    system_prompt,
    '1. One-line opener referencing something concrete from their site (a city, a product detail, the booking/checkout flow).',
    '1. One-line opener referencing ONE specific detail about the recipient. When LinkedIn data is provided in the user message, prefer it (a recent post topic, current role detail, prior tenure at a notable employer in the same vertical). When LI is not available, fall back to something concrete from their site (a city, a product detail, the booking/checkout flow).'
)
WHERE channel = 'email'
  AND system_prompt LIKE '%opener referencing something concrete from their site%';

-- Rule 2: "never invent facts" widens to allow LinkedIn as a valid source
-- (otherwise the model would hesitate to cite LI content that doesn't
-- appear on the website).
UPDATE email_templates
SET system_prompt = REPLACE(
    system_prompt,
    '- Never invent facts the page doesn''t support.',
    '- Never invent facts. Every claim must be grounded in the website signals, the LinkedIn profile/posts, or the company snapshot provided below.'
)
WHERE channel = 'email'
  AND system_prompt LIKE '%Never invent facts the page%';

COMMIT;
