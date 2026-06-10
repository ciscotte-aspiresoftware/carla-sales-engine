// Persistent sweep-session tracking. Backed by Supabase table
// `sweep_sessions` (migration 0011). All writes go through safeWrite so
// transient Supabase blips retry instead of silently dropping counter
// updates.
//
// Caller pattern (grid-cron.js):
//   1. On Resume: createSession({ icpId, scope }) → returns {id}
//   2. On each tick: incrementCounters(id, { cellsAttempted: 1, ... })
//   3. On pause / completion / crash: closeSession(id, { status, reason })
//   4. On server boot: markCrashedSessions() reconciles any leftover
//      'running' rows (server died with the session still active)
//
// When Supabase is disabled (USE_SUPABASE=false) every method is a no-op
// that returns a fake session id - the cron tick path stays functional
// against the JSON fallback even without session persistence.

const { isEnabled, getClient } = require('../db');
const { safeSupabase, safeRead } = require('./safe-write');

// Fake id returned in JSON-fallback mode. Lets the cron code use a single
// code path without checking isEnabled() at every counter call.
const NO_OP_SESSION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Insert a new session row in 'running' state. Returns the new id (or the
 * no-op id when Supabase is off). Stores the operator's chosen scope so
 * the Coverage panel can display "Manchester · Bluebird" later.
 */
async function createSession({ icpId = null, scope = null, metadata = {} } = {}) {
    if (!isEnabled()) return NO_OP_SESSION_ID;
    try {
        const row = {
            icp_id: icpId || null,
            scope_type: scope?.type || 'all',
            scope_value: scope?.value || null,
            status: 'running',
            metadata: metadata || {},
        };
        const { data } = await safeSupabase('createSession', () =>
            getClient().from('sweep_sessions').insert(row).select('id').single(),
        );
        return data?.id || NO_OP_SESSION_ID;
    } catch (err) {
        // Permanent failure - log and return the no-op id. The cron tick
        // shouldn't crash because session persistence is unavailable; the
        // sweep itself still works, the operator just loses post-hoc
        // visibility for this run.
        console.warn(`[sweep-sessions] createSession failed permanently: ${err.message}`);
        return NO_OP_SESSION_ID;
    }
}

/**
 * Atomic increment of counter columns. Reads current values, adds the
 * delta, writes back. Not transactional - we accept a small race window
 * for the simplicity of not needing a stored function. The cron is
 * single-instance and one tick at a time, so contention is zero in
 * practice. If two sessions ever interleave (boot-recover + new resume)
 * the worst case is double-counting by 1.
 */
async function incrementCounters(sessionId, delta) {
    if (!isEnabled() || !sessionId || sessionId === NO_OP_SESSION_ID) return;
    try {
        const { data: cur } = await safeSupabase('readSessionCounters', () =>
            getClient().from('sweep_sessions')
                .select('cells_attempted, cells_succeeded, cells_errored, places_found, leads_qualified, already_known, chains_filtered')
                .eq('id', sessionId)
                .maybeSingle(),
        );
        if (!cur) return; // session row gone (shouldn't happen but defensive)
        const patch = {
            cells_attempted:  (cur.cells_attempted  || 0) + (delta.cellsAttempted  || 0),
            cells_succeeded:  (cur.cells_succeeded  || 0) + (delta.cellsSucceeded  || 0),
            cells_errored:    (cur.cells_errored    || 0) + (delta.cellsErrored    || 0),
            places_found:     (cur.places_found     || 0) + (delta.placesFound     || 0),
            leads_qualified:  (cur.leads_qualified  || 0) + (delta.leadsQualified  || 0),
            already_known:    (cur.already_known    || 0) + (delta.alreadyKnown    || 0),
            chains_filtered:  (cur.chains_filtered  || 0) + (delta.chainsFiltered  || 0),
        };
        await safeSupabase('incrementSessionCounters', () =>
            getClient().from('sweep_sessions').update(patch).eq('id', sessionId),
        );
    } catch (err) {
        // Best-effort: a missed counter update is annoying but not fatal.
        console.warn(`[sweep-sessions] incrementCounters failed: ${err.message}`);
    }
}

/**
 * Finalize a session. Sets ended_at + status + pause_reason. Subsequent
 * counter increments against this id will still write (the cron code is
 * defensive about that), but the operator should regard the session as
 * closed.
 */
async function closeSession(sessionId, { status = 'paused', pauseReason = null } = {}) {
    if (!isEnabled() || !sessionId || sessionId === NO_OP_SESSION_ID) return;
    try {
        await safeSupabase('closeSession', () =>
            getClient().from('sweep_sessions').update({
                status,
                pause_reason: pauseReason,
                ended_at: new Date().toISOString(),
            }).eq('id', sessionId),
        );
    } catch (err) {
        console.warn(`[sweep-sessions] closeSession failed: ${err.message}`);
    }
}

/**
 * Boot-time reconciliation: any session left in 'running' state means the
 * server died with that session active (process exit, OOM kill, Render
 * restart). Mark them 'crashed' so they don't pollute "currently active"
 * UI queries.
 */
async function markCrashedSessions() {
    if (!isEnabled()) return 0;
    try {
        const { data } = await safeSupabase('markCrashedSessions', () =>
            getClient().from('sweep_sessions')
                .update({
                    status: 'crashed',
                    pause_reason: 'server restart',
                    ended_at: new Date().toISOString(),
                })
                .eq('status', 'running')
                .select('id'),
        );
        return (data || []).length;
    } catch (err) {
        console.warn(`[sweep-sessions] markCrashedSessions failed: ${err.message}`);
        return 0;
    }
}

/**
 * Fetch most-recent sessions for the Coverage panel. Returns oldest-newest
 * - safest for paginated display.
 */
async function listRecent({ limit = 20, icpId = null } = {}) {
    if (!isEnabled()) return [];
    return await safeRead('listRecentSessions', async () => {
        let q = getClient().from('sweep_sessions').select('*').order('started_at', { ascending: false }).limit(limit);
        if (icpId) q = q.eq('icp_id', icpId);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    }, { fallback: [] });
}

module.exports = {
    createSession,
    incrementCounters,
    closeSession,
    markCrashedSessions,
    listRecent,
    NO_OP_SESSION_ID,
};
