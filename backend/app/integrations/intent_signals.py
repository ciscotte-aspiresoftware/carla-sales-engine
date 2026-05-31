"""
Intent signals adapter — generic placeholder for buying-signal feeds.

Examples a portfolio team might wire here: job postings (Greenhouse / Lever
public boards), funding announcements (Crunchbase / news feeds), website
intent (Bombora / G2 reviews). The engine doesn't care which — a configured
INTENT_SIGNAL provider's `signals_for()` is consulted by the researcher and
fed into the research prompt as additional context.

See docs/integrations/intent_signals.md for the design.
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _api_key() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("intent_signal_provider_key")


class IntentSignalProvider(BaseProvider):
    name = "intent_signals"
    capabilities = frozenset({Capability.INTENT_SIGNAL})

    def is_configured(self) -> bool:
        return bool(_api_key())

    async def signals_for(self, *, business_name: str, website_url: str | None = None) -> list[dict]:
        """Return a list of {kind, summary, url, observed_at} dicts."""
        if not self.is_configured():
            raise NotConfigured("Intent signal provider key is not set (check Settings)")
        raise NotImplementedError("Intent signals signals_for() is stubbed; wire per docs/integrations/intent_signals.md")
