"""
Guardrails service — loads and saves the guardrails.json file.
Rules are injected into every agent prompt so they apply globally.
"""
import json
from pathlib import Path

GUARDRAILS_PATH = Path(__file__).parent.parent.parent / "packs" / "guardrails.json"


class GuardrailsService:
    def load(self) -> dict:
        if not GUARDRAILS_PATH.exists():
            return {"rules": [], "notes": ""}
        with open(GUARDRAILS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)

    def save(self, data: dict) -> dict:
        with open(GUARDRAILS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return data

    def get_rules_text(self) -> str:
        """Returns rules as a formatted block for injection into LLM prompts."""
        data = self.load()
        rules = data.get("rules", [])
        if not rules:
            return ""
        lines = "\n".join(f"- {r}" for r in rules)
        return f"\nCOPYWRITING GUARDRAILS (strictly follow these rules in all output):\n{lines}\n"


guardrails_service = GuardrailsService()
