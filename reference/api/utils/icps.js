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

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'icps.json');

// Default coverage when an ICP doesn't specify one. Urban + Airports is
// the right starting point for travel-adjacent verticals (rentals, hotels);
// other verticals will want to flip the tier toggles in the ICP form.
const DEFAULT_COVERAGE = {
    urban: true,         // pop ≥ 50k
    suburban: false,     // pop 5k–50k
    rural: false,        // pop 1k–5k + sparse hex backstop
    airports: true,      // airport anchor cells
};

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

function readAll() {
    ensureFile();
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : DEFAULT_ICPS;
    } catch {
        return DEFAULT_ICPS;
    }
}

function writeAll(icps) {
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(icps, null, 2));
}

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

    return {
        id,
        name: String(data.name).trim(),
        vertical: String(data.vertical || '').trim(),
        portfolioCompany,
        countries,
        searchTerms,
        cities,
        coverage,
        targetDescription,
        customerTypes,
        excludeTypes,
        excludeCompanies,
        extraNotes,
        classifyPrompt,
        useCustomPrompt,
        existingId,
    };
}

function createIcp(data) {
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
        cities: v.cities,
        coverage: v.coverage,
        targetDescription: v.targetDescription,
        customerTypes: v.customerTypes,
        excludeTypes: v.excludeTypes,
        excludeCompanies: v.excludeCompanies,
        extraNotes: v.extraNotes,
        classifyPrompt: v.classifyPrompt,
        useCustomPrompt: v.useCustomPrompt,
    };
    all.push(icp);
    writeAll(all);
    return icp;
}

function updateIcp(id, data) {
    const all = readAll();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) return null;
    // Normalize but preserve the original id (renaming would orphan grid
    // cells that reference it; that's a separate operation).
    const v = validateIcp({ ...data, id }, { existingId: id });
    all[idx] = {
        id: id,
        name: v.name,
        vertical: v.vertical,
        portfolioCompany: v.portfolioCompany,
        countries: v.countries,
        searchTerms: v.searchTerms,
        cities: v.cities,
        coverage: v.coverage,
        targetDescription: v.targetDescription,
        customerTypes: v.customerTypes,
        excludeTypes: v.excludeTypes,
        excludeCompanies: v.excludeCompanies,
        extraNotes: v.extraNotes,
        classifyPrompt: v.classifyPrompt,
        useCustomPrompt: v.useCustomPrompt,
    };
    writeAll(all);
    return all[idx];
}

function deleteIcp(id) {
    const all = readAll();
    const idx = all.findIndex(i => i.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    writeAll(all);
    return true;
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
    DEFAULT_COVERAGE,
};
