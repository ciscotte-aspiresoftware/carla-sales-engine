"""
External-tool integrations for the agent pipeline.

Add a new provider in three steps:
  1. Subclass BaseProvider in a new module here.
  2. Declare its `capabilities` (see Capability enum).
  3. Register an instance below.

Agent code looks providers up by capability via `registry.by_capability(...)`,
so callers never need to know which concrete vendor backs a given tool.

Channel + sync providers (sendgrid, twilio_voice, twilio_sms, linkedin,
salesforce, intent_signals) ship as stubs: they appear in the registry so the
Settings UI can configure them and the engine can advertise the capability,
but their `send`/`call`/`upsert_lead` methods are NotImplementedError until
wired by the receiving portfolio team. See docs/integrations/ for per-provider
wiring guides.
"""
from app.integrations.apollo import ApolloProvider
from app.integrations.base import BaseProvider, Capability, NotConfigured, ProviderError
from app.integrations.firecrawl import FirecrawlProvider
from app.integrations.hubspot import HubSpotProvider
from app.integrations.intent_signals import IntentSignalProvider
from app.integrations.linkedin import LinkedInProvider
from app.integrations.local_scraper import LocalScraperProvider
from app.integrations.registry import registry
from app.integrations.salesforce import SalesforceProvider
from app.integrations.sendgrid import SendGridProvider
from app.integrations.tavily import TavilyProvider
from app.integrations.twilio_sms import TwilioSMSProvider
from app.integrations.twilio_voice import TwilioVoiceProvider

# Data providers (live or partially wired)
registry.register(TavilyProvider())
registry.register(ApolloProvider())
# URL_SCRAPE: Firecrawl registered first so it wins when configured;
# LocalScraperProvider is the always-available fallback (no API key needed).
registry.register(FirecrawlProvider())
registry.register(LocalScraperProvider())
# CRM sync
registry.register(HubSpotProvider())
# Channel + sync stubs (NotImplementedError on call until wired)
registry.register(SendGridProvider())
registry.register(TwilioVoiceProvider())
registry.register(TwilioSMSProvider())
registry.register(LinkedInProvider())
registry.register(SalesforceProvider())
registry.register(IntentSignalProvider())

__all__ = [
    "ApolloProvider",
    "BaseProvider",
    "Capability",
    "FirecrawlProvider",
    "HubSpotProvider",
    "IntentSignalProvider",
    "LinkedInProvider",
    "LocalScraperProvider",
    "NotConfigured",
    "ProviderError",
    "SalesforceProvider",
    "SendGridProvider",
    "TavilyProvider",
    "TwilioSMSProvider",
    "TwilioVoiceProvider",
    "registry",
]
