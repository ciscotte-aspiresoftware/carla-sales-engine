from sqlalchemy import Column, Integer, String, Float, DateTime
from sqlalchemy.sql import func

from app.database import Base


class LLMUsage(Base):
    """One row per Claude API call. Token counts come straight from the
    Anthropic response.usage; cost_usd is computed at insert time using the
    pricing table in app/services/llm_cost.py.

    `agent` identifies which logical call site this came from (e.g.
    "researcher", "discovery_generate", "optimizer_recommendations"). The two
    foreign-key columns are nullable because not every call has a campaign /
    prospect context (e.g. AI Auto-fill of a pack section)."""

    __tablename__ = "llm_usage"

    id = Column(Integer, primary_key=True, autoincrement=True)
    occurred_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    model = Column(String(80), nullable=False, index=True)
    agent = Column(String(80), nullable=False, index=True)

    # Soft FKs — recorded but no DB constraint so we can keep usage rows after the
    # campaign / prospect they reference is deleted.
    campaign_id = Column(Integer, nullable=True, index=True)
    prospect_id = Column(Integer, nullable=True, index=True)

    # Token counts — all default to 0 so a partial record (e.g. usage missing cache
    # info) doesn't break aggregations.
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    cache_read_tokens = Column(Integer, nullable=False, default=0)
    cache_creation_tokens = Column(Integer, nullable=False, default=0)
    thinking_tokens = Column(Integer, nullable=False, default=0)

    cost_usd = Column(Float, nullable=False, default=0.0)
    duration_ms = Column(Integer, nullable=True)
