"""
Seed script — loads real / curated prospect data into the database.

Usage:
    cd backend
    python seed.py

This is idempotent — running twice won't duplicate prospects (checked by email).
Engagement (opens / clicks / replies / meetings) is intentionally NOT seeded.
Activity counts start at zero and only grow from real pipeline runs.
"""
import sys
import os
import csv
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent))

os.environ.setdefault("PYTHONPATH", str(Path(__file__).parent))

from app.database import engine, SessionLocal, Base
import app.models  # noqa — registers all models

from app.models.prospect import Prospect

Base.metadata.create_all(bind=engine)
db = SessionLocal()


def _migrate_prospect_columns():
    """Add lat/lng/is_real columns to existing prospects table if not present."""
    from sqlalchemy import text, inspect
    inspector = inspect(engine)
    cols = {c["name"] for c in inspector.get_columns("prospects")}
    with engine.connect() as conn:
        if "lat" not in cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN lat FLOAT"))
        if "lng" not in cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN lng FLOAT"))
        if "is_real" not in cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN is_real BOOLEAN NOT NULL DEFAULT 0"))
        conn.commit()


_migrate_prospect_columns()


def seed_prospects():
    csv_path = Path(__file__).parent / "data" / "synthetic_prospects.csv"
    imported = 0
    skipped = 0
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if db.query(Prospect).filter(Prospect.email == row["email"]).first():
                skipped += 1
                continue
            services = [s.strip() for s in row.get("services", "").split("|") if s.strip()]
            p = Prospect(
                marina_name=row["marina_name"],
                contact_name=row["contact_name"],
                contact_title=row["contact_title"],
                email=row["email"],
                city=row["city"],
                country_code=row["country_code"].upper(),
                berth_count=int(row["berth_count"]) if row.get("berth_count") else None,
                services=services,
                website_url=row.get("website_url") or None,
                tech_maturity_score=int(row["tech_maturity_score"]) if row.get("tech_maturity_score") else None,
                has_online_booking=row.get("has_online_booking", "false").lower() == "true",
                ownership_type=row.get("ownership_type", "family"),
                vertical="marina",
                icp_score=float(row["icp_score"]) if row.get("icp_score") else None,
                lat=float(row["lat"]) if row.get("lat") else None,
                lng=float(row["lng"]) if row.get("lng") else None,
                is_real=row.get("is_real", "false").lower() == "true",
            )
            db.add(p)
            imported += 1
    db.commit()
    print(f"Prospects: {imported} imported, {skipped} skipped (already exist)")

    # Backfill lat/lng/is_real for existing prospects that are missing coordinates
    backfilled = 0
    with open(csv_path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if not row.get("lat"):
                continue
            p = db.query(Prospect).filter(Prospect.email == row["email"]).first()
            if p and p.lat is None:
                p.lat = float(row["lat"])
                p.lng = float(row["lng"])
                p.is_real = row.get("is_real", "false").lower() == "true"
                backfilled += 1
    if backfilled:
        db.commit()
        print(f"Prospects: backfilled coordinates for {backfilled} existing rows")
    return imported


def main():
    print("=== SDR Engine — Seed Script ===")
    seed_prospects()

    total = db.query(Prospect).count()
    print(f"\nTotal prospects in DB: {total}")
    print("Done. Run: cd backend && uvicorn app.main:app --reload")


if __name__ == "__main__":
    main()
    db.close()
