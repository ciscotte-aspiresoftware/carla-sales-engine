// ICP (Ideal Customer Profile) registry - file-backed.
//
// Each entry describes WHAT the sweeper is looking for and HOW to qualify
// it. The pipeline (Scrapingdog Search → chains filter → Firecrawl scrape
// → GPT classify) reads from here so swapping the ICP repoints the
// machine at a different vertical without touching any pipeline code.
//
// Persisted at api/data/icps.json so the new ICP-management UI can create/
// edit/delete entries that survive backend restarts. The file is bootstrapped
// with the Bluebird ICP on first read so a fresh checkout still works.
//
// `cities` is the scope. A single-city ICP just lists one city; a multi-
// city or "country" ICP lists all the cities in that country. Keeps the
// config flat - no special "type" discriminator. The seeder reads city
// names from this list and generates Tier-1 sub-cells per city.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'icps.json');

// ─── Supabase layer (icps) ──────────────────────────────────────────────────
// Getters (getIcp/listIcps) are called synchronously in hot paths (the sweep
// pipeline), so we can't make them async. Instead: an in-memory cache is
// seeded synchronously from JSON at boot, then overwritten asynchronously from
// Supabase; create/update/delete write through to Postgres (those are async,
// only invoked from the ICP routes).
function icpRowToObj(r) {
    return {
        id: r.id, name: r.name, vertical: r.vertical || '', portfolioCompany: r.portfolio_company || '',
        countries: r.countries || [], searchTerms: r.search_terms || [], cities: r.cities || [],
        // Per-country search-term overrides. Null when the ICP uses the flat
        // searchTerms list for every country (legacy behaviour). Reading is
        // safe even before the migration runs - Postgres returns undefined
        // for missing columns and we fall through to null.
        searchTermsByCountry: r.search_terms_by_country || null,
        // Per-CITY search-term overrides. Null when the ICP has no outlier
        // city overrides. Shape: { "Berlin": ["Gartencenter"], ... }. Read is
        // safe before migration 0003 - column-missing returns undefined.
        cityTerms: r.city_terms || null,
        coverage: r.coverage || {}, targetDescription: r.target_description || '',
        customerTypes: r.customer_types || [], excludeTypes: r.exclude_types || [],
        excludeCompanies: r.exclude_companies || [], extraNotes: r.extra_notes || '',
        classifyPrompt: r.classify_prompt || '', useCustomPrompt: !!r.use_custom_prompt,
        reportEnabled: !!r.report_enabled, reportTemplate: r.report_template || '',
    };
}
function icpObjToRow(i) {
    const row = {
        id: i.id, name: i.name, vertical: i.vertical || '', portfolio_company: i.portfolioCompany || '',
        countries: i.countries || [], search_terms: i.searchTerms || [], cities: i.cities || [],
        coverage: i.coverage || {}, target_description: i.targetDescription || '',
        customer_types: i.customerTypes || [], exclude_types: i.excludeTypes || [],
        exclude_companies: i.excludeCompanies || [], extra_notes: i.extraNotes || '',
        classify_prompt: i.classifyPrompt || '', use_custom_prompt: !!i.useCustomPrompt,
        report_enabled: !!i.reportEnabled, report_template: i.reportTemplate || '',
        updated_at: new Date().toISOString(),
    };
    // Only include search_terms_by_country in the write payload when the ICP
    // actually has overrides set. Lets the deploy work BEFORE the operator
    // runs migration 0002 - any ICP that never touches the new field still
    // saves cleanly; ICPs that DO try to set it fail loudly so the migration
    // requirement is impossible to miss.
    if (i.searchTermsByCountry && typeof i.searchTermsByCountry === 'object' && Object.keys(i.searchTermsByCountry).length > 0) {
        row.search_terms_by_country = i.searchTermsByCountry;
    }
    // Same conditional pattern as searchTermsByCountry: only write city_terms
    // when set, so a deploy before migration 0003 still saves ICPs that don't
    // use city overrides.
    if (i.cityTerms && typeof i.cityTerms === 'object' && Object.keys(i.cityTerms).length > 0) {
        row.city_terms = i.cityTerms;
    }
    return row;
}
let icpsCache = null;
async function hydrateFromSupabase() {
    try {
        // Deterministic order (created_at, then id). Supabase has no inherent
        // row order, so without this the ICP list - and the default ICP that
        // Coverage / My Accounts pick (the first one) - would shuffle.
        const { data, error } = await getClient().from('icps').select('*')
            .order('created_at', { ascending: true })
            .order('id', { ascending: true });
        if (error || !data) return;
        icpsCache = data.map(icpRowToObj);
    } catch (e) {
        console.warn('[icps] supabase hydrate failed (using JSON seed):', e.message);
    }
}

// Default coverage when an ICP doesn't specify one. Urban + Airports is
// the right starting point for travel-adjacent verticals (rentals, hotels);
// other verticals will want to flip the tier toggles in the ICP form.
const DEFAULT_COVERAGE = {
    urban: true,         // pop ≥ 50k
    suburban: false,     // pop 5k–50k
    rural: false,        // pop 1k–5k + sparse hex backstop
    airports: true,      // airport anchor cells
};

// Starter markdown report template, pre-filled in the ICP editor when the
// operator enables reports. Entirely editable - sections can be renamed,
// added, or removed. GPT follows whatever the operator leaves here, exactly
// like valsource's fixed REPORT_TEMPLATE but per-ICP and user-owned.
const DEFAULT_REPORT_TEMPLATE = `## Overview
A 2-3 sentence summary of what this business does.

## Products & Services
What they sell or offer, and any specialties or niche focus.

## Size & Scale
Indicators of size - number of locations, staff, years in business, anything the site reveals.

## Fit for this ICP
Why this company is a strong fit for our product, grounded in what the website actually shows.

## Notable Signals
Anything else worth flagging - recent news, expansion, ownership, technology hints, partnerships.`;

const DEFAULT_ICPS = [
    {
        id: 'bluebird',
        name: 'Bluebird Auto Rental',
        vertical: 'Car Rental',
        portfolioCompany: 'Bluebird Auto Rental Systems',
        searchTerms: ['car rental', 'vehicle hire', 'auto rental'],
        cities: ['London'],
        coverage: { urban: true, suburban: false, rural: false, airports: true },
        // Structured criteria - drive composeClassifyPrompt(). The classifyPrompt
        // field below is what the GPT classifier actually sees, but it gets
        // re-composed from these on every save so the structured fields stay
        // canonical. Editing the structured fields in the UI updates the
        // prompt; users only touch the raw prompt for advanced overrides.
        targetDescription: 'an independent car rental or vehicle-hire business serving end customers (consumers or small businesses)',
        customerTypes: ['consumers', 'small businesses'],
        excludeTypes: ['national chains', 'peer-to-peer marketplaces', 'listing or comparison sites'],
        excludeCompanies: ['Hertz', 'Enterprise', 'Avis', 'Budget', 'Sixt', 'Turo', 'Getaround'],
        extraNotes: '',
        classifyPrompt: 'Is this an independent car rental or vehicle-hire business serving consumers and small businesses? Skip national chains, peer-to-peer marketplaces, and listing or comparison sites, and specific companies like Hertz, Enterprise, Avis, Budget, Sixt, Turo, and Getaround. Reply with JSON: {"is_match": true|false, "reason": "<one sentence>"}.',
    },
    {
        // Thermeon - same vertical + country as Bluebird, slightly different
        // ICP angle. Thermeon's CARS+ product targets larger-fleet operators
        // and serves an international customer base (40+ years, 50 countries),
        // so the criteria favor mid-market rental companies (10+ vehicles)
        // over the smallest indies Bluebird also pursues. Sharing the vertical
        // with Bluebird means both ICPs reuse the same scrape cache + search-
        // term log - adding Thermeon costs nearly $0 in extra API credits.
        id: 'thermeon',
        name: 'Thermeon',
        vertical: 'Car Rental',
        portfolioCompany: 'Thermeon',
        searchTerms: ['car rental', 'vehicle hire', 'fleet rental'],
        cities: ['London', 'Manchester', 'Birmingham', 'Edinburgh'],
        coverage: { urban: true, suburban: false, rural: false, airports: true },
        targetDescription: 'an established mid-market car rental or vehicle-hire business with a fleet of 10+ vehicles, ideally with multi-location operations',
        customerTypes: ['business travelers', 'corporate accounts', 'leisure travelers'],
        excludeTypes: ['national chains', 'peer-to-peer marketplaces', 'listing or comparison sites', 'single-vehicle / hobbyist operators'],
        excludeCompanies: ['Hertz', 'Enterprise', 'Avis', 'Budget', 'Sixt', 'Europcar', 'Turo', 'Getaround'],
        extraNotes: 'Prefer operators that have been in business 5+ years and serve corporate/business travel customers, not just leisure self-drive. Multi-branch operations are a plus.',
        classifyPrompt: '',  // composed on save
    },
    // ─── NedFox - three niche sub-ICPs ──────────────────────────────────
    // NedFox sells RetailVista (their ERP+POS suite) into multiple specialty
    // retail niches. Per the financial model: Garden Centres are 77 % of
    // ARR, Thrift Stores 9 %, Camping/Outdoor 6 %, with smaller tails into
    // Personal Care + Bathroom. Rather than one broad "Retail POS" ICP that
    // searches with a vague set of terms, we split into three focused sub-
    // ICPs - each with its own niche-tuned search terms (Dutch + English),
    // tighter exclude lists, and dedicated scrape cache. All three share
    // portfolioCompany="NedFox" so filtering by that name pulls the
    // combined customer pool across niches.
    //
    // Why split: each niche has different Maps query terms (tuincentrum vs
    // kringloopwinkel), different exclude lists (chain garden centres vs
    // chain thrift stores), and different prompt nuances. Lumping them
    // diluted the candidate pool and confused the classifier. Splitting
    // costs a bit more in compute (3 ICPs sweep + classify) but gives much
    // better results - and the auto-fanout means companies discovered
    // under one niche still get classified under the others, so coverage
    // is shared without duplication.
    {
        id: 'nedfox-garden',
        name: 'NedFox - Garden Centres',
        vertical: 'Garden Centre',
        portfolioCompany: 'NedFox',
        searchTerms: [
            // Dutch - primary market (~90% of NedFox's customers are NL)
            'tuincentrum', 'tuincentrum kassa', 'tuincentrum software', 'plantenwinkel',
            // English - UK + IE secondary
            'garden centre', 'garden centre POS', 'plant nursery',
        ],
        cities: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'Emmeloord', 'London'],
        coverage: { urban: true, suburban: true, rural: false, airports: false },
        targetDescription: 'an independent garden centre or plant nursery - a brick-and-mortar retailer selling plants, gardening supplies, and outdoor living products',
        customerTypes: ['family-owned garden centres', 'independent plant nurseries', 'small specialty horticulture chains'],
        excludeTypes: [
            'mass-market chains and big-box DIY stores that happen to sell plants',
            'pure e-commerce with no physical store',
            'wholesale-only growers without a retail operation',
            'listing or comparison sites',
        ],
        excludeCompanies: ['Intratuin', 'Tuincentrum.nl', 'Welkoop', 'GAMMA', 'B&Q', 'Homebase', 'Wickes', 'Dobbies'],
        extraNotes: 'Independent and family-owned are the priority. Multi-location operations are fine if they look independent (not a national chain). Dutch-language sites are expected - judge by the business model, not the language.',
        classifyPrompt: '',
    },
    {
        id: 'nedfox-thrift',
        name: 'NedFox - Thrift Stores',
        vertical: 'Thrift Store',
        portfolioCompany: 'NedFox',
        searchTerms: [
            // Dutch (kringloopwinkel = thrift / second-hand store, very NL-specific)
            'kringloopwinkel', 'kringloopcentrum', 'tweedehands winkel',
            // English (UK charity shops - same model, different name)
            'thrift store', 'charity shop', 'second-hand store',
        ],
        cities: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'London'],
        coverage: { urban: true, suburban: true, rural: false, airports: false },
        targetDescription: 'an independent thrift store, second-hand store, or charity shop selling donated goods to the public',
        customerTypes: ['independent charity shops', 'small thrift store chains', 'community-run kringloopwinkels'],
        excludeTypes: [
            'antique dealers (different POS needs)',
            'consignment-only operations',
            'pure e-commerce',
            'auction houses',
        ],
        excludeCompanies: ['Oxfam', 'British Red Cross', 'Cancer Research UK', 'Salvation Army'],
        extraNotes: 'Independent and small chains preferred. Charity shops in the UK and kringloopwinkels in NL are the same model with different naming.',
        classifyPrompt: '',
    },
    {
        id: 'nedfox-camping',
        name: 'NedFox - Camping & Outdoor',
        vertical: 'Camping & Outdoor',
        portfolioCompany: 'NedFox',
        searchTerms: [
            // Dutch
            'kampeerwinkel', 'kampeerzaak', 'outdoor winkel',
            // English
            'camping store', 'outdoor store', 'camping shop',
        ],
        cities: ['Amsterdam', 'Rotterdam', 'Utrecht', 'Eindhoven', 'London'],
        coverage: { urban: true, suburban: true, rural: false, airports: false },
        targetDescription: 'an independent camping, outdoor, or adventure-sports retailer selling tents, hiking gear, camping equipment, and related outdoor goods',
        customerTypes: ['independent camping retailers', 'small outdoor specialty chains', 'family-owned outdoor stores'],
        excludeTypes: [
            'big-box outdoor chains',
            'department stores with an outdoor section',
            'pure e-commerce',
            'sports general retailers (broader than camping)',
        ],
        excludeCompanies: ['Decathlon', 'Bever', 'Cotswold Outdoor', 'Snow + Rock', 'GO Outdoors', 'Blacks'],
        extraNotes: 'Independent specialists. Volume per customer in this niche is high (3 customers = 6% of NedFox ARR), so quality of fit matters more than quantity of leads.',
        classifyPrompt: '',
    },
];

// Compose the raw classifier prompt from the structured fields above. Called
// on save (createIcp/updateIcp) so the persisted classifyPrompt is always in
// sync with the structured criteria. The sweep pipeline reads classifyPrompt
// directly - it doesn't care that the prompt was assembled from parts.
//
// Returns null if no structured fields are populated, so callers can fall
// back to whatever raw classifyPrompt the user typed (advanced override path).
function composeClassifyPrompt({ targetDescription, customerTypes, excludeTypes, excludeCompanies, extraNotes }) {
    const target = (targetDescription || '').trim();
    const cust = (customerTypes || []).map(s => String(s).trim()).filter(Boolean);
    const exTypes = (excludeTypes || []).map(s => String(s).trim()).filter(Boolean);
    const exCos = (excludeCompanies || []).map(s => String(s).trim()).filter(Boolean);
    const notes = (extraNotes || '').trim();

    // No structured input → nothing to compose. Caller keeps the raw prompt.
    if (!target && cust.length === 0 && exTypes.length === 0 && exCos.length === 0 && !notes) {
        return null;
    }

    const parts = [];
    // Lead with the positive question - most important signal for the LLM.
    if (target) {
        const customerSuffix = cust.length ? ` serving ${joinList(cust)}` : '';
        parts.push(`Is this ${target}${customerSuffix}?`);
    } else if (cust.length) {
        parts.push(`Is this a business serving ${joinList(cust)}?`);
    }

    // Exclusions: combine type-level and company-level into a single SKIP
    // line so the LLM sees them together. Type-level first since they
    // generalize; specific companies act as concrete examples.
    const skipBits = [];
    if (exTypes.length) skipBits.push(joinList(exTypes));
    if (exCos.length) skipBits.push(`specific companies like ${joinList(exCos)}`);
    if (skipBits.length) parts.push(`Skip ${skipBits.join(', and ')}.`);

    // Free-text extra notes ride after the structured rules - captures the
    // qualitative judgment that picklists can't (e.g. "founder-led, prefer
    // 10+ years in business, avoid recently-PE-backed").
    if (notes) parts.push(notes);

    // Output format is invariant - sweep-pipeline parses {is_match, reason}
    // so we hard-code it rather than letting users break the parser.
    parts.push('Reply with JSON: {"is_match": true|false, "reason": "<one sentence>"}.');

    return parts.join(' ');
}

// "a, b, c" → "a, b, and c". Small helper so the composed prompt reads
// naturally instead of comma-separated robot speak.
function joinList(arr) {
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
    return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify(DEFAULT_ICPS, null, 2));
    }
}

function readJsonSync() {
    ensureFile();
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_ICPS;
    } catch {
        return DEFAULT_ICPS;
    }
}

// Cache-backed read. Seeds synchronously from JSON on first call (so the sync
// getters work from frame 0); the Supabase hydrate then overwrites the cache.
function readAll() {
    if (icpsCache) return icpsCache;
    icpsCache = readJsonSync();
    return icpsCache;
}

function writeAll(icps) {
    icpsCache = icps;
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(icps, null, 2));
}

// Kick off the one-time Supabase hydrate (overwrites the JSON-seeded cache).
if (isEnabled()) hydrateFromSupabase();

function getIcp(id) {
    return readAll().find(i => i.id === id) || null;
}

function listIcps() {
    return readAll().map(i => ({
        id: i.id,
        name: i.name,
        vertical: i.vertical,
        // Include portfolioCompany + countries on the trimmed listing too -
        // both are needed by the Coverage page's workspace/portfolio filter
        // and by the country dropdown narrowing. Without portfolioCompany
        // here, picking a workspace would empty the ICP picker because the
        // filter sees `undefined` on every ICP and rejects them all.
        portfolioCompany: i.portfolioCompany || '',
        countries: i.countries || [],
        cities: i.cities,
    }));
}

// Returns the full ICP record (including searchTerms + classifyPrompt) so
// the management UI can populate an edit form. listIcps() trims those
// fields out for the picker dropdowns where they'd be noise.
function getIcpFull(id) {
    return getIcp(id);
}

function listIcpsFull() {
    return readAll();
}

// Distinct portfolioCompany strings present across all ICPs, alphabetized.
// Powers the Portfolio Company filter dropdown on Coverage / Database / ICP
// pages. Empty strings are excluded - an ICP without a portfolioCompany
// won't show up as an option.
function listPortfolioCompanies() {
    const set = new Set();
    for (const i of readAll()) {
        if (i.portfolioCompany) set.add(i.portfolioCompany);
    }
    return Array.from(set).sort();
}

// Validate + normalize an ICP payload from the UI. Throws on missing
// required fields or duplicate id (when creating).
function validateIcp(data, { existingId = null } = {}) {
    if (!data) throw new Error('payload required');
    const id = String(data.id || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id) throw new Error('id required (lowercase letters, digits, hyphens)');
    if (!data.name || !String(data.name).trim()) throw new Error('name required');
    const cities = Array.isArray(data.cities)
        ? data.cities.map(c => String(c).trim()).filter(Boolean)
        : [];
    const searchTerms = Array.isArray(data.searchTerms)
        ? data.searchTerms.map(t => String(t).trim()).filter(Boolean)
        : [];
    if (searchTerms.length === 0) throw new Error('at least one searchTerm required');

    // Per-country search-term overrides. Optional. Shape:
    //   { "NL": ["tuincentrum", "kwekerij"], "UK": ["garden centre"] }
    // When a cell is swept and its country has an entry here, the sweep uses
    // those terms instead of the flat searchTerms list above. Lets a single
    // multi-country ICP run language-appropriate queries per market and not
    // waste Scrapingdog credits on irrelevant cross-language searches. Null
    // when not set - the sweep falls back to the flat list.
    let searchTermsByCountry = null;
    if (data.searchTermsByCountry && typeof data.searchTermsByCountry === 'object' && !Array.isArray(data.searchTermsByCountry)) {
        const out = {};
        for (const [code, terms] of Object.entries(data.searchTermsByCountry)) {
            const cc = String(code || '').trim().toUpperCase();
            if (!cc) continue;
            const list = Array.isArray(terms)
                ? terms.map(t => String(t).trim()).filter(Boolean)
                : [];
            if (list.length > 0) out[cc] = list;
        }
        if (Object.keys(out).length > 0) searchTermsByCountry = out;
    }

    // Per-CITY search-term overrides. Optional. Shape:
    //   { "Berlin": ["Gartencenter", "Pflanzenmarkt"] }
    // Keys are city names. Case-preserved on save; matched case-insensitively
    // at sweep time against cell.parentCity. The outlier-city UX writes here
    // when the user picks "Berlin-only terms" instead of ticking the whole
    // country - lets one stray city run language-correct queries without
    // expanding the country-fill scope to all of Germany.
    let cityTerms = null;
    if (data.cityTerms && typeof data.cityTerms === 'object' && !Array.isArray(data.cityTerms)) {
        const out = {};
        for (const [city, terms] of Object.entries(data.cityTerms)) {
            const name = String(city || '').trim();
            if (!name) continue;
            const list = Array.isArray(terms)
                ? terms.map(t => String(t).trim()).filter(Boolean)
                : [];
            if (list.length > 0) out[name] = list;
        }
        if (Object.keys(out).length > 0) cityTerms = out;
    }
    // Coverage tier toggles. Boolean coercion + safe defaults so a malformed
    // payload (missing the coverage block, or one with extra keys) still
    // produces a usable ICP. At least one tier OR airports must be true,
    // otherwise the country fill would have nothing to seed.
    const c = (data.coverage && typeof data.coverage === 'object') ? data.coverage : {};
    const coverage = {
        urban:    !!c.urban,
        suburban: !!c.suburban,
        rural:    !!c.rural,
        airports: !!c.airports,
    };
    if (!coverage.urban && !coverage.suburban && !coverage.rural && !coverage.airports) {
        // Pick a sensible default rather than refusing to save - the ICP
        // form has its own UX for warning the user, no need to hard-error.
        coverage.urban = true;
    }

    // Portfolio company - which Valsoft portfolio company this ICP is
    // targeting prospects for. Optional, free-text. Multiple ICPs can share
    // a portfolioCompany (e.g. NedFox sells into Garden Centres + Thrift
    // Stores + Camping retailers via three different niche-tuned ICPs that
    // all answer to the same portfolio company). Independent of `vertical`:
    // an ICP has one of each, and the two are orthogonal filter dimensions.
    const portfolioCompany = String(data.portfolioCompany || '').trim();

    // Countries the ICP operates in (ISO-like codes: 'UK', 'NL', 'IE', etc.
    // - internal country codes, must match keys in countries.js). Multi-
    // value because a single ICP can span multiple markets (NedFox-Garden
    // sells into NL + UK + IE + BE). Used as a filter dimension on Coverage
    // and Database - independent of `cities`, which lists specific city
    // names; `countries` summarizes geographic scope without enumerating
    // every city. Auto-derivable from cities (each city knows its country)
    // but storing it explicitly lets users target a country without seeding
    // every city in it first.
    const countries = Array.isArray(data.countries)
        ? Array.from(new Set(data.countries.map((c) => String(c).trim().toUpperCase()).filter(Boolean)))
        : [];

    // Structured classifier criteria. Empty arrays/strings are fine - they
    // just don't contribute to the composed prompt. Trim and normalize so
    // payloads from the UI (which may have trailing-empty array entries from
    // the "add another" UX) round-trip cleanly.
    const targetDescription = String(data.targetDescription || '').trim();
    const customerTypes = Array.isArray(data.customerTypes)
        ? data.customerTypes.map(s => String(s).trim()).filter(Boolean)
        : [];
    const excludeTypes = Array.isArray(data.excludeTypes)
        ? data.excludeTypes.map(s => String(s).trim()).filter(Boolean)
        : [];
    const excludeCompanies = Array.isArray(data.excludeCompanies)
        ? data.excludeCompanies.map(s => String(s).trim()).filter(Boolean)
        : [];
    const extraNotes = String(data.extraNotes || '').trim();

    // Three prompt-resolution paths:
    //   1. useCustomPrompt: true → take classifyPrompt verbatim. The
    //      structured fields are still persisted (so toggling back is
    //      lossless) but they don't contribute to what the classifier
    //      sees. This is the "I'll write the prompt myself" path.
    //   2. structured fields set → compose from them; the composed string
    //      becomes classifyPrompt. Edits to the structured fields are
    //      canonical, the raw textarea is read-only.
    //   3. nothing structured AND useCustomPrompt not set → honour the
    //      raw classifyPrompt as a fallback (covers legacy ICPs that
    //      pre-date the structured-criteria schema).
    const useCustomPrompt = !!data.useCustomPrompt;
    const rawPrompt = String(data.classifyPrompt || '').trim();
    let classifyPrompt;
    if (useCustomPrompt) {
        classifyPrompt = rawPrompt;
    } else {
        const composed = composeClassifyPrompt({ targetDescription, customerTypes, excludeTypes, excludeCompanies, extraNotes });
        classifyPrompt = composed || rawPrompt;
    }

    // Markdown report toggle + template. When reportEnabled, the sweep
    // generates a per-company markdown report following reportTemplate
    // (for matches) or a short why-rejected note (for non-matches). The
    // template is the operator's own markdown - we only seed a default
    // when they first turn it on (handled in the UI). Empty template +
    // enabled falls back to the default at generation time.
    const reportEnabled = !!data.reportEnabled;
    const reportTemplate = String(data.reportTemplate || '').trim();

    return {
        id,
        name: String(data.name).trim(),
        vertical: String(data.vertical || '').trim(),
        portfolioCompany,
        countries,
        searchTerms,
        searchTermsByCountry,
        cityTerms,
        cities,
        coverage,
        targetDescription,
        customerTypes,
        excludeTypes,
        excludeCompanies,
        extraNotes,
        classifyPrompt,
        useCustomPrompt,
        reportEnabled,
        reportTemplate,
        existingId,
    };
}

async function createIcp(data) {
    const v = validateIcp(data);
    const all = readAll();
    if (all.find(i => i.id === v.id)) throw new Error(`ICP "${v.id}" already exists`);
    const icp = {
        id: v.id,
        name: v.name,
        vertical: v.vertical,
        portfolioCompany: v.portfolioCompany,
        countries: v.countries,
        searchTerms: v.searchTerms,
        searchTermsByCountry: v.searchTermsByCountry,
        cityTerms: v.cityTerms,
        cities: v.cities,
        coverage: v.coverage,
        targetDescription: v.targetDescription,
        customerTypes: v.customerTypes,
        excludeTypes: v.excludeTypes,
        excludeCompanies: v.excludeCompanies,
        extraNotes: v.extraNotes,
        classifyPrompt: v.classifyPrompt,
        useCustomPrompt: v.useCustomPrompt,
        reportEnabled: v.reportEnabled,
        reportTemplate: v.reportTemplate,
    };
    if (isEnabled()) {
        const { error } = await getClient().from('icps').insert(icpObjToRow(icp));
        if (error) throw new Error(`createIcp: ${error.message}`);
        icpsCache = [...all, icp];
    } else {
        all.push(icp);
        writeAll(all);
    }
    return icp;
}

async function updateIcp(id, data) {
    const all = readAll();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) return null;
    // Normalize but preserve the original id (renaming would orphan grid
    // cells that reference it; that's a separate operation).
    const v = validateIcp({ ...data, id }, { existingId: id });
    const icp = {
        id: id,
        name: v.name,
        vertical: v.vertical,
        portfolioCompany: v.portfolioCompany,
        countries: v.countries,
        searchTerms: v.searchTerms,
        searchTermsByCountry: v.searchTermsByCountry,
        cityTerms: v.cityTerms,
        cities: v.cities,
        coverage: v.coverage,
        targetDescription: v.targetDescription,
        customerTypes: v.customerTypes,
        excludeTypes: v.excludeTypes,
        excludeCompanies: v.excludeCompanies,
        extraNotes: v.extraNotes,
        classifyPrompt: v.classifyPrompt,
        useCustomPrompt: v.useCustomPrompt,
        reportEnabled: v.reportEnabled,
        reportTemplate: v.reportTemplate,
    };
    if (isEnabled()) {
        const { error } = await getClient().from('icps').update(icpObjToRow(icp)).eq('id', id);
        if (error) throw new Error(`updateIcp: ${error.message}`);
        const next = [...all]; next[idx] = icp; icpsCache = next;
    } else {
        all[idx] = icp;
        writeAll(all);
    }
    return icp;
}

async function deleteIcp(id) {
    const all = readAll();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) return false;
    if (isEnabled()) {
        // FK cascade also drops this ICP's grid_cells / classifications /
        // reviews (search_log.icp_id is set null). That's cleaner than the
        // JSON path, which left those rows orphaned.
        const { error } = await getClient().from('icps').delete().eq('id', id);
        if (error) throw new Error(`deleteIcp: ${error.message}`);
        icpsCache = all.filter(i => i.id !== id);
    } else {
        all.splice(idx, 1);
        writeAll(all);
    }
    return true;
}

// Pick the search-term list for a sweep cell. Single source of truth for the
// precedence rules - the live sweep and the demo sweep both call this so the
// behaviour can't drift between paths. Returns:
//   { terms: string[], source: string, skip?: boolean }
//
// Precedence:
//   1. cityTerms[cell.parentCity]                     - per-city override wins
//   2. searchTermsByCountry[cell.country]             - per-country bucket
//      (only when cell.country is in icp.countries; otherwise it's an outlier
//      and we don't want to silently use these)
//   3. flat searchTerms                                - generic fallback
//      (only when cell.country is in icp.countries OR no countries are set)
//   4. skip                                            - outlier cell with no
//      city override AND its country isn't ticked. UI grays it; this honours
//      the gray-out by NOT calling Scrapingdog (which would burn credits on
//      wrong-language terms).
//
// Why this lives here and not in sweep-pipeline.js: keeps the sweep file
// focused on orchestration; lets the audit script + AI prompts reason about
// "what terms would this cell run" without duplicating the rules.
function pickTermsForCell(icp, cell) {
    const country = String(cell.country || '').toUpperCase();
    const parentCity = String(cell.parentCity || '').trim();
    const activeCountries = (icp.countries || []).map((c) => String(c).toUpperCase()).filter(Boolean);

    // 1. City-level override - most specific, applies regardless of country
    // tick state. This is what the "Berlin-only terms" UX writes when the
    // user wants a single outlier city without expanding country scope.
    if (parentCity && icp.cityTerms && typeof icp.cityTerms === 'object') {
        // Case-insensitive lookup so "berlin" written in cityTerms still
        // matches cell.parentCity="Berlin" (Scrapingdog can return either).
        const key = Object.keys(icp.cityTerms).find((k) => String(k).toLowerCase() === parentCity.toLowerCase());
        if (key) {
            const list = (icp.cityTerms[key] || []).filter(Boolean);
            if (list.length > 0) return { terms: list, source: `cityTerms[${key}]` };
        }
    }

    // 2. Outlier guard - if the cell's country isn't ticked AND we have no
    // city override AND the ICP actually declares its countries, skip. An
    // ICP with NO countries declared (legacy) keeps the old behaviour and
    // falls through to the flat list.
    if (country && activeCountries.length > 0 && !activeCountries.includes(country)) {
        return { terms: [], source: 'skip:outlier', skip: true };
    }

    // 3. Per-country list, only reachable when the country is ticked (or no
    // countries are declared on the ICP).
    if (country && icp.searchTermsByCountry && typeof icp.searchTermsByCountry === 'object') {
        const list = (icp.searchTermsByCountry[country] || []).filter(Boolean);
        if (list.length > 0) return { terms: list, source: `searchTermsByCountry[${country}]` };
    }

    // 4. Flat fallback.
    const flat = (icp.searchTerms || []).filter(Boolean);
    if (flat.length > 0) return { terms: flat, source: 'searchTerms' };

    // 5. Last resort - legacy ICPs with neither flat nor per-country terms
    // (shouldn't happen post-validate, but kept defensive).
    return { terms: [icp.vertical || 'business'], source: 'vertical' };
}

// Stable hash of the ICP's *classifier-defining* state. Two ICPs that would
// produce identical verdicts on identical input share this hash; two that
// wouldn't, don't.
//
// The hash is stamped on each company's classification entry at write time
// (api/routes/companies.js#setClassificationForIcp -> definition_hash column,
// added in migration 0005). When the user opens the Reclassify tab, the
// targets endpoint compares each stored hash against the ICP's *current*
// hash and flags mismatches as `definitionStale: true`. This is the
// authoritative "are these verdicts up to date" signal - survives editor
// close/reopen, page reloads, session changes, multi-user editing.
//
// What we hash:
//   - `classifyPrompt` is the actual string fed to GPT, regardless of
//     whether it came from useCustomPrompt=true (raw textarea) or from
//     composeClassifyPrompt() (structured fields). Hashing it captures
//     EVERY definition-side change in one shot - structured edits, raw-
//     prompt edits, even mode toggles between the two.
//   - We deliberately exclude: name, id, vertical, portfolioCompany,
//     countries, cities, coverage, searchTerms/searchTermsByCountry/
//     cityTerms. None of those change the classifier verdict - they change
//     WHICH companies get scraped or HOW the sweep is targeted, not how
//     the LLM judges what it sees.
//
// SHA-256 hex, first 16 chars. Collision probability negligible at our
// scale (we have ~thousands of ICPs ever, not billions).
const crypto = require('crypto');
function computeIcpDefinitionHash(icp) {
    const prompt = String(icp?.classifyPrompt || '').trim();
    if (!prompt) return null;  // no prompt = no classifier = no hash
    return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}

module.exports = {
    getIcp,
    listIcps,
    getIcpFull,
    listIcpsFull,
    listPortfolioCompanies,
    createIcp,
    updateIcp,
    deleteIcp,
    composeClassifyPrompt,
    pickTermsForCell,
    computeIcpDefinitionHash,
    DEFAULT_COVERAGE,
    DEFAULT_REPORT_TEMPLATE,
};
