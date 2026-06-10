// Resilience wrapper for Supabase calls.
//
// Atlas's hot path (sweep cron, email gen, activity log) hits Supabase
// constantly. Render's networking is mostly reliable but occasionally
// drops a packet, and Supabase's gateway has its own rare hiccups. A
// single transient error currently propagates and either:
//   - silently swallows the write (fire-and-forget paths)
//   - or crashes the in-flight request (synchronous reads)
//
// Wrapping critical writes in safeWrite() / critical reads in safeRead()
// gives us:
//   - 3 attempts with exponential backoff (250ms → 500ms → 1s)
//   - clear logging per retry so transient outages are visible in Render
//     logs without requiring an external observability stack
//   - tolerance of permanent failure: safeWrite still throws after the
//     last attempt (caller decides whether to give up); safeRead returns
//     a fallback so reads degrade gracefully
//
// USE FOR: writes the operator's data depends on (cell state, session
// counters, sequence runs), reads the route handler needs to function.
// SKIP FOR: high-volume best-effort logs where N retries × M rows ×
// recurring outage would amplify load (e.g. api_usage insertions are
// already fire-and-forget; one missed row is fine).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a function with exponential backoff retries. Throws the last error
 * if all attempts fail. The function should be a thunk returning a promise.
 *
 * @param {string} opName - short label for logs ("update cell state", "insert session")
 * @param {() => Promise<T>} fn - the operation to attempt
 * @param {object} [opts]
 * @param {number} [opts.attempts=3] - total attempts including the first
 * @param {number} [opts.baseMs=250] - base backoff; doubled each retry
 */
async function safeWrite(opName, fn, { attempts = 3, baseMs = 250 } = {}) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            const isLast = i === attempts - 1;
            if (isLast) {
                console.error(`[safeWrite] ${opName} FAILED after ${attempts} attempts: ${err.message}`);
                throw err;
            }
            const wait = baseMs * Math.pow(2, i);
            console.warn(`[safeWrite] ${opName} attempt ${i + 1}/${attempts} failed (${err.message}) - retrying in ${wait}ms`);
            await sleep(wait);
        }
    }
}

/**
 * Same retry policy, but on permanent failure returns `fallback` instead
 * of throwing. Use for reads where the caller can degrade (empty list, null
 * cache entry, etc.) rather than crash.
 */
async function safeRead(opName, fn, { attempts = 3, baseMs = 250, fallback = null } = {}) {
    try {
        return await safeWrite(opName, fn, { attempts, baseMs });
    } catch (err) {
        console.warn(`[safeRead] ${opName} returning fallback after exhausting retries: ${err.message}`);
        return fallback;
    }
}

/**
 * Convenience: most Supabase calls return `{ data, error }`. If `error` is
 * non-null, treat it as a thrown error so safeWrite's retry logic kicks
 * in. Wraps the function for you.
 *
 * Usage:
 *   const { data } = await safeSupabase('fetch icps', () =>
 *     getClient().from('icps').select('*'));
 */
async function safeSupabase(opName, fn, opts) {
    return safeWrite(opName, async () => {
        const result = await fn();
        if (result && result.error) {
            const err = new Error(result.error.message || JSON.stringify(result.error));
            err.code = result.error.code;
            throw err;
        }
        return result;
    }, opts);
}

module.exports = { safeWrite, safeRead, safeSupabase };
