// /api/grid/* - grid-sweep dashboard endpoints.
//
//   GET  /api/grid/icps                       - list configured ICPs
//   GET  /api/grid?icp=carla               - list cells for an ICP (optional state filter)
//   GET  /api/grid/coverage?icp=carla      - counts by state + done %
//   POST /api/grid/seed   body: { icp, cities? }  - seed Tier-1 cells. cities optional override
//   POST /api/grid/seed-country body: { icp, country } - seed Tier-2 country fill
//   GET  /api/grid/countries                   - list available country bboxes
//   POST /api/grid/sweep  body: { cellId }     - force-run sweep on one cell (admin/debug)
//   POST /api/grid/reset-budget                - clear the per-session sweep budget
//   POST /api/grid/reset  body: { icp? }       - wipe cells (one ICP, or all if omitted) + reset budget
//
// No auth - same as the rest of Carla's local-only API.

const express = require('express');
const { listIcps, getIcp } = require('../utils/icps');
const grid = require('../utils/grid-store');
const { seedIcp, seedCountry, buildIcpCells, buildCountryCells } = require('../utils/grid-seeder');
const { listCountries } = require('../utils/countries');
const { findCityAsync } = require('../utils/cities');
const { sweepCell } = require('../utils/sweep-pipeline');
const { resetBudget, isPaused, requestPause, isPauseRequested, getPauseReason } = require('../utils/grid-cron');
const sweepState = require('../utils/sweep-state');
const sweepSessions = require('../utils/sweep-sessions');
const sweepErrors = require('../utils/sweep-errors');
const { eventsSince } = require('../utils/activity-log');
const { trackActivity } = require('../middleware/activity');
const { getCellGeneration } = require('../utils/settings');

const router = express.Router();

router.get('/icps', async (req, res) => {
    // Attach pending-cell counts so the Coverage page's "Paused session ·
    // N cells waiting · Resume" banner gates correctly. Without this the
    // route returned bare ICP records, the page set `pendingCells` to
    // undefined, the banner's `activeIcpPending === 0` gate always tripped,
    // and Resume was permanently hidden after every auto-pause.
    //
    // Same logic + same query as /api/icps, kept inline here rather than
    // imported because routes/icps.js already centralizes it and we don't
    // want a circular require just for one helper. One pass over
    // grid.listCells({state:'pending'}) is cheap (indexed) even with
    // thousands of cells.
    const icps = listIcps();
    try {
        const pending = await grid.listCells({ state: 'pending' });
        const counts = new Map();
        for (const cell of pending) counts.set(cell.icpId, (counts.get(cell.icpId) || 0) + 1);
        res.json({ success: true, icps: icps.map((i) => ({ ...i, pendingCells: counts.get(i.id) || 0 })) });
    } catch (e) {
        // Non-fatal: if the cell read fails the page still renders, just
        // with the same broken banner gate as before - no regression.
        console.warn(`[Grid] /icps pending-counts attach failed: ${e.message}`);
        res.json({ success: true, icps });
    }
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

// POST /cities-info  body: { names: ['London', 'Amsterdam', ...] }
// Batch lookup so the ICP editor can resolve country for every city in one
// round-trip. Each entry in the response is null when the geocoder couldn't
// resolve - the UI then renders an "unknown" chip rather than a colored one.
// Uses the same findCityAsync cache as the single-city endpoint, so repeated
// lookups (across multiple ICPs sharing cities like London) are free.
router.post('/cities-info', async (req, res) => {
    const namesRaw = Array.isArray(req.body?.names) ? req.body.names : [];
    const names = [...new Set(namesRaw.map((n) => String(n || '').trim()).filter(Boolean))];
    const results = {};
    await Promise.all(names.map(async (name) => {
        try {
            const city = await findCityAsync(name);
            if (city) {
                results[name] = {
                    country: city.country || null,
                    label: city.label || name,
                };
            } else {
                results[name] = null;
            }
        } catch {
            results[name] = null;
        }
    }));
    res.json({ success: true, results });
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

// Resume Sweeping. Body shape:
//   { icp?: string, scope?: { type: 'city'|'country'|'all', value?: string } }
//
//   - icp omitted        → rotate across all ICPs (legacy behavior)
//   - icp + no scope     → lock to this ICP, no scope filter (any tier/city)
//   - icp + scope        → lock to this ICP AND this scope (e.g. only Amsterdam,
//                          or only NL country fill). The scope is also persisted
//                          as the "last active scope" for this ICP so the UI
//                          can show a "last: Amsterdam" chip across page loads.
router.post('/reset-budget', trackActivity('sweep_resumed'), async (req, res) => {
    const { icp, scope } = req.body || {};
    const cleanScope = (scope && scope.type)
        ? { type: String(scope.type), value: scope.value == null ? null : String(scope.value) }
        : null;
    const label = cleanScope
        ? `${cleanScope.type}${cleanScope.value ? `=${cleanScope.value}` : ''}`
        : 'no-scope';
    console.log(`[Sweep Cron] ↻ Resume sweeping requested - budget reset${icp ? ` (icp=${icp} scope=${label})` : ''}`);
    // resetBudget is async now (it persists the new sweep_sessions row).
    // Await so the response only fires after the session id is allocated -
    // keeps the UI's subsequent /sweep-state call from racing the create.
    await resetBudget(icp || null, cleanScope);
    res.json({ success: true });
});

// Per-ICP "last active scope" map. The Coverage page reads this to render a
// small "last: Amsterdam · 12/40 cells" chip per ICP so the operator can see
// where each scope was paused. Pure metadata - the canonical "where we left
// off" is the cell states themselves.
router.get('/sweep-state', (req, res) => {
    // `paused` is the cron's live in-memory state - boots true on every
    // restart by design. The Coverage page combines this with the per-ICP
    // `pendingCells` count from /api/icps to render a "Paused session - N
    // cells waiting · Resume" banner.
    //
    // `pauseRequested` is the mid-sweep signal: true between the moment the
    // operator clicked Pause and the moment the in-flight cell's classify
    // chain drains and writes its checkpoint. Frontend renders a "Pausing…
    // current company will finish first" indicator during that window.
    // pauseReason lets the Coverage page distinguish operator pauses from
    // auto-pauses (budget cap hit, no work in scope). The big blue "Resume
    // sweeping" banner is gated to 'manual' only - auto-pauses are an
    // expected end-of-session, not an interruption, and the scope action
    // button below the picker re-labels itself to "Resume sweeping…" for
    // those cases instead.
    res.json({
        success: true,
        lastScopes: sweepState.getAll(),
        paused: isPaused(),
        pauseRequested: isPauseRequested(),
        pauseReason: getPauseReason(),
    });
});

// POST /api/grid/pause - mid-sweep pause. Sets both `paused` (cron tick gate)
// and `pauseRequested` (sweep pipeline checkpoint signal). The in-flight cell
// finishes its current company's classify+upsert, writes a `pause_checkpoint`
// JSON on its row, and bails. Subsequent ticks no-op because `paused=true`.
//
// Resume is the existing POST /api/grid/reset-budget - it clears both flags
// and the cron picks the checkpointed cell up on its next tick, resuming the
// per-company loop from the saved `nextIdx`.
router.post('/pause', trackActivity('sweep_paused'), (req, res) => {
    requestPause();
    res.json({ success: true, paused: isPaused(), pauseRequested: isPauseRequested() });
});

// GET /api/grid/last-paused-session - the single most recent operator-paused
// session, used by the Coverage page to surface "Last paused: NedFox-Garden ·
// Netherlands - click to switch view" chip when the operator's current
// picker selection doesn't match where they actually stopped.
//
// Scope is intentionally narrowed to status='paused' AND pause_reason='manual'
// so an auto-pause (budget cap hit, no work) doesn't fire the chip - those
// are expected end-of-session states, not interruptions to recover from.
// Returns null when the most recent session was either still running, ended
// cleanly, or auto-paused.
router.get('/last-paused-session', async (req, res) => {
    try {
        // Pull the latest 5 (cheap, indexed) and pick the first 'paused' +
        // 'manual' row. We don't filter in SQL to avoid two round-trips
        // when the operator's recent activity was a clean completion - one
        // listRecent call covers both the chip and the underlying need.
        const recent = await sweepSessions.listRecent({ limit: 5 });
        const lastManual = (recent || []).find(
            (s) => s.status === 'paused' && s.pause_reason === 'manual',
        ) || null;
        res.json({ success: true, session: lastManual });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/grid/sessions - persisted sweep-session history.
//
// Read by the Coverage page's "Recent sessions" panel. Each row is one
// Resume click (or a server-recovered crashed session). Counters survive
// restarts so the operator can see what was happening last time even
// after a redeploy. Optional ?icpId= scopes to one ICP.
router.get('/sessions', async (req, res) => {
    try {
        const items = await sweepSessions.listRecent({
            limit: Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100)),
            icpId: req.query.icpId || null,
        });
        res.json({ success: true, sessions: items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/grid/errors - persisted per-cell sweep errors.
//
// Reviewed when a rep wants to know "what went wrong on that Manchester
// run?" - returns the cell-level errors recorded by the cron's catch path.
// ?sessionId narrows to one session; otherwise returns the recent globals.
router.get('/errors', async (req, res) => {
    try {
        const items = await sweepErrors.listRecent({
            sessionId: req.query.sessionId || null,
            icpId: req.query.icpId || null,
            limit: Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200)),
        });
        res.json({ success: true, errors: items });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
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

// GET /api/grid/preview-prune?icp=<id>&keepFactor=<n>
// Run the disc-conflict prune over the ICP's existing cells without
// modifying anything. Returns how many pending cells would be dropped at
// the given keepFactor (defaults to the current settings value). Lets the
// Admin UI show "would drop N of M cells" live as the operator slides
// the keepFactor input.
router.get('/preview-prune', async (req, res) => {
    const icp = String(req.query.icp || '').trim();
    if (!icp) return res.status(400).json({ success: false, error: 'icp required' });
    const requested = req.query.keepFactor !== undefined ? Number(req.query.keepFactor) : null;
    const settingsFactor = Number(getCellGeneration().conflictKeepFactor) || 0;
    const keepFactor = Number.isFinite(requested) ? requested : settingsFactor;
    try {
        const preview = await grid.previewPruneForIcp(icp, keepFactor);
        res.json({ success: true, icp, keepFactor, ...preview });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/grid/prune body: { icp, keepFactor? }
// Actually remove the pending cells the prune algorithm flags. Completed/
// empty/scanning cells are never touched (they've already run or are in
// flight). Defaults to the current settings value if `keepFactor` isn't
// passed - the most common UX is "I just bumped this in Admin, clean up
// my pending queue".
router.post('/prune', async (req, res) => {
    const { icp, keepFactor } = req.body || {};
    if (!icp) return res.status(400).json({ success: false, error: 'icp required' });
    const settingsFactor = Number(getCellGeneration().conflictKeepFactor) || 0;
    const factor = keepFactor !== undefined && Number.isFinite(Number(keepFactor))
        ? Number(keepFactor)
        : settingsFactor;
    if (factor <= 0) {
        return res.status(400).json({ success: false, error: 'keepFactor must be > 0 to prune' });
    }
    try {
        const result = await grid.prunePendingCellsForIcp(icp, factor);
        console.log(`[Prune] icp=${icp} factor=${factor} removed=${result.removed} (preview droppedPending=${result.droppedPending})`);
        res.json({ success: true, icp, keepFactor: factor, ...result });
    } catch (err) {
        console.error(`[Prune] icp=${icp} failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Note: the previous POST /reset endpoint (full wipe of cells per ICP, or
// all ICPs if omitted) was removed by design. Coverage no longer exposes
// any data-destructive control - "Reset all" was a foot-gun and we have no
// workflow that legitimately needs to throw away sweep data. If a real
// requirement comes back (e.g. testing fixtures), bring it back as a
// targeted dev-only command rather than a UI button.

module.exports = router;
