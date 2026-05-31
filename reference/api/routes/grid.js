// /api/grid/* - grid-sweep dashboard endpoints.
//
//   GET  /api/grid/icps                       - list configured ICPs
//   GET  /api/grid?icp=bluebird               - list cells for an ICP (optional state filter)
//   GET  /api/grid/coverage?icp=bluebird      - counts by state + done %
//   POST /api/grid/seed   body: { icp, cities? }  - seed Tier-1 cells. cities optional override
//   POST /api/grid/seed-country body: { icp, country } - seed Tier-2 country fill
//   GET  /api/grid/countries                   - list available country bboxes
//   POST /api/grid/sweep  body: { cellId }     - force-run sweep on one cell (admin/debug)
//   POST /api/grid/reset-budget                - clear the per-session sweep budget
//   POST /api/grid/reset  body: { icp? }       - wipe cells (one ICP, or all if omitted) + reset budget
//
// No auth - same as the rest of BlueBird's local-only API.

const express = require('express');
const { listIcps, getIcp } = require('../utils/icps');
const grid = require('../utils/grid-store');
const { seedIcp, seedCountry, buildIcpCells, buildCountryCells } = require('../utils/grid-seeder');
const { listCountries } = require('../utils/countries');
const { findCityAsync } = require('../utils/cities');
const { sweepCell } = require('../utils/sweep-pipeline');
const { resetBudget } = require('../utils/grid-cron');
const { eventsSince } = require('../utils/activity-log');

const router = express.Router();

router.get('/icps', (req, res) => {
    res.json({ success: true, icps: listIcps() });
});

router.get('/', async (req, res) => {
    const { icp, state } = req.query;
    try {
        const cells = await grid.listCells({ icpId: icp || undefined, state: state || undefined });
        res.json({ success: true, cells });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/coverage', async (req, res) => {
    const { icp } = req.query;
    if (!icp) return res.status(400).json({ success: false, error: 'icp query param required' });
    try {
        const coverage = await grid.getCoverage(icp);
        res.json({ success: true, icp, coverage });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Seed Tier-1 cells. Defaults to using the ICP's own `cities` array but
// allows override via body.cities - useful for "I want to seed JUST London
// even though my ICP has the whole UK listed."
router.post('/seed', async (req, res) => {
    const { icp: icpId, cities: cityOverride } = req.body || {};
    if (!icpId) return res.status(400).json({ success: false, error: 'icp required' });
    const icp = getIcp(icpId);
    if (!icp) return res.status(404).json({ success: false, error: `ICP "${icpId}" not found` });
    const startedAt = Date.now();
    const effectiveIcp = cityOverride && cityOverride.length
        ? { ...icp, cities: cityOverride }
        : icp;
    console.log(`[Seed] ▶ START icp="${icp.id}" cities=[${effectiveIcp.cities.join(', ')}]${cityOverride ? ' (override)' : ''}`);
    try {
        const result = await seedIcp(effectiveIcp);
        console.log(`[Seed] ✓ END ${Date.now() - startedAt}ms | added=${result.added || 0} skipped=${result.skipped || 0} total=${result.totalCells || '?'}`);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[Seed] ✗ END error after ${Date.now() - startedAt}ms: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Force-sweep one cell. Useful for debugging or kicking a stuck cell.
// Bypasses the cron's session budget - admins triggering this manually
// have already decided the credit is worth it.
router.post('/sweep', async (req, res) => {
    const { cellId } = req.body || {};
    if (!cellId) return res.status(400).json({ success: false, error: 'cellId required' });
    try {
        const cell = await grid.getCell(cellId);
        if (!cell) return res.status(404).json({ success: false, error: 'cell not found' });
        const icp = getIcp(cell.icpId);
        if (!icp) return res.status(404).json({ success: false, error: `ICP "${cell.icpId}" not found` });
        const result = await sweepCell(icp, cell);
        res.json({ success: true, cellId, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/countries', (req, res) => {
    res.json({ success: true, countries: listCountries() });
});

// Resolve a city name to its lat/lng/country/metro radius. Used by the
// frontend Coverage page to fly the camera to a city the moment the
// user picks it from the dropdown - even if it's not in the hardcoded
// CITY_CENTERS frontend mirror and has no seeded cells yet. Goes
// through findCityAsync so static catalog → geocode cache → live
// Photon all work transparently.
router.get('/city-info', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name query param required' });
    try {
        const city = await findCityAsync(name);
        if (!city) return res.status(404).json({ success: false, error: `no match for "${name}"` });
        res.json({
            success: true,
            city: {
                name: city.label.split(',')[0].trim(),
                label: city.label,
                lat: city.lat,
                lng: city.lng,
                country: city.country,
                metro_radius_km: city.metro_radius_km,
                geocoded: !!city.geocoded,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Preview - compute the cells a seed WOULD produce without writing them.
// Lets the frontend show the user the proposed grid before they commit.
// Body shape mirrors /seed and /seed-country: { icp, scope, cities?, country? }.
//   scope='city'    → buildIcpCells (Tier-1)
//   scope='country' → buildCountryCells (Tier-2 with coverage tiers)
router.post('/preview', async (req, res) => {
    const { icp: icpId, scope, cities: cityOverride, country } = req.body || {};
    if (!icpId) return res.status(400).json({ success: false, error: 'icp required' });
    const icp = getIcp(icpId);
    if (!icp) return res.status(404).json({ success: false, error: `ICP "${icpId}" not found` });
    const startedAt = Date.now();
    console.log(`[Preview] ▶ START icp="${icp.id}" scope=${scope}${country ? ` country=${country}` : ''}${cityOverride ? ` cities=[${cityOverride.join(', ')}]` : ''}`);
    try {
        if (scope === 'country') {
            if (!country) return res.status(400).json({ success: false, error: 'country required for country scope' });
            const result = await buildCountryCells(icp, country);
            console.log(`[Preview] ✓ END ${Date.now() - startedAt}ms | scope=country country=${country} cells=${(result.cells || []).length}`);
            return res.json({ success: true, scope: 'country', ...result });
        }
        const effective = cityOverride && cityOverride.length
            ? { ...icp, cities: cityOverride }
            : icp;
        const result = await buildIcpCells(effective);
        console.log(`[Preview] ✓ END ${Date.now() - startedAt}ms | scope=city cities=[${effective.cities.join(', ')}] cells=${(result.cells || []).length}`);
        return res.json({ success: true, scope: 'city', ...result });
    } catch (err) {
        console.error(`[Preview] ✗ END error after ${Date.now() - startedAt}ms: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Seed Tier-2 country-fill cells (25km hex grid over the country bbox,
// skipping cells within ~30km of any Tier-1 city center for this ICP so
// we don't double-scan the dense metros).
router.post('/seed-country', async (req, res) => {
    const { icp: icpId, country } = req.body || {};
    if (!icpId) return res.status(400).json({ success: false, error: 'icp required' });
    if (!country) return res.status(400).json({ success: false, error: 'country required' });
    const icp = getIcp(icpId);
    if (!icp) return res.status(404).json({ success: false, error: `ICP "${icpId}" not found` });
    try {
        const result = await seedCountry(icp, country);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/reset-budget', (req, res) => {
    console.log(`[Sweep Cron] ↻ Resume sweeping requested - budget reset`);
    resetBudget();
    res.json({ success: true });
});

// Activity feed - newest events first. Frontend polls every few seconds
// with the largest id it's seen as ?since=<id>. Initial load (no since)
// returns the most recent batch so a fresh page mount shows context.
// Optional ?icp= filter so the activity feed only shows events for the
// active ICP.
router.get('/activity', (req, res) => {
    const sinceId = parseInt(req.query.since, 10) || 0;
    const icpFilter = req.query.icp || null;
    let events = eventsSince(sinceId);
    if (icpFilter) events = events.filter(e => e.icpId === icpFilter);
    res.json({ success: true, events });
});

// Full wipe - clears cells for the given ICP (or every ICP if omitted) and
// resets the cron's per-session budget so a fresh seed can start cleanly.
router.post('/reset', async (req, res) => {
    const { icp } = req.body || {};
    console.log(`[Reset] ▶ START scope=${icp ? `icp=${icp}` : 'ALL ICPs'}`);
    try {
        const result = await grid.clearCells(icp || null);
        resetBudget();
        console.log(`[Reset] ✓ END removed=${result.removed || 0} cells`);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error(`[Reset] ✗ END error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
