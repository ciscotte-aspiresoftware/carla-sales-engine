// Operator-tunable settings store.
//
// Each group has the shape `{ useDefault: boolean, custom: {...} }`.
// `getEffective()` returns the values the rest of the code should consult:
// when useDefault is true → DEFAULTS for that group; when false → custom.
// This lets the Admin UI offer a per-group "Default vs Custom" choice and
// fall back to baked-in numbers without losing what the user typed.
//
// Persisted at api/data/settings.json. The file is auto-bootstrapped from
// DEFAULTS on first read so a fresh checkout works without any setup.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const FILE = path.resolve(__dirname, '..', 'data', 'settings.json');

// ─── DEFAULTS ─────────────────────────────────────────────────────────
// These mirror the values that lived as module-level constants in
// grid-seeder.js and firecrawl.js before we made them tunable. Touching
// these defaults is a code change; touching the "custom" overrides is a
// runtime change via the Admin UI.

const DEFAULTS = {
    cellGeneration: {
        // Tier-1 hex spacing inside a city. 12 km matches the geometry of
        // hex packing for a 7 km search radius - cells just touch at the
        // corners of each triangular tile, so every point is within 7 km
        // of at least one cell centre with minimal overlap.
        subCellSpacingKm: 12,
        // Rural backstop hex spacing (the sparse layer filling the gaps
        // between populated places when an ICP has rural coverage on).
        ruralSparseKm: 100,
        // Sparse rural cells must be at least this far from any populated
        // place - otherwise we'd be re-scanning towns we already planned
        // to hit with the populated-places pass.
        ruralAvoidPlaceKm: 75,
        // Populated places above this population get a hex sub-grid
        // instead of a single anchor cell (a single 7 km cell can't cover
        // London's businesses).
        subgridThresholdPop: 100000,
        // Per-tier zoom + advertised search radius. zoom is what we put in
        // the Scrapingdog `ll` parameter; radiusKm is the cosmetic radius
        // stored on the cell record (Scrapingdog uses the zoom, not this).
        // Tighter zoom = smaller search circle = denser coverage for the
        // same number of cells.
        zoomBySource: {
            urban:    { zoom: 12, radiusKm: 7 },
            suburban: { zoom: 11, radiusKm: 14 },
            rural:    { zoom: 11, radiusKm: 14 },
            sparse:   { zoom: 10, radiusKm: 28 },
            airport:  { zoom: 12, radiusKm: 7 },
        },
        // Population → metro radius (km) for city sub-grids. Sorted by
        // minPop descending; lookup picks the first row whose minPop is
        // ≤ the place's population. The final 0-min entry catches small
        // places.
        populationLadder: [
            { minPop: 5000000, radiusKm: 38 },
            { minPop: 1000000, radiusKm: 30 },
            { minPop: 500000,  radiusKm: 22 },
            { minPop: 200000,  radiusKm: 17 },
            { minPop: 100000,  radiusKm: 14 },
            { minPop: 0,       radiusKm: 10 },
        ],
        // Scrapingdog returns up to 20 places per search call (page 0 →
        // results 1-20, page 20 → 21-40, etc, per the docs). Default 3 →
        // up to 60 candidates per term per cell. The sweep stops paginating
        // early when a page returns < 20 results, so sparse cells only pay
        // for page 1 - the extra cost lands only on genuinely dense urban
        // cells where the deeper coverage is worth it. Capped at 6 because
        // the docs flag duplicates / irrelevant results past that.
        maxPagesPerSearch: 3,
        // Disc-conflict greedy prune. After all candidate cells are
        // generated (populated places, airports, sparse, sub-grids), we
        // walk them in importance order (population desc, then anchors)
        // and drop any whose center sits inside the search radius of a
        // previously-accepted higher-importance cell, scaled by this
        // factor:
        //   0.0  = no prune
        //   0.3  = light prune - only drop cells deep inside another's halo
        //   0.6  = balanced (default) - drops ~30-40% of cells with little
        //          coverage loss; eliminates the heavy circle overlap
        //   1.0  = aggressive - no overlap at all, may leave gaps
        // Applies on next seed. Existing cells aren't affected unless the
        // operator triggers /api/grid/prune for an ICP.
        conflictKeepFactor: 0.6,
    },
    firecrawl: {
        // 'scrape' = single-page (the landing page) - cheap, sufficient
        //            for most classification.
        // 'crawl'  = multi-page - crawls up to crawlMaxPages, concatenates
        //            their markdown, costs N× more Firecrawl credits.
        mode: 'scrape',
        crawlMaxPages: 10,
    },
    ai: {
        // Per-task { provider, model } pairs. Each task is independent so you
        // can use a cheap Haiku for the high-volume classify step while using
        // a stronger model for the once-per-day report, or mix providers.
        //
        // Providers: 'anthropic' | 'openai' | 'gemini'
        // The key for the provider must be set in the environment
        // (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY); the app
        // defaults to 'anthropic' since that's the key available at launch.
        //
        // Classify       = URL-classify, Coverage sweep classify, Reclassify.
        //                  Recommend claude-haiku-4-5 for cost ($1/Mtok vs
        //                  $5/Mtok for Opus); quality is comparable for the
        //                  binary qualified/rejected verdict.
        // Email          = Email gen, LI message, sequences.
        // Report         = Per-ICP markdown company report. Slightly stronger
        //                  default since reports are human-read.
        // ICP automation = ICP wizard (generate from description, regen
        //                  section, rewrite classify prompt, terms-for-city).
        classify:       { provider: 'anthropic', model: 'claude-haiku-4-5' },
        email:          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        report:         { provider: 'anthropic', model: 'claude-opus-4-8' },
        icpAutomation:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    },
    linkedin: {
        // How many recent posts to pull per LinkedIn profile via Apify's
        // supreme_coder/linkedin-post actor. ~$0.001 per post, so 5 posts
        // ≈ $0.005 per LI scrape. Higher = richer signal for email gen,
        // proportional Apify cost.
        postsPerProfile: 5,
    },
};

// Multi-provider catalog. Used by the admin UI to populate the Provider and
// Model dropdowns; also used to validate that a provider id is known. The
// model list per provider is a curated set of suggestions — the admin UI
// ALSO accepts free-text custom model ids, so a new release never requires
// a code change. The envKey drives the hasKey flag sent to the UI so it can
// warn when a provider's key isn't configured.
const PROVIDERS = {
    anthropic: {
        label: 'Claude (Anthropic)',
        envKey: 'ANTHROPIC_API_KEY',
        models: [
            'claude-haiku-4-5',    // Fastest, cheapest — recommended for classify
            'claude-sonnet-4-6',   // Balanced speed / quality
            'claude-opus-4-8',     // Most capable
            'claude-opus-4-7',
            'claude-opus-4-6',
            'claude-sonnet-4-5',
        ],
    },
    openai: {
        label: 'OpenAI',
        envKey: 'OPENAI_API_KEY',
        models: [
            'gpt-4o-mini',    // Proven baseline
            'gpt-4o',
            'gpt-5-mini',
            'gpt-5',
            'gpt-5-nano',
            'gpt-4.1-mini',
            'gpt-4.1',
        ],
    },
    gemini: {
        label: 'Gemini (Google)',
        envKey: 'GEMINI_API_KEY',
        models: [
            'gemini-2.5-flash',   // Fast + cheap
            'gemini-2.5-pro',     // Strongest
            'gemini-2.0-flash',
        ],
    },
};

// Back-compat: flat list of all models across all providers.
// No longer used for validation (model accepts custom ids) but kept so any
// callers of settings.allowedModels get a non-empty list.
const ALLOWED_MODELS = Object.values(PROVIDERS).flatMap((p) => p.models);

// Default file state: every group flagged useDefault: true, with `custom`
// pre-filled from DEFAULTS so the UI can show editable inputs at the
// matching numbers the moment the user flips to Custom.
function defaultState() {
    return {
        cellGeneration: { useDefault: true, custom: structuredClone(DEFAULTS.cellGeneration) },
        firecrawl:      { useDefault: true, custom: structuredClone(DEFAULTS.firecrawl) },
        ai:             { useDefault: true, custom: structuredClone(DEFAULTS.ai) },
        linkedin:       { useDefault: true, custom: structuredClone(DEFAULTS.linkedin) },
    };
}

let cache = null;

function ensureFile() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify(defaultState(), null, 2));
    }
}

function load() {
    if (cache) return cache;
    ensureFile();
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        cache = mergeWithDefaultState(raw);
    } catch {
        cache = defaultState();
    }
    return cache;
}

// Merge a possibly-incomplete on-disk state with defaultState() so missing
// groups (e.g. after a schema bump) silently get the default shape rather
// than crashing the load.
function mergeWithDefaultState(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    for (const key of Object.keys(base)) {
        if (raw[key] && typeof raw[key] === 'object') {
            base[key].useDefault = raw[key].useDefault === false ? false : true;
            if (raw[key].custom && typeof raw[key].custom === 'object') {
                base[key].custom = { ...base[key].custom, ...raw[key].custom };
            }
        }
    }
    return base;
}

function save() {
    if (isEnabled()) {
        // Write-through to app_settings (one row per group). Fire-and-forget:
        // the cache is already updated, so getters reflect the change
        // immediately; the DB write lands a moment later. Settings changes are
        // rare + manual, so eventual consistency is fine here.
        const rows = Object.keys(cache).map((key) => ({
            key,
            use_default: cache[key].useDefault !== false,
            custom: cache[key].custom || {},
            updated_at: new Date().toISOString(),
        }));
        getClient().from('app_settings').upsert(rows, { onConflict: 'key' })
            .then(({ error }) => { if (error) console.warn('[settings] supabase write failed:', error.message); })
            .catch((e) => console.warn('[settings] supabase write threw:', e.message));
        return;
    }
    ensureFile();
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

// Boot-load the authoritative settings from Supabase into the in-memory
// cache. The sync getters can't await a DB call, so the cache is seeded
// synchronously from JSON first (instant), then this overwrites it with the
// Supabase rows once they arrive. Called once at module load when enabled.
async function hydrateFromSupabase() {
    try {
        const { data, error } = await getClient().from('app_settings').select('*');
        if (error || !data) return;
        const base = defaultState();
        for (const row of data) {
            if (!base[row.key]) continue;
            base[row.key].useDefault = row.use_default !== false;
            if (row.custom && typeof row.custom === 'object') {
                base[row.key].custom = { ...base[row.key].custom, ...row.custom };
            }
        }
        cache = base;
    } catch (e) {
        console.warn('[settings] supabase hydrate failed (using JSON seed):', e.message);
    }
}
if (isEnabled()) hydrateFromSupabase();

// ─── Public API ───────────────────────────────────────────────────────

// Full effective settings - the values code should consult. Each group is
// either the DEFAULTS for that group (useDefault: true) or the user's
// custom values.
function getEffective() {
    const state = load();
    return {
        cellGeneration: state.cellGeneration.useDefault
            ? structuredClone(DEFAULTS.cellGeneration)
            : structuredClone(state.cellGeneration.custom),
        firecrawl: state.firecrawl.useDefault
            ? structuredClone(DEFAULTS.firecrawl)
            : structuredClone(state.firecrawl.custom),
        ai: state.ai.useDefault
            ? structuredClone(DEFAULTS.ai)
            : structuredClone(state.ai.custom),
        linkedin: state.linkedin.useDefault
            ? structuredClone(DEFAULTS.linkedin)
            : structuredClone(state.linkedin.custom),
    };
}

function getCellGeneration() {
    return getEffective().cellGeneration;
}

function getFirecrawl() {
    return getEffective().firecrawl;
}

function getAi() {
    return getEffective().ai;
}

function getLinkedin() {
    return getEffective().linkedin;
}

// Full payload for the Admin UI - the raw state, the defaults, and the
// effective values. UI can show "currently effective" + "what default
// would be" side by side.
function getState() {
    // Build the catalog with a runtime hasKey flag per provider so the UI
    // can warn when a key isn't configured without exposing the key value.
    const aiCatalog = {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
        aiCatalog[id] = {
            label: p.label,
            models: p.models,
            hasKey: !!process.env[p.envKey],
        };
    }
    return {
        state: load(),
        defaults: structuredClone(DEFAULTS),
        effective: getEffective(),
        aiCatalog,
        allowedModels: [...ALLOWED_MODELS], // back-compat
    };
}

// Replace settings with the user-submitted payload. Validates each group;
// throws on bad shapes. Missing groups in the payload are left untouched
// (so a UI that only edits one card doesn't accidentally reset another).
function setSettings(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('settings payload must be an object');
    }
    const next = structuredClone(load());

    if (payload.cellGeneration) {
        next.cellGeneration = validateCellGenerationGroup(payload.cellGeneration);
    }
    if (payload.firecrawl) {
        next.firecrawl = validateFirecrawlGroup(payload.firecrawl);
    }
    if (payload.ai) {
        next.ai = validateAiGroup(payload.ai);
    }
    if (payload.linkedin) {
        next.linkedin = validateLinkedinGroup(payload.linkedin);
    }

    cache = next;
    save();
    return getState();
}

function validateCellGenerationGroup(g) {
    const useDefault = g.useDefault !== false;
    if (useDefault) {
        // Don't bother re-validating the custom block when the user is on
        // Default - we keep the existing custom values around so they can
        // toggle back without losing prior work.
        return {
            useDefault: true,
            custom: structuredClone(load().cellGeneration.custom),
        };
    }
    const c = g.custom || {};
    const out = { useDefault: false, custom: { ...DEFAULTS.cellGeneration } };
    out.custom.subCellSpacingKm    = positiveNum(c.subCellSpacingKm,    DEFAULTS.cellGeneration.subCellSpacingKm);
    out.custom.ruralSparseKm       = positiveNum(c.ruralSparseKm,       DEFAULTS.cellGeneration.ruralSparseKm);
    out.custom.ruralAvoidPlaceKm   = nonNegNum(c.ruralAvoidPlaceKm,     DEFAULTS.cellGeneration.ruralAvoidPlaceKm);
    out.custom.subgridThresholdPop = nonNegNum(c.subgridThresholdPop,   DEFAULTS.cellGeneration.subgridThresholdPop);
    out.custom.maxPagesPerSearch   = clampInt(c.maxPagesPerSearch, 1, 6, DEFAULTS.cellGeneration.maxPagesPerSearch);
    out.custom.conflictKeepFactor  = clampFloat(c.conflictKeepFactor, 0, 1, DEFAULTS.cellGeneration.conflictKeepFactor);

    const zbs = c.zoomBySource && typeof c.zoomBySource === 'object' ? c.zoomBySource : {};
    out.custom.zoomBySource = { ...DEFAULTS.cellGeneration.zoomBySource };
    for (const tier of Object.keys(out.custom.zoomBySource)) {
        const entry = zbs[tier];
        if (entry && typeof entry === 'object') {
            out.custom.zoomBySource[tier] = {
                zoom: clampInt(entry.zoom, 8, 15, DEFAULTS.cellGeneration.zoomBySource[tier].zoom),
                radiusKm: positiveNum(entry.radiusKm, DEFAULTS.cellGeneration.zoomBySource[tier].radiusKm),
            };
        }
    }

    if (Array.isArray(c.populationLadder)) {
        const cleaned = c.populationLadder
            .map((row) => ({
                minPop: nonNegNum(row?.minPop, 0),
                radiusKm: positiveNum(row?.radiusKm, 10),
            }))
            .sort((a, b) => b.minPop - a.minPop);
        if (cleaned.length > 0) out.custom.populationLadder = cleaned;
    }

    return out;
}

function validateFirecrawlGroup(g) {
    const useDefault = g.useDefault !== false;
    if (useDefault) {
        return {
            useDefault: true,
            custom: structuredClone(load().firecrawl.custom),
        };
    }
    const c = g.custom || {};
    const out = { useDefault: false, custom: { ...DEFAULTS.firecrawl } };
    const mode = c.mode === 'crawl' ? 'crawl' : 'scrape';
    out.custom.mode = mode;
    out.custom.crawlMaxPages = clampInt(c.crawlMaxPages, 1, 250, DEFAULTS.firecrawl.crawlMaxPages);
    return out;
}

// Migrate a legacy flat ai custom block (old shape: { classifyModel: 'gpt-4o-mini', ... })
// to the new per-task {provider, model} shape. Infers provider from the model id.
function migrateAiCustom(c) {
    function inferProvider(model) {
        const m = String(model || '').toLowerCase();
        if (m.startsWith('claude')) return 'anthropic';
        if (m.startsWith('gemini')) return 'gemini';
        return 'openai';
    }
    function taskEntry(modelKey, def) {
        if (c[modelKey] && typeof c[modelKey] === 'string') {
            const model = c[modelKey];
            return { provider: inferProvider(model), model };
        }
        return def;
    }
    return {
        classify:      taskEntry('classifyModel',      DEFAULTS.ai.classify),
        email:         taskEntry('emailModel',         DEFAULTS.ai.email),
        report:        taskEntry('reportModel',        DEFAULTS.ai.report),
        icpAutomation: taskEntry('icpAutomationModel', DEFAULTS.ai.icpAutomation),
    };
}

function validateTaskEntry(entry, def) {
    if (!entry || typeof entry !== 'object') return def;
    const provider = String(entry.provider || '').toLowerCase();
    const model = String(entry.model || '').trim();
    if (!PROVIDERS[provider]) return def;
    if (!model) return def;
    return { provider, model };
}

function validateAiGroup(g) {
    const useDefault = g.useDefault !== false;
    if (useDefault) {
        return {
            useDefault: true,
            custom: structuredClone(load().ai.custom),
        };
    }
    const raw = g.custom || {};
    // Detect and migrate old flat shape (classifyModel, emailModel, ...).
    const isOldShape = raw.classifyModel || raw.emailModel || raw.reportModel || raw.icpAutomationModel;
    const c = isOldShape ? migrateAiCustom(raw) : raw;

    const out = { useDefault: false, custom: structuredClone(DEFAULTS.ai) };
    out.custom.classify      = validateTaskEntry(c.classify,      DEFAULTS.ai.classify);
    out.custom.email         = validateTaskEntry(c.email,         DEFAULTS.ai.email);
    out.custom.report        = validateTaskEntry(c.report,        DEFAULTS.ai.report);
    out.custom.icpAutomation = validateTaskEntry(c.icpAutomation, DEFAULTS.ai.icpAutomation);
    return out;
}

function validateLinkedinGroup(g) {
    const useDefault = g.useDefault !== false;
    if (useDefault) {
        return {
            useDefault: true,
            custom: structuredClone(load().linkedin.custom),
        };
    }
    const c = g.custom || {};
    const out = { useDefault: false, custom: { ...DEFAULTS.linkedin } };
    out.custom.postsPerProfile = clampInt(c.postsPerProfile, 1, 25, DEFAULTS.linkedin.postsPerProfile);
    return out;
}

function positiveNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function nonNegNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
function clampFloat(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

module.exports = {
    DEFAULTS,
    PROVIDERS,
    ALLOWED_MODELS,
    getEffective,
    getCellGeneration,
    getFirecrawl,
    getAi,
    getLinkedin,
    getState,
    setSettings,
};
