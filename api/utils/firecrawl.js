// Firecrawl wrapper for the Bluebird API.
//
// Two modes, picked at call time from Admin settings (utils/settings.js):
//
//   'scrape' (default) - single page. Cheap (~1 credit) and sufficient for
//                        most classifications. Returns Firecrawl's raw
//                        scrapeUrl response.
//
//   'crawl'            - multi-page crawl up to crawlMaxPages. Costs N×
//                        more credits and adds wall time. The pages'
//                        markdown is concatenated with `---` separators
//                        and returned in the SAME shape as scrape mode so
//                        downstream callers (classify route, sweep
//                        pipeline) don't need to know which path ran.
//
// Both modes rotate through the configured FIRECRAWL_API_KEY[_2..5] env
// vars on credit/auth errors so a key running dry doesn't bring down the
// sweep.

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const { getFirecrawl } = require('./settings');

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

// Bump the rotating-key pointer when a key runs into credit/rate errors so
// the next call lands on a fresh key. Shared between scrape and crawl.
function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % FIRECRAWL_KEYS.length;
}

function isCreditOrRateError(err) {
    const status = err?.response?.status || err?.statusCode;
    const errText = JSON.stringify(err?.response?.data || err?.message || '').toLowerCase();
    return status === 402 || status === 403
        || /insufficient.credits|no credits|credits.exhausted|billing|payment|quota|rate.limit/i.test(errText);
}

// Single-page scrape. Same body as the original implementation - kept
// callable directly for any path that wants to force single-page even when
// Admin is in crawl mode (no current call sites do, but useful escape
// hatch).
async function scrapeOnePage(url, options = {}) {
    if (FIRECRAWL_KEYS.length === 0) throw new Error('FIRECRAWL_API_KEY not configured');
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
            console.log(`[Firecrawl] scrape ${url} via key ${idx + 1} (${response?.markdown?.length || 0} md chars)`);
            return response;
        } catch (err) {
            if (isCreditOrRateError(err) && FIRECRAWL_KEYS.length > 1) {
                rotateKey();
                console.warn(`[Firecrawl] Key ${idx + 1} hit credit/rate limit - rotating to key ${currentKeyIndex + 1}`);
                continue;
            }
            throw err;
        }
    }
    throw new Error('All Firecrawl API keys exhausted');
}

// Multi-page crawl. Calls Firecrawl's crawlUrl, which fans out across the
// site up to `limit` pages and returns when complete. The pages come back
// as an array `{ data: [{ markdown, metadata }, ...] }`; we concatenate
// their markdown with separators and re-shape into the same response
// `{ markdown, metadata }` shape scrape mode returns, so downstream
// callers don't branch on mode.
async function crawlSite(url, maxPages, options = {}) {
    if (FIRECRAWL_KEYS.length === 0) throw new Error('FIRECRAWL_API_KEY not configured');
    const triedThisRequest = new Set();
    const limit = Math.max(1, Math.min(parseInt(maxPages, 10) || 10, 250));

    while (triedThisRequest.size < FIRECRAWL_KEYS.length) {
        const idx = currentKeyIndex;
        triedThisRequest.add(idx);
        const firecrawl = new FirecrawlApp({ apiKey: FIRECRAWL_KEYS[idx] });
        try {
            // SDK v1: crawlUrl returns when the crawl completes (or
            // status='scraping' polled internally). data is the page array.
            const response = await firecrawl.crawlUrl(url, {
                limit,
                scrapeOptions: {
                    formats: ['markdown'],
                    onlyMainContent: true,
                },
                ...options,
            });
            const pages = Array.isArray(response?.data) ? response.data : [];
            if (pages.length === 0) {
                // Treat empty crawl like a failed scrape so callers can
                // fall back to error handling rather than getting blank.
                console.warn(`[Firecrawl] crawl ${url} returned 0 pages via key ${idx + 1}`);
                return { markdown: '', metadata: { title: '' }, _crawl: { pages: 0 } };
            }
            const totalChars = pages.reduce((s, p) => s + (p?.markdown?.length || 0), 0);
            console.log(`[Firecrawl] crawl ${url} via key ${idx + 1} (${pages.length} pages, ${totalChars} md chars)`);

            const sections = pages.map((p, i) => {
                const title = p?.metadata?.title || `Page ${i + 1}`;
                const sourceUrl = p?.metadata?.sourceURL || p?.metadata?.url || '';
                const header = `# ${title}${sourceUrl ? `\n${sourceUrl}` : ''}`;
                return `${header}\n\n${p?.markdown || ''}`.trim();
            });
            const combinedMarkdown = sections.join('\n\n---\n\n');
            // Pin the metadata to the first page (typically the landing
            // page) so any caller reading metadata.title gets the site's
            // primary title.
            const metadata = pages[0]?.metadata || { title: '' };
            return {
                markdown: combinedMarkdown,
                metadata,
                _crawl: { pages: pages.length, totalChars },
            };
        } catch (err) {
            if (isCreditOrRateError(err) && FIRECRAWL_KEYS.length > 1) {
                rotateKey();
                console.warn(`[Firecrawl] crawl key ${idx + 1} hit credit/rate limit - rotating to key ${currentKeyIndex + 1}`);
                continue;
            }
            throw err;
        }
    }
    throw new Error('All Firecrawl API keys exhausted');
}

// Public entry point. Picks scrape vs crawl based on current Admin
// settings; both branches return the same `{ markdown, metadata }` shape
// so call sites don't need to know which ran.
async function scrapeUrl(url, options = {}) {
    const cfg = getFirecrawl();
    if (cfg.mode === 'crawl') {
        return crawlSite(url, cfg.crawlMaxPages, options);
    }
    return scrapeOnePage(url, options);
}

module.exports = { scrapeUrl, scrapeOnePage, crawlSite };
