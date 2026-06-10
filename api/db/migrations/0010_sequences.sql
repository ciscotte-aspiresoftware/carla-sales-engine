-- Email sequences (multi-step outreach drafts).
--
-- The data model splits the immutable PLAN (template + ordered steps) from
-- the mutable per-recipient RUN (the actual generated emails for one
-- prospect). Reps pick a template, kick off a run for {company, lead},
-- and the backend pre-fills all N steps with generated drafts they can
-- edit before exporting.
--
-- v1 generates emails only. Delivery is out of scope - reps copy the
-- drafts into their existing sender (Lemlist / Smartlead / Outlook / etc).
--
-- Tables:
--   sequence_templates           - reusable plans (e.g. "Bluebird 4-step EN")
--   sequence_template_steps      - ordered steps for a template
--   sequence_runs                - one per recipient per kick-off
--   sequence_run_steps           - generated subject+body per run step
--
-- Why split run_steps from template_steps: the template is the plan
-- (purpose, cadence, length), the run is the realised output (the actual
-- emails). Reps edit run_steps content freely; template structure stays
-- locked so spend across recipients stays comparable.

CREATE TABLE IF NOT EXISTS sequence_templates (
    id text PRIMARY KEY,
    name text NOT NULL,
    icp_id text,                            -- optional: scope to one ICP for default-suggestion
    portfolio_company text,                 -- e.g. "Bluebird Auto Rental Systems"
    sender_template_id text,                -- references email_templates.id
    language text NOT NULL DEFAULT 'English',
    description text,                       -- short blurb shown in the picker
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_template_steps (
    template_id text NOT NULL REFERENCES sequence_templates(id) ON DELETE CASCADE,
    order_idx integer NOT NULL,             -- 0, 1, 2, ... (0 = first email)
    purpose text NOT NULL,                  -- 'intro' | 'value' | 'social_proof' | 'follow_up' | 'breakup'
    days_after_prev integer NOT NULL DEFAULT 0,  -- 0 for the first step; days from previous for others
    length_hint text NOT NULL DEFAULT 'medium',  -- 'long' | 'medium' | 'short'
    custom_guidance text,                   -- optional: per-step prompt override the template author writes
    PRIMARY KEY (template_id, order_idx)
);

CREATE TABLE IF NOT EXISTS sequence_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id text NOT NULL REFERENCES sequence_templates(id) ON DELETE RESTRICT,
    company_id text NOT NULL,               -- companies.json id (or supabase companies.id)
    lead_apollo_id text,                    -- apolloId of the recipient lead (null for paste-only flows)
    icp_id text,                            -- snapshot of which ICP this run was authored under
    custom_instruction text,                -- rep's per-run steering ("mention their recent expansion")
    status text NOT NULL DEFAULT 'draft',   -- 'draft' | 'approved' | 'exported'
    -- Frozen snapshot of the company + lead context at run creation time.
    -- Stored so a rep can regenerate a step a week later without us having
    -- to re-fetch the company (and risk picking up newer info that would
    -- make the regenerated step inconsistent with the earlier ones). Shape:
    --   { company: { name, domain, vertical, country, classification, report },
    --     lead: { firstName, lastName, title, email, linkedinUrl,
    --             liSummary, liPosts, apolloId } }
    context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sequence_run_steps (
    run_id uuid NOT NULL REFERENCES sequence_runs(id) ON DELETE CASCADE,
    order_idx integer NOT NULL,
    subject text,
    body text,
    model_used text,                        -- which OpenAI model produced this draft
    purpose text NOT NULL,                  -- duplicated from template_step for query convenience
    days_after_prev integer NOT NULL DEFAULT 0,
    edited_by_user boolean NOT NULL DEFAULT false,  -- true once a human has touched the body
    generated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, order_idx)
);

CREATE INDEX IF NOT EXISTS sequence_runs_company_idx ON sequence_runs (company_id);
CREATE INDEX IF NOT EXISTS sequence_runs_template_idx ON sequence_runs (template_id);
CREATE INDEX IF NOT EXISTS sequence_runs_created_at_idx ON sequence_runs (created_at DESC);