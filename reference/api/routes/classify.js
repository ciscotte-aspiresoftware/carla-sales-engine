// POST /api/classify
// Body: { url: string }
// Flow: Firecrawl scrape → OpenAI classifier → returns parsed structured data.
// Also persists the company snapshot to companies.json so the demo has a
// browsable history without a real DB.

const express = require('express');
const { scrapeUrl } = require('../utils/firecrawl');
const { chat } = require('../utils/openai');
const { buildClassifierPrompt } = require('../prompts/classify');
const { upsertCompany } = require('./companies');
const mode = require('../utils/mode');
const { classifyStub } = require('../utils/demo-stubs');

const router = express.Router();

function extractDomain(rawUrl) {
    try {
        const u = new URL(rawUrl);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
}

router.post('/', async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
    }
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;

    const startedAt = Date.now();
    console.log(`[Classify] ▶ START url=${normalizedUrl}${mode.isDemo() ? ' (demo mode)' : ''}`);

    // Demo short-circuit: hand back a UI-functional stub without spending
    // Firecrawl/OpenAI credits. Still persists so downstream leads/email
    // calls can find the company by id.
    if (mode.isDemo()) {
        const stub = classifyStub(normalizedUrl);
        try {
            const saved = await upsertCompany({
                url: normalizedUrl,
                domain: stub.domain,
                classification: stub,
                scrapedAt: Date.now(),
                source: 'demo-stub',
            });
            console.log(`[Classify] ✓ END ${Date.now() - startedAt}ms (stub) | companyId=${saved.id}`);
            return res.json({ success: true, companyId: saved.id, classification: stub, demo: true });
        } catch (err) {
            console.warn(`[Classify] ⚠ stub persist failed: ${err.message}`);
            return res.json({ success: true, classification: stub, demo: true });
        }
    }

    try {
        // Step 1: scrape
        console.log(`[Classify]   ├─ scraping via Firecrawl…`);
        const scrapeStarted = Date.now();
        const scrape = await scrapeUrl(normalizedUrl);
        const markdown = scrape?.markdown || scrape?.data?.markdown || '';
        const pageTitle = scrape?.metadata?.title || scrape?.data?.metadata?.title || '';
        console.log(`[Classify]   ├─ scraped in ${Date.now() - scrapeStarted}ms (${markdown.length} chars, title="${pageTitle || '(none)'}")`);

        if (!markdown) {
            console.warn(`[Classify] ✗ END no-markdown url=${normalizedUrl}`);
            return res.status(502).json({ success: false, error: 'Firecrawl returned no markdown - site may block scraping or be empty' });
        }

        // Step 2: classify via OpenAI
        console.log(`[Classify]   ├─ classifying via GPT…`);
        const classifyStarted = Date.now();
        const messages = buildClassifierPrompt({ url: normalizedUrl, markdown, pageTitle });
        const raw = await chat(messages, {
            temperature: 0.2, // low - we want deterministic structured output
            response_format: { type: 'json_object' },
        });
        console.log(`[Classify]   ├─ classified in ${Date.now() - classifyStarted}ms`);

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            console.error('[Classify] ✗ END non-JSON-response:', raw.slice(0, 200));
            return res.status(502).json({ success: false, error: 'Classifier returned invalid JSON', raw: raw.slice(0, 500) });
        }

        // Backfill domain if the model didn't populate it (common when the
        // prompt is unclear or the URL is a subdomain).
        if (!parsed.domain) parsed.domain = extractDomain(normalizedUrl);

        const verdict = parsed.isCarRental ? '✓ MATCH' : '✗ no-match';
        console.log(`[Classify]   ├─ verdict: ${verdict} | name="${parsed.name || '(unknown)'}" | confidence=${parsed.confidence || '?'}`);

        // Persist a snapshot - the leads/email steps will read these later
        // for any history view we add. Failure to persist is non-fatal.
        try {
            const saved = await upsertCompany({
                url: normalizedUrl,
                domain: parsed.domain,
                classification: parsed,
                scrapedAt: Date.now(),
            });
            console.log(`[Classify] ✓ END ${Date.now() - startedAt}ms total | companyId=${saved.id} | domain=${parsed.domain}`);
            return res.json({ success: true, companyId: saved.id, classification: parsed });
        } catch (persistErr) {
            console.warn('[Classify] ⚠ persist failed (non-fatal):', persistErr.message);
            return res.json({ success: true, classification: parsed, persistWarning: persistErr.message });
        }
    } catch (err) {
        console.error(`[Classify] ✗ END error after ${Date.now() - startedAt}ms:`, err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Classify failed' });
    }
});

module.exports = router;
