# Apollo.io — B2B company + person enrichment

## Capability

`Capability.COMPANY_ENRICHMENT`, `Capability.PERSON_ENRICHMENT`.

## Provider class

`ApolloProvider` in [`backend/app/integrations/apollo.py`](../../backend/app/integrations/apollo.py).

```python
class ApolloProvider(BaseProvider):
    name = "apollo"
    capabilities = frozenset({
        Capability.COMPANY_ENRICHMENT,
        Capability.PERSON_ENRICHMENT,
    })
    def is_configured(self) -> bool: ...   # checks settings.apollo_api_key
    async def enrich_company(self, *, domain: str | None = None,
                              name: str | None = None) -> dict: ...
    async def enrich_person(self, *, email: str | None = None,
                             linkedin_url: str | None = None) -> dict: ...
```

Currently a stub — HTTP shape is sketched but raises `NotConfigured` until `APOLLO_API_KEY` is set.

## Hook points

- **Discovery enrich** ([`backend/app/agents/discovery.py:_enrich_candidate`](../../backend/app/agents/discovery.py)) — after Tavily snippets are gathered and *before* Claude enrich runs, call `apollo.enrich_company(domain=candidate.guessed_website)`. Merge Apollo's structured fields (employee count, industry tags, headquarters, key people) into the snippet text Claude reads, OR pass them as a separate `apollo_facts` field in the candidate dict and amend `ENRICH_SYSTEM_TEMPLATE` to read them.
- **Provenance** — when an Apollo-derived value lands on a Prospect, tag the relevant `provenance.{field}` as `"apollo"` (extend the enum from `{snippet, training, user, unknown}` to include `apollo`). Frontend's `ProvenanceBadge` should treat `apollo` as verified-but-distinct (different icon / color).

## Env config

- `APOLLO_API_KEY` — already in `backend/app/config.py`. Stays optional; `is_configured()` returns `False` when unset.

## Data model changes

None required for company-level enrichment. For person-level enrichment, consider:

- `prospects.linkedin_url` (new column) — populated by Apollo person match. Idempotent ALTER block in `main.py:on_startup`:
  ```python
  if "linkedin_url" not in prospect_cols:
      conn.execute(text("ALTER TABLE prospects ADD COLUMN linkedin_url VARCHAR(300)"))
  ```

## Failure modes

- 4xx (rate-limit, plan limits): adapter raises `ProviderError`. Caller (`_enrich_candidate`) catches and proceeds without Apollo data — the existing fallback path takes over.
- Missing required arg (no `domain` AND no `name`): `ValueError`. Caller is responsible for not invoking with empty inputs.
- Endpoint changes / API drift: covered by Apollo's stable v1 API. If they version-bump, adapter needs the URL update — single point of change.

## Verification

```bash
# Stub state (no key configured)
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.name=="apollo")'
# Expected: { "configured": false, ... }

# After setting APOLLO_API_KEY in .env
# Re-check status; configured should flip to true.
# Run a discovery; confirm Apollo data appears in research_profile.enrichment_notes.
```

## Wiring checklist

1. Discovery's `_enrich_candidate` checks `registry.by_capability(Capability.COMPANY_ENRICHMENT, configured_only=True)` before the Tavily-snippets-only enrich.
2. If a configured provider exists, call it: `apollo_facts = await provider.enrich_company(domain=...)`.
3. Add `apollo_facts` to the candidate dict; update the enrich prompt to use it as a high-confidence input.
4. Set `provenance.<field> = "apollo"` for every field Apollo claimed.
5. Test against a stable demo prospect with a known Apollo record; diff `research_profile.icp_reasoning` before / after to confirm Apollo data shifts the score predictably.
