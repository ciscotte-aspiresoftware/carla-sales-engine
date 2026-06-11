// Search-term log - tracks which Scrapingdog Maps queries we've already
// submitted for a given (vertical, geography, search-term) combination.
//
// Why this exists: when two ICPs share a vertical AND a geography, they
// also tend to share search terms. Carla and Thermeon both want
// "car rental" results in London. Without dedup, both ICPs' sweeps pay
// Scrapingdog credits for the same query at the same coordinates. With
// dedup, the second ICP's sweep skips the duplicate term and only pays
// for the terms it adds (e.g. "exotic car hire").
//
// Companion to scrape-cache.js - that one dedupes Firecrawl scrapes by
// domain. This one dedupes Scrapingdog Maps searches by (vertical, area,
// term). Together they make adding a same-vertical ICP nearly free.
//
// Geography is bucketed to ~1km (lat/lng rounded to 0.01°). Two cells
// less than 1km apart are treated as the same area for dedup purposes;
// running the same query at two near-identical coordinates would have
// returned overlapping results anyway, so we skip the second.
//
// File layout: api/data/search-log.json - single flat-key map for cheap
// lookup. Keys are pipe-separated tuples; values are { ranAt, cellId,
// resultCount } for diagnostic auditing.

const fs = require('fs');
const path = require('path');
const { isEnabled, getClient } = require('../db');

const FILE = path.resolve(__dirname, '..', 'data', 'search-log.json');

// Round to 0.01° (~1km lat, varies by latitude for lng but close enough).
// Two queries at coordinates within this bucket return effectively the
// same Maps results, so caching at this resolution is safe.
function bucket(latlng) {
    if (!Number.isFinite(latlng)) return 0;
    return Math.round(latlng * 100) / 100;
}

// Normalize term so casing/whitespace differences don't create duplicate
// log entries. "Car Rental" and "car rental" should be treated as one
// query for dedup purposes.
function normalizeTerm(t) {
    return String(t || '').trim().toLowerCase();
}

function buildKey(vertical, lat, lng, term) {
    const v = String(vertical || '').toLowerCase();
    return `${v}|${bucket(lat)}|${bucket(lng)}|${normalizeTerm(term)}`;
}

// Lazy-loaded in-memory mirror. Reads come back from memory after first
// load; writes flush through to disk so a process crash mid-sweep doesn't
// lose the search log (would cause duplicate Scrapingdog calls on retry).
let memCache = null;
function load() {
    if (memCache) return memCache;
    if (!fs.existsSync(FILE)) {
        memCache = {};
        return memCache;
    }
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        memCache = JSON.parse(raw);
        if (typeof memCache !== 'object' || memCache === null) memCache = {};
    } catch {
        memCache = {};
    }
    return memCache;
}

function save() {
    if (!memCache) return;
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic-ish write - same rename trick scrape-cache uses.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memCache, null, 2));
    fs.renameSync(tmp, FILE);
}

// Boot-load the dedup map from Supabase (overwrites the JSON-seeded cache).
// Re-applies bucket() to the DB numeric so the in-memory key format exactly
// matches buildKey(). Paginated past PostgREST's 1000-row cap.
async function hydrateFromSupabase() {
    try {
        const sb = getClient();
        const pageSize = 1000;
        const map = {};
        for (let from = 0; ; from += pageSize) {
            const { data, error } = await sb.from('search_log').select('*').range(from, from + pageSize - 1);
            if (error) { console.warn('[SearchLog] hydrate failed:', error.message); return; }
            for (const r of data || []) {
                const key = `${r.vertical}|${bucket(Number(r.lat_bucket))}|${bucket(Number(r.lng_bucket))}|${r.term}`;
                map[key] = { ranAt: r.ran_at ? new Date(r.ran_at).getTime() : Date.now(), cellId: r.cell_id, icpId: r.icp_id, resultCount: r.result_count };
            }
            if (!data || data.length < pageSize) break;
        }
        memCache = map;
    } catch (e) {
        console.warn('[SearchLog] hydrate threw:', e.message);
    }
}
if (isEnabled()) hydrateFromSupabase();

// True if this exact (vertical, area, term) tuple was logged. Callers
// use this to decide whether to skip a Scrapingdog call.
function has(vertical, lat, lng, term) {
    if (!vertical || !term) return false;
    return Object.prototype.hasOwnProperty.call(load(), buildKey(vertical, lat, lng, term));
}

// Log a successful run. `meta` is free-form (cellId, resultCount, etc.)
// - used for audit/debug, not consulted on lookup.
function add(vertical, lat, lng, term, meta = {}) {
    if (!vertical || !term) return;
    const cache = load();
    cache[buildKey(vertical, lat, lng, term)] = { ranAt: Date.now(), ...meta };
    if (isEnabled()) {
        // Write-through (fire-and-forget). A lost entry just risks one
        // duplicate Scrapingdog call later, never data loss - so non-fatal.
        const row = {
            vertical: String(vertical).toLowerCase(),
            lat_bucket: bucket(lat),
            lng_bucket: bucket(lng),
            term: normalizeTerm(term),
            ran_at: new Date().toISOString(),
            cell_id: meta.cellId || null,
            icp_id: meta.icpId || null,
            result_count: typeof meta.resultCount === 'number' ? meta.resultCount : null,
        };
        getClient().from('search_log').upsert(row, { onConflict: 'vertical,lat_bucket,lng_bucket,term' })
            .then(({ error }) => { if (error) console.warn('[SearchLog] supabase write failed:', error.message); })
            .catch((e) => console.warn('[SearchLog] supabase write threw:', e.message));
    } else {
        save();
    }
    console.log(`[SearchLog] LOG vertical="${vertical}" area=(${bucket(lat)},${bucket(lng)}) term="${term}"${meta.icpId ? ` icp=${meta.icpId}` : ''}${typeof meta.resultCount === 'number' ? ` results=${meta.resultCount}` : ''}`);
}

// Diff helper - given an ICP's full search-term list, return only the
// terms we haven't already run for this (vertical, area). Used by the
// sweep pipeline to compute the credit-saving subset.
function unmatchedTerms(vertical, lat, lng, terms) {
    if (!vertical || !Array.isArray(terms)) return terms || [];
    return terms.filter((t) => !has(vertical, lat, lng, t));
}

function clearAll() {
    memCache = {};
    if (isEnabled()) {
        getClient().from('search_log').delete().neq('vertical', '')
            .then(({ error }) => { if (error) console.warn('[SearchLog] supabase clearAll failed:', error.message); })
            .catch((e) => console.warn('[SearchLog] supabase clearAll threw:', e.message));
        return;
    }
    save();
}

module.exports = { has, add, unmatchedTerms, clearAll };
