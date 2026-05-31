"""
In-memory website scrape progress store, keyed by prospect_id.

Mirrors `research_progress.py`. Separate module so a scrape and a research
run for the same prospect don't share progress state.
"""
from typing import Optional

_progress: dict[int, dict] = {}


def set_progress(prospect_id: int, step: str, message: str) -> None:
    _progress[prospect_id] = {"step": step, "message": message}


def get_progress(prospect_id: int) -> Optional[dict]:
    return _progress.get(prospect_id)


def clear_progress(prospect_id: int) -> None:
    _progress.pop(prospect_id, None)
