// Apollo wrapper for the Bluebird demo.
// Adapted from valsource's be-vms-checker/utils/apollo.js - same multi-strategy
// search + tier-based ranking. Stripped of: api-tracker, SF-specific lookup
// fallbacks, keyword-fallback domain filtering. The shape returned is the
// same so the frontend can render leads identically.

const axios = require('axios');

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;

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

async function enrichPerson(apolloId) {
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

        const person = response.data?.person;
        if (!person) return null;

        return {
            firstName: person.first_name || '',
            lastName: person.last_name || '',
            email: person.email || null,
            emailStatus: person.email_status || null,
            linkedinUrl: person.linkedin_url || null,
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

/**
 * Search Apollo for the top N most senior people at a company, then enrich each
 * to get their email + LinkedIn. Same multi-strategy fallback as valsource:
 *   1. Domain + title keywords
 *   2. Domain + seniority filter
 *   3. Domain only (anyone at the company)
 *   4. Org name search if domain returns nothing
 *
 * @param {string} companyName
 * @param {string} domain - e.g. "acmerentals.com"
 * @param {number} limit - max results (default 3)
 * @param {object} opts.skipEnrich - true = search only, no enrichment credits
 * @returns {Promise<{people: Array, warnings: Array}>}
 */
async function searchTopPeople(companyName, domain, limit = 3, { skipEnrich = false } = {}) {
    if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY missing');

    const cleanDomain = (domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');
    console.log(`[Apollo] Searching top ${limit} at ${companyName} (domain=${cleanDomain})`);

    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': APOLLO_API_KEY,
    };

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

        // Enrich the top 2x candidates so we have headroom if some come back
        // empty. skipEnrich saves Apollo credits when the caller just wants
        // a quick preview.
        const enrichCandidates = people.slice(0, skipEnrich ? limit : limit * 2);
        const enriched = [];
        for (const candidate of enrichCandidates) {
            const apolloId = candidate.id || null;
            let firstName = candidate.first_name || '';
            let lastName = candidate.last_name_obfuscated || '';
            let email = null;
            let emailStatus = null;
            let linkedinUrl = candidate.linkedin_url || null;
            const hasEmail = !!candidate.has_email;
            const title = candidate.title || '';

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
                }
            }

            enriched.push({
                firstName, lastName, title, email, emailStatus, linkedinUrl, hasEmail, apolloId,
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

        const results = enriched.slice(0, limit).map(({ _tier, ...rest }) => rest);
        return { people: results, warnings };
    } catch (error) {
        const errMsg = JSON.stringify(error.response?.data || error.message || '');
        const status = error.response?.status;
        console.error('[Apollo] search error:', error.response?.data || error.message);
        if (status === 402 || status === 429 || /insufficient.credits|no credits|credits.exhausted|billing|quota/i.test(errMsg)) {
            return { people: [], warnings: ['Apollo credits exhausted - check billing'] };
        }
        if (status === 401) return { people: [], warnings: ['Apollo authentication failed - check API key'] };
        return { people: [], warnings: ['Apollo search failed'] };
    }
}

module.exports = { searchTopPeople, enrichPerson };
