// JSON-file persistence for the sourcing pipeline.
// Lives at api/data/sources.json, sibling to companies.json.
//
// Two top-level keys:
//   - scans[]:        append-only history of every Search-API call. Each
//                     scan keeps the raw filtered+normalized results so
//                     reopening a past scan doesn't re-burn 5 credits.
//   - placeDetails{}: lookup cache keyed by Scrapingdog data_id, populated
//                     only when the user clicks "Get details" on a row.
//                     Same logic as scans - re-clicking a previously-detailed
//                     row should be free, not another 5 credits.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isEnabled, getClient } = require('../db');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sources.json');

const toMs = (ts) => (ts ? new Date(ts).getTime() : null);

function scanRowToObj(s) {
    return {
        id: s.id, city: s.city, country: s.country, ll: s.ll, query: s.query, page: s.page,
        ranAt: toMs(s.ran_at), totalRaw: s.total_raw,
        chainsFiltered: s.chains_filtered, nonTargetFiltered: s.non_target_filtered,
        results: Array.isArray(s.results) ? s.results : [],
    };
}

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify({ scans: [], placeDetails: {} }, null, 2));
    }
}

async function readAll() {
    ensureFile();
    const raw = await fs.promises.readFile(FILE, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        // Normalize shape so callers don't need defensive checks.
        if (!Array.isArray(parsed.scans)) parsed.scans = [];
        if (!parsed.placeDetails || typeof parsed.placeDetails !== 'object') parsed.placeDetails = {};
        return parsed;
    } catch {
        return { scans: [], placeDetails: {} };
    }
}

async function writeAll(data) {
    ensureFile();
    await fs.promises.writeFile(FILE, JSON.stringify(data, null, 2));
}

/**
 * Append a fresh scan to the history. Returns the saved record (with id).
 * Trims the scans array to the most recent 50 so the file doesn't grow
 * unbounded during a heavy demo session.
 */
async function appendScan({ city, country, ll, query, page, results, totalRaw, chainsFiltered, nonTargetFiltered }) {
    if (isEnabled()) {
        const scan = { id: crypto.randomUUID(), city, country, ll, query, page, ranAt: Date.now(), totalRaw, chainsFiltered, nonTargetFiltered, results: results || [] };
        const { error } = await getClient().from('scans').insert({
            id: scan.id, city: city ?? null, country: country ?? null, ll: ll ?? null,
            query: query ?? null, page: page ?? null, ran_at: new Date(scan.ranAt).toISOString(),
            total_raw: totalRaw ?? null, chains_filtered: chainsFiltered ?? null,
            non_target_filtered: nonTargetFiltered ?? null, results: results || [],
        });
        if (error) throw new Error(`appendScan: ${error.message}`);
        return scan;
    }
    const data = await readAll();
    const scan = {
        id: crypto.randomUUID(),
        city,
        country,
        ll,
        query,
        page,
        ranAt: Date.now(),
        totalRaw,
        chainsFiltered,
        nonTargetFiltered,
        results: results || [],
    };
    data.scans.unshift(scan);
    if (data.scans.length > 50) data.scans = data.scans.slice(0, 50);
    await writeAll(data);
    return scan;
}

async function getScan(id) {
    if (isEnabled()) {
        const { data } = await getClient().from('scans').select('*').eq('id', id).maybeSingle();
        return data ? scanRowToObj(data) : null;
    }
    const data = await readAll();
    return data.scans.find(s => s.id === id) || null;
}

async function listScans({ limit = 20 } = {}) {
    if (isEnabled()) {
        const { data } = await getClient().from('scans').select('*').order('ran_at', { ascending: false }).limit(limit);
        return (data || []).map(s => ({
            id: s.id, city: s.city, country: s.country, query: s.query, page: s.page,
            ranAt: toMs(s.ran_at), totalRaw: s.total_raw,
            keptCount: Array.isArray(s.results) ? s.results.length : 0,
            chainsFiltered: s.chains_filtered, nonTargetFiltered: s.non_target_filtered,
        }));
    }
    const data = await readAll();
    return data.scans.slice(0, limit).map(s => ({
        id: s.id,
        city: s.city,
        country: s.country,
        query: s.query,
        page: s.page,
        ranAt: s.ranAt,
        totalRaw: s.totalRaw,
        keptCount: s.results?.length || 0,
        chainsFiltered: s.chainsFiltered,
        nonTargetFiltered: s.nonTargetFiltered,
    }));
}

async function getPlaceDetails(dataId) {
    if (isEnabled()) {
        const { data } = await getClient().from('place_details').select('*').eq('data_id', dataId).maybeSingle();
        return data ? { fetchedAt: toMs(data.fetched_at), data: data.data } : null;
    }
    const data = await readAll();
    return data.placeDetails[dataId] || null;
}

async function setPlaceDetails(dataId, payload) {
    if (isEnabled()) {
        const now = Date.now();
        const { error } = await getClient().from('place_details').upsert(
            { data_id: dataId, fetched_at: new Date(now).toISOString(), data: payload },
            { onConflict: 'data_id' },
        );
        if (error) throw new Error(`setPlaceDetails: ${error.message}`);
        return { fetchedAt: now, data: payload };
    }
    const data = await readAll();
    data.placeDetails[dataId] = {
        fetchedAt: Date.now(),
        data: payload,
    };
    await writeAll(data);
    return data.placeDetails[dataId];
}

module.exports = {
    appendScan,
    getScan,
    listScans,
    getPlaceDetails,
    setPlaceDetails,
};
