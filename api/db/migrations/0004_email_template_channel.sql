-- Channel field for outreach templates. Lets the same template store split
-- into Email vs LinkedIn variants per (portfolioCompany × ICP) so the LI
-- message generator picks an LI-tuned prompt instead of the email one.
--
-- Existing rows are backfilled as 'email' (the only channel before this
-- migration). The /api/li-message route reads where channel='linkedin';
-- /api/email reads where channel='email' (default if not specified).
--
-- Constraint kept loose ('email' | 'linkedin') so a future SMS / WhatsApp
-- channel can be added without a follow-up migration.

ALTER TABLE email_templates
    ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

UPDATE email_templates SET channel = 'email' WHERE channel IS NULL;