"""
In-memory pipeline progress store.
Safe because the background task runs in the same process/event loop as FastAPI.
"""
from typing import Optional

_progress: dict[int, dict] = {}


def set_progress(campaign_id: int, step: str, message: str, done: int = 0, total: int = 0) -> None:
    _progress[campaign_id] = {
        "step": step,
        "message": message,
        "done": done,
        "total": total,
    }


def get_progress(campaign_id: int) -> Optional[dict]:
    return _progress.get(campaign_id)


def clear_progress(campaign_id: int) -> None:
    _progress.pop(campaign_id, None)
