# Tavily — Live web search for prospect verification

## Capability

`Capability.WEB_SEARCH` — see [`backend/app/integrations/base.py`](../../backend/app/integrations/base.py).

## Provider class

`TavilyProvider` in [`backend/app/integrations/tavily.py`](../../backend/app/integrations/tavily.py).

```python
class TavilyProvider(BaseProvider):
    name = "tavily"
    capabilities = frozenset({Capability.WEB_SEARCH})
    def is_configured(self) -> bool: ...      # checks settings.tavily_api_key
    async def search(self, query: str, max_results: int = 5) -> list[dict]: ...
```

Returns `[{title, url, content}, ...]` — the same shape every WEB_SEARCH provider must honour.

## Hook points

- [`backend/app/agents/discovery.py`](../../backend/app/agents/discovery.py) — `DiscoveryAgent._tavily_search` queries `registry.by_capability(Capability.WEB_SEARCH, configured_only=True)` and calls the first configured provider. Falls back to `[]` (claude-knowledge-only mode) when no provider is configured.
- The legacy method name `_tavily_search` is kept for call-site stability; in practice it's now a registry lookup, not a Tavily-specific call.

## Env config

- `TAVILY_API_KEY` — required for `is_configured()` to return `True`.

## Failure modes

- 4xx/5xx from Tavily: bubbles up as `ProviderError` from the adapter, caught at the `_verify_candidate` boundary which returns the candidate with `raw_snippets="No search results available."`. Discovery proceeds; enrich falls back to estimates.
- No provider configured: `_tavily_search` returns `[]`. Discovery flow continues in claude_knowledge mode.

## Verification

```bash
# Configured
curl -s http://127.0.0.1:8000/api/v1/integrations/status | jq '.providers[] | select(.name=="tavily")'
# Expected: { "name": "tavily", "configured": true, "capabilities": ["web_search"] }

# End-to-end discovery (~$0.05 in API tokens)
curl -X POST http://127.0.0.1:8000/api/v1/agents/discover/generate \
  -H 'Content-Type: application/json' \
  -d '{"location":"Brighton","country_code":"GB","max_results":3,"segment_type":"marina"}'

curl http://127.0.0.1:8000/api/v1/agents/discover/status | jq '.events[] | select(.step=="verifying")'
# Expected: events showing the Tavily query strings
```

## Swap to a different web-search provider (Brave, You.com, etc.)

1. Add a new module, e.g. `backend/app/integrations/brave.py`, subclass `BaseProvider`, declare `Capability.WEB_SEARCH`, implement `search(query, max_results)`.
2. Add `BRAVE_API_KEY` to `backend/app/config.py`.
3. Register the instance in `backend/app/integrations/__init__.py`.
4. The first **configured** WEB_SEARCH provider wins (`registry.by_capability(..., configured_only=True)[0]`). Order is the registration order. If both Brave and Tavily are configured, the registered-first one wins; document any prioritization preference in the registry.
