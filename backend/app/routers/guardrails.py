from fastapi import APIRouter
from pydantic import BaseModel
from typing import List
from app.services.guardrails_service import guardrails_service

router = APIRouter()


class GuardrailsUpdate(BaseModel):
    rules: List[str]
    notes: str = ""


@router.get("/guardrails")
def get_guardrails():
    return guardrails_service.load()


@router.put("/guardrails")
def update_guardrails(data: GuardrailsUpdate):
    return guardrails_service.save({"rules": data.rules, "notes": data.notes})
