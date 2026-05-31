"""
In-memory discovery progress store.

Single fixed key — only one discovery run at a time in the demo. Beyond the
"current snapshot" (step / message / counts), we also keep an append-only
`events` list so the frontend can render a persistent transcript of the run
instead of just the latest message.
"""
from datetime import datetime, timezone
from typing import Optional

_progress: dict[str, dict] = {}
DISCOVERY_KEY = "discovery"

# Cap event history per run. Long tavily/enrich loops can emit a lot of
# per-candidate messages; we keep the most recent N to bound memory.
MAX_EVENTS = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def set_progress(
    step: str,
    message: str,
    found: int = 0,
    total: int = 0,
    data_source: str = "tavily",
    prospect_ids: list = None,
    skipped_no_contact: int = 0,
    skipped_excluded: int = 0,
    skipped_duplicate: int = 0,
) -> None:
    existing = _progress.get(DISCOVERY_KEY) or {}
    events: list[dict] = list(existing.get("events") or [])

    # Append a new event for this transition. Deduplicate consecutive identical
    # (step, message) pairs to keep the transcript readable when an agent
    # re-emits the same status (e.g. a polled UI tick).
    if not events or events[-1].get("step") != step or events[-1].get("message") != message:
        events.append({
            "ts": _now(),
            "step": step,
            "message": message,
            "found": found,
            "total": total,
        })
        if len(events) > MAX_EVENTS:
            events = events[-MAX_EVENTS:]

    _progress[DISCOVERY_KEY] = {
        "step": step,
        "message": message,
        "found": found,
        "total": total,
        "data_source": data_source,
        "prospect_ids": prospect_ids or [],
        # Categorised skip counts — frontend uses these to render an accurate
        # completion message instead of guessing from (total - found).
        "skipped_no_contact": skipped_no_contact,
        "skipped_excluded": skipped_excluded,
        "skipped_duplicate": skipped_duplicate,
        # Persistent transcript so users can scroll back through what happened
        # during the run, even after the run completes.
        "events": events,
    }


def get_progress() -> Optional[dict]:
    return _progress.get(DISCOVERY_KEY)


def clear_progress() -> None:
    _progress.pop(DISCOVERY_KEY, None)
