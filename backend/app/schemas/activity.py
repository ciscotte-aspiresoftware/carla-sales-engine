from pydantic import BaseModel
from typing import Optional, Any
from datetime import datetime


class ActivityEventSchema(BaseModel):
    id: int
    campaign_id: Optional[int] = None
    prospect_id: Optional[int] = None
    email_sequence_id: Optional[int] = None
    event_type: str
    event_data: Optional[Any] = None
    is_simulated: bool
    occurred_at: datetime
    # Denormalized
    business_name: Optional[str] = None
    campaign_name: Optional[str] = None

    model_config = {"from_attributes": True}
