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
const { isEnabled, getClient } = require('../db');

// ─── Supabase persistence layer ────────────────────────────────────────────
// When USE_SUPABASE is on, reads/writes go to Postgres instead of the JSON
// file. We keep every exported function's signature + return shape identical
// (timestamps handed back as epoch-ms, the nested {classifications, reviews,
// leads} company shape rebuilt from the 4 tables) so the routes + frontend
// don't change. JSON remains the fallback when the flag is off.

const toMs = (ts) => (ts ? new Date(ts).getTime() : null);
const toIso = (ms) => (ms != null && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

// Typed classification columns; everything else round-trips through `details`.
// `definitionHash` lives in its own column too (migration 0005) so the
// reclassify-targets endpoint can server-side compare current vs stored hash
// without touching the details JSON.
const CLS_TYPED = new Set(['is_match', 'reason', 'title', 'phone', 'address', 'rating', 'reviews', 'report', 'classifiedAt', 'definitionHash']);

function companyRowToBase(r) {
    return {
        id: r.id,
        url: r.url || null,
        domain: r.domain || null,
        vertical: r.vertical || null,
        city: r.city || null,
        classification: null,
        classifications: {},
        reviews: {},
        scrapedAt: toMs(r.scraped_at) || 0,
        source: r.source ?? null,
        location: (r.lat != null && r.lng != null) ? { lat: r.lat, lng: r.lng } : null,
        scrapedContacts: r.scraped_contacts ?? null,
        createdAt: toMs(r.created_at) || 0,
        updatedAt: toMs(r.updated_at) || 0,
        leadsUpdatedAt: toMs(r.leads_updated_at),
        leads: [],
    };
}

function clsRowToEntry(r) {
    const entry = { ...(r.details || {}) };          // overridden/overriddenAt/placeId/legacy rich fields
    entry.is_match = r.is_match;                       // keep null/true/false
    if (r.reason != null) entry.reason = r.reason;
    if (r.title != null) entry.title = r.title;
    if (r.phone != null) entry.phone = r.phone;
    if (r.address != null) entry.address = r.address;
    if (r.rating != null) entry.rating = Number(r.rating);
    if (r.reviews != null) entry.reviews = r.reviews;
    if (r.report != null) entry.report = r.report;
    // Hash of the ICP's classifyPrompt at the moment this verdict was
    // written. NULL on legacy rows (pre-migration 0005). The reclassify-
    // targets endpoint compares this against the ICP's CURRENT hash to
    // flag stale verdicts in one shot.
    if (r.definition_hash != null) entry.definitionHash = r.definition_hash;
    entry.classifiedAt = toMs(r.classified_at) || Date.now();
    return entry;
}

function clsEntryToRow(companyId, icpId, entry) {
    const details = {};
    for (const k of Object.keys(entry)) if (!CLS_TYPED.has(k)) details[k] = entry[k];
    return {
        company_id: companyId,
        icp_id: icpId,
        is_match: entry.is_match ?? null,
        reason: entry.reason ?? null,
        title: entry.title ?? null,
        phone: entry.phone ?? null,
        address: entry.address ?? null,
        rating: entry.rating ?? null,
        reviews: entry.reviews ?? null,
        report: entry.report ?? null,
        definition_hash: entry.definitionHash || null,
        details: Object.keys(details).length ? details : null,
        classified_at: toIso(entry.classifiedAt) || new Date().toISOString(),
    };
}

function reviewRowToEntry(r) {
    return { decision: r.decision, reason: r.reason || null, note: r.note || null, reviewedAt: toMs(r.reviewed_at) || Date.now() };
}

function leadRowToEntry(r) {
    return {
        apolloId: r.apollo_id || null,
        firstName: r.first_name || '',
        lastName: r.last_name || '',
        title: r.title || '',
        email: r.email || null,
        emailStatus: r.email_status || null,
        linkedinUrl: r.linkedin_url || null,
        phone: r.phone || null,
        hasEmail: !!r.has_email,
        enriched: !!r.enriched,
        enrichedAt: toMs(r.enriched_at),
        phoneCheckedAt: toMs(r.phone_checked_at),
        liSummary: r.li_summary ?? null,
        liPosts: r.li_posts ?? null,
        liScrapedAt: toMs(r.li_scraped_at),
        addedAt: toMs(r.added_at) || undefined,
    };
}

function leadEntryToRow(companyId, l) {
    return {
        company_id: companyId,
        apollo_id: l.apolloId || null,
        first_name: l.firstName || null,
        last_name: l.lastName || null,
        title: l.title || null,
        email: l.email || null,
        email_status: l.emailStatus || null,
        linkedin_url: l.linkedinUrl || null,
        phone: l.phone || null,
        has_email: !!l.hasEmail,
        enriched: !!l.enriched,
        enriched_at: toIso(l.enrichedAt),
        phone_checked_at: toIso(l.phoneCheckedAt),
        li_summary: l.liSummary ?? null,
        li_posts: l.liPosts ?? null,
        li_scraped_at: toIso(l.liScrapedAt),
        added_at: toIso(l.addedAt) || new Date().toISOString(),
    };
}

// Pin the most-recently-classified entry as the legacy `classification` field.
function pinLatest(base) {
    let latest = null, latestAt = -1;
    for (const e of Object.values(base.classifications)) {
        const t = e.classifiedAt || 0;
        if (t >= latestAt) { latestAt = t; latest = e; }
    }
    base.classification = latest;
    return base;
}

async function upsertClassificationRow(sb, companyId, icpId, entry) {
    await sb.from('company_classifications').upsert(clsEntryToRow(companyId, icpId, entry), { onConflict: 'company_id,icp_id' });
}

async function touchCompany(sb, id, extra = {}) {
    await sb.from('companies').update({ updated_at: new Date().toISOString(), ...extra }).eq('id', id);
}

// Fetch every row from a table, paging past PostgREST's 1000-row cap so a
// growing table never silently truncates (JSON had no such limit).
async function selectAllRows(sb, table) {
    const pageSize = 1000;
    const out = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
        if (error) throw new Error(`${table}: ${error.message}`);
        out.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return out;
}

// Assemble the full nested dataset from the 4 tables, newest company first.
async function readAllSupabase() {
    const sb = getClient();
    const [comps, cls, rev, leads] = await Promise.all([
        selectAllRows(sb, 'companies'),
        selectAllRows(sb, 'company_classifications'),
        selectAllRows(sb, 'company_reviews'),
        selectAllRows(sb, 'leads'),
    ]);
    const byId = new Map();
    const companies = comps.map((r) => { const b = companyRowToBase(r); byId.set(r.id, b); return b; });
    for (const r of cls) { const b = byId.get(r.company_id); if (b) b.classifications[r.icp_id] = clsRowToEntry(r); }
    for (const r of rev) { const b = byId.get(r.company_id); if (b) b.reviews[r.icp_id] = reviewRowToEntry(r); }
    for (const r of leads) { const b = byId.get(r.company_id); if (b) b.leads.push(leadRowToEntry(r)); }
    for (const b of companies) pinLatest(b);
    companies.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { companies };
}

// Assemble a single company by id (used by mutations that must return the
// full updated record).
async function getCompanyByIdSupabase(id) {
    const sb = getClient();
    const [c, cls, rev, leads] = await Promise.all([
        sb.from('companies').select('*').eq('id', id).maybeSingle(),
        sb.from('company_classifications').select('*').eq('company_id', id),
        sb.from('company_reviews').select('*').eq('company_id', id),
        sb.from('leads').select('*').eq('company_id', id),
    ]);
    if (!c.data) return null;
    const base = companyRowToBase(c.data);
    for (const r of cls.data || []) base.classifications[r.icp_id] = clsRowToEntry(r);
    for (const r of rev.data || []) base.reviews[r.icp_id] = reviewRowToEntry(r);
    base.leads = (leads.data || []).map(leadRowToEntry);
    return pinLatest(base);
}

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
    if (isEnabled()) return await readAllSupabase();
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
    scrapedContacts,
}) {
    if (isEnabled()) {
        const sb = getClient();
        const now = Date.now();
        const key = (domain || '').toLowerCase();
        let existing = null;
        if (key) {
            const { data } = await sb.from('companies').select('*').eq('domain', key).maybeSingle();
            existing = data || null;
        }
        let companyId;
        if (existing) {
            companyId = existing.id;
            const patch = { updated_at: new Date(now).toISOString() };
            if (url) patch.url = url;
            if (scrapedAt) patch.scraped_at = new Date(scrapedAt).toISOString();
            if (vertical && !existing.vertical) patch.vertical = vertical;     // sticky
            if (city && !existing.city) patch.city = city;                     // sticky
            if (source && !existing.source) patch.source = source;             // preserve origin
            if (location && Number.isFinite(location.lat) && Number.isFinite(location.lng)) { patch.lat = location.lat; patch.lng = location.lng; }
            if (scrapedContacts) patch.scraped_contacts = { ...scrapedContacts, extractedAt: now };
            await sb.from('companies').update(patch).eq('id', companyId);
        } else {
            companyId = crypto.randomUUID();
            await sb.from('companies').insert({
                id: companyId,
                url: url || null,
                domain: domain || null,
                vertical: vertical || null,
                city: city || null,
                lat: (location && Number.isFinite(location.lat)) ? location.lat : null,
                lng: (location && Number.isFinite(location.lng)) ? location.lng : null,
                source: source ?? null,
                scraped_at: new Date(scrapedAt || now).toISOString(),
                scraped_contacts: scrapedContacts ? { ...scrapedContacts, extractedAt: now } : null,
                created_at: new Date(now).toISOString(),
                updated_at: new Date(now).toISOString(),
            });
        }
        let entry = null;
        if (icpId) {
            entry = { ...classification, classifiedAt: now };
            await upsertClassificationRow(sb, companyId, icpId, entry);
        }
        return { id: companyId, url, domain, classifications: entry ? { [icpId]: entry } : {}, classification: entry };
    }
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
        // Contacts harvested from the scraped site (emails/phones/LinkedIn).
        // Refresh on every write that carries them - a later crawl-mode
        // scrape finds more than a homepage-only scrape, so newer wins.
        if (scrapedContacts) {
            existing.scrapedContacts = { ...scrapedContacts, extractedAt: now };
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
            scrapedContacts: scrapedContacts ? { ...scrapedContacts, extractedAt: now } : null,
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
    if (isEnabled()) {
        const sb = getClient();
        const key = String(domain).toLowerCase();
        const { data: comp } = await sb.from('companies').select('id').eq('domain', key).maybeSingle();
        if (!comp) return null;
        const entry = { ...classification, classifiedAt: Date.now() };
        await upsertClassificationRow(sb, comp.id, icpId, entry);
        await touchCompany(sb, comp.id);
        return { id: comp.id, domain: key, classifications: { [icpId]: entry }, classification: entry };
    }
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

// Manually override a per-ICP verdict to qualified. Used by the Sales
// Agent when the rep disagrees with a `not qualified` classification - they
// can flip the company to classified for THAT specific ICP (other ICPs are
// untouched). Keyed by company id (the Sales Agent has it from the classify
// response). Preserves the original reason for the record but stamps
// `overridden: true` + `overriddenAt` so the UI can flag it as a human call
// rather than a model verdict. Returns the updated company, or null if not
// found.
async function overrideClassificationForIcp(id, icpId) {
    if (!id || !icpId) return null;
    if (isEnabled()) {
        const sb = getClient();
        const { data: row } = await sb.from('company_classifications').select('*').eq('company_id', id).eq('icp_id', icpId).maybeSingle();
        const existing = row ? clsRowToEntry(row) : {};
        const entry = { ...existing, is_match: true, overridden: true, overriddenAt: Date.now(), classifiedAt: existing.classifiedAt || Date.now() };
        await upsertClassificationRow(sb, id, icpId, entry);
        await touchCompany(sb, id);
        return await getCompanyByIdSupabase(id);
    }
    const data = await readAll();
    const company = data.companies.find(c => c.id === id);
    if (!company) return null;
    company.classifications = company.classifications || {};
    const existing = company.classifications[icpId] || {};
    const entry = {
        ...existing,
        is_match: true,
        overridden: true,
        overriddenAt: Date.now(),
        classifiedAt: existing.classifiedAt || Date.now(),
    };
    company.classifications[icpId] = entry;
    company.classification = entry; // pin latest
    company.updatedAt = Date.now();
    await writeAll(data);
    return company;
}

// Patch ONLY the markdown report on a company's per-ICP classification,
// preserving is_match/reason/title/etc. Used by the on-demand "Generate
// report" button so a backfill doesn't clobber the existing verdict.
// Keyed by company id (the drawer has it) rather than domain. Returns the
// updated company, or null if the company/classification isn't found.
async function setReportForIcp(id, icpId, report) {
    if (!id || !icpId) return null;
    if (isEnabled()) {
        const sb = getClient();
        const { data: row } = await sb.from('company_classifications').select('company_id').eq('company_id', id).eq('icp_id', icpId).maybeSingle();
        if (row) {
            await sb.from('company_classifications').update({ report }).eq('company_id', id).eq('icp_id', icpId);
        } else {
            await sb.from('company_classifications').upsert(
                { company_id: id, icp_id: icpId, report, classified_at: new Date().toISOString() },
                { onConflict: 'company_id,icp_id' },
            );
        }
        await touchCompany(sb, id);
        return await getCompanyByIdSupabase(id);
    }
    const data = await readAll();
    const company = data.companies.find(c => c.id === id);
    if (!company) return null;
    company.classifications = company.classifications || {};
    if (!company.classifications[icpId]) company.classifications[icpId] = {};
    company.classifications[icpId].report = report;
    // If the pinned legacy classification is this ICP's, mirror the report
    // there too so display surfaces that read `classification` see it.
    if (company.classification) company.classification.report = report;
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
    if (isEnabled()) {
        const sb = getClient();
        const { data: comp } = await sb.from('companies').select('id').eq('id', id).maybeSingle();
        if (!comp) return null;
        await sb.from('company_reviews').upsert({
            company_id: id,
            icp_id: icpId,
            decision,
            reason: (reason || '').trim() || null,
            note: (note || '').trim() || null,
            reviewed_at: new Date().toISOString(),
        }, { onConflict: 'company_id,icp_id' });
        await touchCompany(sb, id);
        return await getCompanyByIdSupabase(id);
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
    if (isEnabled()) {
        const sb = getClient();
        await sb.from('company_reviews').delete().eq('company_id', id).eq('icp_id', icpId);
        await touchCompany(sb, id);
        return await getCompanyByIdSupabase(id);
    }
    const data = await readAll();
    const company = data.companies.find(c => c.id === id);
    if (!company || !company.reviews || !company.reviews[icpId]) return company || null;
    delete company.reviews[icpId];
    company.updatedAt = Date.now();
    await writeAll(data);
    return company;
}

// Merge incoming (search-only) leads over prior records, preserving any
// enrichment + LI cache already saved. Shared by both the JSON and Supabase
// paths so the dedupe/preserve behaviour is identical.
function mergeLeads(priorLeads, incoming, now) {
    const prevByKey = new Map();
    for (const l of Array.isArray(priorLeads) ? priorLeads : []) {
        const key = l.apolloId || l.email;
        if (key) prevByKey.set(key, l);
    }
    const merged = (incoming || []).map((l) => {
        const key = l.apolloId || l.email;
        const prior = key ? prevByKey.get(key) : null;
        if (!prior) return { ...l, addedAt: l.addedAt || now };
        return {
            ...l,
            email: l.email || prior.email || null,
            emailStatus: l.emailStatus || prior.emailStatus || null,
            linkedinUrl: l.linkedinUrl || prior.linkedinUrl || null,
            phone: l.phone || prior.phone || null,
            hasEmail: l.hasEmail || prior.hasEmail || !!prior.email,
            enriched: prior.enriched || l.enriched || false,
            enrichedAt: prior.enrichedAt || l.enrichedAt || null,
            liSummary: prior.liSummary != null ? prior.liSummary : (l.liSummary ?? null),
            liPosts: prior.liPosts != null ? prior.liPosts : (l.liPosts ?? null),
            liScrapedAt: prior.liScrapedAt || l.liScrapedAt || null,
            phoneCheckedAt: prior.phoneCheckedAt || l.phoneCheckedAt || null,
            addedAt: prior.addedAt || l.addedAt || now,
        };
    });
    const mergedKeys = new Set(merged.map((l) => l.apolloId || l.email).filter(Boolean));
    for (const [key, prior] of prevByKey) {
        if (mergedKeys.has(key)) continue;
        if (prior.enriched || prior.email || prior.liScrapedAt) merged.push(prior);
    }
    return merged;
}

async function attachLeads(companyId, leads) {
    if (isEnabled()) {
        const sb = getClient();
        const now = Date.now();
        const { data: comp } = await sb.from('companies').select('id').eq('id', companyId).maybeSingle();
        if (!comp) return null;
        const { data: priorRows } = await sb.from('leads').select('*').eq('company_id', companyId);
        const prior = (priorRows || []).map(leadRowToEntry);
        const merged = mergeLeads(prior, leads, now);
        // Replace this company's lead set: clear then re-insert the merged
        // list (small N per company; keeps the row set exactly in sync).
        await sb.from('leads').delete().eq('company_id', companyId);
        if (merged.length) await sb.from('leads').insert(merged.map((l) => leadEntryToRow(companyId, l)));
        await touchCompany(sb, companyId, { leads_updated_at: new Date(now).toISOString() });
        return await getCompanyByIdSupabase(companyId);
    }
    const data = await readAll();
    const company = data.companies.find(c => c.id === companyId);
    if (!company) return null;
    const now = Date.now();
    // Map prior leads by key (apolloId, email fallback) so a re-search -
    // which returns SEARCH-ONLY rows (no email/LI, enriched:false) - never
    // wipes enrichment + LinkedIn cache a previous email-gen or manual
    // enrich already saved. Without this, re-opening Sales Agent for a
    // company (or any second lead fetch) silently downgrades enriched
    // leads back to unenriched.
    const prevByKey = new Map();
    for (const l of Array.isArray(company.leads) ? company.leads : []) {
        const key = l.apolloId || l.email;
        if (key) prevByKey.set(key, l);
    }

    // Merge each incoming lead over its prior record: fresh search identity
    // wins for basic fields, but enrichment is preserved (a null email from
    // the search must not clobber a verified email from a prior enrich).
    const merged = (leads || []).map(l => {
        const key = l.apolloId || l.email;
        const prior = key ? prevByKey.get(key) : null;
        if (!prior) return { ...l, addedAt: l.addedAt || now };
        return {
            ...l,
            email:          l.email || prior.email || null,
            emailStatus:    l.emailStatus || prior.emailStatus || null,
            linkedinUrl:    l.linkedinUrl || prior.linkedinUrl || null,
            phone:          l.phone || prior.phone || null,
            hasEmail:       l.hasEmail || prior.hasEmail || !!prior.email,
            enriched:       prior.enriched || l.enriched || false,
            enrichedAt:     prior.enrichedAt || l.enrichedAt || null,
            // LinkedIn scrape cache - keep prior when present.
            liSummary:      prior.liSummary != null ? prior.liSummary : (l.liSummary ?? null),
            liPosts:        prior.liPosts != null ? prior.liPosts : (l.liPosts ?? null),
            liScrapedAt:    prior.liScrapedAt || l.liScrapedAt || null,
            phoneCheckedAt: prior.phoneCheckedAt || l.phoneCheckedAt || null,
            addedAt:        prior.addedAt || l.addedAt || now,
        };
    });

    // Don't drop a lead the rep already invested in. If a previously
    // enriched/contacted lead isn't in the new search results, keep it
    // rather than letting a re-search silently delete it.
    const mergedKeys = new Set(merged.map(l => l.apolloId || l.email).filter(Boolean));
    for (const [key, prior] of prevByKey) {
        if (mergedKeys.has(key)) continue;
        if (prior.enriched || prior.email || prior.liScrapedAt) merged.push(prior);
    }

    company.leads = merged;
    company.leadsUpdatedAt = now;
    await writeAll(data);
    return company;
}

async function upsertLeadInCompany(companyId, apolloId, fields) {
    if (!companyId || !apolloId) return null;
    if (isEnabled()) {
        const sb = getClient();
        const colMap = {
            firstName: 'first_name', lastName: 'last_name', title: 'title', email: 'email',
            emailStatus: 'email_status', linkedinUrl: 'linkedin_url', phone: 'phone',
            hasEmail: 'has_email', enriched: 'enriched',
        };
        const patch = {};
        for (const [k, col] of Object.entries(colMap)) if (k in fields) patch[col] = fields[k];
        if ('enrichedAt' in fields) patch.enriched_at = toIso(fields.enrichedAt);
        if ('phoneCheckedAt' in fields) patch.phone_checked_at = toIso(fields.phoneCheckedAt);
        if ('liSummary' in fields) patch.li_summary = fields.liSummary ?? null;
        if ('liPosts' in fields) patch.li_posts = fields.liPosts ?? null;
        if ('liScrapedAt' in fields) patch.li_scraped_at = toIso(fields.liScrapedAt);
        const { data: updated, error } = await sb.from('leads')
            .update(patch).eq('company_id', companyId).eq('apollo_id', apolloId).select('*').maybeSingle();
        if (error || !updated) return null;
        await touchCompany(sb, companyId, { leads_updated_at: new Date().toISOString() });
        return leadRowToEntry(updated);
    }
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
    const target = String(vertical).toLowerCase();
    // Both paths assemble the full nested shape (reclassify needs the
    // per-ICP classifications), so we filter readAll's output either way.
    const data = await readAll();
    return data.companies.filter(c => (c.vertical || '').toLowerCase() === target);
}

// Distinct vertical strings present in the database, in alphabetical
// order. Powers the vertical dropdown in the database UI.
async function listVerticals() {
    const data = await readAll();
    const set = new Set();
    for (const c of data.companies) {
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
                if (status === 'needs-check') {
                    // The classifier couldn't render a verdict (no website to
                    // scrape, or the scrape failed) so is_match is null/undefined
                    // but a classification entry exists with the Google Maps
                    // facts. Surface these for a human to look up + decide.
                    return !!cls && cls.is_match !== true && cls.is_match !== false && !rev;
                }
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
        if (isEnabled()) {
            const sb = getClient();
            // FK cascade (on delete cascade) drops the child rows too.
            const { error, count } = await sb.from('companies').delete({ count: 'exact' }).eq('id', req.params.id);
            if (error) throw new Error(error.message);
            return res.json({ success: true, removed: count || 0 });
        }
        const data = await readAll();
        const before = data.companies.length;
        data.companies = data.companies.filter(c => c.id !== req.params.id);
        await writeAll(data);
        res.json({ success: true, removed: before - data.companies.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/companies/:id/generate-report  body: { icpId }
// On-demand markdown report for one company under one ICP. Reads the
// cached Firecrawl markdown (no re-scrape, no Scrapingdog) and runs the
// report generator, then patches classifications[icpId].report. Used by
// the "Generate report" button in the Database drawer to backfill reports
// for companies swept before the feature, or to refresh one. Uses the
// company's existing verdict for that ICP so matched→full / rejected→why.
router.post('/:id/generate-report', async (req, res) => {
    const { icpId } = req.body || {};
    if (!icpId) return res.status(400).json({ success: false, error: 'icpId required' });
    try {
        const data = await readAll();
        const company = data.companies.find(c => c.id === req.params.id);
        if (!company) return res.status(404).json({ success: false, error: 'company not found' });
        if (!company.domain) return res.status(400).json({ success: false, error: 'company has no domain to look up cached scrape' });

        const { getIcpFull } = require('../utils/icps');
        const icp = getIcpFull(icpId);
        if (!icp) return res.status(404).json({ success: false, error: `ICP "${icpId}" not found` });

        const scrapeCache = require('../utils/scrape-cache');
        const cached = await scrapeCache.get(company.domain);
        if (!cached || !cached.markdown) {
            return res.status(409).json({ success: false, error: 'No cached scrape for this company. Run a sweep on it first.' });
        }

        // Verdict for this ICP drives matched(full)/rejected(why). Fall back
        // to the pinned classification if this ICP hasn't classified it.
        const cls = (company.classifications && company.classifications[icpId]) || company.classification || {};
        const isMatch = cls.is_match === true;

        const { generateCompanyReport } = require('../utils/report-generator');
        const report = await generateCompanyReport({
            markdown: cached.markdown,
            pageTitle: cached.pageTitle,
            icp,
            isMatch,
            reason: cls.reason,
        });
        if (!report) return res.status(502).json({ success: false, error: 'Report generation returned empty' });

        const updated = await setReportForIcp(req.params.id, icpId, report);
        console.log(`[Report] ✓ generated for ${company.domain} under ${icpId} (${isMatch ? 'match' : 'reject'})`);
        res.json({ success: true, company: updated, report });
    } catch (err) {
        console.error(`[Report] generate failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/companies/:id/override-classification  body: { icpId }
// Flip a `not qualified` verdict to qualified for one ICP - the Sales
// Agent's manual override when the rep disagrees with the classifier.
// Only touches classifications[icpId]; other ICPs' verdicts are preserved.
router.post('/:id/override-classification', async (req, res) => {
    const { icpId } = req.body || {};
    if (!icpId) return res.status(400).json({ success: false, error: 'icpId required' });
    try {
        const updated = await overrideClassificationForIcp(req.params.id, icpId);
        if (!updated) {
            console.warn(`[Classify] ✗ OVERRIDE id=${req.params.id} icp=${icpId}: company not found`);
            return res.status(404).json({ success: false, error: 'company not found' });
        }
        console.log(`[Classify] ⚑ OVERRIDE domain="${updated.domain}" icp=${icpId} → qualified`);
        res.json({ success: true, company: updated });
    } catch (err) {
        console.error(`[Classify] ✗ OVERRIDE failed id=${req.params.id} icp=${icpId}: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
module.exports.upsertCompany = upsertCompany;
module.exports.attachLeads = attachLeads;
module.exports.upsertLeadInCompany = upsertLeadInCompany;
module.exports.setClassificationForIcp = setClassificationForIcp;
module.exports.overrideClassificationForIcp = overrideClassificationForIcp;
module.exports.setReportForIcp = setReportForIcp;
module.exports.setReviewForIcp = setReviewForIcp;
module.exports.clearReviewForIcp = clearReviewForIcp;
module.exports.listByVertical = listByVertical;
module.exports.listVerticals = listVerticals;
module.exports.isDemoRecord = isDemoRecord;
module.exports.readAll = readAll;
