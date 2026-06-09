# Atlas

AI-driven lead-discovery + outreach platform for Valsoft portfolio companies
(internal codename: **Bluebird**, kept as the repo name for backwards
compatibility). Atlas crawls Google Maps for real local businesses in your
ICP, classifies each one with GPT against per-ICP criteria, enriches the
qualified ones with Apollo + LinkedIn, and drafts outreach emails / LinkedIn
DMs using your own sender personas and templates.

Live demo: https://bluebird-1lmh.onrender.com (this URL points at the
maintainer's deploy - you'll point at your own after setup).

---

## What's in this repo

```
bluebird/
├── api/                          Node.js + Express backend
│   ├── index.js                  Server entry (Express + Socket.IO)
│   ├── routes/                   REST + Socket.IO event handlers
│   ├── utils/                    Pipeline (scrape, classify, enrich, sweep)
│   ├── prompts/                  GPT system prompts (classify + email)
│   ├── middleware/               Activity-log tracker
│   ├── db/                       Supabase client + SQL migrations
│   ├── data/                     Seed JSON (ICPs, templates, geo lookups)
│   └── scripts/                  Maintenance scripts (audits, backfills)
├── web/                          React + Vite frontend (TanStack-free)
│   └── src/                      Pages, components, design system
├── docs/                         Architecture notes
├── .env.example                  Backend env template
├── web/.env.example              Frontend env template
└── README.md                     You are here
```

The frontend is a SPA built with React 19 + Vite + react-router-dom + Tailwind.
It uses a glass-morphism design system local to `web/src/lib/glass.ts` (not
shadcn-admin). Socket.IO is used for live sweep progress.

---

## Quick start (local dev)

You'll need: Node 20+, npm 10+, a Supabase project (or skip for JSON-fallback
mode), and API keys for at least Scrapingdog + Firecrawl + OpenAI.

```bash
# 1. Clone
git clone <repo-url> bluebird
cd bluebird

# 2. Backend env
cp .env.example .env
# Open .env and paste in your API keys (see "Required keys" below)

# 3. Backend deps + run
cd api
npm install
node index.js
# Server listens on http://localhost:3001

# 4. Frontend env (in a separate terminal)
cd ../web
cp .env.example .env       # leave VITE_API_URL blank for dev (proxy handles it)

# 5. Frontend deps + run
npm install
npm run dev
# Vite serves http://localhost:5174
```

Open http://localhost:5174 and head to **Coverage** to seed cells, then
**Resume sweeping** to start a session.

The Vite dev server proxies `/api/*` and `/socket.io/*` to
`http://localhost:3001`, so the two pieces talk without CORS config.

---

## Required keys

All keys go in `bluebird/.env` (backend). See [.env.example](.env.example)
for the full annotated list. The bare minimum for a real-mode sweep:

| Key | Purpose | Sign up |
|---|---|---|
| `SCRAPINGDOG_API_KEY` | Google Maps search (5 credits / call) | https://www.scrapingdog.com/ |
| `FIRECRAWL_API_KEY` | Per-company website scrape (1 credit / domain) | https://www.firecrawl.dev/ |
| `OPENAI_API_KEY` | Classify + email generation | https://platform.openai.com/api-keys |
| `APOLLO_API_KEY` | Decision-maker search + enrichment | https://apollo.io/ |
| `APIFY_API_TOKEN` | LinkedIn profile + post scrape | https://apify.com/ |

Optional rotation: each of the above accepts `_2` ... `_5` suffixes to rotate
across multiple keys when one hits a credit cap.

---

## Database setup (Supabase, recommended)

Atlas defaults to JSON-file persistence in `api/data/`, which is fine for
single-user demo but loses data on a Render restart and can't be shared
across instances. For real use, point it at Supabase:

1. Create a Supabase project at https://supabase.com/.
2. Run every SQL file in [`api/db/migrations/`](api/db/migrations/) in order
   (`0001_*.sql` through `0008_*.sql`) via the Supabase SQL editor.
3. Grab the project URL + service-role key from Project Settings → API.
   **Service-role key is server-only - never ship it to the browser.**
4. Set in `bluebird/.env`:
   ```
   USE_SUPABASE=true
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_KEY=<service-role-key>
   ```
5. (Optional) Import your existing JSON state with:
   ```
   cd api
   npm run db:import
   ```

If `USE_SUPABASE=false` (the default), Atlas reads / writes
`api/data/*.json` instead. Missing JSON files are created automatically on
first write.

---

## Production deploy

Atlas is currently designed as three independent pieces:

| Piece | Where | How |
|---|---|---|
| Backend | Render (or any Node host) | Auto-deploy from GitHub main. Set every required env var in the Render dashboard. |
| Database | Supabase | Shared by every backend instance. |
| Frontend | Netlify (or any static host) | Build with `npm run build` in `web/`, then upload `web/dist/` to the host. |

**Important for the frontend**: `VITE_API_URL` is baked into the JS bundle
at build time, so set `web/.env.production` to your backend URL BEFORE
running `npm run build`. If the backend URL ever changes, you must rebuild
and re-upload.

Render's filesystem is ephemeral. If you deploy on Render without
`USE_SUPABASE=true`, every restart loses all sweep data.

---

## The pipeline at a glance

```
[Coverage page]
   ↓ user picks an ICP + city/country + clicks "Seed cells"
[Grid seeder]   →   creates hex-grid cells in api/grid_cells
   ↓ user clicks "Resume sweeping"
[Sweep cron, ticks every 5s]
   ↓ picks the next pending cell (priority: tier-1 cities first, then
   ↓ density-prioritised tier-2 fill)
[Scrapingdog]   →   Google Maps search per ICP term
   ↓
[Chain blocklist + type filter]   →   drops franchises + non-target POIs
   ↓
[Dedupe vs DB]   →   skip companies already classified for this ICP
   ↓
[Firecrawl]   →   landing-page markdown (cached in scrape_cache)
   ↓
[GPT classify]   →   per-ICP classifyPrompt, structured JSON verdict
   ↓
[upsertCompany]   →   write classification + fan out to sibling ICPs
   ↓                  (sibling ICPs reclassify the cached markdown - no
   ↓                   extra Scrapingdog / Firecrawl spend)
[Activity feed]   →   Socket.IO push for live UI updates
```

A finished cell transitions to `complete` (had qualified leads), `empty`
(no survivors), or `no_new` (all survivors were already-classified). Per-ICP
budget (default 2 cells / session) pauses the cron so credit spend stays
predictable.

Pause mid-cell at any time: the in-flight pipeline writes a JSON
`pause_checkpoint` on the cell at the next company boundary, and the next
Resume rehydrates from there without re-spending Scrapingdog credits.

---

## In-app documentation

Atlas ships an in-app **Wiki** page (`/wiki`) with deeper walkthroughs of
every surface (Coverage, ICPs, Sweep lifecycle, Templates, etc.). It's the
canonical user-facing documentation; this README only covers setup +
deploy. The wiki content lives in [`web/src/pages/wiki.tsx`](web/src/pages/wiki.tsx)
and is easy to extend - it's just a list of React sections.

---

## What runtime data is NOT in this repo

The following JSON files are gitignored and not shared (they hold real
business data or are recreated automatically):

- `api/data/companies.json` - every classified company + Apollo leads
- `api/data/sources.json` - sourcing scan history
- `api/data/grid.json` - sweep cell state
- `api/data/search-log.json` - Scrapingdog dedup history
- `api/data/geocoded-cities.json` - city → lat/lng cache
- `api/data/mode.json` - demo/real mode marker

You'll generate your own equivalents once you start sweeping. (Or, with
Supabase enabled, you won't need these files at all - everything lives in
Postgres.)

The following config / seed JSON IS tracked and serves as a starting
template:

- `api/data/icps.json` - example ICPs (Bluebird, Thermeon, NedFox variants)
- `api/data/email-templates.json` - example sender personas + templates
- `api/data/settings.json` - default pipeline tunables
- `api/data/airports.json` + `populated-places.json` - public reference data

Edit the seed files to match your own portfolio.

---

## License / ownership

Internal Valsoft project. Not for redistribution outside intended
recipients.