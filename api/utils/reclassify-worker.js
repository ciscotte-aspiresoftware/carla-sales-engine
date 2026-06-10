// Reclassify worker.
//
// Pulls the oldest non-terminal reclassify_jobs row on each tick and
// processes its pending result rows with bounded concurrency. Replaces
// the prior "loop inside the HTTP request" model in routes/icps.js
// /reclassify which blocked the response for minutes and lost in-flight
// state on every restart.
//
// One worker instance per Node process. Module-level `inFlight` flag
// prevents overlapping ticks - if a tick takes 12s, the next tick at 1s
// just no-ops until the current one returns.
//
// Wall-time math at default settings (CONCURRENCY=6, TICK_MS=1000,
// ~3s/classify on gpt-4o-mini):
//   - 6 in-flight per tick = ~6 classifies / 3s = ~2 / s
//   - 66 domains = ~33s end-to-end
//   - 1000 domains = ~8 min end-to-end (vs. ~50 min sequential)
// gpt-4o-mini's 30k RPM cap is nowhere near touched at this rate; the
// concurrency cap exists for progress-reporting fidelity and clean error
// attribution, not API protection.

const { chat } = require('./openai');
const { getAi } = require('./settings');
const scrapeCache = require('./scrape-cache');
const { setClassificationForIcp } = require('../routes/companies');
const { getIcp, computeIcpDefinitionHash } = require('./icps');
const { pushEvent } = require('./activity-log');
const jobs = require('./reclassify-jobs');

// Configurable via env without code changes. Defaults tuned for
// gpt-4o-mini-ish latency + a 5s/30s SWEEP_TICK_MS coexistence (the
// reclassify worker runs on its own timer; same-process but independent).
const TICK_MS = parseInt(process.env.BLUEBIRD_RECLASSIFY_TICK_MS || '1000', 10);
const CONCURRENCY = parseInt(process.env.BLUEBIRD_RECLASSIFY_CONCURRENCY || '6', 10);
// Hard cap on classifies per second to keep us comfortable under
// OpenAI's per-minute token budget on gpt-4o-mini. At CONCURRENCY=6 the
// natural throughput is ~2/s; this cap (default 20/s) is the ceiling
// before we'd ever need to add a token-bucket. Bumping concurrency in
// env without also raising this would NOT exceed the cap - the worker
// just waits between batches.
const MAX_PER_SECOND = parseInt(process.env.BLUEBIRD_RECLASSIFY_MAX_PER_SECOND || '20', 10);

let timer = null;
let inFlight = false;
const recentClassifyTimestamps = [];   // ring of the last N start times for rate-limiting

function start() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    console.log(`[Reclassify Worker] Started - tick every ${TICK_MS}ms, concurrency=${CONCURRENCY}, max=${MAX_PER_SECOND}/s`);
}

function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    console.log('[Reclassify Worker] Stopped');
}

async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
        const job = await jobs.claimNextJob();
        if (!job) return;

        // Cancellation requested? Close cleanly and bail.
        if (job.cancel_requested) {
            await jobs.setStatus(job.id, 'cancelled', { touchFinishedAt: true });
            console.log(`[Reclassify Worker] ✗ CANCELLED job=${job.id} icp=${job.icp_id}`);
            return;
        }

        // First-time pick? Stamp started_at + flip to running. The status
        // flip is the cue the recent-jobs panel uses to show a spinner.
        if (job.status === 'pending') {
            await jobs.setStatus(job.id, 'running', { touchStartedAt: true });
            pushEvent({
                type: 'cell_start',
                icpId: job.icp_id,
                cellId: 'reclassify',
                parentCity: null,
                message: `Reclassify job started - ${job.total} target${job.total === 1 ? '' : 's'}`,
            });
        }

        const icp = getIcp(job.icp_id);
        if (!icp) {
            await jobs.setStatus(job.id, 'crashed', {
                error: `ICP "${job.icp_id}" no longer exists`,
                touchFinishedAt: true,
            });
            console.warn(`[Reclassify Worker] ✗ ICP missing - aborting job=${job.id}`);
            return;
        }

        // Soft rate-limit: never start more than MAX_PER_SECOND classifies
        // per rolling second. Cheap in-memory ring; resets across restarts
        // but that's exactly when the worker is most paused anyway.
        const room = roomLeftThisSecond();
        const claimSize = Math.min(CONCURRENCY, room);
        if (claimSize <= 0) return; // wait one more tick

        const batch = await jobs.claimNextBatch(job.id, claimSize);
        if (batch.length === 0) {
            // Nothing left to process - close the job.
            await jobs.setStatus(job.id, 'completed', { touchFinishedAt: true, currentDomain: null });
            pushEvent({
                type: 'cell_complete',
                icpId: job.icp_id,
                cellId: 'reclassify',
                parentCity: null,
                state: 'complete',
                message: `Reclassify complete`,
            });
            console.log(`[Reclassify Worker] ✓ COMPLETE job=${job.id} icp=${job.icp_id}`);
            return;
        }

        // Surface "current domain" for the live progress pill. Pick the
        // first claimed row - the others will overwrite within the same tick.
        await jobs.setStatus(job.id, 'running', { currentDomain: batch[0].domain });

        // Stamp the rate-limit ring with one entry per row about to start.
        const nowMs = Date.now();
        for (let i = 0; i < batch.length; i++) recentClassifyTimestamps.push(nowMs);
        pruneRateRing(nowMs);

        // Run the batch concurrently. Promise.allSettled so one error
        // doesn't poison the rest of the batch.
        const model = getAi().classifyModel;
        await Promise.allSettled(batch.map((row) => processOne(icp, model, row)));
    } catch (err) {
        console.error(`[Reclassify Worker] tick error: ${err.message}`);
    } finally {
        inFlight = false;
    }
}

// Process exactly one result row. Reads the cache, runs GPT, writes the
// verdict back via setClassificationForIcp (the same writer the legacy
// route used, so company state ends up identical), finalizes the row.
async function processOne(icp, model, row) {
    try {
        const cached = await scrapeCache.get(row.domain);
        if (!cached || !cached.markdown) {
            await jobs.finalizeResult(row, 'skipped', { skipReason: 'no cached scrape' });
            pushEvent({
                type: 'company_skipped',
                icpId: icp.id,
                cellId: 'reclassify',
                parentCity: row.city || null,
                domain: row.domain,
                reason: 'no cached scrape',
                message: `${row.domain} skipped - no cached scrape`,
            });
            return;
        }

        const messages = [
            { role: 'system', content: icp.classifyPrompt },
            { role: 'user', content: `Page title: ${cached.pageTitle || '(none)'}\n\nPage content:\n${(cached.markdown || '').slice(0, 12000)}` },
        ];
        const raw = await chat(messages, {
            model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
        });

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { parsed = { is_match: false, reason: `classifier returned non-JSON: ${String(raw).slice(0, 80)}` }; }

        const verdict = {
            is_match: !!parsed.is_match,
            reason: parsed.reason || (parsed.is_match ? 'matched' : 'rejected'),
            definitionHash: computeIcpDefinitionHash(icp),
        };
        await setClassificationForIcp(row.domain, icp.id, verdict);

        const flipped = row.old_is_match !== null && row.old_is_match !== verdict.is_match;
        await jobs.finalizeResult(row, 'classified', {
            newIsMatch: verdict.is_match,
            newReason: verdict.reason,
            modelUsed: model,
            flipped,
        });

        pushEvent({
            type: verdict.is_match ? 'company_qualified' : 'company_rejected',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: row.city || null,
            domain: row.domain,
            title: row.company_name || row.domain,
            reason: verdict.reason,
            oldVerdict: row.old_is_match === null ? null : { is_match: row.old_is_match, reason: row.old_reason },
            newVerdict: verdict,
            flipped,
            message: `${row.domain} - ${verdict.is_match ? 'qualified' : 'rejected'}${flipped ? ' (FLIPPED)' : ''} (reclassify)`,
        });
    } catch (err) {
        await jobs.finalizeResult(row, 'errored', { errorMessage: err.message || String(err) });
        pushEvent({
            type: 'company_error',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: row.city || null,
            domain: row.domain,
            reason: err.message || String(err),
            message: `${row.domain} errored - ${err.message || String(err)}`,
        });
        console.warn(`[Reclassify Worker] ⚠ ${row.domain}: ${err.message}`);
    }
}

function roomLeftThisSecond() {
    pruneRateRing(Date.now());
    return Math.max(0, MAX_PER_SECOND - recentClassifyTimestamps.length);
}

function pruneRateRing(now) {
    const cutoff = now - 1000;
    while (recentClassifyTimestamps.length > 0 && recentClassifyTimestamps[0] < cutoff) {
        recentClassifyTimestamps.shift();
    }
}

module.exports = { start, stop, tick };
