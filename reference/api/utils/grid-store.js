// JSON-file persistence for grid sweep state.
// Lives at api/data/grid.json, sibling to sources.json + companies.json.
//
// Shape:
//   {
//     "cells": [ { id, icpId, tier, lat, lng, ll, ... } ],
//     "lastSweepAt": <ms epoch>
//   }
//
// Same async-locking pattern would be needed if multiple processes wrote
// concurrently, but BlueBird runs a single API process so a simple
// read-modify-write is fine. Each cell is a small object (~20 fields);
// even mapping the whole UK is well under 1MB.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'grid.json');

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify({ cells: [], lastSweepAt: null }, null, 2));
    }
}

async function readAll() {
    ensureFile();
    const raw = await fs.promises.readFile(FILE, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.cells)) parsed.cells = [];
        return parsed;
    } catch {
        return { cells: [], lastSweepAt: null };
    }
}

async function writeAll(data) {
    ensureFile();
    await fs.promises.writeFile(FILE, JSON.stringify(data, null, 2));
}

// Insert any cells not already present (deduped on lat+lng+icpId - same
// physical cell for the same ICP can't exist twice). Used by the seeder
// when re-seeding an existing ICP city: cells already in the store stay
// in their current state, only new sub-cells get added as `pending`.
async function addCells(newCells) {
    const data = await readAll();
    const existing = new Set(
        data.cells.map(c => `${c.icpId}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`)
    );
    let added = 0;
    for (const c of newCells) {
        const key = `${c.icpId}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
        if (existing.has(key)) continue;
        data.cells.push({
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            state: 'pending',
            placesFound: 0,
            leadsQualified: 0,
            lastScannedAt: null,
            ...c,
        });
        existing.add(key);
        added++;
    }
    await writeAll(data);
    return added;
}

async function listCells({ icpId, state } = {}) {
    const data = await readAll();
    return data.cells.filter(c =>
        (!icpId || c.icpId === icpId) &&
        (!state || c.state === state)
    );
}

async function getCell(id) {
    const data = await readAll();
    return data.cells.find(c => c.id === id) || null;
}

async function updateCell(id, updates) {
    const data = await readAll();
    const idx = data.cells.findIndex(c => c.id === id);
    if (idx < 0) return null;
    data.cells[idx] = {
        ...data.cells[idx],
        ...updates,
        updatedAt: Date.now(),
    };
    await writeAll(data);
    return data.cells[idx];
}

// Density-derived priority within a single tier. Lower number = swept
// sooner. Used to bias the credit budget toward high-yield cells when
// real-mode sessions are capped (BLUEBIRD_SWEEP_BUDGET=2 by default).
//
//   urban     → 1  (highest population density, best ROI per Scrapingdog call)
//   airport   → 2  (anchor hubs - very relevant for vehicle/fleet ICPs;
//                   airports skipped entirely for ICPs that toggle them off)
//   suburban  → 3
//   rural     → 4
//   sparse    → 4  (rural backstop hex from genuinely empty zones)
//
// Tier-1 city-scope cells don't carry placeTier - they all return 0 here
// so they sort identically inside their tier, falling through to the
// alphabetical / createdAt tiebreakers. Country-fill cells (tier=2)
// already carry placeTier + placeSource from the seeder.
function cellPriority(cell) {
    if (cell.placeTier === 'urban') return 1;
    if (cell.placeSource === 'airport' || cell.placeTier === 'airport') return 2;
    if (cell.placeTier === 'suburban') return 3;
    if (cell.placeTier === 'rural' || cell.placeSource === 'sparse') return 4;
    return 0;
}

// Pick the next pending cell to scan. Ordering:
//   1. tier ascending (Tier-1 city cells before Tier-2 country fill)
//   2. density priority ascending (urban → airport → suburban → rural)
//   3. parent_city alphabetical (so all of London finishes before
//      Manchester starts within the same priority)
//   4. created order within a city
async function nextPendingCell(icpId) {
    const data = await readAll();
    const candidates = data.cells.filter(c =>
        c.icpId === icpId && c.state === 'pending'
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        const prCmp = cellPriority(a) - cellPriority(b);
        if (prCmp !== 0) return prCmp;
        const cityCmp = (a.parentCity || '').localeCompare(b.parentCity || '');
        if (cityCmp !== 0) return cityCmp;
        return a.createdAt - b.createdAt;
    });
    return candidates[0];
}

// Quick coverage stats per ICP - used by the dashboard. Computes counts
// per state without loading the full cell array into memory twice.
async function getCoverage(icpId) {
    const data = await readAll();
    const cells = data.cells.filter(c => c.icpId === icpId);
    const counts = { pending: 0, scanning: 0, complete: 0, empty: 0, total: cells.length };
    let placesFound = 0;
    let leadsQualified = 0;
    for (const c of cells) {
        if (counts[c.state] !== undefined) counts[c.state]++;
        placesFound += c.placesFound || 0;
        leadsQualified += c.leadsQualified || 0;
    }
    const done = counts.complete + counts.empty;
    const pct = counts.total ? Math.round((done / counts.total) * 100) : 0;
    return { ...counts, donePct: pct, placesFound, leadsQualified };
}

async function setLastSweepAt(ts) {
    const data = await readAll();
    data.lastSweepAt = ts;
    await writeAll(data);
}

// Recover any cells left in `scanning` on disk. A clean sweep flips a
// cell to `complete` or `empty` (or back to `pending` on hard error)
// before sweepCell returns — so `scanning` only persists when the
// server is killed mid-sweep (Ctrl+C, crash, host reboot). Without this
// cleanup the orphaned cells stay red on the globe forever and the cron
// won't re-pick them because nextPendingCell only looks at `pending`.
// Called once on startup.
async function rescuOrphanedScanningCells() {
    const data = await readAll();
    let rescued = 0;
    for (const c of data.cells) {
        if (c.state === 'scanning') {
            c.state = 'pending';
            c.updatedAt = Date.now();
            rescued++;
        }
    }
    if (rescued > 0) {
        await writeAll(data);
    }
    return rescued;
}

// Wipe all cells for one ICP (or all ICPs if icpId is falsy). Used by the
// "Reset all" button on the coverage page when the user wants a fresh
// demo run. Returns { removed: <int> }.
async function clearCells(icpId) {
    const data = await readAll();
    const before = data.cells.length;
    data.cells = icpId ? data.cells.filter(c => c.icpId !== icpId) : [];
    await writeAll(data);
    return { removed: before - data.cells.length };
}

module.exports = {
    rescuOrphanedScanningCells,
    addCells,
    listCells,
    getCell,
    updateCell,
    nextPendingCell,
    getCoverage,
    setLastSweepAt,
    clearCells,
};
