"""
Firecrawl adapter — site / page scraping for enrichment that web-search
snippets can't cover (full pricing pages, location/branch lists, schema.org
markup, etc.).

Stub: HTTP shape is sketched but no production traffic flows through this yet.
Drop FIRECRAWL_API_KEY into .env and `scrape()` becomes live.
"""
import httpx

from app.integrations.base import BaseProvider, Capability, NotConfigured, ProviderError

FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1"


def _api_key() -> str | None:
    """DB-first, .env fallback (see app_settings_service.get_or_env)."""
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("firecrawl_api_key")


class FirecrawlProvider(BaseProvider):
    name = "firecrawl"
    capabilities = frozenset({Capability.URL_SCRAPE})

    def is_configured(self) -> bool:
        return bool(_api_key())

    async def scrape(self, url: str, formats: list[str] | None = None) -> dict:
        """Scrape a single URL and return the parsed payload (markdown by default)."""
        key = _api_key()
        if not key:
            raise NotConfigured("Firecrawl API key is not set (check Settings or FIRECRAWL_API_KEY env var)")

        headers = {"Authorization": f"Bearer {key}"}
        payload = {"url": url, "formats": formats or ["markdown"]}

        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                resp = await client.post(f"{FIRECRAWL_API_URL}/scrape", json=payload, headers=headers)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Firecrawl scrape failed: {e}") from e
            return resp.json()
