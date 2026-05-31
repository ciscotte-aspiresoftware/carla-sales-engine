"""
App settings service — DB-backed key/value store with env-var fallback.

Read pattern:
    value = app_settings_service.get_or_env("tavily_api_key", "TAVILY_API_KEY")
        # 1. DB row with key="tavily_api_key" (decrypted if is_secret)
        # 2. else os.environ["TAVILY_API_KEY"]
        # 3. else None

Write pattern:
    app_settings_service.set("tavily_api_key", "tvly-abc...", is_secret=True)
    # Encrypts and persists. Subsequent reads return the new value immediately.

The service is the single source of truth for runtime-mutable engine config.
Integration adapters that previously read pydantic settings directly should
go through `get_or_env(...)` so a key set via the Settings UI takes effect
without a backend restart.
"""
from __future__ import annotations

import os
from typing import Optional

from app.database import SessionLocal
from app.models.app_setting import AppSetting
from app.services.secrets_crypto import decrypt, encrypt


# Catalog of every settable key, with metadata the UI uses to render the page.
# Add a new entry here when adding a new integration / branding field.
class SettingDef:
    __slots__ = ("key", "env_var", "is_secret", "category", "label", "description", "placeholder")
    def __init__(self, key, env_var=None, is_secret=False, category="general",
                 label=None, description=None, placeholder=None):
        self.key = key
        self.env_var = env_var
        self.is_secret = is_secret
        self.category = category
        self.label = label or key
        self.description = description or ""
        self.placeholder = placeholder or ""


SETTING_DEFS: list[SettingDef] = [
    # ── API keys (encrypted) ──────────────────────────────────────────────
    SettingDef("anthropic_api_key", env_var="ANTHROPIC_API_KEY", is_secret=True,
               category="api_keys", label="Anthropic API Key",
               description="Required. Powers every Claude call (discovery, research, copywriter, etc.).",
               placeholder="sk-ant-..."),
    SettingDef("tavily_api_key", env_var="TAVILY_API_KEY", is_secret=True,
               category="api_keys", label="Tavily API Key",
               description="Optional. Web search for prospect verification during discovery. Without it, discovery falls back to Claude-knowledge-only mode.",
               placeholder="tvly-..."),
    SettingDef("apollo_api_key", env_var="APOLLO_API_KEY", is_secret=True,
               category="api_keys", label="Apollo API Key",
               description="Optional. Company + person enrichment. Stub until set.",
               placeholder="apollo-..."),
    SettingDef("firecrawl_api_key", env_var="FIRECRAWL_API_KEY", is_secret=True,
               category="api_keys", label="Firecrawl API Key",
               description="Optional. URL scraping for thin Tavily results. Stub until set.",
               placeholder="fc-..."),
    SettingDef("intent_signal_provider_key", env_var="INTENT_SIGNAL_PROVIDER_KEY", is_secret=True,
               category="api_keys", label="Intent Signals API Key",
               description="Optional. Generic intent-signals feed (job postings, funding, website intent). Researcher consults this when configured. Stub until wired.",
               placeholder="provider-..."),
    # ── Channels (encrypted; stub providers — wired by receiving team) ───
    SettingDef("sendgrid_api_key", env_var="SENDGRID_API_KEY", is_secret=True,
               category="channels", label="SendGrid API Key",
               description="Outbound email send. Required for EMAIL_SEND capability. See docs/integrations/sendgrid.md.",
               placeholder="SG...."),
    SettingDef("sendgrid_default_from", env_var="SENDGRID_DEFAULT_FROM", is_secret=False,
               category="channels", label="SendGrid Default From",
               description="Default sender address used when a campaign doesn't override it.",
               placeholder="hello@yourco.com"),
    SettingDef("sendgrid_webhook_secret", env_var="SENDGRID_WEBHOOK_SECRET", is_secret=True,
               category="channels", label="SendGrid Webhook Secret",
               description="HMAC secret used to verify SendGrid event-webhook deliveries.",
               placeholder=""),
    SettingDef("twilio_account_sid", env_var="TWILIO_ACCOUNT_SID", is_secret=True,
               category="channels", label="Twilio Account SID",
               description="Twilio account identifier — drives both voice and SMS providers.",
               placeholder="AC..."),
    SettingDef("twilio_auth_token", env_var="TWILIO_AUTH_TOKEN", is_secret=True,
               category="channels", label="Twilio Auth Token",
               description="Twilio auth token. Also used to verify inbound webhook signatures.",
               placeholder=""),
    SettingDef("twilio_voice_from", env_var="TWILIO_VOICE_FROM", is_secret=False,
               category="channels", label="Twilio Voice From",
               description="E.164-formatted number used as the caller ID for outbound voice.",
               placeholder="+15551234567"),
    SettingDef("twilio_sms_from", env_var="TWILIO_SMS_FROM", is_secret=False,
               category="channels", label="Twilio SMS From",
               description="E.164-formatted number or messaging service SID used for outbound SMS.",
               placeholder="+15551234567"),
    SettingDef("linkedin_session_token", env_var="LINKEDIN_SESSION_TOKEN", is_secret=True,
               category="channels", label="LinkedIn Session Token",
               description="Token / cookie / OAuth pair used by your chosen LinkedIn outreach transport. Stub until wired.",
               placeholder=""),
    SettingDef("salesforce_client_id", env_var="SALESFORCE_CLIENT_ID", is_secret=True,
               category="channels", label="Salesforce Client ID",
               description="OAuth client ID for the Salesforce connected app. See docs/integrations/salesforce.md.",
               placeholder=""),
    SettingDef("salesforce_client_secret", env_var="SALESFORCE_CLIENT_SECRET", is_secret=True,
               category="channels", label="Salesforce Client Secret",
               description="OAuth client secret paired with the client ID.",
               placeholder=""),
    SettingDef("salesforce_webhook_secret", env_var="SALESFORCE_WEBHOOK_SECRET", is_secret=True,
               category="channels", label="Salesforce Webhook Secret",
               description="HMAC secret used to verify inbound Salesforce webhook deliveries.",
               placeholder=""),
    SettingDef("hubspot_access_token", env_var="HUBSPOT_ACCESS_TOKEN", is_secret=True,
               category="channels", label="HubSpot Access Token",
               description="Private App access token for HubSpot CRM (Settings → Integrations → Private Apps). Enables push-to-HubSpot on any prospect.",
               placeholder="pat-na1-..."),
    # ── Branding / app identity (plain) ──────────────────────────────────
    SettingDef("app_name", category="branding", label="App Name",
               description="Display name in the sidebar header and browser tab. Defaults to 'SDR Engine'.",
               placeholder="SDR Engine"),
    SettingDef("parent_organisation", category="branding", label="Parent Organisation",
               description="Optional. Shown in the sidebar footer (e.g. 'Acme Corp · Portfolio').",
               placeholder=""),
    SettingDef("default_vertical", category="branding", label="Default Vertical",
               description="Pack id to select on first visit. Falls back to first available pack.",
               placeholder="marina"),
    # ── Display preferences (plain) ──────────────────────────────────────
    SettingDef("default_currency", category="display", label="Default Currency",
               description="USD / EUR / GBP. Used by the Costs page on first load.",
               placeholder="USD"),
    # ── Website scraping (plain) ─────────────────────────────────────────
    SettingDef("website_scrape_default_max_pages", category="scraping",
               label="Default Pages Per Scrape",
               description="Default number of pages fetched per prospect when no override is given. Capped at 5 server-side. Default 2 (homepage + about).",
               placeholder="2"),
    SettingDef("website_scrape_user_agent", category="scraping",
               label="Scraper User-Agent",
               description="Identifying User-Agent string sent with every scrape request. Override the default if you need a fixed string for allowlisting by a recipient site's WAF.",
               placeholder="AspireSDR/1.0 (+https://aspire.example/sdr-bot)"),
    # ── Schedule (plain; demo-grade in-process scheduler) ─────────────────
    SettingDef("cadence_default", category="schedule", label="Default Cadence",
               description="Cadence applied to new campaigns: immediate, next_business_day_9am, weekly_tuesday_10am, or custom (cron).",
               placeholder="immediate"),
    SettingDef("business_hours_start", category="schedule", label="Business Hours Start",
               description="HH:MM. Used by next-business-day cadence. Defaults to 09:00.",
               placeholder="09:00"),
    SettingDef("business_hours_end", category="schedule", label="Business Hours End",
               description="HH:MM. Reserved for future per-step delays. Defaults to 17:00.",
               placeholder="17:00"),
    SettingDef("timezone", category="schedule", label="Timezone",
               description="IANA timezone name (e.g. UTC, Europe/London, America/New_York). Drives the cadence scheduler.",
               placeholder="UTC"),
]

SETTINGS_BY_KEY: dict[str, SettingDef] = {s.key: s for s in SETTING_DEFS}


class AppSettingsService:
    def get(self, key: str) -> Optional[str]:
        """Returns the DB value (decrypted if secret), or None."""
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == key).first()
            if not row:
                return None
            return decrypt(row.value) if row.is_secret else row.value
        finally:
            db.close()

    def get_or_env(self, key: str, env_var: Optional[str] = None) -> Optional[str]:
        """Resolve a setting: DB first (decrypted if secret), then env, then None.

        The "env" fallback reads from the pydantic Settings instance — which
        loads .env at import time — rather than os.environ directly, so values
        that live in .env (the common case) are visible. env_var arg is
        accepted for backwards compat but the preferred call is just
        `get_or_env(key)`; the field name is presumed to match.
        """
        v = self.get(key)
        if v:
            return v
        # Try pydantic Settings field with the same name as the DB key.
        from app.config import settings
        v = getattr(settings, key, None)
        if v:
            return v
        # Last-ditch: bare os.environ for env vars not modeled in pydantic Settings.
        env_name = env_var or (SETTINGS_BY_KEY.get(key).env_var if key in SETTINGS_BY_KEY else None)
        if env_name:
            return os.environ.get(env_name) or None
        return None

    def set(self, key: str, value: str, is_secret: Optional[bool] = None) -> None:
        """Persist a value. is_secret defaults to the SettingDef's declared
        flag; pass explicitly when writing keys not in the registry."""
        if is_secret is None:
            sd = SETTINGS_BY_KEY.get(key)
            is_secret = sd.is_secret if sd else False
        stored = encrypt(value) if is_secret else value
        db = SessionLocal()
        try:
            row = db.query(AppSetting).filter(AppSetting.key == key).first()
            if row:
                row.value = stored
                row.is_secret = is_secret
            else:
                row = AppSetting(key=key, value=stored, is_secret=is_secret)
                db.add(row)
            db.commit()
        finally:
            db.close()

    def delete(self, key: str) -> bool:
        """Returns True if a row was deleted."""
        db = SessionLocal()
        try:
            n = db.query(AppSetting).filter(AppSetting.key == key).delete()
            db.commit()
            return n > 0
        finally:
            db.close()

    def list_for_ui(self) -> list[dict]:
        """Returns one entry per known setting, with masked values for secrets.
        Drives the Settings page."""
        from app.config import settings as pyd_settings
        db = SessionLocal()
        try:
            rows = {r.key: r for r in db.query(AppSetting).all()}
        finally:
            db.close()
        out: list[dict] = []
        for sd in SETTING_DEFS:
            row = rows.get(sd.key)
            # env value: prefer the pydantic Settings field (which sources from
            # .env at boot) over raw os.environ — that's where TAVILY_API_KEY
            # etc. actually live in this codebase.
            env_value = getattr(pyd_settings, sd.key, None)
            if not env_value and sd.env_var:
                env_value = os.environ.get(sd.env_var)
            db_value: Optional[str] = None
            if row:
                db_value = decrypt(row.value) if row.is_secret else row.value
            effective = db_value or env_value
            source = "db" if db_value else ("env" if env_value else "unset")
            out.append({
                "key": sd.key,
                "label": sd.label,
                "description": sd.description,
                "category": sd.category,
                "is_secret": sd.is_secret,
                "env_var": sd.env_var,
                "placeholder": sd.placeholder,
                "configured": bool(effective),
                "source": source,
                # Mask secret values; show plain values verbatim.
                "value_preview": (
                    _mask(effective) if (sd.is_secret and effective) else (effective or "")
                ),
            })
        return out


def _mask(s: str) -> str:
    """Return a safe preview of a secret. Shows the first 4 and last 4 chars
    when the value is long enough; full mask for short values."""
    if not s:
        return ""
    if len(s) <= 8:
        return "•" * len(s)
    return f"{s[:4]}{'•' * 8}{s[-4:]}"


app_settings_service = AppSettingsService()
