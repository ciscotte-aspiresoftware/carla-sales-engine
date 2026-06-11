// /api/sequences/* - multi-step outreach sequence templates + runs.
//
// Templates are the PLAN (4 steps, intro/value/social/breakup, days
// 0/3/7/14). Runs are the OUTPUT (the actual generated emails for one
// recipient against one template).
//
// Endpoints:
//   GET    /templates                 - list templates (optional ?icpId, ?portfolioCompany)
//   GET    /templates/:id             - single template
//   POST   /templates                 - create
//   PUT    /templates/:id             - update (steps replaced wholesale)
//   DELETE /templates/:id             - delete (fails if any run uses it)
//
//   GET    /runs                      - list runs (optional ?companyId, ?templateId)
//   GET    /runs/:id                  - single run with all steps
//   POST   /runs                      - create + generate all steps
//                                       Body: { templateId, companyId, leadApolloId?,
//                                               icpId?, customInstruction?,
//                                               context: { company, lead } }
//   POST   /runs/:id/regenerate/:idx  - regenerate one step using the run's
//                                       stored context snapshot
//   PUT    /runs/:id/steps/:idx       - manually edit a step's subject/body
//   PUT    /runs/:id/status           - { status: 'draft'|'approved'|'exported' }
//   DELETE /runs/:id                  - delete a run

const express = require('express');
const seq = require('../utils/sequences');
const { buildSequenceStepPrompt } = require('../prompts/sequence-email');
const { chat } = require('../utils/openai');
const { getAi } = require('../utils/settings');
const { getTemplate: getEmailTemplate } = require('../utils/email-templates');
const { trackActivity } = require('../middleware/activity');
const { isEnabled: dbEnabled, getClient: getDb } = require('../db');

// Refresh lead enrichment fields (liSummary, liPosts, linkedinUrl, email,
// enriched, phone, etc.) from the live leads table at generate time.
// The contextSnapshot stored on a sequence_run is a point-in-time copy of
// whatever the frontend had at create time - if the rep created the run
// before they revealed the lead through Sales Agent, or if Sales Agent's
// LinkedIn scrape only landed AFTER the snapshot was taken, the snapshot
// is missing exactly the data the LI-PRIMARY prompt needs to ground on.
// Re-reading from `leads` here mirrors the same flow /api/email uses and
// keeps the prompt synced with the most recent scrape.
async function refreshLeadFromDb(snapshotLead, companyId) {
    if (!dbEnabled() || !companyId || !snapshotLead || !snapshotLead.apolloId) return snapshotLead;
    try {
        const { data, error } = await getDb()
            .from('leads')
            .select('*')
            .eq('company_id', companyId)
            .eq('apollo_id', snapshotLead.apolloId)
            .maybeSingle();
        if (error || !data) return snapshotLead;
        return {
            ...snapshotLead,
            firstName: data.first_name || snapshotLead.firstName,
            lastName: data.last_name || snapshotLead.lastName,
            title: data.title || snapshotLead.title,
            email: data.email || snapshotLead.email,
            linkedinUrl: data.linkedin_url || snapshotLead.linkedinUrl,
            phone: data.phone || snapshotLead.phone,
            enriched: !!data.enriched,
            liSummary: data.li_summary || snapshotLead.liSummary || null,
            liPosts: Array.isArray(data.li_posts) ? data.li_posts : (snapshotLead.liPosts || []),
            liScrapedAt: data.li_scraped_at ? new Date(data.li_scraped_at).getTime() : snapshotLead.liScrapedAt,
        };
    } catch (e) {
        console.warn(`[Sequences] live-lead refresh failed (using snapshot): ${e.message}`);
        return snapshotLead;
    }
}

const router = express.Router();

// ─── Templates ─────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
    try {
        const items = await seq.listTemplates({
            portfolioCompany: req.query.portfolioCompany || null,
            icpId: req.query.icpId || null,
        });
        res.json({ success: true, templates: items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/templates/:id', async (req, res) => {
    try {
        const t = await seq.getTemplate(req.params.id);
        if (!t) return res.status(404).json({ success: false, error: 'not found' });
        res.json({ success: true, template: t });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/templates', trackActivity('sequence_template_created'), async (req, res) => {
    try {
        const t = await seq.createTemplate(req.body || {});
        console.log(`[Sequences] ✓ TEMPLATE CREATE id="${t.id}" name="${t.name}" steps=${t.steps.length}`);
        res.json({ success: true, template: t });
    } catch (err) {
        console.warn(`[Sequences] ✗ TEMPLATE CREATE failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/templates/:id', trackActivity('sequence_template_updated'), async (req, res) => {
    try {
        const t = await seq.updateTemplate(req.params.id, req.body || {});
        if (!t) return res.status(404).json({ success: false, error: 'not found' });
        console.log(`[Sequences] ✓ TEMPLATE UPDATE id="${t.id}" steps=${t.steps.length}`);
        res.json({ success: true, template: t });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/templates/:id', trackActivity('sequence_template_deleted'), async (req, res) => {
    try {
        await seq.deleteTemplate(req.params.id);
        res.json({ success: true });
    } catch (err) {
        // ON DELETE RESTRICT will land here with a foreign-key error when
        // a run references this template - bubble the message verbatim so
        // the UI can show "this template is in use" rather than a generic 500.
        res.status(400).json({ success: false, error: err.message });
    }
});

// ─── Runs ──────────────────────────────────────────────────────────────

router.get('/runs', async (req, res) => {
    try {
        const items = await seq.listRuns({
            companyId: req.query.companyId || null,
            templateId: req.query.templateId || null,
            limit: parseInt(req.query.limit, 10) || 100,
        });
        res.json({ success: true, runs: items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/runs/:id', async (req, res) => {
    try {
        const r = await seq.getRun(req.params.id);
        if (!r) return res.status(404).json({ success: false, error: 'not found' });
        res.json({ success: true, run: r });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Internal helper - generates all empty steps of an existing run by
// looping the prompt builder with prior-step context. Shared between
// POST /runs (sync gen on create) and POST /runs/:id/generate-all
// (deferred gen for bulk-created shells). Per-step GPT calls run
// SEQUENTIALLY because step N needs step N-1's body as context.
async function generateAllStepsForRun(runId) {
    const run = await seq.getRun(runId);
    if (!run) throw new Error(`run "${runId}" not found`);
    const template = await seq.getTemplate(run.templateId);
    if (!template) throw new Error(`template "${run.templateId}" not found`);

    const senderTpl = template.senderTemplateId
        ? await getEmailTemplate(template.senderTemplateId)
        : null;
    const sender = senderTpl?.sender || {
        firstName: 'Sender', lastName: '', title: 'Sales', company: '', signoff: 'Best,',
    };
    const ctx = run.contextSnapshot || {};
    const company = ctx.company || {};
    const snapshotLead = ctx.lead || {};
    const lead = await refreshLeadFromDb(snapshotLead, run.companyId || company.id);

    const startedAt = Date.now();
    const liTag = lead && (lead.liSummary || (Array.isArray(lead.liPosts) && lead.liPosts.length))
        ? `LI=${lead.liSummary ? 'profile' : ''}${lead.liSummary && lead.liPosts?.length ? '+' : ''}${Array.isArray(lead.liPosts) && lead.liPosts.length ? `${lead.liPosts.length}posts` : ''}`
        : 'LI=none';
    console.log(`[Sequences] ▶ RUN GENERATE id=${runId} steps=${template.steps.length} recipient="${lead.firstName || ''} ${lead.lastName || ''}" ${liTag}`);

    const priorSteps = [];
    for (let i = 0; i < template.steps.length; i++) {
        const stepCfg = {
            orderIdx: i,
            totalSteps: template.steps.length,
            purpose: template.steps[i].purpose,
            daysAfterPrev: template.steps[i].daysAfterPrev,
            lengthHint: template.steps[i].lengthHint,
            customGuidance: template.steps[i].customGuidance,
        };
        const messages = buildSequenceStepPrompt({
            sender,
            template: senderTpl,
            company,
            companyReport: company.report || null,
            lead,
            stepConfig: stepCfg,
            priorSteps,
            customInstruction: run.customInstruction,
        });
        const raw = await chat(messages, {
            task: 'email',
            temperature: 0.6,
            response_format: { type: 'json_object' },
            operation: `sequence_step_${stepCfg.purpose}`,
        });
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { parsed = { subject: '(parse failed)', body: raw.slice(0, 600) }; }
        // Strip em dashes the model may emit despite the prompt - never
        // wanted in outbound copy. Matches the email-gen route's policy.
        if (parsed.subject) parsed.subject = String(parsed.subject).replace(/—/g, '-');
        if (parsed.body) parsed.body = String(parsed.body).replace(/—/g, '-');

        await seq.updateRunStep(runId, i, {
            subject: parsed.subject || '',
            body: parsed.body || '',
            modelUsed: model,
            editedByUser: false,
        });
        priorSteps.push({
            orderIdx: i,
            purpose: stepCfg.purpose,
            daysAfterPrev: stepCfg.daysAfterPrev,
            subject: parsed.subject || '',
            body: parsed.body || '',
        });
    }
    console.log(`[Sequences] ✓ RUN GENERATE ${Date.now() - startedAt}ms total | ${template.steps.length} steps drafted`);
    return await seq.getRun(runId);
}

// Create a run. Body:
//   { templateId, companyId, leadApolloId?, icpId?, customInstruction?,
//     context: { company, lead },
//     generate?: boolean (default true) }
//
// generate=true (default, single-recipient path): synchronously calls
// GPT for every step. Returns the fully-generated run. Wall time = ~4-6s
// per step on gpt-4o-mini, so 15-30s total for a 4-step template.
//
// generate=false (bulk path): just creates the run shell + empty step
// placeholders, returns immediately. The rep triggers generation later
// via POST /runs/:id/generate-all when they actually need it. Keeps
// bulk-create operations cheap (no GPT spend) so a "select 50 companies"
// flow doesn't blow $5 of OpenAI in one click.
router.post('/runs', trackActivity('sequence_run_created'), async (req, res) => {
    const { templateId, companyId, leadApolloId, icpId, customInstruction, context, generate = true } = req.body || {};
    // context.lead is optional - when null, the prompt builder falls back
    // to a generic "Hello," greeting and skips the LinkedIn signals
    // block, leaning entirely on the company report + scraped contacts.
    // Useful for first-touch outbound on companies where Sales Agent
    // hasn't run yet (no Apollo leads attached).
    if (!templateId || !companyId || !context?.company) {
        return res.status(400).json({ success: false, error: 'templateId, companyId, context.company are required' });
    }

    try {
        const run = await seq.createRun({
            templateId, companyId, leadApolloId, icpId, customInstruction,
            contextSnapshot: { company: context.company, lead: context.lead || null },
        });

        if (!generate) {
            // Bulk-create path: return the shell immediately, defer gen.
            return res.json({ success: true, run, generated: false });
        }

        const final = await generateAllStepsForRun(run.id);
        res.json({ success: true, run: final, generated: true });
    } catch (err) {
        console.error(`[Sequences] ✗ RUN CREATE/GENERATE failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Generate (or re-generate) every step on an existing run. Used when:
//   - The run was bulk-created with generate=false and the rep is now
//     opening it for the first time.
//   - The rep wants to wipe + redo all steps in one go (rare).
// trackActivity tags this so the Activity Log distinguishes a bulk-shell
// hydration from a single-recipient initial create.
router.post('/runs/:id/generate-all', trackActivity('sequence_run_generated'), async (req, res) => {
    try {
        const final = await generateAllStepsForRun(req.params.id);
        res.json({ success: true, run: final });
    } catch (err) {
        console.error(`[Sequences] ✗ GENERATE-ALL failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Regenerate one step using the run's stored snapshot. Prior step bodies
// (the ones that come before this one) are passed as context; later steps
// stay untouched (the rep can re-trigger them too if needed).
router.post('/runs/:id/regenerate/:idx', trackActivity('sequence_step_regenerated'), async (req, res) => {
    try {
        const run = await seq.getRun(req.params.id);
        if (!run) return res.status(404).json({ success: false, error: 'run not found' });
        const idx = parseInt(req.params.idx, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= run.steps.length) {
            return res.status(400).json({ success: false, error: 'invalid step index' });
        }
        const template = await seq.getTemplate(run.templateId);
        if (!template) return res.status(400).json({ success: false, error: 'template gone' });
        const senderTpl = template.senderTemplateId ? await getEmailTemplate(template.senderTemplateId) : null;
        const sender = senderTpl?.sender || {
            firstName: 'Sender', lastName: '', title: 'Sales', company: '', signoff: 'Best,',
        };

        const ctx = run.contextSnapshot || {};
        // Optional per-regen overrides from the request body (custom
        // instruction tweak, length hint override) - lets the rep "make
        // this one shorter" without editing the template.
        const overrideInstruction = (req.body && req.body.customInstruction) || run.customInstruction || null;
        const overrideLength = (req.body && req.body.lengthHint) || template.steps[idx].lengthHint;

        const priorSteps = run.steps.slice(0, idx).map((s) => ({
            orderIdx: s.orderIdx,
            purpose: s.purpose,
            daysAfterPrev: s.daysAfterPrev,
            subject: s.subject || '',
            body: s.body || '',
        }));

        const stepCfg = {
            orderIdx: idx,
            totalSteps: run.steps.length,
            purpose: template.steps[idx].purpose,
            daysAfterPrev: template.steps[idx].daysAfterPrev,
            lengthHint: overrideLength,
            customGuidance: template.steps[idx].customGuidance,
        };
        // Refresh lead from the live leads table - the snapshot may have
        // been taken before LI scraping ran on this lead, in which case
        // liSummary/liPosts would have been missing from the prompt and
        // the model would have nothing personalized to anchor on.
        const liveLead = await refreshLeadFromDb(ctx.lead || {}, run.companyId || ctx.company?.id);
        const messages = buildSequenceStepPrompt({
            sender,
            template: senderTpl,
            company: ctx.company || {},
            companyReport: ctx.company?.report || null,
            lead: liveLead,
            stepConfig: stepCfg,
            priorSteps,
            customInstruction: overrideInstruction,
        });
        const raw = await chat(messages, {
            task: 'email',
            temperature: 0.6,
            response_format: { type: 'json_object' },
            operation: `sequence_step_${stepCfg.purpose}_regen`,
        });
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { parsed = { subject: '(parse failed)', body: raw.slice(0, 600) }; }
        if (parsed.subject) parsed.subject = String(parsed.subject).replace(/—/g, '-');
        if (parsed.body) parsed.body = String(parsed.body).replace(/—/g, '-');

        await seq.updateRunStep(run.id, idx, {
            subject: parsed.subject || '',
            body: parsed.body || '',
            modelUsed: model,
            editedByUser: false,
        });
        const updated = await seq.getRun(run.id);
        res.json({ success: true, run: updated });
    } catch (err) {
        console.error(`[Sequences] ✗ REGENERATE failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Manual edit of a single step. Keeps generated_at, model_used as-is but
// flips edited_by_user so the UI can show an "edited" marker.
router.put('/runs/:id/steps/:idx', trackActivity('sequence_step_edited'), async (req, res) => {
    try {
        const idx = parseInt(req.params.idx, 10);
        const { subject, body } = req.body || {};
        await seq.updateRunStep(req.params.id, idx, {
            subject: subject === undefined ? undefined : String(subject),
            body: body === undefined ? undefined : String(body),
            editedByUser: true,
        });
        const updated = await seq.getRun(req.params.id);
        res.json({ success: true, run: updated });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/runs/:id/status', trackActivity('sequence_run_status_changed'), async (req, res) => {
    try {
        const { status } = req.body || {};
        await seq.updateRunStatus(req.params.id, status);
        const updated = await seq.getRun(req.params.id);
        res.json({ success: true, run: updated });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/runs/:id', trackActivity('sequence_run_deleted'), async (req, res) => {
    try {
        await seq.deleteRun(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

module.exports = router;
