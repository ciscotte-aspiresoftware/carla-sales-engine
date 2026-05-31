"""
LinkedIn adapter — outbound connection requests + InMail.

Stub: provider exists so the registry advertises LINKEDIN_OUTREACH. The actual
mechanism varies by partner (Sales Navigator API, third-party automation
tooling, browser-based agent). Concrete `send_message()` left blank until the
portfolio team picks an underlying transport.
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _session_token() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("linkedin_session_token")


class LinkedInProvider(BaseProvider):
    name = "linkedin"
    capabilities = frozenset({Capability.LINKEDIN_OUTREACH})

    def is_configured(self) -> bool:
        return bool(_session_token())

    async def send_message(self, *, profile_url: str, body: str) -> dict:
        if not self.is_configured():
            raise NotConfigured("LinkedIn session token is not set (check Settings)")
        raise NotImplementedError("LinkedIn send_message() is stubbed; pick a transport before wiring")
