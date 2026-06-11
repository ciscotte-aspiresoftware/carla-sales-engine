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
const sweepSessions = require('./sweep-sessions');
const sweepErrors = require('./sweep-errors');

// 5s default. The cron's `inFlight` flag stops overlapping ticks, so a low
// interval is safe - during a mid-sweep cell it just no-ops until the cell
// completes, and the moment the cell is done the next tick picks up almost
// immediately (vs up to 30s of idle time before). Bump via env to 600000 for
// overnight production-style behaviour.
const SWEEP_TICK_MS = parseInt(process.env.CARLA_SWEEP_TICK_MS || '5000', 10);
// Default capped at 2 to keep real-mode credit spend low while the operator
// validates results. Override via CARLA_SWEEP_BUDGET when you're ready
// to run longer sessions. Hitting the cap pauses that ICP until "Resume
// sweeping" (which POSTs /api/grid/reset-budget) zeros the counter.
const SWEEP_NIGHTLY_BUDGET = parseInt(process.env.CARLA_SWEEP_BUDGET || '2', 10);

let cronTimer = null;
let inFlight = false;
// Boot-into-paused. The sweep cron must be explicitly resumed by the
// operator (via POST /api/grid/reset-budget) before any real-mode credit
// is spent. The auto-tick on startup used to silently fire a sweep 5s
// after boot - fine for demo mode, dangerous in real mode. With this
// flag the operator is always one click away from a new session, never
// surprised by one.
let paused = true;
// Why the cron is currently paused. Lets the Coverage page gate the big
// "Resume sweeping" banner to ONLY manual pauses - auto-pauses (budget
// cap hit, no work left in scope) shouldn't get the prominent banner
// since they're an expected end-of-session, not an interruption. Values:
//   'manual'   - operator clicked Pause
//   'budget'   - per-ICP cell budget exhausted at tick boundary
//   'no_work'  - no pending cells remain in active scope
//   'boot'     - fresh restart; cron always boots paused before any
//                resume click. Frontend treats this the same as auto-
//                pause (no banner) so a redeploy doesn't nag the user
//                with a Resume banner that has no prior session to resume.
let pauseReason = 'boot';
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
// Database id of the persisted sweep_sessions row for the CURRENT session.
// Set in resetBudget(), cleared on close/auto-pause. When falsy, persistence
// is skipped (e.g. Supabase off, or no session has been started since boot).
// See api/utils/sweep-sessions.js for the lifecycle.
let currentSessionId = null;
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
async function resetBudget(icpId = null, scope = null) {
    // If a prior session is still open (operator clicked Resume without an
    // intervening Pause - shouldn't happen via UI but possible via direct
    // API call), close it cleanly first so we don't leave an orphan row
    // in 'running' state forever.
    if (currentSessionId) {
        await sweepSessions.closeSession(currentSessionId, { status: 'paused', pauseReason: 'manual' })
            .catch(() => {});
        currentSessionId = null;
    }
    for (const k of Object.keys(sweptThisSession)) sweptThisSession[k] = 0;
    for (const k of Object.keys(sessionStats)) delete sessionStats[k];
    sessionAnnounced.clear();
    activeScope = icpId ? { icpId, scope: scope || null } : null;
    paused = false; // unpause so the next tick starts a fresh session
    pauseReason = null; // clear the prior reason so /sweep-state reflects "running"
    // Resume clears any prior mid-sweep pause request so the cron doesn't
    // immediately re-pause the next cell it picks up. The pipeline still
    // reads checkpointed cells correctly: `pause_checkpoint` lives on the
    // cell, independent of this in-memory flag.
    pauseRequested = false;

    // Persist the new session. createSession returns a fake id when
    // Supabase is off, which the rest of the code treats as a no-op - so
    // we can call it unconditionally without branching.
    currentSessionId = await sweepSessions.createSession({
        icpId: icpId || null,
        scope: scope || null,
    });

    if (activeScope) {
        const s = activeScope.scope;
        const label = s && s.type
            ? `${s.type}${s.value ? `=${s.value}` : ''}`
            : 'no-scope';
        console.log(`[Sweep Cron] ▶ Session resumed - icp=${activeScope.icpId} scope=${label} (other ICPs/scopes skipped) [sid=${currentSessionId.slice(0, 8)}]`);
        if (icpId && scope && scope.type) {
            sweepState.setLastScope(icpId, scope);
        }
    } else {
        console.log(`[Sweep Cron] ▶ Session resumed - all ICPs back to 0 sweeps this session [sid=${currentSessionId.slice(0, 8)}]`);
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
    pauseReason = 'manual';
    // Close the persisted session row with status='paused' so the Recent
    // Sessions panel shows the right state. Fire-and-forget; the manual
    // pause path was instant before, we don't want to await DB writes.
    if (currentSessionId) {
        sweepSessions.closeSession(currentSessionId, { status: 'paused', pauseReason: 'manual' });
        currentSessionId = null;
    }
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
    // sawError distinguishes "the tick had nothing to do" (auto-pause is
    // correct) from "the tick tried and failed on a transient error"
    // (cell will retry next tick, do NOT auto-pause). Before this flag,
    // a single Scrapingdog 502 would force the operator to manually
    // Resume - one external hiccup nuking the whole session.
    let sawError = false;
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
                const placesFound = result?.placesFound || refreshed?.placesFound || 0;
                const leadsQualified = result?.leadsQualified || refreshed?.leadsQualified || 0;
                const alreadyKnown = refreshed?.alreadyKnown || 0;
                const chainsFiltered = refreshed?.chainsFiltered || 0;
                const stats = sessionStats[icpMeta.id] || { cellsSwept: 0, placesFound: 0, leadsQualified: 0, alreadyKnown: 0, chainsFiltered: 0, startedAt: Date.now() };
                stats.cellsSwept += 1;
                stats.placesFound += placesFound;
                stats.leadsQualified += leadsQualified;
                stats.alreadyKnown += alreadyKnown;
                stats.chainsFiltered += chainsFiltered;
                sessionStats[icpMeta.id] = stats;
                await grid.setLastSweepAt(Date.now());
                // Mirror the in-memory tally into the persisted session
                // row so it survives a restart. Fire-and-forget - a missed
                // counter update is annoying but not pipeline-breaking.
                sweepSessions.incrementCounters(currentSessionId, {
                    cellsAttempted: 1,
                    cellsSucceeded: 1,
                    placesFound,
                    leadsQualified,
                    alreadyKnown,
                    chainsFiltered,
                });

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
                sawError = true;
                // Persist the error so the Coverage panel shows what
                // happened. Fire-and-forget. Service tag defaults to
                // 'internal' since at this layer we've lost the upstream
                // context - per-service wrappers (Scrapingdog 5xx etc) can
                // record their own richer rows separately if we extend
                // them later.
                sweepErrors.record({
                    sessionId: currentSessionId,
                    cellId: cell.id,
                    icpId: icp.id,
                    service: 'internal',
                    error: err,
                    recovered: false,
                    metadata: { city: cell.parentCity, lat: cell.lat, lng: cell.lng },
                });
                sweepSessions.incrementCounters(currentSessionId, { cellsAttempted: 1, cellsErrored: 1 });
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
        // Auto-pause ONLY when this tick genuinely had no work to do (every
        // ICP at cap OR no pending cells). A transient error - the
        // sawError branch below - means there WAS work, we tried, it
        // failed, and the next tick should retry. Pausing on transient
        // errors makes a single Scrapingdog 502 force the operator to
        // manually Resume, which is unacceptable for unattended runs.
        if (!processedThisTick && !sawError && !paused) {
            paused = true;
            activeScope = null; // clear filter so next Resume can pick a new ICP/scope or default to all
            // Determine pause reason from the budget state: if any ICP hit
            // its cap this session, that's why we have nothing more to do;
            // otherwise the queue is genuinely drained.
            const reachedBudget = Object.values(sweptThisSession).some((c) => c >= SWEEP_NIGHTLY_BUDGET);
            const reason = reachedBudget ? 'budget' : 'no_work';
            pauseReason = reason;
            const finalStatus = reachedBudget ? 'paused' : 'completed';
            if (currentSessionId) {
                sweepSessions.closeSession(currentSessionId, { status: finalStatus, pauseReason: reason });
                currentSessionId = null;
            }
            pushEvent({
                type: 'session_summary',
                cellsSwept: 0,
                placesFound: 0,
                leadsQualified: 0,
                message: 'No more cells to sweep - session paused. Hit "Resume sweeping" or seed more cells.',
            });
            console.log(`[Sweep Cron] ⏸ Auto-paused - ${reason}`);
        } else if (!processedThisTick && sawError) {
            // Stay unpaused; cell will get another shot on the next tick.
            // Log only - not loud enough to need an event in the activity
            // feed, but the operator should see it if watching the console.
            console.log('[Sweep Cron] ⏵ Cell errored - staying unpaused, retrying next tick');
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
    // Reconcile any sweep_sessions left in 'running' from before this boot.
    // If the server died mid-session (Render restart, OOM, etc.) those rows
    // never got their ended_at/status finalized. Mark them 'crashed' so the
    // Recent Sessions panel reads cleanly. Best-effort; doesn't block startup.
    sweepSessions.markCrashedSessions().then((n) => {
        if (n > 0) console.log(`[Sweep Cron] Reconciled ${n} sweep session(s) left 'running' → 'crashed'`);
    }).catch((err) => {
        console.warn(`[Sweep Cron] Session reconcile failed: ${err.message}`);
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

function getPauseReason() { return paused ? pauseReason : null; }

module.exports = { startCron, stopCron, resetBudget, tick, isPaused, requestPause, isPauseRequested, getPauseReason };
