"""
Twilio Voice adapter — outbound voice calls (placeholder for the user's own
internal AI caller integration; same capability shape).

Stub: provider exists in the registry so the engine can advertise VOICE_CALL
capability and the Settings UI can configure credentials. No production
traffic flows through this yet. The user's internal AI caller will plug in
either by replacing this provider or by registering a sibling provider with
the same capability.
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _account_sid() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_account_sid")


def _auth_token() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_auth_token")


def _voice_from() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_voice_from")


class TwilioVoiceProvider(BaseProvider):
    name = "twilio_voice"
    capabilities = frozenset({Capability.VOICE_CALL})

    def is_configured(self) -> bool:
        return bool(_account_sid() and _auth_token() and _voice_from())

    async def call(self, *, to: str, twiml_url: str | None = None, from_: str | None = None) -> dict:
        if not self.is_configured():
            raise NotConfigured("Twilio Voice credentials are not set (check Settings)")
        raise NotImplementedError("Twilio Voice call() is stubbed; wire when voice channel is ready")
