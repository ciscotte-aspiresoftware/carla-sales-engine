// POST /api/classify
// Body: { url: string, icpId: string }
//
// ICP-aware single-URL classify for the Sales Agent. Always classifies the
// URL against ONE specific ICP's prompt - there is no generic "is this a
// car rental" path anymore. Flow:
//   1. Reuse the disk scrape-cache (keyed by domain). A page we've already
//      scraped - by the background sweep or a prior analyze - doesn't need
//      re-fetching; its markdown is good for any ICP in the vertical. This
//      makes "analyze a company we've already seen" nearly free (GPT only).
//   2. On a cache miss, Firecrawl scrape + write the result to the cache so
//      the next ICP (or sweep) reuses it.
//   3. GPT classify against icp.classifyPrompt → { is_match, reason }.
//   4. Harvest contacts + (optionally) generate the per-ICP markdown report.
//   5. Persist under classifications[icpId] via upsertCompany.
//
// Returns { success, companyId, icpId, classification, contacts, fromCache }.
// A not-a-match verdict is NOT an error - the frontend shows an override
// popup so the rep can skip, try another ICP, or override to qualified.

const express = require('express');
const { scrapeUrl } = require('../utils/firecrawl');
const { chat } = require('../utils/openai');
const { upsertCompany, readAll } = require('./companies');
const { getAi } = require('../utils/settings');
const { extractContacts, hasAnyContact } = require('../utils/contact-extractor');
const { getIcpFull } = require('../utils/icps');
const scrapeCache = require('../utils/scrape-cache');
const { generateCompanyReport } = require('../utils/report-generator');

const router = express.Router();

function extractDomain(rawUrl) {
    try {
        const u = new URL(rawUrl);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

// GPT classify against an ICP's prompt → { is_match, reason, key_quotes, signals }.
// Mirrors the sweep pipeline's classifier exactly so the Sales Agent and the
// background sweep agree on a verdict for the same page + ICP. The extended
// schema (key_quotes + signals) is appended to the system prompt so it lands
// in the SAME GPT response - no extra call, no extra cost.
const CLASSIFY_EXTENDED_SCHEMA = `

Also include in the SAME JSON response (no separate call needed):
- "key_quotes": array of up to 3 verbatim excerpts taken directly from the page content (max 120 chars each, do not paraphrase). These should be the strongest sentences that anchor your verdict.
- "signals": array of up to 5 short notable facts from the page (e.g. "Offers online booking", "Founded 2003", "5 store locations", "Mentions Mews integration").
If the page is uninformative, return empty arrays for both.`;

async function classifyAgainstIcp(markdown, pageTitle, classifyPrompt) {
    if (!markdown) return { is_match: false, reason: 'no markdown returned from scraper', key_quotes: [], signals: [] };
    const trimmed = markdown.length > 12000 ? markdown.slice(0, 12000) : markdown; // cap context

    const messages = [
        { role: 'system', content: classifyPrompt + CLASSIFY_EXTENDED_SCHEMA },
        { role: 'user', content: `Page title: ${pageTitle || '(none)'}\n\nPage content:\n${trimmed}` },
    ];
    const raw = await chat(messages, {
        model: getAi().classifyModel,
        temperature: 0.2, // low - deterministic structured output
        response_format: { type: 'json_object' },
    });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { is_match: false, reason: `classifier returned non-JSON: ${raw.slice(0, 100)}`, key_quotes: [], signals: [] }; }
    const cleanArr = (x, max, cap) => Array.isArray(x)
        ? x.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, max)).slice(0, cap)
        : [];
    return {
        is_match: !!parsed.is_match,
        reason: parsed.reason || (parsed.is_match ? 'matched' : 'rejected'),
        key_quotes: cleanArr(parsed.key_quotes, 120, 3),
        signals: cleanArr(parsed.signals, 140, 5),
    };
}

router.post('/', async (req, res) => {
    const { url, icpId, force } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
    }
    if (!icpId || typeof icpId !== 'string') {
        return res.status(400).json({ success: false, error: 'icpId is required - pick an ICP to classify against' });
    }
    const icp = getIcpFull(icpId);
    if (!icp) return res.status(404).json({ success: false, error: `ICP "${icpId}" not found` });
    if (!icp.classifyPrompt) {
        return res.status(400).json({ success: false, error: `ICP "${icpId}" has no classify prompt configured` });
    }

    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;
    const domain = extractDomain(normalizedUrl);

    const startedAt = Date.now();
    console.log(`[Classify] ▶ START url=${normalizedUrl} icp=${icpId}`);

    try {
        // Step 0: stored-result short-circuit. If this ICP has already
        // classified this company, serve the saved verdict + report instantly
        // - no scrape, no GPT. The rep can force a fresh run with force=true
        // (the "Re-classify" button) to pick up edits to the ICP prompt.
        // Only short-circuits on a real boolean verdict; incomplete records
        // (is_match=null from a no-website / scrape-error sweep) fall through
        // to a proper classify.
        if (!force && domain) {
            try {
                const data = await readAll();
                const existing = data.companies.find(c => (c.domain || '').toLowerCase() === domain);
                const stored = existing && existing.classifications && existing.classifications[icpId];
                if (stored && typeof stored.is_match === 'boolean') {
                    const classification = {
                        ...stored,
                        name: stored.name || stored.title || existing.domain,
                        domain: existing.domain,
                    };
                    console.log(`[Classify] ✓ STORED hit for ${domain} under ${icpId} (${stored.is_match ? 'qualified' : 'rejected'}${stored.report ? ', has report' : ''}) - no scrape/GPT`);
                    return res.json({
                        success: true,
                        companyId: existing.id,
                        icpId,
                        classification,
                        contacts: existing.scrapedContacts || null,
                        fromCache: true,
                        fromStored: true,
                    });
                }
            } catch (lookupErr) {
                console.warn(`[Classify]   ⚠ stored-result lookup failed (non-fatal): ${lookupErr.message}`);
            }
        }

        // Step 1: scrape - cache first. Reusing a prior scrape skips the most
        // expensive step entirely; we only pay GPT to re-classify under the
        // new ICP.
        let markdown = '';
        let pageTitle = '';
        let fromCache = false;
        const cached = domain ? await scrapeCache.get(domain) : null;
        if (cached && cached.markdown) {
            markdown = cached.markdown;
            pageTitle = cached.pageTitle || '';
            fromCache = true;
            console.log(`[Classify]   ├─ scrape CACHE-HIT domain=${domain} (${markdown.length} chars)`);
        } else {
            console.log(`[Classify]   ├─ scraping via Firecrawl…`);
            const scrapeStarted = Date.now();
            const scrape = await scrapeUrl(normalizedUrl);
            markdown = scrape?.markdown || scrape?.data?.markdown || '';
            pageTitle = scrape?.metadata?.title || scrape?.data?.metadata?.title || '';
            console.log(`[Classify]   ├─ scraped in ${Date.now() - scrapeStarted}ms (${markdown.length} chars, title="${pageTitle || '(none)'}")`);
            // Persist so a sibling ICP / future sweep reuses this markdown.
            if (markdown && domain) {
                try {
                    await scrapeCache.put(domain, {
                        vertical: icp.vertical || null,
                        url: normalizedUrl,
                        pageTitle,
                        markdown,
                        scrapedAt: Date.now(),
                    });
                } catch (cacheErr) {
                    console.warn(`[Classify]   ⚠ scrape-cache write failed (non-fatal): ${cacheErr.message}`);
                }
            }
        }

        if (!markdown) {
            console.warn(`[Classify] ✗ END no-markdown url=${normalizedUrl}`);
            return res.status(502).json({ success: false, error: 'Firecrawl returned no markdown - site may block scraping or be empty' });
        }

        // Step 2: classify against the chosen ICP's prompt.
        console.log(`[Classify]   ├─ classifying via GPT (${getAi().classifyModel})…`);
        const classifyStarted = Date.now();
        const verdict = await classifyAgainstIcp(markdown, pageTitle, icp.classifyPrompt);
        console.log(`[Classify]   ├─ classified in ${Date.now() - classifyStarted}ms | verdict: ${verdict.is_match ? '✓ MATCH' : '✗ no-match'} - ${verdict.reason}`);

        // Step 3: harvest contacts (emails/phones/LinkedIn) - free fallback
        // to Apollo, often the only reachable contact for a micro-business.
        const contacts = extractContacts(markdown);
        if (hasAnyContact(contacts)) {
            console.log(`[Classify]   ├─ contacts: ${contacts.emails.length} email, ${contacts.phones.length} phone, ${contacts.linkedinPersonUrls.length + contacts.linkedinCompanyUrls.length} LinkedIn`);
        }

        // Step 4: optional per-ICP markdown report (matched → full template,
        // rejected → short why-rejected). Only when the ICP opts in.
        let report = null;
        if (icp.reportEnabled) {
            report = await generateCompanyReport({
                markdown, pageTitle, icp,
                isMatch: verdict.is_match,
                reason: verdict.reason,
            });
        }

        const classification = {
            is_match: verdict.is_match,
            reason: verdict.reason,
            // name/domain feed the downstream Apollo lead search; title is
            // kept too since the sweep-written records use that field.
            name: pageTitle || domain,
            title: pageTitle || domain,
            domain,
            // Verbatim excerpts + signals from the same GPT call (no extra cost).
            // Drive "the website literally says: …" rendering on the company detail.
            key_quotes: verdict.key_quotes || [],
            signals: verdict.signals || [],
            sourceUrl: normalizedUrl,
            report: report || undefined,
        };

        // Step 5: persist under classifications[icpId].
        try {
            const saved = await upsertCompany({
                url: normalizedUrl,
                domain,
                icpId,
                vertical: icp.vertical || null,
                classification,
                scrapedAt: Date.now(),
                source: `${icpId}:sales-agent`,
                scrapedContacts: hasAnyContact(contacts) ? contacts : null,
            });
            const stored = (saved.classifications && saved.classifications[icpId]) || classification;
            console.log(`[Classify] ✓ END ${Date.now() - startedAt}ms total | companyId=${saved.id} | ${verdict.is_match ? 'qualified' : 'rejected'}${fromCache ? ' (cache)' : ''}`);
            return res.json({ success: true, companyId: saved.id, icpId, classification: stored, contacts, fromCache });
        } catch (persistErr) {
            console.warn('[Classify] ⚠ persist failed (non-fatal):', persistErr.message);
            return res.json({ success: true, icpId, classification, contacts, fromCache, persistWarning: persistErr.message });
        }
    } catch (err) {
        console.error(`[Classify] ✗ END error after ${Date.now() - startedAt}ms:`, err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Classify failed' });
    }
});

module.exports = router;
