// Sequence storage + run generation.
//
// Supabase-only for v1 - no JSON fallback. Sequences depend on referential
// integrity (template_id, run_id, company_id) and would be a mess to keep
// consistent in JSON files across server restarts. Run /api/db/migrations/
// 0010_sequences.sql before using anything in this file.
//
// Tables (see migration 0010 for full schema):
//   sequence_templates           - plan (name, icp, sender, language)
//   sequence_template_steps      - ordered steps (purpose, days_after_prev, length_hint)
//   sequence_runs                - per-recipient kick-off (template + company + lead)
//   sequence_run_steps           - generated subject+body per step

const { isEnabled, getClient } = require('../db');

function notEnabledError() {
    return new Error('Sequences require USE_SUPABASE=true. Run migration 0010_sequences.sql first.');
}

// ─── Templates ─────────────────────────────────────────────────────────

async function listTemplates({ portfolioCompany = null, icpId = null } = {}) {
    if (!isEnabled()) throw notEnabledError();
    let q = getClient().from('sequence_templates').select('*, sequence_template_steps(*)').order('updated_at', { ascending: false });
    if (portfolioCompany) q = q.eq('portfolio_company', portfolioCompany);
    if (icpId) q = q.eq('icp_id', icpId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data || []).map(rowToTemplate);
}

async function getTemplate(id) {
    if (!isEnabled()) throw notEnabledError();
    const { data, error } = await getClient()
        .from('sequence_templates')
        .select('*, sequence_template_steps(*)')
        .eq('id', id)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rowToTemplate(data) : null;
}

async function createTemplate(input) {
    if (!isEnabled()) throw notEnabledError();
    const tpl = normaliseTemplate(input);
    if (!tpl.id) throw new Error('template id required');
    if (!tpl.name) throw new Error('template name required');
    if (!Array.isArray(tpl.steps) || tpl.steps.length === 0) throw new Error('template needs at least one step');

    const now = new Date().toISOString();
    const { error: e1 } = await getClient().from('sequence_templates').insert({
        id: tpl.id,
        name: tpl.name,
        icp_id: tpl.icpId || null,
        portfolio_company: tpl.portfolioCompany || null,
        sender_template_id: tpl.senderTemplateId || null,
        language: tpl.language || 'English',
        description: tpl.description || null,
        created_at: now,
        updated_at: now,
    });
    if (e1) throw new Error(e1.message);

    const stepRows = tpl.steps.map((s, idx) => ({
        template_id: tpl.id,
        order_idx: idx,
        purpose: s.purpose,
        days_after_prev: s.daysAfterPrev || 0,
        length_hint: s.lengthHint || 'medium',
        custom_guidance: s.customGuidance || null,
    }));
    const { error: e2 } = await getClient().from('sequence_template_steps').insert(stepRows);
    if (e2) throw new Error(e2.message);

    return getTemplate(tpl.id);
}

async function updateTemplate(id, input) {
    if (!isEnabled()) throw notEnabledError();
    const tpl = normaliseTemplate({ ...input, id });
    if (!tpl.name) throw new Error('template name required');
    if (!Array.isArray(tpl.steps) || tpl.steps.length === 0) throw new Error('template needs at least one step');

    const { data: existing, error: eExist } = await getClient()
        .from('sequence_templates').select('id').eq('id', id).maybeSingle();
    if (eExist) throw new Error(eExist.message);
    if (!existing) return null;

    const { error: e1 } = await getClient().from('sequence_templates').update({
        name: tpl.name,
        icp_id: tpl.icpId || null,
        portfolio_company: tpl.portfolioCompany || null,
        sender_template_id: tpl.senderTemplateId || null,
        language: tpl.language || 'English',
        description: tpl.description || null,
        updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (e1) throw new Error(e1.message);

    // Replace steps wholesale - simpler than diffing and steps are ordered.
    await getClient().from('sequence_template_steps').delete().eq('template_id', id);
    const stepRows = tpl.steps.map((s, idx) => ({
        template_id: id,
        order_idx: idx,
        purpose: s.purpose,
        days_after_prev: s.daysAfterPrev || 0,
        length_hint: s.lengthHint || 'medium',
        custom_guidance: s.customGuidance || null,
    }));
    const { error: e2 } = await getClient().from('sequence_template_steps').insert(stepRows);
    if (e2) throw new Error(e2.message);

    return getTemplate(id);
}

async function deleteTemplate(id) {
    if (!isEnabled()) throw notEnabledError();
    // ON DELETE RESTRICT on sequence_runs.template_id means this will fail
    // if any runs use this template. Surface the error verbatim so the UI
    // can show "this template is in use by N runs, delete those first".
    const { error } = await getClient().from('sequence_templates').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
}

// ─── Runs ──────────────────────────────────────────────────────────────

async function listRuns({ companyId = null, templateId = null, limit = 100 } = {}) {
    if (!isEnabled()) throw notEnabledError();
    let q = getClient().from('sequence_runs').select('*').order('created_at', { ascending: false }).limit(limit);
    if (companyId) q = q.eq('company_id', companyId);
    if (templateId) q = q.eq('template_id', templateId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data || []).map(rowToRun);
}

async function getRun(id) {
    if (!isEnabled()) throw notEnabledError();
    const { data, error } = await getClient()
        .from('sequence_runs')
        .select('*, sequence_run_steps(*)')
        .eq('id', id)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? rowToRunWithSteps(data) : null;
}

// Create the run row + EMPTY step placeholders. Generation is a separate
// route step so the UI can show "generating step 2 of 4..." progress.
async function createRun({ templateId, companyId, leadApolloId, icpId, customInstruction, contextSnapshot }) {
    if (!isEnabled()) throw notEnabledError();
    if (!templateId) throw new Error('templateId required');
    if (!companyId) throw new Error('companyId required');

    const template = await getTemplate(templateId);
    if (!template) throw new Error(`template "${templateId}" not found`);

    const { data: runRow, error: e1 } = await getClient().from('sequence_runs').insert({
        template_id: templateId,
        company_id: String(companyId),
        lead_apollo_id: leadApolloId || null,
        icp_id: icpId || null,
        custom_instruction: customInstruction || null,
        context_snapshot: contextSnapshot || {},
        status: 'draft',
    }).select().single();
    if (e1) throw new Error(e1.message);

    // Seed empty placeholders so the UI sees the right number of steps
    // before generation lands.
    const stepRows = template.steps.map((s, idx) => ({
        run_id: runRow.id,
        order_idx: idx,
        purpose: s.purpose,
        days_after_prev: s.daysAfterPrev || 0,
        subject: null,
        body: null,
        model_used: null,
        edited_by_user: false,
    }));
    const { error: e2 } = await getClient().from('sequence_run_steps').insert(stepRows);
    if (e2) throw new Error(e2.message);

    return getRun(runRow.id);
}

async function updateRunStep(runId, orderIdx, { subject, body, modelUsed, editedByUser } = {}) {
    if (!isEnabled()) throw notEnabledError();
    const patch = {};
    if (subject !== undefined) patch.subject = subject;
    if (body !== undefined) patch.body = body;
    if (modelUsed !== undefined) patch.model_used = modelUsed;
    if (editedByUser !== undefined) patch.edited_by_user = editedByUser;
    patch.generated_at = new Date().toISOString();
    const { error } = await getClient()
        .from('sequence_run_steps').update(patch)
        .eq('run_id', runId).eq('order_idx', orderIdx);
    if (error) throw new Error(error.message);
    // bump parent run's updated_at for the "recent" list sort
    await getClient().from('sequence_runs').update({ updated_at: new Date().toISOString() }).eq('id', runId);
}

async function updateRunStatus(runId, status) {
    if (!isEnabled()) throw notEnabledError();
    if (!['draft', 'approved', 'exported'].includes(status)) throw new Error('invalid status');
    const { error } = await getClient().from('sequence_runs')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', runId);
    if (error) throw new Error(error.message);
}

async function deleteRun(id) {
    if (!isEnabled()) throw notEnabledError();
    const { error } = await getClient().from('sequence_runs').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const VALID_PURPOSES = ['intro', 'value', 'social_proof', 'follow_up', 'breakup'];
const VALID_LENGTHS = ['long', 'medium', 'short', 'brief'];

function normaliseTemplate(input) {
    const i = input || {};
    return {
        id: String(i.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''),
        name: String(i.name || '').trim(),
        icpId: i.icpId || null,
        portfolioCompany: i.portfolioCompany || null,
        senderTemplateId: i.senderTemplateId || null,
        language: i.language || 'English',
        description: i.description || null,
        steps: Array.isArray(i.steps) ? i.steps.map((s) => ({
            purpose: VALID_PURPOSES.includes(s.purpose) ? s.purpose : 'intro',
            daysAfterPrev: Math.max(0, parseInt(s.daysAfterPrev, 10) || 0),
            lengthHint: VALID_LENGTHS.includes(s.lengthHint) ? s.lengthHint : 'medium',
            customGuidance: s.customGuidance || null,
        })) : [],
    };
}

function rowToTemplate(r) {
    return {
        id: r.id,
        name: r.name,
        icpId: r.icp_id,
        portfolioCompany: r.portfolio_company,
        senderTemplateId: r.sender_template_id,
        language: r.language,
        description: r.description,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
        steps: (r.sequence_template_steps || [])
            .sort((a, b) => a.order_idx - b.order_idx)
            .map((s) => ({
                orderIdx: s.order_idx,
                purpose: s.purpose,
                daysAfterPrev: s.days_after_prev,
                lengthHint: s.length_hint,
                customGuidance: s.custom_guidance,
            })),
    };
}

function rowToRun(r) {
    return {
        id: r.id,
        templateId: r.template_id,
        companyId: r.company_id,
        leadApolloId: r.lead_apollo_id,
        icpId: r.icp_id,
        customInstruction: r.custom_instruction,
        contextSnapshot: r.context_snapshot || {},
        status: r.status,
        createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : null,
    };
}

function rowToRunWithSteps(r) {
    return {
        ...rowToRun(r),
        steps: (r.sequence_run_steps || [])
            .sort((a, b) => a.order_idx - b.order_idx)
            .map((s) => ({
                orderIdx: s.order_idx,
                purpose: s.purpose,
                daysAfterPrev: s.days_after_prev,
                subject: s.subject,
                body: s.body,
                modelUsed: s.model_used,
                editedByUser: s.edited_by_user,
                generatedAt: s.generated_at ? new Date(s.generated_at).getTime() : null,
            })),
    };
}

module.exports = {
    listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
    listRuns, getRun, createRun, updateRunStep, updateRunStatus, deleteRun,
    VALID_PURPOSES, VALID_LENGTHS,
};