from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from app.agents.base import get_llm, format_pack_context, tracked_invoke
from app.packs.loader import pack_loader


# Per-vertical voice fragments authored by the pack maintainer in
# `backend/packs/prompts/<vertical>/<fragment>.md`. The copywriter picks
# whichever exist and renders them as a labelled block. Missing fragments
# fall through silently — pack authors only need to fill in the ones that
# matter for their vertical's voice.
PROMPT_FRAGMENTS = ("greeting", "rapport", "cta", "signoff")


def _assemble_prompt_fragments(vertical_id: str | None) -> str:
    if not vertical_id:
        return "(none — pack did not author voice fragments)"
    parts: list[str] = []
    for name in PROMPT_FRAGMENTS:
        body = pack_loader.load_prompt_fragment(vertical_id, name)
        if body:
            parts.append(f"- {name.upper()}:\n{body}")
    if not parts:
        return "(none — pack did not author voice fragments)"
    return "\n\n".join(parts)


# ── B2B copywriter (vertical SaaS — marina ERP, car rental management, etc.) ──

COPYWRITER_SYSTEM = """You are an elite B2B SaaS copywriter specializing in outbound sales for vertical market software. The active vertical, vendor, and product are described in the PRODUCT and INDUSTRY blocks below — anchor every claim there and use that vertical's terminology (e.g. "berths" for marinas, "vehicles" / "fleet" for car rental).
You write email sequences that feel human, relevant, and respect the reader's time.

{pack_context}

RESEARCH PROFILE FOR THIS PROSPECT:
- Hook line: {hook_line}
- Pain hypothesis: {pain_hypothesis}
- Credible detail: {credible_detail}
- Personalization notes: {personalization_notes}

CRITICAL — TRUST UPSTREAM, DON'T FABRICATE:
The research profile above has been written by an upstream agent that knows which prospect facts are VERIFIED (Tavily-confirmed or user-edited) versus UNVERIFIED (training-only estimates). You inherit its decisions:
- If the hook_line / pain_hypothesis already cites a specific number ("200 vehicles", "150 berths"), the upstream agent verified that number — keep it as written.
- If the hook_line hedges ("operations of your size", "a mid-size operation"), the upstream agent could not verify a specific count — DO NOT introduce a specific number anywhere in the body. Continue hedging.
- NEVER add a specific numeric count of the prospect's operation that wasn't already in the research profile. You don't have access to the verification map; your only safe move is to mirror what the researcher wrote.
- Industry-wide benchmarks ARE allowed and encouraged ("operators without unified booking spend 30%+ more counter time per transaction") — they're not specific to this prospect.
The recipient often knows their actual fleet size. A wrong specific number destroys credibility on the first sentence.

SEQUENCE STRATEGY: {sequence_strategy}
SUBJECT LINE STYLE: {subject_line_style}
CTA PROGRESSION: {cta_progression}
AVOID: {avoid_list}

PACK-AUTHORED VOICE FRAGMENTS (apply where natural — these capture the
vertical-specific tone the pack author wants the engine to use):
{prompt_fragments}

HOLIDAY & SCHEDULING CONSTRAINTS:
- No-send dates (do not schedule touches on these): {holiday_dates}
- Best send windows: {best_send_windows}
- Starting from today, calculate send_after_days for each touch.
  Touch 1 = 0 (send now). Each subsequent touch adds {touch_delay_days} days, skipping no-send dates.

Write a {num_touches}-touch email sequence. Each email must:
1. Reference the research profile hooks naturally — not as a list, woven into the prose
2. Be appropriately formal/informal per the regional tone guidance
3. Progress the conversation (teach → teach → ask pattern)
4. Include a clear but non-pushy CTA per the CTA progression
5. Be concise — no email should exceed 150 words in the body
6. Contain ZERO specific numeric counts of the prospect's operation (fleet size, berth count, etc.)

Return ONLY valid JSON:
{{
  "emails": [
    {{
      "touch_number": 1,
      "subject": "...",
      "body": "...",
      "persona_target": "...",
      "send_after_days": 0
    }},
    ...
  ]
}}"""

COPYWRITER_HUMAN = """Write the sequence for:
Name: {contact_name} ({contact_title})
Account: {account_name}
Location: {city}, {country_code}
ICP Score: {icp_score}

Return ONLY the JSON object."""


class CopywriterAgent:
    async def run(
        self,
        prospect: dict,
        research_profile: dict,
        vertical_pack: dict,
        regional_pack: dict,
        num_touches: int = 3,
        touch_delay_days: int = 3,
        holiday_dates: list[str] = None,
        campaign_id: int | None = None,
    ) -> dict:
        """Standard B2B sequence — vertical SaaS outbound."""
        llm = get_llm(temperature=0.8, agent="copywriter")

        prompt = ChatPromptTemplate.from_messages([
            ("system", COPYWRITER_SYSTEM),
            ("human", COPYWRITER_HUMAN),
        ])

        email_guidance = vertical_pack.get("email_guidance", {})
        scheduling = regional_pack.get("scheduling", {})

        vertical_id = vertical_pack.get("vertical_id") or vertical_pack.get("pack_id")
        result = await tracked_invoke(
            prompt | llm,
            {
                "pack_context": format_pack_context(vertical_pack, regional_pack),
                "hook_line": research_profile.get("hook_line", ""),
                "pain_hypothesis": research_profile.get("pain_hypothesis", ""),
                "credible_detail": research_profile.get("credible_detail", ""),
                "personalization_notes": research_profile.get("personalization_notes", ""),
                "sequence_strategy": email_guidance.get("sequence_strategy", "Teach-Teach-Ask"),
                "subject_line_style": email_guidance.get("subject_line_style", "conversational, under 50 chars"),
                "cta_progression": ", ".join(email_guidance.get("cta_progression", ["book a call"])),
                "avoid_list": ", ".join(email_guidance.get("avoid", [])),
                "prompt_fragments": _assemble_prompt_fragments(vertical_id),
                "holiday_dates": ", ".join(holiday_dates or []) or "none",
                "best_send_windows": ", ".join(scheduling.get("best_send_windows", ["Tue-Thu morning"])),
                "touch_delay_days": touch_delay_days,
                "num_touches": num_touches,
                "contact_name": prospect.get("contact_name", ""),
                "contact_title": prospect.get("contact_title", ""),
                "account_name": prospect.get("business_name", ""),
                "city": prospect.get("city", ""),
                "country_code": prospect.get("country_code", ""),
                "icp_score": prospect.get("icp_score", "N/A"),
            },
            agent="copywriter",
            campaign_id=campaign_id,
            prospect_id=prospect.get("id"),
            parser=JsonOutputParser(),
        )

        return result if isinstance(result, dict) else {"emails": []}


copywriter_agent = CopywriterAgent()
