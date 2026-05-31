# Bluebird Sales Agent — local demo

A two-piece local app for Bluebird's sales team:

1. **Sales Agent** — paste a car rental website URL → classify the business → find decision-makers via Apollo → draft an outreach email from Fazal.
2. **Sourcing** — placeholder for the Scrapingdog Google Maps fresh-lead pipeline (the standalone batch script is still in `find-leads.js`).

No DB, no auth, no deploy. Demo only. Reads/writes companies to `api/data/companies.json`.

## Layout

```
BlueBird/
├── find-leads.js              # existing batch sourcing tool (unchanged)
├── Scrapingdog Notes.txt
├── output/
├── package.json               # for find-leads.js
├── .env                       # all API keys live here (you populate)
│
├── api/                       # local Express backend on :3001
│   ├── index.js
│   ├── routes/                # classify · leads · email · companies
│   ├── utils/                 # firecrawl · apollo · openai
│   ├── prompts/               # classify + email prompts
│   ├── senders.js             # Fazal only for the demo
│   └── data/companies.json    # auto-created on first classify
│
└── web/                       # Vite + React frontend on :5174
    └── src/
        ├── components/        # ui (shadcn primitives) + layout
        ├── pages/             # pipeline (Sales Agent) + sourcing
        ├── lib/               # cn helper + API fetch wrappers
        └── App.tsx
```

## Required env vars

Append to your existing `BlueBird/.env` (the `api/` reads from this same file):

```bash
FIRECRAWL_API_KEY=...           # required for classify
# Optional rotation keys — same pattern as valsource
FIRECRAWL_API_KEY_2=...
FIRECRAWL_API_KEY_3=...

OPENAI_API_KEY=...              # required for classify + email
APOLLO_API_KEY=...              # required for leads
SCRAPINGDOG_API_KEY=...         # used by find-leads.js (existing)

# Optional overrides
BLUEBIRD_API_PORT=3001          # default 3001
BLUEBIRD_OPENAI_MODEL=gpt-4o-mini  # default gpt-4o-mini
```

## First-time setup

```bash
# Backend
cd api
npm install

# Frontend (separate terminal)
cd ../web
npm install
```

## Run the demo

You need TWO terminals:

```bash
# Terminal 1 — backend
cd BlueBird/api
npm run dev          # listens on http://localhost:3001
```

```bash
# Terminal 2 — frontend
cd BlueBird/web
npm run dev          # listens on http://localhost:5174
```

Open http://localhost:5174

The Vite dev server proxies `/api/*` → `http://localhost:3001`, so the frontend works without any CORS config.

## Demo flow

1. Open the Sales Agent page (default route).
2. Paste a car rental website URL (e.g. `https://www.acerentacar.com` or any small independent rental's homepage).
3. Click **Analyze** — Firecrawl scrapes, OpenAI classifies. ~5–15s.
4. If it's a car rental, click **Find decision-makers** — Apollo returns the top 3 contacts. ~3–8s.
5. Click **Generate email** on any lead — OpenAI drafts a new-outreach email from Fazal. ~2–5s.
6. Edit the body inline if needed. **Copy to clipboard** to paste into Gmail/Outlook.

## What's NOT in the demo (intentionally)

- Auth / sign-in
- Persistent DB (uses a local JSON file instead)
- Multiple senders (only Fazal — easy to add to `api/senders.js`)
- Reconnect / Spanish toggles (new outreach only)
- Salesforce or Grata integration
- Email-cap rotation, sequence tracking, queue management
- The Scrapingdog sourcing UI (placeholder page exists; batch script still works via `npm run find-leads` from the root)

## Independent of valsource

This project does not import from or modify any code under `c:/Users/ShehryarUrRehman/Desktop/valsource/`. It copies the *patterns* and *utilities* it needs (Firecrawl wrapper, Apollo search, shadcn primitives) but lives entirely under `BlueBird/`.

Future updates to valsource don't auto-propagate here. If you change valsource's Apollo logic and want the same change in Bluebird, you'll need to copy it over manually.

## Architecture notes

- **Classifier** uses OpenAI's structured-JSON response format with low temperature for stable output. Prompt at `api/prompts/classify.js`.
- **Email gen** uses higher temperature for variance. Prompt at `api/prompts/email.js`. Constraint: 90–120 word body, < 60 char subject, no jargon, no fabricated numbers.
- **Apollo** uses the same 4-strategy fallback as valsource: domain+titles → domain+seniority → domain only → org name. Enrichment runs against the top 2N candidates so the final list of N has the best email coverage.
- **Persistence** is a single JSON file, written on every successful classify/leads call. Not safe for concurrent use; fine for a single-user demo.
