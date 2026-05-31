from pydantic import BaseModel, EmailStr
from typing import Optional, List, Any
from datetime import datetime


class ResearchProfile(BaseModel):
    hook_line: str
    pain_hypothesis: str
    credible_detail: str
    suggested_persona: str
    personalization_notes: str


class ProspectContactBase(BaseModel):
    full_name: str
    role: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    is_primary: bool = False
    contact_priority: int = 0


class ProspectContactCreate(ProspectContactBase):
    pass


class ProspectContactUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    is_primary: Optional[bool] = None
    contact_priority: Optional[int] = None


class ProspectContactDetail(ProspectContactBase):
    id: int
    prospect_id: int
    provenance: Optional[dict] = None
    created_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ProspectBase(BaseModel):
    business_name: str
    contact_name: str
    contact_title: str
    email: str
    city: str
    state: Optional[str] = None
    country_code: str
    capacity_count: Optional[int] = None
    services: Optional[List[str]] = None
    website_url: Optional[str] = None
    phone: Optional[str] = None
    tech_maturity_score: Optional[int] = None
    has_online_booking: bool = False
    ownership_type: str
    # Required. Engine is vertical-agnostic; callers must declare which pack
    # this prospect belongs to.
    vertical: str


class ProspectDetail(ProspectBase):
    id: int
    icp_score: Optional[float] = None
    research_profile: Optional[Any] = None
    # Structured payload from WebsiteEnrichmentAgent — see Prospect model
    # docstring. None until a scrape has been run. Shape:
    # {verified, summary, services_list, has_online_booking, online_booking_url,
    #  tech_stack_signals, pain_signals, competitors_mentioned, key_quotes, meta}.
    website_research: Optional[Any] = None
    # Per-field source map — see Prospect model docstring. Optional for
    # backwards compat with prospects saved before provenance was tracked.
    provenance: Optional[dict] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    is_real: bool = False
    created_at: Optional[datetime] = None
    # Additional personas (owner + gm + dockmaster, etc.). Empty list when
    # no additional contacts have been discovered or added by the user; the
    # primary persona always lives on the prospect's top-level fields.
    contacts: List[ProspectContactDetail] = []

    model_config = {"from_attributes": True}


class ProspectUpdate(BaseModel):
    contact_name: Optional[str] = None
    contact_title: Optional[str] = None
    capacity_count: Optional[int] = None
    tech_maturity_score: Optional[int] = None
    has_online_booking: Optional[bool] = None
    ownership_type: Optional[str] = None
    icp_score: Optional[float] = None
    phone: Optional[str] = None
    # Allow editing the email + website. The Settings UI lets a user correct a
    # bogus seed email, and the Website Research tab uses these to promote a
    # discovered email (via the dedicated endpoint, which also flips
    # provenance to "scrape"). Both nullable in the patch shape; the column
    # itself is required + unique.
    email: Optional[str] = None
    website_url: Optional[str] = None


class ProspectListResponse(BaseModel):
    prospects: List[ProspectDetail]
    total: int
    page: int
    limit: int
    pages: int
