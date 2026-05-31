# SendGrid — Outbound email delivery

## Status: Designed, not yet wired

This doc describes the intended integration. No `SendGridProvider` exists yet. The current `sequence_service.mark_sent` only flips a DB flag; no email is actually sent.

## Capability (new)

Add to [`backend/app/integrations/base.py`](../../backend/app/integrations/base.py):

```python
class Capability(str, Enum):
    WEB_SEARCH = "web_search"
    COMPANY_ENRICHMENT = "company_enrichment"
    PERSON_ENRICHMENT = "person_enrichment"
    URL_SCRAPE = "url_scrape"
    EMAIL_SEND = "email_send"          # NEW
    INBOUND_PARSE = "inbound_parse"    # NEW (see inbound.md)
```

## Provider class outline

```python
# backend/app/integrations/sendgrid.py
class SendGridProvider(BaseProvider):
    name = "sendgrid"
    capabilities = frozenset({Capability.EMAIL_SEND})

    def is_configured(self) -> bool:
        return bool(settings.sendgrid_api_key) and bool(settings.sendgrid_default_from)

    async def send(self, *, to: str, subject: str, html: str,
                   from_address: str | None = None,
                   tracking_id: str | None = None,
                   reply_to: str | None = None) -> dict:
        """Returns {provider_message_id, status: 'queued' | 'sent' | 'rejected'}.
        Raises ProviderError on hard failure."""
```

## Hook points

The whole outbound path is mocked today. Replace the hand-waving with real sends in two places:

### `backend/app/services/sequence_service.py`

Currently `mark_sent` flips `seq.sent_at` and commits. Wrap that with a real send call:

```python
def mark_sent(self, db, seq_id: int) -> Optional[EmailSequenceDetail]:
    seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
    if not seq: return None

    # NEW: dispatch via configured EMAIL_SEND provider before flipping the flag.
    from app.integrations import registry, Capability
    senders = registry.by_capability(Capability.EMAIL_SEND, configured_only=True)
    if senders:
        prospect = db.query(Prospect).filter(Prospect.id == seq.prospect_id).first()
        try:
            result = await senders[0].send(
                to=prospect.email,
                subject=seq.subject,
                html=seq.body,
                tracking_id=f"seq-{seq.id}",
            )
            seq.provider_message_id = result.get("provider_message_id")
            seq.delivery_status = result.get("status", "sent")
        except ProviderError as e:
            seq.delivery_status = "send_failed"
            seq.delivery_error = str(e)[:500]
            # Don't flip sent_at if delivery failed
            db.commit()
            return self._to_schema(seq, db)
    # ELSE: no provider configured → keep existing behaviour (DB-only flag)

    seq.sent_at = datetime.now(timezone.utc)
    db.commit()
    return self._to_schema(seq, db)
```

`mark_sent` becomes async — its callers in [`backend/app/routers/sequences.py`](../../backend/app/routers/sequences.py) will need `await`.

### Bounce / complaint webhook

New router `backend/app/routers/sendgrid_webhook.py`:

```python
@router.post("/integrations/sendgrid/webhook")
async def sendgrid_webhook(payload: list[dict], db: Session = Depends(get_db)):
    # Each event: {event: "bounce"|"open"|"click"|...,
    #              sg_message_id: ..., custom_args: {tracking_id: "seq-123"}}
    for event in payload:
        tracking = event.get("custom_args", {}).get("tracking_id", "")
        if not tracking.startswith("seq-"): continue
        seq_id = int(tracking[4:])
        # Map event -> ActivityEvent type
        etype = {"open": "open", "click": "click", "bounce": "bounce",
                 "unsubscribe": "unsubscribe", "spamreport": "complaint"}.get(event["event"])
        if not etype: continue
        seq = db.query(EmailSequence).filter(EmailSequence.id == seq_id).first()
        if not seq: continue
        db.add(ActivityEvent(
            email_sequence_id=seq.id,
            campaign_id=seq.campaign_id,
            prospect_id=seq.prospect_id,
            event_type=etype,
            event_data={"sendgrid_event": event},
            is_simulated=False,
        ))
    db.commit()
    return {"received": len(payload)}
```

SendGrid signs webhooks with an EC public key — verify the signature in middleware before accepting.

## Env config additions

```bash
SENDGRID_API_KEY=...
SENDGRID_DEFAULT_FROM=outreach@your-domain.com
SENDGRID_WEBHOOK_VERIFICATION_KEY=...   # for inbound webhook signature check
```

Add the same to `backend/app/config.py`:

```python
sendgrid_api_key: Optional[str] = None
sendgrid_default_from: Optional[str] = None
sendgrid_webhook_verification_key: Optional[str] = None
```

## Data model changes

Add columns to `email_sequences` table (idempotent block in `main.py:on_startup`):

```python
if "delivery_status" not in seq_cols:
    conn.execute(text("ALTER TABLE email_sequences ADD COLUMN delivery_status VARCHAR(50)"))
if "provider_message_id" not in seq_cols:
    conn.execute(text("ALTER TABLE email_sequences ADD COLUMN provider_message_id VARCHAR(200)"))
if "delivery_error" not in seq_cols:
    conn.execute(text("ALTER TABLE email_sequences ADD COLUMN delivery_error VARCHAR(500)"))
```

Update `EmailSequence` SQLAlchemy model + `EmailSequenceDetail` Pydantic schema.

## Failure modes

| Scenario | Behaviour |
|---|---|
| No provider configured | `mark_sent` keeps existing DB-only behaviour; `delivery_status` is NULL |
| 4xx from SendGrid (bad address, suppressed) | `delivery_status = "rejected"`, `delivery_error` populated, `sent_at` NOT flipped — UI shows the error and the sequence stays in "pending" |
| 5xx from SendGrid | retry with exponential backoff inside `send()`; after N retries, treat as 4xx |
| Webhook verification fails | 401 to SendGrid; log + alert |
| Bounce after successful send | `delivery_status` doesn't change retroactively but a new `bounce` ActivityEvent fires; UI flags the sequence with a "bounced" chip |

## Verification

```bash
# After wiring + setting SENDGRID_API_KEY:
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.name=="sendgrid")'
# Expected: { "name": "sendgrid", "configured": true, "capabilities": ["email_send"] }

# Approve and send a sequence to a test inbox you control.
# Verify:
#  - Email arrives within ~30s
#  - email_sequences row has provider_message_id populated
#  - sent_at is set
#  - delivery_status = "sent"

# Open / click / bounce events should fire on the SendGrid webhook,
# create ActivityEvent rows, and surface in the activity feed.
```

## Wiring checklist

- [ ] Add `EMAIL_SEND` to `Capability` enum
- [ ] Create `backend/app/integrations/sendgrid.py` with `SendGridProvider`
- [ ] Register in `backend/app/integrations/__init__.py`
- [ ] Add 3 env keys to `app/config.py`
- [ ] Add 3 columns to `email_sequences` (idempotent ALTER block in `main.py:on_startup`)
- [ ] Update `EmailSequence` model + `EmailSequenceDetail` schema
- [ ] Make `sequence_service.mark_sent` async, wire provider call before DB flip
- [ ] Update `routers/sequences.py` to await mark_sent (and `bulk_*` variants too)
- [ ] Create webhook router at `/api/v1/integrations/sendgrid/webhook`
- [ ] Register router in `main.py`
- [ ] Update frontend EmailSequence type + review page to surface `delivery_status`
