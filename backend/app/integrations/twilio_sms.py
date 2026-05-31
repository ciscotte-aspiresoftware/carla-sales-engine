"""
Twilio SMS adapter — outbound text messages.

Stub: provider exists so the registry can advertise SMS_SEND. No production
traffic yet. Wire per the same pattern as voice when the SMS channel is ready.
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _account_sid() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_account_sid")


def _auth_token() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_auth_token")


def _sms_from() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("twilio_sms_from")


class TwilioSMSProvider(BaseProvider):
    name = "twilio_sms"
    capabilities = frozenset({Capability.SMS_SEND})

    def is_configured(self) -> bool:
        return bool(_account_sid() and _auth_token() and _sms_from())

    async def send(self, *, to: str, body: str, from_: str | None = None) -> dict:
        if not self.is_configured():
            raise NotConfigured("Twilio SMS credentials are not set (check Settings)")
        raise NotImplementedError("Twilio SMS send() is stubbed; wire when SMS channel is ready")
