from sqlalchemy import Column, Integer, String, Text, JSON, DateTime, ForeignKey
from sqlalchemy.sql import func
from app.database import Base


class EmailSequence(Base):
    __tablename__ = "email_sequences"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False, index=True)
    prospect_id = Column(Integer, ForeignKey("prospects.id"), nullable=False, index=True)
    # NULL = primary contact on the prospect (back-compat). Set to a
    # ProspectContact.id to target an alternate persona (owner vs gm, etc.).
    contact_id = Column(Integer, ForeignKey("prospect_contacts.id"), nullable=True)
    touch_number = Column(Integer, nullable=False)  # 1, 2, 3 ...
    subject = Column(String(500), nullable=False)
    body = Column(Text, nullable=False)
    persona_target = Column(String(100), nullable=True)  # owner, gm, dockmaster
    approval_status = Column(String(50), nullable=False, default="pending", index=True)  # pending, approved, rejected
    sent_at = Column(DateTime(timezone=True), nullable=True)  # null = not yet sent
    approved_by = Column(String(100), nullable=True)
    approved_at = Column(DateTime(timezone=True), nullable=True)
    # Stores: hook_line, pain_hypothesis, credible_detail from ResearchAgent
    agent_metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
