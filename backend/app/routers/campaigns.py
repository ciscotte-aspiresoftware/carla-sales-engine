from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from typing import Optional
from app.database import get_db
from app.services.campaign_service import campaign_service
from app.services.pipeline_progress import get_progress
from app.schemas.campaign import CampaignCreate, CampaignUpdate, CampaignDetail, CampaignListResponse

router = APIRouter()


@router.get("/campaigns", response_model=CampaignListResponse)
async def list_campaigns(
    db: Session = Depends(get_db),
    status: Optional[str] = None,
    vertical: Optional[str] = None,
):
    return campaign_service.list_campaigns(db, status=status, vertical=vertical)


@router.get("/campaigns/{campaign_id}", response_model=CampaignDetail)
async def get_campaign(campaign_id: int, db: Session = Depends(get_db)):
    campaign = campaign_service.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return campaign


@router.post("/campaigns", response_model=CampaignDetail, status_code=201)
async def create_campaign(data: CampaignCreate, db: Session = Depends(get_db)):
    return campaign_service.create(db, data)


@router.patch("/campaigns/{campaign_id}", response_model=CampaignDetail)
async def update_campaign(campaign_id: int, data: CampaignUpdate, db: Session = Depends(get_db)):
    campaign = campaign_service.update(db, campaign_id, data)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return campaign


@router.post("/campaigns/{campaign_id}/run-pipeline")
async def run_pipeline(
    campaign_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    campaign = campaign_service.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")
    background_tasks.add_task(campaign_service.run_pipeline, campaign_id)
    return {"status": "started", "campaign_id": campaign_id}


@router.get("/campaigns/{campaign_id}/stats")
async def get_campaign_stats(campaign_id: int, db: Session = Depends(get_db)):
    return campaign_service.get_stats(db, campaign_id)


@router.get("/campaigns/{campaign_id}/pipeline-status")
async def get_pipeline_status(campaign_id: int):
    progress = get_progress(campaign_id)
    if not progress:
        return {"step": "idle", "message": "", "done": 0, "total": 0}
    return progress
