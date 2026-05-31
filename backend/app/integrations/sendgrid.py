"""
SendGrid adapter — transactional email send.

Stub: provider exists in the registry so the Settings UI can configure keys
and the engine can advertise EMAIL_SEND capability, but no production traffic
flows through this yet. When a portfolio team is ready to ship real outbound
email, fill in `send()` per docs/integrations/sendgrid.md and add a
`/api/v1/webhooks/sendgrid/events` route (Phase 2 plumbing handles signature
verification + idempotency).
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _api_key() -> str | None:
    """DB-first, .env fallback (see app_settings_service.get_or_env)."""
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("sendgrid_api_key")


def _default_from() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("sendgrid_default_from")


class SendGridProvider(BaseProvider):
    name = "sendgrid"
    capabilities = frozenset({Capability.EMAIL_SEND})

    def is_configured(self) -> bool:
        return bool(_api_key())

    async def send(self, *, to: str, subject: str, body: str, from_: str | None = None) -> dict:
        key = _api_key()
        if not key:
            raise NotConfigured("SendGrid API key is not set (check Settings or SENDGRID_API_KEY env var)")
        # Wiring left for the receiving portfolio team — see docs/integrations/sendgrid.md
        # for the production-ready httpx call shape, error handling, and provider_message_id capture.
        raise NotImplementedError("SendGrid send() is stubbed; wire per docs/integrations/sendgrid.md")
