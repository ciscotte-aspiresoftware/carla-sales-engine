# URL_SCRAPE — Firecrawl + Local fallback

## Capability

`Capability.URL_SCRAPE`. Two providers are registered: Firecrawl (preferred when keyed) and a free `httpx + trafilatura + selectolax` local fallback (always available). Callers never reach into the registry directly — they go through [`backend/app/services/scrape_provider.py:pick_scrape_provider()`](../../backend/app/services/scrape_provider.py) which returns the highest-priority configured provider. Because the local fallback's `is_configured()` always returns `True`, this function never returns `None`.

## Providers

### FirecrawlProvider — preferred

[`backend/app/integrations/firecrawl.py`](../../backend/app/integrations/firecrawl.py).

```python
class FirecrawlProvider(BaseProvider):
    name = "firecrawl"
    capabilities = frozenset({Capability.URL_SCRAPE})
    def is_configured(self) -> bool: ...   # checks settings.firecrawl_api_key
    async def scrape(self, url: str, formats: list[str] | None = None) -> dict: ...
```

Returns `{"data": {"markdown", "html", "metadata"}}` — same shape both providers conform to so consumers stay provider-agnostic. `formats` defaults to `["markdown"]`. Firecrawl handles JS rendering, common anti-bot challenges (Cloudflare), and PDF parsing transparently.

### LocalScraperProvider — always-on fallback

[`backend/app/integrations/local_scraper.py`](../../backend/app/integrations/local_scraper.py).

Pure-Python scraper: `httpx` for fetch (15s timeout, follow redirects, 1MB body cap), `trafilatura` for main-text → markdown extraction, `selectolax` for `<title>` / `<meta>` / link parsing. `is_configured()` always returns `True`, so the website-enrichment pipeline works out of the box without any keys. JS-rendered single-page apps and aggressive anti-bot pages will fail here — configure Firecrawl to handle those.

## Where they're used

| Caller | What for |
|---|---|
| [`backend/app/agents/website_enrichment.py`](../../backend/app/agents/website_enrichment.py) | Full multi-page scrape: homepage + up to 5 keyword-ranked inner pages. Robots-aware, rate-limited per registrable domain, concatenated markdown fed to Claude for fact extraction. |
| [`backend/app/services/website_verifier.py`](../../backend/app/services/website_verifier.py) | Pre-scrape verifier — fetches the homepage to check the URL belongs to the prospect (name-token overlap + parked-domain markers) and reuses the fetched body so the agent doesn't double-fetch. |
| [`backend/app/services/website_url_check.py`](../../backend/app/services/website_url_check.py) | Lite "is this URL alive and the right business?" check used by discovery's auto-gate and the `/agents/verify-websites/batch` endpoint. |

## Safety + politeness

All callers go through [`backend/app/services/scrape_safety.py`](../../backend/app/services/scrape_safety.py) for:

- **Robots.txt** — `protego`-backed parser, per-domain TTL-1h cache. Missing/malformed robots.txt → allow (RFC 9309 §2.2.3 compliant). Honoured `Crawl-delay` is capped at 10s.
- **Per-registrable-domain rate limiter** — `asyncio.Lock` + min-interval gate (`PER_DOMAIN_MIN_INTERVAL_SECONDS = 1.5`). Two prospects sharing the same parent domain don't burst.
- **User-Agent** — `DEFAULT_USER_AGENT = "AspireSDR/1.0 (+https://aspire.example/sdr-bot)"`, overridable via the in-app Settings page (`website_scrape_user_agent`).
- **Page caps** — `MAX_PAGES_PER_SITE = 5`, `MAX_BYTES_PER_PAGE = 1MB`.

## Env config

- `FIRECRAWL_API_KEY` — optional. Set in `backend/.env` or via the Settings UI. When unset, the local provider serves every scrape.

## Data model

The scrape result is persisted to `Prospect.website_research` (JSON). Verified scrapes also promote `provenance` keys to a new `"scrape"` source class — see [the website enrichment agent module docstring](../../backend/app/agents/website_enrichment.py) for the full payload shape.

## Verification

```bash
# Show both providers registered
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.capabilities[]=="url_scrape")'
# Local fallback is always configured: true.
# Firecrawl flips to configured: true once FIRECRAWL_API_KEY is set.

# Smoke-test the picked provider directly
backend/.venv/Scripts/python -c "
import asyncio
from app.services.scrape_provider import pick_scrape_provider
async def main():
    p = pick_scrape_provider()
    print('using:', p.name)
    r = await p.scrape('https://example.com')
    print('status:', r['data']['metadata']['statusCode'], 'markdown bytes:', len(r['data']['markdown']))
asyncio.run(main())
"
```

## Failure modes

- **4xx (404, 401)** on a candidate page → caller treats as "no scrape data" and continues; inner-page fetches that fail are silently skipped so a 25-prospect batch isn't poisoned by one broken page.
- **JS-only site under local provider** → empty markdown → the verifier's "empty_page" rejection kicks in and the prospect is flagged needs-review rather than misclassified. Set `FIRECRAWL_API_KEY` to handle these.
- **Anti-bot pages (Cloudflare Turnstile etc.)** under local provider → 4xx or empty body → same path as above. Firecrawl handles most of these natively.
- **Long scrape (>30s)** → `httpx` timeout in the local provider; Firecrawl has its own server-side timeout. Either way the agent skips that page and proceeds.
