import httpx
from datetime import date, timedelta
from typing import Optional


class HolidayService:
    NAGER_BASE = "https://date.nager.at/api/v3/PublicHolidays"
    _cache: dict[str, list[date]] = {}

    async def get_holidays(self, country_code: str, year: int) -> list[date]:
        """
        Fetch public holidays from Nager.Date API (free, no API key required).
        Results are cached in-process by {country_code}-{year} key.
        Returns empty list on timeout/error — demo never breaks.
        """
        cache_key = f"{country_code}-{year}"
        if cache_key in self._cache:
            return self._cache[cache_key]
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.NAGER_BASE}/{year}/{country_code}")
                if resp.status_code == 200:
                    holidays = [date.fromisoformat(h["date"]) for h in resp.json()]
                    self._cache[cache_key] = holidays
                    return holidays
        except Exception:
            pass
        self._cache[cache_key] = []
        return []

    def is_send_allowed(
        self,
        target_date: date,
        regional_pack: dict,
        holidays: list[date],
    ) -> tuple[bool, Optional[str]]:
        scheduling = regional_pack.get("scheduling", {})
        no_send_days = scheduling.get("no_send_days_of_week", [5, 6])  # Sat=5, Sun=6 by default
        if target_date.weekday() in no_send_days:
            return False, f"No-send day ({target_date.strftime('%A')})"
        if target_date in holidays:
            return False, "Public holiday"
        return True, None

    async def next_sendable_date(
        self,
        from_date: date,
        country_code: str,
        regional_pack: dict,
    ) -> date:
        """Walk forward from from_date to find the next allowed send date (max 30-day lookahead)."""
        holidays = await self.get_holidays(country_code, from_date.year)
        if from_date.month >= 11:
            next_year_holidays = await self.get_holidays(country_code, from_date.year + 1)
            holidays = holidays + next_year_holidays

        candidate = from_date
        for _ in range(30):
            allowed, _ = self.is_send_allowed(candidate, regional_pack, holidays)
            if allowed:
                return candidate
            candidate += timedelta(days=1)
        return from_date  # fallback

    async def get_holiday_dates_for_prompt(self, country_code: str, year: int) -> list[str]:
        """Returns formatted holiday date strings for LLM prompt injection."""
        holidays = await self.get_holidays(country_code, year)
        return [d.strftime("%Y-%m-%d") for d in holidays]


holiday_service = HolidayService()
