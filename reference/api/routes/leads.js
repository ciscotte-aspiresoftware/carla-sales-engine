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
const { searchTopPeople } = require('../utils/apollo');
const { attachLeads } = require('./companies');
const mode = require('../utils/mode');
const { leadsStub } = require('../utils/demo-stubs');

const router = express.Router();

router.post('/', async (req, res) => {
    const { companyName, domain, limit, skipEnrich, companyId } = req.body || {};
    if (!companyName && !domain) {
        return res.status(400).json({ success: false, error: 'companyName or domain is required' });
    }

    const cap = Math.min(parseInt(limit, 10) || 3, 10);
    // Default to search-only. Caller can pass skipEnrich:false to force the
    // old behavior (rarely needed - only useful if someone wants to bulk
    // enrich up front for some reason).
    const useSearchOnly = skipEnrich === false ? false : true;

    const startedAt = Date.now();
    console.log(`[Leads] ▶ START company="${companyName || '(name unknown)'}" domain="${domain || '(no domain)'}" cap=${cap} ${useSearchOnly ? '(search-only)' : '(search+enrich)'}${mode.isDemo() ? ' (demo mode)' : ''}`);

    if (mode.isDemo()) {
        const { people, warnings } = leadsStub();
        const capped = people.slice(0, cap);
        if (companyId) {
            try { await attachLeads(companyId, capped); } catch { /* non-fatal */ }
        }
        console.log(`[Leads] ✓ END ${Date.now() - startedAt}ms (stub) ${capped.length} people`);
        return res.json({ success: true, people: capped, warnings, demo: true });
    }

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
            `      ${i + 1}. ${p.firstName} ${p.lastName || ''}${p.title ? ` — ${p.title}` : ''}${p.email ? ` <${p.email}>` : ' (no email)'}`,
        ).join('\n');
        console.log(`[Leads]   ├─ found ${tagged.length} people in ${Date.now() - startedAt}ms:\n${preview || '      (none)'}`);
        if (warnings && warnings.length > 0) {
            for (const w of warnings) console.warn(`[Leads]   ├─ ⚠ ${w}`);
        }

        if (companyId) {
            try {
                await attachLeads(companyId, tagged);
                console.log(`[Leads]   ├─ attached ${tagged.length} lead(s) to companyId=${companyId}`);
            } catch (err) {
                console.warn(`[Leads]   ├─ ⚠ attach failed (non-fatal): ${err.message}`);
            }
        }

        console.log(`[Leads] ✓ END ${Date.now() - startedAt}ms total`);
        return res.json({ success: true, people: tagged, warnings });
    } catch (err) {
        console.error(`[Leads] ✗ END error after ${Date.now() - startedAt}ms:`, err.message);
        return res.status(500).json({ success: false, error: err.message || 'Lead search failed' });
    }
});

module.exports = router;
