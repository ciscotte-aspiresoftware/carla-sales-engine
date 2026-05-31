// /api/icps/* - full CRUD for ICP management + reclassify-existing.
//
//   GET    /api/icps                 - list ICPs (full records)
//   GET    /api/icps/:id             - single ICP (full record)
//   POST   /api/icps                 - create  body: { id, name, vertical?, searchTerms[], cities[], classifyPrompt? }
//   PUT    /api/icps/:id             - update  body: same shape as create (id immutable)
//   DELETE /api/icps/:id             - delete
//   POST   /api/icps/:id/reclassify  - re-run this ICP's classifier across
//                                      every cached company in its vertical;
//                                      writes a per-ICP classification under
//                                      company.classifications[icpId] without
//                                      re-scraping anything. Body optional:
//                                      { cities?: [...] } restricts to those
//                                      cities (defaults to ICP's cities; pass
//                                      ['all'] for the whole vertical).
//   GET    /api/icps/:id/coverage    - per-city status for the ICP's cities:
//                                      which are already covered (companies
//                                      cached in this vertical) vs which still
//                                      need a real sweep.
//
// Local-only, no auth - same as the rest of BlueBird's API.
// /api/grid/icps remains as the trimmed picker-style listing the
// Coverage page uses (id/name/vertical/cities only).

const express = require('express');
const { getIcpFull, listIcpsFull, listPortfolioCompanies, createIcp, updateIcp, deleteIcp } = require('../utils/icps');
const { listByVertical, setClassificationForIcp } = require('./companies');
const scrapeCache = require('../utils/scrape-cache');
const { pushEvent } = require('../utils/activity-log');
const { chat } = require('../utils/openai');
const mode = require('../utils/mode');

const router = express.Router();

router.get('/', (req, res) => {
    // Optional filters - both AND-combined when supplied. Used by the
    // Coverage / Database / ICP-edit pages to scope the picker to ICPs
    // the user actually wants to see.
    const v = req.query.vertical ? String(req.query.vertical).toLowerCase() : null;
    const pc = req.query.portfolioCompany ? String(req.query.portfolioCompany).toLowerCase() : null;
    let icps = listIcpsFull();
    if (v) icps = icps.filter((i) => (i.vertical || '').toLowerCase() === v);
    if (pc) icps = icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === pc);
    res.json({ success: true, icps });
});

// GET /api/icps/portfolio-companies - distinct portfolioCompany strings
// across all ICPs. Powers the Portfolio Company filter dropdown on the
// Coverage / Database pages so the UI doesn't have to derive the list
// client-side.
router.get('/portfolio-companies', (_req, res) => {
    res.json({ success: true, portfolioCompanies: listPortfolioCompanies() });
});

router.get('/:id', (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, icp });
});

router.post('/', (req, res) => {
    try {
        const icp = createIcp(req.body || {});
        console.log(`[ICPs] ✓ CREATE id="${icp.id}" name="${icp.name}" vertical="${icp.vertical}" portfolioCompany="${icp.portfolioCompany || '(none)'}" cities=[${(icp.cities || []).join(', ')}]`);
        res.json({ success: true, icp });
    } catch (err) {
        console.warn(`[ICPs] ✗ CREATE failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const icp = updateIcp(req.params.id, req.body || {});
        if (!icp) {
            console.warn(`[ICPs] ✗ UPDATE id="${req.params.id}" not found`);
            return res.status(404).json({ success: false, error: 'not found' });
        }
        console.log(`[ICPs] ✓ UPDATE id="${icp.id}" name="${icp.name}" vertical="${icp.vertical}" cities=[${(icp.cities || []).join(', ')}]`);
        res.json({ success: true, icp });
    } catch (err) {
        console.warn(`[ICPs] ✗ UPDATE id="${req.params.id}" failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    const ok = deleteIcp(req.params.id);
    if (!ok) {
        console.warn(`[ICPs] ✗ DELETE id="${req.params.id}" not found`);
        return res.status(404).json({ success: false, error: 'not found' });
    }
    console.log(`[ICPs] ✓ DELETE id="${req.params.id}"`);
    res.json({ success: true });
});

// GET /api/icps/:id/coverage - per-city coverage snapshot for an ICP.
//
// Returns one row per city in the ICP's `cities` list, telling the UI
// whether the city is "covered" (we already have cached scraped companies
// in this vertical at this city) or "new" (no cached data, a real sweep
// is needed). Drives the seed flow's split-mode UI: "Reclassify these
// 200 cached London companies, sweep these 80 fresh Manchester cells".
//
// Pass ?cities=A,B,C in the query string to override the ICP's cities
// (used when the user picks a different scope in the dropdown).
router.get('/:id/coverage', async (req, res) => {
    try {
        const icp = getIcpFull(req.params.id);
        if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });

        // Resolve the city list to inspect - query override > ICP cities.
        const queryCities = (req.query.cities || '').toString().split(',').map(s => s.trim()).filter(Boolean);
        const cities = queryCities.length > 0 ? queryCities : (icp.cities || []);

        const vertical = icp.vertical;
        const allInVertical = vertical ? await listByVertical(vertical) : [];

        // Bucket existing companies by city. Case-insensitive match because
        // user free-text in the cities form might differ in casing from the
        // demo seeder's parentCity tag.
        const byCity = new Map();
        for (const c of allInVertical) {
            const cityKey = (c.city || '').toLowerCase();
            if (!cityKey) continue;
            if (!byCity.has(cityKey)) byCity.set(cityKey, []);
            byCity.get(cityKey).push(c);
        }

        const breakdown = cities.map((city) => {
            const key = city.toLowerCase();
            const matches = byCity.get(key) || [];
            // A city counts as "covered" if we have at least 1 cached company
            // in this vertical there. The threshold could move higher (e.g. 5)
            // if we want to require meaningful coverage before reusing -
            // starting permissive and we can tune later.
            const covered = matches.length > 0;
            // Track how many of those companies the current ICP has already
            // classified vs how many would be new work. The reclassify pass
            // will only need to touch the unclassified ones.
            const alreadyClassifiedByThisIcp = matches.filter(
                (c) => c.classifications && c.classifications[icp.id],
            ).length;
            return {
                city,
                covered,
                cachedCompanies: matches.length,
                alreadyClassifiedByThisIcp,
                toReclassify: matches.length - alreadyClassifiedByThisIcp,
            };
        });

        // Aggregate counts so the UI can show "X cities covered, Y new" at
        // a glance without re-walking the breakdown.
        const summary = {
            totalCities: breakdown.length,
            coveredCities: breakdown.filter((b) => b.covered).length,
            newCities: breakdown.filter((b) => !b.covered).length,
            totalCachedCompanies: breakdown.reduce((s, b) => s + b.cachedCompanies, 0),
            totalToReclassify: breakdown.reduce((s, b) => s + b.toReclassify, 0),
        };

        res.json({ success: true, vertical, summary, breakdown });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/icps/:id/reclassify - re-run this ICP's classifyPrompt across
// every cached company in its vertical, without re-scraping. Returns a
// summary of how many companies were processed, qualified, rejected.
//
// Body (optional):
//   cities: string[] - restrict to these cities only. Defaults to the ICP's
//                      cities. Pass `["all"]` to reclassify the whole vertical
//                      regardless of city tag.
//   force: boolean   - by default we skip companies already classified by
//                      this ICP (idempotent retry). Pass true to redo even
//                      already-classified ones (e.g. after editing the
//                      ICP's prompt).
//
// This is the cheap path: only GPT classification cost (no Scrapingdog,
// no Firecrawl). Roughly $0.0001 per company at gpt-4o-mini pricing.
router.post('/:id/reclassify', async (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });
    if (!icp.vertical) return res.status(400).json({ success: false, error: 'ICP has no vertical - reclassify needs a vertical to know which companies to re-run against.' });
    if (!icp.classifyPrompt) return res.status(400).json({ success: false, error: 'ICP has no classifyPrompt - fill in the criteria first.' });

    if (mode.isDemo()) {
        console.log(`[Reclassify] short-circuit (demo mode) icp="${icp.id}" — no OpenAI credits spent`);
        return res.json({
            success: true,
            summary: {
                vertical: icp.vertical,
                inputs: 0,
                processed: 0,
                qualified: 0,
                rejected: 0,
                skipped: 0,
                errors: 0,
            },
            demo: true,
        });
    }

    const body = req.body || {};
    const wantedCities = Array.isArray(body.cities) ? body.cities.map((s) => String(s).toLowerCase()) : null;
    const force = !!body.force;
    const allCities = wantedCities && wantedCities.includes('all');

    const startedAt = Date.now();
    console.log(`[Reclassify] ▶ START icp="${icp.id}" vertical="${icp.vertical}" cities=${allCities ? 'ALL' : (wantedCities ? `[${wantedCities.join(', ')}]` : 'ICP default')} force=${force}`);

    try {
        const all = await listByVertical(icp.vertical);
        // Filter to the cities we care about (unless caller wants the whole
        // vertical). City tags on company records are set when the sweep
        // creates the company - could be missing on legacy entries; those
        // pass through if `allCities` is true.
        const targets = all.filter((c) => {
            if (allCities) return true;
            if (!wantedCities) return true; // default: whole vertical
            return wantedCities.includes((c.city || '').toLowerCase());
        });
        console.log(`[Reclassify]   ├─ targets: ${targets.length} cached companies in "${icp.vertical}"`);

        let processed = 0;
        let qualified = 0;
        let rejected = 0;
        let skipped = 0;
        let errors = 0;

        pushEvent({
            type: 'cell_start',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: null,
            message: `Reclassify started - ${targets.length} cached ${icp.vertical} companies for ICP "${icp.name}"`,
        });

        for (const company of targets) {
            // Skip-already-classified path. Saves the most credits when the
            // user clicks Reclassify multiple times by accident.
            if (!force && company.classifications && company.classifications[icp.id]) {
                skipped++;
                continue;
            }
            const cached = await scrapeCache.get(company.domain);
            if (!cached || !cached.markdown) {
                // No cached scrape → can't reclassify. Real fix is to run a
                // sweep (which will populate the cache); we skip rather than
                // half-running with empty input that'd just say "no markdown".
                skipped++;
                continue;
            }
            try {
                const messages = [
                    { role: 'system', content: icp.classifyPrompt },
                    { role: 'user', content: `Page title: ${cached.pageTitle || '(none)'}\n\nPage content:\n${(cached.markdown || '').slice(0, 12000)}` },
                ];
                const raw = await chat(messages, {
                    temperature: 0.2,
                    response_format: { type: 'json_object' },
                });
                let parsed;
                try { parsed = JSON.parse(raw); }
                catch { parsed = { is_match: false, reason: `classifier returned non-JSON: ${raw.slice(0, 80)}` }; }
                const verdict = {
                    is_match: !!parsed.is_match,
                    reason: parsed.reason || (parsed.is_match ? 'matched' : 'rejected'),
                };
                await setClassificationForIcp(company.domain, icp.id, verdict);
                processed++;
                if (verdict.is_match) qualified++; else rejected++;
                console.log(`[Reclassify]   ├─ ${verdict.is_match ? '✓' : '✗'} ${company.domain} | ${verdict.reason.slice(0, 80)}`);
                pushEvent({
                    type: verdict.is_match ? 'company_qualified' : 'company_rejected',
                    icpId: icp.id,
                    cellId: 'reclassify',
                    parentCity: company.city || null,
                    domain: company.domain,
                    title: company.classification?.title || company.classification?.name || company.domain,
                    reason: verdict.reason,
                    message: `${company.domain} - ${verdict.is_match ? 'qualified' : 'rejected'} (reclassify)`,
                });
            } catch (err) {
                errors++;
                console.warn(`[Reclassify]   ├─ ⚠ ${company.domain}: ${err.message}`);
            }
        }
        console.log(`[Reclassify] ✓ END ${Date.now() - startedAt}ms total | processed=${processed} qualified=${qualified} rejected=${rejected} skipped=${skipped} errors=${errors}`);

        const summary = {
            vertical: icp.vertical,
            inputs: targets.length,
            processed,
            qualified,
            rejected,
            skipped,
            errors,
        };
        pushEvent({
            type: 'cell_complete',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: null,
            placesFound: processed,
            qualifiedCount: qualified,
            state: 'complete',
            message: `Reclassify complete - ${processed} classified (${qualified} qualified, ${rejected} rejected${skipped ? `, ${skipped} skipped` : ''}${errors ? `, ${errors} errors` : ''})`,
        });
        res.json({ success: true, summary });
    } catch (err) {
        pushEvent({
            type: 'cell_complete',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: null,
            state: 'error',
            message: `Reclassify failed: ${err.message}`,
        });
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
