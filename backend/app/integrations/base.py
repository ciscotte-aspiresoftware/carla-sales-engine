"""
Provider interface for external data integrations (search, enrichment, scraping).

This is the seam where third-party tools plug in. Each adapter declares which
capabilities it supports and whether it is configured (i.e. has an API key).
Agent code calls providers by capability via the registry — never by hardcoded
HTTP call — so adding Apollo / Firecrawl / LinkedIn / etc. is a matter of
authoring one file and registering it.
"""
from abc import ABC, abstractmethod
from enum import Enum


class Capability(str, Enum):
    # Data providers (already wired)
    WEB_SEARCH = "web_search"
    COMPANY_ENRICHMENT = "company_enrichment"
    PERSON_ENRICHMENT = "person_enrichment"
    URL_SCRAPE = "url_scrape"
    # Outbound channels (stubbed; wired later)
    EMAIL_SEND = "email_send"
    SMS_SEND = "sms_send"
    VOICE_CALL = "voice_call"
    LINKEDIN_OUTREACH = "linkedin_outreach"
    # Closed-loop ingestion (stubbed; wired later)
    INBOUND_LEAD = "inbound_lead"
    REPLY_INGEST = "reply_ingest"
    # People discovery (search by domain/org, not just enrich a known email)
    PERSON_SEARCH = "person_search"
    # External sync + signals (stubbed; wired later)
    CRM_SYNC = "crm_sync"
    COMPANY_SYNC = "company_sync"
    CONTACT_SYNC = "contact_sync"
    INTENT_SIGNAL = "intent_signal"


class ProviderError(Exception):
    """Base class for provider failures (HTTP errors, bad payloads, etc.)."""


class NotConfigured(ProviderError):
    """Raised when a provider is invoked without the required credentials."""


class BaseProvider(ABC):
    name: str = ""
    capabilities: frozenset[Capability] = frozenset()

    @abstractmethod
    def is_configured(self) -> bool:
        """Return True iff the provider has the env config it needs to run."""
