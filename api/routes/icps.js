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
const { getIcpFull, listIcpsFull, listPortfolioCompanies, createIcp, updateIcp, deleteIcp, computeIcpDefinitionHash, pickTermsForCell } = require('../utils/icps');
const { listByVertical, setClassificationForIcp } = require('./companies');
const grid = require('../utils/grid-store');
const { trackActivity } = require('../middleware/activity');
const scrapeCache = require('../utils/scrape-cache');
const { pushEvent } = require('../utils/activity-log');
const { chat } = require('../utils/openai');
const { getAi } = require('../utils/settings');
const { ICP_GENERATE_SYSTEM, ICP_IMPROVE_SYSTEM } = require('../prompts/icp-generate');

const router = express.Router();

router.get('/', async (req, res) => {
    // Optional filters - both AND-combined when supplied. Used by the
    // Coverage / Database / ICP-edit pages to scope the picker to ICPs
    // the user actually wants to see.
    const v = req.query.vertical ? String(req.query.vertical).toLowerCase() : null;
    const pc = req.query.portfolioCompany ? String(req.query.portfolioCompany).toLowerCase() : null;
    let icps = listIcpsFull();
    if (v) icps = icps.filter((i) => (i.vertical || '').toLowerCase() === v);
    if (pc) icps = icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === pc);

    // Attach pending-cell counts so the Coverage ICP dropdown can render
    // "NedFox - Garden Centres · 23 pending" badges without each frontend
    // having to compute it. One pass over grid.listCells({state:'pending'})
    // and a Map by icpId - cheap even with thousands of cells.
    try {
        const pending = await grid.listCells({ state: 'pending' });
        const counts = new Map();
        for (const cell of pending) {
            counts.set(cell.icpId, (counts.get(cell.icpId) || 0) + 1);
        }
        icps = icps.map((i) => ({ ...i, pendingCells: counts.get(i.id) || 0 }));
    } catch (e) {
        // Non-fatal: dropdown just doesn't show counts if grid_cells fails.
        console.warn(`[ICPs] list pending-counts attach failed: ${e.message}`);
    }

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

router.post('/', trackActivity('icp_created'), async (req, res) => {
    try {
        const icp = await createIcp(req.body || {});
        console.log(`[ICPs] ✓ CREATE id="${icp.id}" name="${icp.name}" vertical="${icp.vertical}" portfolioCompany="${icp.portfolioCompany || '(none)'}" cities=[${(icp.cities || []).join(', ')}]`);
        res.json({ success: true, icp });
    } catch (err) {
        console.warn(`[ICPs] ✗ CREATE failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

// ─── POST /generate ─────────────────────────────────────────────────────
// AI-fill the ICP form from a free-text description. Does NOT persist - the
// frontend populates its editor state from the returned payload and the user
// reviews/edits before saving. The prompt itself (Atlas pipeline brief +
// field rules + worked examples) lives in api/prompts/icp-generate.js.
// Body: { description, portfolioCompany? }.

// Defensive normalisation of a model-produced ICP payload. Coerces every
// field to the right type, slugs the id, uppercases country codes, and
// guarantees at least one coverage tier is on (otherwise seeding is a no-op).
// Shared between /generate (description → ICP) and /improve (critique an
// existing form state and return a tightened ICP).
function normalizeAiIcp(g, portfolioCompany) {
    const obj = g && typeof g === 'object' ? g : {};
    const arr = (x) => Array.isArray(x) ? x.filter(Boolean).map((s) => String(s).trim()).filter(Boolean) : [];
    const str = (x) => x == null ? '' : String(x).trim();
    const slug = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'icp';
    const cov = obj.coverage || {};
    // Per-country search-term overrides. Object of country-code keys → string
    // arrays. Empty/missing entries are dropped silently. Returns null when
    // nothing usable was produced (the sweep then falls back to the flat
    // searchTerms list).
    let searchTermsByCountry = null;
    if (obj.searchTermsByCountry && typeof obj.searchTermsByCountry === 'object' && !Array.isArray(obj.searchTermsByCountry)) {
        const out = {};
        for (const [code, terms] of Object.entries(obj.searchTermsByCountry)) {
            const cc = String(code || '').trim().toUpperCase();
            if (!cc) continue;
            const list = arr(terms);
            if (list.length > 0) out[cc] = list;
        }
        if (Object.keys(out).length > 0) searchTermsByCountry = out;
    }
    // Per-city overrides. Same defensive shape as searchTermsByCountry, but
    // keyed by city name (case-preserved) instead of country code. AI models
    // may produce this when /improve sees an outlier city in a multi-country
    // ICP - lets a single Berlin in an NL+UK ICP carry German terms without
    // forcing the user to tick DE (and thereby trigger DE country-fill).
    let cityTerms = null;
    if (obj.cityTerms && typeof obj.cityTerms === 'object' && !Array.isArray(obj.cityTerms)) {
        const out = {};
        for (const [city, terms] of Object.entries(obj.cityTerms)) {
            const name = String(city || '').trim();
            if (!name) continue;
            const list = arr(terms);
            if (list.length > 0) out[name] = list;
        }
        if (Object.keys(out).length > 0) cityTerms = out;
    }
    const icp = {
        name: str(obj.name) || 'New ICP',
        id: slug(obj.id || obj.name),
        vertical: str(obj.vertical),
        portfolioCompany: str(portfolioCompany) || str(obj.portfolioCompany) || '',
        countries: arr(obj.countries).map((c) => c.toUpperCase()),
        searchTerms: arr(obj.searchTerms),
        searchTermsByCountry,
        cityTerms,
        cities: arr(obj.cities),
        coverage: {
            urban: cov.urban !== false,        // default on
            suburban: !!cov.suburban,
            rural: !!cov.rural,
            airports: !!cov.airports,
        },
        targetDescription: str(obj.targetDescription),
        customerTypes: arr(obj.customerTypes),
        excludeTypes: arr(obj.excludeTypes),
        excludeCompanies: arr(obj.excludeCompanies),
        extraNotes: str(obj.extraNotes),
    };
    if (!icp.coverage.urban && !icp.coverage.suburban && !icp.coverage.rural && !icp.coverage.airports) {
        icp.coverage.urban = true;
    }
    return icp;
}

// Per-section AI fill targets the user can pass via body.section. When set,
// the response payload is partial - only the fields belonging to that section
// are populated. Lets the editor have small per-section AI buttons that
// refresh ONE block without overwriting the user's other tweaks.
const SECTION_FIELDS = {
    // search-terms includes the per-country map too - when a multi-country
    // ICP asks for "AI: search terms" we want GPT to fill in BOTH the flat
    // fallback list AND the per-country buckets so a Dutch term doesn't end
    // up running in UK Maps and vice versa.
    'search-terms': ['searchTerms', 'searchTermsByCountry', 'cityTerms'],
    'cities': ['cities'],
    'classifier': ['targetDescription', 'customerTypes', 'excludeTypes', 'excludeCompanies', 'extraNotes'],
};

router.post('/generate', async (req, res) => {
    const { description, portfolioCompany, section, current } = req.body || {};
    if (!description || !String(description).trim()) {
        return res.status(400).json({ success: false, error: 'description required' });
    }
    const sectionKey = section && SECTION_FIELDS[section] ? section : null;
    const startedAt = Date.now();
    console.log(`[ICPs] ▶ GENERATE${sectionKey ? `:${sectionKey}` : ''} description="${String(description).trim().slice(0, 80)}..." pc="${portfolioCompany || '(none)'}"`);
    try {
        // When the caller is asking for ONE section, pass the rest of their
        // current draft as context so GPT tailors the section to the
        // already-chosen vertical / countries / etc. instead of going generic.
        const contextBlock = sectionKey && current && typeof current === 'object'
            ? `\n\nThe user has already filled in the rest of the ICP. Use this as context (do NOT change anything outside the requested section):\n${JSON.stringify({
                vertical: current.vertical,
                countries: current.countries,
                cities: current.cities,
                searchTerms: current.searchTerms,
                targetDescription: current.targetDescription,
                customerTypes: current.customerTypes,
                excludeTypes: current.excludeTypes,
                excludeCompanies: current.excludeCompanies,
            }, null, 2)}`
            : '';
        const taskInstruction = sectionKey
            ? `\n\nReturn ONLY the JSON fields for the "${sectionKey}" section: ${SECTION_FIELDS[sectionKey].join(', ')}. Omit every other field. Keep the same JSON envelope shape (top-level keys, just only the requested ones populated).`
            : '';
        const raw = await chat(
            [
                { role: 'system', content: ICP_GENERATE_SYSTEM + taskInstruction },
                { role: 'user', content: `Portfolio company: ${portfolioCompany || '(none)'}\n\nDescription:\n${String(description).trim()}${contextBlock}` },
            ],
            { model: getAi().classifyModel, temperature: 0.3, response_format: { type: 'json_object' } },
        );
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            console.warn('[ICPs] ✗ GENERATE non-JSON response');
            return res.status(502).json({ success: false, error: 'AI returned non-JSON', raw: String(raw).slice(0, 500) });
        }
        // For a section call we return only the requested fields so the
        // frontend can splat them in without touching anything else.
        if (sectionKey) {
            const full = normalizeAiIcp(parsed, portfolioCompany);
            const subset = {};
            for (const k of SECTION_FIELDS[sectionKey]) subset[k] = full[k];
            console.log(`[ICPs] ✓ GENERATE:${sectionKey} ${Date.now() - startedAt}ms | fields=${SECTION_FIELDS[sectionKey].join(',')}`);
            return res.json({ success: true, section: sectionKey, fields: subset });
        }
        const icp = normalizeAiIcp(parsed, portfolioCompany);
        console.log(`[ICPs] ✓ GENERATE ${Date.now() - startedAt}ms | name="${icp.name}" vertical="${icp.vertical}" terms=${icp.searchTerms.length} cities=${icp.cities.length}`);
        res.json({ success: true, icp });
    } catch (err) {
        console.error(`[ICPs] ✗ GENERATE error after ${Date.now() - startedAt}ms:`, err.message);
        res.status(500).json({ success: false, error: err.message || 'generate failed' });
    }
});

// ─── POST /improve ──────────────────────────────────────────────────────
// Critique the current ICP form state and return both a short text critique
// AND a tightened ICP payload the user can apply. Catches the kind of bad-
// config mistake even a manual-form-only flow would let through (jargon /
// abstract search terms, wrong-shape targetDescription, missing big-name
// exclusions, etc.). Body: { icp, portfolioCompany? }. Prompt itself lives
// in api/prompts/icp-generate.js next to the generator.

router.post('/improve', async (req, res) => {
    const { icp: current, portfolioCompany } = req.body || {};
    if (!current || typeof current !== 'object') {
        return res.status(400).json({ success: false, error: 'icp object required' });
    }
    const startedAt = Date.now();
    console.log(`[ICPs] ▶ IMPROVE id="${current.id || '(new)'}" name="${current.name || '(unnamed)'}"`);
    try {
        // Only forward the fields that drive the sweep - skip frontend-only
        // bookkeeping like classifyPrompt (auto-composed) and reportTemplate.
        const snapshot = {
            name: current.name,
            vertical: current.vertical,
            portfolioCompany: current.portfolioCompany,
            countries: current.countries,
            searchTerms: current.searchTerms,
            searchTermsByCountry: current.searchTermsByCountry,
            cityTerms: current.cityTerms,
            cities: current.cities,
            coverage: current.coverage,
            targetDescription: current.targetDescription,
            customerTypes: current.customerTypes,
            excludeTypes: current.excludeTypes,
            excludeCompanies: current.excludeCompanies,
            extraNotes: current.extraNotes,
        };
        const raw = await chat(
            [
                { role: 'system', content: ICP_IMPROVE_SYSTEM },
                { role: 'user', content: `Portfolio company: ${portfolioCompany || current.portfolioCompany || '(none)'}\n\nCurrent ICP:\n${JSON.stringify(snapshot, null, 2)}` },
            ],
            { model: getAi().classifyModel, temperature: 0.3, response_format: { type: 'json_object' } },
        );
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            console.warn('[ICPs] ✗ IMPROVE non-JSON response');
            return res.status(502).json({ success: false, error: 'AI returned non-JSON', raw: String(raw).slice(0, 500) });
        }
        const critique = String(parsed.critique || '').trim() || 'No critique returned.';
        const improved = normalizeAiIcp(parsed.improved || {}, portfolioCompany || current.portfolioCompany);
        console.log(`[ICPs] ✓ IMPROVE ${Date.now() - startedAt}ms | critique="${critique.slice(0, 80)}..."`);
        res.json({ success: true, critique, improved });
    } catch (err) {
        console.error(`[ICPs] ✗ IMPROVE error after ${Date.now() - startedAt}ms:`, err.message);
        res.status(500).json({ success: false, error: err.message || 'improve failed' });
    }
});

// ─── POST /distribute-search-terms ──────────────────────────────────────
// Take a flat list of Google Maps search terms + a list of target countries,
// classify each term by language, and bucket it into the country(ies) that
// speak that language. Terms whose language isn't represented in the chosen
// countries fall into `shared` (used as fallback for any unbucketed market).
//
// Backs the "Distribute shared by language" button in the ICP editor's
// multi-country search-terms section. The boss's existing flat list often
// contains language-correct phrases (tuincentrum, garden centre, jardinerie)
// that just need bucketing - this saves him from copying terms around by
// hand and asking GPT to bucket them is more accurate than a heuristic on
// short strings.
const DISTRIBUTE_SYSTEM = `You classify Google Maps search terms by language and bucket them into the countries that speak that language.

Country → language mapping:
- NL → Dutch  (e.g. tuincentrum, plantenkwekerij, kwekerij)
- DE → German (e.g. Gartencenter, Pflanzenmarkt, Baumschule)
- FR → French (e.g. jardinerie, pépinière)
- ES → Spanish
- IT → Italian
- PT → Portuguese
- BE → BOTH Dutch and French (bilingual market - put Dutch terms here AND in any Dutch markets like NL; same for French)
- UK, US, CA, IE, AU → English

For each input term:
1. Classify the language.
2. Add the term to every requested country whose language matches. (English term → all English-speaking countries in the list. Dutch term → NL and BE if both are in the list.)
3. If the term's language is NOT represented in the requested countries, OR the term is a brand name / proper noun / ambiguous abbreviation, put it in "shared" instead.

Return ONLY a JSON object:
{
  "byCountry": { "NL": ["tuincentrum", ...], "UK": ["garden centre", ...], ... },
  "shared": ["..."]
}

Only include countries that received at least one term. Preserve the original wording verbatim - do not translate, normalise, or invent.`;

router.post('/distribute-search-terms', async (req, res) => {
    const { terms, countries } = req.body || {};
    const cleanTerms = Array.isArray(terms)
        ? terms.map((t) => String(t || '').trim()).filter(Boolean)
        : [];
    const cleanCountries = Array.isArray(countries)
        ? [...new Set(countries.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))]
        : [];
    if (cleanTerms.length === 0) {
        return res.status(400).json({ success: false, error: 'terms array required' });
    }
    if (cleanCountries.length === 0) {
        return res.status(400).json({ success: false, error: 'countries array required' });
    }
    const startedAt = Date.now();
    console.log(`[ICPs] ▶ DISTRIBUTE terms=${cleanTerms.length} countries=[${cleanCountries.join(', ')}]`);
    try {
        const raw = await chat(
            [
                { role: 'system', content: DISTRIBUTE_SYSTEM },
                { role: 'user', content: `Terms: ${JSON.stringify(cleanTerms)}\nCountries: ${JSON.stringify(cleanCountries)}` },
            ],
            { model: getAi().classifyModel, temperature: 0.1, response_format: { type: 'json_object' } },
        );
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            console.warn('[ICPs] ✗ DISTRIBUTE non-JSON response');
            return res.status(502).json({ success: false, error: 'AI returned non-JSON' });
        }
        const byCountry = {};
        if (parsed.byCountry && typeof parsed.byCountry === 'object') {
            for (const [cc, t] of Object.entries(parsed.byCountry)) {
                const code = String(cc || '').trim().toUpperCase();
                if (!code || !cleanCountries.includes(code)) continue;
                const list = Array.isArray(t)
                    ? t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
                    : [];
                if (list.length > 0) byCountry[code] = list;
            }
        }
        const shared = Array.isArray(parsed.shared)
            ? parsed.shared.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
            : [];
        console.log(`[ICPs] ✓ DISTRIBUTE ${Date.now() - startedAt}ms | countries=[${Object.keys(byCountry).join(',')}] shared=${shared.length}`);
        res.json({ success: true, byCountry, shared });
    } catch (err) {
        console.error(`[ICPs] ✗ DISTRIBUTE error after ${Date.now() - startedAt}ms:`, err.message);
        res.status(500).json({ success: false, error: err.message || 'distribute failed' });
    }
});

// ─── POST /terms-for-city ───────────────────────────────────────────────
// Generate Maps search terms for a single outlier city - the "Berlin-only
// terms" path on the ICP editor. Used when an ICP has, say, NL + UK ticked
// and one stray Berlin city: the user doesn't want to tick DE (which would
// expand country-fill to all of Germany), they just want this one city to
// run language-correct queries. GPT translates the ICP's existing terms /
// targetDescription into the city's market language.
//
// Body: { city, country, vertical?, targetDescription?, existingTerms? }
//   - city:               'Berlin'
//   - country:            'DE'   (used as the language anchor)
//   - vertical:           'Garden Centre' (helps GPT pick the right Maps category)
//   - targetDescription:  ICP's `targetDescription` (semantic anchor)
//   - existingTerms:      object like { NL: [...], UK: [...], shared: [...] }
//                         so GPT can translate from a sibling country's list
//                         instead of free-inventing
//
// Returns: { success: true, terms: ['Gartencenter', 'Pflanzenmarkt', ...] }
const TERMS_FOR_CITY_SYSTEM = `You are picking Google Maps search phrases for ONE specific city inside Atlas, a deal-sourcing engine.

The user has an ICP whose ticked \`countries\` does NOT include this city's country - it's a deliberate outlier. They want Maps queries tuned to the city's native language so Scrapingdog returns relevant places (a Dutch term in German Maps returns garbage).

Given:
- A city (e.g. "Berlin")
- That city's country code (e.g. "DE") - this drives the LANGUAGE of the output phrases
- The ICP's vertical and targetDescription
- The ICP's existing per-country and shared search terms - use these as SEMANTIC ANCHORS. Translate them into the city's market language rather than free-inventing from the vertical name alone (much better quality).

Return 2-4 real Google Maps category phrases in the city's native language. Rules:
- DE → German ("Gartencenter", "Pflanzenmarkt", "Gartenfachmarkt")
- FR → French ("jardinerie", "pépinière", "centre de jardinage")
- IT → Italian ("garden center", "vivaio")
- ES → Spanish ("centro de jardinería", "vivero")
- PT → Portuguese ("centro de jardinagem", "horto")
- NL → Dutch ("tuincentrum", "kwekerij")
- UK/IE/US/CA/AU → English ("garden centre", "plant nursery")
- BE → BOTH Dutch and French (it's bilingual - include 2-3 of each)
Real category names users would type into Maps. NEVER abstract jargon, product names, or internal terms. NEVER literal word-by-word translations - use the phrases native Maps users actually search.

Return ONLY JSON, no commentary:
{ "terms": ["...", "...", "..."] }`;

router.post('/terms-for-city', async (req, res) => {
    const { city, country, vertical, targetDescription, existingTerms } = req.body || {};
    const cityName = String(city || '').trim();
    const cc = String(country || '').trim().toUpperCase();
    if (!cityName) return res.status(400).json({ success: false, error: 'city required' });
    if (!cc) return res.status(400).json({ success: false, error: 'country code required' });

    // Hint to GPT: if the caller has zero context (no vertical, no targetDescription,
    // no existing terms anywhere) the result will be generic and weak. The frontend
    // disables the button in that case, but guard server-side too in case it's
    // called directly.
    const hasContext = String(vertical || '').trim()
        || String(targetDescription || '').trim()
        || (existingTerms && typeof existingTerms === 'object' && Object.values(existingTerms).some((v) => (Array.isArray(v) ? v.length : 0) > 0));
    if (!hasContext) {
        return res.status(400).json({ success: false, error: 'Need at least one of: vertical, targetDescription, or existingTerms - GPT has nothing to translate from otherwise' });
    }

    const startedAt = Date.now();
    console.log(`[ICPs] ▶ TERMS-FOR-CITY city="${cityName}" country=${cc}`);
    try {
        const userPayload = {
            city: cityName,
            country: cc,
            vertical: String(vertical || '').trim() || null,
            targetDescription: String(targetDescription || '').trim() || null,
            existingTerms: existingTerms && typeof existingTerms === 'object' ? existingTerms : null,
        };
        const raw = await chat(
            [
                { role: 'system', content: TERMS_FOR_CITY_SYSTEM },
                { role: 'user', content: JSON.stringify(userPayload, null, 2) },
            ],
            { model: getAi().classifyModel, temperature: 0.2, response_format: { type: 'json_object' } },
        );
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch {
            console.warn('[ICPs] ✗ TERMS-FOR-CITY non-JSON response');
            return res.status(502).json({ success: false, error: 'AI returned non-JSON' });
        }
        const terms = Array.isArray(parsed.terms)
            ? parsed.terms.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
            : [];
        if (terms.length === 0) {
            console.warn(`[ICPs] ✗ TERMS-FOR-CITY empty result city="${cityName}" country=${cc}`);
            return res.status(502).json({ success: false, error: 'AI returned no terms' });
        }
        console.log(`[ICPs] ✓ TERMS-FOR-CITY ${Date.now() - startedAt}ms | city="${cityName}" terms=${terms.length}: [${terms.join(', ')}]`);
        res.json({ success: true, city: cityName, country: cc, terms });
    } catch (err) {
        console.error(`[ICPs] ✗ TERMS-FOR-CITY error after ${Date.now() - startedAt}ms:`, err.message);
        res.status(500).json({ success: false, error: err.message || 'terms-for-city failed' });
    }
});

router.put('/:id', trackActivity('icp_updated'), async (req, res) => {
    try {
        const icp = await updateIcp(req.params.id, req.body || {});
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

router.delete('/:id', trackActivity('icp_deleted'), async (req, res) => {
    const ok = await deleteIcp(req.params.id);
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

        // Stale-sweep detection: walk completed cells for this ICP and check
        // whether any have a stored search_terms list missing terms that the
        // ICP's CURRENT definition would now use for them. Only ADDITIONS
        // count - a term removal doesn't invalidate the cell's stored data
        // (results from removed terms remain valid, they just won't be
        // re-discovered next time). NULL stored list = legacy pre-migration
        // cells; treated as stale so the very first refresh after rollout
        // backfills the stamp cleanly.
        //
        // The "new terms" set is the union of additions across affected
        // cells, so the Coverage banner can show the user EXACTLY which
        // terms would hit Scrapingdog on rescan. search_log dedup means
        // already-run terms get skipped at runtime; we surface that here
        // pre-action so the user knows the rescan won't burn the full
        // term-budget per cell.
        let staleSweep = { stale: 0, completed: 0, newTermsByCell: {}, newTerms: [] };
        try {
            const allCells = await grid.listCells({ icpId: icp.id });
            const newTermsUnion = new Set();
            let staleCount = 0;
            let completedCount = 0;
            const newTermsByCell = {};
            for (const cell of allCells) {
                // Only completed-ish cells count - pending cells will run with
                // current terms naturally, no rescan needed.
                if (!['complete', 'empty', 'no_new'].includes(cell.state)) continue;
                completedCount++;
                const pick = pickTermsForCell(icp, cell);
                if (pick.skip) continue;  // outlier cell, will be skipped at sweep time anyway
                const currentTerms = (pick.terms || []).filter(Boolean);
                const stored = Array.isArray(cell.searchTerms) ? cell.searchTerms : null;
                const storedSet = stored ? new Set(stored) : null;
                // NULL stored = legacy: flag the cell if it has any current
                // terms (otherwise there's nothing to rescan, leave it alone).
                const newTerms = stored
                    ? currentTerms.filter((t) => !storedSet.has(t))
                    : currentTerms;
                if (newTerms.length > 0) {
                    staleCount++;
                    newTermsByCell[cell.id] = newTerms;
                    for (const t of newTerms) newTermsUnion.add(t);
                }
            }
            staleSweep = {
                stale: staleCount,
                completed: completedCount,
                newTermsByCell,
                newTerms: Array.from(newTermsUnion).sort(),
            };
        } catch (e) {
            // Non-fatal - if grid_cells doesn't exist or the query failed,
            // we just skip the staleness summary. Coverage core data still
            // returns cleanly.
            console.warn(`[ICPs] coverage staleSweep check failed: ${e.message}`);
        }

        res.json({ success: true, vertical, summary, breakdown, staleSweep });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/icps/:id/rescan-stale-terms
//
// Marks every cell for this ICP that has search-term ADDITIONS (relative to
// what was Maps'd at its last sweep) back to `pending`. The sweep cron then
// picks them up and runs `searchLog.unmatchedTerms()` to skip the terms
// already covered for this (vertical, lat, lng), so only the genuinely new
// terms hit Scrapingdog. Cheap targeted rescan.
//
// Returns { rescanned: N, newTerms: [...] }. Zero-action when nothing's
// stale.
router.post('/:id/rescan-stale-terms', trackActivity('rescan_stale_terms'), async (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });

    try {
        const allCells = await grid.listCells({ icpId: icp.id });
        const newTermsUnion = new Set();
        const toReset = [];
        for (const cell of allCells) {
            if (!['complete', 'empty', 'no_new'].includes(cell.state)) continue;
            const pick = pickTermsForCell(icp, cell);
            if (pick.skip) continue;
            const currentTerms = (pick.terms || []).filter(Boolean);
            const stored = Array.isArray(cell.searchTerms) ? cell.searchTerms : null;
            const storedSet = stored ? new Set(stored) : null;
            const newTerms = stored
                ? currentTerms.filter((t) => !storedSet.has(t))
                : currentTerms;
            if (newTerms.length > 0) {
                toReset.push(cell.id);
                for (const t of newTerms) newTermsUnion.add(t);
            }
        }
        // Mark each affected cell back to pending. Keeps placesFound and
        // friends untouched so the user can still see "this cell originally
        // turned up 12 companies" - they'll be added-to, not replaced, when
        // the cron re-runs it (the sweep upserts companies by domain, so
        // existing companies stay and new ones get appended).
        for (const cellId of toReset) {
            await grid.updateCell(cellId, {
                state: 'pending',
                lastError: null,
            });
        }
        console.log(`[ICPs] ▶ RESCAN-STALE-TERMS id="${icp.id}" cells=${toReset.length} newTerms=[${Array.from(newTermsUnion).join(', ')}]`);
        res.json({
            success: true,
            rescanned: toReset.length,
            newTerms: Array.from(newTermsUnion).sort(),
        });
    } catch (err) {
        console.error(`[ICPs] ✗ RESCAN-STALE-TERMS error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/icps/:id/reclassify-targets - list of cached companies in this
// ICP's vertical, each tagged with whether they have a current classification
// for THIS ICP (so the Reclassify tab can render the preview list with a
// before-state per row). No GPT, no Scrapingdog - just reads the companies
// store. Used by the editor's Reclassify tab when it first opens.
//
// Response: { success, total, classified, unclassified, stale, currentHash, targets: [
//   { domain, name, city, url, definitionStale, classification: { is_match, reason, classifiedAt, definitionHash } | null }
// ]}
//
// `definitionStale` is the AUTHORITATIVE "this verdict needs re-running"
// flag - server-side comparison of each company's stored definition_hash
// against the ICP's current hash. NULL stored hash (legacy rows from before
// migration 0005) is also treated as stale, so the very first reclassify
// after the migration covers existing classifications cleanly.
//
// This replaces the previous client-side baseline-snapshot detection, which
// got reset on every editor open and couldn't survive save+close+reopen.
router.get('/:id/reclassify-targets', async (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });
    if (!icp.vertical) return res.status(400).json({ success: false, error: 'ICP has no vertical' });

    try {
        const all = await listByVertical(icp.vertical);
        const currentHash = computeIcpDefinitionHash(icp);
        // For each company: surface the bits the UI needs without dumping
        // the entire scrape blob. The presence of a cached scrape is the
        // gate for whether the company can be reclassified at all - we tell
        // the UI up front so it can disable those rows + show a "needs sweep"
        // note instead of letting the user pick a no-op target.
        // We intentionally DON'T check scrape-cache availability per-row here -
        // doing so would be N Supabase queries on listing open, prohibitive
        // for a vertical with hundreds of cached companies. The runtime
        // reclassify path already handles missing scrapes by emitting
        // `company_skipped` events with reason 'no cached scrape' - the UI
        // surfaces that diff-view-side, no need to pre-flag.
        const targets = all.map((c) => {
            const raw = c.classifications && c.classifications[icp.id];
            const classification = raw
                ? {
                    is_match: !!raw.is_match,
                    reason: raw.reason || '',
                    classifiedAt: raw.classifiedAt || null,
                    // Echo back so the frontend can show "this verdict was
                    // written under definition X" diagnostics if useful.
                    definitionHash: raw.definitionHash || null,
                    // At-a-glance Google Maps signals captured at sweep time
                    // (sweep-pipeline.js writes them into the classification
                    // entry alongside is_match/reason). Surface them on the
                    // Reclassify tab's per-row strip so the user can spot-
                    // check a verdict without expanding the scrape preview.
                    title: raw.title || null,
                    phone: raw.phone || null,
                    address: raw.address || null,
                    rating: typeof raw.rating === 'number' ? raw.rating : null,
                    reviews: typeof raw.reviews === 'number' ? raw.reviews : null,
                }
                : null;
            // Stale = there's a stored verdict AND either no hash is
            // stamped (legacy / pre-migration) or the hash differs from
            // the ICP's current definition. Unclassified rows (no verdict
            // at all) are surfaced via classification=null - that's a
            // separate "needs first-time classify" signal the frontend
            // already handles.
            let definitionStale = false;
            if (classification && currentHash) {
                definitionStale = !classification.definitionHash
                    || classification.definitionHash !== currentHash;
            }
            return {
                domain: c.domain,
                name: c.classification?.name || c.classification?.title || c.domain,
                city: c.city || null,
                url: c.url || null,
                classification,
                definitionStale,
            };
        });
        // Sort: unclassified first (most actionable), then stale verdicts,
        // then fresh. Lets the user see "what's new since last reclassify"
        // and "what's changed since last classify" at the top without
        // scrolling.
        targets.sort((a, b) => {
            const ac = a.classification ? 1 : 0;
            const bc = b.classification ? 1 : 0;
            if (ac !== bc) return ac - bc;
            const as = a.definitionStale ? 0 : 1;
            const bs = b.definitionStale ? 0 : 1;
            if (as !== bs) return as - bs;
            return String(a.domain).localeCompare(String(b.domain));
        });
        const classifiedCount = targets.filter((t) => t.classification).length;
        const staleCount = targets.filter((t) => t.definitionStale).length;
        res.json({
            success: true,
            vertical: icp.vertical,
            total: targets.length,
            classified: classifiedCount,
            unclassified: targets.length - classifiedCount,
            stale: staleCount,
            currentHash,
            targets,
        });
    } catch (err) {
        console.error(`[ICPs] ✗ RECLASSIFY-TARGETS error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/icps/:id/scrape-preview/:domain - returns a truncated snippet
// of a cached company's scrape markdown for the Reclassify tab's per-row
// expansion. Lets the user see what GPT actually saw before / after a
// verdict flip, without forcing them to leave the tab.
//
// Truncates to ~3000 chars (about a screen) since the goal is a quick
// "does this scrape look right" check, not the full document.
router.get('/:id/scrape-preview/:domain', async (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!domain) return res.status(400).json({ success: false, error: 'domain required' });
    try {
        const cached = await scrapeCache.get(domain);
        if (!cached || !cached.markdown) {
            return res.json({ success: true, domain, hasScrape: false, snippet: null, pageTitle: null, scrapedAt: null });
        }
        const snippet = String(cached.markdown).slice(0, 3000);
        const truncated = cached.markdown.length > 3000;
        res.json({
            success: true,
            domain,
            hasScrape: true,
            pageTitle: cached.pageTitle || null,
            scrapedAt: cached.scrapedAt || cached.createdAt || null,
            snippet,
            truncated,
            totalChars: cached.markdown.length,
        });
    } catch (err) {
        console.error(`[ICPs] ✗ SCRAPE-PREVIEW error: ${err.message}`);
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
router.post('/:id/reclassify', trackActivity('reclassify_run'), async (req, res) => {
    const icp = getIcpFull(req.params.id);
    if (!icp) return res.status(404).json({ success: false, error: 'ICP not found' });
    if (!icp.vertical) return res.status(400).json({ success: false, error: 'ICP has no vertical - reclassify needs a vertical to know which companies to re-run against.' });
    if (!icp.classifyPrompt) return res.status(400).json({ success: false, error: 'ICP has no classifyPrompt - fill in the criteria first.' });

    const body = req.body || {};
    const wantedCities = Array.isArray(body.cities) ? body.cities.map((s) => String(s).toLowerCase()) : null;
    const force = !!body.force;
    const allCities = wantedCities && wantedCities.includes('all');
    // Subset filter - the Reclassify tab UI passes only the companies the
    // user ticked. Lowercased for case-insensitive match against
    // company.domain. Null = no filter (default = entire vertical, the
    // legacy behaviour). Combine AND with the city filter above when both
    // are set, which the UI never does today but is the safe semantics.
    const wantedDomains = Array.isArray(body.domains)
        ? new Set(body.domains.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
        : null;

    const startedAt = Date.now();
    console.log(`[Reclassify] ▶ START icp="${icp.id}" vertical="${icp.vertical}" cities=${allCities ? 'ALL' : (wantedCities ? `[${wantedCities.join(', ')}]` : 'ICP default')} domains=${wantedDomains ? wantedDomains.size : 'all'} force=${force}`);

    try {
        const all = await listByVertical(icp.vertical);
        // Filter to the cities we care about (unless caller wants the whole
        // vertical). City tags on company records are set when the sweep
        // creates the company - could be missing on legacy entries; those
        // pass through if `allCities` is true.
        const targets = all.filter((c) => {
            if (wantedDomains && !wantedDomains.has(String(c.domain || '').toLowerCase())) return false;
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
        let flipped = 0;        // verdict changed since last classification
        // Per-company results - returned in the JSON response so the UI can
        // populate the after-the-fact diff view if the user re-opens the
        // tab after the run completed (the streamed pushEvent log only
        // covers in-flight viewers).
        const results = [];

        pushEvent({
            type: 'cell_start',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: null,
            message: `Reclassify started - ${targets.length} cached ${icp.vertical} companies for ICP "${icp.name}"`,
        });

        for (const company of targets) {
            // Capture the BEFORE-state for this ICP so the streamed event +
            // response payload can show old → new diff. The UI uses this to
            // highlight "flipped" companies (qualified → rejected and vice
            // versa) which is usually the most interesting thing in the run.
            const oldVerdict = company.classifications && company.classifications[icp.id]
                ? { is_match: !!company.classifications[icp.id].is_match, reason: company.classifications[icp.id].reason || '' }
                : null;
            // Skip-already-classified path. Saves the most credits when the
            // user clicks Reclassify multiple times by accident. With the new
            // subset UI, the user explicitly picks which to re-run, so the
            // skip mostly kicks in for the legacy "reclassify entire vertical"
            // path when force=false.
            if (!force && oldVerdict) {
                skipped++;
                results.push({ domain: company.domain, name: company.classification?.name || null, city: company.city || null, oldVerdict, newVerdict: null, skipped: true, reason: 'already classified (force=false)' });
                continue;
            }
            // Emit per-company "scanning" so the UI's row can flip to the
            // in-progress state before the GPT call resolves. Cheap and the
            // UX win is large.
            pushEvent({
                type: 'company_scanning',
                icpId: icp.id,
                cellId: 'reclassify',
                parentCity: company.city || null,
                domain: company.domain,
                message: `Re-evaluating ${company.domain}…`,
            });
            const cached = await scrapeCache.get(company.domain);
            if (!cached || !cached.markdown) {
                // No cached scrape → can't reclassify. Real fix is to run a
                // sweep (which will populate the cache); we skip rather than
                // half-running with empty input that'd just say "no markdown".
                skipped++;
                results.push({ domain: company.domain, name: company.classification?.name || null, city: company.city || null, oldVerdict, newVerdict: null, skipped: true, reason: 'no cached scrape' });
                pushEvent({
                    type: 'company_skipped',
                    icpId: icp.id,
                    cellId: 'reclassify',
                    parentCity: company.city || null,
                    domain: company.domain,
                    reason: 'no cached scrape',
                    message: `${company.domain} skipped - no cached scrape`,
                });
                continue;
            }
            try {
                const messages = [
                    { role: 'system', content: icp.classifyPrompt },
                    { role: 'user', content: `Page title: ${cached.pageTitle || '(none)'}\n\nPage content:\n${(cached.markdown || '').slice(0, 12000)}` },
                ];
                const raw = await chat(messages, {
                    model: getAi().classifyModel,
                    temperature: 0.2,
                    response_format: { type: 'json_object' },
                });
                let parsed;
                try { parsed = JSON.parse(raw); }
                catch { parsed = { is_match: false, reason: `classifier returned non-JSON: ${raw.slice(0, 80)}` }; }
                const verdict = {
                    is_match: !!parsed.is_match,
                    reason: parsed.reason || (parsed.is_match ? 'matched' : 'rejected'),
                    // Stamp the ICP's CURRENT definition hash on the verdict
                    // so the targets endpoint can mark this row fresh on the
                    // next open. Without this stamp the row would re-appear
                    // as stale immediately after a successful reclassify.
                    definitionHash: computeIcpDefinitionHash(icp),
                };
                await setClassificationForIcp(company.domain, icp.id, verdict);
                processed++;
                if (verdict.is_match) qualified++; else rejected++;
                const didFlip = oldVerdict && oldVerdict.is_match !== verdict.is_match;
                if (didFlip) flipped++;
                results.push({ domain: company.domain, name: company.classification?.name || null, city: company.city || null, oldVerdict, newVerdict: verdict, flipped: !!didFlip });
                console.log(`[Reclassify]   ├─ ${verdict.is_match ? '✓' : '✗'} ${company.domain}${didFlip ? ` (FLIPPED from ${oldVerdict.is_match ? '✓' : '✗'})` : ''} | ${verdict.reason.slice(0, 80)}`);
                pushEvent({
                    type: verdict.is_match ? 'company_qualified' : 'company_rejected',
                    icpId: icp.id,
                    cellId: 'reclassify',
                    parentCity: company.city || null,
                    domain: company.domain,
                    title: company.classification?.title || company.classification?.name || company.domain,
                    reason: verdict.reason,
                    // New: old → new so the streaming UI can render the diff
                    // inline without a second fetch.
                    oldVerdict,
                    newVerdict: verdict,
                    flipped: !!didFlip,
                    message: `${company.domain} - ${verdict.is_match ? 'qualified' : 'rejected'}${didFlip ? ' (FLIPPED)' : ''} (reclassify)`,
                });
            } catch (err) {
                errors++;
                results.push({ domain: company.domain, name: company.classification?.name || null, city: company.city || null, oldVerdict, newVerdict: null, error: err.message });
                pushEvent({
                    type: 'company_error',
                    icpId: icp.id,
                    cellId: 'reclassify',
                    parentCity: company.city || null,
                    domain: company.domain,
                    reason: err.message,
                    message: `${company.domain} errored - ${err.message}`,
                });
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
            flipped,        // verdict changed since last classification
        };
        pushEvent({
            type: 'cell_complete',
            icpId: icp.id,
            cellId: 'reclassify',
            parentCity: null,
            placesFound: processed,
            qualifiedCount: qualified,
            state: 'complete',
            message: `Reclassify complete - ${processed} classified (${qualified} qualified, ${rejected} rejected${flipped ? `, ${flipped} flipped` : ''}${skipped ? `, ${skipped} skipped` : ''}${errors ? `, ${errors} errors` : ''})`,
        });
        res.json({ success: true, summary, results });
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
