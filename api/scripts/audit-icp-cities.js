// One-shot audit: for every ICP, check each city's geocoded country against
// the ICP's `countries` list, and surface the mismatches.
//
// Run: `node api/scripts/audit-icp-cities.js`
//
// Read-only - prints a report and exits, never writes. Pair with the new
// per-city chip UI in the ICP editor: once you've seen what's mismatched,
// fix in the UI (the grayed cities won't be lost) or decide to expand the
// ICP's `countries` list to cover them.
//
// Loads .env from the repo root via the same path the API uses, so the
// SUPABASE_URL / SUPABASE_SERVICE_KEY / USE_SUPABASE values are picked up
// without needing to be re-declared.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { listIcps } = require('../utils/icps');
const { findCityAsync } = require('../utils/cities');

function fmtList(xs) {
    return xs && xs.length ? xs.join(', ') : '(none)';
}

async function main() {
    // Wait briefly for the icps cache to hydrate from Supabase before we
    // call listIcps. utils/icps.js fires hydrateFromSupabase() at module
    // load - the await here gives that one tick of breathing room.
    await new Promise((r) => setTimeout(r, 2000));

    const icps = listIcps();
    if (!icps || icps.length === 0) {
        console.log('No ICPs found - is USE_SUPABASE=true and the connection live?');
        process.exit(0);
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(' ICP city/country audit');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Scanning ${icps.length} ICP${icps.length === 1 ? '' : 's'}...`);
    console.log('');

    const issues = [];
    let totalCities = 0;
    let totalResolved = 0;

    for (const icp of icps) {
        const cities = Array.isArray(icp.cities) ? icp.cities.filter(Boolean) : [];
        const activeCountries = (icp.countries || []).map((c) => String(c).toUpperCase());
        if (cities.length === 0) continue;
        totalCities += cities.length;

        const resolved = await Promise.all(cities.map(async (raw) => {
            const name = String(raw).trim();
            try {
                const city = await findCityAsync(name);
                if (!city) return { name, country: null, label: null };
                totalResolved++;
                return {
                    name,
                    country: city.country ? String(city.country).toUpperCase() : null,
                    label: city.label,
                };
            } catch (e) {
                return { name, country: null, error: e.message };
            }
        }));

        // Mismatched cities split two ways:
        //   • outlierWithOverride - city's country isn't ticked BUT it has a
        //     cityTerms[name] entry, so the sweep will still run it via the
        //     city-only override. Healthy state - just informational.
        //   • outlierNoOverride   - city's country isn't ticked AND no
        //     override. Sweep will skip it (post-migration 0003 + the new
        //     precedence rule). User needs to either tick the country or
        //     give the city its own terms.
        const cityTerms = icp.cityTerms || {};
        const hasOverride = (cityName) => Object.keys(cityTerms).some((k) => k.toLowerCase() === cityName.toLowerCase());
        const mismatched = resolved.filter((r) => r.country && !activeCountries.includes(r.country));
        const outlierNoOverride = mismatched.filter((r) => !hasOverride(r.name));
        const outlierWithOverride = mismatched.filter((r) => hasOverride(r.name));
        const unresolved = resolved.filter((r) => !r.country);
        const inferredCountries = new Set(resolved.map((r) => r.country).filter(Boolean));
        const tickedButCityless = activeCountries.filter((c) => !inferredCountries.has(c));

        if (outlierNoOverride.length === 0 && outlierWithOverride.length === 0 && unresolved.length === 0 && tickedButCityless.length === 0) continue;

        issues.push({
            icp,
            mismatched,
            outlierNoOverride,
            outlierWithOverride,
            unresolved,
            tickedButCityless,
        });
    }

    if (issues.length === 0) {
        console.log('  ✓ No mismatches found.');
        console.log('');
        process.exit(0);
    }

    for (const { icp, outlierNoOverride, outlierWithOverride, unresolved, tickedButCityless } of issues) {
        const pc = icp.portfolioCompany ? ` · ${icp.portfolioCompany}` : '';
        console.log(`\n  ▸ ${icp.name}${pc}  [${icp.id}]`);
        console.log(`    countries ticked: ${fmtList(icp.countries)}`);
        if (outlierNoOverride.length > 0) {
            console.log(`    ✗ OUTLIERS (will be skipped by sweep - tick country or give city-only terms):`);
            for (const r of outlierNoOverride) {
                console.log(`       • ${r.name}  →  ${r.country}  (not ticked, no cityTerms override)`);
            }
        }
        if (outlierWithOverride.length > 0) {
            console.log(`    ℹ outlier cities with city-only terms (sweep runs them via cityTerms - healthy):`);
            for (const r of outlierWithOverride) {
                console.log(`       • ${r.name}  →  ${r.country}  (cityTerms override active)`);
            }
        }
        if (unresolved.length > 0) {
            console.log(`    cities the geocoder couldn't resolve:`);
            for (const r of unresolved) {
                console.log(`       • ${r.name}${r.error ? `  (${r.error})` : ''}`);
            }
        }
        if (tickedButCityless.length > 0) {
            console.log(`    countries ticked but no cities seeded for them:`);
            console.log(`       • ${tickedButCityless.join(', ')}  (country-fill only, no Tier-1 metros)`);
        }
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(` Summary`);
    console.log(`   ICPs scanned:           ${icps.length}`);
    console.log(`   ICPs with issues:       ${issues.length}`);
    console.log(`   Cities resolved:        ${totalResolved} / ${totalCities}`);
    console.log(`   Outliers (skipped):     ${issues.reduce((n, i) => n + i.outlierNoOverride.length, 0)}`);
    console.log(`   Outliers (city-only):   ${issues.reduce((n, i) => n + i.outlierWithOverride.length, 0)}`);
    console.log(`   Unresolved cities:      ${issues.reduce((n, i) => n + i.unresolved.length, 0)}`);
    console.log(`   Countries w/o cities:   ${issues.reduce((n, i) => n + i.tickedButCityless.length, 0)}`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    console.log(' Next steps:');
    console.log('  • For each ICP above, open it in the editor.');
    console.log('  • Outliers (no override) show a yellow banner inline on the city row:');
    console.log('      - "Tick <CC> (full country)" - adds the whole country');
    console.log('      - "<city>-only terms"        - GPT generates language-correct');
    console.log('        Maps phrases for just that one city (country stays untouched).');
    console.log('  • Outliers WITH overrides are healthy - the sweep runs them via');
    console.log('    cityTerms, no action needed.');
    console.log('  • Unresolved cities will get a "?" chip - check the spelling,');
    console.log('    or accept that the geocoder will auto-try on first seed.');
    console.log('  • This script never writes; nothing has been changed in the DB.');
    console.log('');
    process.exit(0);
}

main().catch((err) => {
    console.error('audit failed:', err.message);
    process.exit(1);
});