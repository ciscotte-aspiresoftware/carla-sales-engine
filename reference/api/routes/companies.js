// JSON-file persistence for companies. Lives at api/data/companies.json,
// auto-created on first write. Fine for a demo/multi-user POC - we just
// need a list the frontend can show as "history" if/when we add that view.
// NOT thread-safe; concurrent requests will race, which is acceptable for
// a single-user demo.
//
// Data model - IMPORTANT:
//   • A company is identified by its domain.
//   • A company is tagged with ONE `vertical` (e.g. "Car Rental"), set
//     when the first ICP-driven sweep finds it. Future ICPs in the same
//     vertical re-classify the same company without re-scraping.
//   • Per-ICP results live under `company.classifications: { [icpId]: {...} }`.
//     This means "Bluebird UK" can mark a company as a match while
//     "Bluebird Spain" rejects it, both stored on the same record.
//   • A flat `classification` field is preserved for backwards compatibility
//     with the existing CompanyDetails frontend - it always points at the
//     most-recently-written per-ICP classification.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getIcp } = require('../utils/icps');
const mode = require('../utils/mode');

// A record counts as "demo data" if its source string is a stub or
// contains the ":demo" seed marker the seeded fixtures use ("bluebird:
// Cambridge:demo"). Real mode hides these so the operator only sees
// records produced by genuine sweep pipeline runs.
function isDemoRecord(c) {
    const src = c?.source;
    if (typeof src !== 'string') return false;
    return src === 'demo-stub' || src.includes(':demo');
}

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'companies.json');

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ companies: [] }, null, 2));
}

// Pull the icpId off a `source` string. Sources look like "bluebird:London"
// or "bluebird:London:scrape-error" - the first colon-separated segment is
// the icpId every time. Used to migrate legacy single-classification
// records into the new per-ICP shape on read.
function icpIdFromSource(source) {
    if (!source || typeof source !== 'string') return null;
    const idx = source.indexOf(':');
    return idx === -1 ? source : source.slice(0, idx);
}

// Lazy migrate a single company on read:
//   • Legacy single `classification` → per-ICP `classifications: { [icpId]: ... }`
//   • Missing `vertical` → backfill from source's icpId by looking up the ICP
// Idempotent - running on an already-migrated record is a no-op. We don't
// rewrite the file on read; migrated values land back on disk on the next
// upsert. Reads return the migrated shape regardless.
function migrateCompanyShape(c) {
    if (!c) return c;
    const icpId = icpIdFromSource(c.source);

    // 1. Per-ICP classifications shape
    if (!c.classifications || typeof c.classifications !== 'object') {
        if (c.classification && icpId) {
            c.classifications = {
                [icpId]: {
                    ...c.classification,
                    classifiedAt: c.scrapedAt || Date.now(),
                },
            };
        } else {
            c.classifications = {};
        }
    }

    // 2. Vertical backfill - pre-vertical-field records get their vertical
    // pulled from the originating ICP. Without this, /api/companies/verticals
    // returns an empty list for legacy data, the Database page's vertical
    // filter shows only "All verticals", and listByVertical() can't find
    // anything to reclassify. The lookup is cached in-memory by icps.js's
    // readAll() so it's cheap even when migrating hundreds of records.
    if (!c.vertical && icpId) {
        try {
            const icp = getIcp(icpId);
            if (icp && icp.vertical) c.vertical = icp.vertical;
        } catch { /* missing icp module or unreadable icps.json - leave null */ }
    }

    // 3. City backfill - mirror the same source-derived approach. The
    // sweep stores source as `<icpId>:<city>` or `<icpId>:<city>:<flag>`,
    // so the second segment is the city tag.
    if (!c.city && typeof c.source === 'string') {
        const segs = c.source.split(':');
        if (segs.length >= 2 && segs[1]) c.city = segs[1];
    }

    return c;
}

async function readAll() {
    ensureFile();
    const raw = await fs.promises.readFile(FILE, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { companies: [] }; }
    if (!Array.isArray(parsed.companies)) parsed.companies = [];
    // Migrate legacy entries on read so callers always see the new shape.
    parsed.companies = parsed.companies.map(migrateCompanyShape);
    return parsed;
}

async function writeAll(data) {
    ensureFile();
    await fs.promises.writeFile(FILE, JSON.stringify(data, null, 2));
}

/**
 * Insert or update a company record by domain. Returns the saved record.
 *
 * Required fields:
 *   - domain
 *   - icpId - which ICP produced this classification
 *   - classification - { is_match, reason, ...rich fields }
 *
 * Optional fields:
 *   - vertical - set on first create; subsequent writes preserve the original
 *     vertical (a company is only in one vertical, even if multiple ICPs
 *     classify it differently).
 *   - city - derived from the cell's parentCity at create time, used by
 *     the coverage-status endpoint to answer "have we covered London for
 *     this vertical?"
 *   - url, scrapedAt, source, location - same as before
 *
 * `source` is preserved on first write; subsequent re-classifications keep
 * the original origin info ("this came from a Toronto scan").
 */
async function upsertCompany({
    url,
    domain,
    icpId,
    vertical,
    city,
    classification,
    scrapedAt,
    source,
    location,
}) {
    const data = await readAll();
    const key = (domain || '').toLowerCase();
    let existing = data.companies.find(c => c.domain?.toLowerCase() === key);

    const now = Date.now();
    const classificationEntry = {
        ...classification,
        classifiedAt: now,
    };

    if (existing) {
        // Re-write fields the new sweep should refresh.
        if (url) existing.url = url;
        if (scrapedAt) existing.scrapedAt = scrapedAt;
        existing.updatedAt = now;
        // Vertical and city are sticky after first set - a company doesn't
        // suddenly change vertical, and we don't want a different ICP's
        // classification to overwrite the original geographic tag.
        if (vertical && !existing.vertical) existing.vertical = vertical;
        if (city && !existing.city) existing.city = city;
        // Preserve original source unless caller explicitly passes a new one
        // AND the existing record has none yet.
        if (source && !existing.source) existing.source = source;
        if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
            existing.location = { lat: location.lat, lng: location.lng };
        }
        // Per-ICP classification - overwrite if same icpId, otherwise add.
        if (icpId) {
            existing.classifications = existing.classifications || {};
            existing.classifications[icpId] = classificationEntry;
            // Pin the legacy `classification` field to the latest write so
            // the existing CompanyDetails display reads naturally.
            existing.classification = classificationEntry;
        }
    } else {
        existing = {
            id: crypto.randomUUID(),
            url,
            domain,
            vertical: vertical || null,
            city: city || null,
            // Keep the legacy single-classification field around for the
            // existing UI, but the canonical store is `classifications`.
            classification: icpId ? classificationEntry : (classification || null),
            classifications: icpId ? { [icpId]: classificationEntry } : {},
            scrapedAt: scrapedAt || now,
            source: source || null,
            location: (location && Number.isFinite(location.lat) && Number.isFinite(location.lng))
                ? { lat: location.lat, lng: location.lng }
                : null,
            createdAt: now,
            updatedAt: now,
            leads: [],
        };
        data.companies.unshift(existing);
    }

    await writeAll(data);
    return existing;
}

// Update only the classification under a specific ICP. Used by the
// reclassify-existing flow which reads the cached scrape, runs the new
// ICP's prompt, and writes the verdict - without touching scrape data,
// vertical, city, or any other fields. Returns the updated company.
async function setClassificationForIcp(domain, icpId, classification) {
    if (!domain || !icpId) return null;
    const data = await readAll();
    const key = String(domain).toLowerCase();
    const company = data.companies.find(c => c.domain?.toLowerCase() === key);
    if (!company) return null;
    const entry = { ...classification, classifiedAt: Date.now() };
    company.classifications = company.classifications || {};
    company.classifications[icpId] = entry;
    company.classification = entry; // pin latest
    company.updatedAt = Date.now();
    await writeAll(data);
    return company;
}

// Record a sales-rep review (confirm / reject) for a company under a
// specific ICP. Reviews are per-ICP because the same company can be a
// genuine fit for one ICP (NedFox-Garden) and clearly wrong for another
// (NedFox-Thrift) - they share a vertical pool but the GTM motion is
// per-ICP. The Accounts page reads these to bucket companies into
// Pending / Confirmed / Rejected lanes.
//
// `decision` must be 'confirmed' or 'rejected'. Reason + note are free-
// text and only meaningful on a reject (frontend doesn't show them on
// confirm). Returns the updated company, or null if not found.
async function setReviewForIcp(id, icpId, { decision, reason, note }) {
    if (!id || !icpId) return null;
    if (decision !== 'confirmed' && decision !== 'rejected') {
        throw new Error(`decision must be 'confirmed' or 'rejected' (got "${decision}")`);
    }
    const data = await readAll();
    const company = data.companies.find(c => c.id === id);
    if (!company) return null;
    company.reviews = company.reviews || {};
    company.reviews[icpId] = {
        decision,
        reason: (reason || '').trim() || null,
        note: (note || '').trim() || null,
        reviewedAt: Date.now(),
    };
    company.updatedAt = Date.now();
    await writeAll(data);
    return company;
}

// Undo a review - the sales rep wants to put the company back in the
// Pending lane. Returns the updated company.
async function clearReviewForIcp(id, icpId) {
    if (!id || !icpId) return null;
    const data = await readAll();
    const company = data.companies.find(c => c.id === id);
    if (!company || !company.reviews || !company.reviews[icpId]) return company || null;
    delete company.reviews[icpId];
    company.updatedAt = Date.now();
    await writeAll(data);
    return company;
}

async function attachLeads(companyId, leads) {
    const data = await readAll();
    const company = data.companies.find(c => c.id === companyId);
    if (!company) return null;
    company.leads = leads || [];
    company.leadsUpdatedAt = Date.now();
    await writeAll(data);
    return company;
}

async function upsertLeadInCompany(companyId, apolloId, fields) {
    if (!companyId || !apolloId) return null;
    const data = await readAll();
    const company = data.companies.find(c => c.id === companyId);
    if (!company || !Array.isArray(company.leads)) return null;
    const idx = company.leads.findIndex(l => l.apolloId === apolloId);
    if (idx === -1) return null;
    company.leads[idx] = { ...company.leads[idx], ...fields };
    company.leadsUpdatedAt = Date.now();
    await writeAll(data);
    return company.leads[idx];
}

// Fetch all companies tagged with a given vertical. Case-insensitive match
// on the vertical string. Used by the reclassify endpoint and by the
// database-page vertical filter.
async function listByVertical(vertical) {
    if (!vertical) return [];
    const data = await readAll();
    const target = String(vertical).toLowerCase();
    // Real mode hides the seeded demo fixtures so Coverage / Reclassify
    // only count companies discovered by genuine sweeps. Demo mode shows
    // everything (the fixtures are the point).
    const inVertical = data.companies.filter(c => (c.vertical || '').toLowerCase() === target);
    return mode.isReal() ? inVertical.filter(c => !isDemoRecord(c)) : inVertical;
}

// Distinct vertical strings present in the database, in alphabetical
// order. Powers the vertical dropdown in the database UI.
async function listVerticals() {
    const data = await readAll();
    const set = new Set();
    for (const c of data.companies) {
        if (mode.isReal() && isDemoRecord(c)) continue;
        if (c.vertical) set.add(c.vertical);
    }
    return Array.from(set).sort();
}

const router = express.Router();

// GET /api/companies - return everything, newest first. Optional filters:
//   ?vertical=Car%20Rental    - only companies in that vertical
//   ?icp=bluebird             - only companies the given ICP has classified
//   ?match=true|false         - filter by the given ICP's match status
//                               (requires `icp`)
//   ?portfolioCompany=NedFox  - companies classified by ANY ICP belonging
//                               to that portfolio company (e.g. NedFox →
//                               nedfox-garden | nedfox-thrift | nedfox-camping)
// All filters are AND-combined. The frontend uses these to drive the
// database page's filter chips without sending the full company list and
// filtering client-side.
router.get('/', async (req, res) => {
    try {
        const data = await readAll();
        let companies = data.companies;
        // Real mode hides the seeded demo fixtures so the operator only
        // sees companies produced by genuine sweeps. Demo mode shows
        // everything (the fixtures are the point).
        if (mode.isReal()) {
            companies = companies.filter((c) => !isDemoRecord(c));
        }
        const verticalFilter = req.query.vertical;
        const icpFilter = req.query.icp;
        const matchFilter = req.query.match;
        const portfolioFilter = req.query.portfolioCompany;

        if (verticalFilter) {
            const v = String(verticalFilter).toLowerCase();
            companies = companies.filter(c => (c.vertical || '').toLowerCase() === v);
        }
        if (portfolioFilter) {
            // Resolve portfolioCompany → set of ICP ids, then keep companies
            // that have at least one classification under any of those ICPs.
            // Done lazily here (lookup at request time) to avoid coupling
            // companies.js to a long-lived ICP cache.
            const { listIcpsFull } = require('../utils/icps');
            const target = String(portfolioFilter).toLowerCase();
            const owned = new Set(
                listIcpsFull()
                    .filter(i => (i.portfolioCompany || '').toLowerCase() === target)
                    .map(i => i.id),
            );
            if (owned.size === 0) {
                companies = []; // nothing matches
            } else {
                companies = companies.filter(c =>
                    c.classifications && Object.keys(c.classifications).some(k => owned.has(k)),
                );
            }
        }
        if (icpFilter) {
            companies = companies.filter(c => c.classifications && c.classifications[icpFilter]);
        }
        if (matchFilter !== undefined && icpFilter) {
            // Compare against the ICP's classification only - match status
            // is per-ICP, not a global property of the company.
            const want = String(matchFilter).toLowerCase() === 'true';
            companies = companies.filter(c => !!c.classifications?.[icpFilter]?.is_match === want);
        }
        // reviewStatus filter - drives the Accounts page lane tabs. Only
        // meaningful when an ICP is also set (reviews are per-ICP). Three
        // values:
        //   pending   - classifier said is_match AND no review yet
        //   confirmed - review.decision === 'confirmed'
        //   rejected  - review.decision === 'rejected'
        // The pending bucket intentionally excludes classifier-rejected
        // companies (is_match: false) because those aren't "to review" -
        // they're already filtered out by the classifier.
        const reviewStatus = req.query.reviewStatus;
        if (reviewStatus && icpFilter) {
            const status = String(reviewStatus).toLowerCase();
            companies = companies.filter(c => {
                const cls = c.classifications?.[icpFilter];
                const rev = c.reviews?.[icpFilter];
                if (status === 'pending') {
                    return cls?.is_match === true && !rev;
                }
                if (status === 'confirmed') return rev?.decision === 'confirmed';
                if (status === 'rejected') return rev?.decision === 'rejected';
                return true;
            });
        }

        res.json({ success: true, companies });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/companies/:id/reviews/:icpId - sales-rep confirms or rejects
// a pre-classified company under one ICP. Body shape:
//   { decision: 'confirmed' | 'rejected', reason?: string, note?: string }
router.post('/:id/reviews/:icpId', async (req, res) => {
    try {
        const { decision, reason, note } = req.body || {};
        const updated = await setReviewForIcp(req.params.id, req.params.icpId, { decision, reason, note });
        if (!updated) {
            console.warn(`[Reviews] ✗ ${decision} id=${req.params.id} icp=${req.params.icpId}: company not found`);
            return res.status(404).json({ success: false, error: 'company not found' });
        }
        const icon = decision === 'confirmed' ? '✓' : '✗';
        console.log(`[Reviews] ${icon} ${decision.toUpperCase()} domain="${updated.domain}" icp=${req.params.icpId}${reason ? ` reason="${reason}"` : ''}${note ? ` note="${note.slice(0, 60)}"` : ''}`);
        res.json({ success: true, company: updated });
    } catch (err) {
        console.warn(`[Reviews] ✗ failed id=${req.params.id} icp=${req.params.icpId}: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
});

// DELETE /api/companies/:id/reviews/:icpId - undo a review.
router.delete('/:id/reviews/:icpId', async (req, res) => {
    try {
        const updated = await clearReviewForIcp(req.params.id, req.params.icpId);
        if (!updated) {
            console.warn(`[Reviews] ✗ UNDO id=${req.params.id} icp=${req.params.icpId}: company not found`);
            return res.status(404).json({ success: false, error: 'company not found' });
        }
        console.log(`[Reviews] ↻ UNDO domain="${updated.domain}" icp=${req.params.icpId} (back to Pending)`);
        res.json({ success: true, company: updated });
    } catch (err) {
        console.warn(`[Reviews] ✗ UNDO failed id=${req.params.id} icp=${req.params.icpId}: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/companies/verticals - distinct verticals, sorted. Used to
// populate the "Vertical" filter dropdown on the database page.
router.get('/verticals', async (_req, res) => {
    try {
        res.json({ success: true, verticals: await listVerticals() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/companies/:id - single record
router.get('/:id', async (req, res) => {
    try {
        const data = await readAll();
        const company = data.companies.find(c => c.id === req.params.id);
        if (!company) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, company });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE /api/companies/:id - clear a record (handy for demo resets)
router.delete('/:id', async (req, res) => {
    try {
        const data = await readAll();
        const before = data.companies.length;
        data.companies = data.companies.filter(c => c.id !== req.params.id);
        await writeAll(data);
        res.json({ success: true, removed: before - data.companies.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
module.exports.upsertCompany = upsertCompany;
module.exports.attachLeads = attachLeads;
module.exports.upsertLeadInCompany = upsertLeadInCompany;
module.exports.setClassificationForIcp = setClassificationForIcp;
module.exports.setReviewForIcp = setReviewForIcp;
module.exports.clearReviewForIcp = clearReviewForIcp;
module.exports.listByVertical = listByVertical;
module.exports.listVerticals = listVerticals;
module.exports.isDemoRecord = isDemoRecord;
