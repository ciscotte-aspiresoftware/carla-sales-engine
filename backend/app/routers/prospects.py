from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from typing import Optional, List
from pydantic import BaseModel, field_validator
from app.database import get_db
from app.models.activity import ActivityEvent
from app.models.prospect import Prospect
from app.services.prospect_service import prospect_service
from app.services.prospect_contact_service import prospect_contact_service
from app.schemas.prospect import (
    ProspectListResponse,
    ProspectDetail,
    ProspectUpdate,
    ProspectContactCreate,
    ProspectContactDetail,
    ProspectContactUpdate,
)

router = APIRouter()


def _hydrate_detail(db: Session, prospect) -> ProspectDetail:
    """Build a ProspectDetail with the prospect's extra contacts nested."""
    detail = ProspectDetail.model_validate(prospect)
    detail.contacts = [
        ProspectContactDetail.model_validate(c)
        for c in prospect_contact_service.list_for_prospect(db, prospect.id)
    ]
    return detail


@router.get("/prospects", response_model=ProspectListResponse)
async def list_prospects(
    db: Session = Depends(get_db),
    country_code: Optional[str] = None,
    ownership_type: Optional[str] = None,
    has_online_booking: Optional[bool] = None,
    min_icp_score: Optional[float] = None,
    max_icp_score: Optional[float] = None,
    vertical: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=500),
):
    return prospect_service.list_prospects(
        db, country_code=country_code, ownership_type=ownership_type,
        has_online_booking=has_online_booking, min_icp_score=min_icp_score,
        max_icp_score=max_icp_score, vertical=vertical, search=search,
        page=page, limit=limit,
    )


@router.get("/prospects/{prospect_id}", response_model=ProspectDetail)
async def get_prospect(prospect_id: int, db: Session = Depends(get_db)):
    prospect = prospect_service.get_by_id(db, prospect_id)
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")
    return _hydrate_detail(db, prospect)


@router.patch("/prospects/{prospect_id}", response_model=ProspectDetail)
async def update_prospect(prospect_id: int, data: ProspectUpdate, db: Session = Depends(get_db)):
    prospect = prospect_service.update(db, prospect_id, data)
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")
    return _hydrate_detail(db, prospect)


@router.post("/prospects/upload-csv")
async def upload_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    content = await file.read()
    result = prospect_service.import_csv(db, content.decode("utf-8"))
    return result


# ── Adopt a discovered email ──────────────────────────────────────────────

class AdoptDiscoveredEmailRequest(BaseModel):
    """Promote one of the addresses Claude extracted from the prospect's
    own website to be the prospect's primary email."""
    email: str

    @field_validator("email")
    @classmethod
    def normalise(cls, v: str) -> str:
        v = (v or "").strip().lower()
        if "@" not in v:
            raise ValueError("email must contain '@'")
        return v


@router.post("/prospects/{prospect_id}/use-discovered-email", response_model=ProspectDetail)
async def adopt_discovered_email(
    prospect_id: int,
    payload: AdoptDiscoveredEmailRequest,
    db: Session = Depends(get_db),
):
    """Set `prospect.email` to an address from `website_research.discovered_emails`,
    promote `provenance.email` to "scrape", and log an activity event.

    Returns 400 when the requested email isn't in the discovered list (callers
    cannot bypass the verification done by the scraper), 404 when the prospect
    doesn't exist, and 409 when another prospect already owns this address."""
    prospect = db.query(Prospect).filter(Prospect.id == prospect_id).first()
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")

    wr = prospect.website_research or {}
    discovered = wr.get("discovered_emails") or []
    discovered_addresses = {
        (d.get("email") or "").strip().lower()
        for d in discovered if isinstance(d, dict)
    }
    if payload.email not in discovered_addresses:
        raise HTTPException(
            status_code=400,
            detail="Email is not in this prospect's discovered_emails list — re-scrape first.",
        )

    if prospect.email and prospect.email.strip().lower() == payload.email:
        # Idempotent — bump provenance only.
        provenance = dict(prospect.provenance or {})
        if provenance.get("email") != "scrape":
            provenance["email"] = "scrape"
            prospect.provenance = provenance
            db.commit()
        return _hydrate_detail(db, prospect)

    previous_email = prospect.email
    prospect.email = payload.email
    provenance = dict(prospect.provenance or {})
    provenance["email"] = "scrape"
    prospect.provenance = provenance
    db.add(ActivityEvent(
        prospect_id=prospect_id,
        event_type="prospect_email_updated",
        event_data={
            "source": "website_scrape",
            "previous_email": previous_email,
            "new_email": payload.email,
        },
        is_simulated=False,
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # email column is UNIQUE — another prospect already owns this address.
        raise HTTPException(
            status_code=409,
            detail="Another prospect is already using this email address.",
        )
    db.refresh(prospect)
    return _hydrate_detail(db, prospect)


# ── Contacts CRUD (additional personas per prospect) ──────────────────────


@router.get("/prospects/{prospect_id}/contacts", response_model=List[ProspectContactDetail])
async def list_prospect_contacts(prospect_id: int, db: Session = Depends(get_db)):
    if not prospect_service.get_by_id(db, prospect_id):
        raise HTTPException(status_code=404, detail="Prospect not found")
    return prospect_contact_service.list_for_prospect(db, prospect_id)


@router.post("/prospects/{prospect_id}/contacts", response_model=ProspectContactDetail)
async def create_prospect_contact(
    prospect_id: int, data: ProspectContactCreate, db: Session = Depends(get_db)
):
    contact = prospect_contact_service.create(db, prospect_id, data)
    if not contact:
        raise HTTPException(status_code=404, detail="Prospect not found")
    return contact


@router.patch("/prospects/{prospect_id}/contacts/{contact_id}", response_model=ProspectContactDetail)
async def update_prospect_contact(
    prospect_id: int, contact_id: int, data: ProspectContactUpdate, db: Session = Depends(get_db)
):
    contact = prospect_contact_service.get(db, contact_id)
    if not contact or contact.prospect_id != prospect_id:
        raise HTTPException(status_code=404, detail="Contact not found")
    return prospect_contact_service.update(db, contact_id, data)


@router.delete("/prospects/{prospect_id}/contacts/{contact_id}")
async def delete_prospect_contact(
    prospect_id: int, contact_id: int, db: Session = Depends(get_db)
):
    contact = prospect_contact_service.get(db, contact_id)
    if not contact or contact.prospect_id != prospect_id:
        raise HTTPException(status_code=404, detail="Contact not found")
    prospect_contact_service.delete(db, contact_id)
    return {"deleted": True, "id": contact_id}


# ── Apollo people search ──────────────────────────────────────────────────────

@router.post("/prospects/{prospect_id}/search-apollo", response_model=List[ProspectContactDetail])
async def search_apollo_contacts(
    prospect_id: int,
    db: Session = Depends(get_db),
    limit: int = Query(3, ge=1, le=10),
):
    """Use Apollo to discover decision-makers at this prospect's domain.

    Saves each result as a ProspectContact (skips duplicates by email).
    Returns the full updated contact list for the prospect.
    """
    prospect = prospect_service.get_by_id(db, prospect_id)
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")

    from app.integrations import registry, Capability
    from app.integrations.base import NotConfigured, ProviderError

    providers = registry.by_capability(Capability.PERSON_SEARCH, configured_only=True)
    if not providers:
        raise HTTPException(status_code=503, detail="No PERSON_SEARCH provider configured — add APOLLO_API_KEY to settings")

    from urllib.parse import urlparse
    domain = ""
    if prospect.website_url:
        parsed = urlparse(prospect.website_url)
        domain = parsed.netloc.lstrip("www.") or parsed.path.lstrip("www.")

    try:
        people = await providers[0].search_people(
            domain=domain or None,
            org_name=prospect.business_name,
            limit=limit,
        )
    except (NotConfigured, ProviderError) as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    existing_emails = {
        (c.email or "").lower()
        for c in prospect_contact_service.list_for_prospect(db, prospect_id)
        if c.email
    }

    for person in people:
        email = (person.get("email") or "").lower()
        if email and email in existing_emails:
            continue
        contact_data = ProspectContactCreate(
            full_name=person["full_name"],
            role=person.get("role"),
            email=person.get("email") or None,
            linkedin_url=person.get("linkedin_url") or None,
            is_primary=False,
            contact_priority=max(0, 10 - person.get("tier", 99)),
        )
        prospect_contact_service.create(db, prospect_id, contact_data)
        if email:
            existing_emails.add(email)

    return prospect_contact_service.list_for_prospect(db, prospect_id)


# ── HubSpot push ──────────────────────────────────────────────────────────────

@router.post("/prospects/{prospect_id}/push-to-hubspot")
async def push_to_hubspot(
    prospect_id: int,
    db: Session = Depends(get_db),
):
    """Push this prospect (as a Company) and its contacts to HubSpot CRM.

    Returns the HubSpot company ID and a direct link to the record.
    """
    prospect = prospect_service.get_by_id(db, prospect_id)
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")

    from app.integrations import registry, Capability
    from app.integrations.base import NotConfigured, ProviderError

    providers = registry.by_capability(Capability.COMPANY_SYNC, configured_only=True)
    if not providers:
        raise HTTPException(status_code=503, detail="No CRM provider configured — add HUBSPOT_ACCESS_TOKEN to settings")

    hs = providers[0]

    try:
        company_result = await hs.push_company(prospect)
        hubspot_company_id = company_result["id"]

        contacts = prospect_contact_service.list_for_prospect(db, prospect_id)
        pushed_contacts = []
        for contact in contacts:
            try:
                contact_result = await hs.push_contact(contact, hubspot_company_id)
                pushed_contacts.append({"name": contact.full_name, "hubspot_id": contact_result["id"]})
            except (NotConfigured, ProviderError):
                pass

    except (NotConfigured, ProviderError) as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {
        "hubspot_company_id": hubspot_company_id,
        "hubspot_url": company_result["url"],
        "contacts_pushed": len(pushed_contacts),
        "contacts": pushed_contacts,
    }
