"""
Salesforce adapter — bidirectional CRM sync (lead push, activity log, inbound
record updates via webhook).

Stub: provider exists so the registry advertises CRM_SYNC. Real wiring needs
OAuth2 with refresh tokens (encrypted per-tenant in production); for the
single-org demo posture this just stores client_id/client_secret in app
settings. See docs/integrations/salesforce.md for the full plan.
"""
from app.integrations.base import BaseProvider, Capability, NotConfigured


def _client_id() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("salesforce_client_id")


def _client_secret() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("salesforce_client_secret")


class SalesforceProvider(BaseProvider):
    name = "salesforce"
    capabilities = frozenset({Capability.CRM_SYNC})

    def is_configured(self) -> bool:
        return bool(_client_id() and _client_secret())

    async def upsert_lead(self, *, prospect_id: int, payload: dict) -> dict:
        if not self.is_configured():
            raise NotConfigured("Salesforce credentials are not set (check Settings)")
        raise NotImplementedError("Salesforce upsert_lead() is stubbed; wire per docs/integrations/salesforce.md")

    async def log_activity(self, *, lead_external_id: str, activity: dict) -> dict:
        if not self.is_configured():
            raise NotConfigured("Salesforce credentials are not set (check Settings)")
        raise NotImplementedError("Salesforce log_activity() is stubbed; wire per docs/integrations/salesforce.md")
