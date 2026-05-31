import asyncio
import json
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
from typing import Optional
from app.database import get_db, SessionLocal
from app.services.activity_service import activity_service

router = APIRouter()


@router.get("/activity")
async def list_activity(
    db: Session = Depends(get_db),
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    event_type: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
):
    events = activity_service.list_events(
        db, campaign_id=campaign_id, prospect_id=prospect_id,
        event_type=event_type, limit=limit
    )
    return {"events": events}


@router.get("/activity/stream")
async def activity_stream(last_id: int = 0):
    async def event_generator():
        current_id = last_id
        while True:
            db = SessionLocal()
            try:
                events = activity_service.get_events_after(db, current_id, limit=20)
                for event in events:
                    current_id = event["id"]
                    yield {
                        "event": "activity",
                        "data": json.dumps(event),
                        "id": str(current_id),
                    }
            finally:
                db.close()
            await asyncio.sleep(3)

    return EventSourceResponse(event_generator())
