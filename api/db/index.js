// Supabase connection - DISABLED by default.
//
// Bluebird currently persists everything to JSON files under api/data/.
// This module is the single seam for the future Postgres/Supabase backend:
// a flag-gated client the rest of the app can adopt store-by-store later.
//
// Until USE_SUPABASE === 'true' AND the credentials are present, isEnabled()
// returns false and NOTHING in the running app touches Supabase. No route or
// store imports this yet - it's intentionally inert scaffolding.
//
// Env (see .env.example):
//   USE_SUPABASE=true|false        master switch (default: false)
//   SUPABASE_URL=https://xxx.supabase.co
//   SUPABASE_SERVICE_KEY=...       service-role key - SERVER ONLY, never ship
//                                  to the browser (bypasses RLS).
//
// @supabase/supabase-js is required LAZILY inside getClient() so the app
// boots fine even when the package isn't installed and the flag is off.

let cachedClient = null;

// True only when the operator has explicitly switched Supabase on AND both
// credentials are set. Callers MUST gate on this before getClient().
function isEnabled() {
    return process.env.USE_SUPABASE === 'true'
        && !!process.env.SUPABASE_URL
        && !!process.env.SUPABASE_SERVICE_KEY;
}

// Diagnostic snapshot (no secrets) for the db:status script / future health
// endpoint.
function getStatus() {
    return {
        enabled: isEnabled(),
        flag: process.env.USE_SUPABASE === 'true',
        hasUrl: !!process.env.SUPABASE_URL,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_KEY,
    };
}

// Returns the cached Supabase client, creating it on first use. Throws a
// clear error when disabled or the package is missing so callers fail loudly
// rather than silently no-op. Always guard with isEnabled() first.
function getClient() {
    if (!isEnabled()) {
        throw new Error('Supabase is disabled. Set USE_SUPABASE=true plus SUPABASE_URL and SUPABASE_SERVICE_KEY in .env to enable.');
    }
    if (cachedClient) return cachedClient;
    let createClient;
    try {
        ({ createClient } = require('@supabase/supabase-js'));
    } catch {
        throw new Error('@supabase/supabase-js is not installed. Run `npm install` in api/ before enabling Supabase.');
    }
    cachedClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return cachedClient;
}

module.exports = { isEnabled, getStatus, getClient };