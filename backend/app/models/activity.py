from sqlalchemy import Column, Integer, String, Boolean, JSON, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.database import Base


class ActivityEvent(Base):
    __tablename__ = "activity_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=True, index=True)
    prospect_id = Column(Integer, ForeignKey("prospects.id"), nullable=True, index=True)
    email_sequence_id = Column(Integer, ForeignKey("email_sequences.id"), nullable=True)
    event_type = Column(String(50), nullable=False, index=True)
    # sent, open, click, reply, meeting_booked, unsubscribe, ooo, pipeline_started, pipeline_completed
    event_data = Column(JSON, nullable=True)  # reply text, click URL, etc.
    is_simulated = Column(Boolean, nullable=False, default=True)
    occurred_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)

    # Relationships — declared so the activity router can eager-load
    # prospect + campaign in a single query (joinedload). Without these,
    # the `_enrich()` step fires a separate SELECT per event = N+1.
    # `lazy="joined"` is NOT used here because not every consumer needs
    # the joins — callers opt in via `.options(joinedload(...))`.
    prospect = relationship("Prospect", foreign_keys=[prospect_id])
    campaign = relationship("Campaign", foreign_keys=[campaign_id])
