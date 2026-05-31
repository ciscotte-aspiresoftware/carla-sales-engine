# Salesforce — Bidirectional CRM sync

## Status: Designed, not yet wired

The engine has zero CRM integration today. Activity events (sent, opened, clicked, replied) are stored locally in `activity_events`. Prospects, campaigns, and sequences live only in the engine's SQLite. Nothing flows out to Salesforce, HubSpot, or any other CRM.

## Capability (new)

Two capabilities, because they have different write patterns:

```python
class Capability(str, Enum):
    ...
    CRM_LEAD_PUSH = "crm_lead_push"        # upsert a Lead/Contact when a Prospect is scored
    CRM_ACTIVITY_LOG = "crm_activity_log"  # mirror engine activity events to CRM Activity records
```

Splitting them lets a portfolio plug in `CRM_LEAD_PUSH` without `CRM_ACTIVITY_LOG`, or use one CRM for leads and another for activity (rare but valid).

## Provider class outline

```python
# backend/app/integrations/salesforce.py
class SalesforceProvider(BaseProvider):
    name = "salesforce"
    capabilities = frozenset({Capability.CRM_LEAD_PUSH, Capability.CRM_ACTIVITY_LOG})

    def is_configured(self) -> bool:
        # Salesforce uses OAuth2 with refresh tokens. We don't store the
        # access_token in env vars — it's per-tenant. Look up the tenant's
        # row in `crm_credentials` (new table — see Data model below).
        return self._has_active_credentials()

    async def upsert_lead(self, prospect: dict) -> dict:
        """Upsert a Salesforce Lead/Contact keyed by prospect.email.
        Returns {sf_id, sf_record_type: 'Lead'|'Contact', synced_at}."""

    async def log_activity(self, event: dict) -> dict:
        """Create a Task on the matching Lead/Contact representing the event
        (sent / opened / clicked / replied / meeting_booked).
        Returns {sf_task_id, synced_at}."""
```

## Hook points

### Lead push (after ICP scoring)

In [`backend/app/agents/pipeline.py`](../../backend/app/agents/pipeline.py), after the prospector commits ICP scores, fire-and-forget a CRM upsert per prospect that crossed the threshold:

```python
# After: db.commit() of icp_scores in run_campaign_pipeline
crm_providers = registry.by_capability(Capability.CRM_LEAD_PUSH, configured_only=True)
for provider in crm_providers:
    for p in prospects:
        if (p.icp_score or 0) >= ICP_PUSH_THRESHOLD:
            background_tasks.add_task(provider.upsert_lead, prospect_to_dict(p))
```

(Pass `BackgroundTasks` into the pipeline if it doesn't already have one — or use a separate task queue. Don't block the pipeline on CRM availability.)

### Activity log mirroring

`backend/app/services/activity_service.py` is the natural choke point. Every `ActivityEvent` insertion goes through here. Add a post-commit hook:

```python
def log_event(self, db, **kwargs) -> ActivityEvent:
    event = ActivityEvent(**kwargs)
    db.add(event)
    db.commit()
    db.refresh(event)
    # Mirror to CRM in the background
    crm_providers = registry.by_capability(Capability.CRM_ACTIVITY_LOG, configured_only=True)
    for provider in crm_providers:
        background_tasks.add_task(provider.log_activity, event_to_dict(event))
    return event
```

Today, ActivityEvent rows are inserted in many places (pipeline.py, classifier.py, simulation seeds). Centralising through `ActivityService.log_event` is the prerequisite — without it, you'd have to hook every insertion site.

### Inbound webhook (CRM → engine)

Salesforce sends webhooks for status changes (Lead → Contact, Lead → Opportunity, manual disposition by an SDR). New router:

```python
# backend/app/routers/salesforce_webhook.py
@router.post("/integrations/salesforce/webhook")
async def salesforce_webhook(payload: dict, x_signature: str = Header(...)):
    if not _verify_sf_signature(payload, x_signature, settings.salesforce_webhook_secret):
        raise HTTPException(401, "Invalid signature")
    # Map sf_id → prospect.id via crm_external_links table (see Data model)
    # Apply status changes (e.g. mark prospect as `disposition="converted"` or "disqualified")
```

## Auth: OAuth2 with refresh tokens (NOT plain env keys)

Salesforce is multi-tenant in spirit; receiving portfolios will connect their own SF org. Plain env keys won't work. Approach:

1. **Connect flow**: New `/integrations/salesforce/connect` endpoint redirects to SF OAuth consent screen with `client_id` from env.
2. **Callback**: `/integrations/salesforce/callback?code=...` exchanges the code for `access_token` + `refresh_token` and stores them encrypted in a new `crm_credentials` table (see below).
3. **Runtime**: Adapter pulls the active credential, refreshes if expired, makes the API call.

If you want to keep things simple for the demo, you *can* use a single SF org's `username + security_token` flow with env vars — see [SimpleSalesforce](https://github.com/simple-salesforce/simple-salesforce) — but for a portfolio handoff, OAuth is the right path.

## Env config additions

```bash
SALESFORCE_CLIENT_ID=...
SALESFORCE_CLIENT_SECRET=...
SALESFORCE_REDIRECT_URI=http://localhost:8000/api/v1/integrations/salesforce/callback
SALESFORCE_API_VERSION=v60.0
SALESFORCE_WEBHOOK_SECRET=...
# Demo-shortcut alternative (single-org, no OAuth):
# SALESFORCE_USERNAME=...
# SALESFORCE_PASSWORD=...
# SALESFORCE_SECURITY_TOKEN=...
# SALESFORCE_INSTANCE_URL=https://yourorg.my.salesforce.com
```

## Data model changes

Two new tables:

```python
# backend/app/models/crm_credentials.py
class CRMCredential(Base):
    __tablename__ = "crm_credentials"
    id = Column(Integer, primary_key=True)
    provider = Column(String(50), nullable=False)        # "salesforce" | "hubspot" | etc.
    instance_url = Column(String(300), nullable=False)
    encrypted_access_token = Column(Text, nullable=False)
    encrypted_refresh_token = Column(Text, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

# backend/app/models/crm_external_link.py
class CRMExternalLink(Base):
    __tablename__ = "crm_external_links"
    id = Column(Integer, primary_key=True)
    prospect_id = Column(Integer, ForeignKey("prospects.id"), nullable=False, index=True)
    provider = Column(String(50), nullable=False)
    external_id = Column(String(100), nullable=False)    # SF Lead/Contact id
    external_type = Column(String(50), nullable=False)   # "Lead" | "Contact"
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    last_status = Column(String(50), nullable=True)      # last known SF status
```

Encryption: use a server-side key (`CRM_ENCRYPTION_KEY`) with `cryptography.fernet`. Don't store tokens plain.

## Failure modes

| Scenario | Behaviour |
|---|---|
| No SF credential configured | `is_configured()` returns False; lead push / activity log skipped silently |
| SF auth expired, refresh fails | `is_configured()` flips to False on next check; queue background re-auth, alert admin |
| 4xx from SF (validation rule, missing field) | log error, mark `crm_external_links.last_status = "sync_failed"`; surface in admin UI |
| 5xx / network blip | retry with backoff; after 3 fails, queue for later |
| Sync race (two pipelines push the same Lead) | dedupe on email; SF upsert is idempotent if you key by external_id |

## Verification

```bash
# Confirm provider is configured (after OAuth connect or password flow):
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.name=="salesforce")'

# Run a campaign pipeline end-to-end. Verify:
#  - crm_external_links row created per scored prospect
#  - SF org has matching Lead/Contact records
#  - Activity log on each Lead shows the engine's "sent" / "opened" / "replied" events
#  - Webhook from SF (manual stage change) lands and updates prospect.disposition
```

## Wiring checklist

- [ ] Add `CRM_LEAD_PUSH` and `CRM_ACTIVITY_LOG` to `Capability` enum
- [ ] Create `app/integrations/salesforce.py` with provider class
- [ ] Add `crm_credentials` and `crm_external_links` tables (model + idempotent CREATE in `main.py:on_startup`)
- [ ] Add OAuth connect / callback router at `/integrations/salesforce/{connect,callback}`
- [ ] Add webhook receiver at `/integrations/salesforce/webhook` with signature verification
- [ ] Centralize ActivityEvent insertion through `ActivityService.log_event` (refactor existing call sites)
- [ ] Wire CRM upsert hook into `pipeline.run_campaign_pipeline` after ICP scoring
- [ ] Add `CRM_ENCRYPTION_KEY` to env config; install `cryptography`
- [ ] Update README with the OAuth setup instructions
- [ ] (Stretch) Frontend "Connect Salesforce" button + status indicator on Costs / Settings page

## Alternative: HubSpot

Same shape, different SDK. Create `app/integrations/hubspot.py` with `HubSpotProvider` declaring `Capability.CRM_LEAD_PUSH` and `Capability.CRM_ACTIVITY_LOG`. The hook points (`pipeline.run_campaign_pipeline`, `ActivityService.log_event`) loop over **all** providers in those capabilities, so a portfolio that uses both SF + HubSpot mirrors to both. No engine code change.
