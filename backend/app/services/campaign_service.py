from datetime import datetime, timezone
from typing import Optional, List
from sqlalchemy.orm import Session
from app.models.campaign import Campaign, CampaignProspect
from app.models.prospect import Prospect
from app.models.campaign_brief import CampaignBrief
from app.models.activity import ActivityEvent
from app.models.email_sequence import EmailSequence
from app.schemas.campaign import (
    CampaignCreate, CampaignUpdate, CampaignDetail, CampaignListResponse, CampaignStats
)
from app.schemas.campaign_brief import CampaignBriefCreate, CampaignBriefResponse, CampaignBriefListResponse
from app.packs.loader import pack_loader


class CampaignService:
    def list_campaigns(self, db: Session, status: Optional[str] = None, vertical: Optional[str] = None) -> CampaignListResponse:
        q = db.query(Campaign)
        if status:
            q = q.filter(Campaign.status == status)
        if vertical:
            q = q.filter(Campaign.vertical_pack == vertical)
        campaigns = q.order_by(Campaign.created_at.desc()).all()

        # Batch-compute stats + brief titles for the whole list in a small
        # constant number of queries instead of the previous ~10 per
        # campaign (9 COUNTs + 1 brief lookup). For a 10-campaign list this
        # drops total DB round-trips from ~100 to ~4.
        campaign_ids = [c.id for c in campaigns]
        stats_by_id = self._compute_stats_for_campaigns(campaign_ids, db)
        brief_titles = self._fetch_brief_titles(
            [c.campaign_brief_id for c in campaigns if c.campaign_brief_id], db,
        )

        details = [
            self._to_detail(c, db, stats=stats_by_id.get(c.id), brief_title=brief_titles.get(c.campaign_brief_id))
            for c in campaigns
        ]
        return CampaignListResponse(campaigns=details, total=len(details))

    def get_by_id(self, db: Session, campaign_id: int) -> Optional[CampaignDetail]:
        c = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not c:
            return None
        return self._to_detail(c, db)

    def _to_detail(
        self,
        c: Campaign,
        db: Session,
        stats: Optional[CampaignStats] = None,
        brief_title: Optional[str] = None,
    ) -> CampaignDetail:
        if stats is None:
            stats = self._compute_stats(c.id, db)
        detail = CampaignDetail.model_validate(c)
        detail.stats = stats
        if c.campaign_brief_id:
            if brief_title is None:
                brief = db.query(CampaignBrief).filter(CampaignBrief.id == c.campaign_brief_id).first()
                brief_title = brief.title if brief else None
            detail.campaign_brief_title = brief_title or c.campaign_brief_id
        return detail

    def _compute_stats(self, campaign_id: int, db: Session) -> CampaignStats:
        """Single-campaign stats (used by `get_by_id`, `get_stats`, etc.).
        Cheap enough at 9 queries when scoped to one campaign; list paths
        use `_compute_stats_for_campaigns` to avoid the N× multiplier."""
        from sqlalchemy import func
        enrolled = db.query(func.count(CampaignProspect.id)).filter(CampaignProspect.campaign_id == campaign_id).scalar() or 0
        generated = db.query(func.count(EmailSequence.id)).filter(EmailSequence.campaign_id == campaign_id).scalar() or 0
        pending = db.query(func.count(EmailSequence.id)).filter(EmailSequence.campaign_id == campaign_id, EmailSequence.approval_status == "pending").scalar() or 0
        approved = db.query(func.count(EmailSequence.id)).filter(EmailSequence.campaign_id == campaign_id, EmailSequence.approval_status == "approved").scalar() or 0
        sent = db.query(func.count(EmailSequence.id)).filter(EmailSequence.campaign_id == campaign_id, EmailSequence.sent_at.isnot(None)).scalar() or 0

        def ev(t): return db.query(func.count(ActivityEvent.id)).filter(ActivityEvent.campaign_id == campaign_id, ActivityEvent.event_type == t).scalar() or 0

        opens = ev("open"); clicks = ev("click"); replies = ev("reply"); meetings = ev("meeting_booked")
        return CampaignStats(
            enrolled=enrolled, emails_generated=generated, pending_approval=pending,
            approved=approved, sent=sent, opens=opens, clicks=clicks, replies=replies,
            meetings_booked=meetings,
            open_rate=round(opens / sent * 100, 1) if sent > 0 else 0,
            reply_rate=round(replies / sent * 100, 1) if sent > 0 else 0,
        )

    def _compute_stats_for_campaigns(
        self,
        campaign_ids: List[int],
        db: Session,
    ) -> dict:
        """Bulk replacement for `_compute_stats` in a loop.

        Returns a `{campaign_id: CampaignStats}` map computed in three
        grouped queries regardless of how many campaigns are in the list:
          1) CampaignProspect counts grouped by campaign_id
          2) EmailSequence aggregates (total / pending / approved / sent)
             grouped by campaign_id, using SQL `CASE` to bucket counts
          3) ActivityEvent counts grouped by (campaign_id, event_type),
             filtered to the four event types we surface in stats

        Campaigns with zero of anything still appear with zero counts so
        the response shape never has missing entries.
        """
        from sqlalchemy import func, case
        if not campaign_ids:
            return {}

        # Seed zeros for every campaign so missing rows don't break the lookup.
        raw: dict[int, dict[str, int]] = {
            cid: {
                "enrolled": 0, "generated": 0, "pending": 0, "approved": 0, "sent": 0,
                "opens": 0, "clicks": 0, "replies": 0, "meetings": 0,
            }
            for cid in campaign_ids
        }

        # 1) Enrolled prospect counts.
        enrolled_rows = (
            db.query(CampaignProspect.campaign_id, func.count(CampaignProspect.id))
            .filter(CampaignProspect.campaign_id.in_(campaign_ids))
            .group_by(CampaignProspect.campaign_id)
            .all()
        )
        for cid, count in enrolled_rows:
            raw[cid]["enrolled"] = count or 0

        # 2) Email-sequence aggregates in a single grouped query.
        seq_rows = (
            db.query(
                EmailSequence.campaign_id,
                func.count(EmailSequence.id),
                func.sum(case((EmailSequence.approval_status == "pending", 1), else_=0)),
                func.sum(case((EmailSequence.approval_status == "approved", 1), else_=0)),
                func.sum(case((EmailSequence.sent_at.isnot(None), 1), else_=0)),
            )
            .filter(EmailSequence.campaign_id.in_(campaign_ids))
            .group_by(EmailSequence.campaign_id)
            .all()
        )
        for cid, generated, pending, approved, sent in seq_rows:
            raw[cid]["generated"] = int(generated or 0)
            raw[cid]["pending"] = int(pending or 0)
            raw[cid]["approved"] = int(approved or 0)
            raw[cid]["sent"] = int(sent or 0)

        # 3) Activity event counts, grouped by (campaign_id, event_type).
        event_rows = (
            db.query(
                ActivityEvent.campaign_id,
                ActivityEvent.event_type,
                func.count(ActivityEvent.id),
            )
            .filter(
                ActivityEvent.campaign_id.in_(campaign_ids),
                ActivityEvent.event_type.in_(["open", "click", "reply", "meeting_booked"]),
            )
            .group_by(ActivityEvent.campaign_id, ActivityEvent.event_type)
            .all()
        )
        ev_key_map = {"open": "opens", "click": "clicks", "reply": "replies", "meeting_booked": "meetings"}
        for cid, ev_type, count in event_rows:
            key = ev_key_map.get(ev_type)
            if key:
                raw[cid][key] = int(count or 0)

        return {
            cid: CampaignStats(
                enrolled=s["enrolled"],
                emails_generated=s["generated"],
                pending_approval=s["pending"],
                approved=s["approved"],
                sent=s["sent"],
                opens=s["opens"],
                clicks=s["clicks"],
                replies=s["replies"],
                meetings_booked=s["meetings"],
                open_rate=round(s["opens"] / s["sent"] * 100, 1) if s["sent"] > 0 else 0,
                reply_rate=round(s["replies"] / s["sent"] * 100, 1) if s["sent"] > 0 else 0,
            )
            for cid, s in raw.items()
        }

    def _fetch_brief_titles(self, brief_ids: List[str], db: Session) -> dict:
        """Batch-load campaign brief titles so the list endpoint doesn't
        fire one SELECT per linked brief."""
        if not brief_ids:
            return {}
        rows = (
            db.query(CampaignBrief.id, CampaignBrief.title)
            .filter(CampaignBrief.id.in_(brief_ids))
            .all()
        )
        return {bid: title for bid, title in rows}

    def create(self, db: Session, data: CampaignCreate) -> CampaignDetail:
        # If the vertical is layered (no messaging_framework on the vertical pack itself),
        # vendor_pack and product_pack are required.
        vpack = pack_loader.load_vertical(data.vertical_pack)
        if vpack and not pack_loader.is_legacy_vertical(vpack):
            if not (data.vendor_pack and data.product_pack):
                from fastapi import HTTPException
                raise HTTPException(
                    status_code=422,
                    detail=f"Vertical '{data.vertical_pack}' is layered and requires vendor_pack and product_pack.",
                )

        campaign = Campaign(
            name=data.name,
            vertical_pack=data.vertical_pack,
            vendor_pack=data.vendor_pack,
            product_pack=data.product_pack,
            regional_pack=data.regional_pack,
            status="draft",
            sequence_touches=data.sequence_touches,
            touch_delay_days=data.touch_delay_days,
            icp_filter=data.icp_filter,
            campaign_brief_id=data.campaign_brief_id,
        )
        db.add(campaign)
        db.flush()

        # Enroll prospects
        if data.prospect_ids:
            prospect_ids = data.prospect_ids
        else:
            threshold = data.min_icp_score if data.min_icp_score is not None else 0.5
            prospects = (
                db.query(Prospect)
                .filter(Prospect.vertical == data.vertical_pack, Prospect.icp_score >= threshold)
                .all()
            )
            prospect_ids = [p.id for p in prospects]

        for pid in prospect_ids:
            cp = CampaignProspect(campaign_id=campaign.id, prospect_id=pid, enrollment_status="enrolled")
            db.add(cp)

        # Update brief if linked
        if data.campaign_brief_id:
            brief = db.query(CampaignBrief).filter(CampaignBrief.id == data.campaign_brief_id).first()
            if brief:
                brief.status = "linked"
                brief.linked_campaign_id = campaign.id

        db.commit()
        db.refresh(campaign)
        return self._to_detail(campaign, db)

    def update(self, db: Session, campaign_id: int, data: CampaignUpdate) -> Optional[CampaignDetail]:
        campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not campaign:
            return None
        patch = data.model_dump(exclude_unset=True)
        schedule_dirty = bool(
            {"auto_send", "send_cadence", "cadence_custom_cron"} & patch.keys()
        )
        for field, value in patch.items():
            setattr(campaign, field, value)
        db.commit()
        db.refresh(campaign)
        if schedule_dirty:
            from app.services.scheduler_service import scheduler_service
            scheduler_service.reschedule_campaign(campaign_id)
        return self._to_detail(campaign, db)

    def get_stats(self, db: Session, campaign_id: int) -> CampaignStats:
        return self._compute_stats(campaign_id, db)

    async def run_pipeline(self, campaign_id: int):
        """Runs the full agent pipeline for a campaign. Called as a background task."""
        from app.database import SessionLocal
        from app.agents.pipeline import run_campaign_pipeline
        from sqlalchemy import func
        import uuid
        from datetime import date
        db = SessionLocal()
        try:
            campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
            if not campaign:
                return
            campaign.status = "running"
            db.commit()
            await run_campaign_pipeline(campaign_id, db)
            campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
            if campaign:
                campaign.status = "draft"  # Back to draft after generation — awaiting approval

                # Auto-generate a campaign brief if one wasn't provided at creation
                if not campaign.campaign_brief_id:
                    enrolled = db.query(func.count(CampaignProspect.id)).filter(
                        CampaignProspect.campaign_id == campaign_id
                    ).scalar() or 0
                    sequences = db.query(func.count(EmailSequence.id)).filter(
                        EmailSequence.campaign_id == campaign_id
                    ).scalar() or 0

                    brief_id = f"pipeline_{campaign_id}_{date.today().strftime('%Y%m%d')}_{uuid.uuid4().hex[:6]}"
                    brief = CampaignBrief(
                        id=brief_id,
                        title=campaign.name,
                        source_system="campaign_pipeline_v1",
                        vertical=campaign.vertical_pack,
                        region=campaign.regional_pack,
                        objective=(
                            f"AI pipeline executed for '{campaign.name}'. "
                            f"Targeted {enrolled} {campaign.vertical_pack.replace('_', ' ')} prospects "
                            f"with {sequences} personalised email sequence{'' if sequences == 1 else 's'} "
                            f"({campaign.sequence_touches} touch{'' if campaign.sequence_touches == 1 else 'es'}, "
                            f"{campaign.touch_delay_days} days apart)."
                        ),
                        target_segment={
                            "country_codes": [],
                            "min_capacity_count": None,
                            "ownership_types": [],
                            "has_online_booking": None,
                            "min_icp_score": None,
                        },
                        priority="medium",
                        status="executed",
                        linked_campaign_id=campaign.id,
                    )
                    db.add(brief)
                    campaign.campaign_brief_id = brief_id

                db.commit()
        finally:
            db.close()

    # --- Campaign Brief methods ---

    def create_brief(self, db: Session, data: CampaignBriefCreate) -> CampaignBriefResponse:
        existing = db.query(CampaignBrief).filter(CampaignBrief.id == data.id).first()
        if existing:
            from fastapi import HTTPException
            raise HTTPException(status_code=409, detail=f"Campaign brief '{data.id}' already exists")

        # Validate packs exist
        if not pack_loader.load_vertical(data.vertical):
            from fastapi import HTTPException
            raise HTTPException(status_code=422, detail=f"Vertical pack '{data.vertical}' not found")
        if not pack_loader.load_regional(data.region):
            from fastapi import HTTPException
            raise HTTPException(status_code=422, detail=f"Regional pack '{data.region}' not found")

        brief = CampaignBrief(
            id=data.id,
            title=data.title,
            source_system=data.source_system,
            vertical=data.vertical,
            region=data.region,
            objective=data.objective,
            target_segment=data.target_segment.model_dump(),
            priority=data.priority.value,
            ideal_launch_date=data.ideal_launch_date,
            budget_signal=data.budget_signal.model_dump() if data.budget_signal else None,
            metadata_=data.metadata,
            status="received",
        )
        db.add(brief)
        db.commit()
        db.refresh(brief)
        return self._brief_to_schema(brief)

    def list_briefs(self, db: Session, status: Optional[str] = None) -> CampaignBriefListResponse:
        q = db.query(CampaignBrief)
        if status:
            q = q.filter(CampaignBrief.status == status)
        briefs = q.order_by(CampaignBrief.created_at.desc()).all()
        return CampaignBriefListResponse(
            briefs=[self._brief_to_schema(b) for b in briefs],
            total=len(briefs)
        )

    def get_brief(self, db: Session, brief_id: str) -> Optional[CampaignBriefResponse]:
        brief = db.query(CampaignBrief).filter(CampaignBrief.id == brief_id).first()
        if not brief:
            return None
        return self._brief_to_schema(brief)

    def link_brief(self, db: Session, brief_id: str, campaign_id: int) -> Optional[dict]:
        brief = db.query(CampaignBrief).filter(CampaignBrief.id == brief_id).first()
        campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
        if not brief or not campaign:
            return None
        brief.status = "linked"
        brief.linked_campaign_id = campaign_id
        campaign.campaign_brief_id = brief_id
        db.commit()
        return {"brief_id": brief_id, "campaign_id": campaign_id, "status": "linked"}

    def _brief_to_schema(self, b: CampaignBrief) -> CampaignBriefResponse:
        return CampaignBriefResponse(
            id=b.id, title=b.title, source_system=b.source_system,
            vertical=b.vertical, region=b.region, objective=b.objective,
            target_segment=b.target_segment, priority=b.priority,
            ideal_launch_date=b.ideal_launch_date, budget_signal=b.budget_signal,
            metadata=b.metadata_, status=b.status,
            linked_campaign_id=b.linked_campaign_id, created_at=b.created_at,
        )


campaign_service = CampaignService()
