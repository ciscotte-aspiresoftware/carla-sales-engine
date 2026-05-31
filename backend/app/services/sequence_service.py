from datetime import datetime, timezone
from typing import Optional, List
from sqlalchemy.orm import Session
from app.models.activity import ActivityEvent
from app.models.campaign import Campaign
from app.models.email_sequence import EmailSequence
from app.models.prospect import Prospect
from app.schemas.email_sequence import EmailSequenceDetail, SequenceListResponse


class SequenceService:
    def _to_schema(self, seq: EmailSequence, db: Session) -> EmailSequenceDetail:
        prospect = db.query(Prospect).filter(Prospect.id == seq.prospect_id).first()
        d = EmailSequenceDetail.model_validate(seq)
        if prospect:
            d.business_name = prospect.business_name
            d.contact_name = prospect.contact_name
            d.contact_email = prospect.email
            d.website_url = prospect.website_url
        return d

    def list_sequences(
        self,
        db: Session,
        campaign_id: Optional[int] = None,
        prospect_id: Optional[int] = None,
        approval_status: Optional[str] = None,
    ) -> SequenceListResponse:
        q = db.query(EmailSequence)
        if campaign_id:
            q = q.filter(EmailSequence.campaign_id == campaign_id)
        if prospect_id:
            q = q.filter(EmailSequence.prospect_id == prospect_id)
        if approval_status:
            q = q.filter(EmailSequence.approval_status == approval_status)
        seqs = q.order_by(EmailSequence.prospect_id, EmailSequence.touch_number).all()
        return SequenceListResponse(
            sequences=[self._to_schema(s, db) for s in seqs],
            total=len(seqs),
        )

    def get_by_id(self, db: Session, seq_id: int) -> Optional[EmailSequenceDetail]:
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq:
            return None
        return self._to_schema(seq, db)

    def approve(self, db: Session, seq_id: int, approved_by: str) -> Optional[EmailSequenceDetail]:
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq:
            return None
        seq.approval_status = "approved"
        seq.approved_by = approved_by
        seq.approved_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(seq)
        self._maybe_schedule(db, seq)
        return self._to_schema(seq, db)

    def reject(self, db: Session, seq_id: int) -> Optional[EmailSequenceDetail]:
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq:
            return None
        seq.approval_status = "rejected"
        db.commit()
        db.refresh(seq)
        return self._to_schema(seq, db)

    def update_content(self, db: Session, seq_id: int, subject: str, body: str) -> Optional[EmailSequenceDetail]:
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq:
            return None
        seq.subject = subject
        seq.body = body
        db.commit()
        db.refresh(seq)
        return self._to_schema(seq, db)

    def bulk_reject(self, db: Session, ids: List[int]) -> dict:
        seqs = db.query(EmailSequence).filter(EmailSequence.id.in_(ids)).all()
        for seq in seqs:
            seq.approval_status = "rejected"
        db.commit()
        return {"rejected": len(seqs)}

    def bulk_approve(self, db: Session, ids: List[int], approved_by: str) -> dict:
        now = datetime.now(timezone.utc)
        seqs = db.query(EmailSequence).filter(EmailSequence.id.in_(ids)).all()
        for seq in seqs:
            seq.approval_status = "approved"
            seq.approved_by = approved_by
            seq.approved_at = now
        db.commit()
        for seq in seqs:
            self._maybe_schedule(db, seq)
        return {"approved": len(seqs)}

    def _maybe_schedule(self, db: Session, seq: EmailSequence) -> None:
        """If the parent campaign has auto_send=True, register a scheduler
        job for this sequence per the campaign's cadence. No-op otherwise."""
        campaign = db.query(Campaign).filter(Campaign.id == seq.campaign_id).first()
        if not campaign or not campaign.auto_send:
            return
        from app.services.scheduler_service import resolve_send_at, scheduler_service
        send_at = resolve_send_at(campaign)
        if campaign.send_cadence == "custom" and campaign.cadence_custom_cron:
            scheduler_service.schedule_sequence_send(seq.id, send_at, cron=campaign.cadence_custom_cron)
        else:
            scheduler_service.schedule_sequence_send(seq.id, send_at)

    def mark_sent(self, db: Session, seq_id: int) -> Optional[EmailSequenceDetail]:
        """Mark a sequence as sent.

        When the parent campaign has `dry_run=True`, the sequence's `sent_at`
        stays NULL and we instead emit a `dry_run_send` ActivityEvent with the
        full payload — letting a portfolio team validate prompts + cadence
        end-to-end without risk of accidental real outbound.
        """
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq:
            return None

        campaign = db.query(Campaign).filter(Campaign.id == seq.campaign_id).first()
        if campaign and campaign.dry_run:
            db.add(ActivityEvent(
                campaign_id=seq.campaign_id,
                prospect_id=seq.prospect_id,
                email_sequence_id=seq.id,
                event_type="dry_run_send",
                event_data={
                    "subject": seq.subject,
                    "body": seq.body,
                    "touch_number": seq.touch_number,
                    "would_have_sent_at": datetime.now(timezone.utc).isoformat(),
                },
                is_simulated=False,
            ))
            db.commit()
            db.refresh(seq)
            return self._to_schema(seq, db)

        seq.sent_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(seq)
        return self._to_schema(seq, db)


sequence_service = SequenceService()
