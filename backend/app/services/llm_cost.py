"""
LLM cost service — pricing table, currency conversion, and the record_usage()
helper called from every Claude call site.

Pricing reflects Anthropic's published per-Mtok rates; cache reads are billed
at 10% of the input rate, cache writes at 1.25× (5-minute) or 2× (1-hour)
depending on TTL. Sonnet has a tiered rate for >200k context — we use the
≤200k tier here since the demo's prompts stay well under that.

Currency rates are static with an `as_of` date so the UI can disclose data age.
Edit the constants below to refresh them.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from app.models.activity import ActivityEvent
from app.models.llm_usage import LLMUsage


# ── Model pricing (USD per 1,000,000 tokens) ──────────────────────────────────

@dataclass
class ModelPricing:
    model_id: str
    label: str
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float
    cache_write_5m_per_mtok: float
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


MODEL_PRICING: dict[str, ModelPricing] = {
    # ── Claude 4.x lineup ─────────────────────────────────────────────────────
    "claude-opus-4-7": ModelPricing(
        model_id="claude-opus-4-7",
        label="Claude Opus 4.7",
        input_per_mtok=15.00,
        output_per_mtok=75.00,
        cache_read_per_mtok=1.50,
        cache_write_5m_per_mtok=18.75,
        notes="Current Opus flagship. Highest reasoning; expensive at volume. Best for the optimizer and complex pack generation.",
    ),
    "claude-opus-4-6": ModelPricing(
        model_id="claude-opus-4-6",
        label="Claude Opus 4.6",
        input_per_mtok=15.00,
        output_per_mtok=75.00,
        cache_read_per_mtok=1.50,
        cache_write_5m_per_mtok=18.75,
        notes="Previous Opus generation. Same pricing tier as 4.7 — pick 4.7 unless you need 4.6 for an A/B.",
    ),
    "claude-sonnet-4-7": ModelPricing(
        model_id="claude-sonnet-4-7",
        label="Claude Sonnet 4.7",
        input_per_mtok=3.00,
        output_per_mtok=15.00,
        cache_read_per_mtok=0.30,
        cache_write_5m_per_mtok=3.75,
        notes="Latest Sonnet generation. Good capability/cost balance for the pipeline.",
    ),
    "claude-sonnet-4-6": ModelPricing(
        model_id="claude-sonnet-4-6",
        label="Claude Sonnet 4.6",
        input_per_mtok=3.00,
        output_per_mtok=15.00,
        cache_read_per_mtok=0.30,
        cache_write_5m_per_mtok=3.75,
        notes="Current default. Used by every agent until you override.",
    ),
    "claude-sonnet-4-5": ModelPricing(
        model_id="claude-sonnet-4-5",
        label="Claude Sonnet 4.5",
        input_per_mtok=3.00,
        output_per_mtok=15.00,
        cache_read_per_mtok=0.30,
        cache_write_5m_per_mtok=3.75,
        notes="Older Sonnet 4.x. Same pricing — useful for regression tests against newer Sonnets.",
    ),
    "claude-haiku-4-5-20251001": ModelPricing(
        model_id="claude-haiku-4-5-20251001",
        label="Claude Haiku 4.5",
        input_per_mtok=1.00,
        output_per_mtok=5.00,
        cache_read_per_mtok=0.10,
        cache_write_5m_per_mtok=1.25,
        notes="Fastest and cheapest 4.x. Good for high-volume / low-judgement agents (classifier, suggest-count, copywriter).",
    ),

    # ── Claude 3.x legacy — kept for cost-comparison and A/B against 4.x ──────
    "claude-3-7-sonnet-latest": ModelPricing(
        model_id="claude-3-7-sonnet-latest",
        label="Claude 3.7 Sonnet (legacy)",
        input_per_mtok=3.00,
        output_per_mtok=15.00,
        cache_read_per_mtok=0.30,
        cache_write_5m_per_mtok=3.75,
        notes="Legacy Sonnet — same price tier as 4.x Sonnet but older capabilities.",
    ),
    "claude-3-5-sonnet-latest": ModelPricing(
        model_id="claude-3-5-sonnet-latest",
        label="Claude 3.5 Sonnet (legacy)",
        input_per_mtok=3.00,
        output_per_mtok=15.00,
        cache_read_per_mtok=0.30,
        cache_write_5m_per_mtok=3.75,
        notes="Legacy Sonnet 3.5. Useful only if you have prompts pinned to its behaviour.",
    ),
    "claude-3-5-haiku-latest": ModelPricing(
        model_id="claude-3-5-haiku-latest",
        label="Claude 3.5 Haiku (legacy)",
        input_per_mtok=0.80,
        output_per_mtok=4.00,
        cache_read_per_mtok=0.08,
        cache_write_5m_per_mtok=1.00,
        notes="Cheaper than Haiku 4.5 but markedly weaker. Reasonable for the classifier or simple extraction.",
    ),
    "claude-3-opus-20240229": ModelPricing(
        model_id="claude-3-opus-20240229",
        label="Claude 3 Opus (legacy)",
        input_per_mtok=15.00,
        output_per_mtok=75.00,
        cache_read_per_mtok=1.50,
        cache_write_5m_per_mtok=18.75,
        notes="Legacy flagship. Same pricing tier as 4.x Opus — pick 4.7 unless reproducing pre-4.x output.",
    ),
    "claude-3-haiku-20240307": ModelPricing(
        model_id="claude-3-haiku-20240307",
        label="Claude 3 Haiku (legacy)",
        input_per_mtok=0.25,
        output_per_mtok=1.25,
        cache_read_per_mtok=0.03,
        cache_write_5m_per_mtok=0.30,
        notes="Cheapest model in the catalog — ~4× cheaper than Haiku 4.5 but visibly weaker. Use only for trivial classification.",
    ),
}


def list_models() -> list[dict]:
    return [m.to_dict() for m in MODEL_PRICING.values()]


def get_pricing(model_id: str) -> Optional[ModelPricing]:
    return MODEL_PRICING.get(model_id)


# ── Currency rates (static, USD-base) ─────────────────────────────────────────

# Approximate rates — refresh by editing this block. Frontend converts client-side.
CURRENCY_RATES = {
    "USD": 1.0,
    "EUR": 0.92,
    "GBP": 0.78,
}
CURRENCY_RATES_AS_OF = date(2026, 5, 7)


def currency_payload() -> dict:
    return {
        "base": "USD",
        "rates": CURRENCY_RATES,
        "as_of": CURRENCY_RATES_AS_OF.isoformat(),
        "source": "static (edit backend/app/services/llm_cost.py to refresh)",
    }


# ── Cost computation ──────────────────────────────────────────────────────────

def compute_cost_usd(
    model_id: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    thinking_tokens: int = 0,
) -> float:
    """Pure function — total cost in USD for one Claude call.

    Thinking tokens are billed as output tokens by Anthropic's pricing model.
    Cache-creation tokens here use the 5-minute TTL rate; if you start using
    1-hour caching, add a `cache_ttl` parameter and a separate per-mtok rate.
    """
    p = MODEL_PRICING.get(model_id)
    if not p:
        return 0.0
    per_token = lambda mtok_rate: mtok_rate / 1_000_000.0
    return (
        input_tokens * per_token(p.input_per_mtok)
        + (output_tokens + thinking_tokens) * per_token(p.output_per_mtok)
        + cache_read_tokens * per_token(p.cache_read_per_mtok)
        + cache_creation_tokens * per_token(p.cache_write_5m_per_mtok)
    )


# ── Record-usage helper ───────────────────────────────────────────────────────

def record_usage(
    db: Session,
    *,
    model: str,
    agent: str,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    thinking_tokens: int = 0,
    duration_ms: Optional[int] = None,
) -> LLMUsage:
    """
    Insert one LLMUsage row. Cost is computed from the model's pricing table.
    Failures are swallowed and logged (we never want cost-tracking to break the
    underlying agent call) — the returned row may not have an id if commit failed.
    """
    cost = compute_cost_usd(
        model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_creation_tokens=cache_creation_tokens,
        thinking_tokens=thinking_tokens,
    )
    row = LLMUsage(
        model=model,
        agent=agent,
        campaign_id=campaign_id,
        prospect_id=prospect_id,
        input_tokens=int(input_tokens or 0),
        output_tokens=int(output_tokens or 0),
        cache_read_tokens=int(cache_read_tokens or 0),
        cache_creation_tokens=int(cache_creation_tokens or 0),
        thinking_tokens=int(thinking_tokens or 0),
        cost_usd=float(cost),
        duration_ms=duration_ms,
    )
    try:
        db.add(row)
        db.commit()
        db.refresh(row)

        # Mirror into the activity feed so users see Claude calls as they happen,
        # alongside campaign/sequence/etc. events. event_data holds enough to render
        # a one-line summary without re-fetching the LLMUsage row.
        try:
            db.add(ActivityEvent(
                campaign_id=campaign_id,
                prospect_id=prospect_id,
                event_type="llm_call",
                event_data={
                    "llm_usage_id": row.id,
                    "model": model,
                    "agent": agent,
                    "input_tokens": row.input_tokens,
                    "output_tokens": row.output_tokens,
                    "thinking_tokens": row.thinking_tokens,
                    "cost_usd": row.cost_usd,
                    "duration_ms": duration_ms,
                },
                is_simulated=False,
            ))
            db.commit()
        except Exception as inner_exc:
            db.rollback()
            print(f"[llm_cost] failed to mirror llm_call activity event: {inner_exc}")
    except Exception as exc:
        # Do not propagate — cost tracking must never break the agent call.
        db.rollback()
        print(f"[llm_cost] failed to record usage for {agent}/{model}: {exc}")
    return row


def record_usage_anthropic(
    db: Session,
    *,
    response,  # anthropic.types.Message
    model: str,
    agent: str,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    duration_ms: Optional[int] = None,
) -> LLMUsage:
    """Convenience wrapper for direct Anthropic SDK responses."""
    u = response.usage
    # Anthropic SDK exposes thinking tokens via response.usage.cache_creation_input_tokens?
    # Extended-thinking output tokens are counted in output_tokens by the API.
    return record_usage(
        db,
        model=model,
        agent=agent,
        campaign_id=campaign_id,
        prospect_id=prospect_id,
        input_tokens=getattr(u, "input_tokens", 0) or 0,
        output_tokens=getattr(u, "output_tokens", 0) or 0,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_creation_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
        duration_ms=duration_ms,
    )


def record_usage_langchain(
    db: Session,
    *,
    usage_metadata: Optional[dict],
    model: str,
    agent: str,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    duration_ms: Optional[int] = None,
) -> Optional[LLMUsage]:
    """LangChain ChatAnthropic exposes usage as an `usage_metadata` dict on the
    AIMessage. Shape: {input_tokens, output_tokens, total_tokens, input_token_details: {...}}.
    """
    if not usage_metadata:
        return None
    details = usage_metadata.get("input_token_details") or {}
    return record_usage(
        db,
        model=model,
        agent=agent,
        campaign_id=campaign_id,
        prospect_id=prospect_id,
        input_tokens=usage_metadata.get("input_tokens", 0) or 0,
        output_tokens=usage_metadata.get("output_tokens", 0) or 0,
        cache_read_tokens=details.get("cache_read", 0) or 0,
        cache_creation_tokens=details.get("cache_creation", 0) or 0,
        duration_ms=duration_ms,
    )
