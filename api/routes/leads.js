// POST /api/leads
// Body: { companyName, domain, limit?, companyId?, skipEnrich? }
// Returns top N decision-makers via Apollo SEARCH ONLY by default. No
// enrichment credits are spent at this stage - the user picks a lead, then
// /api/email enriches just that one. Mirrors valsource's agent.js pattern,
// where enrichment is deferred until the user commits to writing an email.
//
// Each returned lead is tagged with `enriched: false`. After enrichment,
// the same lead in companies.json is updated to `enriched: true` and the
// frontend swaps in the verified email/LinkedIn.

const express = require('express');
const { searchTopPeople, enrichPerson, enrichPersonWithWaterfall } = require('../utils/apollo');
const { attachLeads, readAll, upsertLeadInCompany } = require('./companies');

const router = express.Router();

// GET /api/leads
// Returns every stored lead across all companies in a flat array, each
// row enriched with company context (companyId / companyName / vertical /
// icpIds) so the frontend can render company-scoped chips next to each
// lead without a join.
// Filters (all optional, applied AND-wise):
//   ?vertical=<exact match, case-insensitive>
//   ?icp=<icpId>                - only leads on companies classified under that ICP
//   ?portfolioCompany=<name>    - leads on companies under any of that portfolio's ICPs
//   ?companyId=<id>             - leads on a single company
//   ?hasLi=true|false           - only leads with (or without) a cached liSummary
//   ?hasEmail=true|false        - only leads with (or without) a verified email
//   ?search=<q>                 - substring match on name / title / email / companyName
router.get('/', async (req, res) => {
    try {
        const data = await readAll();
        const companies = data.companies || [];

        const verticalFilter = req.query.vertical ? String(req.query.vertical).toLowerCase() : null;
        const icpFilter = req.query.icp ? String(req.query.icp) : null;
        const portfolioFilter = req.query.portfolioCompany ? String(req.query.portfolioCompany).toLowerCase() : null;
        const companyIdFilter = req.query.companyId ? String(req.query.companyId) : null;
        const hasLiFilter = req.query.hasLi === 'true' ? true : req.query.hasLi === 'false' ? false : null;
        const hasEmailFilter = req.query.hasEmail === 'true' ? true : req.query.hasEmail === 'false' ? false : null;
        const search = req.query.search ? String(req.query.search).toLowerCase().trim() : '';

        // Resolve portfolioCompany → ICP-id set once, then test inclusion
        // per company. Same lazy lookup pattern companies.js uses.
        let portfolioIcpIds = null;
        if (portfolioFilter) {
            const { listIcpsFull } = require('../utils/icps');
            portfolioIcpIds = new Set(
                listIcpsFull()
                    .filter(i => (i.portfolioCompany || '').toLowerCase() === portfolioFilter)
                    .map(i => i.id),
            );
            if (portfolioIcpIds.size === 0) {
                return res.json({ success: true, leads: [] });
            }
        }

        const out = [];
        for (const c of companies) {
            if (verticalFilter && (c.vertical || '').toLowerCase() !== verticalFilter) continue;
            if (companyIdFilter && c.id !== companyIdFilter) continue;
            if (icpFilter && !(c.classifications && c.classifications[icpFilter])) continue;
            if (portfolioIcpIds) {
                const hits = c.classifications ? Object.keys(c.classifications).some(k => portfolioIcpIds.has(k)) : false;
                if (!hits) continue;
            }
            if (!Array.isArray(c.leads) || c.leads.length === 0) continue;
            const icpIds = c.classifications ? Object.keys(c.classifications) : [];
            for (const lead of c.leads) {
                if (hasLiFilter !== null) {
                    const hasLi = !!(lead.liSummary || (Array.isArray(lead.liPosts) && lead.liPosts.length > 0));
                    if (hasLi !== hasLiFilter) continue;
                }
                if (hasEmailFilter !== null) {
                    const hasEmail = !!lead.email;
                    if (hasEmail !== hasEmailFilter) continue;
                }
                if (search) {
                    const haystack = [
                        lead.firstName, lead.lastName, lead.name, lead.title, lead.email,
                        c.name, c.domain,
                    ].filter(Boolean).join(' ').toLowerCase();
                    if (!haystack.includes(search)) continue;
                }
                out.push({
                    ...lead,
                    companyId: c.id,
                    companyName: c.name || null,
                    companyDomain: c.domain || null,
                    vertical: c.vertical || null,
                    icpIds,
                    // Surface the company's createdAt as a fallback "added"
                    // date for any lead row that pre-dates the per-lead
                    // addedAt stamp. Frontend prefixes it with ~ to signal
                    // it's approximate (company-level, not lead-level).
                    companyCreatedAt: c.createdAt || null,
                });
            }
        }

        res.json({ success: true, leads: out });
    } catch (err) {
        console.error('[Leads] GET / failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { companyName, domain, limit, skipEnrich, companyId } = req.body || {};
    if (!companyName && !domain) {
        return res.status(400).json({ success: false, error: 'companyName or domain is required' });
    }

    // No default cap. When the caller doesn't specify `limit`, the search
    // returns every person Apollo surfaced for the company (deduped,
    // ranked by seniority). The caller can still pass an explicit `limit`
    // to cap the response if they want a short preview list.
    const parsedLimit = parseInt(limit, 10);
    const cap = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    // Default to search-only. Caller can pass skipEnrich:false to force the
    // old behavior (rarely needed - only useful if someone wants to bulk
    // enrich up front for some reason).
    const useSearchOnly = skipEnrich === false ? false : true;

    const startedAt = Date.now();
    console.log(`[Leads] ▶ START company="${companyName || '(name unknown)'}" domain="${domain || '(no domain)'}" cap=${cap ?? 'all'} ${useSearchOnly ? '(search-only)' : '(search+enrich)'}`);

    try {
        const { people, warnings } = await searchTopPeople(
            companyName || '',
            domain || '',
            cap,
            { skipEnrich: useSearchOnly }
        );

        // Tag each lead's enrichment state so the frontend can show a badge
        // and the email route knows whether it needs to enrich-then-save.
        const tagged = people.map(p => ({ ...p, enriched: !useSearchOnly }));

        // Pretty-print the top picks so the operator can see who the
        // pipeline is about to feed into email-gen without opening the UI.
        const preview = tagged.slice(0, 5).map((p, i) =>
            `      ${i + 1}. ${p.firstName} ${p.lastName || ''}${p.title ? ` - ${p.title}` : ''}${p.email ? ` <${p.email}>` : ' (no email)'}`,
        ).join('\n');
        console.log(`[Leads]   ├─ found ${tagged.length} people in ${Date.now() - startedAt}ms:\n${preview || '      (none)'}`);
        if (warnings && warnings.length > 0) {
            for (const w of warnings) console.warn(`[Leads]   ├─ ⚠ ${w}`);
        }

        // Default to the fresh search results. When we have a companyId we
        // return the MERGED leads instead (see below) so prior enrichment
        // survives a re-run.
        let responsePeople = tagged;
        if (companyId) {
            try {
                const updatedCompany = await attachLeads(companyId, tagged);
                // attachLeads merges the fresh (search-only) rows with what's
                // already on the company, preserving email / LinkedIn /
                // enriched flags from earlier enrichment. Return that merged
                // list so re-running an account in the Sales Agent shows the
                // already-enriched contacts with their email + LI, NOT a fresh
                // "Enrich" button. (Returning `tagged` here was the bug: the
                // file kept the enrichment but the response threw it away.)
                if (updatedCompany && Array.isArray(updatedCompany.leads)) {
                    responsePeople = updatedCompany.leads;
                }
                console.log(`[Leads]   ├─ attached ${tagged.length} lead(s) to companyId=${companyId} → returning ${responsePeople.length} merged (${responsePeople.filter(l => l.enriched).length} already enriched)`);
            } catch (err) {
                console.warn(`[Leads]   ├─ ⚠ attach failed (non-fatal): ${err.message}`);
            }
        }

        console.log(`[Leads] ✓ END ${Date.now() - startedAt}ms total`);
        return res.json({ success: true, people: responsePeople, warnings });
    } catch (err) {
        console.error(`[Leads] ✗ END error after ${Date.now() - startedAt}ms:`, err.message);
        return res.status(500).json({ success: false, error: err.message || 'Lead search failed' });
    }
});

// POST /api/leads/:companyId/:apolloId/enrich
// Single-person Apollo enrichment for a lead already in the database. Used by
// the Leads page "Enrich" button so the operator can fill in email + LI URL
// for search-only rows without going through the full /api/email flow. Costs
// one Apollo enrichment credit. Writes the verified email/LI/name back to
// companies.json via upsertLeadInCompany so reloads keep the result.
router.post('/:companyId/:apolloId/enrich', async (req, res) => {
    const { companyId, apolloId } = req.params;
    if (!companyId || !apolloId) {
        return res.status(400).json({ success: false, error: 'companyId and apolloId are required' });
    }

    try {
        const result = await enrichPerson(apolloId);
        if (!result) {
            return res.status(502).json({ success: false, error: 'Apollo returned no data for this person' });
        }
        if (result.warning) {
            return res.status(402).json({ success: false, error: result.warning });
        }
        // Build the patch conditionally - only include `phone` when Apollo
        // returned one, so a re-enrich that comes back phone-less doesn't
        // clobber a phone the operator already had.
        const patch = {
            firstName: result.firstName || undefined,
            lastName: result.lastName || undefined,
            email: result.email,
            emailStatus: result.emailStatus,
            linkedinUrl: result.linkedinUrl,
            hasEmail: !!result.email,
            enriched: true,
            enrichedAt: Date.now(),
        };
        if (result.phone) patch.phone = result.phone;
        const updated = await upsertLeadInCompany(companyId, apolloId, patch);
        if (!updated) return res.status(404).json({ success: false, error: 'Lead not found in company' });
        console.log(`[Leads] ✓ enriched apolloId=${apolloId} on company=${companyId}: email=${result.email || '(none)'} li=${result.linkedinUrl ? 'yes' : 'no'} phone=${result.phone || '(none)'}`);
        return res.json({ success: true, lead: updated });
    } catch (err) {
        console.error(`[Leads] enrich failed for ${apolloId}:`, err.message);
        return res.status(500).json({ success: false, error: err.message || 'Enrichment failed' });
    }
});

// POST /api/leads/:companyId/:apolloId/enrich-phone
// Async phone enrichment via Apollo's waterfall API. Sales Agent search
// already extracted cached phone from Apollo's results — this endpoint is
// for exhaustive phone reveal when the search came up empty.
//
// Initiates an async request: Apollo enriches the phone in the background
// and POSTs the result to /api/apollo/webhook, which updates the lead.
// Returns immediately with { waterfall_pending: true, request_id }.
//
// Requires CARLA_APOLLO_WEBHOOK_URL to be set (the endpoint Apollo posts to).
router.post('/:companyId/:apolloId/enrich-phone', async (req, res) => {
    const { companyId, apolloId } = req.params;

    if (!companyId || !apolloId) {
        return res.status(400).json({ success: false, error: 'companyId and apolloId are required' });
    }

    try {
        const webhookUrl = process.env.CARLA_APOLLO_WEBHOOK_URL;
        if (!webhookUrl) {
            return res.status(500).json({
                success: false,
                error: 'Phone reveal not configured (set CARLA_APOLLO_WEBHOOK_URL)',
            });
        }

        const waterfallResult = await enrichPersonWithWaterfall(apolloId, {
            companyId,
            leadKey: apolloId,
            webhookUrl,
        });

        if (!waterfallResult) {
            return res.status(502).json({ success: false, error: 'Waterfall initiation failed' });
        }
        if (waterfallResult.warning) {
            return res.status(402).json({ success: false, error: waterfallResult.warning });
        }

        // Mark the lead as phoneCheckedAt so the UI knows we initiated enrichment.
        const patch = { phoneCheckedAt: Date.now() };
        await upsertLeadInCompany(companyId, apolloId, patch);

        console.log(`[Leads] ✓ waterfall phone reveal initiated ${apolloId}: request_id=${waterfallResult.request_id}`);
        return res.json({
            success: true,
            waterfall_pending: true,
            request_id: waterfallResult.request_id,
            message: 'Phone reveal in progress - check back in a few minutes',
        });
    } catch (err) {
        console.error(`[Leads] phone reveal failed for ${apolloId}:`, err.message);
        return res.status(500).json({ success: false, error: err.message || 'Phone reveal failed' });
    }
});

module.exports = router;
