// Persisted reclassify-job lifecycle. Backed by Supabase tables
// `reclassify_jobs` + `reclassify_results` (migrations 0014, 0015). Mirrors
// the sweep-sessions.js shape so the patterns stay consistent across the
// two queues.
//
// Caller patterns:
//   - POST /api/icps/:id/reclassify (routes/icps.js):
//       enqueue({ icpId, force, targets }) → returns { jobId, total }
//   - utils/reclassify-worker.js (the tick loop):
//       claimNextBatch(jobId, limit)  → up to `limit` pending result rows
//       finalizeResult(resultId, ...) → stamp the terminal status + bump job counters
//   - Boot recovery (api/index.js):
//       markCrashedJobs() reconciles 'running' rows left over by a process exit
//
// Every Supabase call is wrapped in safeSupabase so transient DB blips
// retry with backoff. Permanent failures throw - callers (worker, routes)
// handle them.

const { isEnabled, getClient } = require('../db');
const { safeSupabase, safeRead } = require('./safe-write');

function notEnabledError() {
    return new Error('Supabase is disabled (USE_SUPABASE=false). Reclassify jobs require Supabase.');
}

/**
 * Insert a job row + a result row per target domain in a single round-trip
 * per table. Returns `{ jobId, total }`. The caller (the route) responds
 * to the rep immediately - the worker picks up the job on its next tick.
 *
 * `targets` shape: [{ domain, companyName?, city?, oldVerdict?: {is_match, reason} }, ...]
 * Order is preserved via array index → result.order_idx.
 *
 * Pre-seeded with status='pending' (or 'skipped' for force=false + already-
 * classified rows) so the worker can claim by status without re-deriving
 * the skip condition at tick time.
 */
async function enqueue({ icpId, force = false, targets, metadata = {} }) {
    if (!isEnabled()) throw notEnabledError();
    if (!icpId) throw new Error('icpId required');
    if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error('targets array required and must be non-empty');
    }

    const { data: jobRow } = await safeSupabase('enqueueReclassifyJob', () =>
        getClient().from('reclassify_jobs').insert({
            icp_id: icpId,
            status: 'pending',
            force,
            total: targets.length,
            metadata: metadata || {},
        }).select('id').single(),
    );
    const jobId = jobRow.id;

    // Pre-skip rows that are already classified when force=false. The
    // worker would re-derive the same condition but doing it here makes the
    // initial UI render accurate ("48 skipped, 18 to process") and removes
    // one round-trip per row from the worker's hot path.
    const rows = targets.map((t, idx) => {
        const hasOld = t.oldVerdict && (t.oldVerdict.is_match === true || t.oldVerdict.is_match === false);
        const presentAndStable = hasOld && !force;
        return {
            job_id: jobId,
            order_idx: idx,
            domain: t.domain,
            company_name: t.companyName || null,
            city: t.city || null,
            status: presentAndStable ? 'skipped' : 'pending',
            old_is_match: hasOld ? !!t.oldVerdict.is_match : null,
            old_reason: hasOld ? (t.oldVerdict.reason || null) : null,
            skip_reason: presentAndStable ? 'already classified (force=false)' : null,
            completed_at: presentAndStable ? new Date().toISOString() : null,
        };
    });

    // Supabase's PostgREST is happy with batches up to ~1000 rows in one
    // INSERT; chunk defensively in case someone reclassifies a 5k-domain
    // ICP at once.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        await safeSupabase('enqueueReclassifyResults', () =>
            getClient().from('reclassify_results').insert(rows.slice(i, i + CHUNK)),
        );
    }

    // If everything was pre-skipped, finalize the job immediately so the
    // recent-jobs panel doesn't show a phantom "pending" row that never moves.
    const preSkipped = rows.filter((r) => r.status === 'skipped').length;
    if (preSkipped > 0) {
        await safeSupabase('seedPreSkipCounters', () =>
            getClient().from('reclassify_jobs').update({
                skipped: preSkipped,
                processed: preSkipped,
            }).eq('id', jobId),
        );
    }
    if (preSkipped === rows.length) {
        await safeSupabase('autoFinalizeAllSkipped', () =>
            getClient().from('reclassify_jobs').update({
                status: 'completed',
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
            }).eq('id', jobId),
        );
    }

    return { jobId, total: rows.length };
}

/**
 * Claim up to `limit` pending result rows for the given job. Sets each to
 * status='in_flight' atomically by domain UPDATE so two ticks can't race
 * for the same row.
 *
 * Returns the claimed rows (not the in_flight versions). Returns [] when
 * no pending rows remain.
 *
 * Implementation note: PostgREST doesn't expose UPDATE...RETURNING with a
 * LIMIT clause directly, so we read N pending ids first then UPDATE by id.
 * The two-round-trip cost is fine at a tick cadence; the alternative
 * (stored function) would buy us atomicity but adds a SQL surface to
 * maintain.
 */
async function claimNextBatch(jobId, limit) {
    if (!isEnabled()) throw notEnabledError();
    const { data: candidates } = await safeSupabase('readPendingResults', () =>
        getClient().from('reclassify_results')
            .select('*')
            .eq('job_id', jobId)
            .eq('status', 'pending')
            .order('order_idx', { ascending: true })
            .limit(limit),
    );
    const rows = candidates || [];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    await safeSupabase('claimPendingResults', () =>
        getClient().from('reclassify_results').update({
            status: 'in_flight',
            attempted_at: new Date().toISOString(),
        }).in('id', ids),
    );
    return rows;
}

/**
 * Stamp the terminal status on a result row + atomically bump the parent
 * job's counters. Called by the worker after each classify resolves.
 *
 * `outcome` shape:
 *   classified: { newIsMatch, newReason, modelUsed, flipped }
 *   skipped:    { skipReason }
 *   errored:    { errorMessage }
 *   cancelled:  {}
 */
async function finalizeResult(resultRow, kind, outcome = {}) {
    if (!isEnabled()) throw notEnabledError();
    const patch = {
        status: kind,
        completed_at: new Date().toISOString(),
    };
    if (kind === 'classified') {
        patch.new_is_match = !!outcome.newIsMatch;
        patch.new_reason = outcome.newReason || null;
        patch.flipped = !!outcome.flipped;
        patch.model_used = outcome.modelUsed || null;
    } else if (kind === 'skipped') {
        patch.skip_reason = outcome.skipReason || null;
    } else if (kind === 'errored') {
        patch.error_message = outcome.errorMessage || null;
    }
    await safeSupabase('finalizeResult', () =>
        getClient().from('reclassify_results').update(patch).eq('id', resultRow.id),
    );

    // Counter bump on the parent job. Same race-tolerance comment as
    // sweep-sessions.incrementCounters - we accept a single-step race in
    // exchange for not needing a SQL stored function.
    const delta = {
        processed: 1,
        qualified: kind === 'classified' && outcome.newIsMatch ? 1 : 0,
        rejected: kind === 'classified' && !outcome.newIsMatch ? 1 : 0,
        flipped: kind === 'classified' && outcome.flipped ? 1 : 0,
        skipped: kind === 'skipped' ? 1 : 0,
        errors: kind === 'errored' ? 1 : 0,
    };
    const { data: cur } = await safeSupabase('readJobCounters', () =>
        getClient().from('reclassify_jobs')
            .select('processed, qualified, rejected, flipped, skipped, errors')
            .eq('id', resultRow.job_id)
            .maybeSingle(),
    );
    if (!cur) return;
    await safeSupabase('bumpJobCounters', () =>
        getClient().from('reclassify_jobs').update({
            processed: (cur.processed || 0) + delta.processed,
            qualified: (cur.qualified || 0) + delta.qualified,
            rejected: (cur.rejected || 0) + delta.rejected,
            flipped: (cur.flipped || 0) + delta.flipped,
            skipped: (cur.skipped || 0) + delta.skipped,
            errors: (cur.errors || 0) + delta.errors,
        }).eq('id', resultRow.job_id),
    );
}

/**
 * Flip a job's status. Called by the worker when transitioning between
 * pending/running/completed and by routes/icps.js for cancel.
 */
async function setStatus(jobId, status, { error = null, currentDomain = null, touchStartedAt = false, touchFinishedAt = false } = {}) {
    if (!isEnabled()) return;
    const patch = { status };
    if (error !== null) patch.last_error = error;
    if (currentDomain !== null) patch.current_domain = currentDomain;
    if (touchStartedAt) patch.started_at = new Date().toISOString();
    if (touchFinishedAt) patch.finished_at = new Date().toISOString();
    await safeSupabase('setJobStatus', () =>
        getClient().from('reclassify_jobs').update(patch).eq('id', jobId),
    );
}

async function requestCancel(jobId) {
    if (!isEnabled()) return;
    await safeSupabase('requestCancel', () =>
        getClient().from('reclassify_jobs').update({ cancel_requested: true }).eq('id', jobId),
    );
}

/**
 * Pick the oldest job the worker should service - first 'running' (resume
 * mid-flight), then 'pending' (new). Ignores 'paused'/'cancelled'/terminal
 * statuses. Returns null when nothing is ready.
 */
async function claimNextJob() {
    if (!isEnabled()) return null;
    return await safeRead('claimNextJob', async () => {
        const { data, error } = await getClient()
            .from('reclassify_jobs')
            .select('*')
            .in('status', ['running', 'pending'])
            .order('created_at', { ascending: true })
            .limit(1);
        if (error) throw new Error(error.message);
        return (data && data[0]) || null;
    }, { fallback: null });
}

async function getJob(jobId) {
    if (!isEnabled()) return null;
    return await safeRead('getReclassifyJob', async () => {
        const { data, error } = await getClient()
            .from('reclassify_jobs').select('*').eq('id', jobId).maybeSingle();
        if (error) throw new Error(error.message);
        return data || null;
    }, { fallback: null });
}

async function listRecentJobs({ icpId = null, limit = 20 } = {}) {
    if (!isEnabled()) return [];
    return await safeRead('listReclassifyJobs', async () => {
        let q = getClient().from('reclassify_jobs').select('*')
            .order('created_at', { ascending: false }).limit(limit);
        if (icpId) q = q.eq('icp_id', icpId);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return data || [];
    }, { fallback: [] });
}

async function listJobResults(jobId, { limit = 500 } = {}) {
    if (!isEnabled()) return [];
    return await safeRead('listReclassifyResults', async () => {
        const { data, error } = await getClient()
            .from('reclassify_results').select('*').eq('job_id', jobId)
            .order('order_idx', { ascending: true }).limit(limit);
        if (error) throw new Error(error.message);
        return data || [];
    }, { fallback: [] });
}

/**
 * Boot-time reconciliation. Any job left in 'running' means the process
 * died with the worker mid-loop. Flip to 'pending' so the worker resumes
 * cleanly - in_flight result rows from that crash flip back to pending
 * too (the worker re-claims them on the next tick).
 *
 * Returns the number of jobs reconciled.
 */
async function reconcileOnBoot() {
    if (!isEnabled()) return 0;
    try {
        const { data: jobs } = await safeSupabase('reconcileRunningJobs', () =>
            getClient().from('reclassify_jobs')
                .update({ status: 'pending', current_domain: null })
                .eq('status', 'running')
                .select('id'),
        );
        const reconciled = (jobs || []).length;
        if (reconciled > 0) {
            // Bring any in_flight result rows from those jobs back to pending
            // so the worker re-claims them. Cheaper than tracking per-job
            // in_flight ids - one bulk update reaches every orphan.
            await safeSupabase('reconcileInFlightResults', () =>
                getClient().from('reclassify_results')
                    .update({ status: 'pending', attempted_at: null })
                    .eq('status', 'in_flight'),
            );
        }
        return reconciled;
    } catch (err) {
        console.warn(`[reclassify-jobs] reconcileOnBoot failed: ${err.message}`);
        return 0;
    }
}

module.exports = {
    enqueue,
    claimNextJob,
    claimNextBatch,
    finalizeResult,
    setStatus,
    requestCancel,
    getJob,
    listRecentJobs,
    listJobResults,
    reconcileOnBoot,
};
