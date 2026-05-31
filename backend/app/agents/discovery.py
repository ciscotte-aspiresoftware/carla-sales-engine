"""
DiscoveryAgent — Claude-first, Tavily-verify prospect discovery.

Flow:
  1. generating  — Claude lists real named businesses in the location from training knowledge
  2. verifying   — Tavily searches for each named business to pull live website/contact snippets
  3. enriching   — Claude extracts structured contact + operational data from snippets
  4. saving      — DB write per prospect (partial results survive crashes)
  5. complete

Vertical-aware: dispatches on `segment_type` to use the right prompts, search
suffix, enrichment guidance, and prospect vertical. Per-vertical wording is
loaded from pack JSON (`industry_context.terminology` and
`industry_context.discovery_copy`) via `_segment_config_from_pack`. Adding a
new vertical is just a new pack JSON — no code change required.
"""
import asyncio
import re
from typing import Optional

from langchain_anthropic import ChatAnthropic
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from sqlalchemy.orm import Session

from app.agents.base import get_llm, tracked_invoke
from app.models.prospect import Prospect
from app.services.discovery_progress import set_progress

# Phase 7 of vertical-agnostic refactor: web search routes through the
# integrations registry (`app.integrations`). The legacy hard-wired Tavily
# call has been replaced. Add a new web-search provider in
# backend/app/integrations/ and register it — no edit to this file required.

# ── Discovery prompt templates (vertical-agnostic, pack-driven) ────────────────
#
# A single template per role drives every vertical. Per-vertical wording is
# substituted from `industry_context.terminology` and `industry_context.discovery_copy`
# in the pack JSON. Adding a new vertical = author its pack JSON; no code change.
#
# LLM-emitted JSON keys use the engine's neutral names (business_name,
# capacity_count) — they match the DB columns. The {{ ... }} double-braces are
# literal JSON examples that ChatPromptTemplate must not treat as variables.

GENERATE_SYSTEM_TEMPLATE = """You are a {industry_expert_role} with deep knowledge of real {entity_label} worldwide.

Your task: list real, named {entity_label} that you are HIGHLY CONFIDENT exist in the specified location.

Rules:
- Only include {entity_label} you are genuinely confident about. Do not invent names.
- {mix_guidance}
- {size_focus}
- If you genuinely know fewer than the requested number with high confidence, return only the ones you're sure of. Do not pad the list.
- Estimate {size_focus_label} based on your knowledge — use null if you are not sure.
- For website URLs, only provide if you are confident the domain is correct — otherwise null.
- ownership_type must be one of: {ownership_options_quoted}
- country_code must be ISO 3166-1 alpha-2 (e.g. {country_code_examples})

Return ONLY a valid JSON array. Each object must have exactly these fields:
- business_name (string, required — the operator's official name)
- city (string, required)
- country_code (string, required)
- estimated_capacity (integer or null — see size_focus_label above)
- guessed_website (string or null — domain only is fine, e.g. "operator-example.com")
- guessed_ownership_type (string: {ownership_options_quoted})
- confidence (string: "high", "medium", or "low" — your honest confidence that this operator exists at this location)
- notable_for (string, max ~10 words — one short phrase describing what they are known for)
"""

GENERATE_HUMAN_TEMPLATE = """Location: {location}
Country hint: {country_code}
Return up to: {max_results} {entity_label} (fewer is fine if your confidence runs out)
Do NOT include these (already customers / excluded): {exclude_list}

List the {entity_label}. Return ONLY the JSON array, nothing else."""


ENRICH_SYSTEM_TEMPLATE = """You are a B2B sales researcher extracting contact and operational details for {entity_label_singular}.

You are given:
- Claude's initial knowledge about this operator (name, city, estimated capacity, guessed website)
- Live web search snippets

Your task: extract the most accurate, complete information possible. Prefer live snippets over initial estimates, but fall back to estimates when snippets don't help.

Contact priority: {contact_priority}.

Email rules:
- Use a real email if visible in the snippets
- If not visible but you can see the domain, construct: manager@{{domain}} or info@{{domain}}
- Never invent a contact name — use "{default_contact_role}" if no name found in snippets
- Email must always be a plausible, deliverable format

CRITICAL — TRACK SOURCE OF EACH FIELD:
For every field below, also record where you got it:
- "snippet" — the value is supported by the live web snippets (you saw it, or strongly inferred it from concrete page content)
- "training" — you fell back to the initial estimate / your training knowledge because snippets didn't have it
- "unknown" — the field is null/empty because neither source had usable info

Return ONLY a valid JSON object with these exact fields:
- contact_name (string — real name from snippets, or "{default_contact_role}")
- contact_title (string)
- email (string — constructed from domain if needed)
- website_url (string or null — prefer real URL from snippets over initial guess)
- capacity_count (integer or null — {size_focus_label}; prefer number from snippets)
- services (array of strings from: {service_options_quoted})
- has_online_booking (boolean — true if snippets mention online booking, reservations, or a booking widget)
- tech_maturity_score (integer 1-5 — infer from digital presence: {tech_maturity_hint})
- ownership_type (string: {ownership_options_quoted})
- confidence (string: "high", "medium", or "low")
- enrichment_notes (string — one sentence on what was found and where)
- source_url (string or null — most useful URL from snippets)
- _provenance (object — required, one key per data field above where source matters):
    {{"capacity_count": "snippet" | "training" | "unknown",
     "website_url": "snippet" | "training" | "unknown",
     "tech_maturity_score": "snippet" | "training" | "unknown",
     "has_online_booking": "snippet" | "training" | "unknown",
     "services": "snippet" | "training" | "unknown",
     "ownership_type": "snippet" | "training" | "unknown"}}
"""

ENRICH_HUMAN_TEMPLATE = """Operator: {business_name}
City: {city}
Initial estimate — capacity: {estimated_capacity}, website: {guessed_website}, ownership: {guessed_ownership_type}

Live search snippets:
{snippets}

Extract the enriched data. Return ONLY the JSON object."""


# ── Size-preference fragments ─────────────────────────────────────────────────

# Inserted into the GENERATE_SYSTEM prompts at {size_focus}. Lets the user steer
# Claude toward small independents, established operators, or a mix.
SIZE_FOCUS_FRAGMENTS: dict[str, str] = {
    "any": (
        "Include a representative mix of operators across all sizes — small independents, "
        "regional operators, and well-known brands. Don't bias toward any size category."
    ),
    "small_independent": (
        "Focus specifically on smaller, independent, family-run operators. Avoid major brand "
        "chains and corporate franchise locations. Prioritise businesses that locals would "
        "recognise but that may not dominate web search results."
    ),
    "established": (
        "Focus on well-established operators with strong reputations — full-service businesses, "
        "regional chains, and brands with multiple locations or a long history in the area."
    ),
}

DEFAULT_SIZE_PREFERENCE = "any"


def _size_focus(size_preference: str) -> str:
    return SIZE_FOCUS_FRAGMENTS.get(size_preference) or SIZE_FOCUS_FRAGMENTS[DEFAULT_SIZE_PREFERENCE]


# ── Count-suggestion prompt ───────────────────────────────────────────────────

SUGGEST_COUNT_SYSTEM = """You estimate how many real, named businesses of a given type you would
confidently know about in a specific location. You are honest about the limits of your knowledge.

Rules:
- Return a single integer between 1 and 50.
- Base your estimate on how dense / well-known the location is and how much of the industry
  you have first-hand knowledge of.
- A small town with a couple of operators → 2-5. A major metro / well-known region → 15-30.
  Only suggest 30+ if the location is genuinely large or industry-dense (e.g. Florida marinas,
  Madrid car rentals).

Return ONLY valid JSON: {{"suggested": int, "reasoning": "one short sentence"}}
"""

SUGGEST_COUNT_HUMAN = """Industry: {entity_label}
Location: {location}, country hint: {country_code}
Size preference: {size_preference} ({size_focus})

How many real {entity_label} would you confidently know about in this location, given the
size preference? Return ONLY the JSON object."""


# ── Pack-driven segment config ────────────────────────────────────────────────
#
# The single GENERATE_SYSTEM_TEMPLATE / ENRICH_SYSTEM_TEMPLATE plus per-vertical
# variables drive every discovery run. `_segment_config_from_pack` builds a
# per-vertical config dict on demand by reading the pack JSON's
# `industry_context.terminology` and `industry_context.discovery_copy`.
#
# To add a new vertical: drop a new pack JSON in backend/packs/vertical/ with
# the required keys (see marina.json or car_rental.json as worked examples).
# No code change required.


def _quote_csv(items: list[str]) -> str:
    """Format a list as a quoted CSV — used inside prompts so Claude sees
    `"family", "corporate", "club"` rather than a Python list literal."""
    return ", ".join(f'"{x}"' for x in items)


def _segment_config_from_pack(vertical_id: str) -> dict:
    """Resolve a vertical id to the dict consumed by the discovery agent.

    Reads the pack JSON. Returns the legacy segment-config dict shape so call
    sites in `_generate_candidates`, `_enrich_candidate`, `_save_prospect`,
    etc. don't need to change.

    Raises ValueError if the pack is missing or doesn't have the required
    `industry_context.terminology` / `industry_context.discovery_copy` keys.
    """
    from app.packs.loader import pack_loader
    pack = pack_loader.load_vertical(vertical_id)
    if not pack:
        raise ValueError(
            f"No vertical pack named '{vertical_id}'. Available: "
            f"{sorted(pack_loader.list_available().get('vertical', []))}"
        )
    ic = pack.get("industry_context") or {}
    term = ic.get("terminology") or {}
    copy = ic.get("discovery_copy") or {}
    missing = [k for k in ("entity_label", "entity_label_singular", "default_contact_role",
                            "default_ownership_type", "fallback_email_domain") if not term.get(k)]
    if missing:
        raise ValueError(
            f"Pack '{vertical_id}' is missing industry_context.terminology keys: {missing}. "
            f"See marina.json / car_rental.json for required shape."
        )
    missing_copy = [k for k in ("industry_expert_role", "ownership_options", "search_suffix",
                                 "contact_priority", "service_options", "tech_maturity_hint",
                                 "size_focus_label", "country_code_examples") if not copy.get(k)]
    if missing_copy:
        raise ValueError(
            f"Pack '{vertical_id}' is missing industry_context.discovery_copy keys: {missing_copy}."
        )
    return {
        "vertical": vertical_id,
        # Terminology
        "entity_label": term["entity_label"],
        "entity_label_singular": term["entity_label_singular"],
        "default_contact_title": term["default_contact_role"],
        "default_ownership_type": term["default_ownership_type"],
        "fallback_email_domain": term["fallback_email_domain"],
        # Discovery copy
        "industry_expert_role": copy["industry_expert_role"],
        "ownership_options": copy["ownership_options"],
        "ownership_options_quoted": _quote_csv(copy["ownership_options"]),
        "search_suffix": copy["search_suffix"],
        "contact_priority": copy["contact_priority"],
        "service_options": copy["service_options"],
        "service_options_quoted": _quote_csv(copy["service_options"]),
        "tech_maturity_hint": copy["tech_maturity_hint"],
        "size_focus_label": copy["size_focus_label"],
        "country_code_examples": copy["country_code_examples"],
        "mix_guidance": copy.get("mix_guidance", ""),
    }


def _collect_vendor_exclusions(vertical_id: str) -> list[str]:
    """
    Aggregate excluded_customers across every vendor pack that targets this vertical.
    Names are normalised (lowercased, stripped) so the discovery filter can do a
    cheap substring/equality match against Claude's output.
    """
    from app.packs.loader import pack_loader
    names: set[str] = set()
    for vendor_id in pack_loader.list_available().get("vendor", []):
        v = pack_loader.load_vendor(vendor_id)
        if not v or vertical_id not in (v.get("verticals") or []):
            continue
        for entry in v.get("excluded_customers") or []:
            if isinstance(entry, dict) and entry.get("name"):
                names.add(str(entry["name"]).strip().lower())
            elif isinstance(entry, str):
                names.add(entry.strip().lower())
    return sorted(names)


def _is_excluded(name: str, exclusions: list[str]) -> bool:
    """Return True if `name` looks like one of the excluded entries.

    Substring match in either direction so 'Hertz Manhattan' matches an
    exclusion of 'Hertz' and a full name like 'Coffs Harbour Rent-A-Car'
    matches its exact entry.
    """
    if not name or not exclusions:
        return False
    n = name.strip().lower()
    return any(ex == n or ex in n or n in ex for ex in exclusions)


def _is_placeholder_contact(enriched: dict, fallback_title: str) -> bool:
    """
    True when Claude couldn't extract a real decision-maker and emitted the
    enricher's fallback. Two strong signals: contact_name is empty, or it
    matches contact_title verbatim (e.g. "General Manager" / "General Manager"),
    or it matches the segment's default fallback title exactly.
    """
    name = (enriched.get("contact_name") or "").strip().lower()
    title = (enriched.get("contact_title") or "").strip().lower()
    if not name:
        return True
    if title and name == title:
        return True
    if name == fallback_title.strip().lower():
        return True
    return False


def _segment_config(segment_type: str) -> dict:
    """Resolve segment_type → config. Pack-driven (Phase 5 of the
    vertical-agnostic refactor). The function name stays `_segment_config`
    because it's called from many places and the contract hasn't changed —
    only the implementation now reads pack JSON instead of a hardcoded dict."""
    return _segment_config_from_pack(segment_type)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_domain(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    match = re.search(r"https?://(?:www\.)?([^/\s]+)", url)
    return match.group(1) if match else None


def _build_query(candidate: dict, segment_type: str) -> str:
    """Compose the Tavily search query for a candidate. Used both at planning
    time (the wizard previews queries before running them) and at execution
    time (run_discovery / verify_enrich_save_selected) — single source of truth."""
    cfg = _segment_config(segment_type)
    name = candidate.get("business_name", "")
    city = candidate.get("city", "")
    return f'"{name}" {city} {cfg["search_suffix"]}'


def _format_snippets(results: list[dict]) -> str:
    parts = []
    for r in results:
        content = (r.get("content") or "")[:600]
        parts.append(
            f"URL: {r.get('url', 'unknown')}\n"
            f"Title: {r.get('title', '')}\n"
            f"Content: {content}"
        )
    return "\n\n---\n\n".join(parts) if parts else "No search results available."


SAVE_RESULT_SAVED = "saved"
SAVE_RESULT_DUPLICATE = "duplicate"
SAVE_RESULT_INVALID = "invalid"
SAVE_RESULT_ERROR = "error"


def _save_prospect(
    enriched: dict, db: Session, data_source: str,
    segment_type: str = "marina", state: Optional[str] = None,
    contact_quality: str = "ok",
    verification: Optional[dict] = None,
) -> tuple[Optional[int], str]:
    """
    Write one enriched prospect to the DB. Vertical-aware: the segment_type
    determines which vertical the prospect is saved under and the fallback
    contact title / email domain.

    Returns (prospect.id | None, status). Status is one of:
      "saved"      — successfully written
      "duplicate"  — same name+city or email already in DB
      "invalid"    — missing required fields
      "error"      — DB write failed

    contact_quality is stored in research_profile so the UI can show a
    "needs research" badge for prospects saved with placeholder contacts.

    `verification` is the lite-verifier result (see
    `app.services.website_url_check.check_website`). When present:
      * verified=True keeps the URL with provenance unchanged.
      * Hard-fail (HTTP error / parked / unreachable) nulls the URL and sets
        provenance to "unknown" — discovery shouldn't ship a dead URL.
      * Soft-fail (name mismatch / low confidence) keeps the URL but sets
        provenance to "needs_review" so the UI flags it for human check.
    The full payload is also persisted to `website_research` so the existing
    panel can render the result without a second backend call.
    """
    cfg = _segment_config(segment_type)

    business_name = (enriched.get("business_name") or "").strip()
    city = (enriched.get("city") or "").strip()
    email = (enriched.get("email") or "").strip().lower()

    if not business_name or not city or not email:
        return None, SAVE_RESULT_INVALID

    # Duplicate check — same name + city (case-insensitive)
    existing = (
        db.query(Prospect)
        .filter(Prospect.business_name.ilike(business_name), Prospect.city.ilike(city))
        .first()
    )
    if existing:
        return None, SAVE_RESULT_DUPLICATE

    # Email uniqueness — construct a fallback slug if needed
    email_final = email
    if db.query(Prospect).filter(Prospect.email == email).first():
        domain = email.split("@")[-1] if "@" in email else cfg["fallback_email_domain"]
        slug = re.sub(r"[^a-z0-9]", "", business_name.lower())[:12]
        email_final = f"contact+{slug}@{domain}"
        if db.query(Prospect).filter(Prospect.email == email_final).first():
            return None, SAVE_RESULT_DUPLICATE

    fallback_contact = cfg["default_contact_title"]

    # Provenance map — defaults conservative ("training" for fields where the
    # enricher had to fall back; "unknown" for nulls). The enricher's _provenance
    # object overrides these per-field when it returned one.
    enricher_prov = enriched.get("_provenance") or {}
    final_website = enriched.get("website_url") or enriched.get("guessed_website")
    provenance: dict[str, str] = {
        "capacity_count":
            enricher_prov.get("capacity_count")
            or ("training" if enriched.get("capacity_count") is not None else "unknown"),
        "website_url":
            enricher_prov.get("website_url")
            or ("training" if final_website else "unknown"),
        "tech_maturity_score":
            enricher_prov.get("tech_maturity_score")
            or ("training" if enriched.get("tech_maturity_score") is not None else "unknown"),
        "has_online_booking":
            enricher_prov.get("has_online_booking")
            or ("training" if "has_online_booking" in enriched else "unknown"),
        "services":
            enricher_prov.get("services")
            or ("training" if enriched.get("services") else "unknown"),
        "ownership_type":
            enricher_prov.get("ownership_type")
            or ("training" if enriched.get("ownership_type") else "unknown"),
    }
    # If the run was Claude-knowledge-only (no Tavily), every snippet-claim is
    # impossible by construction — clamp to training/unknown.
    if data_source == "claude_knowledge":
        for k in list(provenance):
            if provenance[k] == "snippet":
                provenance[k] = "training"

    # Apply the lite-verifier outcome (if discovery ran one). Soft-fail flags
    # the URL for human review; hard-fail nulls the URL entirely so we never
    # ship a dead link to downstream agents. See website_url_check for the
    # hard/soft taxonomy.
    website_research_payload: dict | None = None
    if verification is not None and final_website:
        website_research_payload = verification
        if verification.get("verified"):
            # Honest verification — leave provenance as-is; the URL is good.
            pass
        elif verification.get("meta", {}).get("is_hard_fail"):
            final_website = None
            provenance["website_url"] = "unknown"
        else:
            # Soft fail (name_mismatch / low confidence): keep the URL but
            # flag for human verification.
            provenance["website_url"] = "needs_review"

    prospect = Prospect(
        business_name=business_name,
        contact_name=enriched.get("contact_name") or fallback_contact,
        contact_title=enriched.get("contact_title") or fallback_contact,
        email=email_final,
        city=city,
        state=state,
        country_code=(enriched.get("country_code") or "US").upper()[:2],
        capacity_count=enriched.get("capacity_count"),
        services=enriched.get("services") or [],
        website_url=final_website,
        tech_maturity_score=enriched.get("tech_maturity_score"),
        has_online_booking=bool(enriched.get("has_online_booking", False)),
        ownership_type=enriched.get("ownership_type") or enriched.get("guessed_ownership_type") or cfg["default_ownership_type"],
        vertical=cfg["vertical"],
        icp_score=None,
        provenance=provenance,
        website_research=website_research_payload,
        research_profile={
            "discovery_source": data_source,
            "segment_type": segment_type,
            "contact_confidence": enriched.get("confidence", "low"),
            "contact_quality": contact_quality,  # "ok" | "low" — UI can flag low-quality contacts
            "enrichment_notes": enriched.get("enrichment_notes", ""),
            "source_url": enriched.get("source_url"),
        },
    )
    try:
        db.add(prospect)
        db.commit()
        db.refresh(prospect)
        return prospect.id, SAVE_RESULT_SAVED
    except Exception:
        db.rollback()
        return None, SAVE_RESULT_ERROR


# ── Agent class ───────────────────────────────────────────────────────────────

class DiscoveryAgent:

    async def _tavily_search(self, query: str, max_results: int = 5) -> list[dict]:
        """Web search for verification. Routed through the integrations registry
        (Phase 7 of vertical-agnostic refactor) so a portfolio receiving the
        zip can swap Tavily for Brave / You.com / etc. by registering a new
        `Capability.WEB_SEARCH` provider — no edit to this file required.

        Returns [] when no provider is configured, which lets discovery fall
        back to claude_knowledge mode without raising."""
        from app.integrations import registry, Capability
        providers = registry.by_capability(Capability.WEB_SEARCH, configured_only=True)
        if not providers:
            return []
        return await providers[0].search(query, max_results=max_results)

    async def _generate_candidates(
        self, location: str, country_code: str, max_results: int,
        segment_type: str = "marina",
        exclusions: Optional[list[str]] = None,
        size_preference: str = DEFAULT_SIZE_PREFERENCE,
    ) -> list[dict]:
        """Ask Claude to list real organisations it knows about in the location.
        Uses the GENERATE_SYSTEM_TEMPLATE plus per-vertical variables resolved
        from the pack JSON via `_segment_config_from_pack`."""
        cfg = _segment_config(segment_type)
        llm = get_llm(temperature=0.3, agent="discovery_generate")
        prompt = ChatPromptTemplate.from_messages([
            ("system", GENERATE_SYSTEM_TEMPLATE),
            ("human", GENERATE_HUMAN_TEMPLATE),
        ])

        invoke_args = {
            # Per-vertical (from pack)
            "industry_expert_role": cfg["industry_expert_role"],
            "entity_label": cfg["entity_label"],
            "ownership_options_quoted": cfg["ownership_options_quoted"],
            "country_code_examples": cfg["country_code_examples"],
            "size_focus_label": cfg["size_focus_label"],
            "mix_guidance": cfg["mix_guidance"],
            # Per-call
            "location": location,
            "country_code": country_code,
            "max_results": max_results,
            "exclude_list": ", ".join(exclusions) if exclusions else "none",
            "size_focus": _size_focus(size_preference),
        }

        result = await tracked_invoke(
            prompt | llm,
            invoke_args,
            agent="discovery_generate",
            parser=JsonOutputParser(),
        )
        return result if isinstance(result, list) else []

    async def _verify_candidate(self, candidate: dict, segment_type: str = "marina") -> dict:
        """
        Tavily search for this specific named organisation.
        Returns candidate dict with 'raw_snippets' added.

        Honours candidate["planned_query"] when present (the wizard pre-computes
        and may let the user edit it). Otherwise composes via _build_query.
        """
        query = candidate.get("planned_query") or _build_query(candidate, segment_type)

        try:
            results = await self._tavily_search(query, max_results=4)
        except Exception:
            results = []

        return {
            **candidate,
            "raw_snippets": _format_snippets(results),
            "source_url": results[0].get("url") if results else None,
        }

    async def _enrich_candidate(self, candidate: dict, segment_type: str = "marina") -> dict:
        """Claude extracts structured contact + operational data from Tavily snippets.
        Uses ENRICH_SYSTEM_TEMPLATE + per-vertical pack data."""
        cfg = _segment_config(segment_type)
        llm = get_llm(temperature=0.2, agent="discovery_enrich")
        prompt = ChatPromptTemplate.from_messages([
            ("system", ENRICH_SYSTEM_TEMPLATE),
            ("human", ENRICH_HUMAN_TEMPLATE),
        ])

        try:
            enriched = await tracked_invoke(
                prompt | llm,
                {
                    # Per-vertical (from pack)
                    "entity_label_singular": cfg["entity_label_singular"],
                    "default_contact_role": cfg["default_contact_title"],
                    "contact_priority": cfg["contact_priority"],
                    "ownership_options_quoted": cfg["ownership_options_quoted"],
                    "service_options_quoted": cfg["service_options_quoted"],
                    "tech_maturity_hint": cfg["tech_maturity_hint"],
                    "size_focus_label": cfg["size_focus_label"],
                    # Per-candidate
                    "business_name": candidate.get("business_name", ""),
                    "city": candidate.get("city", ""),
                    "estimated_capacity": candidate.get("estimated_capacity", "unknown"),
                    "guessed_website": candidate.get("guessed_website") or "unknown",
                    "guessed_ownership_type": candidate.get("guessed_ownership_type", cfg["default_ownership_type"]),
                    "snippets": candidate.get("raw_snippets", "No search results available."),
                },
                agent="discovery_enrich",
                parser=JsonOutputParser(),
            )
        except Exception:
            # Fallback contact if Claude call fails. Every numeric/text field
            # in this branch came from the original generate-step estimate, so
            # tag the provenance as "training" across the board.
            domain = _extract_domain(candidate.get("guessed_website")) or cfg["fallback_email_domain"]
            enriched = {
                "contact_name": cfg["default_contact_title"],
                "contact_title": cfg["default_contact_title"],
                "email": f"manager@{domain}",
                "website_url": candidate.get("guessed_website"),
                "capacity_count": candidate.get("estimated_capacity"),
                "services": [],
                "has_online_booking": False,
                "tech_maturity_score": None,
                "ownership_type": candidate.get("guessed_ownership_type", cfg["default_ownership_type"]),
                "confidence": "low",
                "enrichment_notes": "Enrichment failed — fallback contact used.",
                "source_url": candidate.get("source_url"),
                "_provenance": {
                    "capacity_count": "training" if candidate.get("estimated_capacity") is not None else "unknown",
                    "website_url": "training" if candidate.get("guessed_website") else "unknown",
                    "tech_maturity_score": "unknown",
                    "has_online_booking": "unknown",
                    "services": "unknown",
                    "ownership_type": "training" if candidate.get("guessed_ownership_type") else "unknown",
                },
            }

        return {**candidate, **enriched}

    async def generate_with_queries(
        self, location: str, country_code: str, max_results: int,
        segment_type: str = "marina",
        size_preference: str = DEFAULT_SIZE_PREFERENCE,
    ) -> dict:
        """
        Wizard step 1 — generate candidates only. No Tavily, no DB writes.

        Returns:
            {
              "candidates": [{...candidate, "planned_query": str}],
              "skipped_excluded": int,
              "exclusions": list[str],   # surfaced for transparency
              "size_preference": str,
              "size_focus": str,
            }

        Each candidate carries a `planned_query` field — the exact Tavily query
        that would be sent if the user clicks through to verify+enrich. The
        frontend can display these so the user sees what's about to be searched.
        """
        cfg = _segment_config(segment_type)
        exclusions = _collect_vendor_exclusions(cfg["vertical"])

        candidates = await self._generate_candidates(
            location, country_code, max_results,
            segment_type=segment_type, exclusions=exclusions,
            size_preference=size_preference,
        )

        skipped_excluded = 0
        if exclusions:
            before = len(candidates)
            candidates = [
                c for c in candidates
                if not _is_excluded(c.get("business_name", ""), exclusions)
            ]
            skipped_excluded = before - len(candidates)

        # Attach the planned Tavily query so the UI can show / let the user edit it.
        for c in candidates:
            c["planned_query"] = _build_query(c, segment_type)

        return {
            "candidates": candidates,
            "skipped_excluded": skipped_excluded,
            "exclusions": exclusions,
            "size_preference": size_preference,
            "size_focus": _size_focus(size_preference),
        }

    async def suggest_count(
        self, location: str, country_code: str,
        segment_type: str = "marina",
        size_preference: str = DEFAULT_SIZE_PREFERENCE,
    ) -> dict:
        """Ask Claude how many real operators it would confidently know about
        in this location, scoped by size preference. Used by the wizard to
        pre-fill the result-count slider with a sensible default."""
        cfg = _segment_config(segment_type)
        llm = get_llm(temperature=0.2, agent="discovery_suggest_count")
        prompt = ChatPromptTemplate.from_messages([
            ("system", SUGGEST_COUNT_SYSTEM),
            ("human", SUGGEST_COUNT_HUMAN),
        ])

        try:
            result = await tracked_invoke(
                prompt | llm,
                {
                    "entity_label": cfg["entity_label"],
                    "location": location,
                    "country_code": country_code,
                    "size_preference": size_preference,
                    "size_focus": _size_focus(size_preference),
                },
                agent="discovery_suggest_count",
                parser=JsonOutputParser(),
            )
        except Exception as e:
            return {"suggested": 10, "reasoning": f"(fallback — Claude call failed: {str(e)[:80]})"}

        suggested = int(result.get("suggested") or 10)
        suggested = max(1, min(50, suggested))
        return {
            "suggested": suggested,
            "reasoning": str(result.get("reasoning") or "")[:240],
        }

    async def verify_enrich_save_selected(
        self,
        candidates: list[dict],
        location: str,
        db: Session,
        mode: str = "auto",
        segment_type: str = "marina",
        include_low_confidence: bool = False,
        skipped_excluded: int = 0,
    ) -> dict:
        """
        Wizard step 2 — given a user-reviewed candidate list, run Tavily verify
        + Claude enrich + DB save. Pushes events to discovery_progress so the
        persistent transcript stays accurate.

        Also called by `run_discovery` for the legacy one-shot endpoint, so this
        is the single place the verify/enrich/save behaviour lives.
        """
        # Web search is enabled when (a) the caller asked for tavily/auto AND (b)
        # the integration registry has a configured WEB_SEARCH provider.
        from app.integrations import registry, Capability
        web_search_providers = registry.by_capability(Capability.WEB_SEARCH, configured_only=True)
        use_tavily = (mode == "tavily" or mode == "auto") and bool(web_search_providers)
        data_source = "tavily" if use_tavily else "claude_knowledge"

        cfg = _segment_config(segment_type)
        entity_label = cfg["entity_label"]

        if not candidates:
            set_progress(
                "complete",
                (
                    f"All candidates were already known to you "
                    f"({skipped_excluded} matched your vendor exclusion lists)."
                    if skipped_excluded
                    else f"No {entity_label} to verify."
                ),
                found=0, total=0, data_source=data_source,
                skipped_excluded=skipped_excluded,
            )
            return {
                "found": 0, "prospect_ids": [], "data_source": data_source,
                "skipped_no_contact": 0, "skipped_excluded": skipped_excluded, "skipped_duplicate": 0,
            }

        total = len(candidates)

        # ── VERIFYING (parallel, semaphore 3) ─────────────────────────────────
        verifying_label = (
            f"Searching Tavily for {total} {entity_label}..." if use_tavily
            else f"Skipping live search — using Claude knowledge for {total} {entity_label}..."
        )
        set_progress("verifying", verifying_label, found=0, total=total, data_source=data_source)

        semaphore = asyncio.Semaphore(3)
        verified: list[dict] = [{}] * total

        async def verify_one(candidate: dict, idx: int) -> None:
            async with semaphore:
                name = candidate.get("business_name", f"{cfg['entity_label_singular']} {idx + 1}")
                if use_tavily:
                    query = candidate.get("planned_query") or _build_query(candidate, segment_type)
                    set_progress(
                        "verifying",
                        f'Tavily: searching {query} ({idx + 1}/{total})...',
                        found=0, total=total, data_source=data_source,
                    )
                    result = await self._verify_candidate(candidate, segment_type=segment_type)
                else:
                    result = {**candidate, "raw_snippets": "No live search — using Claude knowledge only.", "source_url": None}
                verified[idx] = result
                if use_tavily:
                    set_progress(
                        "verifying",
                        f"Tavily: verified {name} ({idx + 1}/{total})",
                        found=0, total=total, data_source=data_source,
                    )

        await asyncio.gather(*[verify_one(c, i) for i, c in enumerate(candidates)])

        # ── ENRICHING + VERIFYING (parallel, semaphore 3) ─────────────────────
        # Phase 1 of the enrich-save split: run Claude enrichment + lite URL
        # verification concurrently per candidate. Both are network-bound
        # (LLM + HTTP), and they're independent across candidates, so a
        # 25-candidate batch that used to take 25× (enrich + verify) now
        # runs in ~ceil(25/3) × (enrich + verify).
        from app.services.website_url_check import check_website

        enrich_verify_sem = asyncio.Semaphore(3)
        completed_enrich = 0

        async def enrich_and_verify(candidate: dict, idx: int) -> tuple[Optional[dict], Optional[dict]]:
            nonlocal completed_enrich
            async with enrich_verify_sem:
                name = candidate.get("business_name", f"{cfg['entity_label_singular']} {idx + 1}")
                try:
                    enriched_local = await self._enrich_candidate(candidate, segment_type=segment_type)
                except Exception as exc:
                    print(f"[discovery] enrich failed for {name}: {exc}")
                    return None, None

                # Kick off the verifier concurrently with the per-candidate
                # progress message — both are quick to schedule.
                verification_local: Optional[dict] = None
                candidate_url = (enriched_local.get("website_url") or enriched_local.get("guessed_website") or "").strip()
                if candidate_url:
                    try:
                        verification_local = await check_website(
                            candidate_url,
                            enriched_local.get("business_name") or name,
                            enriched_local.get("city"),
                        )
                    except Exception as exc:
                        print(f"[discovery] verifier failed for {name}: {exc}")

                completed_enrich += 1
                set_progress(
                    "enriching",
                    f"Enriched + verified {completed_enrich}/{total}…",
                    found=0, total=total, data_source=data_source,
                )
                return enriched_local, verification_local

        enrich_results: list[tuple[Optional[dict], Optional[dict]]] = await asyncio.gather(
            *[enrich_and_verify(c, i) for i, c in enumerate(verified)],
        )

        # ── SAVING (sequential) ──────────────────────────────────────────────
        # DB writes stay serial: unique-email collisions need fallback logic
        # that's awkward to interleave, and the per-row work is cheap.
        found = 0
        skipped_no_contact = 0
        skipped_duplicate = 0
        prospect_ids: list[int] = []

        for idx, candidate in enumerate(verified):
            if not candidate:
                continue
            name = candidate.get("business_name", f"{cfg['entity_label_singular']} {idx + 1}")
            enriched, verification = enrich_results[idx]
            if enriched is None:
                continue

            is_placeholder = _is_placeholder_contact(enriched, cfg["default_contact_title"])
            if is_placeholder and not include_low_confidence:
                skipped_no_contact += 1
                set_progress(
                    "saving",
                    f"Skipping {name} — couldn't extract a real contact.",
                    found=found, total=total, data_source=data_source,
                    skipped_no_contact=skipped_no_contact,
                    skipped_excluded=skipped_excluded,
                    skipped_duplicate=skipped_duplicate,
                )
                continue

            contact_quality = "low" if is_placeholder else "ok"

            set_progress(
                "saving",
                f"Saving {name}...",
                found=found, total=total, data_source=data_source,
                skipped_no_contact=skipped_no_contact,
                skipped_excluded=skipped_excluded,
                skipped_duplicate=skipped_duplicate,
            )
            pid, status = _save_prospect(
                enriched, db, data_source,
                segment_type=segment_type, state=location,
                contact_quality=contact_quality,
                verification=verification,
            )
            if status == SAVE_RESULT_SAVED and pid is not None:
                found += 1
                prospect_ids.append(pid)
            elif status == SAVE_RESULT_DUPLICATE:
                skipped_duplicate += 1

        # ── COMPLETE ──────────────────────────────────────────────────────────
        parts: list[str] = []
        if skipped_no_contact:
            parts.append(f"{skipped_no_contact} skipped (no real contact)")
        if skipped_excluded:
            parts.append(f"{skipped_excluded} excluded (existing customers)")
        if skipped_duplicate:
            parts.append(f"{skipped_duplicate} already in DB")
        suffix = f" — {', '.join(parts)}" if parts else ""

        set_progress(
            "complete",
            f"Discovery complete — {found} {entity_label} added{suffix}.",
            found=found, total=total, data_source=data_source,
            prospect_ids=prospect_ids,
            skipped_no_contact=skipped_no_contact,
            skipped_excluded=skipped_excluded,
            skipped_duplicate=skipped_duplicate,
        )
        return {
            "found": found,
            "skipped_no_contact": skipped_no_contact,
            "skipped_excluded": skipped_excluded,
            "skipped_duplicate": skipped_duplicate,
            "prospect_ids": prospect_ids,
            "data_source": data_source,
        }

    async def run_discovery(
        self, location: str, country_code: str, max_results: int, db: Session,
        mode: str = "auto",
        segment_type: str = "marina",
        include_low_confidence: bool = False,
        size_preference: str = DEFAULT_SIZE_PREFERENCE,
    ) -> dict:
        """
        Legacy one-shot orchestration: generate → verify → enrich → save in a
        single call. The wizard splits this into two endpoints; this method
        composes the same primitives so the legacy /agents/discover endpoint
        keeps working unchanged.
        """
        # Web search is enabled when (a) the caller asked for tavily/auto AND (b)
        # the integration registry has a configured WEB_SEARCH provider.
        from app.integrations import registry, Capability
        web_search_providers = registry.by_capability(Capability.WEB_SEARCH, configured_only=True)
        use_tavily = (mode == "tavily" or mode == "auto") and bool(web_search_providers)
        data_source = "tavily" if use_tavily else "claude_knowledge"

        cfg = _segment_config(segment_type)
        entity_label = cfg["entity_label"]

        set_progress("generating", f"Asking Claude about {entity_label} in {location}...", data_source=data_source)

        try:
            generated = await self.generate_with_queries(
                location, country_code, max_results,
                segment_type=segment_type,
                size_preference=size_preference,
            )
        except Exception as e:
            set_progress("complete", f"Failed to generate candidates: {str(e)[:80]}", data_source=data_source)
            return {"found": 0, "prospect_ids": [], "data_source": data_source}

        candidates = generated["candidates"]
        skipped_excluded = generated["skipped_excluded"]

        if skipped_excluded > 0:
            set_progress(
                "generating",
                f"Filtered out {skipped_excluded} excluded customer{'s' if skipped_excluded != 1 else ''} from results...",
                data_source=data_source,
                skipped_excluded=skipped_excluded,
            )

        result = await self.verify_enrich_save_selected(
            candidates, location, db,
            mode=mode, segment_type=segment_type,
            include_low_confidence=include_low_confidence,
            skipped_excluded=skipped_excluded,
        )
        return {
            "found": result["found"],
            "skipped_no_contact": result["skipped_no_contact"],
            "skipped_excluded": result["skipped_excluded"],
            "skipped_duplicate": result["skipped_duplicate"],
            "prospect_ids": result["prospect_ids"],
            "data_source": result["data_source"],
        }


discovery_agent = DiscoveryAgent()
