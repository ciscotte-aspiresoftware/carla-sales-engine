# Inbound — Reply ingestion + classifier wiring

## Status: Designed, not yet wired

The classifier agent exists ([`backend/app/agents/classifier.py`](../../backend/app/agents/classifier.py)) and works — given reply text, it returns `{intent: "interested" | "not_now" | "ooo" | "unsubscribe" | ...}`. But nothing currently *feeds* it. The endpoint expects a manual HTTP POST with raw reply text. There's no IMAP poll, no Gmail watch, no SendGrid Inbound Parse.

## Capability (new)

```python
class Capability(str, Enum):
    ...
    INBOUND_PARSE = "inbound_parse"
```

## Provider class outline

Multiple implementations depending on how the receiving portfolio handles inbound mail:

```python
# backend/app/integrations/sendgrid_inbound.py
class SendGridInboundProvider(BaseProvider):
    """SendGrid Inbound Parse: SendGrid receives mail at a subdomain you own
    and POSTs each message as multipart/form-data to a webhook you specify.
    No polling — push only."""
    name = "sendgrid_inbound"
    capabilities = frozenset({Capability.INBOUND_PARSE})
    def is_configured(self) -> bool:
        return bool(settings.sendgrid_inbound_secret)
    # No `run` method — this provider is purely declarative; the hook is
    # the inbound webhook router below.

# backend/app/integrations/gmail_inbound.py
class GmailInboundProvider(BaseProvider):
    """Gmail API watch + Pub/Sub. More complex setup but works for any
    Google Workspace inbox."""
    name = "gmail_inbound"
    capabilities = frozenset({Capability.INBOUND_PARSE})
    def is_configured(self) -> bool: ...
    async def poll_once(self) -> list[dict]:
        """Returns a list of new messages since the last cursor. Idempotent —
        the cursor is stored in inbound_state."""

# backend/app/integrations/imap_inbound.py
class IMAPInboundProvider(BaseProvider):
    """Plain IMAP poll for any mailbox. Slowest but works everywhere."""
    name = "imap_inbound"
    capabilities = frozenset({Capability.INBOUND_PARSE})
    def is_configured(self) -> bool: ...
    async def poll_once(self) -> list[dict]: ...
```

Each yields a list of messages with the same shape:

```python
{
    "from": "ops@operator.com",
    "subject": "Re: Your message",
    "body_text": "...",
    "body_html": "...",
    "in_reply_to_message_id": "<seq-123@your-domain.com>",  # if available
    "received_at": "2026-05-09T...",
}
```

## Hook points

### Webhook path (SendGrid Inbound Parse, push)

New router `backend/app/routers/inbound_webhook.py`:

```python
@router.post("/integrations/inbound/sendgrid")
async def sendgrid_inbound(
    request: Request,
    db: Session = Depends(get_db),
):
    # Verify HMAC signature (SendGrid sends X-SendGrid-Inbound-Signature)
    body = await request.body()
    if not _verify_inbound_signature(body, request.headers, settings.sendgrid_inbound_secret):
        raise HTTPException(401, "Invalid signature")
    form = await request.form()
    msg = _parse_inbound_form(form)
    await _ingest_reply(db, msg)
    return {"received": True}
```

### Polling path (Gmail / IMAP)

A background job — either a separate `worker` service or a FastAPI startup task:

```python
@app.on_event("startup")
async def start_inbound_pollers():
    from app.integrations import registry, Capability
    pollers = [p for p in registry.by_capability(Capability.INBOUND_PARSE, configured_only=True)
               if hasattr(p, 'poll_once')]
    if pollers:
        asyncio.create_task(_inbound_poll_loop(pollers))

async def _inbound_poll_loop(pollers):
    while True:
        for poller in pollers:
            try:
                msgs = await poller.poll_once()
                db = SessionLocal()
                try:
                    for m in msgs: await _ingest_reply(db, m)
                finally:
                    db.close()
            except Exception as e:
                # log, don't crash the loop
                pass
        await asyncio.sleep(60)  # poll every minute
```

### Shared ingestion helper

```python
# backend/app/services/inbound_service.py
async def _ingest_reply(db: Session, msg: dict) -> None:
    # 1. Match the reply to a sequence using in_reply_to_message_id (preferred)
    #    or by sender email + subject heuristic.
    seq = _match_sequence(db, msg)
    if not seq:
        # Unmatched reply — log to a dead-letter table for human review
        db.add(UnmatchedReply(**msg))
        db.commit()
        return

    # 2. Run the classifier
    from app.agents.classifier import classifier_agent
    result = await classifier_agent.classify(msg["body_text"], seq.id, db)

    # 3. Record activity event
    from app.services.activity_service import activity_service
    activity_service.log_event(
        db,
        email_sequence_id=seq.id,
        campaign_id=seq.campaign_id,
        prospect_id=seq.prospect_id,
        event_type="reply",
        event_data={
            "intent": result["intent"],
            "confidence": result.get("confidence"),
            "from": msg["from"],
            "received_at": msg["received_at"],
            "preview": msg["body_text"][:200],
        },
        is_simulated=False,
    )
```

## Env config additions

```bash
# SendGrid Inbound Parse
SENDGRID_INBOUND_SECRET=...
SENDGRID_INBOUND_DOMAIN=reply.your-domain.com   # the subdomain SG receives mail at

# Gmail
GMAIL_SERVICE_ACCOUNT_JSON_PATH=...   # service account JSON for the inbox
GMAIL_INBOX_ADDRESS=outreach@your-domain.com

# IMAP fallback
IMAP_HOST=...
IMAP_PORT=993
IMAP_USERNAME=...
IMAP_PASSWORD=...
IMAP_FOLDER=INBOX
```

## Data model changes

```python
# backend/app/models/unmatched_reply.py
class UnmatchedReply(Base):
    __tablename__ = "unmatched_replies"
    id = Column(Integer, primary_key=True)
    received_at = Column(DateTime(timezone=True), server_default=func.now())
    from_address = Column(String(300), nullable=False)
    subject = Column(String(500))
    body_text = Column(Text)
    body_html = Column(Text)
    raw_headers = Column(JSON)
    matched_sequence_id = Column(Integer, nullable=True)  # populated if a human matches it later

# backend/app/models/inbound_state.py
class InboundState(Base):
    """Per-provider cursor for polling. Stops polling from re-processing
    the same messages on restart."""
    __tablename__ = "inbound_state"
    provider = Column(String(50), primary_key=True)
    cursor = Column(String(500), nullable=False)  # provider-specific (history_id for Gmail, UID for IMAP)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
```

## Reply matching heuristic

Threading is the hard part. Pure email threading is unreliable; users hit "Reply" inconsistently and clients mangle headers. Use a 3-tier match:

1. **`In-Reply-To` header** — if the original outbound included a `Message-Id` like `<seq-123@your-domain.com>`, this is bullet-proof. Set the Message-Id at send time (SendGrid supports custom headers).
2. **`from_address` + recent sequence** — if the sender matches a `prospect.email` AND there's a sequence sent to them in the last N days, link.
3. **`subject` match (fuzzy)** — last resort. Strip "Re:" prefixes and compare against recent subjects.

Anything that fails all three goes to `unmatched_replies` for human review.

## Failure modes

| Scenario | Behaviour |
|---|---|
| No inbound provider configured | Replies don't get ingested. Existing manual `/agents/classify-reply` endpoint still works for testing. |
| Webhook signature invalid | 401 returned; SendGrid retries per their policy. Repeated failures = misconfiguration. |
| Polling provider crashes mid-loop | The `try/except` swallows; the next 60s tick continues. Log to console for now; route to error tracker in production. |
| Reply matches multiple sequences (same sender, multiple campaigns) | Pick the most recently sent. Log the conflict. |
| Cursor lost on Gmail (history_id expired) | Fall back to a full mailbox scan once, save new cursor. |

## Verification

```bash
# Manual test (works today, no integration needed):
curl -X POST 'http://127.0.0.1:8000/api/v1/agents/classify-reply?reply_text=Sure,%20happy%20to%20chat&sequence_id=1'
# Expected: {"intent": "interested", ...}

# After SendGrid Inbound wired:
# 1. Configure SG to forward reply.your-domain.com → /api/v1/integrations/inbound/sendgrid
# 2. Send a test reply from a real inbox to a sequence's reply-to address
# 3. Verify: ActivityEvent row for the sequence with event_type="reply"
# 4. Verify: classifier output appears in event_data.intent
```

## Wiring checklist

- [ ] Add `INBOUND_PARSE` to `Capability` enum
- [ ] Pick at least one provider (SendGrid Inbound Parse is the simplest for a managed-domain setup)
- [ ] Create the provider in `app/integrations/<name>.py`
- [ ] Add the inbound webhook router (or polling startup task) to `main.py`
- [ ] Add `unmatched_replies` and `inbound_state` tables (model + idempotent CREATE)
- [ ] Centralize reply ingestion through `inbound_service._ingest_reply`
- [ ] At outbound send time (SendGrid hook in [sendgrid.md](sendgrid.md)), set a stable `Message-Id` header so threading works
- [ ] Frontend: surface `unmatched_replies` count in the Activity feed for human triage
