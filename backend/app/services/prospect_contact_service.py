"""
ProspectContact CRUD service.

Contacts are extra personas attached to a prospect (owner + GM + dockmaster
etc.). Used by voice/SMS/LinkedIn channels to target a specific role rather
than only the prospect's primary email contact.

Discovery may auto-create contacts when the LLM finds multiple personas in
pack `discovery_copy.contact_priority` order; the Prospect detail UI lets a
user add/edit/remove them by hand.
"""
from typing import Optional

from sqlalchemy.orm import Session

from app.models.prospect import Prospect
from app.models.prospect_contact import ProspectContact
from app.schemas.prospect import ProspectContactCreate, ProspectContactUpdate


class ProspectContactService:
    def list_for_prospect(self, db: Session, prospect_id: int) -> list[ProspectContact]:
        return (
            db.query(ProspectContact)
            .filter(ProspectContact.prospect_id == prospect_id)
            .order_by(ProspectContact.is_primary.desc(), ProspectContact.contact_priority.desc(), ProspectContact.id.asc())
            .all()
        )

    def get(self, db: Session, contact_id: int) -> Optional[ProspectContact]:
        return db.query(ProspectContact).filter(ProspectContact.id == contact_id).first()

    def create(self, db: Session, prospect_id: int, data: ProspectContactCreate) -> Optional[ProspectContact]:
        if not db.query(Prospect).filter(Prospect.id == prospect_id).first():
            return None
        if data.is_primary:
            self._clear_primary(db, prospect_id)
        contact = ProspectContact(
            prospect_id=prospect_id,
            **data.model_dump(),
        )
        db.add(contact)
        db.commit()
        db.refresh(contact)
        return contact

    def update(self, db: Session, contact_id: int, data: ProspectContactUpdate) -> Optional[ProspectContact]:
        contact = self.get(db, contact_id)
        if not contact:
            return None
        patch = data.model_dump(exclude_unset=True)
        if patch.get("is_primary") is True:
            self._clear_primary(db, contact.prospect_id, exclude_id=contact.id)
        for field, value in patch.items():
            setattr(contact, field, value)
        db.commit()
        db.refresh(contact)
        return contact

    def delete(self, db: Session, contact_id: int) -> bool:
        contact = self.get(db, contact_id)
        if not contact:
            return False
        db.delete(contact)
        db.commit()
        return True

    def _clear_primary(self, db: Session, prospect_id: int, exclude_id: Optional[int] = None) -> None:
        q = db.query(ProspectContact).filter(
            ProspectContact.prospect_id == prospect_id,
            ProspectContact.is_primary.is_(True),
        )
        if exclude_id is not None:
            q = q.filter(ProspectContact.id != exclude_id)
        for row in q.all():
            row.is_primary = False


prospect_contact_service = ProspectContactService()
