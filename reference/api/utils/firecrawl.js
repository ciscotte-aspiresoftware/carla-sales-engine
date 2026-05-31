// Firecrawl wrapper for the Bluebird demo.
// Adapted from valsource's be-vms-checker/utils/firecrawl-helpers.js - same
// rotating-key pattern, but stripped of api-tracker (no telemetry sink in the
// demo) and using `scrapeUrl` for single-page scrapes since we only need the
// landing page for classification, not a multi-page crawl.

const FirecrawlApp = require('@mendable/firecrawl-js').default;

const FIRECRAWL_KEYS = [
    process.env.FIRECRAWL_API_KEY,
    process.env.FIRECRAWL_API_KEY_2,
    process.env.FIRECRAWL_API_KEY_3,
    process.env.FIRECRAWL_API_KEY_4,
    process.env.FIRECRAWL_API_KEY_5,
].filter(Boolean);

if (FIRECRAWL_KEYS.length === 0) {
    console.warn('[Firecrawl] No API keys configured - set FIRECRAWL_API_KEY in .env');
} else {
    console.log(`[Firecrawl] ${FIRECRAWL_KEYS.length} key(s) configured`);
}

let currentKeyIndex = 0;

/**
 * Scrape a single URL and return its markdown + extracted metadata.
 * Rotates to the next key on credit/auth failures, throws if all keys exhausted.
 */
async function scrapeUrl(url, options = {}) {
    if (FIRECRAWL_KEYS.length === 0) {
        throw new Error('FIRECRAWL_API_KEY not configured');
    }

    const triedThisRequest = new Set();
    const scrapeOpts = {
        formats: ['markdown'],
        onlyMainContent: true,
        ...options,
    };

    while (triedThisRequest.size < FIRECRAWL_KEYS.length) {
        const idx = currentKeyIndex;
        triedThisRequest.add(idx);
        const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEYS[idx] });

        try {
            const response = await firecrawl.scrapeUrl(url, scrapeOpts);
            console.log(`[Firecrawl] Scraped ${url} via key ${idx + 1} (${response?.markdown?.length || 0} md chars)`);
            return response;
        } catch (err) {
            const status = err.response?.status || err.statusCode;
            const errText = JSON.stringify(err.response?.data || err.message || '').toLowerCase();
            const isCreditError = status === 402 || status === 403 ||
                /insufficient.credits|no credits|credits.exhausted|billing|payment|quota|rate.limit/i.test(errText);

            if (isCreditError && FIRECRAWL_KEYS.length > 1) {
                currentKeyIndex = (currentKeyIndex + 1) % FIRECRAWL_KEYS.length;
                console.warn(`[Firecrawl] Key ${idx + 1} hit credit/rate limit - rotating to key ${currentKeyIndex + 1}`);
                continue;
            }

            throw err;
        }
    }

    throw new Error('All Firecrawl API keys exhausted');
}

module.exports = { scrapeUrl };
