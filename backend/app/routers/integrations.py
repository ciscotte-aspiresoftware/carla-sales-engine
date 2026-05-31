"""
Integrations router — read-only endpoints for the integration registry.

Surfaces which external providers (Tavily, Apollo, Firecrawl, plus any new
adapters dropped into app.integrations) are configured and what capabilities
they declare. Drives the demo's "what's wired vs what's just stubbed" UI.
"""
from fastapi import APIRouter

from app.integrations import registry

router = APIRouter()


@router.get("/integrations/status")
async def integrations_status():
    """One row per registered provider: name, capabilities, configured flag.
    `configured: true` means the provider has the env config it needs and
    will actually call out at runtime; `false` means it's a stub waiting on
    an API key.
    """
    return {"providers": registry.status()}
