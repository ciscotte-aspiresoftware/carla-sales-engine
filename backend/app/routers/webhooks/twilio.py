"""
Twilio webhook receivers — voice call status + SMS receipts.

Twilio POSTs application/x-www-form-urlencoded. The signing algorithm is
HMAC-SHA1 over the request URL plus sorted form fields — see
`webhook_signatures.verify_twilio`.

Returns 200 even on signature failure (silent reject) so retries don't pile up.
"""
import logging

from fastapi import APIRouter, Request

from app.routers.webhooks.common import emit_activity_event, record_delivery
from app.services.app_settings_service import app_settings_service
from app.services.webhook_signatures import hash_payload, verify_twilio

router = APIRouter()
logger = logging.getLogger(__name__)


def _full_url(request: Request) -> str:
    # Twilio signs the URL it POSTed to, including scheme + host. We honour
    # X-Forwarded-Proto/Host when present — otherwise rely on FastAPI's URL.
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.url.netloc
    return f"{proto}://{host}{request.url.path}"


@router.post("/voice")
async def twilio_voice(request: Request):
    body = await request.body()
    form = dict(await request.form())
    auth = app_settings_service.get_or_env("twilio_auth_token")
    sig = request.headers.get("X-Twilio-Signature")
    if not verify_twilio(url=_full_url(request), params=form, header_value=sig, auth_token=auth):
        logger.info("twilio voice webhook: signature rejected or unconfigured")
        return {"received": True, "verified": False}

    external_id = form.get("CallSid") or ""
    if not external_id:
        return {"received": True, "verified": True, "processed": 0}

    if not record_delivery(provider="twilio_voice", external_id=external_id,
                           payload_hash=hash_payload(body)):
        return {"received": True, "verified": True, "duplicate": True}

    status = form.get("CallStatus") or "unknown"
    # in-progress / ringing / completed / busy / failed / no-answer / canceled
    event_type = {
        "completed": "call_completed",
        "busy":      "call_failed",
        "failed":    "call_failed",
        "no-answer": "call_no_answer",
        "canceled":  "call_canceled",
    }.get(status, f"call_{status}")

    emit_activity_event(
        event_type=event_type,
        event_data={"provider": "twilio_voice", "raw": form, "to": form.get("To"), "from": form.get("From")},
    )
    return {"received": True, "verified": True, "processed": 1}


@router.post("/sms")
async def twilio_sms(request: Request):
    body = await request.body()
    form = dict(await request.form())
    auth = app_settings_service.get_or_env("twilio_auth_token")
    sig = request.headers.get("X-Twilio-Signature")
    if not verify_twilio(url=_full_url(request), params=form, header_value=sig, auth_token=auth):
        logger.info("twilio sms webhook: signature rejected or unconfigured")
        return {"received": True, "verified": False}

    external_id = form.get("MessageSid") or ""
    if not external_id:
        return {"received": True, "verified": True, "processed": 0}

    if not record_delivery(provider="twilio_sms", external_id=external_id,
                           payload_hash=hash_payload(body)):
        return {"received": True, "verified": True, "duplicate": True}

    # Inbound SMS: SmsStatus="received" / Body present.
    # Outbound status: SmsStatus="delivered"/"failed" — Twilio uses the same endpoint.
    status = form.get("SmsStatus") or form.get("MessageStatus") or "received"
    event_type = {
        "received":  "sms_received",
        "delivered": "sms_delivered",
        "failed":    "sms_failed",
        "undelivered": "sms_failed",
    }.get(status, f"sms_{status}")

    emit_activity_event(
        event_type=event_type,
        event_data={"provider": "twilio_sms", "raw": form, "to": form.get("To"),
                    "from": form.get("From"), "body": form.get("Body")},
    )
    return {"received": True, "verified": True, "processed": 1}
