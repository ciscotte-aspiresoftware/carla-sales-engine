// Scrapingdog Google Maps wrapper.
// Two endpoints, both costing 5 credits per call:
//   - /google_maps         → list of places at a location (discovery)
//   - /google_maps/places  → full record for one place by data_id (qualification)
// They're meant to be used together: Search once per city scan, Places only
// on the specific rows the salesperson cares about.

const axios = require('axios');

const API_KEY = process.env.SCRAPINGDOG_API_KEY;
const BASE = 'https://api.scrapingdog.com';

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
    if (!API_KEY) throw new Error('SCRAPINGDOG_API_KEY missing');

    const params = {
        api_key: API_KEY,
        query,
        ll,
        page: String(page),
        domain: domain || 'google.com',
        language: language || 'en',
        country: (country || 'us').toLowerCase(),
    };

    console.log(`[Scrapingdog] /google_maps query="${query}" ll=${ll} page=${page}`);
    const res = await axios.get(`${BASE}/google_maps`, { params, timeout: 30000 });
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
    if (!API_KEY) throw new Error('SCRAPINGDOG_API_KEY missing');
    if (!dataId) throw new Error('dataId required');

    const params = {
        api_key: API_KEY,
        type: 'place',
        data_id: dataId,
    };

    console.log(`[Scrapingdog] /google_maps/places data_id=${dataId}`);
    const res = await axios.get(`${BASE}/google_maps/places`, { params, timeout: 30000 });
    const place = res.data?.place_results || null;
    console.log(`[Scrapingdog] /google_maps/places ${place ? 'found' : 'no result'}`);
    return { place, raw: res.data };
}

module.exports = { searchMaps, getPlaceDetails };
