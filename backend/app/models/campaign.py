from sqlalchemy import Column, Integer, String, Boolean, JSON, DateTime, ForeignKey
from sqlalchemy.sql import func
from app.database import Base


class Campaign(Base):
    __tablename__ = "campaigns"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    vertical_pack = Column(String(50), nullable=False)   # e.g. "marina" or "car_rental"
    vendor_pack = Column(String(50), nullable=True)      # e.g. "thermeon" — required for layered verticals
    product_pack = Column(String(50), nullable=True)     # e.g. "thermeon_carsplus"
    regional_pack = Column(String(50), nullable=False)   # e.g. "us_en"
    status = Column(String(50), nullable=False, default="draft")  # draft, running, paused, completed
    sequence_touches = Column(Integer, nullable=False, default=3)
    touch_delay_days = Column(Integer, nullable=False, default=3)
    icp_filter = Column(JSON, nullable=True)  # snapshot of criteria used at creation
    # Soft FK to campaign_briefs — optimization suite integration hook
    campaign_brief_id = Column(String(100), nullable=True)
    # ── Schedule + tools (Roadmap Phases 4 + 5) ─────────────────────────
    # When auto_send=True, scheduler_service registers APScheduler jobs that
    # call sequence_service.mark_sent at the configured cadence. Demo flows
    # default to manual approval, so this is opt-in per campaign.
    auto_send = Column(Boolean, nullable=False, default=False)
    # immediate | next_business_day_9am | weekly_tuesday_10am | custom
    send_cadence = Column(String(50), nullable=False, default="immediate")
    # Cron expression (5-field) used when send_cadence == "custom".
    cadence_custom_cron = Column(String(100), nullable=True)
    # Phase 5a: copywriter generates 2 variants per touch when True.
    ab_test = Column(Boolean, nullable=False, default=False)
    # Phase 5e: mark_sent emits "dry_run_send" ActivityEvents instead of
    # flipping sent_at — lets a portfolio team validate prompts + cadences
    # without risking real outbound.
    dry_run = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class CampaignProspect(Base):
    __tablename__ = "campaign_prospects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    campaign_id = Column(Integer, ForeignKey("campaigns.id"), nullable=False)
    prospect_id = Column(Integer, ForeignKey("prospects.id"), nullable=False)
    enrollment_status = Column(String(50), nullable=False, default="enrolled")
    # enrolled, active, replied, unsubscribed, completed
    enrolled_at = Column(DateTime(timezone=True), server_default=func.now())
