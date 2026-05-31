"""
Inbound parse webhook — captures replies / forwarded messages and creates
ActivityEvents the classifier can pick up.

Generic HMAC-SHA256 verification using `sendgrid_webhook_secret` (most common
inbound source today is SendGrid Inbound Parse; portfolio teams using Mailgun
or AWS SES can swap the secret key in `app_settings_service` without touching
this route).

Idempotency key is the `Message-Id` header captured in the payload (or
provider-supplied `event_id`).
"""
import json
import logging

from fastapi import APIRouter, Request

from app.routers.webhooks.common import emit_activity_event, record_delivery
from app.services.app_settings_service import app_settings_service
from app.services.webhook_signatures import hash_payload, verify_hmac_sha256

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/email")
async def inbound_email(request: Request):
    body = await request.body()
    secret = app_settings_service.get_or_env("sendgrid_webhook_secret")
    sig = request.headers.get("X-Inbound-Signature") or request.headers.get("X-SendGrid-Signature")
    if not verify_hmac_sha256(body, sig, secret):
        logger.info("inbound email webhook: signature rejected or unconfigured")
        return {"received": True, "verified": False}

    try:
        payload = json.loads(body or b"{}")
    except json.JSONDecodeError:
        return {"received": True, "verified": True, "processed": 0}

    external_id = (
        payload.get("event_id")
        or payload.get("Message-Id")
        or payload.get("message_id")
        or ""
    )
    if not external_id:
        return {"received": True, "verified": True, "processed": 0}

    if not record_delivery(provider="inbound_email", external_id=external_id,
                           payload_hash=hash_payload(body)):
        return {"received": True, "verified": True, "duplicate": True}

    emit_activity_event(
        event_type="email_reply",
        event_data={
            "provider": "inbound",
            "raw": payload,
            "from": payload.get("from"),
            "to": payload.get("to"),
            "subject": payload.get("subject"),
            "text": payload.get("text") or payload.get("body"),
        },
    )
    return {"received": True, "verified": True, "processed": 1}
