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
const { pushEvent } = require('./activity-log');
const sweepState = require('./sweep-state');

// 5s default. The cron's `inFlight` flag stops overlapping ticks, so a low
// interval is safe - during a mid-sweep cell it just no-ops until the cell
// completes, and the moment the cell is done the next tick picks up almost
// immediately (vs up to 30s of idle time before). Bump via env to 600000 for
// overnight production-style behaviour.
const SWEEP_TICK_MS = parseInt(process.env.BLUEBIRD_SWEEP_TICK_MS || '5000', 10);
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
// after boot - fine for demo mode, dangerous in real mode. With this
// flag the operator is always one click away from a new session, never
// surprised by one.
let paused = true;
// `pauseRequested` is a DIFFERENT signal from `paused`. `paused` gates the
// cron tick loop (no new cell starts when true). `pauseRequested` is what
// the sweep pipeline itself reads at company-boundary checkpoints to know
// "the operator wants me to stop mid-cell - save where I am and bail".
// Set together when the user clicks Pause; cleared together on Resume.
// The cron's auto-pause (no work, budget hit) only toggles `paused`,
// because there's no in-flight sweep to interrupt in that case.
let pauseRequested = false;
// When non-null, the tick loop ONLY processes cells matching this scope -
// other ICPs (and other scopes within the same ICP) get skipped even if
// they have pending cells. Set via resetBudget(icpId, scope). null = process
// every ICP in rotation with no scope filter (legacy behavior).
//
// Shape: { icpId: string, scope: { type: 'city'|'country'|'all', value: string|null } | null }
// Cleared on auto-pause so the next Resume picks up the UI's then-current scope.
let activeScope = null;
const sweptThisSession = {}; // { [icpId]: count }
// Per-ICP running totals for the current session, used to fan out a
// "session summary" activity event the moment that ICP's budget is hit.
// Keyed by icpId; reset alongside sweptThisSession in resetBudget().
const sessionStats = {}; // { [icpId]: { cellsSwept, placesFound, leadsQualified, alreadyKnown, chainsFiltered, startedAt } }
// Tracks which ICPs have already published their "session complete"
// summary so the event fires exactly once per session even though the
// tick loop revisits each ICP every 30s. Cleared in resetBudget().
const sessionAnnounced = new Set();

// Resume a session. Two ways to call:
//   - resetBudget()                          → no scope, rotate across all ICPs
//   - resetBudget(icpId)                     → lock to this ICP, no scope filter
//   - resetBudget(icpId, {type, value})      → lock to this ICP AND this scope
//                                              (e.g. {type:'city', value:'Amsterdam'})
//
// When a scope is provided we also persist it as the "last active scope" for
// that ICP via sweep-state, so the UI can show "last: Amsterdam · 12/40 cells"
// chips and the operator's cross-restart workflow stays visible.
function resetBudget(icpId = null, scope = null) {
    for (const k of Object.keys(sweptThisSession)) sweptThisSession[k] = 0;
    for (const k of Object.keys(sessionStats)) delete sessionStats[k];
    sessionAnnounced.clear();
    activeScope = icpId ? { icpId, scope: scope || null } : null;
    paused = false; // unpause so the next tick starts a fresh session
    // Resume clears any prior mid-sweep pause request so the cron doesn't
    // immediately re-pause the next cell it picks up. The pipeline still
    // reads checkpointed cells correctly: `pause_checkpoint` lives on the
    // cell, independent of this in-memory flag.
    pauseRequested = false;
    if (activeScope) {
        const s = activeScope.scope;
        const label = s && s.type
            ? `${s.type}${s.value ? `=${s.value}` : ''}`
            : 'no-scope';
        console.log(`[Sweep Cron] ▶ Session resumed - icp=${activeScope.icpId} scope=${label} (other ICPs/scopes skipped)`);
        if (icpId && scope && scope.type) {
            sweepState.setLastScope(icpId, scope);
        }
    } else {
        console.log('[Sweep Cron] ▶ Session resumed - all ICPs back to 0 sweeps this session');
    }
}

function isPaused() {
    return paused;
}

// Two-phase pause:
//   1. requestPause() flips both flags. The sweep pipeline's in-flight cell
//      reads `pauseRequested` at company-boundary checkpoints, writes its
//      pause_checkpoint, and returns. Cron tick gate (`paused=true`) also
//      blocks any new cell starts.
//   2. The cell ends up in `state='pending'` with a `pause_checkpoint`, and
//      stays there until the operator hits Resume (which is the existing
//      resetBudget() above - it clears both flags).
function requestPause() {
    pauseRequested = true;
    paused = true;
    console.log('[Sweep Cron] ⏸ Pause requested - in-flight cell will checkpoint at the next company boundary');
}
function isPauseRequested() {
    return pauseRequested;
}

async function tick() {
    if (inFlight) return; // previous sweep still going
    // Soft gate: the operator must explicitly press "Resume sweeping" to
    // start a session. Boots paused; auto-pauses when budget exhausted
    // or no pending work remains. No tick body executes while paused.
    if (paused) return;
    inFlight = true;
    let processedThisTick = false;
    try {
        for (const icpMeta of listIcps()) {
            // Active-scope filter - when the operator hit Resume Sweeping
            // with a selected ICP (and optional scope), only that ICP +
            // scope is processed this session.
            if (activeScope && icpMeta.id !== activeScope.icpId) continue;
            // Per-ICP nightly budget cap. Once hit, this ICP gets skipped
            // until resetBudget() is called (e.g. by a daily cron at midnight).
            const used = sweptThisSession[icpMeta.id] || 0;
            if (used >= SWEEP_NIGHTLY_BUDGET) continue;

            const cell = await grid.nextPendingCell(
                icpMeta.id,
                activeScope ? activeScope.scope : null,
            );
            if (!cell) continue; // no pending cells for this ICP+scope

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
                    const msg = `Session paused for "${icp.name}" - ${stats.cellsSwept} cells, ${stats.placesFound} companies scraped, ${stats.leadsQualified} qualified (in ${elapsedStr}). Hit "Resume sweeping" to continue.`;
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
            activeScope = null; // clear filter so next Resume can pick a new ICP/scope or default to all
            pushEvent({
                type: 'session_summary',
                cellsSwept: 0,
                placesFound: 0,
                leadsQualified: 0,
                message: 'No more cells to sweep - session paused. Hit "Resume sweeping" or seed more cells.',
            });
            console.log('[Sweep Cron] ⏸ Auto-paused - no eligible work this tick');
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
    // clean sweep always exits with the cell in complete/empty/pending -
    // anything still `scanning` on boot belongs to a process that never
    // got to finish. Flip those back to pending so the cron re-picks
    // them rather than leaving zombie red dots on the Coverage globe.
    grid.rescuOrphanedScanningCells().then((n) => {
        if (n > 0) console.log(`[Sweep Cron] Rescued ${n} orphaned scanning cell(s) → pending`);
    }).catch((err) => {
        console.warn(`[Sweep Cron] Orphan rescue failed: ${err.message}`);
    });
    cronTimer = setInterval(tick, SWEEP_TICK_MS);
    // No auto-tick on boot. The cron is paused by default - a session
    // only starts when the operator hits "Resume sweeping" (POST
    // /api/grid/reset-budget), which clears the paused flag. This
    // prevents unintended credit spend after a server restart.
    console.log(`[Sweep Cron] Started - tick every ${SWEEP_TICK_MS / 1000}s, budget ${SWEEP_NIGHTLY_BUDGET} cells/ICP/session (paused - press "Resume sweeping" to start a session)`);
}

function stopCron() {
    if (cronTimer) clearInterval(cronTimer);
    cronTimer = null;
    console.log('[Sweep Cron] Stopped');
}

module.exports = { startCron, stopCron, resetBudget, tick, isPaused, requestPause, isPauseRequested };
