// Apollo wrapper for the Carla demo.
// Adapted from valsource's be-vms-checker/utils/apollo.js - same multi-strategy
// search + tier-based ranking. Stripped of: api-tracker, SF-specific lookup
// fallbacks, keyword-fallback domain filtering. The shape returned is the
// same so the frontend can render leads identically.

const axios = require('axios');
const { recordUsage, priceService } = require('./api-cost');

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

// Waterfall enrichment request tracking: request_id → {apolloId, companyId, leadKey, createdAt}
// When Apollo's webhook fires with phone data, we look up the original lead here.
const pendingEnrichments = new Map();

function registerPendingEnrichment(requestId, { apolloId, companyId, leadKey }) {
    pendingEnrichments.set(requestId, { apolloId, companyId, leadKey, createdAt: Date.now() });
    // Clean up old requests (>1h) to prevent memory leaks.
    const oneHourAgo = Date.now() - 3600000;
    for (const [id, data] of pendingEnrichments.entries()) {
        if (data.createdAt < oneHourAgo) pendingEnrichments.delete(id);
    }
}

function consumePendingEnrichment(requestId) {
    const data = pendingEnrichments.get(requestId);
    if (data) pendingEnrichments.delete(requestId);
    return data;
}

// Title tiers - lower number = higher seniority. Same as valsource.
const TITLE_TIERS = [
    { tier: 1, keywords: ['founder', 'co-founder', 'cofounder', 'owner', 'co-owner'] },
    { tier: 2, keywords: ['president', 'chief executive', 'ceo'] },
    { tier: 3, keywords: ['chief operating', 'coo', 'chief financial', 'cfo', 'chief revenue', 'cro', 'chief growth', 'cgo', 'chief strategy', 'cso', 'chief technology', 'cto', 'chief product', 'cpo'] },
    { tier: 4, keywords: ['managing director', 'managing partner', 'partner', 'md', 'senior director'] },
    { tier: 5, keywords: ['vice president', 'vp', 'director', 'head of'] },
    { tier: 6, keywords: ['senior manager', 'principal', 'regional manager', 'general manager'] },
    { tier: 7, keywords: ['manager'] },
];

const ALL_TITLES = TITLE_TIERS.flatMap(t => t.keywords);
const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'];

// Words that, preceding "owner", mean it's NOT a company owner role.
const OWNER_EXCLUSIONS = /\b(product|account|project|home|brand|content|program|platform|property|land|pet|store|shop)\s+owner\b/;

function getTitleTier(title) {
    if (!title) return 99;
    const lower = title.toLowerCase();
    for (const { tier, keywords } of TITLE_TIERS) {
        if (keywords.some(k => {
            if (k === 'owner' && OWNER_EXCLUSIONS.test(lower)) return false;
            const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`).test(lower);
        })) return tier;
    }
    return 99;
}

// Extract a usable phone number from an Apollo /people/match response.
// Apollo surfaces phones in two shapes:
//   - person.contact.sanitized_phone - a single canonical E.164-ish string
//   - person.contact.phone_numbers[] - an array; first item is the primary
// We prefer the sanitized single-field form; fall back to the first phone in
// the array, preferring sanitized_number over raw_number. Returns null when
// no phone is available (very common for contacts Apollo hasn't seen a phone
// for - those would need the paid reveal_phone_number=true + webhook flow).
function extractPhone(person) {
    if (!person) return null;
    const contact = person.contact || {};
    if (contact.sanitized_phone) return String(contact.sanitized_phone);
    if (Array.isArray(contact.phone_numbers) && contact.phone_numbers.length > 0) {
        const first = contact.phone_numbers[0];
        return first?.sanitized_number || first?.raw_number || null;
    }
    return null;
}

async function enrichPerson(apolloId) {
    const startedAt = Date.now();
    try {
        const response = await axios.post(
            'https://api.apollo.io/api/v1/people/match',
            { id: apolloId, reveal_personal_emails: true },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                    'X-Api-Key': APOLLO_API_KEY,
                },
            }
        );
        const durationMs = Date.now() - startedAt;

        const person = response.data?.person;
        // Record the enrichment regardless of whether person was found - the
        // credit gets burned by Apollo either way.
        recordUsage({
            service: 'apollo',
            operation: 'enrich',
            units: 1,
            usdCost: priceService('apollo', 1, 'enrich'),
            durationMs,
            metadata: { apolloId, found: !!person },
        });
        if (!person) return null;

        return {
            firstName: person.first_name || '',
            lastName: person.last_name || '',
            email: person.email || null,
            emailStatus: person.email_status || null,
            linkedinUrl: person.linkedin_url || null,
            // Apollo returns whatever phone it has on file in the standard
            // match response (no reveal_phone_number flag needed for these).
            // For mobiles Apollo hasn't seen, this stays null and the caller
            // would need the webhook-based reveal flow to chase them.
            phone: extractPhone(person),
        };
    } catch (error) {
        const errMsg = JSON.stringify(error.response?.data || error.message || '');
        const status = error.response?.status;
        if (status === 402 || status === 429 || /insufficient.credits|no credits|credits.exhausted|billing|quota/i.test(errMsg)) {
            return { warning: 'Apollo credits exhausted - leads returned without verified emails' };
        }
        console.error('[Apollo] enrichPerson error:', error.response?.data || error.message);
        return null;
    }
}

// Waterfall enrichment: async phone reveal via webhook.
// Initiates an Apollo waterfall request for phone numbers. Apollo will POST the
// results back to webhookUrl (must be publicly accessible, e.g.
// https://carla-sales-engine.onrender.com/api/apollo/webhook). This function
// returns immediately with {phone: null, waterfall_pending: true, request_id};
// the actual phone will arrive asynchronously and update the lead.
//
// Only used when synchronous enrichPerson can't find a phone and the operator
// clicks "reveal phone" — this initiates the async flow.
async function enrichPersonWithWaterfall(apolloId, { companyId, leadKey, webhookUrl }) {
    const startedAt = Date.now();
    if (!webhookUrl) throw new Error('webhookUrl required for waterfall enrichment');

    try {
        const response = await axios.post(
            'https://api.apollo.io/api/v1/people/match',
            {
                id: apolloId,
                run_waterfall_phone: true,
                webhook_url: webhookUrl,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                    'X-Api-Key': APOLLO_API_KEY,
                },
            }
        );

        const requestId = response.data?.request_id;
        if (!requestId) {
            console.warn('[Apollo] waterfall /people/match returned no request_id', response.data);
            return null;
        }

        // Register this request so when Apollo's webhook fires we know which lead to update.
        registerPendingEnrichment(requestId, { apolloId, companyId, leadKey });

        recordUsage({
            service: 'apollo',
            operation: 'waterfall_enrich',
            units: 1,
            usdCost: priceService('apollo', 1, 'waterfall_enrich'),
            durationMs: Date.now() - startedAt,
            metadata: { apolloId, requestId },
        });

        console.log(`[Apollo] waterfall initiated for ${apolloId}: request_id=${requestId}`);

        // Return a marker that phone enrichment is pending — the webhook will update it.
        return {
            phone: null,
            waterfall_pending: true,
            request_id: requestId,
        };
    } catch (error) {
        const errMsg = JSON.stringify(error.response?.data || error.message || '');
        const status = error.response?.status;
        if (status === 402 || status === 429 || /insufficient.credits|no credits|credits.exhausted|billing|quota/i.test(errMsg)) {
            return { warning: 'Apollo credits exhausted' };
        }
        console.error('[Apollo] waterfall enrichment error:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Search Apollo for people at a company, sorted by seniority. Same multi-
 * strategy fallback as valsource:
 *   1. Domain + title keywords
 *   2. Domain + seniority filter
 *   3. Domain only (anyone at the company)
 *   4. Org name search if domain returns nothing
 *
 * Behavior is mode-dependent:
 *   - search-only (skipEnrich: true, the default flow): returns EVERY person
 *     Apollo surfaced for this company, deduped + sorted by seniority. No
 *     enrichment credits spent. If `limit` is passed explicitly, the list
 *     is sliced to that length; otherwise no cap.
 *   - enrich mode (skipEnrich: false): enriches `limit * 2` candidates to
 *     guarantee `limit` final winners have email coverage. Costs ~limit*2
 *     enrich credits. Default limit in this mode is 3.
 *
 * @param {string} companyName
 * @param {string} domain - e.g. "acmerentals.com"
 * @param {number=} limit - max results (undefined = no cap in search-only mode)
 * @param {object} opts.skipEnrich - true = search only, no enrichment credits
 * @returns {Promise<{people: Array, warnings: Array}>}
 */
async function searchTopPeople(companyName, domain, limit, { skipEnrich = false } = {}) {
    if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY missing');

    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
    const noLimit = !Number.isFinite(limit) || limit <= 0;
    const effectiveLimit = noLimit ? (skipEnrich ? null : 3) : limit;
    console.log(`[Apollo] Searching at ${companyName} (domain=${cleanDomain}) - ${skipEnrich ? 'search-only' : 'enrich'} mode, limit=${effectiveLimit ?? 'all'}`);

    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_API_KEY,
    };

    // Counts the Apollo search-API requests this call makes (one per
    // strategy that runs). enrich calls are tracked separately inside
    // enrichPerson(). Recorded once at the end as a single search_session
    // row so the Costs page shows one logical Apollo search per company.
    const startedAt = Date.now();
    let searchCalls = 0;

    const seenIds = new Set();
    function mergeUnique(existing, incoming) {
        const out = [...existing];
        for (const p of incoming) {
            const id = p.id || `${p.first_name}_${p.last_name_obfuscated}`;
            if (!seenIds.has(id)) {
                seenIds.add(id);
                out.push(p);
            }
        }
        return out;
    }

    const warnings = [];
    let people = [];

    try {
        // Strategy 1: domain + title keywords
        if (cleanDomain) {
            const r1 = await axios.post(
                'https://api.apollo.io/api/v1/mixed_people/api_search',
                { q_organization_domains_list: [cleanDomain], person_titles: ALL_TITLES, per_page: 25, page: 1 },
                { headers }
            );
            searchCalls++;
            people = mergeUnique(people, r1.data?.people || []);
            console.log(`[Apollo] Strategy 1: ${r1.data?.people?.length || 0} people`);
        }

        // Strategy 2: domain + seniority
        if (cleanDomain) {
            const r2 = await axios.post(
                'https://api.apollo.io/api/v1/mixed_people/api_search',
                { q_organization_domains_list: [cleanDomain], person_seniorities: SENIORITIES, per_page: 25, page: 1 },
                { headers }
            );
            searchCalls++;
            people = mergeUnique(people, r2.data?.people || []);
            console.log(`[Apollo] Strategy 2: ${r2.data?.people?.length || 0} people (${people.length} unique)`);
        }

        // Strategy 3: domain only
        if (people.length === 0 && cleanDomain) {
            const r3 = await axios.post(
                'https://api.apollo.io/api/v1/mixed_people/api_search',
                { q_organization_domains_list: [cleanDomain], per_page: 25, page: 1 },
                { headers }
            );
            searchCalls++;
            people = mergeUnique(people, r3.data?.people || []);
            console.log(`[Apollo] Strategy 3 (domain only): ${people.length} people`);
        }

        // Strategy 4: org name (for businesses not indexed by domain - common
        // for small independent rentals that may have weak SEO presence)
        if (people.length === 0 && companyName) {
            const r4 = await axios.post(
                'https://api.apollo.io/api/v1/mixed_people/api_search',
                { q_organization_name: companyName, person_seniorities: SENIORITIES, per_page: 25, page: 1 },
                { headers }
            );
            searchCalls++;
            people = mergeUnique(people, r4.data?.people || []);
            console.log(`[Apollo] Strategy 4 (org name): ${people.length} people`);
        }

        if (people.length === 0) return { people: [], warnings };

        // Sort: seniority tier first, then has-email/has-linkedin priority
        function contactPriority(p) {
            const hasEmail = !!p.has_email;
            const hasLinkedin = !!p.linkedin_url;
            if (hasEmail && hasLinkedin) return 0;
            if (hasEmail) return 1;
            if (hasLinkedin) return 2;
            return 3;
        }

        people.sort((a, b) => {
            const t = getTitleTier(a.title) - getTitleTier(b.title);
            if (t !== 0) return t;
            return contactPriority(a) - contactPriority(b);
        });

        // Candidate pool size:
        //   - skip-enrich + no limit  → every Apollo person (the new default)
        //   - skip-enrich + explicit  → cap at the explicit limit
        //   - enrich mode             → cap at limit*2 so the final `limit`
        //                               winners have headroom for empty emails
        const poolSize = skipEnrich
            ? (effectiveLimit == null ? people.length : effectiveLimit)
            : effectiveLimit * 2;
        const enrichCandidates = people.slice(0, poolSize);
        const enriched = [];
        for (const candidate of enrichCandidates) {
            const apolloId = candidate.id || null;
            let firstName = candidate.first_name || '';
            let lastName = candidate.last_name_obfuscated || '';
            let email = null;
            let emailStatus = null;
            let linkedinUrl = candidate.linkedin_url || null;
            let phone = null;
            const hasEmail = !!candidate.has_email;
            const title = candidate.title || '';
            // Phone-availability signal from the cheap search response.
            // Apollo doesn't expose a single `has_phone` boolean, so we infer
            // from whatever phone hints they include for free: a non-empty
            // phone_numbers array on the candidate, a populated
            // sanitized_phone on the contact subobject (sometimes present),
            // or the organization's primary_phone. Best-effort - when Apollo
            // omits all of these, hasPhone stays false and the UI shows no
            // pre-enrich badge (which the operator should treat as "unknown",
            // not "definitely no phone").
            const candidatePhones = Array.isArray(candidate.phone_numbers) ? candidate.phone_numbers : [];
            const contactPhones = Array.isArray(candidate.contact?.phone_numbers) ? candidate.contact.phone_numbers : [];
            const orgPhone = candidate.organization?.primary_phone?.number
                || candidate.organization?.phone
                || null;
            const hasPhone = candidatePhones.length > 0
                || contactPhones.length > 0
                || !!candidate.contact?.sanitized_phone
                || !!orgPhone;

            // Extract phone from the search result (not just from enrichment).
            // Apollo's /mixed_people/api_search already returns phone hints —
            // use them instead of waiting for enrichment (which costs extra credits).
            // If Apollo didn't return a phone in the search, this stays null and
            // the operator can later click "Reveal phone" to trigger async waterfall.
            if (!phone && hasPhone) {
                phone = extractPhone(candidate);
            }

            if (skipEnrich) {
                console.log(`[Apollo] ${firstName} ${lastName} (${title}): search-only, no enrich`);
            } else if (apolloId) {
                const enrichResult = await enrichPerson(apolloId);
                if (enrichResult?.warning) {
                    warnings.push(enrichResult.warning);
                    break; // Stop enriching - credits gone
                } else if (enrichResult) {
                    firstName = enrichResult.firstName || firstName;
                    lastName = enrichResult.lastName || lastName;
                    email = enrichResult.email;
                    emailStatus = enrichResult.emailStatus;
                    linkedinUrl = enrichResult.linkedinUrl || linkedinUrl;
                    phone = enrichResult.phone || phone;
                }
            }

            enriched.push({
                firstName, lastName, title, email, emailStatus, linkedinUrl, phone, hasEmail, hasPhone, apolloId,
                _tier: getTitleTier(title),
            });
        }

        // Re-sort enriched: verified email first, then any email, then by tier
        function enrichedPriority(p) {
            if (p.email && p.emailStatus === 'verified') return 0;
            if (p.email) return 1;
            if (p.hasEmail) return 2;
            return 3;
        }
        enriched.sort((a, b) => {
            const ep = enrichedPriority(a) - enrichedPriority(b);
            if (ep !== 0) return ep;
            return a._tier - b._tier;
        });

        // In skip-enrich + no-limit mode we return everyone we built. In
        // every other mode we slice to the effective limit (enrich mode
        // wants exactly `limit` winners; skip-enrich + explicit cap wants
        // exactly `limit`). `_tier` is stripped on the way out.
        const sliceTo = (skipEnrich && effectiveLimit == null) ? enriched.length : effectiveLimit;
        const results = enriched.slice(0, sliceTo).map(({ _tier, ...rest }) => rest);
        recordUsage({
            service: 'apollo',
            operation: 'search_session',
            units: searchCalls,
            usdCost: priceService('apollo', searchCalls, 'search'),
            durationMs: Date.now() - startedAt,
            metadata: { companyName, domain: cleanDomain, peopleFound: people.length, returned: results.length },
        });
        return { people: results, warnings };
    } catch (error) {
        const errMsg = JSON.stringify(error.response?.data || error.message || '');
        const status = error.response?.status;
        console.error('[Apollo] search error:', error.response?.data || error.message);
        recordUsage({
            service: 'apollo',
            operation: 'search_session',
            units: searchCalls,
            usdCost: priceService('apollo', searchCalls, 'search'),
            durationMs: Date.now() - startedAt,
            metadata: { companyName, domain: cleanDomain, error: status || 'unknown' },
        });
        if (status === 402 || status === 429 || /insufficient.credits|no credits|credits.exhausted|billing|quota/i.test(errMsg)) {
            return { people: [], warnings: ['Apollo credits exhausted - check billing'] };
        }
        if (status === 401) return { people: [], warnings: ['Apollo authentication failed - check API key'] };
        return { people: [], warnings: ['Apollo search failed'] };
    }
}

module.exports = {
    searchTopPeople,
    enrichPerson,
    enrichPersonWithWaterfall,
    consumePendingEnrichment,
    registerPendingEnrichment,
};
