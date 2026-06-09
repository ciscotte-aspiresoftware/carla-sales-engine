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
const { getCellGeneration } = require('./settings');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const grid = require('./grid-store');

// 12 km spacing matches the geometry of hex packing for a 7 km search
// radius - cells just touch at the corners of each triangular tile, so
// every point is within 7 km of at least one cell centre with minimal
// overlap. Earlier 8 km value created ~50 % overlap (a city like
// Birmingham was scanned ~2× per neighbourhood) - wasted credits without
// catching any extra businesses since Google Maps Search already saturates
// at 20 results per call.
// Physical constant. 1° of latitude is always ~111 km regardless of where
// you are on Earth, so it stays hardcoded.
const KM_PER_DEG_LAT = 111;

// Cosmetic radius stored on each cell record. Scrapingdog doesn't actually
// consult these - it uses the zoom in `cell.ll`. Kept for record-keeping
// (rendering circle previews in the UI, history audits).
const TIER1_RADIUS_KM = 5;
const TIER2_RADIUS_KM = 12;

// Fallback for any candidate that doesn't match an entry in the configured
// `zoomBySource`. Tier-1 city scope uses zoom 12 (~7 km), so this lines up.
const DEFAULT_ZOOM_RADIUS = { zoom: 12, radiusKm: 7 };

// Pop → tier label. Decoupled from the zoomBySource lookup so changing the
// urban/suburban/rural radii in Admin doesn't shift which places count as
// which tier. The thresholds (50k urban / 5k suburban) are intentionally
// not user-tunable: they're shared with populated-places.js bucketing.
function classifyPopulationTier(population) {
    const pop = Number(population) || 0;
    if (pop >= 50000) return 'urban';
    if (pop >= 5000)  return 'suburban';
    return 'rural';
}

// Population → metro radius (km) for the sub-grid around a populated
// place. Consults the configured populationLadder (sorted desc by minPop)
// and returns the first row whose minPop is ≤ the place's population.
function populationToRadiusKm(population) {
    const pop = Number(population) || 0;
    const { populationLadder } = getCellGeneration();
    for (const row of populationLadder) {
        if (pop >= row.minPop) return row.radiusKm;
    }
    return populationLadder[populationLadder.length - 1]?.radiusKm || 10;
}

// Per-candidate zoom + cosmetic radius. Reads zoomBySource at call time so
// Admin edits apply on the next seed without restarting the API.
function settingsForCandidate(c) {
    const { zoomBySource } = getCellGeneration();
    if (c._source === 'airport') return zoomBySource.airport || DEFAULT_ZOOM_RADIUS;
    if (c._source === 'sparse')  return zoomBySource.sparse  || DEFAULT_ZOOM_RADIUS;
    if (c._source === 'populated') {
        const tier = classifyPopulationTier(c.population);
        return zoomBySource[tier] || DEFAULT_ZOOM_RADIUS;
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
//
// `spacingKm` is the gap between adjacent sub-cell centers. Defaults to the
// configured subCellSpacingKm so callers that don't care just get the
// Admin-configured value; callers with their own spacing (e.g. the bbox
// generator below) pass it explicitly.
function hexGridAround(centerLat, centerLng, radiusKm, spacingKm) {
    const points = [];
    const spacing = spacingKm || getCellGeneration().subCellSpacingKm;
    const stepLatDeg = (spacing * Math.sqrt(3) / 2) / KM_PER_DEG_LAT;
    const kmPerDegLng = KM_PER_DEG_LAT * Math.cos(centerLat * Math.PI / 180);
    const stepLngDeg = spacing / kmPerDegLng;

    const radiusLatDeg = radiusKm / KM_PER_DEG_LAT;
    const rowsHalf = Math.ceil(radiusKm / (spacing * Math.sqrt(3) / 2));
    const colsHalf = Math.ceil(radiusKm / spacing);

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

// ─── Disc-conflict greedy prune ──────────────────────────────────────────
//
// Optional pass that runs after all candidate cells are generated, to drop
// cells whose center sits inside the search radius of a higher-importance
// cell already accepted. Reduces overlap and total cell count without
// losing meaningful business coverage (a small town inside London's halo
// is already covered by London's sub-grid).
//
// Determinism: cells are sorted by (importance desc, lat asc, lng asc,
// source desc, parentCity asc) so the same input set always produces the
// same accepted set. Stable tiebreakers all the way down.

// Importance ranking - higher = swept first, less likely to be dropped.
// City-scope (Tier-1) wins by construction since they're the user's
// explicit picks. Populated places rank by raw population. Airports get
// a fixed mid-priority boost. Sparse rural is the floor.
function cellImportanceScore(cell) {
    if (cell.tier === 1) return 1e10;                          // city scope wins everything
    const src = cell.placeSource;
    // Airports rank between rural and small urban - they're useful anchors
    // for travel-adjacent verticals (car rental, fleet, ground transport)
    // but shouldn't outrank major metros where the actual business density
    // sits. 25k is roughly the boundary between suburban and urban so a
    // major-metro populated-places entry (any city ≥ 50k pop) beats an
    // airport in a conflict, while airports still beat genuinely rural
    // towns ( < 5k pop).
    if (src === 'airport') return 25_000;
    if (src === 'populated') {
        const pop = Number(cell.population) || 0;
        // Use population as score directly. London 9M >> tiny town 5k.
        // Add 1 so a 0-pop populated row beats sparse (which is < 1).
        return pop + 1;
    }
    if (src === 'sparse') return 0.5;                           // last resort
    return 1;                                                   // unknown sources
}

// Haversine distance in km between two lat/lng points. Identical to the
// distanceKm helper defined further down; defined locally here to keep
// the prune block self-contained and copy-pasteable.
function _distanceKm(aLat, aLng, bLat, bLng) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Stable tiebreaker key for a cell. Pure string comparison fallback so
// determinism holds across processes / OS sort implementations.
function _stableKey(c) {
    return [
        (c.lat ?? 0).toFixed(6),
        (c.lng ?? 0).toFixed(6),
        c.placeSource || c.tier || '',
        c.parentCity || '',
    ].join('|');
}

/**
 * Greedy disc-conflict prune. Accepts a cell only if its center is at
 * least `max(neighbor.radiusKm, candidate.radiusKm) * keepFactor` from
 * every previously-accepted cell. Higher-importance cells are evaluated
 * first, so a candidate gets dropped by a stronger one (not the reverse).
 *
 * @param {Array<Cell>} cells - candidate cells, each must carry lat, lng, radiusKm
 * @param {object} opts
 * @param {number} opts.keepFactor - 0 (no prune) to 1 (no overlap)
 * @returns {{ kept: Array<Cell>, dropped: Array<Cell & {droppedBy: object, distanceKm: number}> }}
 */
function pruneConflictingCells(cells, { keepFactor = 0 } = {}) {
    const factor = Number(keepFactor) || 0;
    if (factor <= 0 || !Array.isArray(cells) || cells.length === 0) {
        return { kept: cells || [], dropped: [] };
    }

    // Sort by importance desc, with deterministic tiebreakers.
    const sorted = [...cells].sort((a, b) => {
        const sb = cellImportanceScore(b);
        const sa = cellImportanceScore(a);
        if (sb !== sa) return sb - sa;
        // Tiebreaker: lat asc, lng asc, stable key asc.
        if (a.lat !== b.lat) return a.lat - b.lat;
        if (a.lng !== b.lng) return a.lng - b.lng;
        return _stableKey(a).localeCompare(_stableKey(b));
    });

    const kept = [];
    const dropped = [];

    for (const c of sorted) {
        let conflict = null;
        let conflictDist = Infinity;
        for (const a of kept) {
            const d = _distanceKm(c.lat, c.lng, a.lat, a.lng);
            const threshold = Math.max(a.radiusKm || 7, c.radiusKm || 7) * factor;
            if (d < threshold) {
                conflict = a;
                conflictDist = d;
                break;
            }
        }
        if (conflict) {
            dropped.push({
                ...c,
                _droppedBy: {
                    lat: conflict.lat, lng: conflict.lng,
                    parentCity: conflict.parentCity || null,
                    placeSource: conflict.placeSource || null,
                    radiusKm: conflict.radiusKm || null,
                },
                _distanceKm: Math.round(conflictDist * 100) / 100,
            });
        } else {
            kept.push(c);
        }
    }

    return { kept, dropped };
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

    // Apply the disc-conflict prune if enabled. Tier-1 city-scope cells
    // mostly only conflict with each other when two cities are close
    // (Amsterdam/Utrecht, Manchester/Salford). Their importance score is
    // all the same (1e10), so the secondary sort by lat/lng decides which
    // wins - deterministic.
    const cfg = getCellGeneration();
    const factor = Number(cfg.conflictKeepFactor) || 0;
    let prunedCount = 0;
    let finalCells = allCells;
    if (factor > 0) {
        const { kept, dropped } = pruneConflictingCells(allCells, { keepFactor: factor });
        finalCells = kept;
        prunedCount = dropped.length;
    }

    return {
        cells: finalCells,
        perCity,
        skippedUnknownCity: totalSkippedUnknownCity,
        geocodedCount: totalGeocoded,
        // Prune metadata - useful for the seed flow's UI summary and the
        // preview endpoint.
        cellsBeforePrune: allCells.length,
        cellsAfterPrune: finalCells.length,
        conflictsRemoved: prunedCount,
        conflictKeepFactor: factor,
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
        cellsBeforePrune: result.cellsBeforePrune,
        cellsAfterPrune: result.cellsAfterPrune,
        conflictsRemoved: result.conflictsRemoved,
        conflictKeepFactor: result.conflictKeepFactor,
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

    // Pull the tunables once - same call across the whole build so we don't
    // race a settings-file write mid-seed.
    const cellCfg = getCellGeneration();
    const RURAL_SPARSE_KM = cellCfg.ruralSparseKm;
    const RURAL_AVOID_PLACE_KM = cellCfg.ruralAvoidPlaceKm;
    const SUBGRID_THRESHOLD_POP = cellCfg.subgridThresholdPop;

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
                // Population (when known) - feeds the disc-conflict prune's
                // importance score so larger cities outrank smaller towns
                // in overlap decisions.
                population: Number(c.population) || 0,
            });
        }
    }
    // Apply the disc-conflict prune if enabled. Runs over the fully-
    // expanded cell list (sub-grid sub-cells included) so cross-source
    // conflicts (airport inside Amsterdam's halo, suburban town inside
    // urban radius) get caught at the right granularity.
    const factor = Number(cellCfg.conflictKeepFactor) || 0;
    let finalCells = cells;
    let prunedCount = 0;
    if (factor > 0) {
        const { kept, dropped } = pruneConflictingCells(cells, { keepFactor: factor });
        finalCells = kept;
        prunedCount = dropped.length;
    }

    return {
        cells: finalCells,
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
        // Prune metadata.
        cellsBeforePrune: cells.length,
        cellsAfterPrune: finalCells.length,
        conflictsRemoved: prunedCount,
        conflictKeepFactor: factor,
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
        cellsBeforePrune: result.cellsBeforePrune,
        cellsAfterPrune: result.cellsAfterPrune,
        conflictsRemoved: result.conflictsRemoved,
        conflictKeepFactor: result.conflictKeepFactor,
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
    pruneConflictingCells,
    cellImportanceScore,
};
