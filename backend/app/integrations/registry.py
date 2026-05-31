"""
ProviderRegistry — single source of truth for which integrations are wired in.

Agents lookup providers by capability (e.g. "give me anyone who can do
WEB_SEARCH") rather than by name. That lets us swap Tavily for Brave or add
Apollo alongside Clearbit without touching agent code.
"""
from typing import Optional

from app.integrations.base import BaseProvider, Capability


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, BaseProvider] = {}

    def register(self, provider: BaseProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str) -> Optional[BaseProvider]:
        return self._providers.get(name)

    def by_capability(self, cap: Capability, *, configured_only: bool = False) -> list[BaseProvider]:
        out = [p for p in self._providers.values() if cap in p.capabilities]
        if configured_only:
            out = [p for p in out if p.is_configured()]
        return out

    def status(self) -> list[dict]:
        """Snapshot of every registered provider — useful for a future status page."""
        return [
            {
                "name": p.name,
                "capabilities": sorted(c.value for c in p.capabilities),
                "configured": p.is_configured(),
            }
            for p in self._providers.values()
        ]


registry = ProviderRegistry()
