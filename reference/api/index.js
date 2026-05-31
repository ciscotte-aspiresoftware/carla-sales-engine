// Bluebird sales agent - local demo backend
// No DB, no auth, no deploy. Reads .env from the BlueBird root so the
// existing Scrapingdog/Firecrawl/Apollo/OpenAI keys are picked up without
// duplicating them.

// Boot banner. Prints before any module-load chatter so it's the first
// thing the user sees on every restart.
console.log('');
console.log('  ┌──────────────────────────────────┐');
console.log('  │                                  │');
console.log('  │   BlueBird API                   │');
console.log('  │   code created by sheru          │');
console.log('  │                                  │');
console.log('  └──────────────────────────────────┘');
console.log('');

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const http = require('http');
const cors = require('cors');

const classifyRoute = require('./routes/classify');
const leadsRoute = require('./routes/leads');
const emailRoute = require('./routes/email');
const companiesRoute = require('./routes/companies');
const sourcingRoute = require('./routes/sourcing');
const gridRoute = require('./routes/grid');
const icpsRoute = require('./routes/icps');
const emailTemplatesRoute = require('./routes/email-templates');
const adminRoute = require('./routes/admin');
const { startCron: startSweepCron } = require('./utils/grid-cron');
const mode = require('./utils/mode');
const realtime = require('./utils/realtime');

const app = express();
const PORT = process.env.BLUEBIRD_API_PORT || 3001;

// Permissive CORS for the demo - frontend on Vite dev server can reach us
// from any localhost port without a custom config.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

// Quick liveness check so the frontend can show a "backend is up" indicator
// if we ever want one. Also useful for debugging port conflicts.
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'bluebird-api',
        ts: Date.now(),
        env: {
            firecrawl: !!process.env.FIRECRAWL_API_KEY,
            openai: !!process.env.OPENAI_API_KEY,
            apollo: !!process.env.APOLLO_API_KEY,
            scrapingdog: !!process.env.SCRAPINGDOG_API_KEY,
        },
    });
});

app.use('/api/classify', classifyRoute);
app.use('/api/leads', leadsRoute);
app.use('/api/email', emailRoute);
app.use('/api/companies', companiesRoute);
app.use('/api/sourcing', sourcingRoute);
// Grid sweep - Phase 1 of the ICP-driven region mapping (see
// docs/icp-mapping-plan.md). Endpoints: /api/grid, /api/grid/seed,
// /api/grid/sweep, /api/grid/coverage, /api/grid/icps.
app.use('/api/grid', gridRoute);
// Full CRUD for ICP definitions - backs the /icp management page in the
// frontend. /api/grid/icps remains as the trimmed list the Coverage
// page picker uses.
app.use('/api/icps', icpsRoute);
// Email templates - per-portfolio-company sender + system-prompt records
// that drive outbound email generation. Replaces the old hardcoded
// senders.js + prompts/email.js pair so each portfolio company has its
// own voice/tone (Bluebird = Fazal, Thermeon = Adam, NedFox = Maartje).
app.use('/api/email-templates', emailTemplatesRoute);
// Demo/real mode switch. GET returns current mode; POST flips it. The
// rest of the API consults utils/mode.js on every request, so flipping is
// effective immediately (no restart). Default is "demo".
app.use('/api/admin', adminRoute);

// 404 fallback that returns JSON instead of Express's default HTML so
// the frontend's fetch handlers always parse cleanly.
app.use((req, res) => {
    res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// Wrap the express app in a bare http.Server so Socket.IO can attach to
// the same port. The previous app.listen() form created its own internal
// server we couldn't share - pulling it up here makes the http server
// addressable for both express routes and the WebSocket upgrade handshake.
const server = http.createServer(app);
realtime.attach(server);

server.listen(PORT, () => {
    console.log(`[Bluebird API] Listening on http://localhost:${PORT}`);
    console.log(`[Bluebird API] Env loaded: firecrawl=${!!process.env.FIRECRAWL_API_KEY} openai=${!!process.env.OPENAI_API_KEY} apollo=${!!process.env.APOLLO_API_KEY} scrapingdog=${!!process.env.SCRAPINGDOG_API_KEY}`);
    console.log(`[Bluebird API] Mode: ${mode.getMode().toUpperCase()}${mode.isDemo() ? ' (stubbed responses, no credits spent)' : ' (live API calls, credits will be spent)'}`);
    // Start the grid sweep cron - picks pending cells from grid.json and
    // runs the Scrapingdog → chains → Firecrawl → GPT classify pipeline
    // until the per-session budget is hit. Set BLUEBIRD_SWEEP_TICK_MS=0 in
    // .env to keep the route handlers but skip the auto-loop.
    if (process.env.BLUEBIRD_SWEEP_TICK_MS !== '0') startSweepCron();
});
