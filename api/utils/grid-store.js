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
const { isEnabled, getClient } = require('../db');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'grid.json');

// ─── Supabase layer (grid_cells) ────────────────────────────────────────────
const toMs = (ts) => (ts ? new Date(ts).getTime() : null);
const toIso = (ms) => (ms != null && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

// camelCase cell field → grid_cells column. `priority` is a generated column
// and is intentionally omitted (never written).
const CELL_COL = {
    icpId: 'icp_id', tier: 'tier', lat: 'lat', lng: 'lng', ll: 'll', radiusKm: 'radius_km',
    parentCity: 'parent_city', country: 'country', domain: 'domain', language: 'language',
    placeSource: 'place_source', placeTier: 'place_tier', population: 'population',
    state: 'state', placesFound: 'places_found', leadsQualified: 'leads_qualified',
    chainsFiltered: 'chains_filtered', nonTargetFiltered: 'non_target_filtered',
    alreadyKnown: 'already_known', lastScannedAt: 'last_scanned_at', lastError: 'last_error',
    // Search-term list (added in migration 0006). Stamped at sweep-completion
    // time so Coverage can later detect "ICP has new terms not in this cell's
    // list yet" and offer a targeted rescan.
    searchTerms: 'search_terms',
    // Mid-sweep pause checkpoint (added in migration 0007). When non-null
    // and the cell is `pending`, sweepCell resumes the per-company loop
    // from `nextIdx` instead of restarting from Scrapingdog. Cleared on
    // successful completion. See migration 0007 for the shape.
    pauseCheckpoint: 'pause_checkpoint',
    createdAt: 'created_at', updatedAt: 'updated_at',
};
const CELL_TS_COLS = new Set(['last_scanned_at', 'created_at', 'updated_at']);

function cellRowToObj(r) {
    // Same lazy empty→no_new split the JSON path does.
    let state = r.state;
    if (state === 'empty' && (r.places_found || 0) > 0 && r.places_found === r.already_known) state = 'no_new';
    return {
        id: r.id, icpId: r.icp_id, tier: r.tier, lat: r.lat, lng: r.lng, ll: r.ll,
        radiusKm: r.radius_km ?? null, parentCity: r.parent_city ?? null, country: r.country ?? null,
        domain: r.domain ?? null, language: r.language ?? null, placeSource: r.place_source ?? null,
        placeTier: r.place_tier ?? null, population: r.population ?? 0, state,
        placesFound: r.places_found ?? 0, leadsQualified: r.leads_qualified ?? 0,
        chainsFiltered: r.chains_filtered ?? 0, nonTargetFiltered: r.non_target_filtered ?? 0,
        alreadyKnown: r.already_known ?? 0,
        lastScannedAt: toMs(r.last_scanned_at), lastError: r.last_error ?? null,
        // Terms that were Maps'd on this cell at its last sweep. NULL on
        // legacy rows (pre-migration 0006); the Coverage staleness check
        // treats those as needing rescan if the ICP has any current terms,
        // and the next successful sweep stamps the column.
        searchTerms: Array.isArray(r.search_terms) ? r.search_terms : null,
        // Mid-sweep pause checkpoint (migration 0007). Non-null when the
        // cell is `pending` because the operator paused while a sweep was
        // in flight - sweepCell reads this on entry and resumes from
        // `nextIdx` rather than restarting Scrapingdog/filter.
        pauseCheckpoint: (r.pause_checkpoint && typeof r.pause_checkpoint === 'object') ? r.pause_checkpoint : null,
        createdAt: toMs(r.created_at) || 0, updatedAt: toMs(r.updated_at) || 0,
    };
}

function cellUpdatesToRow(updates) {
    const row = {};
    for (const [k, v] of Object.entries(updates)) {
        const col = CELL_COL[k];
        if (!col) continue;
        row[col] = CELL_TS_COLS.has(col) ? toIso(v) : v;
    }
    return row;
}

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

// lastSweepAt has no Supabase column (it was a top-level field in grid.json).
// It's purely informational, so in Supabase mode we keep it in memory
// (ephemeral - resets on restart, which is fine for a "last sweep time" stamp).
let lastSweepAtMem = null;

function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) {
        fs.writeFileSync(FILE, JSON.stringify({ cells: [], lastSweepAt: null }, null, 2));
    }
}

async function readAll() {
    if (isEnabled()) {
        const rows = await selectAllRows(getClient(), 'grid_cells');
        return { cells: rows.map(cellRowToObj), lastSweepAt: lastSweepAtMem };
    }
    ensureFile();
    const raw = await fs.promises.readFile(FILE, 'utf8');
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.cells)) parsed.cells = [];
        // Lazy migration: split the legacy `empty` state into `no_new` vs
        // `empty` using the existing placesFound + alreadyKnown counts on
        // the cell. The old code wrote `state:'empty'` for both "we
        // genuinely found nothing" and "every place was already known" -
        // visually identical grey dots in places that should have been
        // yellow ("we've already covered this area"). New writes use the
        // three-way classification directly; this catches everything
        // already on disk so the Coverage globe reflects reality
        // immediately on the next read.
        for (const c of parsed.cells) {
            if (c.state === 'empty' && (c.placesFound || 0) > 0 && c.placesFound === c.alreadyKnown) {
                c.state = 'no_new';
            }
        }
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
    if (isEnabled()) {
        const sb = getClient();
        const icpIds = [...new Set(newCells.map(c => c.icpId))];
        const existing = new Set();
        if (icpIds.length) {
            const { data } = await sb.from('grid_cells').select('icp_id,lat,lng').in('icp_id', icpIds);
            for (const r of data || []) existing.add(`${r.icp_id}|${Number(r.lat).toFixed(4)}|${Number(r.lng).toFixed(4)}`);
        }
        const now = new Date().toISOString();
        const toInsert = [];
        for (const c of newCells) {
            const key = `${c.icpId}|${c.lat.toFixed(4)}|${c.lng.toFixed(4)}`;
            if (existing.has(key)) continue;
            existing.add(key);
            toInsert.push({
                id: crypto.randomUUID(),
                icp_id: c.icpId, tier: c.tier, lat: c.lat, lng: c.lng, ll: c.ll,
                radius_km: c.radiusKm ?? null, parent_city: c.parentCity ?? null, country: c.country ?? null,
                domain: c.domain ?? null, language: c.language ?? null, place_source: c.placeSource ?? null,
                place_tier: c.placeTier ?? null, population: c.population ?? 0,
                state: c.state || 'pending', places_found: 0, leads_qualified: 0,
                chains_filtered: 0, non_target_filtered: 0, already_known: 0,
                last_scanned_at: null, created_at: now, updated_at: now,
            });
        }
        for (let i = 0; i < toInsert.length; i += 500) {
            const { error } = await sb.from('grid_cells').insert(toInsert.slice(i, i + 500));
            if (error) throw new Error(`addCells: ${error.message}`);
        }
        return toInsert.length;
    }
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
    if (isEnabled()) {
        const patch = cellUpdatesToRow(updates);
        patch.updated_at = new Date().toISOString();
        const { data, error } = await getClient().from('grid_cells').update(patch).eq('id', id).select('*').maybeSingle();
        if (error || !data) return null;
        return cellRowToObj(data);
    }
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

// Decide whether a cell falls inside the operator's currently-active scope.
// Scope shape: { type: 'city' | 'country' | 'all', value: string | null }.
// 'all' (or a null/undefined scope) means no filter - legacy behavior.
//   - city + value      → only cells with parentCity === value
//   - city + null/'all' → any Tier-1 city cell (no Tier-2 country fill)
//   - country + value   → Tier-2 cells with country === value (country fill)
//   - country + null    → any Tier-2 cell (any country fill)
function cellMatchesScope(cell, scope) {
    if (!scope || !scope.type || scope.type === 'all') return true;
    if (scope.type === 'city') {
        if (!scope.value || scope.value === 'all') return cell.tier === 1;
        return cell.parentCity === scope.value;
    }
    if (scope.type === 'country') {
        if (!scope.value) return cell.tier === 2;
        return cell.tier === 2 && cell.country === scope.value;
    }
    return true;
}

// Pick the next pending cell to scan. Ordering:
//   1. tier ascending (Tier-1 city cells before Tier-2 country fill)
//   2. density priority ascending (urban → airport → suburban → rural)
//   3. parent_city alphabetical (so all of London finishes before
//      Manchester starts within the same priority)
//   4. created order within a city
//
// The optional `scope` argument restricts candidates to one view (city or
// country fill) so the operator can pause Amsterdam, switch to a country
// fill, and have the cron pick the right queue on the next tick.
async function nextPendingCell(icpId, scope = null) {
    const data = await readAll();
    const candidates = data.cells.filter(c =>
        c.icpId === icpId && c.state === 'pending' && cellMatchesScope(c, scope)
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
    const counts = { pending: 0, scanning: 0, complete: 0, no_new: 0, empty: 0, total: cells.length };
    let placesFound = 0;
    let leadsQualified = 0;
    for (const c of cells) {
        if (counts[c.state] !== undefined) counts[c.state]++;
        placesFound += c.placesFound || 0;
        leadsQualified += c.leadsQualified || 0;
    }
    // "done" includes anything that's been visited - complete, no_new, empty.
    // Only pending + scanning are still in the queue.
    const done = counts.complete + counts.no_new + counts.empty;
    const pct = counts.total ? Math.round((done / counts.total) * 100) : 0;
    return { ...counts, donePct: pct, placesFound, leadsQualified };
}

async function setLastSweepAt(ts) {
    if (isEnabled()) { lastSweepAtMem = ts; return; }
    const data = await readAll();
    data.lastSweepAt = ts;
    await writeAll(data);
}

// Recover any cells left in `scanning` on disk. A clean sweep flips a
// cell to `complete` or `empty` (or back to `pending` on hard error)
// before sweepCell returns - so `scanning` only persists when the
// server is killed mid-sweep (Ctrl+C, crash, host reboot). Without this
// cleanup the orphaned cells stay red on the globe forever and the cron
// won't re-pick them because nextPendingCell only looks at `pending`.
// Called once on startup.
async function rescuOrphanedScanningCells() {
    if (isEnabled()) {
        const { data, error } = await getClient()
            .from('grid_cells')
            .update({ state: 'pending', updated_at: new Date().toISOString() })
            .eq('state', 'scanning')
            .select('id');
        if (error) return 0;
        return (data || []).length;
    }
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
    if (isEnabled()) {
        const sb = getClient();
        // delete requires a filter; tier >= 1 matches every cell.
        let q = sb.from('grid_cells').delete({ count: 'exact' });
        q = icpId ? q.eq('icp_id', icpId) : q.gte('tier', 0);
        const { count, error } = await q;
        if (error) throw new Error(error.message);
        return { removed: count || 0 };
    }
    const data = await readAll();
    const before = data.cells.length;
    data.cells = icpId ? data.cells.filter(c => c.icpId !== icpId) : [];
    await writeAll(data);
    return { removed: before - data.cells.length };
}

// Run the disc-conflict prune on a snapshot of an ICP's cells. PREVIEW
// mode: doesn't modify the store, just returns counts + which pending
// cells would be dropped. Completed/empty/scanning cells are always
// kept (they've either run already or are in flight) but they count as
// "accepted" for the prune so pending cells get dropped if they
// conflict with completed neighbors.
async function previewPruneForIcp(icpId, keepFactor) {
    // Late require to avoid a cycle (grid-seeder requires grid-store).
    const { pruneConflictingCells } = require('./grid-seeder');
    const data = await readAll();
    const cells = data.cells.filter(c => c.icpId === icpId);
    if (cells.length === 0) {
        return { total: 0, pending: 0, droppedPending: 0, ids: [] };
    }
    // Sort: completed/empty/scanning first, so they enter the kept list
    // before pending cells and pending cells get measured against them.
    const sorted = [
        ...cells.filter(c => c.state !== 'pending'),
        ...cells.filter(c => c.state === 'pending'),
    ];
    const { dropped } = pruneConflictingCells(sorted, { keepFactor });
    const droppedPending = dropped.filter(d => d.state === 'pending');
    return {
        total: cells.length,
        pending: cells.filter(c => c.state === 'pending').length,
        droppedPending: droppedPending.length,
        ids: droppedPending.map(d => d.id),
    };
}

// EXECUTE the prune: remove the pending cells that would be dropped.
// Returns the same shape as previewPruneForIcp + a `removed` count of
// rows actually deleted from disk.
async function prunePendingCellsForIcp(icpId, keepFactor) {
    const preview = await previewPruneForIcp(icpId, keepFactor);
    if (preview.ids.length === 0) return { ...preview, removed: 0 };
    if (isEnabled()) {
        const { count, error } = await getClient().from('grid_cells').delete({ count: 'exact' }).in('id', preview.ids);
        if (error) throw new Error(error.message);
        return { ...preview, removed: count || 0 };
    }
    const data = await readAll();
    const toDrop = new Set(preview.ids);
    const before = data.cells.length;
    data.cells = data.cells.filter(c => !toDrop.has(c.id));
    await writeAll(data);
    return { ...preview, removed: before - data.cells.length };
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
    previewPruneForIcp,
    prunePendingCellsForIcp,
};
