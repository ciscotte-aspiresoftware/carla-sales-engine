from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional
from app.database import get_db
from app.services.campaign_service import campaign_service
from app.schemas.campaign_brief import CampaignBriefCreate, CampaignBriefResponse, CampaignBriefListResponse

router = APIRouter()


@router.post("/sdr/campaign-briefs", response_model=CampaignBriefResponse, status_code=201)
async def create_campaign_brief(data: CampaignBriefCreate, db: Session = Depends(get_db)):
    return campaign_service.create_brief(db, data)


@router.get("/sdr/campaign-briefs", response_model=CampaignBriefListResponse)
async def list_campaign_briefs(db: Session = Depends(get_db), status: Optional[str] = None):
    return campaign_service.list_briefs(db, status=status)


@router.get("/sdr/campaign-briefs/{brief_id}", response_model=CampaignBriefResponse)
async def get_campaign_brief(brief_id: str, db: Session = Depends(get_db)):
    brief = campaign_service.get_brief(db, brief_id)
    if not brief:
        raise HTTPException(status_code=404, detail="Campaign brief not found")
    return brief


@router.patch("/sdr/campaign-briefs/{brief_id}/link")
async def link_brief_to_campaign(brief_id: str, campaign_id: int, db: Session = Depends(get_db)):
    result = campaign_service.link_brief(db, brief_id, campaign_id)
    if not result:
        raise HTTPException(status_code=404, detail="Brief or campaign not found")
    return result
