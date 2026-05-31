from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.models.activity import ActivityEvent
from app.models.campaign import Campaign, CampaignProspect
from app.models.email_sequence import EmailSequence
from app.models.prospect import Prospect


class AnalyticsService:
    def get_dashboard_metrics(self, db: Session, vertical: Optional[str] = None) -> dict:
        # Total emails sent
        sent_q = db.query(func.count(EmailSequence.id)).filter(EmailSequence.sent_at.isnot(None))
        emails_sent = sent_q.scalar() or 0

        # Open, click, reply, meeting counts from activity
        def count_event(event_type: str) -> int:
            return db.query(func.count(ActivityEvent.id)).filter(
                ActivityEvent.event_type == event_type
            ).scalar() or 0

        opens = count_event("open")
        clicks = count_event("click")
        replies = count_event("reply")
        meetings = count_event("meeting_booked")

        open_rate = round(opens / emails_sent * 100, 1) if emails_sent > 0 else 0
        click_rate = round(clicks / emails_sent * 100, 1) if emails_sent > 0 else 0
        reply_rate = round(replies / emails_sent * 100, 1) if emails_sent > 0 else 0

        # Funnel: prospects -> contacted -> replied -> meeting
        total_prospects = db.query(func.count(Prospect.id)).scalar() or 0
        contacted = db.query(func.count(func.distinct(EmailSequence.prospect_id))).filter(
            EmailSequence.sent_at.isnot(None)
        ).scalar() or 0

        return {
            "emails_sent": emails_sent,
            "open_rate": open_rate,
            "click_rate": click_rate,
            "reply_rate": reply_rate,
            "meetings_booked": meetings,
            "funnel": {
                "prospects": total_prospects,
                "contacted": contacted,
                "replied": replies,
                "meetings": meetings,
            },
            "campaigns_active": db.query(func.count(Campaign.id)).filter(
                Campaign.status.in_(["running", "draft"])
            ).scalar() or 0,
        }

    def get_campaign_analytics(self, db: Session, campaign_id: int) -> dict:
        enrolled = db.query(func.count(CampaignProspect.id)).filter(
            CampaignProspect.campaign_id == campaign_id
        ).scalar() or 0
        generated = db.query(func.count(EmailSequence.id)).filter(
            EmailSequence.campaign_id == campaign_id
        ).scalar() or 0
        approved = db.query(func.count(EmailSequence.id)).filter(
            EmailSequence.campaign_id == campaign_id,
            EmailSequence.approval_status == "approved"
        ).scalar() or 0
        sent = db.query(func.count(EmailSequence.id)).filter(
            EmailSequence.campaign_id == campaign_id,
            EmailSequence.sent_at.isnot(None)
        ).scalar() or 0

        def camp_event(etype: str) -> int:
            return db.query(func.count(ActivityEvent.id)).filter(
                ActivityEvent.campaign_id == campaign_id,
                ActivityEvent.event_type == etype
            ).scalar() or 0

        opens = camp_event("open")
        replies = camp_event("reply")
        meetings = camp_event("meeting_booked")

        return {
            "campaign_id": campaign_id,
            "enrolled": enrolled,
            "generated": generated,
            "approved": approved,
            "sent": sent,
            "opens": opens,
            "replies": replies,
            "meetings": meetings,
            "open_rate": round(opens / sent * 100, 1) if sent > 0 else 0,
            "reply_rate": round(replies / sent * 100, 1) if sent > 0 else 0,
        }

    def get_region_breakdown(self, db: Session) -> dict:
        rows = (
            db.query(Prospect.country_code, func.count(Prospect.id).label("count"))
            .group_by(Prospect.country_code)
            .all()
        )
        return {"regions": [{"country_code": r.country_code, "count": r.count} for r in rows]}


analytics_service = AnalyticsService()
