// POST /api/li-message/scrape
// Body: either { linkedinUrl } (paste-URL mode) or { companyId, apolloId }
//       (existing-lead mode). Returns { profileSummary, posts, lead? }.
// - In paste-URL mode: fresh scrape only, nothing persisted.
// - In existing-lead mode: scrape (or reuse 30-day cache), persist to
//   companies.json via upsertLeadInCompany so the Leads page picks it up.
//
// POST /api/li-message/email
// Body: { profileSummary, posts, linkedinUrl, icpId?, templateId?,
//         companyId?, lead?, classification?, customInstruction? }
// Returns the same shape as /api/email - { email, lead, sender, template }.
// Reuses buildEmailPrompt with the scraped LI signals so the prompt is
// identical to the email pipeline's; the only difference is we don't run
// Apollo enrichment (the lead is already chosen explicitly).

const express = require('express');
const { chat } = require('../utils/openai');
const { scrapeLinkedInProfile, scrapeRecentPosts, summarizeProfile, isUsefulLiSummary, hasUsefulPosts, describeLiSummary } = require('../utils/linkedin');
const { buildEmailPrompt } = require('../prompts/email');
const { getSender } = require('../senders');
const { upsertLeadInCompany, readAll } = require('./companies');
const { getTemplate, listTemplates, suggestTemplate } = require('../utils/email-templates');
const { getAi } = require('../utils/settings');
const { trackActivity } = require('../middleware/activity');

const LINKEDIN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LINKEDIN_URL_RE = /linkedin\.com\/in\//i;

const router = express.Router();

// Locate a lead by (companyId, apolloId) and return both the company and the
// lead. Used by /scrape and /email's existing-lead branch. Returns null if
// either is missing.
async function findLead(companyId, apolloId) {
    if (!companyId || !apolloId) return null;
    const data = await readAll();
    const company = data.companies.find(c => c.id === companyId);
    if (!company || !Array.isArray(company.leads)) return null;
    const lead = company.leads.find(l => l.apolloId === apolloId);
    if (!lead) return null;
    return { company, lead };
}

router.post('/scrape', async (req, res) => {
    const { linkedinUrl: rawUrl, companyId, apolloId } = req.body || {};

    // Mode resolution: explicit pair takes precedence so callers that pass
    // both (e.g. the "Pick lead → scrape" flow) get the persist behavior.
    const mode_existingLead = !!(companyId && apolloId);
    const startedAt = Date.now();

    try {
        let linkedinUrl = (rawUrl || '').trim();
        let leadRec = null;
        let companyRec = null;

        if (mode_existingLead) {
            const found = await findLead(companyId, apolloId);
            if (!found) return res.status(404).json({ success: false, error: 'Lead not found' });
            leadRec = found.lead;
            companyRec = found.company;
            if (!linkedinUrl) linkedinUrl = (leadRec.linkedinUrl || '').trim();
            if (!linkedinUrl) {
                return res.status(400).json({
                    success: false,
                    error: 'This lead has no LinkedIn URL. Enrich the lead first, or use the paste-URL mode.',
                });
            }
        }

        if (!linkedinUrl) {
            return res.status(400).json({ success: false, error: 'linkedinUrl is required' });
        }
        if (!LINKEDIN_URL_RE.test(linkedinUrl)) {
            return res.status(400).json({ success: false, error: 'Please paste a valid LinkedIn profile URL (e.g. linkedin.com/in/username)' });
        }
        if (!process.env.APIFY_API_TOKEN) {
            return res.status(500).json({ success: false, error: 'APIFY_API_TOKEN is not configured' });
        }

        // Cache hit: existing-lead mode and the cached scrape is < 30 days
        // old AND the cached content is actually populated. Without the
        // isUsefulLiSummary / hasUsefulPosts gate a previously-blocked
        // Apify response (empty-string fields) would satisfy `leadRec.
        // liSummary` and the route would serve generic data back to the
        // rep as if it were a real scrape - same bug we fixed in /api/email.
        if (mode_existingLead && leadRec.liScrapedAt && (Date.now() - leadRec.liScrapedAt) < LINKEDIN_CACHE_MAX_AGE_MS) {
            const hasData = isUsefulLiSummary(leadRec.liSummary) || hasUsefulPosts(leadRec.liPosts);
            if (hasData) {
                const ageDays = Math.round((Date.now() - leadRec.liScrapedAt) / (24 * 60 * 60 * 1000));
                console.log(`[LI Message] cache hit (${ageDays}d) for apolloId=${apolloId} - skipping re-scrape`);
                return res.json({
                    success: true,
                    profileSummary: leadRec.liSummary || null,
                    posts: Array.isArray(leadRec.liPosts) ? leadRec.liPosts : [],
                    lead: leadRec,
                    cached: true,
                    cacheAgeDays: ageDays,
                });
            }
        }

        console.log(`[LI Message] scraping ${linkedinUrl}${mode_existingLead ? ` (apolloId=${apolloId})` : ' (paste-url)'}`);

        // Profile + posts in parallel - same pattern as /api/email step 2.5.
        const [rawProfile, postsResult] = await Promise.all([
            scrapeLinkedInProfile(linkedinUrl).catch(err => {
                console.error('[LI Message] profile scrape error:', err.message);
                return null;
            }),
            scrapeRecentPosts(linkedinUrl).catch(err => {
                console.error('[LI Message] posts scrape error (non-critical):', err.message);
                return [];
            }),
        ]);

        // scrapeLinkedInProfile already returns the summary shape via
        // summarizeProfile internally - but if a caller swaps the helper for
        // a raw fetcher, summarizeProfile guarantees the shape downstream
        // expects. Either way, this is a no-op if rawProfile is already the
        // summary.
        const profileSummary = rawProfile && rawProfile.headline === undefined && typeof summarizeProfile === 'function'
            ? summarizeProfile(rawProfile)
            : rawProfile;

        if (!profileSummary) {
            return res.status(502).json({ success: false, error: 'Could not scrape LinkedIn profile' });
        }
        // If the scrape technically returned a summary object but every
        // field is blank (Apify partial / anti-bot), surface the empty
        // result to the caller AND skip persistence - otherwise an empty
        // shell would land in companies.json and short-circuit the next
        // 30 days of re-scrape attempts on this lead.
        const summaryUseful = isUsefulLiSummary(profileSummary);
        const posts = Array.isArray(postsResult) ? postsResult : [];
        const postsUseful = hasUsefulPosts(posts);
        if (!summaryUseful && !postsUseful) {
            console.warn(`[LI Message] scrape returned empty (profile=${describeLiSummary(profileSummary)}, posts=${posts.length}) - not persisting`);
            return res.status(502).json({
                success: false,
                error: 'LinkedIn scrape came back empty - Apify may be throttled on this URL. Try again in a few minutes.',
            });
        }

        // Existing-lead mode: persist back so subsequent regenerates skip Apify.
        let updatedLead = leadRec;
        if (mode_existingLead && leadRec) {
            try {
                updatedLead = await upsertLeadInCompany(companyId, apolloId, {
                    liSummary: profileSummary,
                    liPosts: posts,
                    liScrapedAt: Date.now(),
                });
                console.log(`[LI Message] persisted LI scrape to companies.json (${posts.length} posts)`);
            } catch (err) {
                console.warn(`[LI Message] persist failed (non-fatal): ${err.message}`);
            }
        }

        console.log(`[LI Message] scrape done in ${Date.now() - startedAt}ms | posts=${posts.length}`);
        return res.json({
            success: true,
            profileSummary,
            posts,
            lead: updatedLead,
            companyName: companyRec?.name || null,
        });
    } catch (err) {
        console.error(`[LI Message] scrape failed after ${Date.now() - startedAt}ms:`, err.message);
        return res.status(500).json({ success: false, error: err.message || 'Scrape failed' });
    }
});

router.post('/email', trackActivity('li_message_generated'), async (req, res) => {
    const {
        profileSummary,
        posts,
        linkedinUrl,
        icpId,
        templateId,
        senderId,
        companyId,
        apolloId,
        lead: leadFromClient,
        classification: classificationFromClient,
        customInstruction,
    } = req.body || {};

    if (!profileSummary && (!Array.isArray(posts) || posts.length === 0)) {
        return res.status(400).json({ success: false, error: 'profileSummary or posts is required - scrape first' });
    }

    const startedAt = Date.now();

    // Resolve template - same priority chain as /api/email, but scoped to
    // the 'linkedin' channel first. suggestTemplate's two-pass logic
    // (channel-first, then cross-channel) means an ICP without an LI template
    // still resolves to its email twin rather than failing - safe during
    // rollout where some ICPs may not have LI counterparts yet. We surface
    // the resolved template's channel in the response so the frontend can
    // hint "this is using an email template - create an LI variant for
    // sharper output".
    let template = null;
    let resolutionSource = 'fallback';
    if (templateId) {
        template = getTemplate(templateId);
        if (!template) return res.status(400).json({ success: false, error: `template "${templateId}" not found` });
        resolutionSource = `explicit templateId=${templateId}`;
    } else if (icpId) {
        template = suggestTemplate({ icpId, channel: 'linkedin' });
        resolutionSource = `ICP suggest (icp=${icpId}, channel=linkedin)`;
    } else if (senderId) {
        // Legacy senderId lookup - prefer LI templates over email, but fall
        // through if the sender only has an email template registered.
        const liByName = listTemplates({ channel: 'linkedin' })
            .find(t => (t.sender?.firstName || '').toLowerCase() === senderId.toLowerCase());
        const anyByName = liByName || listTemplates()
            .find(t => (t.sender?.firstName || '').toLowerCase() === senderId.toLowerCase());
        if (anyByName) template = getTemplate(anyByName.id);
        resolutionSource = `legacy senderId=${senderId}${liByName ? '' : ' (no LI match, fell back to email)'}`;
    }
    if (!template) {
        // Final fallback - prefer the LI Bluebird-Fazal template; fall through
        // to the email twin if the LI seed hasn't been migrated in yet.
        template = getTemplate('fazal-bluebird-li') || getTemplate('fazal-bluebird') || getTemplate('bluebird-fazal');
        resolutionSource += ' → fallback Fazal/Bluebird';
    }
    console.log(`[LI Message] template resolved via ${resolutionSource}: "${template?.name}" channel=${template?.channel || 'email'}`);

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

    // Build the lead object the prompt builder expects. For existing-lead
    // mode, we trust the row from companies.json. For paste-URL mode, we
    // synthesize a minimal lead from the LI profile so the prompt still
    // gets a name/title.
    let workingLead;
    if (companyId && apolloId) {
        const found = await findLead(companyId, apolloId);
        if (!found) return res.status(404).json({ success: false, error: 'Lead not found' });
        workingLead = {
            ...found.lead,
            liSummary: profileSummary || found.lead.liSummary,
            liPosts: Array.isArray(posts) ? posts : found.lead.liPosts,
            liScrapedAt: Date.now(),
        };
    } else {
        // Paste-URL mode - derive name + title from the scraped profile.
        const name = profileSummary?.name || '';
        const [firstName, ...rest] = name.split(/\s+/);
        workingLead = leadFromClient ? { ...leadFromClient } : {
            firstName: firstName || 'there',
            lastName: rest.join(' ') || '',
            title: profileSummary?.headline || profileSummary?.current || '',
            email: null,
            emailStatus: null,
            linkedinUrl: linkedinUrl || null,
            hasEmail: false,
            apolloId: null,
        };
        workingLead.liSummary = profileSummary;
        workingLead.liPosts = Array.isArray(posts) ? posts : [];
        workingLead.liScrapedAt = Date.now();
    }

    // Classification: caller may pass one (paste-URL mode where they typed
    // a company name), otherwise we lean on the company record (existing-
    // lead mode) or build a minimal one from the LI profile.
    let classification = classificationFromClient || null;
    if (!classification && companyId) {
        try {
            const data = await readAll();
            const company = data.companies.find(c => c.id === companyId);
            if (company) {
                // Prefer the ICP-pinned classification if one matches the
                // active icpId, else any classification on file.
                const pinned = (icpId && company.classifications?.[icpId]) || company.classification || null;
                classification = pinned ? {
                    ...pinned,
                    name: company.name || pinned.name,
                    domain: company.domain || pinned.domain,
                    city: company.city || pinned.city,
                } : {
                    name: company.name || '',
                    domain: company.domain || '',
                    city: company.city || '',
                };
            }
        } catch { /* non-fatal */ }
    }
    if (!classification) {
        // Last-resort: synthesize from LI signals so the prompt isn't blank.
        classification = {
            name: profileSummary?.current?.split(' at ').pop() || '',
            domain: '',
            city: profileSummary?.location || '',
            tagline: profileSummary?.headline || '',
            signals: [],
            fleetVehicleTypes: [],
            languages: [],
            hasOnlineBooking: false,
            bookingPlatformHints: [],
        };
    }

    try {
        const messages = buildEmailPrompt({ classification, lead: workingLead, sender, template });

        // Operator's custom instruction (if any). Treated as the highest-
        // priority directive: appended to BOTH the system message (authority)
        // and the very end of the user message (recency) so the model honors
        // it even when it conflicts with the template's default voice,
        // structure, or cold-outreach framing. The ONLY thing it can't
        // override is the JSON output format (the parser depends on it).
        if (customInstruction && typeof customInstruction === 'string' && customInstruction.trim()) {
            const trimmed = customInstruction.trim().slice(0, 800);
            messages[0].content += `\n\nOPERATOR INSTRUCTION - HIGHEST PRIORITY. This is a direct, required instruction from the human operator:\n"${trimmed}"\nYou MUST follow it, even if it conflicts with the voice, tone, structure, length, or content rules above (e.g. the "new outreach / no prior contact" framing). Do not soften, water down, or omit it. The ONLY rule it cannot override is the JSON output format.`;
            messages[messages.length - 1].content += `\n\nReminder before you write: apply the operator instruction as a hard requirement - "${trimmed}".`;
        }

        const raw = await chat(messages, { task: 'email', temperature: 0.6, response_format: { type: 'json_object' } });
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            return res.status(502).json({ success: false, error: 'Email generator returned invalid JSON', raw: raw.slice(0, 500) });
        }
        if (!parsed.subject || !parsed.body) {
            return res.status(502).json({ success: false, error: 'Email generator returned incomplete payload', received: parsed });
        }

        // Strip em dashes the model may emit despite the prompt - we never
        // want them in outbound copy. Hyphen is the in-house substitute.
        parsed.subject = parsed.subject.replace(/—/g, '-');
        parsed.body = parsed.body.replace(/—/g, '-');

        console.log(`[LI Message] ✓ END ${Date.now() - startedAt}ms | subject="${parsed.subject.slice(0, 60)}"`);
        return res.json({
            success: true,
            email: parsed,
            lead: workingLead,
            sender: { id: sender.id, name: sender.name, signoff: sender.signoff },
            template: template ? {
                id: template.id,
                name: template.name,
                portfolioCompany: template.portfolioCompany,
                language: template.language,
                // Echo back the resolved template's channel so the LI page
                // can show a "using an email template - create an LI variant
                // to tighten the output" hint when the cross-channel fallback
                // fires (icp had no linkedin template, fell back to email).
                channel: template.channel || 'email',
            } : null,
            warnings: [],
        });
    } catch (err) {
        console.error(`[LI Message] email gen failed after ${Date.now() - startedAt}ms:`, err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Email generation failed' });
    }
});

module.exports = router;