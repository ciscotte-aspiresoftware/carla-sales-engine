"""
Cost dashboard + LLM settings endpoints.

All cost values returned by these endpoints are in USD; the frontend converts
to EUR/GBP using the static rates from /costs/currency-rates.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.campaign import Campaign
from app.models.llm_usage import LLMUsage
from app.services.llm_cost import (
    MODEL_PRICING,
    currency_payload,
    list_models,
)
from app.services.llm_settings import (
    KNOWN_AGENT_NAMES,
    KNOWN_AGENTS,
    clear_agent_override,
    get_active_model,
    get_overrides,
    set_active_model,
    set_agent_override,
)

router = APIRouter()


# ── Read endpoints ────────────────────────────────────────────────────────────

@router.get("/costs/summary")
def get_summary(db: Session = Depends(get_db)) -> dict:
    """Top-line totals across all-time + last 7d + last 30d. USD."""
    now = datetime.now(timezone.utc)

    def window(start: Optional[datetime]) -> dict:
        q = db.query(
            func.coalesce(func.sum(LLMUsage.cost_usd), 0.0).label("cost_usd"),
            func.coalesce(func.sum(LLMUsage.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(LLMUsage.output_tokens), 0).label("output_tokens"),
            func.coalesce(func.sum(LLMUsage.cache_read_tokens), 0).label("cache_read_tokens"),
            func.coalesce(func.sum(LLMUsage.cache_creation_tokens), 0).label("cache_creation_tokens"),
            func.coalesce(func.sum(LLMUsage.thinking_tokens), 0).label("thinking_tokens"),
            func.count(LLMUsage.id).label("calls"),
        )
        if start:
            q = q.filter(LLMUsage.occurred_at >= start)
        row = q.one()
        return {
            "cost_usd": round(float(row.cost_usd), 6),
            "input_tokens": int(row.input_tokens),
            "output_tokens": int(row.output_tokens),
            "cache_read_tokens": int(row.cache_read_tokens),
            "cache_creation_tokens": int(row.cache_creation_tokens),
            "thinking_tokens": int(row.thinking_tokens),
            "calls": int(row.calls),
        }

    return {
        "all_time": window(None),
        "last_7d":  window(now - timedelta(days=7)),
        "last_30d": window(now - timedelta(days=30)),
    }


def _group_breakdown(db: Session, group_col, label: str) -> list[dict]:
    rows = (
        db.query(
            group_col.label("key"),
            func.coalesce(func.sum(LLMUsage.cost_usd), 0.0).label("cost_usd"),
            func.coalesce(func.sum(LLMUsage.input_tokens + LLMUsage.output_tokens + LLMUsage.thinking_tokens), 0).label("tokens"),
            func.count(LLMUsage.id).label("calls"),
        )
        .group_by(group_col)
        .order_by(func.sum(LLMUsage.cost_usd).desc())
        .all()
    )
    return [
        {
            label: r.key,
            "cost_usd": round(float(r.cost_usd), 6),
            "tokens": int(r.tokens),
            "calls": int(r.calls),
        }
        for r in rows
    ]


@router.get("/costs/by-model")
def by_model(db: Session = Depends(get_db)) -> dict:
    """Breakdown by Claude model id."""
    return {"rows": _group_breakdown(db, LLMUsage.model, "model")}


@router.get("/costs/by-agent")
def by_agent(db: Session = Depends(get_db)) -> dict:
    """Breakdown by agent / call site."""
    return {"rows": _group_breakdown(db, LLMUsage.agent, "agent")}


@router.get("/costs/by-campaign")
def by_campaign(db: Session = Depends(get_db)) -> dict:
    """Breakdown by campaign id, with the campaign name resolved."""
    rows = (
        db.query(
            LLMUsage.campaign_id,
            func.coalesce(func.sum(LLMUsage.cost_usd), 0.0).label("cost_usd"),
            func.coalesce(func.sum(LLMUsage.input_tokens + LLMUsage.output_tokens + LLMUsage.thinking_tokens), 0).label("tokens"),
            func.count(LLMUsage.id).label("calls"),
        )
        .group_by(LLMUsage.campaign_id)
        .order_by(func.sum(LLMUsage.cost_usd).desc())
        .all()
    )
    name_by_id: dict[int, str] = {}
    ids = [r.campaign_id for r in rows if r.campaign_id]
    if ids:
        for c in db.query(Campaign).filter(Campaign.id.in_(ids)).all():
            name_by_id[c.id] = c.name
    return {
        "rows": [
            {
                "campaign_id": r.campaign_id,
                "campaign_name": name_by_id.get(r.campaign_id) if r.campaign_id else "(no campaign)",
                "cost_usd": round(float(r.cost_usd), 6),
                "tokens": int(r.tokens),
                "calls": int(r.calls),
            }
            for r in rows
        ]
    }


@router.get("/costs/daily-by-model")
def daily_by_model(days: int = Query(30, ge=1, le=180), db: Session = Depends(get_db)) -> dict:
    """Daily cost timeseries split by model. Used by the stacked-area chart on
    the Costs page so users can see the impact of an override over time.

    Returns:
      {
        "days":   [{ "date": "YYYY-MM-DD", "by_model": {model_id: cost_usd}, "calls_by_model": {model_id: calls} }, ...],
        "models": [model_id, ...]   # ordered by total spend desc — chart uses this for legend / stack order
      }
    """
    start_dt = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(
            func.date(LLMUsage.occurred_at).label("d"),
            LLMUsage.model.label("model"),
            func.coalesce(func.sum(LLMUsage.cost_usd), 0.0).label("cost_usd"),
            func.count(LLMUsage.id).label("calls"),
        )
        .filter(LLMUsage.occurred_at >= start_dt)
        .group_by(func.date(LLMUsage.occurred_at), LLMUsage.model)
        .all()
    )
    by_day_cost: dict[str, dict[str, float]] = {}
    by_day_calls: dict[str, dict[str, int]] = {}
    for r in rows:
        d_str = str(r.d)
        by_day_cost.setdefault(d_str, {})[r.model] = round(float(r.cost_usd), 6)
        by_day_calls.setdefault(d_str, {})[r.model] = int(r.calls)

    today = date.today()
    out: list[dict] = []
    for i in range(days, -1, -1):
        d_str = (today - timedelta(days=i)).isoformat()
        out.append({
            "date": d_str,
            "by_model": by_day_cost.get(d_str, {}),
            "calls_by_model": by_day_calls.get(d_str, {}),
        })

    # Models ordered by total spend across the window — frontend uses this order
    # for the stack and the legend so heavy spenders sit at the bottom of the bar.
    model_totals: dict[str, float] = {}
    for entry in out:
        for m, c in entry["by_model"].items():
            model_totals[m] = model_totals.get(m, 0.0) + c
    models = sorted(model_totals.keys(), key=lambda m: model_totals.get(m, 0), reverse=True)

    return {"days": out, "models": models}


@router.get("/costs/latency-by-agent")
def latency_by_agent(db: Session = Depends(get_db)) -> dict:
    """p50 / p95 / call count of duration_ms per agent.

    Computed in Python rather than SQL because SQLite has no native percentile
    aggregate. Volume is small (a few thousand rows in the demo DB), so this
    is fine. If volume grows, switch to ntile() or move to a real DB.
    """
    rows = (
        db.query(LLMUsage.agent, LLMUsage.duration_ms)
        .filter(LLMUsage.duration_ms.isnot(None))
        .all()
    )
    by_agent: dict[str, list[int]] = {}
    for agent, dur in rows:
        if not agent or dur is None:
            continue
        by_agent.setdefault(agent, []).append(int(dur))

    def percentile(values: list[int], p: float) -> int:
        if not values:
            return 0
        xs = sorted(values)
        idx = max(0, min(len(xs) - 1, int(round((len(xs) - 1) * p))))
        return xs[idx]

    out: list[dict] = []
    for agent, durs in by_agent.items():
        out.append({
            "agent": agent,
            "p50_ms": percentile(durs, 0.5),
            "p95_ms": percentile(durs, 0.95),
            "calls": len(durs),
            # total_ms drives the default sort — slowest agents bubble to the top.
            "total_ms": sum(durs),
        })
    out.sort(key=lambda r: r["total_ms"], reverse=True)
    return {"rows": out}


@router.get("/costs/daily")
def daily(days: int = Query(30, ge=1, le=180), db: Session = Depends(get_db)) -> dict:
    """Daily cost timeseries for the last N days. Returns a row per day even if
    that day had zero calls (so the frontend chart has consistent x-axis)."""
    start_dt = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (
        db.query(
            func.date(LLMUsage.occurred_at).label("d"),
            func.coalesce(func.sum(LLMUsage.cost_usd), 0.0).label("cost_usd"),
            func.coalesce(func.sum(LLMUsage.input_tokens + LLMUsage.output_tokens + LLMUsage.thinking_tokens), 0).label("tokens"),
            func.count(LLMUsage.id).label("calls"),
        )
        .filter(LLMUsage.occurred_at >= start_dt)
        .group_by(func.date(LLMUsage.occurred_at))
        .all()
    )
    by_day: dict[str, dict] = {
        str(r.d): {
            "date": str(r.d),
            "cost_usd": round(float(r.cost_usd), 6),
            "tokens": int(r.tokens),
            "calls": int(r.calls),
        }
        for r in rows
    }
    out: list[dict] = []
    today = date.today()
    for i in range(days, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        out.append(by_day.get(d, {"date": d, "cost_usd": 0.0, "tokens": 0, "calls": 0}))
    return {"days": out}


@router.get("/costs/recent")
def recent(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)) -> dict:
    """Most recent LLM calls — used by the activity feed and the costs detail table."""
    rows = (
        db.query(LLMUsage)
        .order_by(LLMUsage.occurred_at.desc())
        .limit(limit)
        .all()
    )
    cmpids = list({r.campaign_id for r in rows if r.campaign_id})
    cnames: dict[int, str] = {}
    if cmpids:
        for c in db.query(Campaign).filter(Campaign.id.in_(cmpids)).all():
            cnames[c.id] = c.name
    return {
        "calls": [
            {
                "id": r.id,
                "occurred_at": r.occurred_at.isoformat() if r.occurred_at else None,
                "model": r.model,
                "agent": r.agent,
                "campaign_id": r.campaign_id,
                "campaign_name": cnames.get(r.campaign_id) if r.campaign_id else None,
                "prospect_id": r.prospect_id,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "cache_read_tokens": r.cache_read_tokens,
                "cache_creation_tokens": r.cache_creation_tokens,
                "thinking_tokens": r.thinking_tokens,
                "cost_usd": r.cost_usd,
                "duration_ms": r.duration_ms,
            }
            for r in rows
        ]
    }


@router.get("/costs/currency-rates")
def currency_rates() -> dict:
    return currency_payload()


# ── Settings: model selector ─────────────────────────────────────────────────

@router.get("/settings/llm")
def get_llm_settings() -> dict:
    """The full LLM-settings payload. Includes the global active model, the per-
    agent override map, the catalog of available models, and the canonical list
    of agents whose model can be overridden."""
    return {
        "active_model": get_active_model(),
        "available_models": list_models(),
        "overrides": get_overrides(),
        "agents": KNOWN_AGENTS,
    }


class SetActiveModelRequest(BaseModel):
    model_id: str

    @field_validator("model_id")
    @classmethod
    def known_model(cls, v: str) -> str:
        if v not in MODEL_PRICING:
            raise ValueError(f"Unknown model id '{v}' — must be one of {sorted(MODEL_PRICING.keys())}")
        return v


@router.put("/settings/llm/active-model")
def set_llm_active_model(payload: SetActiveModelRequest) -> dict:
    try:
        new_model = set_active_model(payload.model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"active_model": new_model}


class SetAgentModelRequest(BaseModel):
    """Pin a single agent to a specific model, or clear its override.

    `model_id` may be:
      - a string in MODEL_PRICING → set the override
      - null → clear the override (agent reverts to global default)
    """
    agent: str
    model_id: Optional[str] = None

    @field_validator("agent")
    @classmethod
    def known_agent(cls, v: str) -> str:
        if v not in KNOWN_AGENT_NAMES:
            raise ValueError(f"Unknown agent '{v}'")
        return v

    @field_validator("model_id")
    @classmethod
    def known_model_or_null(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        if v not in MODEL_PRICING:
            raise ValueError(f"Unknown model id '{v}'")
        return v


@router.put("/settings/llm/agent-model")
def set_llm_agent_model(payload: SetAgentModelRequest) -> dict:
    """Set or clear an agent's per-step model override. Returns the updated
    overrides map so the frontend can re-render without a second fetch."""
    try:
        if payload.model_id is None:
            overrides = clear_agent_override(payload.agent)
        else:
            overrides = set_agent_override(payload.agent, payload.model_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"overrides": overrides}
