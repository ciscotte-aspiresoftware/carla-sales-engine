"""
Apollo.io adapter — B2B company and person enrichment + people search.

Drop APOLLO_API_KEY into .env (or set it via the Settings UI) and the methods
become live. People search uses a 4-tier title-seniority fallback so it always
returns the most decision-relevant contact available.
"""
import httpx

from app.integrations.base import BaseProvider, Capability, NotConfigured, ProviderError

APOLLO_API_URL = "https://api.apollo.io/v1"

TITLE_TIERS: list[tuple[int, list[str]]] = [
    (1, ["founder", "owner"]),
    (2, ["ceo", "president"]),
    (3, ["chief executive", "managing director", "managing partner"]),
    (4, ["coo", "cfo", "cro", "chief operating", "chief financial", "chief revenue"]),
    (5, ["vp", "vice president", "director"]),
    (6, ["general manager", "operations manager", "fleet manager", "branch manager"]),
    (7, ["manager"]),
]

SENIORITY_FILTER = ["owner", "founder", "c_suite", "vp", "director"]


def _tier(title: str) -> int:
    t = (title or "").lower()
    for tier, keywords in TITLE_TIERS:
        if any(k in t for k in keywords):
            return tier
    return 99


def _api_key() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("apollo_api_key")


class ApolloProvider(BaseProvider):
    name = "apollo"
    capabilities = frozenset({
        Capability.COMPANY_ENRICHMENT,
        Capability.PERSON_ENRICHMENT,
        Capability.PERSON_SEARCH,
    })

    def is_configured(self) -> bool:
        return bool(_api_key())

    async def search_people(
        self,
        *,
        domain: str | None = None,
        org_name: str | None = None,
        limit: int = 3,
    ) -> list[dict]:
        """Return up to `limit` decision-makers at the given domain/org.

        Uses a 4-tier fallback strategy:
          1. Domain + title keywords (founder/owner/ceo/director/GM)
          2. Domain + seniority filter
          3. Domain only (any contact)
          4. Org name search (when domain returns nothing)
        Results are ranked by title tier then email availability.
        """
        key = _api_key()
        if not key:
            raise NotConfigured("Apollo API key is not set (check Settings or APOLLO_API_KEY env var)")
        if not (domain or org_name):
            raise ValueError("search_people requires domain or org_name")

        strategies: list[dict] = []
        if domain:
            strategies += [
                {"q_organization_domains": [domain], "person_titles": ["founder", "owner", "ceo", "president", "managing director", "general manager", "director", "operations manager"]},
                {"q_organization_domains": [domain], "person_seniorities": SENIORITY_FILTER},
                {"q_organization_domains": [domain]},
            ]
        if org_name:
            strategies.append({"q_keywords": org_name})

        seen_ids: set[str] = set()
        candidates: list[dict] = []

        async with httpx.AsyncClient(timeout=20.0) as client:
            for payload in strategies:
                if len(candidates) >= limit * 3:
                    break
                payload = {**payload, "api_key": key, "page": 1, "per_page": 10}
                try:
                    resp = await client.post(f"{APOLLO_API_URL}/mixed_people/search", json=payload)
                    if resp.status_code in (401, 402, 429):
                        break
                    resp.raise_for_status()
                    data = resp.json()
                except httpx.HTTPError as e:
                    raise ProviderError(f"Apollo people search failed: {e}") from e

                for person in data.get("people") or []:
                    pid = person.get("id") or ""
                    if pid and pid in seen_ids:
                        continue
                    if pid:
                        seen_ids.add(pid)
                    candidates.append(person)

        # Rank: tier asc (lower = better), then email > linkedin > nothing
        def _rank(p: dict) -> tuple[int, int]:
            tier = _tier(p.get("title") or "")
            has_email = 0 if p.get("email") else 1
            return (tier, has_email)

        candidates.sort(key=_rank)

        results = []
        for p in candidates[:limit]:
            results.append({
                "full_name": " ".join(filter(None, [p.get("first_name"), p.get("last_name")])),
                "role": p.get("title"),
                "email": p.get("email"),
                "linkedin_url": p.get("linkedin_url"),
                "apollo_id": p.get("id"),
                "tier": _tier(p.get("title") or ""),
            })
        return results

    async def enrich_company(self, *, domain: str | None = None, name: str | None = None) -> dict:
        key = _api_key()
        if not key:
            raise NotConfigured("Apollo API key is not set (check Settings or APOLLO_API_KEY env var)")
        if not (domain or name):
            raise ValueError("enrich_company requires domain or name")

        params: dict[str, str] = {"api_key": key}
        if domain:
            params["domain"] = domain
        if name:
            params["organization_name"] = name

        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                resp = await client.get(f"{APOLLO_API_URL}/organizations/enrich", params=params)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Apollo company enrichment failed: {e}") from e
            return resp.json()

    async def enrich_person(self, *, email: str | None = None, linkedin_url: str | None = None) -> dict:
        key = _api_key()
        if not key:
            raise NotConfigured("Apollo API key is not set (check Settings or APOLLO_API_KEY env var)")
        if not (email or linkedin_url):
            raise ValueError("enrich_person requires email or linkedin_url")

        payload: dict[str, str] = {"api_key": key}
        if email:
            payload["email"] = email
        if linkedin_url:
            payload["linkedin_url"] = linkedin_url

        async with httpx.AsyncClient(timeout=20.0) as client:
            try:
                resp = await client.post(f"{APOLLO_API_URL}/people/match", json=payload)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                raise ProviderError(f"Apollo person enrichment failed: {e}") from e
            return resp.json()
