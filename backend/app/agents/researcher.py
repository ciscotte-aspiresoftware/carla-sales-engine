import json
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from app.agents.base import get_llm, format_pack_context, tracked_invoke


RESEARCHER_SYSTEM = """You are an expert B2B sales researcher for vertical market software. The active vertical, product, and industry context are described in the PRODUCT and INDUSTRY blocks below — anchor every claim in those.
Given structured data about a prospect, you synthesize a concise personalization profile that a sales rep can use to write a highly relevant outbound email.

{pack_context}

Generate insights that feel like you've done real research — use the structured data to infer likely pain points, business context, and what would resonate with this specific contact. Use the industry's own terminology (e.g. "berths" for marinas, "vehicles" / "fleet" for car rental).

CRITICAL — DATA INTEGRITY POLICY:
The human prompt below tells you whether each numeric/text field is VERIFIED (came from live web snippets or a manual user edit) or UNVERIFIED (Claude training estimate). The rules:

- For VERIFIED facts (size, website, online-booking status): you MAY cite the specific value confidently. The recipient can verify it; we won't be lying.
- For UNVERIFIED facts: NEVER cite the specific value. Use general phrasings instead:
    "operations of your size", "a fleet your scale", "a mid-size operation", "multi-location operators".
- Sending a fabricated specific number ("200 vehicles", "150 berths") to an operator destroys credibility on the first sentence. Hedge when you don't know.
- When a "Website research (VERIFIED — scraped from the live site)" block is present, every fact in it is safe to cite — it came from the prospect's own website. You MAY quote up to 8 words verbatim from `key_quotes` inside `hook_line`; never invent quotes, never paraphrase quotes, never cite a competitor name in `hook_line`.

Return ONLY valid JSON with these exact fields:
- hook_line: A compelling 1-sentence opener. May cite verified facts confidently; hedge unverified ones with size-band phrasings. Max 30 words.
- pain_hypothesis: A 1-sentence hypothesis about their most likely operational pain. Same rule — verified facts only. Max 25 words.
- credible_detail: An industry-level data point or benchmark (e.g. "operators without unified booking spend 30%+ more counter time per transaction"). Industry stats are always allowed and don't need verification. Max 20 words.
- suggested_persona: Which persona to target — pick from the persona ids listed in the PERSONAS block above, based on the contact title.
- personalization_notes: A brief note for the copywriter about what tone and angle will resonate. Tell the copywriter explicitly which facts (if any) are verified and safe to use.
"""

RESEARCHER_HUMAN = """Prospect data (cross-reference each field against the verification map below):
{prospect_json}

Contact title: {contact_title}
Location: {city}, {country_code}
Operation size: {size_text}
Has online booking: {has_online_booking_text}
Tech maturity score: {tech_maturity_text}
Services offered: {services}
Ownership type: {ownership_type}

Verification map (the source recorded by discovery for each field):
{provenance_text}
{website_research_block}
Generate the personalization profile. Return ONLY valid JSON. Reminder: cite verified facts confidently, hedge unverified ones with size-band phrasings."""


# Fallback thresholds when a pack hasn't declared `size_band_thresholds` yet.
# Picked to match marina semantics (capacity ~50 = mid-size, ~250 = large).
_FALLBACK_BAND_THRESHOLDS = {"mid_min": 50, "large_min": 250}


def _size_band(size: int | None, vertical_pack: dict | None = None) -> str:
    """Bucket a raw capacity count into a coarse band so the researcher prompt
    has size-class signal without a falsifiable specific number.

    Reads `industry_context.size_band_thresholds` from the pack so adding a new
    vertical = a JSON edit, no code change. Falls back to marina-flavored
    thresholds if the pack hasn't declared its own."""
    if size is None:
        return "unknown"
    ic = (vertical_pack or {}).get("industry_context") or {}
    thresholds = ic.get("size_band_thresholds") or _FALLBACK_BAND_THRESHOLDS
    mid_min = thresholds.get("mid_min", _FALLBACK_BAND_THRESHOLDS["mid_min"])
    large_min = thresholds.get("large_min", _FALLBACK_BAND_THRESHOLDS["large_min"])
    if size < mid_min:
        return "small"
    if size < large_min:
        return "mid-size"
    return "large"


class ResearchAgent:
    async def run(self, prospect: dict, vertical_pack: dict, regional_pack: dict) -> dict:
        """
        Generates a personalization profile for a single prospect.
        Returns hook_line, pain_hypothesis, credible_detail, suggested_persona, personalization_notes.
        """
        llm = get_llm(temperature=0.75, agent="researcher")
        prompt = ChatPromptTemplate.from_messages([
            ("system", RESEARCHER_SYSTEM),
            ("human", RESEARCHER_HUMAN),
        ])

        services_str = ", ".join(prospect.get("services", []) or []) or "not specified"

        industry = vertical_pack.get("industry_context") or {}
        unit = industry.get("default_unit_label") or "units"

        provenance = prospect.get("provenance") or {}
        band = _size_band(prospect.get("capacity_count"), vertical_pack)

        # Per-field text — VERIFIED variants give Claude the specific value
        # and permission to cite it; UNVERIFIED variants strip the number.
        size_text = _verified_text(
            prospect.get("capacity_count"), provenance.get("capacity_count"),
            band_label=band, unit=unit,
        )
        booking_text = _verified_bool_text(
            prospect.get("has_online_booking"), provenance.get("has_online_booking"),
        )
        tech_text = _verified_int_text(
            prospect.get("tech_maturity_score"), provenance.get("tech_maturity_score"),
            suffix="/5",
        )

        # Strip raw numeric counts from the JSON dump — the model receives them
        # only via the verification-aware text fields above. Prevents the model
        # from quoting the count back even when provenance says unverified.
        scrubbed = {
            k: v for k, v in prospect.items()
            if k not in ("research_profile", "capacity_count", "tech_maturity_score", "has_online_booking", "provenance")
        }

        provenance_text = "\n".join(
            f"  - {field}: {provenance.get(field, 'unknown')}"
            for field in ("capacity_count", "website_url", "tech_maturity_score",
                          "has_online_booking", "services", "ownership_type")
        )

        # Strip raw website_research from the scrubbed JSON dump — the model
        # receives it via the dedicated structured block below (with the
        # safe-to-cite framing) instead of seeing the whole payload twice.
        scrubbed.pop("website_research", None)

        website_research_block = _format_website_research_block(
            prospect.get("website_research")
        )

        result = await tracked_invoke(
            prompt | llm,
            {
                "pack_context": format_pack_context(vertical_pack, regional_pack),
                "prospect_json": json.dumps(scrubbed, indent=2),
                "contact_title": prospect.get("contact_title", ""),
                "city": prospect.get("city", ""),
                "country_code": prospect.get("country_code", ""),
                "size_text": size_text,
                "has_online_booking_text": booking_text,
                "tech_maturity_text": tech_text,
                "services": services_str,
                "ownership_type": prospect.get("ownership_type", ""),
                "provenance_text": provenance_text,
                "website_research_block": website_research_block,
            },
            agent="researcher",
            prospect_id=prospect.get("id"),
            parser=JsonOutputParser(),
        )

        return result


# ── Verification-aware text builders ─────────────────────────────────────────

VERIFIED_SOURCES = {"snippet", "user", "scrape"}


def _verified_text(value, source: str | None, *, band_label: str, unit: str) -> str:
    """Format a numeric value for the prompt, signalling whether the model
    may cite it specifically (verified) or must hedge (unverified)."""
    if value is None:
        return f"unknown (size band: {band_label}) — UNVERIFIED, do NOT cite a specific number"
    if source in VERIFIED_SOURCES:
        return f"{value} {unit} — VERIFIED ({source}); you MAY cite this specific number confidently"
    return f"approximately {band_label} (size band) — UNVERIFIED training estimate; do NOT cite a specific count"


def _verified_bool_text(value, source: str | None) -> str:
    if value is None:
        return "unknown — UNVERIFIED"
    if source in VERIFIED_SOURCES:
        return f"{value} — VERIFIED ({source}); safe to reference"
    return f"{value} (UNVERIFIED training inference; treat as a hypothesis, not a fact)"


def _verified_int_text(value, source: str | None, *, suffix: str = "") -> str:
    if value is None:
        return "unknown — UNVERIFIED"
    if source in VERIFIED_SOURCES:
        return f"{value}{suffix} — VERIFIED ({source})"
    return f"{value}{suffix} (UNVERIFIED training inference)"


def _format_website_research_block(payload: dict | None) -> str:
    """Render the scraped website summary into a researcher-prompt block.

    Returns an empty string when no payload is present or the scrape didn't
    verify — the prompt template renders cleanly with the empty value.
    """
    if not payload or not payload.get("verified"):
        return ""

    summary = (payload.get("summary") or "").strip()
    services = ", ".join(payload.get("services_list") or [])
    pains = payload.get("pain_signals") or []
    competitors = payload.get("competitors_mentioned") or []
    quotes = payload.get("key_quotes") or []
    tech = payload.get("tech_stack_signals") or []

    lines: list[str] = [
        "",
        "Website research (VERIFIED — scraped from the live site, safe to cite):",
    ]
    if summary:
        lines.append(f"  Summary: {summary}")
    if services:
        lines.append(f"  Services on site: {services}")
    if tech:
        lines.append(f"  Tech-stack signals: {', '.join(tech)}")
    if pains:
        lines.append("  Pain signals (quoted from page):")
        for p in pains[:5]:
            lines.append(f"    - {p}")
    if competitors:
        lines.append(f"  Competitors mentioned on site: {', '.join(competitors)} (FYI — do NOT name these in hook_line)")
    if quotes:
        lines.append("  Verbatim quotes (you may use up to 8 consecutive words from these in hook_line):")
        for q in quotes[:3]:
            lines.append(f"    - \"{q.get('quote', '')}\" — {q.get('source_url', '')}")
    lines.append("")
    return "\n".join(lines)


research_agent = ResearchAgent()
