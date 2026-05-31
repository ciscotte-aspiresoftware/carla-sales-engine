"""
Seed Thermeon car rental prospects.

Usage:
    cd backend
    python seed_car_rental.py

Idempotent — checks by email before inserting.
"""
import sys
import os
import csv
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("PYTHONPATH", str(Path(__file__).parent))

from app.database import engine, SessionLocal, Base
import app.models  # noqa

from app.models.prospect import Prospect

Base.metadata.create_all(bind=engine)


def seed_car_rental_prospects():
    db = SessionLocal()
    try:
        csv_path = Path(__file__).parent / "data" / "car_rental_prospects.csv"
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
                    vertical=row.get("vertical", "car_rental"),
                    icp_score=float(row["icp_score"]) if row.get("icp_score") else None,
                )
                db.add(p)
                imported += 1

        db.commit()
        print(f"Car rental prospects: {imported} imported, {skipped} skipped.")
        return imported
    finally:
        db.close()


if __name__ == "__main__":
    print("=== Thermeon Car Rental Prospect Seeder ===")
    seed_car_rental_prospects()
    print("Done.")
