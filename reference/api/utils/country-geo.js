// Loads the Natural Earth 110m country polygon GeoJSON once and caches it
// in memory. Used by the Tier-2 country-fill seeder to filter generated
// hex points down to those actually on land (no Atlantic, no Gulf, no
// inland seas). Without this the bbox approach plants ~30 % of cells on
// water for the UK and ~15 % for the US.
//
// Same GeoJSON the frontend globe uses, so the visual + the cell mask
// stay consistent. Fetched on first need (lazy) so the API doesn't pay
// the network cost at startup.

const COUNTRIES_GEOJSON_URL =
    'https://raw.githubusercontent.com/vasturiano/react-globe.gl/master/example/datasets/ne_110m_admin_0_countries.geojson';

// Our country.code values (UK/US/CA) → Natural Earth's ISO_A2 codes.
// UK is the historical odd one - ISO uses GB. Add new mappings here as
// we expand the COUNTRIES list in countries.js.
const CODE_MAP = {
    UK: 'GB',
    US: 'US',
    CA: 'CA',
};

let cache = null;        // GeoJSON FeatureCollection once loaded
let inflight = null;     // dedupes concurrent fetches at startup

async function loadAll() {
    if (cache) return cache;
    if (inflight) return inflight;
    inflight = fetch(COUNTRIES_GEOJSON_URL)
        .then(r => r.json())
        .then(data => {
            cache = data;
            return data;
        })
        .catch(err => {
            console.warn('[CountryGeo] fetch failed:', err.message);
            inflight = null;
            return null;
        });
    return inflight;
}

// Find a country feature by our internal code. Returns null if the
// GeoJSON failed to load or the code is unmapped - caller should treat
// that as "skip the polygon filter, fall back to bbox".
async function getCountryFeature(code) {
    const iso = CODE_MAP[String(code || '').toUpperCase()];
    if (!iso) return null;
    const geo = await loadAll();
    if (!geo || !Array.isArray(geo.features)) return null;
    return geo.features.find(f => {
        const p = f.properties || {};
        // Natural Earth uses ISO_A2 normally, but some features have it
        // set to "-99" (disputed/unset) and rely on ISO_A2_EH. Check both.
        return p.ISO_A2 === iso || p.ISO_A2_EH === iso;
    }) || null;
}

module.exports = { loadAll, getCountryFeature };
