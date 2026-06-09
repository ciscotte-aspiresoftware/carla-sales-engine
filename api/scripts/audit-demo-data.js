// One-shot audit: count demo vs real companies + leads in Supabase.
//
// Demo records are flagged by:
//   - company.source === 'demo-stub'  OR  source contains ':demo'
//     (matches the existing isDemoRecord() in routes/companies.js)
//   - lead.apollo_id startsWith 'demo-' (matches makeDemoLeads in
//     sweep-pipeline.js)
//
// Read-only. Run: `node api/scripts/audit-demo-data.js`

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { isEnabled, getClient } = require('../db');

async function selectAll(sb, table, cols = '*') {
    const pageSize = 1000;
    const out = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await sb.from(table).select(cols).range(from, from + pageSize - 1);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return out;
}

function isDemoSrc(src) {
    if (typeof src !== 'string') return false;
    return src === 'demo-stub' || src.includes(':demo');
}

async function main() {
    if (!isEnabled()) {
        console.log('USE_SUPABASE is not set / Supabase client not configured. Aborting.');
        process.exit(1);
    }
    const sb = getClient();
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(' Demo-data audit (Supabase)');
    console.log('═══════════════════════════════════════════════════════════════════');

    const [companies, leads] = await Promise.all([
        selectAll(sb, 'companies', 'id, domain, source, vertical, created_at'),
        selectAll(sb, 'leads', 'id, company_id, apollo_id, first_name, last_name'),
    ]);

    const totalCompanies = companies.length;
    const demoCompanies = companies.filter((c) => isDemoSrc(c.source));
    const demoCompanyIds = new Set(demoCompanies.map((c) => c.id));

    const totalLeads = leads.length;
    const demoLeads = leads.filter((l) => String(l.apollo_id || '').startsWith('demo-'));
    const leadsOnDemoCompanies = leads.filter((l) => demoCompanyIds.has(l.company_id));
    const leadsOnRealCompanies = leads.filter((l) => !demoCompanyIds.has(l.company_id));
    const demoLeadsOnRealCompanies = demoLeads.filter((l) => !demoCompanyIds.has(l.company_id));

    console.log('');
    console.log(`  COMPANIES`);
    console.log(`    Total:           ${totalCompanies}`);
    console.log(`    Demo (source):   ${demoCompanies.length}  (${totalCompanies ? Math.round(demoCompanies.length / totalCompanies * 100) : 0}%)`);
    console.log(`    Real:            ${totalCompanies - demoCompanies.length}`);
    console.log('');
    console.log(`  LEADS`);
    console.log(`    Total:                  ${totalLeads}`);
    console.log(`    Demo (apollo_id):       ${demoLeads.length}  (${totalLeads ? Math.round(demoLeads.length / totalLeads * 100) : 0}%)`);
    console.log(`    Real:                   ${totalLeads - demoLeads.length}`);
    console.log(`    On demo companies:      ${leadsOnDemoCompanies.length}`);
    console.log(`    On real companies:      ${leadsOnRealCompanies.length}`);
    console.log(`    Demo leads on REAL co:  ${demoLeadsOnRealCompanies.length}  ${demoLeadsOnRealCompanies.length > 0 ? '⚠ this is the bug surface' : ''}`);
    console.log('');

    // Per-source breakdown of the demo companies - lets the user see which
    // ICP / city / batch the leftovers came from.
    const bySrc = new Map();
    for (const c of demoCompanies) {
        bySrc.set(c.source, (bySrc.get(c.source) || 0) + 1);
    }
    const srcRows = Array.from(bySrc.entries()).sort((a, b) => b[1] - a[1]);
    if (srcRows.length > 0) {
        console.log('  Demo-company sources (top 15):');
        for (const [src, n] of srcRows.slice(0, 15)) console.log(`    ${String(n).padStart(4)}  ${src}`);
        if (srcRows.length > 15) console.log(`    ... and ${srcRows.length - 15} more`);
        console.log('');
    }

    // Sample of the leads that triggered the user's error log. Useful for
    // "show me one so I know what we're talking about".
    if (demoLeads.length > 0) {
        console.log(`  Sample demo lead apollo_ids (first 5):`);
        for (const l of demoLeads.slice(0, 5)) {
            console.log(`    ${l.apollo_id}  (${l.first_name || '?'} ${l.last_name || '?'})`);
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(' Cleanup notes');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  • To delete the demo companies (and cascade-drop their leads /`);
    console.log(`    classifications / reviews via FK), run:`);
    console.log('');
    console.log(`      DELETE FROM companies WHERE source = 'demo-stub' OR source LIKE '%:demo';`);
    console.log('');
    console.log(`  • Any orphan demo leads on real companies (count above) need a`);
    console.log(`    separate cleanup:`);
    console.log('');
    console.log(`      DELETE FROM leads WHERE apollo_id LIKE 'demo-%';`);
    console.log('');
    console.log(`  Read-only audit. Nothing has been deleted.`);
    console.log('');
}

main().catch((e) => { console.error('audit-demo-data failed:', e.message); process.exit(1); });