// Grid sweep scheduler.
//
// Picks the next pending cell across all configured ICPs and runs the
// sweep pipeline against it. Looped via setInterval so an early-stage
// demo run can churn through cells without leaving the dev server idle
// overnight.
//
// Two knobs:
//   - SWEEP_TICK_MS: how often we LOOK for a pending cell. Default 30s
//     during dev so users see progress quickly. Bump to ~10 min for
//     overnight production-style behavior.
//   - SWEEP_NIGHTLY_BUDGET: max cells per ICP per "session" - guards
//     against burning through Scrapingdog credits if seeded cells are
//     plentiful. Reset by calling resetBudget().
//
// One sweep at a time globally - the inFlight flag means a long Firecrawl
// scrape (~10s) won't be interrupted by the next tick. If a sweep takes
// 30s and the tick is 30s, the next tick just no-ops and waits.

const { listIcps, getIcp } = require('./icps');
const grid = require('./grid-store');
const { sweepCell } = require('./sweep-pipeline');
const mode = require('./mode');
const { pushEvent } = require('./activity-log');

const SWEEP_TICK_MS = parseInt(process.env.BLUEBIRD_SWEEP_TICK_MS || '30000', 10);
// Default capped at 2 to keep real-mode credit spend low while the operator
// validates results. Override via BLUEBIRD_SWEEP_BUDGET when you're ready
// to run longer sessions. Hitting the cap pauses that ICP until "Resume
// sweeping" (which POSTs /api/grid/reset-budget) zeros the counter.
const SWEEP_NIGHTLY_BUDGET = parseInt(process.env.BLUEBIRD_SWEEP_BUDGET || '2', 10);

let cronTimer = null;
let inFlight = false;
// Boot-into-paused. The sweep cron must be explicitly resumed by the
// operator (via POST /api/grid/reset-budget) before any real-mode credit
// is spent. The auto-tick on startup used to silently fire a sweep 5s
// after boot — fine for demo mode, dangerous in real mode. With this
// flag the operator is always one click away from a new session, never
// surprised by one.
let paused = true;
const sweptThisSession = {}; // { [icpId]: count }
// Per-ICP running totals for the current session, used to fan out a
// "session summary" activity event the moment that ICP's budget is hit.
// Keyed by icpId; reset alongside sweptThisSession in resetBudget().
const sessionStats = {}; // { [icpId]: { cellsSwept, placesFound, leadsQualified, alreadyKnown, chainsFiltered, startedAt } }
// Tracks which ICPs have already published their "session complete"
// summary so the event fires exactly once per session even though the
// tick loop revisits each ICP every 30s. Cleared in resetBudget().
const sessionAnnounced = new Set();

function resetBudget() {
    for (const k of Object.keys(sweptThisSession)) sweptThisSession[k] = 0;
    for (const k of Object.keys(sessionStats)) delete sessionStats[k];
    sessionAnnounced.clear();
    paused = false; // unpause so the next tick starts a fresh session
    console.log('[Sweep Cron] ▶ Session resumed - all ICPs back to 0 sweeps this session');
}

function isPaused() {
    return paused;
}

async function tick() {
    if (inFlight) return; // previous sweep still going
    // Hard gate: demo mode parks the sweeper so we don't burn Scrapingdog/
    // Firecrawl/OpenAI credits against the seeded data set. Flip to real
    // on the /admin page to let sweeps run.
    if (mode.isDemo()) return;
    // Soft gate: the operator must explicitly press "Resume sweeping" to
    // start a session. Boots paused; auto-pauses when budget exhausted
    // or no pending work remains. No tick body executes while paused.
    if (paused) return;
    inFlight = true;
    let processedThisTick = false;
    try {
        for (const icpMeta of listIcps()) {
            // Per-ICP nightly budget cap. Once hit, this ICP gets skipped
            // until resetBudget() is called (e.g. by a daily cron at midnight).
            const used = sweptThisSession[icpMeta.id] || 0;
            if (used >= SWEEP_NIGHTLY_BUDGET) continue;

            const cell = await grid.nextPendingCell(icpMeta.id);
            if (!cell) continue; // no pending cells for this ICP

            const icp = getIcp(icpMeta.id);
            if (!icp) {
                console.warn(`[Sweep Cron] ICP ${icpMeta.id} disappeared - skipping`);
                continue;
            }
            try {
                const result = await sweepCell(icp, cell);
                sweptThisSession[icpMeta.id] = used + 1;
                processedThisTick = true;
                // Accumulate session totals so we can emit a single
                // summary line when this ICP's budget is exhausted.
                // sweepCell returns { state, placesFound, leadsQualified };
                // we also pull alreadyKnown/chainsFiltered off the cell
                // after the update for a complete tally.
                const refreshed = await grid.getCell(cell.id);
                const stats = sessionStats[icpMeta.id] || { cellsSwept: 0, placesFound: 0, leadsQualified: 0, alreadyKnown: 0, chainsFiltered: 0, startedAt: Date.now() };
                stats.cellsSwept += 1;
                stats.placesFound += (result?.placesFound || refreshed?.placesFound || 0);
                stats.leadsQualified += (result?.leadsQualified || refreshed?.leadsQualified || 0);
                stats.alreadyKnown += (refreshed?.alreadyKnown || 0);
                stats.chainsFiltered += (refreshed?.chainsFiltered || 0);
                sessionStats[icpMeta.id] = stats;
                await grid.setLastSweepAt(Date.now());

                // Budget just exhausted: announce the session summary
                // once. Fires through the activity feed so the operator
                // sees the run totals at the top of the Coverage log.
                if (sweptThisSession[icpMeta.id] >= SWEEP_NIGHTLY_BUDGET && !sessionAnnounced.has(icpMeta.id)) {
                    sessionAnnounced.add(icpMeta.id);
                    const elapsedMs = Date.now() - stats.startedAt;
                    const elapsedStr = elapsedMs < 60000
                        ? `${Math.round(elapsedMs / 1000)}s`
                        : `${Math.round(elapsedMs / 60000)}m ${Math.round((elapsedMs % 60000) / 1000)}s`;
                    const msg = `Session paused for "${icp.name}" — ${stats.cellsSwept} cells, ${stats.placesFound} companies scraped, ${stats.leadsQualified} qualified (in ${elapsedStr}). Hit "Resume sweeping" to continue.`;
                    pushEvent({
                        type: 'session_summary',
                        icpId: icpMeta.id,
                        cellsSwept: stats.cellsSwept,
                        placesFound: stats.placesFound,
                        leadsQualified: stats.leadsQualified,
                        alreadyKnown: stats.alreadyKnown,
                        chainsFiltered: stats.chainsFiltered,
                        elapsedMs,
                        message: msg,
                    });
                    console.log(`[Sweep Cron] ◀ ${msg}`);
                }
            } catch (err) {
                console.error(`[Sweep Cron] sweep failed for ${icp.id}/${cell.id}: ${err.message}`);
                // sweepCell already reset the cell to pending on hard error;
                // bail out of this tick so we don't immediately retry the
                // same broken cell in a tight loop. Next tick = next attempt.
                break;
            }
            // Process one cell per tick. Keeps Scrapingdog calls spaced
            // out and gives the dev a chance to inspect logs between
            // cells. To process a batch per tick, wrap this in a loop.
            break;
        }
        // If this tick found no eligible work (every ICP at cap OR no
        // pending cells remain), auto-pause so we don't keep ticking
        // forever, and emit a global pause event so the activity feed
        // shows a clear stop. Next "Resume sweeping" click re-arms.
        if (!processedThisTick && !paused) {
            paused = true;
            pushEvent({
                type: 'session_summary',
                cellsSwept: 0,
                placesFound: 0,
                leadsQualified: 0,
                message: 'No more cells to sweep — session paused. Hit "Resume sweeping" or seed more cells.',
            });
            console.log('[Sweep Cron] ⏸ Auto-paused — no eligible work this tick');
        }
    } finally {
        inFlight = false;
    }
}

function startCron() {
    if (cronTimer) {
        console.log('[Sweep Cron] Already running');
        return;
    }
    // Rescue orphaned `scanning` cells from a previous kill/crash. A
    // clean sweep always exits with the cell in complete/empty/pending —
    // anything still `scanning` on boot belongs to a process that never
    // got to finish. Flip those back to pending so the cron re-picks
    // them rather than leaving zombie red dots on the Coverage globe.
    grid.rescuOrphanedScanningCells().then((n) => {
        if (n > 0) console.log(`[Sweep Cron] Rescued ${n} orphaned scanning cell(s) → pending`);
    }).catch((err) => {
        console.warn(`[Sweep Cron] Orphan rescue failed: ${err.message}`);
    });
    cronTimer = setInterval(tick, SWEEP_TICK_MS);
    // No auto-tick on boot. The cron is paused by default — a session
    // only starts when the operator hits "Resume sweeping" (POST
    // /api/grid/reset-budget), which clears the paused flag. This
    // prevents unintended credit spend after a server restart.
    const gateMsg = mode.isDemo()
        ? ' (parked: demo mode active)'
        : ' (paused — press "Resume sweeping" to start a session)';
    console.log(`[Sweep Cron] Started - tick every ${SWEEP_TICK_MS / 1000}s, budget ${SWEEP_NIGHTLY_BUDGET} cells/ICP/session${gateMsg}`);
}

function stopCron() {
    if (cronTimer) clearInterval(cronTimer);
    cronTimer = null;
    console.log('[Sweep Cron] Stopped');
}

module.exports = { startCron, stopCron, resetBudget, tick, isPaused };
