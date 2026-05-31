import json
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from app.agents.base import get_llm, format_pack_context, tracked_invoke


PROSPECTOR_SYSTEM = """You are a B2B sales operations expert in vertical market software (the active vertical is given below in the PRODUCT and INDUSTRY context).
Your job is to score prospects against an Ideal Customer Profile (ICP) and return a ranked list.

{pack_context}

ICP CRITERIA (each criterion has a weight):
{icp_criteria}

For each prospect, score 0.0-1.0 by evaluating how well they match each weighted criterion.
Be realistic — a perfect score is rare. Use the weights to calculate a weighted average.

Return ONLY valid JSON: an array of objects with these exact fields:
- prospect_id (integer)
- icp_score (float, 2 decimal places)
- icp_reasoning (string, 1 sentence explaining the score)
"""

PROSPECTOR_HUMAN = """Score these {count} prospects:

{prospects_json}

Return ONLY the JSON array. No markdown, no explanation."""


class ProspectorAgent:
    async def score_batch(
        self,
        prospects: list[dict],
        vertical_pack: dict,
        regional_pack: dict,
        campaign_id: int | None = None,
    ) -> list[dict]:
        """
        Scores a batch of prospects against the ICP criteria in the vertical pack.
        Returns list of {prospect_id, icp_score, icp_reasoning} dicts.
        Single LLM call for efficiency.
        """
        llm = get_llm(temperature=0.2, agent="prospector")

        icp_criteria_text = "\n".join([
            f"- {c['label']} (weight: {c['weight']}, field: {c['field']} {c['operator']} {c['value']})"
            for c in vertical_pack.get("icp", {}).get("criteria", [])
        ])

        pack_context = format_pack_context(vertical_pack, regional_pack)

        prompt = ChatPromptTemplate.from_messages([
            ("system", PROSPECTOR_SYSTEM),
            ("human", PROSPECTOR_HUMAN),
        ])

        # Slim down prospects for the prompt — only scoring-relevant fields.
        # Dict keys are vertical-neutral; the LLM doesn't need vertical-specific
        # names because the ICP criteria text already references the correct
        # field names per pack.
        slim_prospects = [
            {
                "prospect_id": p["id"],
                "business_name": p.get("business_name"),
                "capacity_count": p.get("capacity_count"),
                "has_online_booking": p.get("has_online_booking"),
                "tech_maturity_score": p.get("tech_maturity_score"),
                "ownership_type": p.get("ownership_type"),
                "services": p.get("services", []),
                "country_code": p.get("country_code"),
            }
            for p in prospects
        ]

        result = await tracked_invoke(
            prompt | llm,
            {
                "pack_context": pack_context,
                "icp_criteria": icp_criteria_text,
                "count": len(slim_prospects),
                "prospects_json": json.dumps(slim_prospects, indent=2),
            },
            agent="prospector",
            campaign_id=campaign_id,
            parser=JsonOutputParser(),
        )

        return result if isinstance(result, list) else []


prospector_agent = ProspectorAgent()
