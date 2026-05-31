from typing import Optional, List
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import desc
from app.models.activity import ActivityEvent


class ActivityService:
    def list_events(
        self,
        db: Session,
        campaign_id: Optional[int] = None,
        prospect_id: Optional[int] = None,
        event_type: Optional[str] = None,
        limit: int = 50,
    ) -> List[dict]:
        q = db.query(ActivityEvent).options(
            joinedload(ActivityEvent.prospect),
            joinedload(ActivityEvent.campaign),
        )
        if campaign_id:
            q = q.filter(ActivityEvent.campaign_id == campaign_id)
        if prospect_id:
            q = q.filter(ActivityEvent.prospect_id == prospect_id)
        if event_type:
            q = q.filter(ActivityEvent.event_type == event_type)
        events = q.order_by(desc(ActivityEvent.occurred_at)).limit(limit).all()
        return [self._enrich(e) for e in events]

    def get_events_after(self, db: Session, last_id: int, limit: int = 20) -> List[dict]:
        events = (
            db.query(ActivityEvent)
            .options(
                joinedload(ActivityEvent.prospect),
                joinedload(ActivityEvent.campaign),
            )
            .filter(ActivityEvent.id > last_id)
            .order_by(ActivityEvent.id.asc())
            .limit(limit)
            .all()
        )
        return [self._enrich(e) for e in events]

    def _enrich(self, event: ActivityEvent) -> dict:
        """Build the dict response. Prospect + Campaign are eager-loaded
        by the caller, so accessing the relationship attributes does not
        trigger a database round-trip — previously this method did one
        SELECT per event, adding up to ~100 sync queries for a 50-event
        response. Now: zero extra queries.
        """
        return {
            "id": event.id,
            "campaign_id": event.campaign_id,
            "prospect_id": event.prospect_id,
            "email_sequence_id": event.email_sequence_id,
            "event_type": event.event_type,
            "event_data": event.event_data,
            "is_simulated": event.is_simulated,
            "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
            "business_name": event.prospect.business_name if event.prospect else None,
            "campaign_name": event.campaign.name if event.campaign else None,
        }


activity_service = ActivityService()
