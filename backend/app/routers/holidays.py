from fastapi import APIRouter
from app.services.holiday_service import holiday_service

router = APIRouter()


@router.get("/holidays/{country_code}/{year}")
async def get_holidays(country_code: str, year: int):
    holidays = await holiday_service.get_holidays(country_code.upper(), year)
    return {"country_code": country_code.upper(), "year": year, "holidays": [str(d) for d in holidays]}
