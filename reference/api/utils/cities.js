// Prefilled city configs for the New Leads sourcing page.
// Constrained to English-speaking markets for v0: US, UK, Canada.
// Each entry carries the Scrapingdog `ll` coordinate string + country/domain
// + raw lat/lng so the globe picker can place a marker on it.
//
// Adding a city later: pull the lat/long from the URL on Google Maps, pick
// the country code, set the language to whatever Google should localize
// toward.

// Each city carries its center coordinate + metro_radius_km. The metro radius
// is what the grid seeder uses to figure out how many sub-cells to lay down
// over the city - bigger metros (London, NYC, LA) get more cells than small
// ones (Cambridge, Edinburgh). Default ~25 km covers a typical European
// metro; major US sprawl cities get bumped up to 35-40 km.
const CITIES = [
    // ─── United States ───────────────────────────────────────────────
    { key: 'newYork',      label: 'New York, NY',      country: 'US', domain: 'google.com',    language: 'en', lat: 40.7128, lng: -74.0060,  ll: '@40.7128,-74.0060,12z',   metro_radius_km: 35 },
    { key: 'losAngeles',   label: 'Los Angeles, CA',   country: 'US', domain: 'google.com',    language: 'en', lat: 34.0522, lng: -118.2437, ll: '@34.0522,-118.2437,12z',  metro_radius_km: 40 },
    { key: 'chicago',      label: 'Chicago, IL',       country: 'US', domain: 'google.com',    language: 'en', lat: 41.8781, lng: -87.6298,  ll: '@41.8781,-87.6298,12z',   metro_radius_km: 30 },
    { key: 'miami',        label: 'Miami, FL',         country: 'US', domain: 'google.com',    language: 'en', lat: 25.7617, lng: -80.1918,  ll: '@25.7617,-80.1918,12z',   metro_radius_km: 25 },
    { key: 'houston',      label: 'Houston, TX',       country: 'US', domain: 'google.com',    language: 'en', lat: 29.7604, lng: -95.3698,  ll: '@29.7604,-95.3698,12z',   metro_radius_km: 35 },
    { key: 'seattle',      label: 'Seattle, WA',       country: 'US', domain: 'google.com',    language: 'en', lat: 47.6062, lng: -122.3321, ll: '@47.6062,-122.3321,12z',  metro_radius_km: 25 },
    { key: 'boston',       label: 'Boston, MA',        country: 'US', domain: 'google.com',    language: 'en', lat: 42.3601, lng: -71.0589,  ll: '@42.3601,-71.0589,12z',   metro_radius_km: 25 },
    { key: 'denver',       label: 'Denver, CO',        country: 'US', domain: 'google.com',    language: 'en', lat: 39.7392, lng: -104.9903, ll: '@39.7392,-104.9903,12z',  metro_radius_km: 25 },
    // ─── United Kingdom ──────────────────────────────────────────────
    { key: 'london',       label: 'London, UK',        country: 'UK', domain: 'google.co.uk',  language: 'en', lat: 51.5074, lng: -0.1278,   ll: '@51.5074,-0.1278,12z',    metro_radius_km: 30 },
    { key: 'manchester',   label: 'Manchester, UK',    country: 'UK', domain: 'google.co.uk',  language: 'en', lat: 53.4808, lng: -2.2426,   ll: '@53.4808,-2.2426,12z',    metro_radius_km: 20 },
    { key: 'edinburgh',    label: 'Edinburgh, UK',     country: 'UK', domain: 'google.co.uk',  language: 'en', lat: 55.9533, lng: -3.1883,   ll: '@55.9533,-3.1883,12z',    metro_radius_km: 15 },
    { key: 'birmingham',   label: 'Birmingham, UK',    country: 'UK', domain: 'google.co.uk',  language: 'en', lat: 52.4862, lng: -1.8904,   ll: '@52.4862,-1.8904,12z',    metro_radius_km: 20 },
    { key: 'glasgow',      label: 'Glasgow, UK',       country: 'UK', domain: 'google.co.uk',  language: 'en', lat: 55.8642, lng: -4.2518,   ll: '@55.8642,-4.2518,12z',    metro_radius_km: 18 },
    // ─── Canada ──────────────────────────────────────────────────────
    { key: 'toronto',      label: 'Toronto, ON',       country: 'CA', domain: 'google.ca',     language: 'en', lat: 43.6532, lng: -79.3832,  ll: '@43.6532,-79.3832,12z',   metro_radius_km: 30 },
    { key: 'vancouver',    label: 'Vancouver, BC',     country: 'CA', domain: 'google.ca',     language: 'en', lat: 49.2827, lng: -123.1207, ll: '@49.2827,-123.1207,12z',  metro_radius_km: 25 },
    { key: 'calgary',      label: 'Calgary, AB',       country: 'CA', domain: 'google.ca',     language: 'en', lat: 51.0447, lng: -114.0719, ll: '@51.0447,-114.0719,12z',  metro_radius_km: 22 },
    { key: 'montreal',     label: 'Montreal, QC',      country: 'CA', domain: 'google.ca',     language: 'en', lat: 45.5017, lng: -73.5673,  ll: '@45.5017,-73.5673,12z',   metro_radius_km: 25 },
    // ─── Netherlands ─────────────────────────────────────────────────
    // Top 5 metros by population, plus Emmeloord (NedFox HQ - useful as
    // a sanity-check sweep location since their own staff are likely
    // listed in Maps results around there). All use google.nl with
    // Dutch-language search results.
    { key: 'amsterdam',    label: 'Amsterdam, NL',     country: 'NL', domain: 'google.nl',     language: 'nl', lat: 52.3676, lng: 4.9041,    ll: '@52.3676,4.9041,12z',     metro_radius_km: 20 },
    { key: 'rotterdam',    label: 'Rotterdam, NL',     country: 'NL', domain: 'google.nl',     language: 'nl', lat: 51.9244, lng: 4.4777,    ll: '@51.9244,4.4777,12z',     metro_radius_km: 20 },
    { key: 'theHague',     label: 'The Hague, NL',     country: 'NL', domain: 'google.nl',     language: 'nl', lat: 52.0705, lng: 4.3007,    ll: '@52.0705,4.3007,12z',     metro_radius_km: 18 },
    { key: 'utrecht',      label: 'Utrecht, NL',       country: 'NL', domain: 'google.nl',     language: 'nl', lat: 52.0907, lng: 5.1214,    ll: '@52.0907,5.1214,12z',     metro_radius_km: 15 },
    { key: 'eindhoven',    label: 'Eindhoven, NL',     country: 'NL', domain: 'google.nl',     language: 'nl', lat: 51.4416, lng: 5.4697,    ll: '@51.4416,5.4697,12z',     metro_radius_km: 15 },
    { key: 'emmeloord',    label: 'Emmeloord, NL',     country: 'NL', domain: 'google.nl',     language: 'nl', lat: 52.7106, lng: 5.7480,    ll: '@52.7106,5.7480,12z',     metro_radius_km: 12 },
    // ─── Ireland ─────────────────────────────────────────────────────
    // 10 NedFox active customers + €61K ARR sit primarily around Dublin
    // and the smaller cities. Tier-1 sweeps in these cities work without
    // populated-places.json - that file would need a GeoNames refresh
    // to enable Tier-2 country-fill mode for IE.
    { key: 'dublin',       label: 'Dublin, IE',        country: 'IE', domain: 'google.ie',     language: 'en', lat: 53.3498, lng: -6.2603,   ll: '@53.3498,-6.2603,12z',    metro_radius_km: 22 },
    { key: 'cork',         label: 'Cork, IE',          country: 'IE', domain: 'google.ie',     language: 'en', lat: 51.8985, lng: -8.4756,   ll: '@51.8985,-8.4756,12z',    metro_radius_km: 15 },
    { key: 'galway',       label: 'Galway, IE',        country: 'IE', domain: 'google.ie',     language: 'en', lat: 53.2707, lng: -9.0568,   ll: '@53.2707,-9.0568,12z',    metro_radius_km: 12 },
    { key: 'limerick',     label: 'Limerick, IE',      country: 'IE', domain: 'google.ie',     language: 'en', lat: 52.6638, lng: -8.6267,   ll: '@52.6638,-8.6267,12z',    metro_radius_km: 12 },
    // ─── Belgium ─────────────────────────────────────────────────────
    // 8 active NedFox customers concentrated in Flanders (Dutch-speaking
    // half). Brussels is bilingual but defaults to Dutch here since the
    // Maps language code only takes one value per cell. A future Wallonia-
    // specific ICP could override with French.
    { key: 'brussels',     label: 'Brussels, BE',      country: 'BE', domain: 'google.be',     language: 'nl', lat: 50.8503, lng: 4.3517,    ll: '@50.8503,4.3517,12z',     metro_radius_km: 18 },
    { key: 'antwerp',      label: 'Antwerp, BE',       country: 'BE', domain: 'google.be',     language: 'nl', lat: 51.2194, lng: 4.4025,    ll: '@51.2194,4.4025,12z',     metro_radius_km: 18 },
    { key: 'ghent',        label: 'Ghent, BE',         country: 'BE', domain: 'google.be',     language: 'nl', lat: 51.0543, lng: 3.7174,    ll: '@51.0543,3.7174,12z',     metro_radius_km: 14 },
    { key: 'bruges',       label: 'Bruges, BE',        country: 'BE', domain: 'google.be',     language: 'nl', lat: 51.2093, lng: 3.2247,    ll: '@51.2093,3.2247,12z',     metro_radius_km: 12 },
];

function getCity(key) {
    return CITIES.find(c => c.key === key) || null;
}

// Common aliases - local-language or shorthand names that should resolve
// to the same static-catalog entry as their canonical English label. Keep
// this list small; if it grows, move it into the CITIES rows themselves
// as an `aliases: []` field.
const CITY_ALIASES = {
    'den haag':   'theHague',          // Dutch name for The Hague
    "'s-gravenhage": 'theHague',       // formal Dutch name
    'amsterdam, the netherlands': 'amsterdam',
    'bruxelles':  'brussels',          // French name for Brussels
    'brussel':    'brussels',          // Dutch name for Brussels
    'antwerpen':  'antwerp',           // Dutch name for Antwerp
    'gent':       'ghent',             // Dutch name for Ghent
    'brugge':     'bruges',            // Dutch name for Bruges
    'baile átha cliath': 'dublin',     // Irish name for Dublin
};

// Lookup by case-insensitive name match against `key` or `label`.
// Useful for ICP configs that say `cities: ['London', 'Manchester']` -
// we don't want to force users to remember the camelCase keys.
function findCity(name) {
    if (!name) return null;
    const target = String(name).trim().toLowerCase();
    if (CITY_ALIASES[target]) return getCity(CITY_ALIASES[target]);
    return CITIES.find(c =>
        c.key.toLowerCase() === target ||
        c.label.toLowerCase() === target ||
        c.label.split(',')[0].trim().toLowerCase() === target
    ) || null;
}

// ─── Dynamic / geocoded city support ───────────────────────────────────────
// When an ICP references a city we don't have in the static CITIES catalog
// (e.g. "Bristol", "Karachi", "Lyon"), we transparently look it up via
// Nominatim (OpenStreetMap, free, no API key) and cache the result so future
// seeds skip the network hop. Means a user can type ANY city in their ICP
// definition and the seeder Just Works without anyone editing this file.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'geocoded-cities.json');

function readGeocodeCache() {
    if (!fs.existsSync(CACHE_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    } catch {
        return {};
    }
}

function writeGeocodeCache(cache) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// Convert Nominatim's boundingbox into a sensible metro radius. Half the
// diagonal of the bbox is roughly the city's geographic reach; cap at
// METRO_MAX so a Nominatim match against "Greater London" doesn't lay
// down 200 km of Tier-1 cells, floor at METRO_MIN so a tiny match like
// "Cambridge" still gets a respectable scan footprint.
const METRO_MIN_KM = 12;
const METRO_MAX_KM = 35;
function deriveMetroRadiusKm({ minLat, maxLat, minLng, maxLng }) {
    const KM_PER_DEG_LAT = 111;
    const centerLat = (minLat + maxLat) / 2;
    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
    const dLatKm = (maxLat - minLat) * KM_PER_DEG_LAT;
    const dLngKm = (maxLng - minLng) * kmPerDegLng;
    const diagonal = Math.hypot(dLatKm, dLngKm);
    const radius = diagonal / 2;
    return Math.max(METRO_MIN_KM, Math.min(METRO_MAX_KM, Math.round(radius)));
}

// Map Nominatim's address.country_code (lowercased ISO_A2) to our internal
// country code + Google domain + default search language. Anything not
// mapped falls back to US/com/en since most demo flows are English-speaking.
// Extend as we add countries.
const ISO_TO_INTERNAL = { gb: 'UK', us: 'US', ca: 'CA', nl: 'NL', ie: 'IE', be: 'BE' };
const INTERNAL_TO_DOMAIN = {
    US: 'google.com',
    UK: 'google.co.uk',
    CA: 'google.ca',
    NL: 'google.nl',
    IE: 'google.ie',
    BE: 'google.be',
};
// Default search language per internal country code. Used by the geocoder
// fallback to set `language` on the resolved city - this is what Scrapingdog
// passes through to Google Maps as the `hl` parameter, which controls the
// language of the returned place names + descriptions. Critical for
// non-English markets: a Dutch garden centre is far more likely to be
// indexed under "tuincentrum" than "garden centre", and Maps' relevance
// scoring is language-sensitive.
//
// Belgium is trilingual (NL/FR/DE); we default to NL since NedFox's BE
// customers are primarily Flemish. Wallonia (FR-speaking) coverage would
// need a separate ICP with French-language search terms - easy to add
// when we get there.
const INTERNAL_TO_LANGUAGE = { US: 'en', UK: 'en', CA: 'en', NL: 'nl', IE: 'en', BE: 'nl' };

async function geocodeCity(name) {
    // Photon (Komoot's hosted OSM geocoder) - free, no API key, friendlier
    // about non-browser clients than Nominatim. We tried Nominatim first and
    // got 403's almost immediately; Photon doesn't enforce the same
    // User-Agent policy and returns the same OSM data backing it. The
    // `osm_tag=place:city,place:town` filter biases results toward
    // populated places (avoids matching, e.g., "Cambridge United" the
    // football club, or a tiny hamlet of the same name).
    const q = encodeURIComponent(name);
    const url = `https://photon.komoot.io/api/?q=${q}&limit=1&osm_tag=place:city&osm_tag=place:town&osm_tag=place:village`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Photon ${res.status}`);
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    if (features.length === 0) return null;
    const hit = features[0];
    const coords = hit.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const props = hit.properties || {};
    // Photon's bbox is [west, north, east, south] = [minLng, maxLat, maxLng, minLat]
    const ext = Array.isArray(props.extent) ? props.extent.map(Number) : null;
    const metro_radius_km = (ext && ext.length === 4 && ext.every(Number.isFinite))
        ? deriveMetroRadiusKm({ minLat: ext[3], maxLat: ext[1], minLng: ext[0], maxLng: ext[2] })
        : 20; // sensible fallback when extent is missing (e.g. small towns)
    const iso = (props.countrycode || '').toLowerCase();
    const internal = ISO_TO_INTERNAL[iso] || 'US';
    // Build a friendly label like "Cambridge, England" or "Karachi, Sindh"
    // from whatever Photon gave us. props.name is the place name; state/
    // country fill in the qualifier.
    const labelParts = [props.name, props.state || props.country].filter(Boolean);
    const label = labelParts.join(', ') || String(name);
    return {
        // Match the static catalog's shape so downstream code (the
        // seeder, the frontend pre-zoom map) doesn't care which source
        // produced this row.
        key: String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, ''),
        label,
        country: internal,
        domain: INTERNAL_TO_DOMAIN[internal] || 'google.com',
        // Per-country default language - was hardcoded 'en' which broke
        // non-English markets (e.g. Amsterdam returned google.com results
        // in English). Falls back to 'en' for unmapped countries.
        language: INTERNAL_TO_LANGUAGE[internal] || 'en',
        lat,
        lng,
        ll: `@${lat},${lng},12z`,
        metro_radius_km,
        // Provenance - useful when debugging "why did the geocoder think
        // 'Cambridge' was in Massachusetts and not the UK?"
        geocoded: true,
        geocodeSource: 'photon',
        photonProps: props,
    };
}

// findCity, with a Nominatim fallback + on-disk cache. Static catalog
// always wins (instant, no network). Cache keyed by lowercased trimmed
// input so "London", " london ", "LONDON" all hit the same row.
async function findCityAsync(name) {
    const direct = findCity(name);
    if (direct) return direct;
    const cacheKey = String(name || '').trim().toLowerCase();
    if (!cacheKey) return null;
    const cache = readGeocodeCache();
    if (cache[cacheKey]) return cache[cacheKey];
    try {
        const fresh = await geocodeCity(name);
        if (!fresh) return null;
        cache[cacheKey] = fresh;
        writeGeocodeCache(cache);
        console.log(`[Cities] geocoded "${name}" → ${fresh.label} (${fresh.lat}, ${fresh.lng}, r=${fresh.metro_radius_km}km)`);
        return fresh;
    } catch (err) {
        console.warn(`[Cities] geocode failed for "${name}": ${err.message}`);
        return null;
    }
}

module.exports = { CITIES, getCity, findCity, findCityAsync };
