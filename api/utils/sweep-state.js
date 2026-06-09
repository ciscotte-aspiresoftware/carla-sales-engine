// Per-ICP "last active sweep scope" memory.
//
// The sweep cron used to lock to one ICP at a time and pick cells by global
// priority (Tier-1 cities before Tier-2 country fill). That made it impossible
// to pause Amsterdam and switch to a country-fill view without Amsterdam's
// remaining Tier-1 cells stealing the budget on every Resume.
//
// This module tracks, per ICP, the most recent (scope, value) the operator
// resumed for - e.g. {type:'city', value:'Amsterdam'} or {type:'country',
// value:'NL'}. The cron stores the live scope in memory; this module just
// persists "what was the last thing run for this ICP" so the UI can show
// "last: Amsterdam" badges and the operator's cross-restart workflow is
// visible at a glance.
//
// Per-cell progress (pending/scanning/complete/empty) is already persisted
// on each grid cell, so "where we left off" is implicit - the cron will
// pick up the next pending cell in that scope as soon as the operator hits
// Resume Sweeping with the right scope selected.
//
// Storage:
//   - Supabase (USE_SUPABASE=true): app_settings row with key='sweep_last_scopes',
//     custom={[icpId]: {type, value, updatedAt}}. Squats on the existing
//     settings table so no schema migration is needed; settings.js ignores
//     unknown keys, so the two don't collide.
//   - JSON fallback: api/data/sweep-state.json.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const FILE = path.resolve(__dirname, '..', 'data', 'sweep-state.json');
const SETTINGS_KEY = 'sweep_last_scopes';

// In-memory cache. { [icpId]: { type, value, updatedAt } }.
let cache = {};

function loadFromJson() {
    try {
        if (!fs.existsSync(FILE)) return {};
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        console.warn('[sweep-state] json read failed:', e.message);
        return {};
    }
}

function writeToJson() {
    try {
        const dir = path.dirname(FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    } catch (e) {
        console.warn('[sweep-state] json write failed:', e.message);
    }
}

async function hydrateFromSupabase() {
    try {
        const { data, error } = await getClient()
            .from('app_settings')
            .select('*')
            .eq('key', SETTINGS_KEY)
            .maybeSingle();
        if (error) {
            console.warn('[sweep-state] supabase hydrate failed:', error.message);
            return;
        }
        if (data && data.custom && typeof data.custom === 'object') {
            cache = data.custom;
        }
    } catch (e) {
        console.warn('[sweep-state] supabase hydrate threw:', e.message);
    }
}

// Seed sync from JSON immediately so the cache is non-empty even before the
// async Supabase hydrate lands. Same trick settings.js / icps.js use.
cache = loadFromJson();
if (isEnabled()) hydrateFromSupabase();

function getAll() {
    return { ...cache };
}

function getLastScope(icpId) {
    if (!icpId) return null;
    const entry = cache[icpId];
    return entry ? { ...entry } : null;
}

function setLastScope(icpId, scope) {
    if (!icpId) return;
    if (!scope || !scope.type) {
        delete cache[icpId];
    } else {
        cache[icpId] = {
            type: String(scope.type),
            value: scope.value == null ? null : String(scope.value),
            updatedAt: Date.now(),
        };
    }
    if (isEnabled()) {
        const row = {
            key: SETTINGS_KEY,
            use_default: false,
            custom: cache,
            updated_at: new Date().toISOString(),
        };
        getClient().from('app_settings').upsert(row, { onConflict: 'key' })
            .then(({ error }) => { if (error) console.warn('[sweep-state] supabase write failed:', error.message); })
            .catch((e) => console.warn('[sweep-state] supabase write threw:', e.message));
        return;
    }
    writeToJson();
}

module.exports = { getAll, getLastScope, setLastScope };
