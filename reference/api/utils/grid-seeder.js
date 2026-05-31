// Tier-1 sub-cell seeder. Given an ICP, looks up each city in its `cities`
// list, generates a hex-spaced grid of sub-cells covering that city's
// metro_radius_km footprint, and inserts them as `pending` rows in the
// grid store.
//
// Why hex-spaced (offset rows) instead of a square grid: hex packing has
// no diagonal gaps. With a square grid at spacing S, the worst-case
// "uncovered" distance is sqrt(2)*S/2 (the diagonal between cells); with
// a hex grid it's S/2. Same number of points, ~30% better worst-case
// coverage. Cheap win.
//
// SUB_CELL_SPACING_KM is the gap between adjacent sub-cell centers. Picked
// to roughly match the radius Google Maps Search covers at zoom level 12
// (~7 km). Slight overlap is OK - the dedupe step on place_id catches it.

const { findCity, findCityAsync } = require('./cities');
const { getCountry } = require('./countries');
const { getCountryFeature } = require('./country-geo');
const { getPlacesForCoverage, findPlace } = require('./populated-places');
const { getAirportsForCountry } = require('./airports');
const { DEFAULT_COVERAGE } = require('./icps');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const grid = require('./grid-store');

// 12 km spacing matches the geometry of hex packing for a 7 km search
// radius - cells just touch at the corners of each triangular tile, so
// every point is within 7 km of at least one cell centre with minimal
// overlap. Earlier 8 km value created ~50 % overlap (a city like
// Birmingham was scanned ~2× per neighbourhood) - wasted credits without
// catching any extra businesses since Google Maps Search already saturates
// at 20 results per call.
const SUB_CELL_SPACING_KM = 12;       // Tier-1 sub-cell spacing (within cities)
const TIER2_SPACING_KM = 25;          // Tier-2 country-fill spacing (between cities)
// Rural backstop hex spacing. Bumped iteratively as the demo revealed
// the original 50 km was way too aggressive over empty US/Canada
// interiors. At 100 km, each backstop cell still catches any business
// within ~50 km - plenty for the truly rural verticals (ag equipment,
// fence supply, etc.). For verticals that don't need rural at all
// (car rental, dental, gym), users should just toggle Rural off in the
// ICP. The "Montana rancher" scenario this protects against is rare;
// 99 % of credit savings come from skipping it entirely.
//
// Iteration history: 50 km → 75 km → 100 km.
//   50 km  → ~1000 cells over continental US (mostly empty fields)
//   75 km  → ~450
//   100 km → ~250
const RURAL_SPARSE_KM = 100;
const KM_PER_DEG_LAT = 111;           // constant; 1° latitude = ~111 km
const TIER1_RADIUS_KM = 5;            // displayed/stored as the cell's "radius"
const TIER2_RADIUS_KM = 12;           // ditto for Tier-2 - a 25km cell with overlap covers ~12km clean
const TIER2_DEDUPE_RADIUS_KM = 30;    // skip Tier-2 cells within X km of any Tier-1 city center for this ICP
const RURAL_AVOID_PLACE_KM = 75;      // sparse-rural cells must be at least this far from any populated place

// Search radius per cell type. Scrapingdog's `ll` zoom level controls
// how wide a geographic area the Maps query covers - higher zoom = tighter
// search. Scrapingdog/Google use integer zoom levels with each step
// roughly doubling the radius, so the implementable rungs are:
//   zoom 12 ≈  7 km   urban populated + airports - businesses cluster,
//                     a tight scan still saturates Google's 20-result cap
//                     quickly. (Tried zoom 13 / 4 km - too narrow for
//                     metros >50k pop.)
//   zoom 11 ≈ 14 km   suburban + rural populated places - towns sprawl
//                     along main roads, a wider sweep catches outer
//                     businesses. Note: 10 km was the user's suggested
//                     suburban target but isn't a clean integer-zoom
//                     value, so we round up to 14 km.
//   zoom 10 ≈ 28 km   sparse rural backstop - cells are 50 km apart by
//                     design, almost-touching circles. Widest sensible
//                     before Google switches from "rentals near here"
//                     to "City of Bozeman" placeholder results.
const ZOOM_BY_SOURCE = {
    'urban-populated':    { zoom: 12, radiusKm: 7  },
    'suburban-populated': { zoom: 11, radiusKm: 14 },
    'rural-populated':    { zoom: 11, radiusKm: 14 },
    sparse:               { zoom: 10, radiusKm: 28 },
    airport:              { zoom: 12, radiusKm: 7  },
};
const DEFAULT_ZOOM_RADIUS = { zoom: 12, radiusKm: 7 };

function classifyPopulationTier(population) {
    const pop = Number(population) || 0;
    if (pop >= 50000) return 'urban';
    if (pop >= 5000)  return 'suburban';
    return 'rural';
}

// Threshold above which a populated place is large enough that one cell
// at the centre can't cover all its rentals/businesses. Above this, the
// seeder lays down a hex sub-grid (same as Tier-1 city scope does for a
// user-picked city). Below it, a single cell with tier-tuned zoom does.
//
// Picked at 100k because that's roughly the point where urban geography
// starts spreading beyond a 7 km central radius - Cambridge (~145k) just
// crosses into needing sub-cells; Norwich (~200k) clearly does.
const SUBGRID_THRESHOLD_POP = 100000;

// Population → metro radius (km) for the sub-grid. Tuned for the new
// 12 km spacing so smaller cities still get ≥ 4 cells in their hex
// (Cambridge with the previous 10 km radius would have collapsed to 1
// cell at 12 km spacing - too tight for a 145 k-pop city).
function populationToRadiusKm(population) {
    const pop = Number(population) || 0;
    if (pop >= 5000000) return 38;       // London, NYC, LA - ~37 cells at 12 km
    if (pop >= 1000000) return 30;       // Birmingham, Toronto - ~22 cells
    if (pop >= 500000)  return 22;       // Leeds, Glasgow, Edinburgh - ~13 cells
    if (pop >= 200000)  return 17;       // Brighton, Coventry, Cardiff - ~8 cells
    if (pop >= 100000)  return 14;       // Norwich, Oxford, Cambridge - ~5 cells
    return 10;                           // small / borderline - 1 or 2 cells
}

function settingsForCandidate(c) {
    if (c._source === 'airport') return ZOOM_BY_SOURCE.airport;
    if (c._source === 'sparse')  return ZOOM_BY_SOURCE.sparse;
    if (c._source === 'populated') {
        const tier = classifyPopulationTier(c.population);
        return ZOOM_BY_SOURCE[`${tier}-populated`] || DEFAULT_ZOOM_RADIUS;
    }
    return DEFAULT_ZOOM_RADIUS;
}

function resolveCoverage(icp) {
    return { ...DEFAULT_COVERAGE, ...(icp?.coverage || {}) };
}

// Hex-spaced grid generator centered on (centerLat, centerLng), covering
// a circular area of radius R km. Returns an array of { lat, lng } points.
//
// Algorithm:
//   - Step in lat = SPACING * sqrt(3)/2  (vertical hex spacing)
//   - Step in lng = SPACING               (horizontal hex spacing)
//   - Every other row offset by SPACING/2 in longitude
//   - Skip points outside the metro radius
function hexGridAround(centerLat, centerLng, radiusKm) {
    const points = [];
    const stepLatDeg = (SUB_CELL_SPACING_KM * Math.sqrt(3) / 2) / KM_PER_DEG_LAT;
    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
    const stepLngDeg = SUB_CELL_SPACING_KM / kmPerDegLng;

    const radiusLatDeg = radiusKm / KM_PER_DEG_LAT;
    const rowsHalf = Math.ceil(radiusKm / (SUB_CELL_SPACING_KM * Math.sqrt(3) / 2));
    const colsHalf = Math.ceil(radiusKm / SUB_CELL_SPACING_KM);

    for (let row = -rowsHalf; row <= rowsHalf; row++) {
        const lat = centerLat + row * stepLatDeg;
        // Offset every other row by half a column (true hex packing).
        const colOffset = (row % 2 === 0) ? 0 : 0.5;
        for (let col = -colsHalf; col <= colsHalf; col++) {
            const lng = centerLng + (col + colOffset) * stepLngDeg;
            // Distance check: how many km from the center? Use simple
            // Euclidean in degree-space scaled to km. Plenty accurate at
            // city-metro scales.
            const dLatKm = (lat - centerLat) * KM_PER_DEG_LAT;
            const dLngKm = (lng - centerLng) * kmPerDegLng;
            const distKm = Math.hypot(dLatKm, dLngKm);
            if (distKm <= radiusKm) {
                points.push({ lat: round4(lat), lng: round4(lng) });
            }
        }
    }
    // dedupe on rounded coords (defensive - shouldn't happen but cheap)
    const seen = new Set();
    return points.filter(p => {
        const k = `${p.lat}|${p.lng}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    void radiusLatDeg; // unused but kept for clarity in future radius math
}

function round4(n) {
    return Math.round(n * 1e4) / 1e4;
}

// Seed Tier-1 cells for an ICP. For each city in icp.cities:
//   1. Look it up in the catalog (skip with warning if not found)
//   2. Generate a hex grid covering its metro_radius_km
//   3. Build cell objects + insert into grid store (deduped by lat/lng)
//
// Returns { added, skipped, perCity: [{city, count}] }.
// Compute Tier-1 cells for an ICP without persisting. Returns `cells` +
// `perCity` breakdown. Same dispatch is shared between seedIcp (persist)
// and the preview endpoint (don't persist).
async function buildIcpCells(icp) {
    if (!icp || !icp.id) throw new Error('buildIcpCells: invalid ICP');
    const perCity = [];
    let totalSkippedUnknownCity = 0;
    let totalGeocoded = 0;
    const allCells = [];

    for (const cityName of icp.cities || []) {
        const city = await findCityAsync(cityName);
        if (!city) {
            console.warn(`[Grid Seeder] Unknown city "${cityName}" - geocoder found no match`);
            totalSkippedUnknownCity++;
            perCity.push({ city: cityName, count: 0, skipped: true, reason: 'no geocode hit' });
            continue;
        }
        if (city.geocoded) totalGeocoded++;

        // Unify the metro radius with what country-fill's urban tier would
        // use for this same city. If the city exists in populated-places.json
        // with a population, derive the radius from population - same source,
        // same algorithm, so a London seeded via city scope produces the
        // identical hex grid as London via country fill (urban tier).
        // Falls back to the existing metro_radius_km (cities.js catalog or
        // Photon bbox-derived) if the city isn't in populated-places.
        const placeMatch = findPlace(city.label.split(',')[0].trim(), city.country);
        const metroRadiusKm = placeMatch && placeMatch.population
            ? populationToRadiusKm(placeMatch.population)
            : city.metro_radius_km;

        const points = hexGridAround(city.lat, city.lng, metroRadiusKm);
        const cells = points.map(p => ({
            icpId: icp.id,
            tier: 1,
            lat: p.lat,
            lng: p.lng,
            ll: `@${p.lat},${p.lng},12z`,
            radiusKm: TIER1_RADIUS_KM,
            parentCity: city.label.split(',')[0].trim(),
            country: city.country,
            domain: city.domain,
            language: city.language,
        }));
        allCells.push(...cells);
        perCity.push({
            city: city.label,
            count: cells.length,
            geocoded: !!city.geocoded,
            radiusKm: metroRadiusKm,
            radiusSource: placeMatch?.population ? 'population' : (city.geocoded ? 'geocode-bbox' : 'catalog'),
        });
    }

    return {
        cells: allCells,
        perCity,
        skippedUnknownCity: totalSkippedUnknownCity,
        geocodedCount: totalGeocoded,
    };
}

async function seedIcp(icp) {
    const result = await buildIcpCells(icp);
    const added = await grid.addCells(result.cells);
    // perCity counts above are pre-dedup; return the stored count (after
    // dedupe against existing rows) as the canonical added value.
    return {
        added,
        skippedUnknownCity: result.skippedUnknownCity,
        geocodedCount: result.geocodedCount,
        perCity: result.perCity,
    };
}

// Hex-spaced grid generator over a rectangular bounding box. Same offset-
// row hex packing as hexGridAround, but driven by lat/lng bounds instead
// of a center+radius. Returns array of { lat, lng } points.
function hexGridInBbox(minLat, maxLat, minLng, maxLng, spacingKm) {
    const points = [];
    const stepLatDeg = (spacingKm * Math.sqrt(3) / 2) / KM_PER_DEG_LAT;
    // Approximate kmPerDegLng using the bbox center latitude. Good enough
    // for country-scale boxes; at extreme latitudes the spacing distorts
    // slightly but never enough to break coverage.
    const centerLat = (minLat + maxLat) / 2;
    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
    const stepLngDeg = spacingKm / kmPerDegLng;

    let row = 0;
    for (let lat = minLat; lat <= maxLat; lat += stepLatDeg) {
        const colOffset = (row % 2 === 0) ? 0 : 0.5;
        // Recompute kmPerDegLng at THIS row's latitude so rows in the deep
        // north/south stay roughly equidistant. Cheap; happens once per row.
        const localKmPerDegLng = KM_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
        const localStepLngDeg = spacingKm / localKmPerDegLng;
        for (let lng = minLng + colOffset * localStepLngDeg; lng <= maxLng; lng += localStepLngDeg) {
            points.push({ lat: round4(lat), lng: round4(lng) });
        }
        row++;
        // step in longitude is row-independent (we recomputed inside the
        // inner loop), but step in latitude is fixed
        void stepLngDeg;
    }
    return points;
}

// Distance in km between two lat/lng points using the haversine formula.
// We only need it for the "skip cells near Tier-1 cities" check; cheap
// enough to call N×M times on country-scale grids (~1000 candidate cells
// × ~10 cities = 10k calls, microseconds total).
function distanceKm(aLat, aLng, bLat, bLng) {
    const R = 6371; // earth radius km
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Seed Tier-2 country-fill cells for an ICP.
//   1. Look up the country bbox from countries.js
//   2. Generate a 25km hex grid over the bbox
//   3. Skip cells within TIER2_DEDUPE_RADIUS_KM of any Tier-1 city center
//      that's part of THIS ICP's cities[] (those areas already have dense
//      coverage; double-scanning wastes credits)
//   4. Insert remaining cells as `pending` rows tagged tier=2
//
// Returns { added, skippedNearTier1, generated } counts.
// Compute the cells a country fill WOULD produce, without persisting.
// Both `seedCountry` and the preview endpoint go through this so the
// preview is guaranteed to match what an actual seed would write.
//
// Strategy: read the ICP's coverage tier toggles, then assemble cells
// from up to four sources:
//   1. Populated places matching urban/suburban/rural population brackets
//   2. Major airports if coverage.airports
//   3. Sparse hex backstop if coverage.rural - fills tiles >50 km from
//      any populated place so genuinely middle-of-nowhere businesses get
//      covered without re-scanning towns the populated-places already hit.
//   4. (Removed: blanket bbox grid. The old approach wasted ~70% of
//      Tier-2 credits on empty fields the populated-places approach
//      simply doesn't visit.)
//
// All sources are then filtered by:
//   - On-land check via Natural Earth country polygon (no ocean cells)
//   - Tier-1 dedupe (no double-scan of cities the user already seeded)
async function buildCountryCells(icp, countryCode) {
    if (!icp) throw new Error('buildCountryCells: ICP required');
    const country = getCountry(countryCode);
    if (!country) throw new Error(`buildCountryCells: unknown country "${countryCode}"`);

    const coverage = resolveCoverage(icp);
    const feature = await getCountryFeature(country.code);

    // 1. Populated places filtered by tier toggles. A point per city/
    //    town/village in the requested population bracket(s).
    const tiers = [];
    if (coverage.urban)    tiers.push('urban');
    if (coverage.suburban) tiers.push('suburban');
    if (coverage.rural)    tiers.push('rural');
    const rawPlaces = getPlacesForCoverage(country.code, tiers);

    // Proximity-dedupe populated places. Sort by population desc, then
    // keep a place only if it's NOT inside a larger kept place's metro
    // radius. Westminster (255k pop, 1 km from London centre) gets
    // absorbed by London (9M pop, 38 km radius covers it) - without this
    // they each generate overlapping sub-grids that visually crowd the
    // centre and waste credits scanning the same neighbourhoods twice.
    // Same effect on Manchester/Salford, Birmingham/Solihull,
    // Leeds/Bradford, etc. Reading and Brighton stay since they're
    // outside London's 38 km halo.
    const placesByPopDesc = [...rawPlaces].sort(
        (a, b) => (Number(b.population) || 0) - (Number(a.population) || 0),
    );
    const places = [];
    let placesAbsorbed = 0;
    for (const p of placesByPopDesc) {
        const dominator = places.find(kept => {
            const keptRadius = populationToRadiusKm(Number(kept.population) || 0);
            return distanceKm(p.lat, p.lng, kept.lat, kept.lng) < keptRadius;
        });
        if (dominator) {
            placesAbsorbed++;
            continue;
        }
        places.push(p);
    }

    // 2. Airports - anchor cells where rentals/fleet/ground-transport
    //    cluster regardless of nearby population.
    const airports = coverage.airports ? getAirportsForCountry(country.code) : [];

    // 3. Sparse rural backstop. Only generated if coverage.rural is on.
    //    Filters the bbox hex grid to points >RURAL_AVOID_PLACE_KM away
    //    from any populated place - catches genuinely middle-of-nowhere
    //    businesses without retreading towns already in the list.
    let sparseRural = [];
    if (coverage.rural) {
        const bbox = hexGridInBbox(
            country.minLat, country.maxLat,
            country.minLng, country.maxLng,
            RURAL_SPARSE_KM,
        );
        // For "far from every populated place" we need ALL populated
        // places of any tier in this country, not just the selected ones,
        // so we don't backstop into a town we just decided not to scan.
        const everyPlace = getPlacesForCoverage(country.code, ['urban', 'suburban', 'rural']);
        sparseRural = bbox.filter(p =>
            !everyPlace.some(pp =>
                distanceKm(p.lat, p.lng, pp.lat, pp.lng) < RURAL_AVOID_PLACE_KM
            ),
        );
    }

    // (No more Tier-1 dedupe ring around icp.cities[].) Used to skip a
    // 30 km radius around every city the user explicitly listed in their
    // ICP - necessary back when country-fill was a single big cell that
    // would have stomped on the hex grid city scope produced. Now that
    // both paths produce identical hex grids (via populationToRadiusKm),
    // the ring just punched holes in country-fill - Cambridge / London /
    // any city listed in the ICP would silently vanish from a
    // "Fill country" preview, which surprised users. Letting the cells
    // dedupe at addCells (by lat/lng) is the cleaner mental model:
    // country-fill is comprehensive; running city scope first then
    // country-fill is a no-op for the overlap zone.

    // Combine all sources and apply on-land filter.
    // Each candidate carries its origin (`source`) so the response can
    // surface the breakdown (e.g. "150 from populated places, 12 airports,
    // 8 sparse-rural backstop").
    const candidates = [
        ...places.map(p => ({ ...p, _source: 'populated' })),
        ...airports.map(a => ({ ...a, _source: 'airport', label: a.code + ' · ' + a.name })),
        ...sparseRural.map(p => ({ ...p, _source: 'sparse' })),
    ];

    const stats = { populated: 0, airport: 0, sparse: 0 };
    let skippedOcean = 0;
    let placesSubgridded = 0;
    const cells = [];
    const seen = new Set();

    // Helper: turn a single candidate (one lat/lng) into a list of
    // {lat, lng, zoom, radiusKm} cell descriptors. For populated places
    // with population ≥ SUBGRID_THRESHOLD_POP we expand into a hex grid
    // so a city like London (one populated-places row, pop 9M) doesn't
    // collapse into a single 7 km cell - it gets the same ~50-cell
    // treatment Tier-1 city scope produces. Smaller populated places +
    // airports + sparse rural stay as one cell each with tier-tuned zoom.
    function expandCandidate(c) {
        const isLargePopulated = c._source === 'populated' && (Number(c.population) || 0) >= SUBGRID_THRESHOLD_POP;
        if (!isLargePopulated) {
            const { zoom, radiusKm } = settingsForCandidate(c);
            return [{ lat: c.lat, lng: c.lng, zoom, radiusKm, isOrigin: true }];
        }
        // Sub-grid: hex around the place's lat/lng with a population-derived
        // metro radius. Each sub-cell uses the standard zoom 12 (7 km
        // search) since they're packed at SUB_CELL_SPACING_KM ≈ 8 km.
        placesSubgridded++;
        const metroRadius = populationToRadiusKm(c.population);
        const grid = hexGridAround(c.lat, c.lng, metroRadius);
        return grid.map((p, i) => ({
            lat: p.lat,
            lng: p.lng,
            zoom: 12,
            radiusKm: 7,
            isOrigin: i === 0,
        }));
    }

    for (const c of candidates) {
        // Sub-km dedup at CANDIDATE level - same place can show up in
        // multiple sources (e.g. populated-place + airport in the same
        // city). Sub-cells inside a single expansion are deduped below.
        const candKey = `${c.lat.toFixed(3)}|${c.lng.toFixed(3)}`;
        if (seen.has(candKey)) continue;
        seen.add(candKey);

        const subCells = expandCandidate(c);
        for (const sc of subCells) {
            // Per-sub-cell dedup: a Tier-1 dedupe ring around London might
            // clip half of London's sub-grid; the rest still belongs.
            const subKey = `${sc.lat.toFixed(3)}|${sc.lng.toFixed(3)}`;
            if (!sc.isOrigin && seen.has(subKey)) continue;
            seen.add(subKey);
            if (feature && !booleanPointInPolygon([sc.lng, sc.lat], feature)) {
                skippedOcean++;
                continue;
            }
            stats[c._source] = (stats[c._source] || 0) + 1;
            cells.push({
                icpId: icp.id,
                tier: 2,
                lat: round4(sc.lat),
                lng: round4(sc.lng),
                ll: `@${round4(sc.lat)},${round4(sc.lng)},${sc.zoom}z`,
                radiusKm: sc.radiusKm,
                parentCity: c._source === 'airport' ? c.label : (c.name || null),
                country: country.code,
                domain: country.domain,
                language: country.language,
                placeSource: c._source,
                // Density tier label for the cell drawer / activity log.
                placeTier: c._source === 'populated' ? classifyPopulationTier(c.population) : c._source,
            });
        }
    }
    return {
        cells,
        country: country.code,
        coverage,
        stats,
        skippedOcean,
        // How many large populated places were expanded into hex sub-grids.
        // Useful for the preview banner: "12 cities sub-gridded · 28 single
        // cells · 5 airports · 8 rural backstop".
        placesSubgridded,
        // How many smaller places got absorbed into a nearby larger one
        // (e.g. Westminster into London). Useful to show in the preview
        // so the user understands why the place count dropped.
        placesAbsorbed,
        landFiltered: !!feature,
        candidateCount: candidates.length,
    };
}

// Persist the cells `buildCountryCells` produces.
async function seedCountry(icp, countryCode) {
    const result = await buildCountryCells(icp, countryCode);
    const added = await grid.addCells(result.cells);
    return {
        added,
        country: result.country,
        coverage: result.coverage,
        stats: result.stats,
        skippedOcean: result.skippedOcean,
        placesSubgridded: result.placesSubgridded,
        placesAbsorbed: result.placesAbsorbed,
        landFiltered: result.landFiltered,
        candidateCount: result.candidateCount,
    };
}

module.exports = {
    seedIcp,
    seedCountry,
    buildIcpCells,
    buildCountryCells,
    hexGridAround,
    hexGridInBbox,
};
