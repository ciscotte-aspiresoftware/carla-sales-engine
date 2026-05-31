"""
Salesforce inbound webhook — record updates pushed from Salesforce.

Generic HMAC-SHA256 verification using `salesforce_webhook_secret`. The actual
production wire format is whatever the receiving portfolio team configures
in their Apex trigger / Outbound Message / Platform Event subscriber — this
route accepts an arbitrary JSON envelope with an `event_id` for idempotency.
"""
import json
import logging

from fastapi import APIRouter, Request

from app.routers.webhooks.common import emit_activity_event, record_delivery
from app.services.app_settings_service import app_settings_service
from app.services.webhook_signatures import hash_payload, verify_hmac_sha256

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("")
async def salesforce_event(request: Request):
    body = await request.body()
    secret = app_settings_service.get_or_env("salesforce_webhook_secret")
    sig = request.headers.get("X-Signature") or request.headers.get("X-Salesforce-Signature")
    if not verify_hmac_sha256(body, sig, secret):
        logger.info("salesforce webhook: signature rejected or unconfigured")
        return {"received": True, "verified": False}

    try:
        payload = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return {"received": True, "verified": True, "processed": 0}

    external_id = payload.get("event_id") or payload.get("Id") or ""
    if not external_id:
        return {"received": True, "verified": True, "processed": 0}

    if not record_delivery(provider="salesforce", external_id=external_id,
                           payload_hash=hash_payload(body)):
        return {"received": True, "verified": True, "duplicate": True}

    emit_activity_event(
        event_type="crm_record_updated",
        event_data={"provider": "salesforce", "raw": payload},
    )
    return {"received": True, "verified": True, "processed": 1}
