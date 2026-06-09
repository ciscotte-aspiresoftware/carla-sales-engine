// One-time uploader: JSON files (api/data/) → Supabase tables.
//
// Run AFTER you've created the Supabase project, applied
// migrations/0001_initial_schema.sql, and set USE_SUPABASE=true +
// SUPABASE_URL + SUPABASE_SERVICE_KEY in .env. Then, from api/:
//   npm run db:import
//
// Idempotent: every table is upserted on its natural key, so re-running
// updates rows rather than duplicating them. (Exception: leads with no
// apolloId have no stable key and will re-insert on a second run - a known,
// minor edge for the handful of website-only contacts.)
//
// FK-safe order: icps + companies first (referenced by the per-ICP tables),
// then grid_cells (referenced by search_log), then the rest. Rows that point
// at an unknown icp/cell are dropped or null-ed so a partial dataset still
// imports cleanly.
//
// This script is the ONLY thing in the repo that writes to Supabase. The
// running API is untouched and still uses JSON until each store is migrated.

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { isEnabled, getClient } = require('./index');

const DATA = path.resolve(__dirname, '..', 'data');

// Fallback timestamp for NOT-NULL columns whose source record predates the
// field (e.g. legacy leads with no addedAt). We can't rely on the column
// default here: a bulk upsert with mixed keys makes PostgREST send NULL for
// rows missing the key rather than applying `default now()`, which trips the
// not-null constraint. So every not-null timestamp gets an explicit value.
const nowIso = new Date().toISOString();

// ─── helpers ──────────────────────────────────────────────────────────────
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
    catch { return fallback; }
}

// epoch-ms → ISO timestamp (or null). Drops 0/invalid so seeded-but-never-
// classified records land as NULL rather than 1970.
function toTs(ms) {
    if (ms == null) return null;
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n).toISOString();
}

async function upsertAll(label, table, rows, onConflict) {
    if (!rows || rows.length === 0) { console.log(`  ${label.padEnd(22)} 0 rows (skip)`); return; }
    const sb = getClient();
    let ok = 0, failed = 0;
    for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error } = await sb.from(table).upsert(chunk, onConflict ? { onConflict } : undefined);
        if (error) {
            failed += chunk.length;
            console.warn(`  ${label.padEnd(22)} batch ${i}-${i + chunk.length} FAILED: ${error.message}`);
        } else {
            ok += chunk.length;
        }
    }
    console.log(`  ${label.padEnd(22)} ${ok} upserted${failed ? `, ${failed} failed` : ''}`);
}

// Read a `--name value` CLI arg (returns null if absent).
function getArg(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// Classification typed columns - everything else on the per-ICP object gets
// stashed in the jsonb `details` column (legacy rich shape: tagline,
// languages, signals, reasoning, isCarRental, confidence, …).
const CLS_TYPED = new Set(['is_match', 'reason', 'title', 'phone', 'address', 'rating', 'reviews', 'report', 'classifiedAt']);
function clsDetails(cls) {
    const out = {};
    for (const k of Object.keys(cls)) if (!CLS_TYPED.has(k)) out[k] = cls[k];
    return Object.keys(out).length ? out : null;
}

async function main() {
    if (!isEnabled()) {
        console.error('✗ Supabase is disabled. Set USE_SUPABASE=true + SUPABASE_URL + SUPABASE_SERVICE_KEY in .env first.');
        process.exit(1);
    }
    console.log('▶ Importing JSON → Supabase…\n');

    // Optional portfolio scope. `npm run db:import -- --portfolio NedFox`
    // (or `--icps nedfox-garden,nedfox-thrift,...`) uploads ONLY that
    // portfolio's ICPs and everything tied to them - companies, per-ICP
    // classifications/reviews, leads, grid cells, search-log, scrape-cache,
    // and templates. No flag = full upload. Nothing is moved or deleted on
    // disk either way; this only scopes what gets written to Supabase.
    const argv = process.argv.slice(2);
    const portfolioArg = getArg(argv, '--portfolio');
    const icpsArg = getArg(argv, '--icps');
    const explicitIcpIds = icpsArg
        ? new Set(icpsArg.split(',').map(s => s.trim()).filter(Boolean))
        : null;
    const filtered = !!(portfolioArg || explicitIcpIds);

    // ─── ICPs (referenced by classifications/reviews/grid_cells/search_log) ──
    const allIcps = readJson('icps.json', []);
    const icps = allIcps.filter(i => {
        if (explicitIcpIds) return explicitIcpIds.has(i.id);
        if (portfolioArg) return (i.portfolioCompany || '').toLowerCase() === portfolioArg.toLowerCase();
        return true;
    });
    const icpIds = new Set(icps.map(i => i.id));
    // Verticals owned by the included ICPs - used to scope scrape-cache and
    // search-log, which are keyed by vertical rather than ICP id.
    const includedVerticals = new Set(icps.map(i => (i.vertical || '').toLowerCase()).filter(Boolean));
    if (filtered) {
        console.log(`▶ Scope filter: ${portfolioArg ? `portfolio "${portfolioArg}"` : `icps [${[...explicitIcpIds].join(', ')}]`}`);
        console.log(`  → ${icpIds.size} ICP(s): ${[...icpIds].join(', ') || '(none matched!)'}`);
        console.log(`  → verticals: ${[...includedVerticals].join(', ') || '(none)'}\n`);
        if (icpIds.size === 0) {
            console.error('✗ No ICPs matched the filter - nothing to import. Check the portfolio name (matches portfolioCompany, case-insensitive) or your --icps list.');
            process.exit(1);
        }
    }
    await upsertAll('icps', 'icps', icps.map((i, idx) => ({
        id: i.id,
        // Encode the JSON array order into created_at so the deterministic
        // (created_at ASC) read order matches the file order. Spaced 1s apart.
        created_at: new Date(Date.parse('2026-01-01T00:00:00Z') + idx * 1000).toISOString(),
        name: i.name,
        vertical: i.vertical || '',
        portfolio_company: i.portfolioCompany || '',
        countries: i.countries || [],
        search_terms: i.searchTerms || [],
        cities: i.cities || [],
        coverage: i.coverage || {},
        target_description: i.targetDescription || '',
        customer_types: i.customerTypes || [],
        exclude_types: i.excludeTypes || [],
        exclude_companies: i.excludeCompanies || [],
        extra_notes: i.extraNotes || '',
        classify_prompt: i.classifyPrompt || '',
        use_custom_prompt: !!i.useCustomPrompt,
        report_enabled: !!i.reportEnabled,
        report_template: i.reportTemplate || '',
    })), 'id');

    // ─── Email templates ────────────────────────────────────────────────────
    // Under a portfolio filter, keep templates owned by that portfolio OR
    // bound to one of the included ICPs.
    const templates = readJson('email-templates.json', []).filter(t => {
        if (!filtered) return true;
        if (portfolioArg && (t.portfolioCompany || '').toLowerCase() === portfolioArg.toLowerCase()) return true;
        return (t.defaultForIcps || []).some(id => icpIds.has(id));
    });
    await upsertAll('email_templates', 'email_templates', templates.map(t => ({
        id: t.id,
        name: t.name,
        portfolio_company: t.portfolioCompany || '',
        default_for_icps: t.defaultForIcps || [],
        language: t.language || 'English',
        sender: t.sender || {},
        voice: t.voice || '',
        system_prompt: t.systemPrompt || '',
        linkedin_guidance: t.linkedinGuidance || '',
        example_subject: t.exampleSubject || '',
        example_body: t.exampleBody || '',
    })), 'id');

    // ─── Companies + per-ICP children + leads ───────────────────────────────
    const companies = (readJson('companies.json', { companies: [] }).companies) || [];
    const companyRows = [];
    const classRows = [];
    const reviewRows = [];
    const leadRows = [];
    for (const c of companies) {
        // Portfolio scope: only companies classified under an included ICP.
        // (Their classifications/reviews for other ICPs are still skipped by
        // the icpIds guards below, so a NedFox-only run carries no car-rental
        // verdicts even on a shared company.)
        if (filtered && !Object.keys(c.classifications || {}).some(id => icpIds.has(id))) continue;
        companyRows.push({
            id: c.id,
            domain: c.domain || null,
            url: c.url || null,
            name: c.name || null,
            vertical: c.vertical || null,
            city: c.city || null,
            lat: c.location && Number.isFinite(c.location.lat) ? c.location.lat : null,
            lng: c.location && Number.isFinite(c.location.lng) ? c.location.lng : null,
            source: c.source ?? null,
            scraped_at: toTs(c.scrapedAt),
            scraped_contacts: c.scrapedContacts ?? null,
            created_at: toTs(c.createdAt) || nowIso,
            updated_at: toTs(c.updatedAt) || nowIso,
            leads_updated_at: toTs(c.leadsUpdatedAt),
        });
        for (const [icpId, cls] of Object.entries(c.classifications || {})) {
            if (!icpIds.has(icpId)) continue; // FK: skip orphan classifications
            classRows.push({
                company_id: c.id,
                icp_id: icpId,
                is_match: cls.is_match ?? null,
                reason: cls.reason || null,
                title: cls.title || null,
                phone: cls.phone || null,
                address: cls.address || null,
                rating: cls.rating ?? null,
                reviews: cls.reviews ?? null,
                report: cls.report || null,
                details: clsDetails(cls),
                classified_at: toTs(cls.classifiedAt) || nowIso,
            });
        }
        for (const [icpId, rev] of Object.entries(c.reviews || {})) {
            if (!icpIds.has(icpId)) continue;
            if (rev.decision !== 'confirmed' && rev.decision !== 'rejected') continue;
            reviewRows.push({
                company_id: c.id,
                icp_id: icpId,
                decision: rev.decision,
                reason: rev.reason || null,
                note: rev.note || null,
                reviewed_at: toTs(rev.reviewedAt) || nowIso,
            });
        }
        for (const l of (Array.isArray(c.leads) ? c.leads : [])) {
            leadRows.push({
                company_id: c.id,
                apollo_id: l.apolloId || null,
                first_name: l.firstName || null,
                last_name: l.lastName || null,
                title: l.title || null,
                email: l.email || null,
                email_status: l.emailStatus || null,
                linkedin_url: l.linkedinUrl || null,
                phone: l.phone || null,
                has_email: !!l.hasEmail,
                enriched: !!l.enriched,
                enriched_at: toTs(l.enrichedAt),
                phone_checked_at: toTs(l.phoneCheckedAt),
                li_summary: l.liSummary ?? null,
                li_posts: l.liPosts ?? null,
                li_scraped_at: toTs(l.liScrapedAt),
                added_at: toTs(l.addedAt) || nowIso,
            });
        }
    }
    await upsertAll('companies', 'companies', companyRows, 'id');
    await upsertAll('company_classifications', 'company_classifications', classRows, 'company_id,icp_id');
    await upsertAll('company_reviews', 'company_reviews', reviewRows, 'company_id,icp_id');
    await upsertAll('leads', 'leads', leadRows, 'company_id,apollo_id');

    // ─── Grid cells (referenced by search_log.cell_id) ──────────────────────
    const grid = readJson('grid.json', { cells: [] });
    const allCells = Array.isArray(grid.cells) ? grid.cells : [];
    // FK + scope: only cells for included ICPs (= all ICPs when unfiltered).
    const cells = allCells.filter(cell => icpIds.has(cell.icpId));
    const cellIds = new Set(cells.map(c => c.id));
    await upsertAll('grid_cells', 'grid_cells', cells
        .map(cell => ({
            id: cell.id,
            icp_id: cell.icpId,
            tier: cell.tier,
            lat: cell.lat,
            lng: cell.lng,
            ll: cell.ll,
            radius_km: cell.radiusKm ?? null,
            parent_city: cell.parentCity || null,
            country: cell.country || null,
            domain: cell.domain || null,
            language: cell.language || null,
            place_source: cell.placeSource || null,
            place_tier: cell.placeTier || null,
            population: cell.population ?? 0,
            state: cell.state || 'pending',
            places_found: cell.placesFound ?? 0,
            leads_qualified: cell.leadsQualified ?? 0,
            chains_filtered: cell.chainsFiltered ?? 0,
            non_target_filtered: cell.nonTargetFiltered ?? 0,
            already_known: cell.alreadyKnown ?? 0,
            last_scanned_at: toTs(cell.lastScannedAt),
            last_error: cell.lastError || null,
            created_at: toTs(cell.createdAt) || nowIso,
            updated_at: toTs(cell.updatedAt) || nowIso,
        })), 'id');

    // ─── Scrape cache (one file per domain) ─────────────────────────────────
    const cacheDir = path.join(DATA, 'scrape-cache');
    const cacheRows = [];
    try {
        for (const f of fs.readdirSync(cacheDir)) {
            if (!f.endsWith('.json')) continue;
            try {
                const e = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
                if (!e.domain) continue;
                if (filtered && !includedVerticals.has(String(e.vertical || '').toLowerCase())) continue;
                cacheRows.push({
                    domain: String(e.domain).toLowerCase(),
                    vertical: e.vertical || null,
                    url: e.url || null,
                    page_title: e.pageTitle || null,
                    markdown: e.markdown || '',
                    scraped_at: toTs(e.scrapedAt) || nowIso,
                });
            } catch { /* skip malformed cache file */ }
        }
    } catch { /* no cache dir */ }
    await upsertAll('scrape_cache', 'scrape_cache', cacheRows, 'domain');

    // ─── Search log (keyed "vertical|latBucket|lngBucket|term") ─────────────
    const searchLog = readJson('search-log.json', {});
    const searchRows = [];
    for (const [key, v] of Object.entries(searchLog)) {
        const parts = key.split('|');
        if (parts.length < 4) continue;
        const [vertical, latB, lngB, ...termParts] = parts;
        if (filtered && !includedVerticals.has(vertical.toLowerCase())) continue;
        searchRows.push({
            vertical,
            lat_bucket: Number(latB),
            lng_bucket: Number(lngB),
            term: termParts.join('|'),
            ran_at: toTs(v.ranAt) || nowIso,
            cell_id: v.cellId && cellIds.has(v.cellId) ? v.cellId : null,
            icp_id: v.icpId && icpIds.has(v.icpId) ? v.icpId : null,
            result_count: v.resultCount ?? null,
        });
    }
    await upsertAll('search_log', 'search_log', searchRows, 'vertical,lat_bucket,lng_bucket,term');

    // ─── Sourcing scans + place details ─────────────────────────────────────
    // Skipped under a portfolio filter - these come from the one-off Sourcing
    // tool and aren't ICP-scoped, so they can't be cleanly attributed to a
    // single portfolio. A full (unfiltered) import includes them.
    if (filtered) {
        console.log(`  ${'scans / place_details'.padEnd(22)} skipped (portfolio filter active - not ICP-scoped)`);
    } else {
        const sources = readJson('sources.json', { scans: [], placeDetails: {} });
        await upsertAll('scans', 'scans', (sources.scans || []).map(s => ({
            id: s.id,
            city: s.city || null,
            country: s.country || null,
            ll: s.ll || null,
            query: s.query || null,
            page: s.page ?? null,
            ran_at: toTs(s.ranAt) || nowIso,
            total_raw: s.totalRaw ?? null,
            chains_filtered: s.chainsFiltered ?? null,
            non_target_filtered: s.nonTargetFiltered ?? null,
            results: s.results || [],
        })), 'id');
        await upsertAll('place_details', 'place_details',
            Object.entries(sources.placeDetails || {}).map(([dataId, data]) => ({
                data_id: dataId,
                fetched_at: toTs(data && data.fetchedAt) || nowIso,
                data,
            })), 'data_id');
    }

    // ─── Geocoded cities ────────────────────────────────────────────────────
    const geo = readJson('geocoded-cities.json', {});
    await upsertAll('geocoded_cities', 'geocoded_cities', Object.entries(geo).map(([key, g]) => ({
        key,
        label: g.label || null,
        country: g.country || null,
        domain: g.domain || null,
        language: g.language || null,
        lat: g.lat ?? null,
        lng: g.lng ?? null,
        ll: g.ll || null,
        metro_radius_km: g.metro_radius_km ?? null,
        geocoded: g.geocoded !== false,
        geocode_source: g.geocodeSource || null,
        props: g.photonProps || null,
    })), 'key');

    // ─── App settings (one row per group) ───────────────────────────────────
    const settings = readJson('settings.json', {});
    await upsertAll('app_settings', 'app_settings', Object.entries(settings).map(([key, s]) => ({
        key,
        use_default: s.useDefault !== false,
        custom: s.custom || {},
    })), 'key');

    console.log('\n✓ Import complete.');
}

main().catch((e) => { console.error('\n✗ Import failed:', e.message); process.exit(1); });