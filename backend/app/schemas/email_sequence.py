from pydantic import BaseModel
from typing import Optional, List, Any
from datetime import datetime


class EmailSequenceDetail(BaseModel):
    id: int
    campaign_id: int
    prospect_id: int
    touch_number: int
    subject: str
    body: str
    persona_target: Optional[str] = None
    approval_status: str
    sent_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    approved_at: Optional[datetime] = None
    agent_metadata: Optional[Any] = None
    created_at: Optional[datetime] = None
    # Denormalized for UI convenience
    business_name: Optional[str] = None
    contact_name: Optional[str] = None
    contact_email: Optional[str] = None
    # Website URL of the prospect — surfaced on the review page so the user can
    # open the operator's actual site and verify the email's claims before approving.
    website_url: Optional[str] = None

    model_config = {"from_attributes": True}


class SequenceListResponse(BaseModel):
    sequences: List[EmailSequenceDetail]
    total: int


class BulkApproveRequest(BaseModel):
    ids: List[int]
    approved_by: str = "demo_user"


class BulkRejectRequest(BaseModel):
    ids: List[int]


class SequenceUpdateRequest(BaseModel):
    subject: str
    body: str
