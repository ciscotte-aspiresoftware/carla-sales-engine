// POST /api/discover
//
// Standalone "find + enrich + contacts" pipeline built for the Aspire CRM
// integration. Chains the existing Atlas building blocks into ONE stateless
// call that returns CRM-ready records - it does NOT persist to Atlas's own
// stores (companies/grid/etc.). The CRM either pulls this live or the operator
// downloads the JSON from the Discover page.
//
//   Scrapingdog Maps  (find businesses for each search term in a location)
//     → Firecrawl scrape + GPT analysis against a DYNAMIC `criteria` string
//     → Apollo decision-maker contacts
//
// Vertical-agnostic: `criteria` drives what GPT qualifies + extracts, so the
// same endpoint works for hotels today and anything tomorrow with no code
// change. `limit` (companies), `enrich`, `contacts`, and `contactsLimit` are
// all caller-controlled so the CRM team can trade speed/credits for depth.

const express = require('express');
const { searchMaps } = require('../utils/scrapingdog');
const { findCityAsync } = require('../utils/cities');
const { scrapeUrl } = require('../utils/firecrawl');
const { chat } = require('../utils/openai');
const { getAi } = require('../utils/settings');
const { extractContacts, hasAnyContact } = require('../utils/contact-extractor');
const { extractDomain } = require('../utils/chains');
const { searchTopPeople } = require('../utils/apollo');
const scrapeCache = require('../utils/scrape-cache');

const router = express.Router();

// Optional API-key gate. When DISCOVER_API_KEY is set in the environment, every
// request must present it (header `x-api-key: <key>` OR `Authorization: Bearer
// <key>`). When the env var is unset the endpoint stays open - so local dev and
// the existing behaviour are unchanged until you opt in by setting the key on
// Render. Lets you hand the CRM team a credential without sharing any code, and
// revoke/rotate it by changing the env var.
function keyOk(req) {
    const required = process.env.DISCOVER_API_KEY || '';
    if (!required) return true; // no key configured → open
    const headerKey = req.get('x-api-key') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    return headerKey === required || bearer === required;
}

// Bounded-concurrency map. Keeps Firecrawl/Apollo from hammering rate limits
// while still beating fully-sequential latency: `n` workers pull from a shared
// cursor until the list is drained. Errors are captured per-item so one bad
// company can't fail the whole batch.
async function mapPool(items, n, fn) {
    const out = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (cursor < items.length) {
            const idx = cursor++;
            try { out[idx] = await fn(items[idx], idx); }
            catch (e) { out[idx] = { __error: e.message }; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

const ANALYZE_SYSTEM = `You are a B2B sales-lead analyst. You are given a company's website content plus a set of qualification CRITERIA. Analyze the company strictly against the criteria.

Return ONLY a valid JSON object with exactly these fields:
{
  "qualified": boolean,        // true if the company clearly meets the criteria
  "reason": string,            // one short sentence explaining the verdict
  "summary": string,           // 1-2 sentence plain description of the company
  "attributes": object,        // flat key/value facts relevant to the criteria, e.g. {"roomCount": 58, "currentSoftware": "Mews", "category": "boutique hotel"}. Use null when a value is unknown. Never invent.
  "signals": string[]          // up to 5 short buying signals / notable facts
}`;

// Extra field appended to the schema when the caller asks for a markdown
// writeup (report:true). Kept opt-in because it roughly doubles output tokens
// per company.
const REPORT_FIELD = `,
  "report": string             // a concise markdown writeup: ## Overview, ## Fit vs the criteria, ## Outreach angle. Use real facts from the page; say "unknown" rather than inventing.`;

// GPT analysis against the caller's dynamic criteria. Mirrors the classify
// route's chat() usage so model selection / settings stay consistent. When
// wantReport is true the JSON also carries a `report` markdown string.
async function analyze(markdown, pageTitle, name, url, criteria, wantReport = false) {
    if (!markdown) return null;
    const trimmed = markdown.length > 12000 ? markdown.slice(0, 12000) : markdown;
    // Splice the optional report field into the schema before the closing brace.
    const schema = wantReport ? ANALYZE_SYSTEM.replace(/\n}$/, `${REPORT_FIELD}\n}`) : ANALYZE_SYSTEM;
    const messages = [
        { role: 'system', content: `${schema}\n\nCRITERIA:\n${criteria || 'Any legitimate business matching the search terms.'}` },
        { role: 'user', content: `Company: ${name || '(unknown)'}\nWebsite: ${url || '(none)'}\nPage title: ${pageTitle || '(none)'}\n\nPage content:\n${trimmed}` },
    ];
    const raw = await chat(messages, {
        model: getAi().classifyModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
    });
    try {
        const p = JSON.parse(raw);
        return {
            qualified: !!p.qualified,
            reason: p.reason || (p.qualified ? 'meets criteria' : 'does not meet criteria'),
            summary: p.summary || '',
            attributes: (p.attributes && typeof p.attributes === 'object') ? p.attributes : {},
            signals: Array.isArray(p.signals) ? p.signals.slice(0, 5) : [],
            report: (wantReport && typeof p.report === 'string') ? p.report : null,
        };
    } catch {
        return { qualified: false, reason: 'analysis returned non-JSON', summary: '', attributes: {}, signals: [], report: null };
    }
}

router.post('/', async (req, res) => {
    if (!keyOk(req)) {
        return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
    }
    const body = req.body || {};
    const { searchTerms, location, limit, criteria, enrich, contacts, pages, contactsLimit } = body;

    // ── Normalize inputs ──────────────────────────────────────────────────
    const terms = Array.isArray(searchTerms)
        ? searchTerms.map((t) => String(t).trim()).filter(Boolean)
        : (searchTerms ? [String(searchTerms).trim()].filter(Boolean) : []);
    if (terms.length === 0) {
        return res.status(400).json({ success: false, error: 'searchTerms (string or array) is required' });
    }
    if (!location || !String(location).trim()) {
        return res.status(400).json({ success: false, error: 'location is required' });
    }

    const maxCompanies = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 10;
    const pagesPerTerm = Number.isFinite(Number(pages)) && Number(pages) > 0 ? Math.min(Math.floor(Number(pages)), 6) : 1;
    const doEnrich = enrich !== false;     // default true
    const doContacts = contacts !== false; // default true
    const wantReport = body.report === true; // opt-in markdown writeup per company (needs enrich)
    const perCompanyContacts = Number.isFinite(Number(contactsLimit)) && Number(contactsLimit) > 0 ? Math.floor(Number(contactsLimit)) : 3;

    const startedAt = Date.now();
    console.log(`[Discover] ▶ START terms=${JSON.stringify(terms)} location="${location}" limit=${maxCompanies} enrich=${doEnrich} contacts=${doContacts}`);

    try {
        // ── Step 1: geocode the free-text location → Scrapingdog ll/country/lang ──
        const city = await findCityAsync(String(location).trim());
        if (!city) {
            return res.status(422).json({ success: false, error: `Could not geocode location "${location}"` });
        }
        // Output country = the geocoder's real ISO code (Photon's countrycode,
        // e.g. "PT" for Lisbon). city.country is an INTERNAL code that defaults
        // to "US" for markets outside the static catalog, so it's wrong to ship
        // to the CRM - the Scrapingdog query still uses city.country (lat/lng
        // dominates), we just relabel the output.
        const countryCode = String(city.photonProps?.countrycode || city.country || '').toUpperCase();

        // ── Step 2: Scrapingdog Maps per search term, dedupe by domain ──────────
        const seen = new Set();
        const found = [];
        outer:
        for (const term of terms) {
            for (let p = 0; p < pagesPerTerm; p++) {
                let results = [];
                try {
                    ({ results } = await searchMaps({
                        query: term, ll: city.ll, country: city.country,
                        language: city.language, domain: city.domain, page: p * 20,
                    }));
                } catch (e) {
                    console.warn(`[Discover]   ⚠ searchMaps failed for "${term}" p${p}: ${e.message}`);
                }
                const got = (results || []).length;
                for (const r of (results || [])) {
                    const dom = extractDomain(r.website) || '';
                    const key = dom || (r.title || '').toLowerCase().trim();
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    found.push({
                        company: r.title || '',
                        website: r.website || '',
                        domain: dom,
                        phone: r.phone || '',
                        address: r.address || '',
                        rating: r.rating ?? null,
                        reviews: r.reviews ?? null,
                        category: r.type || '',
                        gps: r.gps_coordinates || null,
                        searchTerm: term,
                    });
                }
                if (got < 20) break;                       // no more pages for this term
                if (found.length >= maxCompanies * 3) break outer; // plenty to pick from
            }
        }

        // ── Step 3: cap to the requested limit. Prefer companies WITH a website
        // when trimming so enrichment + Apollo have something to work with. ─────
        found.sort((a, b) => (b.website ? 1 : 0) - (a.website ? 1 : 0));
        const selected = found.slice(0, maxCompanies);
        console.log(`[Discover]   ├─ ${found.length} unique businesses found, processing ${selected.length}`);

        // ── Step 4: enrich + contacts per company (bounded concurrency = 3) ─────
        const records = await mapPool(selected, 3, async (biz) => {
            const rec = {
                company: biz.company,
                website: biz.website,
                domain: biz.domain,
                address: biz.address,
                city: city.label,
                country: countryCode,
                phone: biz.phone,
                rating: biz.rating,
                reviews: biz.reviews,
                category: biz.category,
                gps: biz.gps,
                source: 'google_maps',
                searchTerm: biz.searchTerm,
                qualified: null,
                reason: null,
                summary: '',
                attributes: {},
                signals: [],
                report: null,
                websiteContacts: null,
                contacts: [],
            };

            // 4a: Firecrawl scrape (cache-first) + GPT analysis.
            if (doEnrich && biz.website) {
                let url = biz.website;
                if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
                try {
                    let markdown = '';
                    let pageTitle = '';
                    const cached = biz.domain ? await scrapeCache.get(biz.domain) : null;
                    if (cached && cached.markdown) {
                        markdown = cached.markdown;
                        pageTitle = cached.pageTitle || '';
                    } else {
                        const scrape = await scrapeUrl(url);
                        markdown = scrape?.markdown || scrape?.data?.markdown || '';
                        pageTitle = scrape?.metadata?.title || scrape?.data?.metadata?.title || '';
                        if (markdown && biz.domain) {
                            try {
                                await scrapeCache.put(biz.domain, {
                                    vertical: 'crm-discover', url, pageTitle, markdown, scrapedAt: Date.now(),
                                });
                            } catch { /* cache write non-fatal */ }
                        }
                    }
                    if (markdown) {
                        const analysis = await analyze(markdown, pageTitle, biz.company, url, criteria, wantReport);
                        if (analysis) {
                            rec.qualified = analysis.qualified;
                            rec.reason = analysis.reason;
                            rec.summary = analysis.summary;
                            rec.attributes = analysis.attributes;
                            rec.signals = analysis.signals;
                            rec.report = analysis.report;
                        }
                        const c = extractContacts(markdown);
                        if (hasAnyContact(c)) rec.websiteContacts = c;
                    }
                } catch (e) {
                    console.warn(`[Discover]   ⚠ enrich failed for ${biz.company}: ${e.message}`);
                }
            }

            // 4b: Apollo decision-maker contacts (enrich mode → real emails).
            if (doContacts && biz.domain) {
                try {
                    const { people } = await searchTopPeople(biz.company, biz.domain, perCompanyContacts, { skipEnrich: false });
                    rec.contacts = (people || []).map((p) => ({
                        name: [p.firstName, p.lastName].filter(Boolean).join(' ').trim(),
                        title: p.title || '',
                        email: p.email || null,
                        emailStatus: p.emailStatus || null,
                        linkedinUrl: p.linkedinUrl || null,
                        phone: p.phone || null,
                    }));
                } catch (e) {
                    console.warn(`[Discover]   ⚠ Apollo failed for ${biz.company}: ${e.message}`);
                }
            }

            return rec;
        });

        // Drop any pool-level errors (kept as {__error} placeholders).
        const clean = records.filter((r) => r && !r.__error);
        console.log(`[Discover] ✓ END ${Date.now() - startedAt}ms | ${clean.length} records`);
        return res.json({
            success: true,
            meta: {
                location: city.label,
                country: countryCode,
                searchTerms: terms,
                requested: maxCompanies,
                found: found.length,
                returned: clean.length,
                enrich: doEnrich,
                contacts: doContacts,
                report: wantReport,
                ranAt: Date.now(),
            },
            records: clean,
        });
    } catch (err) {
        console.error(`[Discover] ✗ END error after ${Date.now() - startedAt}ms:`, err.response?.data || err.message);
        return res.status(500).json({ success: false, error: err.message || 'Discover failed' });
    }
});

module.exports = router;
