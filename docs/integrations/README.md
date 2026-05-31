# Integrations — Design Docs

Each file in this folder describes one external integration: where it plugs into the engine, what env config it needs, what data model changes it implies, and how to verify it.

## Wired today

| Provider  | Capability             | Status                                            | Doc |
|-----------|------------------------|---------------------------------------------------|-----|
| Tavily    | `WEB_SEARCH`           | **Live** — discovery routes through the registry. | [tavily.md](tavily.md) |
| Firecrawl | `URL_SCRAPE`           | **Live (optional)** — used by the website enrichment agent + verifier when `FIRECRAWL_API_KEY` is set. | [firecrawl.md](firecrawl.md) |
| LocalScraper | `URL_SCRAPE`        | **Live (always-on fallback)** — `httpx + trafilatura + selectolax`; runs without an API key. JS-only sites and aggressive anti-bot pages will fail here. | [firecrawl.md](firecrawl.md) (covered in the URL_SCRAPE section) |
| Apollo    | `COMPANY_/PERSON_ENRICHMENT` | Stub adapter — raises `NotConfigured` until env key set | [apollo.md](apollo.md) |

## Designed but not yet wired

| Provider  | Capability        | Doc |
|-----------|-------------------|-----|
| SendGrid  | `EMAIL_SEND`      | [sendgrid.md](sendgrid.md) |
| Salesforce | `CRM_SYNC`       | [salesforce.md](salesforce.md) |
| Inbound (Gmail/SendGrid Inbound Parse/IMAP) | `INBOUND_LEAD` | [inbound.md](inbound.md) |

## How to add a new integration

The integration registry lives at [`backend/app/integrations/`](../../backend/app/integrations/). Three files matter:

- `base.py` — the `BaseProvider` ABC and the `Capability` enum. Add a new capability here if your integration doesn't fit an existing one.
- `registry.py` — singleton `registry` with `register()`, `get(name)`, `by_capability(cap)`, `status()`.
- `__init__.py` — instantiates each provider and calls `registry.register(...)` so import-time wiring is automatic.

To add a new provider:

1. Subclass `BaseProvider` in a new module under `app/integrations/<name>.py`.
2. Declare `name`, `capabilities`, and `is_configured()`.
3. Add the provider's required env keys to `app/config.py` (all optional — `is_configured()` reads them).
4. Register the instance in `app/integrations/__init__.py`.
5. The relevant agent / service starts using it via `registry.by_capability(Capability.X, configured_only=True)`.

The engine never imports your provider directly. That's the point — every integration is a drop-in.
