"""
SendGrid Event Webhook receiver.

SendGrid POSTs an array of events (delivery, bounce, open, click,
unsubscribe, spamreport, dropped, etc.). Each event has a `sg_event_id`
which we use as the idempotency key. We verify the signature, dedupe per
event, and emit one ActivityEvent per unique event.

Returns 200 even on signature failure — that's intentional: external
retries should not pile up against an unconfigured / mis-keyed receiver.
"""
import json
import logging
from typing import Mapping

from fastapi import APIRouter, Request

from app.routers.webhooks.common import emit_activity_event, record_delivery
from app.services.app_settings_service import app_settings_service
from app.services.webhook_signatures import hash_payload, verify_sendgrid

router = APIRouter()
logger = logging.getLogger(__name__)


# Map SendGrid event names → activity event_type used by the engine UI.
EVENT_TYPE_MAP: Mapping[str, str] = {
    "delivered":   "email_delivered",
    "open":        "email_open",
    "click":       "email_click",
    "bounce":      "email_bounce",
    "dropped":     "email_dropped",
    "deferred":    "email_deferred",
    "unsubscribe": "email_unsubscribe",
    "spamreport":  "email_spam",
    "group_unsubscribe": "email_unsubscribe",
}


@router.post("/events", include_in_schema=True)
async def sendgrid_events(request: Request):
    body = await request.body()
    secret = app_settings_service.get_or_env("sendgrid_webhook_secret")
    if not verify_sendgrid(body, dict(request.headers), secret):
        # Silent reject; do NOT raise — keeps SendGrid retry quotas clean.
        logger.info("sendgrid webhook: signature rejected or unconfigured")
        return {"received": True, "verified": False}

    try:
        events = json.loads(body or b"[]")
        if not isinstance(events, list):
            events = [events]
    except json.JSONDecodeError:
        return {"received": True, "verified": True, "processed": 0}

    payload_hash = hash_payload(body)
    processed = 0
    for evt in events:
        if not isinstance(evt, dict):
            continue
        external_id = evt.get("sg_event_id") or evt.get("sg_message_id") or ""
        if not external_id:
            continue
        if not record_delivery(provider="sendgrid", external_id=external_id, payload_hash=payload_hash):
            continue  # duplicate
        engine_event_type = EVENT_TYPE_MAP.get(evt.get("event") or "", f"email_{evt.get('event', 'unknown')}")
        emit_activity_event(
            event_type=engine_event_type,
            event_data={
                "provider": "sendgrid",
                "raw": evt,
                "to": evt.get("email"),
                "timestamp": evt.get("timestamp"),
            },
        )
        processed += 1

    return {"received": True, "verified": True, "processed": processed}
