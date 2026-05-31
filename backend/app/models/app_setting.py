from sqlalchemy import Column, String, Boolean, DateTime, Text
from sqlalchemy.sql import func
from app.database import Base


class AppSetting(Base):
    """Key/value store for runtime-mutable engine settings.

    Two flavours:
      - is_secret=True: API keys, OAuth tokens, etc. `value` is Fernet-encrypted
        ciphertext (see app.services.secrets_crypto). Reads decrypt on access.
      - is_secret=False: branding, display preferences, default vertical. `value`
        is stored plain.

    The settings UI surfaces every row here. Adapters that previously read
    from `settings.tavily_api_key` etc. now go through
    `app_settings_service.get_or_env(...)` which checks this table first and
    falls back to the env var if not set.

    NOTE: legacy LLM model preferences live in .app_settings.json (a separate
    file at the project root) — not in this table. They predate this design
    and have their own service. Future cleanup: migrate them in here too.
    """
    __tablename__ = "app_settings"

    key = Column(String(100), primary_key=True)
    # Fernet ciphertext when is_secret=True, plain UTF-8 otherwise.
    value = Column(Text, nullable=False)
    is_secret = Column(Boolean, nullable=False, default=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
