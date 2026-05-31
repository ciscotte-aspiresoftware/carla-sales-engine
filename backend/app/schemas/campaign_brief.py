from pydantic import BaseModel, Field
from typing import Optional, Any, List, Literal
from datetime import date, datetime
from enum import Enum


class BriefPriority(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class BriefStatus(str, Enum):
    RECEIVED = "received"
    LINKED = "linked"
    EXECUTED = "executed"


class TargetSegment(BaseModel):
    """Criteria for prospect selection — mirrors ICP criteria shape from vertical packs."""
    country_codes: Optional[List[str]] = None
    min_capacity_count: Optional[int] = None
    max_capacity_count: Optional[int] = None
    ownership_types: Optional[List[str]] = None
    has_online_booking: Optional[bool] = None
    min_tech_maturity: Optional[int] = None
    max_tech_maturity: Optional[int] = None
    services_include: Optional[List[str]] = None
    min_icp_score: Optional[float] = None


class BudgetSignal(BaseModel):
    currency: str
    amount: Optional[float] = None
    notes: Optional[str] = None


class CampaignBriefCreate(BaseModel):
    """
    API contract for the Revenue & Occupancy Optimization Suite (or any external system)
    to instruct the SDR engine to run a targeted outbound campaign.

    Field names here are frozen — never change without API versioning.
    """
    id: str = Field(
        ...,
        description="Caller-assigned UUID. The optimization suite owns ID generation.",
        example="brief_20260401_dry_storage_us_q2"
    )
    title: str = Field(..., max_length=200)
    source_system: str = Field(
        ...,
        description="Identifier of the originating system",
        example="revenue_optimizer_v1"
    )
    vertical: str = Field(..., description="Must match an available vertical pack ID", example="marina")
    region: str = Field(..., description="Must match an available regional pack ID", example="us_en")
    objective: str = Field(
        ...,
        max_length=200,
        description="Campaign objective code or free text",
        example="upsell_dry_storage_q2"
    )
    target_segment: TargetSegment
    priority: BriefPriority = BriefPriority.MEDIUM
    ideal_launch_date: Optional[date] = None
    budget_signal: Optional[BudgetSignal] = None
    metadata: Optional[dict[str, Any]] = Field(
        default=None,
        description="Open passthrough for future optimization suite fields"
    )


class CampaignBriefResponse(BaseModel):
    id: str
    title: str
    source_system: str
    vertical: str
    region: str
    objective: str
    target_segment: Any
    priority: str
    ideal_launch_date: Optional[date] = None
    budget_signal: Optional[Any] = None
    metadata: Optional[Any] = None
    status: str
    linked_campaign_id: Optional[int] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class CampaignBriefListResponse(BaseModel):
    briefs: List[CampaignBriefResponse]
    total: int
