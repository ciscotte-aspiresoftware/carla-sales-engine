from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from typing import Optional
from app.database import get_db
from app.services.analytics_service import analytics_service

router = APIRouter()


@router.get("/analytics/dashboard")
async def dashboard_metrics(db: Session = Depends(get_db), vertical: Optional[str] = None):
    return analytics_service.get_dashboard_metrics(db, vertical=vertical)


@router.get("/analytics/campaigns/{campaign_id}")
async def campaign_analytics(campaign_id: int, db: Session = Depends(get_db)):
    return analytics_service.get_campaign_analytics(db, campaign_id)


@router.get("/analytics/by-region")
async def region_breakdown(db: Session = Depends(get_db)):
    return analytics_service.get_region_breakdown(db)
