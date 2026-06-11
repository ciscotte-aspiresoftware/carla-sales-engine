// Atlas - portfolio prospecting engine (local demo backend)
// No DB, no auth, no deploy. Reads .env from the repo root so the
// existing Scrapingdog/Firecrawl/Apollo/OpenAI keys are picked up without
// duplicating them.

// Boot banner. Prints before any module-load chatter so it's the first
// thing the user sees on every restart.
console.log('');
console.log('  ┌──────────────────────────────────┐');
console.log('  │                                  │');
console.log('  │   Atlas API                      │');
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
const liMessageRoute = require('./routes/li-message');
const companiesRoute = require('./routes/companies');
const sourcingRoute = require('./routes/sourcing');
const gridRoute = require('./routes/grid');
const icpsRoute = require('./routes/icps');
const emailTemplatesRoute = require('./routes/email-templates');
const adminRoute = require('./routes/admin');
const discoverRoute = require('./routes/discover');
const activityRoute = require('./routes/activity');
const costsRoute = require('./routes/costs');
const sequencesRoute = require('./routes/sequences');
const { startCron: startSweepCron } = require('./utils/grid-cron');
const reclassifyWorker = require('./utils/reclassify-worker');
const reclassifyJobs = require('./utils/reclassify-jobs');
const realtime = require('./utils/realtime');

const app = express();
// Render (and most hosts) inject the port to bind via process.env.PORT and
// health-check it - must take precedence. Falls back to the local dev port.
const PORT = process.env.PORT || process.env.BLUEBIRD_API_PORT || 3001;

// Permissive CORS for the demo - frontend on Vite dev server can reach us
// from any localhost port without a custom config.
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

// Quick liveness check so the frontend can show a "backend is up" indicator
// if we ever want one. Also useful for debugging port conflicts.
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'atlas-api',
        ts: Date.now(),
        env: {
            firecrawl: !!process.env.FIRECRAWL_API_KEY,
            openai: !!process.env.OPENAI_API_KEY,
            anthropic: !!process.env.ANTHROPIC_API_KEY,
            gemini: !!process.env.GEMINI_API_KEY,
            apollo: !!process.env.APOLLO_API_KEY,
            scrapingdog: !!process.env.SCRAPINGDOG_API_KEY,
        },
    });
});

app.use('/api/classify', classifyRoute);
app.use('/api/leads', leadsRoute);
app.use('/api/email', emailRoute);
// LI Message - paste-URL or pick-from-leads workflow. /scrape returns the
// LinkedIn profile + recent posts; /email runs the same prompt as the main
// email route but seeded from the scraped LI signals rather than a website
// classification. The companion page is web/src/pages/li-message.tsx.
app.use('/api/li-message', liMessageRoute);
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
// Operator-tunable settings (search radii, Firecrawl scrape vs crawl, etc).
// Each group has a Default/Custom toggle; code reads via utils/settings.js
// so changes apply without a restart (radii apply on next seed).
app.use('/api/admin', adminRoute);
// Discover - standalone find+enrich+contacts pipeline for the Aspire CRM
// integration. Scrapingdog Maps → Firecrawl + GPT (dynamic criteria) → Apollo,
// returning CRM-ready JSON. Stateless: writes nothing to Atlas's own stores.
app.use('/api/discover', discoverRoute);
// Operator activity log - audit trail of mutating actions across the API.
// Writes come from middleware/activity.js attached to specific POSTs/PUTs;
// this surface is read-only.
app.use('/api/activity', activityRoute);
app.use('/api/costs', costsRoute);
app.use('/api/sequences', sequencesRoute);

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

server.listen(PORT, async () => {
    console.log(`[Atlas API] Listening on port ${PORT}`);
    console.log(`[Atlas API] Env loaded: firecrawl=${!!process.env.FIRECRAWL_API_KEY} openai=${!!process.env.OPENAI_API_KEY} apollo=${!!process.env.APOLLO_API_KEY} scrapingdog=${!!process.env.SCRAPINGDOG_API_KEY}`);
    // Start the grid sweep cron - picks pending cells from grid.json and
    // runs the Scrapingdog → chains → Firecrawl → GPT classify pipeline
    // until the per-session budget is hit. Set BLUEBIRD_SWEEP_TICK_MS=0 in
    // .env to keep the route handlers but skip the auto-loop.
    if (process.env.BLUEBIRD_SWEEP_TICK_MS !== '0') startSweepCron();
    // Reclassify worker - processes the reclassify_jobs queue (migrations
    // 0014/0015). Reconcile first so any 'running' rows left by a prior
    // crash flip back to 'pending' and the worker picks up where it left
    // off; then start the tick loop. Set BLUEBIRD_RECLASSIFY_TICK_MS=0 in
    // .env to skip the auto-loop (jobs still enqueue but stay pending).
    try {
        const reconciled = await reclassifyJobs.reconcileOnBoot();
        if (reconciled > 0) {
            console.log(`[Reclassify Worker] Reconciled ${reconciled} crashed job(s) back to pending on boot`);
        }
    } catch (err) {
        console.warn(`[Reclassify Worker] boot reconcile failed: ${err.message}`);
    }
    if (process.env.BLUEBIRD_RECLASSIFY_TICK_MS !== '0') reclassifyWorker.start();
});
