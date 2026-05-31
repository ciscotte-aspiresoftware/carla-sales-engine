# SDR Engine

A modular AI Sales Development Representative and Go-To-Market automation engine. The pipeline (discovery → ICP scoring → personalised research → email sequence drafting) is generic; **what changes per portfolio company is a small set of pack files**, not the agent code.

The repo ships with two verticals (car rental, marina) and four real Aspire Software / Valsoft portfolio vendors as worked examples: **Thermeon**, **Bluebird**, **RENTALL**, and **DockMaster**. The engine code is vertical-agnostic — you can add a new vertical by authoring one pack JSON; the discovery prompts, UI labels, ICP fields, and size bands are all read from the pack at runtime.

---

## Quick orientation for new portfolio teams

**What this codebase is**: a clean foundation for an AI SDR engine. Marina + car_rental are example data, not engine assumptions. Drop in your own vertical pack JSON and the engine — same code — does discovery, scoring, research, and copywriting for your vertical.

**What's wired vs planned**:

| Capability | Status |
|---|---|
| Pack-driven discovery prompts (per-vertical wording from JSON) | ✅ Live |
| Pack-driven ICP scoring | ✅ Live |
| Tavily web search (registry-routed) | ✅ Live |
| Website enrichment (homepage + selected inner pages, robots.txt-aware) | ✅ Live — Firecrawl preferred, free local `httpx + trafilatura` fallback runs without an API key |
| URL verification gate during discovery + batch re-verify of existing prospects | ✅ Live — catches parked / wrong-company / dead URLs, soft fails flag `provenance.website_url = "needs_review"` |
| Email discovery + DNS deliverability check on scrape (`MX → A` lookup, in-process cache) | ✅ Live |
| Per-fact source attribution (services, pain signals, competitors all carry their source URL) | ✅ Live |
| Apollo stub | ✅ Registered, raises `NotConfigured` until you set the env key |
| SendGrid outbound delivery | 📄 Designed in `docs/integrations/sendgrid.md` — not wired |
| Salesforce CRM sync | 📄 Designed in `docs/integrations/salesforce.md` — not wired |
| Inbound reply ingestion (Gmail/IMAP/SendGrid Inbound Parse) | 📄 Designed in `docs/integrations/inbound.md` — not wired |

**Adding a new vertical** (no code change):

1. Drop a new JSON in `backend/packs/vertical/` — copy `marina.json` or `car_rental.json` as a template. Required keys are `industry_context.terminology`, `industry_context.discovery_copy`, `industry_context.size_band_thresholds`, `industry_context.ui`, plus `icp.criteria`.
2. Restart the backend.
3. `GET /api/v1/verticals/manifest` lists your new vertical.
4. The sidebar's vertical switcher gains an entry for it.
5. Discovery, ICP scoring, research, and copywriting all use your pack's wording.

**Adding a new integration** (one file change + register):

1. Subclass `BaseProvider` in `backend/app/integrations/<provider>.py`.
2. Declare `Capability.X`, implement `is_configured()` and the relevant async method.
3. Register the instance in `backend/app/integrations/__init__.py`.
4. The relevant agent picks it up via `registry.by_capability(Capability.X, configured_only=True)`.

See `docs/integrations/` for design docs covering Tavily, Apollo, Firecrawl, SendGrid, Salesforce, and Inbound — each with the exact hook points, env config, and verification steps.

**Architectural seams worth knowing**:

- `backend/app/agents/` — seven agents (discovery, prospector, researcher, copywriter, classifier, pipeline, website_enrichment). All vertical-agnostic; per-vertical wording is loaded from pack JSON via `_segment_config_from_pack` and `industry_context.terminology`.
- `backend/app/packs/loader.py` — pack loader; reads `vertical/`, `vendor/`, `product/`, `regional/` JSON.
- `backend/app/integrations/` — provider registry; one file per external vendor, all uniform shape. `URL_SCRAPE` resolves to Firecrawl when keyed and falls back to a free local `httpx + trafilatura` provider otherwise — every downstream caller goes through `services/scrape_provider.py:pick_scrape_provider()`.
- `backend/app/services/llm_settings.py` — per-agent model overrides; the `KNOWN_AGENTS` list is the source of truth for which agents the UI exposes.
- `backend/app/services/scrape_safety.py` — single source of truth for the SDR user-agent string, the robots.txt cache (RFC 9309 compliant via `protego`), and the per-registrable-domain rate limiter shared across the scraper, the verifier and the agent.
- `backend/app/services/website_url_check.py` + `website_verifier.py` — lite URL verifier (used by discovery's auto-gate + the batch action) and the full pre-scrape verifier respectively. Both produce `website_research`-shaped payloads so the UI panel renders either consistently.
- `backend/app/services/email_verifier.py` — DNS-backed deliverability check (MX → A) used by the website enrichment agent on every discovered email. Per-domain in-process cache survives across a batch.
- `backend/app/main.py:on_startup` — idempotent ALTER TABLE migrations + `CREATE INDEX IF NOT EXISTS` on hot filter columns. Add new column migrations or indexes here.
- `frontend/lib/use-poll.ts` — visibility-aware polling hook. Every status loop in the app (research, scrape, batch trace, activity feed) goes through it — pauses while the tab is hidden, cancels via `AbortController` on unmount.

**The Prospect data model is vertical-neutral**: columns are `business_name` and `capacity_count`, not `marina_name` / `berth_count`. The pack's `prospect_schema_hints.size_field_label` and `industry_context.terminology.size_field_short` provide vertical-appropriate display labels.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Running the Application](#running-the-application)
4. [Architecture: Vertical / Vendor / Product / Regional](#architecture-vertical--vendor--product--regional)
5. [The Pack System](#the-pack-system)
6. [Where the AI Calls Live](#where-the-ai-calls-live)
7. [Configuration](#configuration)
8. [Project Structure](#project-structure)
9. [Key File Reference](#key-file-reference)

---

## Prerequisites

| Tool | Minimum Version | Download |
|------|----------------|---------|
| Python | 3.11+ | https://www.python.org/downloads/ |
| Node.js | 18 LTS+ | https://nodejs.org/ |
| npm | 9+ | Included with Node.js |

You will also need two API keys:

| Key | Required | Purpose | Where to get it |
|-----|----------|---------|----------------|
| **Anthropic (Claude)** | Yes | All AI agents and AI Auto-fill | https://console.anthropic.com/ |
| **Tavily** | Optional | Live web search during prospect discovery | https://tavily.com/ |

> Without Tavily, discovery falls back to Claude's training knowledge alone (real businesses, but not verified against current websites).

---

## Installation

Clone the repo, then run the setup script for your platform from inside the repo root. The script checks prerequisites, prompts for your API keys, sets up the Python virtual environment, and installs all dependencies.

```bash
git clone <repo-url> sdr-engine
cd sdr-engine
```

### macOS / Linux

```bash
chmod +x install.sh start.sh
./install.sh
```

If `python3` resolves to anything older than 3.11, install a newer version first (`brew install python@3.12` on macOS, your distro's package manager on Linux).

### Windows — PowerShell (recommended)

```powershell
# First-time only: allow scripts in this session
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

.\install.ps1
```

### Windows — Command Prompt

```
install.bat
```

If the installer reports that Python or Node.js is missing right after installing them, close the terminal and open a fresh one — Windows only refreshes `PATH` for new shells.

---

The script will create (or overwrite) `backend/.env` with your keys. Re-run it any time to update them. The `.env` file is excluded by `.gitignore` and must never be committed.

> **⚠️ Heads-up if you use AI coding assistants (Claude Code, Cursor, Copilot Workspace, etc.)**
>
> Your API keys live in `backend/.env`. Tools like Claude Code can read and search any file your user account can read — including `.env` — unless you explicitly restrict them. A wide-net grep during a routine audit can surface secrets in the agent's output and, by extension, in the conversation transcript.
>
> If you use Claude Code, this repo ships a `.claude/settings.json` with deny rules covering `.env`, `.settings_encryption_key`, and `*.db` files. Review and adapt as needed. For other assistants, configure the equivalent in their settings.
>
> If a key ever surfaces in any agent transcript, log, or terminal output you don't fully control — **rotate it**. That's cheap insurance.

---

## Running the Application

### One-shot launcher

- **macOS / Linux:** `./start.sh`
- **Windows:** `start.bat` (also works from PowerShell)

Either script opens two terminals — backend on **http://localhost:8000**, frontend on **http://localhost:3000** — and then opens the UI in your default browser.

### Or run them manually (two terminals)

**Terminal 1 — Backend (FastAPI):**
```bash
cd backend

# macOS / Linux
source .venv/bin/activate

# Windows (PowerShell)
.venv\Scripts\Activate.ps1

# Windows (cmd)
.venv\Scripts\activate.bat

uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — Frontend (Next.js):**
```bash
cd frontend
npm run dev
```

Open **http://localhost:3000** in your browser. Backend interactive docs at **http://localhost:8000/docs**.

---

## Architecture: Vertical / Vendor / Product / Regional

The pack system is layered so that adding a new portfolio company doesn't require editing agent code or duplicating ICP definitions.

```
backend/packs/
├── vertical/                  ← The industry / buyer side
│   ├── car_rental.json        ← ICP criteria, persona archetypes, industry KPIs, common pains
│   └── marina.json            ← (same shape, different industry)
│
├── vendor/                    ← The company doing the selling
│   ├── thermeon.json          ← Thermeon — UK HQ, 30+ yrs, CARS+ + FrontDesk
│   ├── bluebird.json          ← Bluebird — US/CA/UK, since 1982, RentWorks (rental + dealer service loaners)
│   ├── rentall.json           ← RENTALL — cloud platform, 70+ countries (formed 2021 from Bluebird + Thermeon + Navotar)
│   └── dockmaster.json        ← DockMaster — marina software vendor
│
├── product/                   ← Specific products from a vendor, with personas + messaging
│   ├── thermeon_carsplus.json
│   ├── thermeon_frontdesk.json
│   ├── bluebird_rentworks.json
│   ├── rentall_platform.json
│   └── dockmaster.json
│
└── regional/                  ← Locale, scheduling, compliance, tone
    ├── us_en.json
    ├── nl_nl.json
    ├── au_en.json
    └── es_es.json
```

A campaign references **(vertical, vendor, product, regional)**. The `PackLoader.compose()` method merges the four into a single pack object that the AI agents consume — the agents themselves don't need to know about the layering.

**Where things live:**

| Layer | Owns |
|---|---|
| **Vertical** | ICP scoring criteria · industry KPIs · common pains · prospect schema fields |
| **Vendor** | Company name + parent · regions served · years · customer logos · brand voice · **outreach sender** · **excluded customers** (skip in discovery) |
| **Product** | Product name/URL · elevator pitch · differentiators · proof points · per-persona value props · email guidance |
| **Regional** | Locale, scheduling, compliance, tone overrides |

---

## The Pack System

### Adding a new vendor in an existing vertical

1. Create `backend/packs/vendor/<vendor_id>.json` (see [thermeon.json](backend/packs/vendor/thermeon.json) as a template). Set `verticals: ["car_rental"]` so the cascade picker shows it under car rental.
2. Create one or more `backend/packs/product/<product_id>.json` files (see [thermeon_carsplus.json](backend/packs/product/thermeon_carsplus.json)). Set `vendor_id` and `vertical_id` to link.
3. The vendor + product appear automatically in:
   - The Pack Explorer (vendor + product cards)
   - The Campaign Builder cascade picker (Vertical → Vendor → Product)
   - Discovery's exclusion list (union across all vendors targeting the vertical)

No code changes required.

### Adding a new vertical

1. Create `backend/packs/vertical/<vertical_id>.json` with `industry_context` (KPIs, pains, segments, default unit label) and `icp.criteria`.
2. Add at least one vendor + product targeting it.
3. (Optional) For the discovery agent to know how to find prospects in the new vertical, add an entry to `SEGMENT_CONFIGS` in [backend/app/agents/discovery.py](backend/app/agents/discovery.py) with the per-vertical generate / enrich prompts and Tavily search suffix.

### Excluding existing customers from discovery

Add entries to `excluded_customers` in any vendor pack:

```json
"excluded_customers": [
  {"name": "Hertz", "reason": "existing customer"},
  {"name": "Budget Car Rental", "reason": "existing customer"}
]
```

The discovery agent (a) instructs Claude to skip these names in its candidate generation prompt, and (b) post-filters the result via fuzzy substring match before saving — so `"Hertz"` catches `"Hertz Manhattan"` but not `"Sixt Rent A Car"`.

### AI Auto-fill

In the Pack Explorer, Vendor and Product packs each expose an **Edit + AI Auto-fill** button. Inside the editor, sections (ICP / personas / messaging / email guidance) have their own AI Auto-fill button that calls `POST /packs/generate-section` and replaces just that section using the surrounding pack context.

The same exists on Vertical packs for ICP criteria.

---

## Where the AI Calls Live

All Claude API calls are in `backend/app/agents/` and `backend/app/routers/packs.py`. Every agent receives a **composed** pack (the merged vertical+vendor+product object), so the same agent code drives every vendor.

| File | Role |
|------|------|
| [backend/app/agents/discovery.py](backend/app/agents/discovery.py) | Two-step Claude+Tavily prospect discovery. Vertical-aware via `SEGMENT_CONFIGS`. Filters Claude's output against vendor exclusion lists, skips placeholders, and auto-runs the lite URL verifier on every candidate (parallel under a semaphore) so dead / mis-mapped URLs never leak into the database. |
| [backend/app/agents/prospector.py](backend/app/agents/prospector.py) | Batch ICP scoring against the vertical's `icp.criteria`. |
| [backend/app/agents/researcher.py](backend/app/agents/researcher.py) | Per-prospect personalisation profile (hook, pain, credible detail, suggested persona). Reads `provenance` to decide what's safe to cite; `"scrape"` is a verified source class that lets the researcher quote facts from the prospect's own site. |
| [backend/app/agents/copywriter.py](backend/app/agents/copywriter.py) | Multi-touch email sequence drafting. Uses regional tone, holiday-aware scheduling, vendor outreach sender. |
| [backend/app/agents/website_enrichment.py](backend/app/agents/website_enrichment.py) | Scrapes a prospect's website (homepage + up to 5 keyword-ranked inner pages, robots-aware, rate-limited per domain) and asks Claude to extract a structured payload — services, online booking, tech stack, pain signals, competitor mentions, verbatim quotes, plus a discovered-emails list with DNS-verified deliverability. Each fact carries a source-URL in an `evidence` sidecar so the UI can link back to the page it came from. |
| [backend/app/agents/optimizer.py](backend/app/agents/optimizer.py) | ⭐ **Extended thinking** — pricing and gap-fill recommendations using Claude's `thinking` blocks. |
| [backend/app/agents/classifier.py](backend/app/agents/classifier.py) | Inbound reply classification. |
| [backend/app/routers/packs.py](backend/app/routers/packs.py) | `POST /packs/regional/generate` and `POST /packs/generate-section` — the AI Auto-fill endpoints. |

---

## Configuration

All configuration is loaded from `backend/.env` via `backend/app/config.py` (Pydantic Settings).

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key. All agents fail without this. |
| `TAVILY_API_KEY` | No | Enables live web search in discovery. |
| `FIRECRAWL_API_KEY` | No | When set, the website-enrichment agent uses Firecrawl for scraping (better at JS-rendered / anti-bot-protected sites). Without it, scraping still works via the free local `httpx + trafilatura` provider — JS-only sites and aggressive anti-bot pages will fail. |
| `DATABASE_URL` | No | SQLite by default (`sqlite:///./aspire_demo.db`). PostgreSQL also supported. |
| `PACKS_DIR` | No | Path to the packs directory. Default: `./packs` |
| `ENVIRONMENT` | No | `development` or `production`. |

> Additional tunables for the scraping pipeline live in the in-app Settings UI (DB-backed, no restart): `website_scrape_default_max_pages` and `website_scrape_user_agent`.

To change a setting, edit `backend/.env` and restart the backend server.

---

## Project Structure

```
sdr-engine/
├── install.sh / install.bat / install.ps1   # Setup wizards (macOS+Linux / cmd / PowerShell)
├── start.sh  / start.bat                    # Launches backend + frontend in two terminals
├── .gitignore                               # Excludes .env, .venv, node_modules, *.db, etc.
├── README.md
│
├── backend/
│   ├── app/
│   │   ├── agents/         # AI agent implementations (Claude calls live here)
│   │   ├── models/         # SQLAlchemy models (Prospect, Campaign, EmailSequence, Activity, …)
│   │   ├── routers/        # FastAPI routes (prospects, campaigns, packs, optimization, …)
│   │   ├── schemas/        # Pydantic request/response models
│   │   ├── services/       # Business logic (prospect, campaign, occupancy, holiday, …)
│   │   ├── packs/          # PackLoader — loads + composes layered packs
│   │   ├── config.py       # Settings loaded from .env
│   │   ├── database.py     # SQLAlchemy engine + idempotent column migrations
│   │   └── main.py
│   ├── packs/              # ← The 4-layer pack system (see Architecture above)
│   │   ├── vertical/
│   │   ├── vendor/
│   │   ├── product/
│   │   └── regional/
│   ├── data/               # Synthetic prospect CSVs (used by seed.py)
│   └── seed.py             # Loads prospect CSVs only — no fake activity / campaigns
│
└── frontend/               # Next.js 16 App Router
    ├── app/
    │   ├── prospects/      # Prospect list, detail, discovery flow
    │   ├── campaigns/      # Campaign management + 3-step builder (cascade picker for layered verticals)
    │   ├── optimize/       # Revenue Optimizer — KPI strip, heatmap, gaps, AI recommendations
    │   ├── packs/          # Pack Explorer — vertical / vendor / product / regional with AI Auto-fill
    │   ├── activity/       # Real activity feed (no simulator)
    │   └── dashboard/      # KPI dashboard
    ├── components/         # Shared React UI (shadcn/ui based)
    └── lib/
        ├── api.ts          # All HTTP calls to the backend
        ├── types.ts        # TypeScript interfaces
        └── vertical-context.tsx  # Active vertical state (sidebar branding follows it)
```

---

## Key File Reference

| File | What it does |
|------|-------------|
| [backend/app/main.py](backend/app/main.py) | FastAPI app entry point. Idempotent column migrations on startup. |
| [backend/app/config.py](backend/app/config.py) | `.env` → typed settings. Add new env vars here. |
| [backend/app/packs/loader.py](backend/app/packs/loader.py) | `PackLoader` with `load_*`, `save_*`, `delete_*` per layer; `compose(vertical, vendor, product)` and `compose_default(vertical)` produce the unified pack object the agents consume. |
| [backend/app/agents/base.py](backend/app/agents/base.py) | `get_llm()` and `format_pack_context()` — the latter renders the composed pack for use inside agent system prompts. |
| [backend/app/agents/discovery.py](backend/app/agents/discovery.py) | Discovery flow + `SEGMENT_CONFIGS` (per-vertical prompts) + `_collect_vendor_exclusions()` + placeholder-contact filter. |
| [backend/app/agents/optimizer.py](backend/app/agents/optimizer.py) | Revenue Optimizer's recommendation generation. Uses Claude extended thinking; vertical-aware (`vertical == "car_rental"`). |
| [backend/app/services/occupancy_service.py](backend/app/services/occupancy_service.py) | KPIs, gap analysis, daily heatmap. Pure SQL, vertical-aware fallback rates and unit types. |
| [backend/app/routers/packs.py](backend/app/routers/packs.py) | Pack CRUD + AI generation endpoints. `BUILTIN_VERTICALS / VENDORS / PRODUCTS` lists protect the shipped packs from deletion. |
| [frontend/lib/vertical-context.tsx](frontend/lib/vertical-context.tsx) | Active vertical state. Sidebar branding (DockMaster vs Thermeon vs …) and per-page terminology react to this. |
| [frontend/app/packs/page.tsx](frontend/app/packs/page.tsx) | Pack Explorer. Renders all four pack layers with view + edit + AI Auto-fill. |
| [frontend/app/campaigns/new/page.tsx](frontend/app/campaigns/new/page.tsx) | 3-step Campaign Builder. Cascade picker for layered verticals. |
| [frontend/app/optimize/page.tsx](frontend/app/optimize/page.tsx) | Revenue Optimizer page — terminology and unit labels react to active vertical via `useTerms()`. |

---

## Handing off as a zip

If you need to share the project without giving someone git access, use the
bundled packaging scripts. They mirror `.gitignore` — secrets, virtualenvs,
`node_modules`, databases, and backups are stripped out, but all source code,
pack files (vertical + vendor + product + regional), docs, install scripts,
and seed CSVs are kept.

```bash
# macOS / Linux
./package.sh                          # → ../sdr-engine-YYYY-MM-DD.zip
./package.sh /tmp/handover.zip        # custom path
./package.sh --no-dockmaster         # exclude DockMaster packs

# Windows
.\package.ps1                         # → ../sdr-engine-YYYY-MM-DD.zip
.\package.ps1 -OutputPath C:\out.zip
.\package.ps1 -IncludeDockmaster:$false
```

Both scripts include a sanity check that drops any `.env`, encryption key, or
`*.db` file that slipped through, so you can't accidentally ship secrets.

---

## Demo Reset

The sidebar **Reset Demo** button calls `POST /demo/reset` which wipes campaigns, sequences, activity, and AI research profiles — but **preserves prospect rows**. Engagement counters return to honest zero. There is no fake-activity simulator: the activity feed only shows real events from real pipeline runs.
