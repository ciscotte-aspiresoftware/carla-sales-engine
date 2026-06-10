// /api/costs/* - read-only aggregations over the api_usage ledger.
//
//   GET /api/costs/summary           - all-time + last 30d + last 7d totals
//   GET /api/costs/by-service        - per-service breakdown for a window
//   GET /api/costs/by-model          - per-OpenAI-model breakdown
//   GET /api/costs/by-operation      - per-operation breakdown
//   GET /api/costs/daily?days=30     - per-day spend timeline
//   GET /api/costs/recent?limit=40   - most recent calls
//
// Window query params (all endpoints):
//   ?days=N       - last N days (default 30; 0 = all-time)
//   ?service=X    - restrict to one service (optional)
//
// All endpoints gracefully return empty arrays when Supabase is disabled
// rather than 500-ing, so the page works in JSON-only dev mode (it just
// shows nothing).

const express = require('express');
const { isEnabled, getClient } = require('../db');
const { OPENAI_PRICING, SERVICE_UNIT_USD, MONTHLY_SUBSCRIPTIONS_USD, FX_RATES, FX_AS_OF } = require('../utils/api-cost');

const router = express.Router();

function emptyOk(extra = {}) {
    return { success: true, enabled: false, ...extra };
}

function windowStart(days) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n <= 0) return null; // all-time
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
}

// Run a SELECT with optional service filter + optional time window.
// Returns up to 50k rows; the page won't realistically have more than
// that in scope (30d × 100 calls/day per service × 5 services ≈ 15k).
async function fetchRows({ days = 30, service = null }) {
    const since = windowStart(days);
    let q = getClient().from('api_usage').select('*').order('created_at', { ascending: false }).limit(50000);
    if (since) q = q.gte('created_at', since);
    if (service) q = q.eq('service', service);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
}

function aggregate(rows, keyFn) {
    const acc = new Map();
    for (const r of rows) {
        const k = keyFn(r) || '(unknown)';
        const cur = acc.get(k) || { key: k, calls: 0, units: 0, units_in: 0, units_out: 0, usd_cost: 0 };
        cur.calls += 1;
        cur.units += Number(r.units || 0);
        cur.units_in += Number(r.units_in || 0);
        cur.units_out += Number(r.units_out || 0);
        cur.usd_cost += Number(r.usd_cost || 0);
        acc.set(k, cur);
    }
    return Array.from(acc.values()).sort((a, b) => b.usd_cost - a.usd_cost);
}

// ─── GET /summary ──────────────────────────────────────────────────────
// Top-line KPIs: all-time, last 30d, last 7d, last 24h. Always returns the
// full structure even when zero rows exist so the frontend doesn't have
// to defensively check.
router.get('/summary', async (req, res) => {
    if (!isEnabled()) {
        return res.json(emptyOk({
            allTime: { calls: 0, usd_cost: 0, tokens: 0 },
            last30d: { calls: 0, usd_cost: 0, tokens: 0 },
            last7d:  { calls: 0, usd_cost: 0, tokens: 0 },
            last24h: { calls: 0, usd_cost: 0, tokens: 0 },
        }));
    }
    try {
        const all = await fetchRows({ days: 0 });
        const cutoff30 = Date.parse(windowStart(30));
        const cutoff7 = Date.parse(windowStart(7));
        const cutoff1 = Date.now() - 24 * 60 * 60 * 1000;
        const summarize = (rows) => ({
            calls: rows.length,
            usd_cost: rows.reduce((s, r) => s + Number(r.usd_cost || 0), 0),
            tokens: rows.reduce((s, r) => s + (Number(r.units_in || 0) + Number(r.units_out || 0)) * (r.service === 'openai' ? 1 : 0), 0),
        });
        res.json({
            success: true,
            enabled: true,
            allTime: summarize(all),
            last30d: summarize(all.filter((r) => Date.parse(r.created_at) >= cutoff30)),
            last7d:  summarize(all.filter((r) => Date.parse(r.created_at) >= cutoff7)),
            last24h: summarize(all.filter((r) => Date.parse(r.created_at) >= cutoff1)),
        });
    } catch (err) {
        console.warn(`[costs] /summary failed: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /by-service ───────────────────────────────────────────────────
router.get('/by-service', async (req, res) => {
    if (!isEnabled()) return res.json(emptyOk({ rows: [] }));
    try {
        const rows = await fetchRows({ days: req.query.days || 30 });
        res.json({ success: true, enabled: true, rows: aggregate(rows, (r) => r.service) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /by-model ─────────────────────────────────────────────────────
// OpenAI-only - non-LLM services don't have a meaningful "model" axis.
router.get('/by-model', async (req, res) => {
    if (!isEnabled()) return res.json(emptyOk({ rows: [], pricing: OPENAI_PRICING }));
    try {
        const rows = await fetchRows({ days: req.query.days || 30, service: 'openai' });
        res.json({
            success: true,
            enabled: true,
            rows: aggregate(rows, (r) => r.model),
            pricing: OPENAI_PRICING,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /by-operation ─────────────────────────────────────────────────
router.get('/by-operation', async (req, res) => {
    if (!isEnabled()) return res.json(emptyOk({ rows: [] }));
    try {
        const rows = await fetchRows({ days: req.query.days || 30, service: req.query.service || null });
        res.json({ success: true, enabled: true, rows: aggregate(rows, (r) => `${r.service}:${r.operation || '(none)'}`) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /daily ────────────────────────────────────────────────────────
// One bucket per UTC day in the window. Zero-fills empty days so charts
// render a continuous timeline even on slow weeks.
router.get('/daily', async (req, res) => {
    if (!isEnabled()) return res.json(emptyOk({ days: [] }));
    try {
        const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
        const rows = await fetchRows({ days });
        const buckets = new Map();
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        // Pre-fill the buckets for every day in the window so empty days
        // still show up as 0 in the timeline.
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(today);
            d.setUTCDate(d.getUTCDate() - i);
            const key = d.toISOString().slice(0, 10);
            buckets.set(key, { date: key, calls: 0, usd_cost: 0 });
        }
        for (const r of rows) {
            const key = String(r.created_at).slice(0, 10);
            const b = buckets.get(key);
            if (!b) continue;
            b.calls += 1;
            b.usd_cost += Number(r.usd_cost || 0);
        }
        res.json({ success: true, enabled: true, days: Array.from(buckets.values()) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /recent ───────────────────────────────────────────────────────
router.get('/recent', async (req, res) => {
    if (!isEnabled()) return res.json(emptyOk({ rows: [] }));
    try {
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 40, 200));
        const { data, error } = await getClient()
            .from('api_usage').select('*')
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw new Error(error.message);
        res.json({ success: true, enabled: true, rows: data || [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /pricing ──────────────────────────────────────────────────────
// Static pricing tables, for the frontend to render the per-model cards
// without having to hardcode the numbers itself.
router.get('/pricing', (req, res) => {
    res.json({
        success: true,
        openai: OPENAI_PRICING,
        services: SERVICE_UNIT_USD,
        monthlySubscriptions: MONTHLY_SUBSCRIPTIONS_USD,
        fx: {
            rates: FX_RATES,
            asOf: FX_AS_OF,
        },
    });
});

module.exports = router;