// API usage + cost ledger writer.
//
// Wraps the 5 external services Atlas hits (OpenAI, Scrapingdog, Firecrawl,
// Apollo, Apify) and writes one row per call to the `api_usage` Supabase
// table. Drives /api/costs aggregations rendered on the Costs page.
//
// All public functions are fire-and-forget - they never throw, never block
// the caller. A logging failure here MUST NOT take down a sweep or an email
// gen. The price of that promise is: when Supabase is disabled or down, we
// silently drop the row. That's the right trade.
//
// Pricing tables live here, baked in. Updating prices = code change. We
// stamp the computed usd_cost into each row at write time so historical
// rows survive future pricing changes - the "rate when this call happened"
// is captured forever.

const { isEnabled, getClient } = require('../db');

// ─── OpenAI pricing ────────────────────────────────────────────────────
// USD per token, broken into prompt (in) + completion (out). Source:
// https://openai.com/api/pricing/ - sanity-check before raising prices.
// Models not in this table fall through to UNKNOWN_MODEL_PRICING below
// (a conservative placeholder so spend is at least approximated, never 0).
const OPENAI_PRICING = {
    // ─── gpt-5 family ─────────────────────────────────────────────────
    'gpt-5.2-pro':            { in: 21.00e-6, out: 168.00e-6 },
    'gpt-5.2':                { in: 1.750e-6, out:  14.00e-6 },
    'gpt-5.1':                { in: 1.250e-6, out:  10.00e-6 },
    'gpt-5-pro':              { in: 15.00e-6, out: 120.00e-6 },
    'gpt-5':                  { in: 1.250e-6, out:  10.00e-6 },
    'gpt-5-mini':             { in: 0.250e-6, out:   2.00e-6 },
    'gpt-5-nano':             { in: 0.050e-6, out:   0.40e-6 },
    // ─── gpt-4.1 family ───────────────────────────────────────────────
    'gpt-4.1':                { in: 2.000e-6, out:   8.00e-6 },
    'gpt-4.1-mini':           { in: 0.400e-6, out:   1.60e-6 },
    'gpt-4.1-nano':           { in: 0.100e-6, out:   0.40e-6 },
    // ─── gpt-4o family ────────────────────────────────────────────────
    'gpt-4o':                 { in: 2.500e-6, out:  10.00e-6 },
    'gpt-4o-2024-08-06':      { in: 2.500e-6, out:  10.00e-6 },
    'gpt-4o-2024-11-20':      { in: 2.500e-6, out:  10.00e-6 },
    'gpt-4o-mini':            { in: 0.150e-6, out:   0.60e-6 },
    'gpt-4o-mini-2024-07-18': { in: 0.150e-6, out:   0.60e-6 },
    // ─── Legacy (kept so historical rows price correctly) ─────────────
    'o1':                     { in: 15.00e-6, out:  60.00e-6 },
    'o1-mini':                { in: 1.100e-6, out:   4.40e-6 },
    'gpt-4-turbo':            { in: 10.00e-6, out:  30.00e-6 },
    'gpt-4':                  { in: 30.00e-6, out:  60.00e-6 },
    'gpt-3.5-turbo':          { in: 0.500e-6, out:   1.50e-6 },
};
// Conservative fallback for any model id we haven't priced. Picked to
// approximate gpt-4o so unrecognised models don't show as $0 (which would
// obscure spend) or some absurd number.
const UNKNOWN_MODEL_PRICING = { in: 2.500e-6, out: 10.00e-6 };

// ─── Anthropic (Claude) pricing ─────────────────────────────────────────
// USD per token. Source: https://platform.claude.com/docs/en/pricing
const ANTHROPIC_PRICING = {
    'claude-opus-4-8':   { in:  5.00e-6, out: 25.00e-6 },
    'claude-opus-4-7':   { in:  5.00e-6, out: 25.00e-6 },
    'claude-opus-4-6':   { in:  5.00e-6, out: 25.00e-6 },
    'claude-opus-4-5':   { in:  5.00e-6, out: 25.00e-6 },
    'claude-sonnet-4-6': { in:  3.00e-6, out: 15.00e-6 },
    'claude-sonnet-4-5': { in:  3.00e-6, out: 15.00e-6 },
    'claude-haiku-4-5':  { in:  1.00e-6, out:  5.00e-6 },
};

// ─── Google Gemini pricing ──────────────────────────────────────────────
// USD per token. APPROXIMATE — Gemini prices tier by context length and the
// catalog model ids move fast. Verify against https://ai.google.dev/pricing
// when a Gemini key is added. Unpriced ids fall through to UNKNOWN_MODEL_PRICING.
const GEMINI_PRICING = {
    'gemini-2.5-pro':   { in: 1.250e-6, out: 10.00e-6 },
    'gemini-2.5-flash': { in: 0.300e-6, out:  2.50e-6 },
    'gemini-2.0-flash': { in: 0.100e-6, out:  0.40e-6 },
};

// Provider → pricing table. Drives priceLLM() / recordLLM().
const PRICING_BY_PROVIDER = {
    openai: OPENAI_PRICING,
    anthropic: ANTHROPIC_PRICING,
    gemini: GEMINI_PRICING,
};

// ─── FX rates ──────────────────────────────────────────────────────────
// All ledger rows are stored in USD. The Costs page lets the operator
// view in USD / EUR / GBP via simple multiplication. Updated periodically
// by hand - we don't hit a live FX API to keep the deployment self-
// contained. Numbers below are mid-market spot rates as of FX_AS_OF.
const FX_RATES = {
    USD: 1.00,
    EUR: 0.92,
    GBP: 0.79,
    CAD: 1.36,
};
const FX_AS_OF = '2026-06-07';

// ─── Per-service unit pricing (non-LLM) ────────────────────────────────
// Sourced from the plans Bluebird's current deployment runs on. Tenants
// on different plans pay different rates; the Admin page will eventually
// expose these as overrides (not wired yet).
//
// Apollo phone reveal would be 8 credits per number - Atlas doesn't call
// /people/reveal_phone yet, so no apollo_phone rate is needed. Add one if
// that path lands.
const SERVICE_UNIT_USD = {
    scrapingdog:      0.0002,  // $/credit (LITE plan: $40 / 200k credits = $0.0002/credit)
    firecrawl:        0.001,   // $/credit (Standard plan: $100 / 100k credits)
    apollo_enrich:    0.02,    // $/credit, 1 credit per email reveal (Professional ≈ $79/mo / 48k credits ≈ $0.0198/credit)
    apollo_search:    0.0,     // search doesn't burn enrichment credits
    apify_profile:    0.004,   // $/profile (HarvestAPI actor: $4/1k profiles)
    apify_post:       0.003,   // $/post (supreme_coder actor: $3/1k posts)
};

// ─── Flat monthly infrastructure subscriptions ─────────────────────────
// Not per-call costs - these are the always-on subscriptions Atlas needs
// regardless of usage. Surfaced on the Costs page as a separate card so
// the total cost of running Atlas reads honestly, not just the per-call
// burn. Update when you re-shop plans.
const MONTHLY_SUBSCRIPTIONS_USD = {
    apify_base:   30,    // Apify Starter sub (pay-per-use actors sit on top)
    supabase:     25,    // Supabase Pro
    hosting:      65,    // Azure App Service estimate (Render is similar / cheaper)
    netlify:      0,     // Free tier covers static frontend
};

function priceOpenAI(model, tokensIn, tokensOut) {
    const rate = OPENAI_PRICING[model] || UNKNOWN_MODEL_PRICING;
    return (tokensIn || 0) * rate.in + (tokensOut || 0) * rate.out;
}

/**
 * Compute the USD cost for a non-LLM call. `service` is the table-stored
 * service name; `subkey` picks the right rate inside SERVICE_UNIT_USD
 * (e.g. apollo has both _enrich and _search rates).
 */
function priceService(service, units, subkey = null) {
    const key = subkey ? `${service}_${subkey}` : service;
    const rate = SERVICE_UNIT_USD[key];
    if (rate == null) return 0;
    return (units || 0) * rate;
}

/**
 * Write one usage row. Fire-and-forget. Never throws, never blocks.
 *
 * Required:
 *   service - 'openai' | 'scrapingdog' | 'firecrawl' | 'apollo' | 'apify'
 *   units   - billable units (tokens for LLM, credits/calls for others)
 *
 * Optional:
 *   operation     - free-text tag ('classify', 'email_gen', 'maps_search', ...)
 *   model         - OpenAI model id; ignored for non-LLM services
 *   unitsIn       - prompt tokens (LLM) or 0
 *   unitsOut      - completion tokens (LLM) or 0
 *   usdCost       - if supplied, used verbatim; otherwise computed from pricing
 *   durationMs    - round-trip time in ms
 *   metadata      - arbitrary JSON (icp_id, company_domain, error, etc.)
 */
function recordUsage({
    service,
    operation = null,
    model = null,
    units = 0,
    unitsIn = 0,
    unitsOut = 0,
    usdCost = null,
    durationMs = null,
    metadata = {},
} = {}) {
    if (!service) return;
    if (!isEnabled()) return; // Supabase off → silent no-op

    const cost = usdCost != null ? usdCost : 0;
    const row = {
        service,
        operation,
        model,
        units_in: Math.max(0, Math.round(unitsIn || 0)),
        units_out: Math.max(0, Math.round(unitsOut || 0)),
        units: Math.max(0, Math.round(units || 0)),
        usd_cost: Math.max(0, cost),
        duration_ms: durationMs != null ? Math.round(durationMs) : null,
        metadata: metadata || {},
    };

    // .then so unhandled-rejection guards see the promise; never await.
    getClient().from('api_usage').insert(row).then(({ error }) => {
        if (error) console.warn(`[api-cost] insert failed: ${error.message}`);
    }).catch((err) => {
        console.warn(`[api-cost] insert threw: ${err.message}`);
    });
}

/**
 * Price an LLM call for any provider. Falls back to the conservative
 * UNKNOWN_MODEL_PRICING when the model id isn't in the provider's table
 * (e.g. a freshly-released model entered as a custom id in Admin).
 */
function priceLLM(provider, model, tokensIn, tokensOut) {
    const table = PRICING_BY_PROVIDER[provider] || {};
    const rate = table[model] || UNKNOWN_MODEL_PRICING;
    return (tokensIn || 0) * rate.in + (tokensOut || 0) * rate.out;
}

/**
 * Provider-agnostic LLM usage recorder. The LLM router (utils/llm/index.js)
 * calls this for every completion. `usage` is the normalized adapter shape
 * { inputTokens, outputTokens }. service = the provider name so the Costs
 * page breaks spend down by provider as well as model.
 */
function recordLLM({ provider, model, usage = {}, operation = null, durationMs = null, metadata = {} } = {}) {
    const inT = usage.inputTokens || 0;
    const outT = usage.outputTokens || 0;
    recordUsage({
        service: provider || 'unknown',
        operation,
        model,
        unitsIn: inT,
        unitsOut: outT,
        units: inT + outT,
        usdCost: priceLLM(provider, model, inT, outT),
        durationMs,
        metadata,
    });
}

/**
 * Convenience for OpenAI: pass the completion's `usage` field straight in.
 * Handles missing usage gracefully (some streaming paths don't populate it).
 */
function recordOpenAI({ model, usage, operation = null, durationMs = null, metadata = {} } = {}) {
    const inT = usage?.prompt_tokens || 0;
    const outT = usage?.completion_tokens || 0;
    const cost = priceOpenAI(model, inT, outT);
    recordUsage({
        service: 'openai',
        operation,
        model,
        unitsIn: inT,
        unitsOut: outT,
        units: inT + outT,
        usdCost: cost,
        durationMs,
        metadata,
    });
}

module.exports = {
    recordUsage,
    recordOpenAI,
    recordLLM,
    priceOpenAI,
    priceLLM,
    priceService,
    OPENAI_PRICING,
    ANTHROPIC_PRICING,
    GEMINI_PRICING,
    PRICING_BY_PROVIDER,
    SERVICE_UNIT_USD,
    MONTHLY_SUBSCRIPTIONS_USD,
    FX_RATES,
    FX_AS_OF,
};