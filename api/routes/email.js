// POST /api/email
// Body: { classification, lead, companyId?, templateId?, senderId? }
// Flow:
//   1. If lead.enriched is false AND lead.apolloId is present → enrich (1
//      Apollo credit). Merge enriched fields back into the lead object.
//   2. Persist the enriched lead to companies.json so the badge stays after
//      page reloads and we don't burn another credit on the same person.
//   3. Resolve the template - by templateId if provided, by ICP context,
//      or fall back to the legacy senderId/default sender.
//   4. Generate the email using the template's system prompt + (enriched)
//      lead + classification + sender.
//
// `templateId` replaces the old `senderId` as the canonical handle -
// `senderId` is kept for legacy callers (Bluebird's original Fazal flow)
// and resolved to the matching template by sender id.

const express = require('express');
const { chat } = require('../utils/openai');
const { enrichPerson } = require('../utils/apollo');
const { scrapeLinkedInProfile, scrapeRecentPosts } = require('../utils/linkedin');
const { buildEmailPrompt } = require('../prompts/email');
const { getSender } = require('../senders');
const { upsertLeadInCompany } = require('./companies');
const { getTemplate, listTemplates, suggestTemplate } = require('../utils/email-templates');
const { getAi } = require('../utils/settings');
const { trackActivity } = require('../middleware/activity');

// Re-scrape LinkedIn for a given lead at most this often. Profiles + posts
// don't change minute-by-minute, so a 30-day cache cuts repeat Apify cost
// on the same lead when reps re-generate emails. Tune up/down here only.
const LINKEDIN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const router = express.Router();

router.post('/', trackActivity('email_generated'), async (req, res) => {
    const { classification, lead, companyId, templateId, senderId, icpId } = req.body || {};
    if (!classification || !lead) {
        return res.status(400).json({ success: false, error: 'classification and lead are required' });
    }

    const startedAt = Date.now();
    const targetCompany = classification?.name || classification?.title || classification?.domain || '(unknown)';
    const recipient = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || '(unknown lead)';
    console.log(`[Email] ▶ START company="${targetCompany}" recipient="${recipient}"${icpId ? ` icp=${icpId}` : ''}`);

    // Resolve the email template. Priority:
    //   1. Explicit templateId from the request (UI picker / "Save as template" flow)
    //   2. Suggest by ICP context (came from Accounts skip flow)
    //   3. Legacy senderId → look up a template whose sender.firstName matches
    //   4. Fall back to default Bluebird Fazal template (legacy behaviour)
    let template = null;
    let resolutionSource = 'fallback';
    if (templateId) {
        template = getTemplate(templateId);
        if (!template) {
            console.warn(`[Email] ✗ END template-not-found templateId=${templateId}`);
            return res.status(400).json({ success: false, error: `template "${templateId}" not found` });
        }
        resolutionSource = `explicit templateId=${templateId}`;
    } else if (icpId) {
        template = suggestTemplate({ icpId });
        resolutionSource = `ICP suggest (icp=${icpId})`;
    } else if (senderId) {
        // Legacy path - match by sender.firstName lowercased == senderId.
        // Lets older callers (paste-classify flow) keep working without
        // knowing about templates.
        const all = listTemplates();
        template = all.find((t) => (t.sender?.firstName || '').toLowerCase() === senderId.toLowerCase()) || null;
        if (template) template = getTemplate(template.id); // hydrate to full record
        resolutionSource = `legacy senderId=${senderId}`;
    }
    // Final fallback - the original Bluebird-Fazal template.
    if (!template) {
        template = getTemplate('bluebird-fazal');
        resolutionSource += ' → fallback Fazal/Bluebird';
    }
    console.log(`[Email]   ├─ template resolved: "${template?.name || '(legacy)'}" id=${template?.id || 'legacy'} via ${resolutionSource} | language=${template?.language || 'English'}`);

    // Hydrate the sender shape that buildEmailPrompt expects from the
    // template. Legacy senders.js shape kept compatible so we don't have
    // to change the prompt builder signature.
    const sender = template
        ? {
            id: template.id,
            name: `${template.sender.firstName} ${template.sender.lastName || ''}`.trim(),
            firstName: template.sender.firstName,
            title: template.sender.title,
            company: template.sender.company,
            signoff: template.sender.signoff,
            email: template.sender.email,
            intro: `I'm ${template.sender.firstName}, ${template.sender.title} at ${template.sender.company}.`,
        }
        : getSender(senderId || 'fazal');

    // Mutable working copy - we may merge enrichment results into this.
    let workingLead = { ...lead };
    const enrichmentWarnings = [];

    // Step 1: enrich if needed.
    if (!workingLead.enriched && workingLead.apolloId) {
        console.log(`[Email]   ├─ enriching via Apollo: ${workingLead.firstName} ${workingLead.lastName || ''} (apolloId=${workingLead.apolloId})`);
        const enrichStarted = Date.now();
        try {
            const result = await enrichPerson(workingLead.apolloId);
            if (result?.warning) {
                // Apollo credits exhausted or rate-limited. Continue with
                // un-enriched data - email gen still works, just without
                // the verified email/LinkedIn.
                enrichmentWarnings.push(result.warning);
                console.warn(`[Email]   ├─ ⚠ enrichment warning after ${Date.now() - enrichStarted}ms: ${result.warning}`);
            } else if (result) {
                console.log(`[Email]   ├─ enriched in ${Date.now() - enrichStarted}ms | email=${result.email ? 'found' : 'missing'} | linkedin=${result.linkedinUrl ? 'found' : 'missing'}`);
                workingLead = {
                    ...workingLead,
                    firstName: result.firstName || workingLead.firstName,
                    lastName: result.lastName || workingLead.lastName,
                    email: result.email || workingLead.email,
                    emailStatus: result.emailStatus || workingLead.emailStatus,
                    linkedinUrl: result.linkedinUrl || workingLead.linkedinUrl,
                    enriched: true,
                    enrichedAt: Date.now(),
                };

                // Step 2: persist back to JSON. Best-effort - failure here
                // doesn't block email generation.
                if (companyId) {
                    try {
                        await upsertLeadInCompany(companyId, workingLead.apolloId, {
                            firstName: workingLead.firstName,
                            lastName: workingLead.lastName,
                            email: workingLead.email,
                            emailStatus: workingLead.emailStatus,
                            linkedinUrl: workingLead.linkedinUrl,
                            enriched: true,
                            enrichedAt: workingLead.enrichedAt,
                        });
                        console.log(`[Email] Saved enriched lead to companies.json`);
                    } catch (persistErr) {
                        console.warn(`[Email] Persist of enriched lead failed (non-fatal): ${persistErr.message}`);
                    }
                }
            }
        } catch (err) {
            console.error(`[Email] Enrichment failed: ${err.message}`);
            enrichmentWarnings.push(`Enrichment failed: ${err.message}`);
        }
    }

    // Step 2.5: LinkedIn scrape (profile + recent posts) - free signal that
    // sharpens email personalization. Only runs when:
    //   (a) we have a LinkedIn URL (either from existing lead or Apollo enrich)
    //   (b) we don't already have a fresh cached scrape (< 30 days old)
    //   (c) we're not in demo mode (handled above by early-return stub)
    // Failures are non-fatal - email gen still works with the original
    // Apollo data if Apify is down / out of credits.
    const hasFreshLiCache = workingLead.liScrapedAt
        && (Date.now() - workingLead.liScrapedAt) < LINKEDIN_CACHE_MAX_AGE_MS
        && (workingLead.liSummary || (Array.isArray(workingLead.liPosts) && workingLead.liPosts.length > 0));

    if (workingLead.linkedinUrl && !hasFreshLiCache) {
        console.log(`[Email]   ├─ scraping LinkedIn: ${workingLead.linkedinUrl}`);
        const liStart = Date.now();
        try {
            const [liSummary, liPosts] = await Promise.all([
                scrapeLinkedInProfile(workingLead.linkedinUrl),
                scrapeRecentPosts(workingLead.linkedinUrl),
            ]);
            console.log(`[Email]   ├─ LinkedIn scrape done in ${Date.now() - liStart}ms | profile=${liSummary ? 'ok' : 'none'} | posts=${liPosts.length}`);

            workingLead = {
                ...workingLead,
                liSummary: liSummary || null,
                liPosts: liPosts || [],
                liScrapedAt: Date.now(),
            };

            // Persist so subsequent regenerate calls on the same lead reuse
            // the cached data instead of paying Apify again.
            if (companyId) {
                try {
                    await upsertLeadInCompany(companyId, workingLead.apolloId, {
                        liSummary: workingLead.liSummary,
                        liPosts: workingLead.liPosts,
                        liScrapedAt: workingLead.liScrapedAt,
                    });
                    console.log(`[Email]   ├─ Saved LI summary + posts to companies.json`);
                } catch (persistErr) {
                    console.warn(`[Email] Persist of LI scrape failed (non-fatal): ${persistErr.message}`);
                }
            }
        } catch (err) {
            console.warn(`[Email]   ├─ LinkedIn scrape failed (non-fatal): ${err.message}`);
            enrichmentWarnings.push(`LinkedIn scrape failed: ${err.message}`);
        }
    } else if (workingLead.linkedinUrl && hasFreshLiCache) {
        const ageDays = Math.round((Date.now() - workingLead.liScrapedAt) / (24 * 60 * 60 * 1000));
        console.log(`[Email]   ├─ LinkedIn cache hit (${ageDays}d old) - skipping re-scrape`);
    }

    // Step 3: generate email.
    try {
        console.log(`[Email]   ├─ generating via GPT…`);
        const genStarted = Date.now();
        const messages = buildEmailPrompt({ classification, lead: workingLead, sender, template });
        const raw = await chat(messages, {
            model: getAi().emailModel,
            temperature: 0.6,
            response_format: { type: 'json_object' },
        });
        console.log(`[Email]   ├─ generated in ${Date.now() - genStarted}ms`);

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (err) {
            console.error('[Email] ✗ END OpenAI returned non-JSON:', raw.slice(0, 200));
            return res.status(502).json({ success: false, error: 'Email generator returned invalid JSON', raw: raw.slice(0, 500) });
        }

        if (!parsed.subject || !parsed.body) {
            console.error('[Email] ✗ END incomplete payload:', parsed);
            return res.status(502).json({ success: false, error: 'Email generator returned incomplete payload', received: parsed });
        }

        // Strip em dashes the model may emit despite the prompt - we never
        // want them in outbound copy. Hyphen is the in-house substitute.
        parsed.subject = parsed.subject.replace(/—/g, '-');
        parsed.body = parsed.body.replace(/—/g, '-');

        console.log(`[Email] ✓ END ${Date.now() - startedAt}ms total | subject="${parsed.subject.slice(0, 60)}${parsed.subject.length > 60 ? '…' : ''}" | body ${parsed.body.length} chars`);
        return res.json({
            success: true,
            email: parsed,
            lead: workingLead, // return the (possibly enriched) lead so the frontend can update its row + badge
            sender: { id: sender.id, name: sender.name, signoff: sender.signoff },
            // Echo back which template was used so the frontend can show
            // it next to the generated email (and so "Save as template"
            // knows what to clone from).
            template: template ? {
                id: template.id,
                name: template.name,
                portfolioCompany: template.portfolioCompany,
                language: template.language,
            } : null,
            warnings: enrichmentWarnings,
        });
    } catch (err) {
        console.error(`[Email] ✗ END error after ${Date.now() - startedAt}ms:`, err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Email generation failed' });
    }
});

module.exports = router;
