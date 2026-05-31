"""
Tavily web-search adapter.

This is the reference implementation that proves the seam works end-to-end.
The DiscoveryAgent currently calls Tavily inline (see app/agents/discovery.py)
— a follow-up refactor will route that call through this adapter so the
agent depends on Capability.WEB_SEARCH rather than the Tavily HTTP shape.
"""
import httpx

from app.integrations.base import BaseProvider, Capability, NotConfigured, ProviderError

TAVILY_API_URL = "https://api.tavily.com/search"


def _api_key() -> str | None:
    """DB-first, .env fallback. Lets the Settings UI override the .env key
    without a backend restart."""
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("tavily_api_key")


class TavilyProvider(BaseProvider):
    name = "tavily"
    capabilities = frozenset({Capability.WEB_SEARCH})

    def is_configured(self) -> bool:
        return bool(_api_key())

    async def search(self, query: str, max_results: int = 5) -> list[dict]:
        """Returns a list of {title, url, content} dicts."""
        key = _api_key()
        if not key:
            raise NotConfigured("Tavily API key is not set (check Settings or TAVILY_API_KEY env var)")
        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                resp = await client.post(
                    TAVILY_API_URL,
                    json={
                        "api_key": key,
                        "query": query,
                        "search_depth": "advanced",
                        "max_results": max_results,
                        "include_answer": False,
                    },
                )
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Tavily request failed: {e}") from e
            return resp.json().get("results", [])
