"""
HubSpot CRM adapter — push prospects (as Companies) and contacts to HubSpot.

Requires a Private App access token (not OAuth).
Set HUBSPOT_ACCESS_TOKEN in .env or via the Settings UI.

Flow:
  1. push_company(prospect)        → creates/updates Company, returns hubspot_company_id
  2. push_contact(contact, cid)    → creates/updates Contact, returns hubspot_contact_id
  3. associate(contact_id, cid)    → links Contact → Company in HubSpot

Custom properties used (create them once in HubSpot Settings → Properties):
  - car_fleet_size  (number)
  - icp_score       (number, 0–1)
  - sdr_vertical    (single-line text)
  - sdr_source      (single-line text)
"""
import httpx

from app.integrations.base import BaseProvider, Capability, NotConfigured, ProviderError

HUBSPOT_API = "https://api.hubapi.com"


def _token() -> str | None:
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("hubspot_access_token")


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
    }


class HubSpotProvider(BaseProvider):
    name = "hubspot"
    capabilities = frozenset({
        Capability.COMPANY_SYNC,
        Capability.CONTACT_SYNC,
        Capability.CRM_SYNC,
    })

    def is_configured(self) -> bool:
        return bool(_token())

    async def get_portal_id(self) -> str | None:
        """Return the HubSpot portal ID (hub_id) for link construction."""
        token = _token()
        if not token:
            return None
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{HUBSPOT_API}/oauth/v1/access-tokens/{token}",
                    headers=_headers(),
                )
                if resp.status_code == 200:
                    return str(resp.json().get("hub_id", ""))
        except httpx.HTTPError:
            pass
        return None

    async def push_company(self, prospect) -> dict:
        """Upsert a Company record in HubSpot from a Prospect ORM object.

        Returns {"id": hubspot_company_id, "url": hubspot_app_url}.
        """
        token = _token()
        if not token:
            raise NotConfigured("HUBSPOT_ACCESS_TOKEN is not set")

        from urllib.parse import urlparse
        domain = ""
        if prospect.website_url:
            parsed = urlparse(prospect.website_url)
            domain = parsed.netloc.lstrip("www.") or parsed.path.lstrip("www.")

        properties = {
            "name": prospect.business_name,
            "city": prospect.city or "",
            "state": prospect.state or "",
            "country": prospect.country_code or "",
            "website": prospect.website_url or "",
            "domain": domain,
            "sdr_vertical": prospect.vertical or "",
            "sdr_source": "carla_sdr_engine",
        }
        if prospect.icp_score is not None:
            properties["icp_score"] = round(prospect.icp_score, 3)
        if prospect.capacity_count is not None:
            properties["car_fleet_size"] = prospect.capacity_count

        payload = {"properties": properties}

        async with httpx.AsyncClient(timeout=20.0) as client:
            # Try upsert by domain first (avoids duplicates)
            if domain:
                search_resp = await client.post(
                    f"{HUBSPOT_API}/crm/v3/objects/companies/search",
                    headers=_headers(),
                    json={"filterGroups": [{"filters": [{"propertyName": "domain", "operator": "EQ", "value": domain}]}], "limit": 1},
                )
                if search_resp.status_code == 200:
                    results = search_resp.json().get("results") or []
                    if results:
                        existing_id = results[0]["id"]
                        patch = await client.patch(
                            f"{HUBSPOT_API}/crm/v3/objects/companies/{existing_id}",
                            headers=_headers(),
                            json=payload,
                        )
                        if patch.status_code not in (200, 201):
                            raise ProviderError(f"HubSpot company update failed: {patch.status_code} {patch.text}")
                        return await self._company_result(existing_id)

            # Create new
            resp = await client.post(
                f"{HUBSPOT_API}/crm/v3/objects/companies",
                headers=_headers(),
                json=payload,
            )
            if resp.status_code not in (200, 201):
                raise ProviderError(f"HubSpot company create failed: {resp.status_code} {resp.text}")
            company_id = resp.json()["id"]
            return await self._company_result(company_id)

    async def push_contact(self, contact, hubspot_company_id: str) -> dict:
        """Upsert a Contact record and associate it with the given Company.

        `contact` is a ProspectContact ORM object.
        Returns {"id": hubspot_contact_id}.
        """
        token = _token()
        if not token:
            raise NotConfigured("HUBSPOT_ACCESS_TOKEN is not set")

        name_parts = (contact.full_name or "").split(" ", 1)
        properties = {
            "firstname": name_parts[0],
            "lastname": name_parts[1] if len(name_parts) > 1 else "",
            "jobtitle": contact.role or "",
            "email": contact.email or "",
            "hs_linkedin_url": contact.linkedin_url or "",
        }

        payload = {"properties": {k: v for k, v in properties.items() if v}}

        async with httpx.AsyncClient(timeout=20.0) as client:
            if contact.email:
                search_resp = await client.post(
                    f"{HUBSPOT_API}/crm/v3/objects/contacts/search",
                    headers=_headers(),
                    json={"filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": contact.email}]}], "limit": 1},
                )
                if search_resp.status_code == 200:
                    results = search_resp.json().get("results") or []
                    if results:
                        existing_id = results[0]["id"]
                        await client.patch(
                            f"{HUBSPOT_API}/crm/v3/objects/contacts/{existing_id}",
                            headers=_headers(),
                            json=payload,
                        )
                        await self._associate(client, existing_id, hubspot_company_id)
                        return {"id": existing_id}

            resp = await client.post(
                f"{HUBSPOT_API}/crm/v3/objects/contacts",
                headers=_headers(),
                json=payload,
            )
            if resp.status_code not in (200, 201):
                raise ProviderError(f"HubSpot contact create failed: {resp.status_code} {resp.text}")
            contact_id = resp.json()["id"]
            await self._associate(client, contact_id, hubspot_company_id)
            return {"id": contact_id}

    async def _associate(self, client: httpx.AsyncClient, contact_id: str, company_id: str) -> None:
        await client.put(
            f"{HUBSPOT_API}/crm/v4/objects/contacts/{contact_id}/associations/companies/{company_id}",
            headers=_headers(),
            json=[{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 1}],
        )

    async def _company_result(self, company_id: str) -> dict:
        portal_id = await self.get_portal_id()
        url = (
            f"https://app.hubspot.com/contacts/{portal_id}/company/{company_id}"
            if portal_id
            else f"https://app.hubspot.com/contacts/0/company/{company_id}"
        )
        return {"id": company_id, "url": url}
