"""
Single seam for picking a URL_SCRAPE provider.

Callers never reach into the registry directly — they call `pick_scrape_provider()`
and get back the highest-priority configured provider. Because the local
fallback always reports `is_configured() == True`, this never returns None.
"""
from __future__ import annotations

from app.integrations import registry, Capability
from app.integrations.base import BaseProvider


def pick_scrape_provider() -> BaseProvider:
    providers = registry.by_capability(Capability.URL_SCRAPE, configured_only=True)
    if not providers:
        # Defensive: LocalScraperProvider should always be configured. If the
        # registry was overridden in a test, fall back to any URL_SCRAPE
        # provider regardless of config.
        providers = registry.by_capability(Capability.URL_SCRAPE)
    if not providers:
        raise RuntimeError("No URL_SCRAPE provider is registered.")
    return providers[0]
