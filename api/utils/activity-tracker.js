// User-action activity tracker. Writes one row per operator action to the
// `user_activity` Supabase table (migration 0008). Distinct from the sweep
// pipeline's per-cell/per-company events that flow through activity-log.js
// + pushEvent() - this is the operator-facing audit trail, surfaced on the
// /activity page in the frontend.
//
// Pattern ported from valsource's be-vms-checker/utils/activity-tracker.js.
// Adapted for Carla: no user auth, so user_id defaults to 'operator'.
// Non-blocking: tracking failures never throw - we'd rather drop a row than
// break the actual API call the operator made.

const { isEnabled, getClient } = require('../db');

const DEFAULT_USER = 'operator';

async function trackUserActivity(userId, action, details = {}) {
    if (!isEnabled()) return; // no Supabase = no activity log (silent no-op)
    try {
        await getClient().from('user_activity').insert([{
            user_id: userId || DEFAULT_USER,
            action,
            details: details || {},
            created_at: new Date().toISOString(),
        }]);
    } catch (err) {
        // Logged and swallowed - never propagate to the caller. Activity
        // tracking is a nice-to-have; a Supabase blip shouldn't kill an
        // ICP edit or a sweep resume.
        console.warn(`[Activity Tracker] insert failed (action=${action}): ${err.message}`);
    }
}

// Fetch the last `days` worth of activity, newest first. Paginates past
// PostgREST's default 1000-row limit so big windows don't get truncated.
async function getAllActivity(days = 30, limit = 5000) {
    if (!isEnabled()) return [];
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceIso = since.toISOString();

    const PAGE_SIZE = 1000;
    const out = [];
    for (let from = 0; out.length < limit; from += PAGE_SIZE) {
        const { data, error } = await getClient()
            .from('user_activity')
            .select('*')
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const page = data || [];
        out.push(...page);
        if (page.length < PAGE_SIZE) break;
    }
    return out.slice(0, limit);
}

async function getUserActivity(userId, days = 30) {
    if (!isEnabled()) return [];
    const since = new Date();
    since.setDate(since.getDate() - days);
    const { data, error } = await getClient()
        .from('user_activity')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

module.exports = { trackUserActivity, getAllActivity, getUserActivity, DEFAULT_USER };