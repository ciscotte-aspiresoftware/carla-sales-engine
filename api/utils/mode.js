// App-wide demo/real mode flag.
//
// "demo" (default) means every credit-spending entry point returns a fast
// stub response and the grid sweep cron stays parked. "real" means the
// route handlers actually call Scrapingdog/Firecrawl/OpenAI/Apollo and the
// sweep cron is allowed to consume cells.
//
// State lives in data/mode.json so a server restart preserves the operator's
// last choice. There's only one process; cached in memory after first read.
//
// CARLA_MODE env override: on hosts with an EPHEMERAL filesystem (e.g.
// Render's free plan, which wipes data/ on every cold start / redeploy), the
// mode file is lost on restart and the app would silently revert to "demo" -
// making real pushes / sweeps no-op. Set CARLA_MODE=real|demo and it is
// AUTHORITATIVE: it wins over any data/mode.json so a stray/leftover file
// can't silently flip a server back to demo, and the in-app toggle can't
// override the server's pinned mode (the toggle is a local-dev convenience).
// Leave CARLA_MODE unset for the original file-only behaviour.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'mode.json');
const VALID = new Set(['demo', 'real']);

let cached = null;

// The env-pinned mode, or null when CARLA_MODE is unset/invalid.
function pinnedMode() {
    const m = String(process.env.CARLA_MODE || '').toLowerCase();
    return VALID.has(m) ? m : null;
}

function load() {
    if (cached) return cached;
    // Env pin is authoritative - check it BEFORE the file.
    const pin = pinnedMode();
    if (pin) {
        cached = { mode: pin, updatedAt: 0, pinned: true };
        return cached;
    }
    try {
        if (fs.existsSync(FILE)) {
            const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            if (raw && VALID.has(raw.mode)) {
                cached = { mode: raw.mode, updatedAt: raw.updatedAt || 0 };
                return cached;
            }
        }
    } catch { /* fall through to default */ }
    cached = { mode: 'demo', updatedAt: 0 };
    return cached;
}

function save() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cached, null, 2));
}

function getMode() {
    return load().mode;
}

function getState() {
    return { ...load() };
}

function setMode(next) {
    if (!VALID.has(next)) throw new Error(`mode must be "demo" or "real" (got "${next}")`);
    // When the server pins the mode via CARLA_MODE, the in-app toggle can't
    // override it - report the pinned value back so the UI re-syncs to it.
    const pin = pinnedMode();
    if (pin) {
        console.warn(`[Mode] CARLA_MODE=${pin} is pinned; ignoring toggle to "${next}".`);
        cached = { mode: pin, updatedAt: Date.now(), pinned: true };
        return cached;
    }
    cached = { mode: next, updatedAt: Date.now() };
    save();
    console.log(`[Mode] Switched → ${next.toUpperCase()}${next === 'real' ? ' - real API credits will be spent' : ' - stubbed responses, no credits'}`);
    return cached;
}

function isReal() { return getMode() === 'real'; }
function isDemo() { return getMode() === 'demo'; }

// Is the mode currently pinned by the CARLA_MODE env var? (diagnostic)
function isPinned() { return pinnedMode() !== null; }

module.exports = { getMode, getState, setMode, isReal, isDemo, isPinned };
