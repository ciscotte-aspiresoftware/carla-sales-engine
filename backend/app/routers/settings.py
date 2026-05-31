"""
Settings router — exposes the runtime app-settings store to the UI.

Read endpoints return masked previews for secrets (never the full value).
Write endpoints encrypt secrets before persisting and take effect immediately
without a backend restart (integration adapters read DB-first via
`app_settings_service.get_or_env`).
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.services.app_settings_service import (
    SETTINGS_BY_KEY,
    app_settings_service,
)

router = APIRouter()


@router.get("/settings")
async def list_settings() -> dict:
    """Return one entry per known setting with masked values for secrets.
    Use this to drive the Settings page."""
    return {"settings": app_settings_service.list_for_ui()}


class SetSettingRequest(BaseModel):
    """One-key write. The frontend posts the new value verbatim; the backend
    encrypts it on the way to the DB if the SettingDef declares is_secret."""
    value: str

    @field_validator("value")
    @classmethod
    def trim(cls, v: str) -> str:
        # Trim whitespace but keep the value as-is otherwise — API keys often
        # have meaningful trailing punctuation we don't want to mangle.
        return v.strip()


@router.put("/settings/{key}")
async def set_setting(key: str, payload: SetSettingRequest) -> dict:
    if key not in SETTINGS_BY_KEY:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown setting key '{key}'. Valid keys: {sorted(SETTINGS_BY_KEY.keys())}",
        )
    if not payload.value:
        raise HTTPException(status_code=400, detail="value cannot be empty; use DELETE to clear")
    app_settings_service.set(key, payload.value)
    # Return the updated full list so the UI can reconcile in one round-trip.
    return {"settings": app_settings_service.list_for_ui()}


@router.delete("/settings/{key}")
async def delete_setting(key: str) -> dict:
    if key not in SETTINGS_BY_KEY:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown setting key '{key}'.",
        )
    app_settings_service.delete(key)
    return {"settings": app_settings_service.list_for_ui()}
