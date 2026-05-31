import csv
import io
import math
from typing import Optional
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.models.prospect import Prospect
from app.schemas.prospect import ProspectListResponse, ProspectDetail, ProspectUpdate


class ProspectService:
    def list_prospects(
        self,
        db: Session,
        country_code: Optional[str] = None,
        ownership_type: Optional[str] = None,
        has_online_booking: Optional[bool] = None,
        min_icp_score: Optional[float] = None,
        max_icp_score: Optional[float] = None,
        vertical: Optional[str] = None,
        search: Optional[str] = None,
        page: int = 1,
        limit: int = 25,
    ) -> ProspectListResponse:
        q = db.query(Prospect)
        if country_code:
            q = q.filter(Prospect.country_code == country_code.upper())
        if ownership_type:
            q = q.filter(Prospect.ownership_type == ownership_type)
        if has_online_booking is not None:
            q = q.filter(Prospect.has_online_booking == has_online_booking)
        if min_icp_score is not None:
            q = q.filter(Prospect.icp_score >= min_icp_score)
        if max_icp_score is not None:
            q = q.filter(Prospect.icp_score <= max_icp_score)
        if vertical:
            q = q.filter(Prospect.vertical == vertical)
        if search:
            q = q.filter(
                or_(
                    Prospect.business_name.ilike(f"%{search}%"),
                    Prospect.city.ilike(f"%{search}%"),
                    Prospect.state.ilike(f"%{search}%"),
                    Prospect.contact_name.ilike(f"%{search}%"),
                )
            )
        total = q.count()
        offset = (page - 1) * limit
        prospects = q.order_by(Prospect.icp_score.desc().nullslast()).offset(offset).limit(limit).all()
        return ProspectListResponse(
            prospects=[ProspectDetail.model_validate(p) for p in prospects],
            total=total,
            page=page,
            limit=limit,
            pages=math.ceil(total / limit) if total > 0 else 1,
        )

    def get_by_id(self, db: Session, prospect_id: int) -> Optional[Prospect]:
        return db.query(Prospect).filter(Prospect.id == prospect_id).first()

    # Fields tracked by `prospect.provenance`. When the user PATCHes one of
    # these, we flip its provenance to "user" so downstream auto-promotion
    # (e.g. the scrape pipeline's email auto-swap) respects the manual edit.
    _PROVENANCE_TRACKED_FIELDS = frozenset({
        "email", "website_url", "capacity_count", "tech_maturity_score",
        "has_online_booking", "services", "ownership_type",
    })

    def update(self, db: Session, prospect_id: int, data: ProspectUpdate) -> Optional[Prospect]:
        prospect = self.get_by_id(db, prospect_id)
        if not prospect:
            return None
        update_dict = data.model_dump(exclude_unset=True)
        for field, value in update_dict.items():
            setattr(prospect, field, value)
        edited_tracked = [f for f in update_dict if f in self._PROVENANCE_TRACKED_FIELDS]
        if edited_tracked:
            provenance = dict(prospect.provenance or {})
            for f in edited_tracked:
                provenance[f] = "user"
            prospect.provenance = provenance
        db.commit()
        db.refresh(prospect)
        return prospect

    def import_csv(self, db: Session, csv_content: str) -> dict:
        reader = csv.DictReader(io.StringIO(csv_content))
        imported = 0
        errors = []
        for i, row in enumerate(reader):
            try:
                services = [s.strip() for s in row.get("services", "").split("|") if s.strip()]
                # CSV import accepts either the new column names (business_name,
                # capacity_count) or the old vertical-coupled names (marina_name,
                # berth_count) for backwards compat with hand-curated marina CSVs.
                business_name = row.get("business_name") or row.get("marina_name")
                capacity_raw = row.get("capacity_count") or row.get("berth_count")
                prospect = Prospect(
                    business_name=business_name,
                    contact_name=row["contact_name"],
                    contact_title=row["contact_title"],
                    email=row["email"],
                    city=row["city"],
                    state=row.get("state") or None,
                    country_code=row["country_code"].upper(),
                    capacity_count=int(capacity_raw) if capacity_raw else None,
                    services=services,
                    website_url=row.get("website_url") or None,
                    tech_maturity_score=int(row["tech_maturity_score"]) if row.get("tech_maturity_score") else None,
                    has_online_booking=row.get("has_online_booking", "false").lower() == "true",
                    ownership_type=row.get("ownership_type", "family"),
                    vertical=row.get("vertical", "marina"),
                    icp_score=float(row["icp_score"]) if row.get("icp_score") else None,
                )
                db.add(prospect)
                db.flush()
                imported += 1
            except Exception as e:
                errors.append({"row": i + 2, "error": str(e)})
        db.commit()
        return {"imported": imported, "errors": errors}


prospect_service = ProspectService()
