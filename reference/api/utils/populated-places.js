// Populated places dataset - used by the tier-based country fill seeder
// to drop cells AT towns/cities of a given population range, instead of
// uniformly across a country bbox (which wastes credits on empty fields).
//
// Source: GeoNames cities1000 dump
// (https://download.geonames.org/export/dump/cities1000.zip) - CC-BY 4.0,
// monthly-updated, contains every populated place ≥1000 pop globally.
// Ours is filtered to UK/US/CA/NL with the GB→UK rename, ~22k entries.
// To regenerate (after a GeoNames refresh, or to add more countries),
// download cities1000.zip and run the converter at api/tmp/convert.js
// (see git history for the script).

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'populated-places.json');

// Population brackets per tier. The seeder's `coverage` config picks
// which tiers to include; these thresholds decide what falls into each.
const TIERS = {
    urban:    { min: 50000, max: Infinity },     // major city cores
    suburban: { min: 5000,  max: 50000 },        // mid-size towns + city-adjacent
    rural:    { min: 1000,  max: 5000 },         // small towns + villages
};

let cache = null;

function loadAll() {
    if (cache) return cache;
    if (!fs.existsSync(FILE)) {
        console.warn('[PopulatedPlaces] populated-places.json missing - country-fill seeding will return empty');
        cache = [];
        return cache;
    }
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        cache = JSON.parse(raw) || [];
    } catch (err) {
        console.warn('[PopulatedPlaces] parse failed:', err.message);
        cache = [];
    }
    return cache;
}

// Filter the dataset to places matching a country code AND falling in any
// of the requested tiers (e.g. ['urban', 'suburban']). De-duplicated by
// rounded lat/lng so accidental duplicates in the source file don't
// produce double-cells.
function getPlacesForCoverage(countryCode, tiers) {
    if (!countryCode || !Array.isArray(tiers) || tiers.length === 0) return [];
    const ranges = tiers
        .map(t => TIERS[t])
        .filter(Boolean);
    if (ranges.length === 0) return [];
    const all = loadAll();
    const seen = new Set();
    const matches = [];
    for (const place of all) {
        if (place.country !== countryCode) continue;
        const pop = Number(place.population) || 0;
        const inAnyTier = ranges.some(r => pop >= r.min && pop < r.max);
        if (!inAnyTier) continue;
        // Round to ~1 km grid for dedupe - same physical place at slightly
        // different recorded coords still counts as one.
        const key = `${place.lat.toFixed(2)}|${place.lng.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push(place);
    }
    return matches;
}

// Lookup a single populated place by name (case-insensitive). Optional
// country filter so "London, UK" doesn't accidentally match "London, ON"
// in Canada. Used by the city-scope seeder to align its metro radius
// with the urban country-fill radius for the same city - so a London
// seeded via either path produces the same hex grid.
function findPlace(name, country) {
    if (!name) return null;
    const target = String(name).trim().toLowerCase();
    return loadAll().find(p =>
        p.name.toLowerCase() === target &&
        (!country || p.country === country)
    ) || null;
}

// Distance helper - same haversine the seeder uses, repeated here so
// this module doesn't import from grid-seeder (would create a cycle).
function distanceKm(aLat, aLng, bLat, bLng) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat), lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { TIERS, loadAll, getPlacesForCoverage, findPlace, distanceKm };
