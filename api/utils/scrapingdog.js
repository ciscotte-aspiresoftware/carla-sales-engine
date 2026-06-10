// Scrapingdog Google Maps wrapper.
// Two endpoints, both costing 5 credits per call:
//   - /google_maps         → list of places at a location (discovery)
//   - /google_maps/places  → full record for one place by data_id (qualification)
// They're meant to be used together: Search once per city scan, Places only
// on the specific rows the salesperson cares about.

const axios = require('axios');
const { recordUsage, priceService } = require('./api-cost');

const BASE = 'https://api.scrapingdog.com';

// Scrapingdog charges 5 credits per call on either endpoint.
const CREDITS_PER_CALL = 5;

// Sticky key rotation, same pattern as Firecrawl/Apify: stay on one key
// until it hits a credit/rate/auth wall, then advance to the next and stay
// there. Configure backups as SCRAPINGDOG_API_KEY_2.._5 in .env.
const SCRAPINGDOG_KEYS = [
    process.env.SCRAPINGDOG_API_KEY,
    process.env.SCRAPINGDOG_API_KEY_2,
    process.env.SCRAPINGDOG_API_KEY_3,
    process.env.SCRAPINGDOG_API_KEY_4,
    process.env.SCRAPINGDOG_API_KEY_5,
].filter(Boolean);

if (SCRAPINGDOG_KEYS.length === 0) {
    console.warn('[Scrapingdog] No API keys configured - set SCRAPINGDOG_API_KEY in .env');
} else {
    console.log(`[Scrapingdog] ${SCRAPINGDOG_KEYS.length} key(s) configured`);
}

// Pointer survives across calls; only advances on credit/rate/auth failure.
let currentKeyIndex = 0;

function isCreditOrRateError(err) {
    const status = err?.response?.status;
    const errText = JSON.stringify(err?.response?.data || err?.message || '').toLowerCase();
    return status === 402 || status === 403 || status === 429
        || /insufficient.credits|no credits|credits.exhausted|limit.exceeded|billing|payment|quota|rate.limit|too many requests/i.test(errText);
}

// Transient server-side errors from Scrapingdog's gateway. 502/503/504 are
// almost always a momentary upstream hiccup that recovers in < 1s. Without
// a retry, a single 502 fails the sweep cell which then auto-pauses the
// whole session - way too brittle for an external dependency we don't own.
function isTransientServerError(err) {
    const status = err?.response?.status;
    return typeof status === 'number' && status >= 500 && status <= 599;
}

// Sleep helper for the retry-on-same-key backoff. Tiny implementation
// kept here to avoid pulling in a util just for one call.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET against Scrapingdog with two layers of resilience:
//   1. Transient 5xx → retry ONCE on the same key after a 500ms backoff
//      (Scrapingdog gateway hiccups typically clear in < 1s)
//   2. Credit/rate limits → rotate to the next configured key
//   3. Transient 5xx that survives the retry → rotate to next key as a
//      last resort (different upstream POPs may not be in the same broken
//      state)
// Other errors propagate so the caller can decide what to do.
async function getWithRotation(path, params) {
    if (SCRAPINGDOG_KEYS.length === 0) throw new Error('SCRAPINGDOG_API_KEY missing');
    const tried = new Set();
    while (tried.size < SCRAPINGDOG_KEYS.length) {
        const idx = currentKeyIndex;
        tried.add(idx);
        try {
            return await axios.get(`${BASE}${path}`, {
                params: { ...params, api_key: SCRAPINGDOG_KEYS[idx] },
                timeout: 30000,
            });
        } catch (err) {
            // 5xx: retry once on the same key first. If it still fails,
            // fall through to the rotation path so a stuck POP doesn't
            // permanently park us.
            if (isTransientServerError(err)) {
                console.warn(`[Scrapingdog] Key ${idx + 1} got ${err.response?.status} - retrying in 500ms`);
                await sleep(500);
                try {
                    return await axios.get(`${BASE}${path}`, {
                        params: { ...params, api_key: SCRAPINGDOG_KEYS[idx] },
                        timeout: 30000,
                    });
                } catch (err2) {
                    if (SCRAPINGDOG_KEYS.length > 1) {
                        currentKeyIndex = (currentKeyIndex + 1) % SCRAPINGDOG_KEYS.length;
                        console.warn(`[Scrapingdog] Key ${idx + 1} 5xx survived retry - rotating to key ${currentKeyIndex + 1}/${SCRAPINGDOG_KEYS.length}`);
                        continue;
                    }
                    throw err2;
                }
            }
            if (isCreditOrRateError(err) && SCRAPINGDOG_KEYS.length > 1) {
                currentKeyIndex = (currentKeyIndex + 1) % SCRAPINGDOG_KEYS.length;
                console.warn(`[Scrapingdog] Key ${idx + 1} hit credit/rate limit - rotating to key ${currentKeyIndex + 1}/${SCRAPINGDOG_KEYS.length}`);
                continue;
            }
            throw err;
        }
    }
    throw new Error('All Scrapingdog API keys exhausted');
}

/**
 * Search a city for places matching `query`.
 * @param {object} args
 * @param {string} args.query - e.g. "car rental"
 * @param {string} args.ll - Scrapingdog ll string, e.g. "@43.6532,-79.3832,12z"
 * @param {string} args.country - ISO country code, e.g. "ca"
 * @param {string} args.language - language code, e.g. "en"
 * @param {string} args.domain - Google domain, e.g. "google.ca"
 * @param {number} args.page - 0 for first page, 20 for second, etc.
 * @returns {Promise<{ search_results: Array }>}
 */
async function searchMaps({ query, ll, country, language, domain, page = 0 }) {
    const params = {
        query,
        ll,
        page: String(page),
        domain: domain || 'google.com',
        language: language || 'en',
        country: (country || 'us').toLowerCase(),
    };

    console.log(`[Scrapingdog] /google_maps query="${query}" ll=${ll} page=${page}`);
    const startedAt = Date.now();
    const res = await getWithRotation('/google_maps', params);
    const durationMs = Date.now() - startedAt;
    const results = res.data?.search_results || [];
    console.log(`[Scrapingdog] /google_maps returned ${results.length} places`);
    recordUsage({
        service: 'scrapingdog',
        operation: 'maps_search',
        units: CREDITS_PER_CALL,
        usdCost: priceService('scrapingdog', CREDITS_PER_CALL),
        durationMs,
        metadata: { query, ll, page, returned: results.length },
    });
    return { results, raw: res.data };
}

/**
 * Get full details for a single place. Pricier per place (5 credits) but
 * scoped to one record - only call on rows the salesperson explicitly
 * picks for deep-dive.
 * @param {string} dataId - Place's data_id from a Search result
 * @returns {Promise<{ place_results: object }>}
 */
async function getPlaceDetails(dataId) {
    if (!dataId) throw new Error('dataId required');

    const params = {
        type: 'place',
        data_id: dataId,
    };

    console.log(`[Scrapingdog] /google_maps/places data_id=${dataId}`);
    const startedAt = Date.now();
    const res = await getWithRotation('/google_maps/places', params);
    const durationMs = Date.now() - startedAt;
    const place = res.data?.place_results || null;
    console.log(`[Scrapingdog] /google_maps/places ${place ? 'found' : 'no result'}`);
    recordUsage({
        service: 'scrapingdog',
        operation: 'place_details',
        units: CREDITS_PER_CALL,
        usdCost: priceService('scrapingdog', CREDITS_PER_CALL),
        durationMs,
        metadata: { data_id: dataId, found: !!place },
    });
    return { place, raw: res.data };
}

module.exports = { searchMaps, getPlaceDetails };
