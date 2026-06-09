// Quick Supabase connection check. Run: `npm run db:status` (from api/).
// Prints whether the flag/creds are set and, if enabled, whether a trivial
// query against the `icps` table succeeds. Safe to run anytime - read-only.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { getStatus, isEnabled, getClient } = require('./index');

(async () => {
    const s = getStatus();
    console.log('Supabase status:', s);
    if (!isEnabled()) {
        console.log('→ DISABLED. The app is using JSON files (api/data/). Set USE_SUPABASE=true + SUPABASE_URL + SUPABASE_SERVICE_KEY in .env to enable.');
        return;
    }
    try {
        const sb = getClient();
        const { error } = await sb.from('icps').select('id').limit(1);
        if (error) {
            console.log(`→ Connected, but query failed: ${error.message}`);
            console.log('  (Did you run api/db/migrations/0001_initial_schema.sql in the Supabase SQL editor?)');
            process.exitCode = 1;
        } else {
            console.log('→ Connected ✓ (icps table reachable).');
        }
    } catch (e) {
        console.log('→ Connection error:', e.message);
        process.exitCode = 1;
    }
})();