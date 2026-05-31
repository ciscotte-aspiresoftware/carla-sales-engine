import json
import re

import anthropic
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, field_validator
from typing import Any, Optional

from app.config import settings
from app.packs.loader import pack_loader

router = APIRouter()

RESERVED_IDS = {"new", "vertical", "vendor", "product", "regional", "composed"}
PACK_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
BUILTIN_VERTICALS = {"marina", "car_rental"}
BUILTIN_VENDORS = {"thermeon", "dockmaster", "bluebird", "rentall"}
BUILTIN_PRODUCTS = {"thermeon_carsplus", "thermeon_frontdesk", "dockmaster", "bluebird_rentworks", "rentall_platform"}


# ── Read endpoints ────────────────────────────────────────────────────────────

@router.get("/packs")
async def list_packs():
    return pack_loader.list_available()


@router.get("/verticals/manifest")
async def verticals_manifest():
    """Lightweight list of every available vertical with the minimum metadata
    needed to render the sidebar / vertical-switcher: id, label, color token,
    logo color. Replaces the hardcoded VERTICALS array in the frontend so a
    new vertical = just a new pack JSON, no code change.

    The full pack body is still fetched lazily via /packs/composed?vertical=...
    when a vertical is actually selected; this endpoint is the boot-time index.
    """
    out: list[dict] = []
    for vid in pack_loader.list_available().get("vertical", []):
        pack = pack_loader.load_vertical(vid)
        if not pack:
            continue
        ic = pack.get("industry_context") or {}
        ui = ic.get("ui") or {}
        # display_name often carries " — Industry" suffix in the JSON; strip
        # it for sidebar use so the label stays compact.
        raw_label = pack.get("display_name") or pack.get("pack_id") or vid
        label = raw_label.split(" — ")[0]
        out.append({
            "id": vid,
            "label": label,
            "color_token": ui.get("color_token"),
            "logo_color": ui.get("logo_color") or pack.get("logo_color"),
            # Phase 5d: optional per-pack catalog of capabilities the engine
            # should advertise / configure for this vertical. None means the
            # pack didn't opt-in — UI shows everything (back-compat).
            "supported_capabilities": pack_loader.supported_capabilities(vid),
        })
    return {"verticals": out}


@router.get("/packs/vertical/{pack_id}")
async def get_vertical_pack(pack_id: str):
    pack = pack_loader.load_vertical(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=f"Vertical pack '{pack_id}' not found")
    return pack


@router.get("/packs/vendor/{pack_id}")
async def get_vendor_pack(pack_id: str):
    pack = pack_loader.load_vendor(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=f"Vendor pack '{pack_id}' not found")
    return pack


@router.get("/packs/product/{pack_id}")
async def get_product_pack(pack_id: str):
    pack = pack_loader.load_product(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=f"Product pack '{pack_id}' not found")
    return pack


@router.get("/packs/regional/{pack_id}")
async def get_regional_pack(pack_id: str):
    pack = pack_loader.load_regional(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=f"Regional pack '{pack_id}' not found")
    return pack


@router.get("/packs/composed")
async def get_composed_pack(
    vertical: str,
    vendor: Optional[str] = None,
    product: Optional[str] = None,
):
    """
    Compose a vertical + vendor + product into a single pack object.
    Legacy vertical packs (marina) are returned as-is; vendor/product are ignored.
    Layered vertical packs (car_rental) require vendor + product.
    """
    composed = pack_loader.compose(vertical, vendor, product)
    if not composed:
        v = pack_loader.load_vertical(vertical)
        if not v:
            raise HTTPException(status_code=404, detail=f"Vertical pack '{vertical}' not found")
        raise HTTPException(
            status_code=400,
            detail=f"Vertical '{vertical}' requires both 'vendor' and 'product' query parameters.",
        )
    return composed


# ── Write schemas ─────────────────────────────────────────────────────────────

class IcpCriterion(BaseModel):
    field: str
    operator: str
    value: Any
    weight: float
    label: str


class PersonaModel(BaseModel):
    titles: list[str] = []
    primary_motivators: list[str] = []
    communication_style: str = ""
    value_props: list[str] = []
    objection_handles: dict[str, str] = {}


class MessagingFramework(BaseModel):
    elevator_pitch: str = ""
    category: str = ""
    differentiators: list[str] = []
    proof_points: list[dict] = []


class EmailGuidance(BaseModel):
    sequence_strategy: str = ""
    subject_line_style: str = ""
    cta_progression: list[str] = []
    avoid: list[str] = []


def _validate_pack_id(v: str) -> str:
    v = v.strip().lower().replace(" ", "_").replace("-", "_")
    if not PACK_ID_RE.match(v):
        raise ValueError("pack_id must be 2-40 lowercase letters/digits/underscores, starting with a letter")
    if v in RESERVED_IDS:
        raise ValueError(f"'{v}' is a reserved ID")
    return v


class VerticalPackWrite(BaseModel):
    model_config = ConfigDict(extra="allow")

    pack_id: str
    display_name: str
    product_name: str = ""
    product_url: str = ""
    logo_color: str = "#6366f1"
    version: str = "1.0.0"
    icp: Optional[dict] = None
    personas: Optional[dict[str, Any]] = None
    messaging_framework: Optional[dict] = None
    email_guidance: Optional[dict] = None
    industry_context: Optional[dict] = None
    prospect_schema_hints: Optional[dict] = None
    # Sender for legacy single-file packs (layered packs use vendor.outreach_sender instead).
    outreach_sender: Optional[dict] = None

    @field_validator("pack_id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        return _validate_pack_id(v)


class VendorPackWrite(BaseModel):
    model_config = ConfigDict(extra="allow")

    pack_id: str
    company_name: str
    display_name: str = ""
    parent_company: str = ""
    portfolio_group: str = ""
    logo_color: str = "#6366f1"
    version: str = "1.0.0"
    verticals: list[str] = []
    headquarters: str = ""
    regional_offices: list[str] = []
    regions_served: str = ""
    years_in_business: str = ""
    company_summary: str = ""
    primary_url: str = ""
    customer_logos: list[dict] = []
    support_model: str = ""
    brand_voice: Optional[dict] = None
    # Sender used as the From line in outbound campaign emails. {"name", "email"}.
    outreach_sender: Optional[dict] = None
    # Existing customers / orgs that should NOT be discovered as new prospects.
    # Each entry: {"name": str, "reason": str (optional)}.
    excluded_customers: list[dict] = []
    # Competitor names that the website-enrichment agent should flag when found
    # verbatim on a prospect's site. Pure data surfacing — does not affect
    # discovery or ICP scoring. Plain string list because we only need the
    # name; the matcher is case-insensitive substring (see _is_excluded).
    competitor_signals: list[str] = []
    product_ids: list[str] = []

    @field_validator("pack_id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        return _validate_pack_id(v)


class ProductPackWrite(BaseModel):
    model_config = ConfigDict(extra="allow")

    pack_id: str
    vendor_id: str
    vertical_id: str
    product_name: str
    display_name: str = ""
    product_url: str = ""
    logo_color: str = "#6366f1"
    version: str = "1.0.0"
    scope_summary: str = ""
    modules: list[str] = []
    icp_overrides: Optional[dict] = None
    personas: Optional[dict[str, Any]] = None
    messaging_framework: Optional[dict] = None
    email_guidance: Optional[dict] = None

    @field_validator("pack_id", "vendor_id", "vertical_id")
    @classmethod
    def validate_ids(cls, v: str) -> str:
        return _validate_pack_id(v)


class RegionalPackWrite(BaseModel):
    model_config = ConfigDict(extra="allow")

    pack_id: str
    display_name: str
    language: str = "en"
    locale: str = "en-US"
    country_code: str = "US"
    timezone: str = "UTC"
    currency: str = "USD"
    currency_symbol: str = "$"
    version: str = "1.0.0"
    tone: Optional[dict] = None
    scheduling: Optional[dict] = None
    localization: Optional[dict] = None
    compliance: Optional[dict] = None
    cultural_notes: str = ""

    @field_validator("pack_id")
    @classmethod
    def validate_id(cls, v: str) -> str:
        return _validate_pack_id(v)


# ── AI generation ─────────────────────────────────────────────────────────────

class GenerateRegionalRequest(BaseModel):
    country: str  # free-text country name or code, e.g. "Germany" or "DE"


_REGIONAL_SCHEMA_HINT = """{
  "pack_id": "<cc>_<lang> e.g. de_de",
  "display_name": "<Country (Language)>",
  "language": "<ISO 639-1 code>",
  "locale": "<BCP-47 locale>",
  "country_code": "<ISO 3166-1 alpha-2>",
  "timezone": "<IANA timezone>",
  "currency": "<ISO 4217 code>",
  "currency_symbol": "<symbol>",
  "tone": {
    "formality": "<informal|semi-formal|formal>",
    "directness": "<low|moderate|high>",
    "humor": "<none|minimal|light|moderate>",
    "relationship_style": "<one-word style e.g. professional_first>",
    "notes": "<2-3 sentences of B2B tone guidance for this market>"
  },
  "scheduling": {
    "nager_country_code": "<ISO 3166-1 alpha-2>",
    "no_send_days_of_week": [<0=Sun … 6=Sat>],
    "no_send_hours_start": <int 0-23>,
    "no_send_hours_end": <int 0-23>,
    "best_send_windows": ["<Day HH:MM-HH:MM>"],
    "blackout_periods": [{"name": "<holiday>", "description": "<why to avoid>"}]
  },
  "localization": {
    "date_format": "<e.g. DD.MM.YYYY>",
    "number_format": "<e.g. 1.000,00>",
    "greeting_style": "<e.g. Sehr geehrte(r) {first_name},>",
    "sign_off": "<closing in local language>",
    "units": "<metric|imperial>",
    "measurement_notes": "<unit guidance for marina/boat context>"
  },
  "compliance": {
    "opt_out_language": "<unsubscribe text in local language>",
    "required_footer": "<footer text in local language>",
    "relevant_law": "<e.g. GDPR, CAN-SPAM, CASL>",
    "notes": "<key compliance requirements>"
  },
  "cultural_notes": "<2-3 sentences on marina industry culture and B2B decision-making in this country>"
}"""


# ── AI section generation (ICP / personas / messaging / email guidance) ──────

class GenerateSectionRequest(BaseModel):
    """Request for AI-generating a single section of a vertical / product pack.

    Either `vertical_id` and (optionally) `vendor_id` / `product_id` are passed
    so the server can load existing pack context, or `draft` overrides are
    passed directly (so the editor can preview generation before saving).
    """
    section: str  # "icp" | "personas" | "messaging" | "email_guidance"
    vertical_id: Optional[str] = None
    vendor_id: Optional[str] = None
    product_id: Optional[str] = None
    # Optional draft overrides — fields not yet saved that should bias the LLM.
    draft: Optional[dict] = None
    # Optional free-text steering ("emphasize counter-time pain", "tone: punchy").
    instructions: Optional[str] = None

    @field_validator("section")
    @classmethod
    def valid_section(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in {"icp", "personas", "messaging", "email_guidance"}:
            raise ValueError("section must be one of: icp, personas, messaging, email_guidance")
        return v


_SECTION_SCHEMA_HINTS: dict[str, str] = {
    "icp": """{
  "description": "<1 sentence on who this ICP targets and why>",
  "minimum_score": 0.55,
  "criteria": [
    {
      "field": "<prospect attribute name from industry_context, e.g. vehicle_count>",
      "operator": "<gte|lte|eq|in|any_of>",
      "value": <number | bool | string array>,
      "weight": <float, all weights must sum to 1.0>,
      "label": "<one sentence explaining WHY this signal matters for THIS product>"
    }
  ]
}""",
    "personas": """{
  "<persona_id>": {
    "titles": ["<job title>", "..."],
    "primary_motivators": ["<what they care about>", "..."],
    "communication_style": "<one sentence>",
    "value_props": [
      "<product-specific value prop 1>",
      "<product-specific value prop 2>",
      "<product-specific value prop 3>",
      "<product-specific value prop 4>"
    ],
    "objection_handles": {
      "<short objection key>": "<one sentence rebuttal>"
    }
  }
}""",
    "messaging": """{
  "elevator_pitch": "<2-3 sentences pitching the product to its primary buyer>",
  "category": "<short category label>",
  "differentiators": [
    "<verifiable differentiator 1>",
    "<verifiable differentiator 2>",
    "<verifiable differentiator 3>",
    "<verifiable differentiator 4>"
  ],
  "proof_points": ["<customer logo or named proof>", "..."]
}""",
    "email_guidance": """{
  "sequence_strategy": "<2 sentences describing the sequence pattern, e.g. Teach-Teach-Ask>",
  "subject_line_style": "<one sentence on subject line voice>",
  "cta_progression": [
    "<touch 1 CTA>",
    "<touch 2 CTA>",
    "<touch 3 CTA>"
  ],
  "avoid": [
    "<thing not to do 1>",
    "<thing not to do 2>",
    "<thing not to do 3>"
  ]
}""",
}


def _build_pack_context_for_generation(
    vertical_id: Optional[str],
    vendor_id: Optional[str],
    product_id: Optional[str],
    draft: Optional[dict],
) -> str:
    """Compose a compact context block from saved packs + any draft overrides."""
    pieces: list[str] = []

    vertical = pack_loader.load_vertical(vertical_id) if vertical_id else None
    vendor = pack_loader.load_vendor(vendor_id) if vendor_id else None
    product = pack_loader.load_product(product_id) if product_id else None

    # Apply draft overrides on top of whichever layer the section lives on.
    if draft:
        if draft.get("_layer") == "vertical" and vertical:
            vertical = {**vertical, **{k: v for k, v in draft.items() if not k.startswith("_")}}
        elif draft.get("_layer") == "vendor" and vendor:
            vendor = {**vendor, **{k: v for k, v in draft.items() if not k.startswith("_")}}
        elif draft.get("_layer") == "product" and product:
            product = {**product, **{k: v for k, v in draft.items() if not k.startswith("_")}}

    if vertical:
        ic = vertical.get("industry_context", {})
        if ic:
            pieces.append(
                "INDUSTRY CONTEXT:\n"
                f"- Summary: {ic.get('summary', '')}\n"
                f"- Key KPIs: {', '.join(ic.get('key_kpis', []))}\n"
                f"- Common pains: {'; '.join(ic.get('common_pains', []))}\n"
                f"- Buyer segments: {', '.join(s.get('label', '') for s in ic.get('buyer_segments', []))}\n"
                f"- Default unit label: {ic.get('default_unit_label', '')}"
            )
        if vertical.get("icp"):
            pieces.append(f"VERTICAL ICP (existing): {json.dumps(vertical.get('icp'), indent=2)}")

    if vendor:
        pieces.append(
            "VENDOR:\n"
            f"- Company: {vendor.get('company_name', '')}\n"
            f"- HQ / years: {vendor.get('headquarters', '')}, {vendor.get('years_in_business', '')}\n"
            f"- Customer logos: {', '.join(l.get('name', '') for l in vendor.get('customer_logos', []) if isinstance(l, dict))}\n"
            f"- Brand voice: {json.dumps(vendor.get('brand_voice', {}))}\n"
            f"- Summary: {vendor.get('company_summary', '')}"
        )

    if product:
        pieces.append(
            "PRODUCT:\n"
            f"- Name: {product.get('product_name', '')}\n"
            f"- Scope: {product.get('scope_summary', '')}\n"
            f"- Modules: {', '.join(product.get('modules', []))}"
        )
        if product.get("messaging_framework"):
            pieces.append(f"PRODUCT MESSAGING (existing): {json.dumps(product.get('messaging_framework'), indent=2)}")

    return "\n\n".join(pieces) if pieces else "(no prior context)"


@router.post("/packs/generate-section")
async def generate_pack_section_ai(payload: GenerateSectionRequest):
    """Use Claude to generate one section of a pack (ICP, personas, messaging, or email guidance)."""
    if payload.section not in _SECTION_SCHEMA_HINTS:
        raise HTTPException(status_code=400, detail=f"Unknown section '{payload.section}'")

    context = _build_pack_context_for_generation(
        payload.vertical_id, payload.vendor_id, payload.product_id, payload.draft,
    )

    section_label = {
        "icp": "ICP scoring criteria",
        "personas": "buyer personas",
        "messaging": "messaging framework (elevator pitch, differentiators, proof points)",
        "email_guidance": "email sequence guidance (strategy, subject style, CTAs, avoid list)",
    }[payload.section]

    extra = f"\n\nADDITIONAL INSTRUCTIONS:\n{payload.instructions}" if payload.instructions else ""

    prompt = (
        f"You are helping author a B2B sales pack. Generate the {section_label} section.\n\n"
        f"CONTEXT:\n{context}{extra}\n\n"
        f"Return ONLY valid JSON matching this exact schema (no extra text, no code fences):\n"
        f"{_SECTION_SCHEMA_HINTS[payload.section]}\n\n"
        "Be specific and grounded in the context above. Do not invent vendor capabilities, "
        "named integrations, or customer logos that are not present in the context. For ICP, "
        "ensure criteria weights sum to 1.0. For personas, return at least 2 distinct personas keyed "
        "by short snake_case ids. For messaging, only cite proof points that appear in the vendor "
        "context. For email guidance, provide concrete CTAs."
    )

    from app.agents.base import _anthropic_api_key
    client = anthropic.Anthropic(api_key=_anthropic_api_key())
    try:
        from app.agents.base import tracked_anthropic_create
        from app.services.llm_settings import get_active_model
        agent_name = f"pack_generate_{payload.section}"
        response = tracked_anthropic_create(
            client,
            agent=agent_name,
            model=get_active_model(agent_name),
            max_tokens=4096,
            temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise HTTPException(status_code=500, detail="AI did not return valid JSON")
        return json.loads(match.group())
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"AI response could not be parsed: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AI generation failed: {str(exc)[:120]}")


@router.post("/packs/regional/generate")
async def generate_regional_pack_ai(payload: GenerateRegionalRequest):
    """Use Claude to generate a suggested regional pack JSON for a given country."""
    from app.agents.base import _anthropic_api_key
    client = anthropic.Anthropic(api_key=_anthropic_api_key())

    prompt = (
        f"Generate a complete B2B sales outreach regional pack for: {payload.country.strip()}\n\n"
        f"Return ONLY valid JSON matching this exact schema (no extra text, no code fences):\n"
        f"{_REGIONAL_SCHEMA_HINT}\n\n"
        "Be accurate and specific: real public holidays, correct business hours, accurate legal "
        "requirements (GDPR for EU countries, etc.), culturally appropriate communication style, "
        "and practical marina/maritime industry context."
    )

    try:
        from app.agents.base import tracked_anthropic_create
        from app.services.llm_settings import get_active_model
        response = tracked_anthropic_create(
            client,
            agent="pack_generate_regional",
            model=get_active_model("pack_generate_regional"),
            max_tokens=4096,
            temperature=0.3,
            messages=[{"role": "user", "content": prompt}],
        )
        text = response.content[0].text
        # Strip optional markdown code fence
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise HTTPException(status_code=500, detail="AI did not return valid JSON")
        return json.loads(match.group())
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"AI response could not be parsed: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"AI generation failed: {str(exc)[:120]}")


# ── Write endpoints ───────────────────────────────────────────────────────────

@router.post("/packs/vertical", status_code=201)
async def create_vertical_pack(payload: VerticalPackWrite):
    if pack_loader.load_vertical(payload.pack_id):
        raise HTTPException(status_code=409, detail=f"Pack '{payload.pack_id}' already exists. Use PUT to update.")
    data = payload.model_dump()
    pack_loader.save_vertical(payload.pack_id, data)
    return data


@router.put("/packs/vertical/{pack_id}")
async def update_vertical_pack(pack_id: str, payload: VerticalPackWrite):
    if payload.pack_id != pack_id:
        raise HTTPException(status_code=400, detail="pack_id in body must match URL parameter")
    incoming = payload.model_dump()
    # For built-in vertical packs, deep-merge with the existing file so that
    # fields the UI builder doesn't expose (industry_context, terminology, etc.)
    # are preserved. Without this, editing via the Pack Builder strips those
    # keys and breaks the discovery agent.
    if pack_id in BUILTIN_VERTICALS:
        existing = pack_loader.load_vertical(pack_id) or {}
        # Merge: existing is the base, incoming overrides only the keys it sends
        # (excluding declared-but-None fields from the Pydantic model).
        non_null_incoming = {k: v for k, v in incoming.items() if v is not None}
        data = {**existing, **non_null_incoming}
    else:
        data = incoming
    pack_loader.save_vertical(pack_id, data)
    return data


@router.post("/packs/regional", status_code=201)
async def create_regional_pack(payload: RegionalPackWrite):
    if pack_loader.load_regional(payload.pack_id):
        raise HTTPException(status_code=409, detail=f"Pack '{payload.pack_id}' already exists. Use PUT to update.")
    data = payload.model_dump()
    pack_loader.save_regional(payload.pack_id, data)
    return data


@router.put("/packs/regional/{pack_id}")
async def update_regional_pack(pack_id: str, payload: RegionalPackWrite):
    if payload.pack_id != pack_id:
        raise HTTPException(status_code=400, detail="pack_id in body must match URL parameter")
    data = payload.model_dump()
    pack_loader.save_regional(pack_id, data)
    return data


@router.delete("/packs/vertical/{pack_id}", status_code=204)
async def delete_vertical_pack(pack_id: str):
    if pack_id in BUILTIN_VERTICALS:
        raise HTTPException(status_code=403, detail="Built-in packs cannot be deleted")
    if not pack_loader.delete_vertical(pack_id):
        raise HTTPException(status_code=404, detail=f"Pack '{pack_id}' not found")


# ── Vendor write endpoints ────────────────────────────────────────────────────

@router.post("/packs/vendor", status_code=201)
async def create_vendor_pack(payload: VendorPackWrite):
    if pack_loader.load_vendor(payload.pack_id):
        raise HTTPException(status_code=409, detail=f"Vendor pack '{payload.pack_id}' already exists. Use PUT to update.")
    data = payload.model_dump()
    pack_loader.save_vendor(payload.pack_id, data)
    return data


@router.put("/packs/vendor/{pack_id}")
async def update_vendor_pack(pack_id: str, payload: VendorPackWrite):
    if payload.pack_id != pack_id:
        raise HTTPException(status_code=400, detail="pack_id in body must match URL parameter")
    data = payload.model_dump()
    pack_loader.save_vendor(pack_id, data)
    return data


@router.delete("/packs/vendor/{pack_id}", status_code=204)
async def delete_vendor_pack(pack_id: str):
    if pack_id in BUILTIN_VENDORS:
        raise HTTPException(status_code=403, detail="Built-in vendor packs cannot be deleted")
    if not pack_loader.delete_vendor(pack_id):
        raise HTTPException(status_code=404, detail=f"Vendor pack '{pack_id}' not found")


# ── Product write endpoints ───────────────────────────────────────────────────

@router.post("/packs/product", status_code=201)
async def create_product_pack(payload: ProductPackWrite):
    if pack_loader.load_product(payload.pack_id):
        raise HTTPException(status_code=409, detail=f"Product pack '{payload.pack_id}' already exists. Use PUT to update.")
    if not pack_loader.load_vendor(payload.vendor_id):
        raise HTTPException(status_code=400, detail=f"Vendor '{payload.vendor_id}' does not exist")
    if not pack_loader.load_vertical(payload.vertical_id):
        raise HTTPException(status_code=400, detail=f"Vertical '{payload.vertical_id}' does not exist")
    data = payload.model_dump()
    pack_loader.save_product(payload.pack_id, data)
    return data


@router.put("/packs/product/{pack_id}")
async def update_product_pack(pack_id: str, payload: ProductPackWrite):
    if payload.pack_id != pack_id:
        raise HTTPException(status_code=400, detail="pack_id in body must match URL parameter")
    if not pack_loader.load_vendor(payload.vendor_id):
        raise HTTPException(status_code=400, detail=f"Vendor '{payload.vendor_id}' does not exist")
    if not pack_loader.load_vertical(payload.vertical_id):
        raise HTTPException(status_code=400, detail=f"Vertical '{payload.vertical_id}' does not exist")
    data = payload.model_dump()
    pack_loader.save_product(pack_id, data)
    return data


@router.delete("/packs/product/{pack_id}", status_code=204)
async def delete_product_pack(pack_id: str):
    if pack_id in BUILTIN_PRODUCTS:
        raise HTTPException(status_code=403, detail="Built-in product packs cannot be deleted")
    if not pack_loader.delete_product(pack_id):
        raise HTTPException(status_code=404, detail=f"Product pack '{pack_id}' not found")
