// Persistent per-cell sweep errors. Backed by Supabase table sweep_errors
// (migration 0012). Called from grid-cron.js's catch path and from the
// per-service rotation wrappers (Scrapingdog 5xx, Firecrawl credit, etc).
//
// Calls are fire-and-forget - we never want error logging to itself become
// a source of errors that propagates up to the cron. safeSupabase still
// retries the insert, but if it ultimately fails the error stays in
// Render's console logs as a fallback.

const { isEnabled, getClient } = require('../db');
const { safeSupabase } = require('./safe-write');

// Classify an axios-style error into our service-agnostic error_type
// vocabulary. Called by the cron when it doesn't have richer context. The
// per-service wrappers (scrapingdog.js, firecrawl.js) pass an explicit
// type when they know better.
function classifyError(err) {
    const status = err?.response?.status;
    const txt = String(err?.response?.data || err?.message || '').toLowerCase();
    if (status >= 500 && status <= 599) return 'transient_5xx';
    if (status === 429 || /rate.limit|too many requests/.test(txt)) return 'rate_limit';
    if (status === 402 || /insufficient.credits|no credits|credits.exhausted|billing|payment|quota/.test(txt)) return 'credit_exhausted';
    if (status >= 400 && status < 500) return 'permanent';
    return 'unknown';
}

/**
 * Record an error against the active sweep session. Fire-and-forget -
 * never throws. Pass `recovered=true` when the upstream retry succeeded
 * (logged for visibility but the cell completed normally).
 *
 * @param {object} opts
 * @param {string} opts.sessionId    - active sweep session id
 * @param {string} opts.cellId       - grid_cells.id (or null for non-cell errors)
 * @param {string} opts.icpId        - the icp this error happened under
 * @param {string} [opts.service]    - 'scrapingdog' | 'firecrawl' | 'openai' | 'apollo' | 'apify' | 'internal'
 * @param {string} [opts.errorType]  - explicit type; otherwise inferred from `error`
 * @param {Error|string} opts.error  - the thrown error or a message string
 * @param {boolean} [opts.recovered] - true if retry succeeded
 * @param {object} [opts.metadata]   - JSON blob for context (request params, etc)
 */
async function record({ sessionId = null, cellId = null, icpId = null, service = 'internal', errorType = null, error, recovered = false, metadata = {} } = {}) {
    if (!isEnabled()) return;
    if (sessionId === '00000000-0000-0000-0000-000000000000') sessionId = null;
    const message = error instanceof Error ? error.message : String(error || '(no message)');
    const type = errorType || (error instanceof Error ? classifyError(error) : 'unknown');
    try {
        await safeSupabase('recordSweepError', () =>
            getClient().from('sweep_errors').insert({
                session_id: sessionId,
                cell_id: cellId,
                icp_id: icpId,
                service,
                error_type: type,
                error_message: message.slice(0, 2000),  // cap to avoid blowing up logs / row size
                recovered,
                metadata: metadata || {},
            }),
        );
    } catch (err) {
        // Best-effort. The console log from grid-cron.js's catch is the
        // ultimate fallback if persisted logging is broken.
        console.warn(`[sweep-errors] record failed: ${err.message}`);
    }
}

/**
 * Fetch recent errors for the Coverage panel. By default narrows to a
 * specific session; pass sessionId=null + limit=50 to get "last 50 across
 * all sessions" for a global view.
 */
async function listRecent({ sessionId = null, limit = 50, icpId = null } = {}) {
    if (!isEnabled()) return [];
    try {
        let q = getClient().from('sweep_errors').select('*').order('occurred_at', { ascending: false }).limit(limit);
        if (sessionId) q = q.eq('session_id', sessionId);
        if (icpId) q = q.eq('icp_id', icpId);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    } catch (err) {
        console.warn(`[sweep-errors] listRecent failed: ${err.message}`);
        return [];
    }
}

module.exports = { record, listRecent, classifyError };
