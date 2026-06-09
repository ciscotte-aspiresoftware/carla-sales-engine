// Scrapingdog Google Maps wrapper.
// Two endpoints, both costing 5 credits per call:
//   - /google_maps         → list of places at a location (discovery)
//   - /google_maps/places  → full record for one place by data_id (qualification)
// They're meant to be used together: Search once per city scan, Places only
// on the specific rows the salesperson cares about.

const axios = require('axios');

const BASE = 'https://api.scrapingdog.com';

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

// GET against Scrapingdog with sticky key rotation. Injects api_key per
// attempt; on a credit/rate/auth error it rotates to the next key and
// retries within the same request, until one works or all are exhausted.
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
    const res = await getWithRotation('/google_maps', params);
    const results = res.data?.search_results || [];
    console.log(`[Scrapingdog] /google_maps returned ${results.length} places`);
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
    const res = await getWithRotation('/google_maps/places', params);
    const place = res.data?.place_results || null;
    console.log(`[Scrapingdog] /google_maps/places ${place ? 'found' : 'no result'}`);
    return { place, raw: res.data };
}

module.exports = { searchMaps, getPlaceDetails };
