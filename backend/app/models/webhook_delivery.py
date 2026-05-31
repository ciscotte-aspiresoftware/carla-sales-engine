from sqlalchemy import Column, Integer, String, DateTime, UniqueConstraint
from sqlalchemy.sql import func

from app.database import Base


class WebhookDelivery(Base):
    """Idempotency record for inbound webhook deliveries.

    Every verified webhook hit (SendGrid event, Twilio call-status, Salesforce
    record update, inbound parse, etc.) gets a row here keyed by
    (provider, external_id). Duplicate deliveries are no-ops — the route
    looks up (provider, external_id), and skips processing if a row already
    exists. payload_hash is stored for forensic comparison if a provider
    ever ships divergent payloads under the same external_id.
    """
    __tablename__ = "webhook_deliveries"
    __table_args__ = (
        UniqueConstraint("provider", "external_id", name="uq_webhook_provider_external_id"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider = Column(String(50), nullable=False)         # "sendgrid", "twilio", "salesforce", "inbound", ...
    external_id = Column(String(200), nullable=False)     # provider-supplied event id (sg_event_id, MessageSid, etc.)
    payload_hash = Column(String(64), nullable=False)     # sha256 of raw body — detects payload mutation across retries
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
