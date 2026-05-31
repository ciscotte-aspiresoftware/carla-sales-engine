"""
Shared helpers for webhook routes — idempotency + activity event emission.

Every verified webhook hit goes through `record_delivery(...)` which inserts
a `WebhookDelivery` row keyed by (provider, external_id). On a duplicate the
helper returns False so the caller knows to skip downstream work.
"""
from __future__ import annotations

from typing import Optional

from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal
from app.models.activity import ActivityEvent
from app.models.webhook_delivery import WebhookDelivery


def record_delivery(*, provider: str, external_id: str, payload_hash: str) -> bool:
    """Insert a WebhookDelivery row. Returns True if this is a fresh delivery,
    False if a row with the same (provider, external_id) already exists.

    Callers should branch on the return value: only emit ActivityEvents and
    other side effects when True.
    """
    db = SessionLocal()
    try:
        try:
            db.add(WebhookDelivery(
                provider=provider,
                external_id=external_id,
                payload_hash=payload_hash,
            ))
            db.commit()
            return True
        except IntegrityError:
            db.rollback()
            return False
    finally:
        db.close()


def emit_activity_event(
    *,
    event_type: str,
    event_data: dict,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    email_sequence_id: Optional[int] = None,
    is_simulated: bool = False,
) -> None:
    """Persist an ActivityEvent. Webhook events are real (is_simulated=False
    by default) — the demo's seeded synthetic events use is_simulated=True."""
    db = SessionLocal()
    try:
        db.add(ActivityEvent(
            campaign_id=campaign_id,
            prospect_id=prospect_id,
            email_sequence_id=email_sequence_id,
            event_type=event_type,
            event_data=event_data,
            is_simulated=is_simulated,
        ))
        db.commit()
    finally:
        db.close()
