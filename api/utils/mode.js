// App-wide demo/real mode flag.
//
// "demo" (default) means every credit-spending entry point returns a fast
// stub response and the grid sweep cron stays parked. "real" means the
// route handlers actually call Scrapingdog/Firecrawl/OpenAI/Apollo and the
// sweep cron is allowed to consume cells.
//
// State lives in data/mode.json so a server restart preserves the operator's
// last choice. There's only one process; cached in memory after first read.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'mode.json');
const VALID = new Set(['demo', 'real']);

let cached = null;

function load() {
    if (cached) return cached;
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
    cached = { mode: next, updatedAt: Date.now() };
    save();
    console.log(`[Mode] Switched → ${next.toUpperCase()}${next === 'real' ? ' - real API credits will be spent' : ' - stubbed responses, no credits'}`);
    return cached;
}

function isReal() { return getMode() === 'real'; }
function isDemo() { return getMode() === 'demo'; }

module.exports = { getMode, getState, setMode, isReal, isDemo };
