from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Optional
from app.database import get_db
from app.services.sequence_service import sequence_service
from app.schemas.email_sequence import SequenceListResponse, EmailSequenceDetail, BulkApproveRequest, BulkRejectRequest, SequenceUpdateRequest

router = APIRouter()


@router.get("/sequences", response_model=SequenceListResponse)
async def list_sequences(
    db: Session = Depends(get_db),
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    approval_status: Optional[str] = None,
):
    return sequence_service.list_sequences(
        db, campaign_id=campaign_id, prospect_id=prospect_id, approval_status=approval_status
    )


@router.get("/sequences/{sequence_id}", response_model=EmailSequenceDetail)
async def get_sequence(sequence_id: int, db: Session = Depends(get_db)):
    seq = sequence_service.get_by_id(db, sequence_id)
    if not seq:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return seq


@router.patch("/sequences/{sequence_id}/approve", response_model=EmailSequenceDetail)
async def approve_sequence(sequence_id: int, approved_by: str = "demo_user", db: Session = Depends(get_db)):
    seq = sequence_service.approve(db, sequence_id, approved_by)
    if not seq:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return seq


@router.patch("/sequences/{sequence_id}/reject", response_model=EmailSequenceDetail)
async def reject_sequence(sequence_id: int, db: Session = Depends(get_db)):
    seq = sequence_service.reject(db, sequence_id)
    if not seq:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return seq


@router.post("/sequences/bulk-approve")
async def bulk_approve(data: BulkApproveRequest, db: Session = Depends(get_db)):
    return sequence_service.bulk_approve(db, data.ids, data.approved_by)


@router.post("/sequences/bulk-reject")
async def bulk_reject(data: BulkRejectRequest, db: Session = Depends(get_db)):
    return sequence_service.bulk_reject(db, data.ids)


@router.patch("/sequences/{sequence_id}/content", response_model=EmailSequenceDetail)
async def update_content(sequence_id: int, data: SequenceUpdateRequest, db: Session = Depends(get_db)):
    seq = sequence_service.update_content(db, sequence_id, data.subject, data.body)
    if not seq:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return seq


@router.post("/sequences/{sequence_id}/mark-sent", response_model=EmailSequenceDetail)
async def mark_sent(sequence_id: int, db: Session = Depends(get_db)):
    seq = sequence_service.mark_sent(db, sequence_id)
    if not seq:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return seq
