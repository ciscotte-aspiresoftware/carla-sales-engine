from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime


class CampaignCreate(BaseModel):
    name: str
    vertical_pack: str
    vendor_pack: Optional[str] = None    # required for layered verticals (e.g. car_rental)
    product_pack: Optional[str] = None   # required for layered verticals
    regional_pack: str
    sequence_touches: int = 3
    touch_delay_days: int = 3
    min_icp_score: float = 0.5  # enrollment threshold — prospects at or above this score are enrolled
    icp_filter: Optional[Any] = None
    campaign_brief_id: Optional[str] = None
    prospect_ids: Optional[List[int]] = None  # explicit list, or None = auto-select by ICP


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    sequence_touches: Optional[int] = None
    touch_delay_days: Optional[int] = None
    auto_send: Optional[bool] = None
    send_cadence: Optional[str] = None
    cadence_custom_cron: Optional[str] = None
    ab_test: Optional[bool] = None
    dry_run: Optional[bool] = None


class EnrolledProspect(BaseModel):
    prospect_id: int
    business_name: str
    contact_name: str
    email: str
    enrollment_status: str
    icp_score: Optional[float] = None


class CampaignStats(BaseModel):
    enrolled: int
    emails_generated: int
    pending_approval: int
    approved: int
    sent: int
    opens: int
    clicks: int
    replies: int
    meetings_booked: int
    open_rate: float
    reply_rate: float


class CampaignDetail(BaseModel):
    id: int
    name: str
    vertical_pack: str
    vendor_pack: Optional[str] = None
    product_pack: Optional[str] = None
    regional_pack: str
    status: str
    sequence_touches: int
    touch_delay_days: int
    icp_filter: Optional[Any] = None
    campaign_brief_id: Optional[str] = None
    campaign_brief_title: Optional[str] = None   # resolved from campaign_brief_id
    auto_send: bool = False
    send_cadence: str = "immediate"
    cadence_custom_cron: Optional[str] = None
    ab_test: bool = False
    dry_run: bool = False
    created_at: Optional[datetime] = None
    stats: Optional[CampaignStats] = None

    model_config = {"from_attributes": True}


class CampaignListResponse(BaseModel):
    campaigns: List[CampaignDetail]
    total: int
