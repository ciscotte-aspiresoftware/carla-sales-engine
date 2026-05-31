from sqlalchemy import Column, Integer, String, JSON, DateTime, Date
from sqlalchemy.sql import func
from app.database import Base


class CampaignBrief(Base):
    """
    Represents a structured brief from the Revenue & Occupancy Optimization Suite
    (or any external system) that instructs the SDR engine to run a targeted campaign.

    The optimization suite POSTs to /api/v1/sdr/campaign-briefs with this payload.
    The SDR engine stores it and a human links it to a Campaign when ready.

    This is the architectural seam between the two systems — the soft FK
    Campaign.campaign_brief_id points here without a hard constraint.
    """
    __tablename__ = "campaign_briefs"

    id = Column(String(100), primary_key=True)  # Caller-assigned UUID
    title = Column(String(200), nullable=False)
    source_system = Column(String(100), nullable=False)  # "revenue_optimizer_v1"
    vertical = Column(String(50), nullable=False)
    region = Column(String(50), nullable=False)
    objective = Column(String(200), nullable=False)
    target_segment = Column(JSON, nullable=False)
    priority = Column(String(50), nullable=False, default="medium")  # high, medium, low
    ideal_launch_date = Column(Date, nullable=True)
    budget_signal = Column(JSON, nullable=True)
    metadata_ = Column("metadata", JSON, nullable=True)  # open passthrough
    status = Column(String(50), nullable=False, default="received")  # received, linked, executed
    linked_campaign_id = Column(Integer, nullable=True)  # soft FK, set when linked
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
