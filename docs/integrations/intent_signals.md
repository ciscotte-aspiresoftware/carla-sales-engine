# Intent Signals — Buying-signal feeds for the researcher

## Capability

`Capability.INTENT_SIGNAL` — added in the Roadmap Phase 1 capability scaffolding.

A configured `INTENT_SIGNAL` provider returns "what's happening at this prospect right now" signals — the researcher consumes them as additional context when building the personalisation profile, so generated outreach references the freshest hook available rather than only static firmographics.

## Provider class

`IntentSignalProvider` stub in [`backend/app/integrations/intent_signals.py`](../../backend/app/integrations/intent_signals.py).

```python
class IntentSignalProvider(BaseProvider):
    name = "intent_signals"
    capabilities = frozenset({Capability.INTENT_SIGNAL})
    def is_configured(self) -> bool: ...   # checks intent_signal_provider_key
    async def signals_for(
        self, *, business_name: str, website_url: str | None = None,
    ) -> list[dict]: ...
```

`signals_for(...)` should return a list of dicts with the shape:

```json
{
  "kind": "job_posting" | "funding" | "news" | "intent_topic" | "review",
  "summary": "Hired a Director of Operations 14 days ago",
  "url": "https://...",
  "observed_at": "2026-04-25T12:00:00Z",
  "confidence": 0.9
}
```

The engine doesn't care which transport you use — Greenhouse / Lever public job boards, Crunchbase funding feed, news API (Diffbot, GDELT), Bombora intent topics, G2 review velocity, SimilarWeb traffic spikes. All collapse to the same envelope.

## Hook points

- **`backend/app/agents/researcher.py`** — before composing the research prompt, check for a configured `INTENT_SIGNAL` provider. If present, call `signals_for(business_name=prospect.business_name, website_url=prospect.website_url)` and inject the top 3 signals (sorted by `observed_at` desc, then `confidence` desc) into the prompt as "Recent signals:" bullet points. Researcher's `pain_hypothesis` and `hook_line` already accept arbitrary context.
- **Optional, future** — same hook in the discovery enrich step so newly-found prospects get a first-pass signal scan before scoring.

## Env config

- `INTENT_SIGNAL_PROVIDER_KEY` — already registered in `app_settings_service.SETTING_DEFS`. Vendor-specific (Bombora token, Crunchbase key, etc.). Configure via the Settings UI or `.env`.

## Data model changes

None required for the wired-in case (signals are injected at prompt time and not persisted). When a portfolio team wants persistent signal history, add:

```sql
CREATE TABLE prospect_signals (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER REFERENCES prospects(id),
  kind VARCHAR(50),
  summary TEXT,
  url VARCHAR(500),
  observed_at DATETIME,
  confidence FLOAT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

…and an idempotent `CREATE TABLE IF NOT EXISTS` block in `main.py:on_startup`. The activity timeline can then surface a row per signal as a distinct event_type.

## Failure modes

- Provider 4xx: drop signals silently, researcher continues without them.
- Provider 5xx / timeout: same — log and continue.
- Signal recency: providers vary widely. Filter `observed_at` older than 90 days at injection time so stale signals don't become noisy hooks.

## Verification

```bash
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.name=="intent_signals")'
# Expected before configuring: { "configured": false }

# After setting the API key:
# curl -X POST .../app-settings -d '{"key":"intent_signal_provider_key","value":"..."}'
# Researcher prompts will include a "Recent signals:" section when run.
```

## Wiring checklist

1. Implement `signals_for(...)` for your chosen vendor — return the dict shape above. Filter to last 90 days, top 5 by confidence.
2. Add a `_intent_signal_context(prospect)` helper in `researcher.py` that calls `registry.by_capability(Capability.INTENT_SIGNAL, configured_only=True)` and renders the top 3 as bullet points.
3. Inject the rendered string into the researcher prompt under the existing `personalization_notes` block.
4. Update the researcher tests to assert the prompt includes signal bullets when the registry has a configured provider.
5. (Optional) persist signals into `prospect_signals` and surface a small "Recent signals" card on the Prospect detail page.

## Why this is just a stub

The portfolio receiving this engine likely already has signal infrastructure (Bombora seat, internal news feed, etc.). Wiring a specific vendor here would force them to rip it out and replace. The capability + provider pattern lets them drop in their own implementation without touching engine code — same shape as Tavily/Apollo/Firecrawl.
