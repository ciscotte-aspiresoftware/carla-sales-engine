"""
Runtime-mutable LLM settings.

Two settings live here:
  - active_model: the global default Claude model id, used by every agent that
    doesn't have a per-agent override.
  - model_overrides: a {agent_name: model_id} map letting individual agents run
    on a different model than the global default (e.g. copywriter on Haiku
    while researcher stays on Sonnet).

Persisted as a small JSON file next to the SQLite DB so it survives restarts
without requiring a schema migration.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from app.services.llm_cost import MODEL_PRICING


# Default model. The app starts with this until someone POSTs a different one.
DEFAULT_MODEL = "claude-sonnet-4-6"


# ── Agent registry ────────────────────────────────────────────────────────────

# The canonical list of agents whose model can be overridden. Keep in sync with
# the call sites that pass agent="..." to get_llm() / tracked_invoke. Order here
# drives the order in the UI.
KNOWN_AGENTS: list[dict] = [
    {
        "name": "discovery_generate",
        "label": "Discovery — generate",
        "description": "Lists candidate businesses Claude knows about for a given location.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "World-knowledge recall + structured JSON output — Sonnet is the right balance.",
    },
    {
        "name": "discovery_suggest_count",
        "label": "Discovery — suggest count",
        "description": "Tiny call: how many real operators Claude would confidently know in this location.",
        "recommended_model": "claude-haiku-4-5-20251001",
        "recommendation_reason": "Returns one integer + one sentence — Haiku handles this trivially.",
    },
    {
        "name": "discovery_enrich",
        "label": "Discovery — enrich",
        "description": "Extracts the decision-maker contact and operational data from Tavily snippets.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Reading-comprehension extraction from messy web snippets — Haiku misses subtle title/email cues.",
    },
    {
        "name": "website_enrichment",
        "label": "Website Enrichment",
        "description": "Extracts structured facts (services, online booking, tech stack, pain quotes, competitor mentions) from a prospect's homepage and selected inner pages.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Reading-comprehension over messy multi-page markdown; output feeds the researcher so quality regressions propagate.",
    },
    {
        "name": "prospector",
        "label": "Prospector (ICP scoring)",
        "description": "Scores enrolled prospects against the vertical pack's ICP criteria.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Multi-criterion weighting and edge-case judgement — Haiku gets the marginal cases wrong.",
    },
    {
        "name": "researcher",
        "label": "Researcher",
        "description": "Generates the per-prospect personalisation profile (hook, pain, credible detail).",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Output drives email quality downstream. Quality regressions here propagate to reply rates.",
    },
    {
        "name": "copywriter",
        "label": "Copywriter",
        "description": "Writes the email sequence per prospect. The highest-volume creative call.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "The email copy IS the product. Don't economise here — a small reply-rate drop costs far more than the token savings.",
    },
    {
        "name": "classifier",
        "label": "Reply classifier",
        "description": "Classifies inbound replies (interested / OOO / unsubscribe / objection / spam).",
        "recommended_model": "claude-haiku-4-5-20251001",
        "recommendation_reason": "5-way classification of short text — Haiku handles this well at a fraction of the cost.",
    },
    {
        "name": "pack_generate_icp",
        "label": "Pack — ICP generation",
        "description": "AI Auto-fill for a vertical pack's ICP criteria.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Structured generation under human review. Sonnet's sweet spot.",
    },
    {
        "name": "pack_generate_personas",
        "label": "Pack — Personas generation",
        "description": "AI Auto-fill for a product pack's buyer personas.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Creative-but-constrained generation. Sonnet handles the structure-plus-judgement balance.",
    },
    {
        "name": "pack_generate_messaging",
        "label": "Pack — Messaging generation",
        "description": "AI Auto-fill for a product pack's messaging framework.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Messaging quality matters; this ships into every campaign downstream.",
    },
    {
        "name": "pack_generate_email_guidance",
        "label": "Pack — Email guidance generation",
        "description": "AI Auto-fill for a product pack's sequence strategy.",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Same shape as messaging — Sonnet for the right blend of structure and creativity.",
    },
    {
        "name": "pack_generate_regional",
        "label": "Pack — Regional generation",
        "description": "AI Auto-fill for a regional pack (locale, tone, compliance).",
        "recommended_model": "claude-sonnet-4-6",
        "recommendation_reason": "Needs accurate locale / holiday / compliance knowledge — accuracy matters more than cost here.",
    },
]

KNOWN_AGENT_NAMES: set[str] = {a["name"] for a in KNOWN_AGENTS}


# ── Settings file I/O ─────────────────────────────────────────────────────────

def _settings_path() -> Path:
    # Resolves to {project_root}/.app_settings.json (parents[3] from this file).
    return Path(__file__).resolve().parents[3] / ".app_settings.json"


def _read() -> dict:
    p = _settings_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write(data: dict) -> None:
    p = _settings_path()
    try:
        p.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"[llm_settings] failed to persist settings: {exc}")


# ── Active model + per-agent overrides ────────────────────────────────────────

def get_active_model(agent: Optional[str] = None) -> str:
    """Returns the Claude model id to use right now.

    If `agent` is provided and that agent has a recorded override that points
    at a known model, return the override. Otherwise return the global default.
    Unknown / stale model ids fall through to the global default rather than
    propagate as a 4xx — the cost dashboard might still show old rows, but
    the next live call will pick up a sane model.
    """
    data = _read()
    overrides = data.get("model_overrides") or {}

    if agent and agent in overrides:
        candidate = overrides[agent]
        if candidate in MODEL_PRICING:
            return candidate

    candidate = data.get("active_model")
    if candidate and candidate in MODEL_PRICING:
        return candidate
    return DEFAULT_MODEL


def set_active_model(model_id: str) -> str:
    """Set the global default model. Validates against MODEL_PRICING."""
    if model_id not in MODEL_PRICING:
        raise ValueError(f"Unknown model: {model_id}")
    data = _read()
    data["active_model"] = model_id
    _write(data)
    return model_id


def get_overrides() -> dict[str, str]:
    """Return the {agent: model_id} override map (filtered to known agents +
    known models, so stale entries don't leak into the UI)."""
    data = _read()
    raw = data.get("model_overrides") or {}
    out: dict[str, str] = {}
    for agent, model_id in raw.items():
        if agent in KNOWN_AGENT_NAMES and model_id in MODEL_PRICING:
            out[agent] = model_id
    return out


def set_agent_override(agent: str, model_id: str) -> dict[str, str]:
    """Pin an agent to a specific model. Returns the full updated override map."""
    if agent not in KNOWN_AGENT_NAMES:
        raise ValueError(f"Unknown agent: {agent}")
    if model_id not in MODEL_PRICING:
        raise ValueError(f"Unknown model: {model_id}")
    data = _read()
    overrides = dict(data.get("model_overrides") or {})
    overrides[agent] = model_id
    data["model_overrides"] = overrides
    _write(data)
    return overrides


def clear_agent_override(agent: str) -> dict[str, str]:
    """Remove an agent's override so it falls back to the global default.
    No-op if no override exists."""
    if agent not in KNOWN_AGENT_NAMES:
        raise ValueError(f"Unknown agent: {agent}")
    data = _read()
    overrides = dict(data.get("model_overrides") or {})
    overrides.pop(agent, None)
    data["model_overrides"] = overrides
    _write(data)
    return overrides


# Settings used at startup or as fallback. Direct callers should always go
# through get_active_model() so they pick up runtime changes.
def default_model() -> str:
    return DEFAULT_MODEL
