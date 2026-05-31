"""
Webhook router subpackage.

Exposes a single APIRouter that nests sub-routers per provider. Each
sub-router verifies the signature with `app.services.webhook_signatures`,
dedupes on (provider, external_id) via `WebhookDelivery`, and emits
`ActivityEvent` rows for downstream UI / classifier work.

To add a new provider's webhook:
  1. Create a new module here (e.g. `mailgun.py`).
  2. Pick an `external_id` field from the payload that's stable per delivery.
  3. Verify the signature first; on failure return 200 silently.
  4. Use `record_delivery(...)` from .common to dedupe + log.
"""
from fastapi import APIRouter

from app.routers.webhooks.inbound import router as inbound_router
from app.routers.webhooks.salesforce import router as salesforce_router
from app.routers.webhooks.sendgrid import router as sendgrid_router
from app.routers.webhooks.twilio import router as twilio_router

router = APIRouter()
router.include_router(sendgrid_router, prefix="/webhooks/sendgrid")
router.include_router(twilio_router, prefix="/webhooks/twilio")
router.include_router(salesforce_router, prefix="/webhooks/salesforce")
router.include_router(inbound_router, prefix="/webhooks/inbound")

__all__ = ["router"]
