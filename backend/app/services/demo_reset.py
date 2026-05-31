"""
Demo reset service — wipes transient AI state and campaigns so the app returns
to a "prospects only" baseline. Engagement counters return to honest zero.
Prospect rows themselves are kept; their AI-filled research_profile is cleared
so the pipeline can re-run from scratch.
"""
from sqlalchemy.orm import Session

from app.models.prospect import Prospect
from app.models.campaign import Campaign, CampaignProspect
from app.models.email_sequence import EmailSequence
from app.models.activity import ActivityEvent
from app.models.campaign_brief import CampaignBrief


def reset_demo(db: Session) -> dict:
    activity_deleted = db.query(ActivityEvent).delete()
    sequences_deleted = db.query(EmailSequence).delete()
    campaign_prospects_deleted = db.query(CampaignProspect).delete()
    campaigns_deleted = db.query(Campaign).delete()
    briefs_deleted = db.query(CampaignBrief).delete()

    db.query(Prospect).update({"research_profile": None})

    db.commit()

    return {
        "campaigns_deleted": campaigns_deleted,
        "campaign_prospects_deleted": campaign_prospects_deleted,
        "sequences_deleted": sequences_deleted,
        "activity_events_deleted": activity_deleted,
        "campaign_briefs_deleted": briefs_deleted,
    }
