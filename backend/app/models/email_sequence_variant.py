from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.sql import func

from app.database import Base


class EmailSequenceVariant(Base):
    """A/B test variant of an email sequence.

    When `Campaign.ab_test=True`, the copywriter generates two variants per
    touch and persists them here (label "A" + "B"). The classifier attributes
    replies to the variant whose subject/body was sent (using the
    provider_message_id captured at send time, or the variant_id stamped on
    the outbound activity event).

    Counters (sent_to_count, replied_count) are denormalised for cheap
    reporting; activity events remain the source of truth.
    """
    __tablename__ = "email_sequence_variants"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sequence_id = Column(Integer, ForeignKey("email_sequences.id"), nullable=False, index=True)
    label = Column(String(10), nullable=False)        # "A" / "B" / "C" — string so it sorts naturally in UI
    subject = Column(String(500), nullable=False)
    body = Column(Text, nullable=False)
    sent_to_count = Column(Integer, nullable=False, default=0)
    replied_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
