import time
from typing import Any, Optional

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage

from app.config import settings
from app.database import SessionLocal
from app.services.guardrails_service import guardrails_service
from app.services.llm_cost import (
    record_usage_anthropic,
    record_usage_langchain,
)
from app.services.llm_settings import get_active_model


def _anthropic_api_key() -> str:
    """DB-first, .env fallback. Lets the Settings UI override the key without
    a backend restart."""
    from app.services.app_settings_service import app_settings_service
    return app_settings_service.get_or_env("anthropic_api_key") or ""


def get_llm(
    temperature: float = 0.7,
    model: Optional[str] = None,
    agent: Optional[str] = None,
) -> ChatAnthropic:
    """Returns a configured ChatAnthropic instance.

    Resolution order for the model:
      1. explicit `model` arg (test / one-off override)
      2. per-agent override pinned in .app_settings.json (Costs page → "Per-step models")
      3. global active_model (Costs page → "Active Model")
      4. DEFAULT_MODEL constant

    The API key is resolved DB-first (Settings UI), env-fallback (.env).

    Callers should always pass `agent="researcher"` (or whatever their canonical
    agent name is) so step 2 can take effect."""
    return ChatAnthropic(
        model=model or get_active_model(agent),
        api_key=_anthropic_api_key(),
        temperature=temperature,
        max_tokens=4096,
    )


async def tracked_invoke(
    chain,
    invoke_args: dict,
    *,
    agent: str,
    model: Optional[str] = None,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    parser: Optional[Any] = None,
):
    """
    Invoke a LangChain chain (`prompt | llm`), record token usage to llm_usage,
    optionally run a parser on the result, and return the parsed value.

    Usage:
        result = await tracked_invoke(
            prompt | llm,                  # chain WITHOUT the parser
            invoke_args,
            agent="researcher",
            prospect_id=p.id,
            parser=JsonOutputParser(),
        )

    Why no parser in the chain? Because parsers strip the AIMessage wrapper that
    carries usage_metadata. Running the parser separately lets us capture both.
    """
    started = time.perf_counter()
    ai_msg: AIMessage = await chain.ainvoke(invoke_args)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    db = SessionLocal()
    try:
        record_usage_langchain(
            db,
            usage_metadata=getattr(ai_msg, "usage_metadata", None),
            # Record the model the call actually ran on, including any per-agent override.
            model=model or get_active_model(agent),
            agent=agent,
            campaign_id=campaign_id,
            prospect_id=prospect_id,
            duration_ms=elapsed_ms,
        )
    finally:
        db.close()

    if parser is None:
        return ai_msg
    return parser.invoke(ai_msg)


def tracked_anthropic_create(
    client,
    *,
    agent: str,
    model: str,
    campaign_id: Optional[int] = None,
    prospect_id: Optional[int] = None,
    **create_kwargs,
):
    """Synchronous wrapper around `anthropic_client.messages.create(...)` that
    records usage and returns the response. The model is required here (it's
    a kwarg of the underlying create() call) — it gets recorded as the value
    we sent to Anthropic, which is what the user is paying for."""
    started = time.perf_counter()
    response = client.messages.create(model=model, **create_kwargs)
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    db = SessionLocal()
    try:
        record_usage_anthropic(
            db,
            response=response,
            model=model,
            agent=agent,
            campaign_id=campaign_id,
            prospect_id=prospect_id,
            duration_ms=elapsed_ms,
        )
    finally:
        db.close()
    return response


def format_pack_context(vertical_pack: dict, regional_pack: dict) -> str:
    """Serializes key pack fields into a compact string block for LLM prompts.

    Works for both legacy single-file packs (marina) and composed layered packs
    (car_rental + vendor + product) — both expose display_name / product_name /
    messaging_framework / personas / email_guidance.
    """
    vp = vertical_pack
    rp = regional_pack

    personas_summary = ""
    for persona_id, persona in vp.get("personas", {}).items():
        vps = "\n    ".join(persona.get("value_props", []))
        personas_summary += f"\n  - {persona_id}: {persona.get('communication_style', '')}\n    Value props: {vps}"

    # Industry context (only set on layered packs; marina-style packs don't have it)
    industry = vp.get("industry_context") or {}
    industry_block = ""
    if industry:
        kpis = ", ".join(industry.get("key_kpis", []))
        pains = "; ".join(industry.get("common_pains", []))
        industry_block = (
            f"\nINDUSTRY: {industry.get('summary', '')}"
            + (f"\nKEY KPIS: {kpis}" if kpis else "")
            + (f"\nCOMMON PAINS: {pains}" if pains else "")
        )

    # Vendor context (only on composed packs)
    vendor = vp.get("vendor") or {}
    vendor_block = ""
    if vendor:
        logos = ", ".join(l.get("name", "") for l in vendor.get("customer_logos", []) if l.get("name"))
        vendor_block = (
            f"\nVENDOR: {vendor.get('company_name', '')}"
            + (f" (HQ {vendor.get('headquarters', '')}, {vendor.get('years_in_business', '')} years)" if vendor.get('headquarters') else "")
            + (f"\nVENDOR CUSTOMERS: {logos}" if logos else "")
        )

    guardrails = guardrails_service.get_rules_text()

    return f"""
PRODUCT: {vp.get('display_name', '')} ({vp.get('product_name', '')})
ELEVATOR PITCH: {vp.get('messaging_framework', {}).get('elevator_pitch', '')}
DIFFERENTIATORS: {', '.join(vp.get('messaging_framework', {}).get('differentiators', []))}{industry_block}{vendor_block}
PERSONAS:{personas_summary}
EMAIL GUIDANCE: {vp.get('email_guidance', {}).get('sequence_strategy', '')}
REGION: {rp.get('display_name', '')}
TONE: {rp.get('tone', {}).get('notes', '')}
LANGUAGE: {rp.get('language', 'en')} / {rp.get('locale', 'en-US')}
COMPLIANCE: {rp.get('compliance', {}).get('relevant_law', 'CAN-SPAM')}
GREETING STYLE: {rp.get('localization', {}).get('greeting_style', 'Hi {first_name},')}
SIGN OFF: {rp.get('localization', {}).get('sign_off', 'Best,')}
{guardrails}""".strip()
