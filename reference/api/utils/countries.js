// Country bounding boxes for Tier-2 country-fill seeding.
//
// Used by the grid seeder to lay down a 25 km hex grid covering the whole
// country bbox. Cells inside the metro radius of any Tier-1 city in the
// ICP get skipped (those areas are already covered by the dense Tier-1
// sub-grid). Cells over ocean or empty countryside auto-flip to `empty`
// after one Scrapingdog call returns 0 places - no follow-up cost.
//
// Bboxes are conservative - they slightly over-cover land plus a bit of
// adjacent ocean/border area. The empty-cell auto-flip handles the
// over-coverage gracefully.

const COUNTRIES = {
    UK: {
        code: 'UK',
        name: 'United Kingdom',
        domain: 'google.co.uk',
        language: 'en',
        // mainland Britain + N. Ireland + the Hebrides - excludes Shetland
        // (further north, low rental density, not worth the credits)
        minLat: 49.9, maxLat: 59.0,
        minLng: -8.2, maxLng: 1.8,
    },
    US: {
        code: 'US',
        name: 'United States',
        domain: 'google.com',
        language: 'en',
        // Continental US only - Alaska + Hawaii are separate, low priority
        // for car rental and would balloon the cell count.
        minLat: 24.5, maxLat: 49.4,
        minLng: -125.0, maxLng: -66.9,
    },
    CA: {
        code: 'CA',
        name: 'Canada',
        domain: 'google.ca',
        language: 'en',
        // Populated southern strip - most of CA's population sits within
        // 200km of the US border. Bbox caps at ~55°N to skip the empty
        // arctic which would generate ~70% wasted cells.
        minLat: 41.7, maxLat: 55.0,
        minLng: -141.0, maxLng: -52.6,
    },
    NL: {
        code: 'NL',
        name: 'Netherlands',
        domain: 'google.nl',
        // Dutch - required so Scrapingdog returns Dutch-language Maps
        // results. Critical for NedFox-style ICPs whose target market
        // (garden centres, DIY stores) is overwhelmingly Dutch-speaking.
        language: 'nl',
        // Mainland NL bbox + a sliver of overlap with BE/DE that gets
        // auto-skipped via the empty-cell flip when the country tag
        // mismatches. Excludes Bonaire/Caribbean Netherlands (different
        // market entirely).
        minLat: 50.7, maxLat: 53.7,
        minLng: 3.3,  maxLng: 7.3,
    },
    IE: {
        code: 'IE',
        name: 'Ireland',
        domain: 'google.ie',
        // English - Ireland is bilingual on paper but commercial Maps
        // results are overwhelmingly English-language.
        language: 'en',
        // Republic of Ireland bbox. Excludes Northern Ireland (UK),
        // which is covered by the UK bbox above.
        minLat: 51.4, maxLat: 55.4,
        minLng: -10.7, maxLng: -5.4,
    },
    BE: {
        code: 'BE',
        name: 'Belgium',
        domain: 'google.be',
        // Belgium is trilingual (Dutch/French/German). Default to Dutch
        // since NedFox's customers in BE are primarily Flemish garden
        // centres + thrift stores. Per-cell language can override later
        // for Wallonia/Brussels - for now Dutch covers the high-yield
        // market and search-log dedup absorbs any waste.
        language: 'nl',
        minLat: 49.5, maxLat: 51.6,
        minLng: 2.5,  maxLng: 6.4,
    },
};

function getCountry(code) {
    return COUNTRIES[code?.toUpperCase()] || null;
}

function listCountries() {
    return Object.values(COUNTRIES).map(c => ({
        code: c.code,
        name: c.name,
        // bbox is consumed by the frontend to fly the camera/map to the
        // country's footprint when the user picks it from the dropdown.
        bbox: {
            minLat: c.minLat, maxLat: c.maxLat,
            minLng: c.minLng, maxLng: c.maxLng,
        },
    }));
}

module.exports = { COUNTRIES, getCountry, listCountries };
