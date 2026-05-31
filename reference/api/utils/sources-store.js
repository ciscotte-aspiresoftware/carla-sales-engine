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

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sources.json');

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
    const data = await readAll();
    return data.scans.find(s => s.id === id) || null;
}

async function listScans({ limit = 20 } = {}) {
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
    const data = await readAll();
    return data.placeDetails[dataId] || null;
}

async function setPlaceDetails(dataId, payload) {
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
