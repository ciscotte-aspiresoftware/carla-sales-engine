from sqlalchemy import Column, Integer, String, Boolean, JSON, DateTime, ForeignKey
from sqlalchemy.sql import func

from app.database import Base


class ProspectContact(Base):
    """One person at a prospect business — owner, GM, dockmaster, etc.

    A prospect always has its top-level `contact_name`/`email`/`phone` for the
    primary persona (back-compat with the original single-contact design).
    Additional personas live here so voice/SMS/LinkedIn channels can target
    a specific role rather than the primary email contact.

    Created during discovery enrichment when the LLM finds multiple contacts
    in pack `discovery_copy.contact_priority` order, or manually via the
    Prospect detail UI.
    """
    __tablename__ = "prospect_contacts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    prospect_id = Column(Integer, ForeignKey("prospects.id"), nullable=False, index=True)
    full_name = Column(String(200), nullable=False)
    role = Column(String(100), nullable=True)            # owner, gm, dockmaster, ...
    email = Column(String(200), nullable=True)
    phone = Column(String(50), nullable=True)
    linkedin_url = Column(String(500), nullable=True)
    is_primary = Column(Boolean, nullable=False, default=False)
    contact_priority = Column(Integer, nullable=False, default=0)  # higher = preferred for outreach
    # {"email": "snippet"|"training"|"user"|"unknown", ...} — same shape as Prospect.provenance
    provenance = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
