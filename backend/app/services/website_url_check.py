"""
Lite URL verification — confirms a prospect's website actually resolves and
plausibly belongs to the prospect, WITHOUT running the full multi-page
Claude-extraction pipeline.

Two callers:
  * Discovery enrich → catches dead / parked / mis-mapped URLs before a
    bogus prospect lands in the database.
  * Batch "Verify URLs" action → walks existing prospects and flags ones
    whose stored URL no longer resolves.

The payload returned is shape-compatible with `website_research` so the
prospect UI's existing renderer Just Works. A `meta.kind` discriminator
lets the frontend tell a lite verification record apart from a full scrape.
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.services.website_verifier import verify_website


# Reasons we treat as "definitely broken" — the URL itself is unusable.
# Discovery nulls the URL in this case. Anything else is a "soft" failure
# (we still keep the URL but flag it for human review).
HARD_FAIL_REASONS = frozenset({
    "http_error", "parked_domain", "empty_page",
    "empty_url", "provider_unavailable",
})


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def check_website(url: str, business_name: str, city: str | None = None) -> dict:
    """Run the verifier and shape the result into a `website_research`-style
    payload. Returns:

        {
            "verified": bool,
            "reason": str,
            "message": str | None,
            "summary": None, "services_list": [], "has_online_booking": None,
            "online_booking_url": None, "tech_stack_signals": [],
            "pain_signals": [], "competitors_mentioned": [], "key_quotes": [],
            "discovered_emails": [], "recommended_email": None,
            "recommended_email_rationale": None,
            "meta": {
                "kind": "verification",
                "provider": None,           # not tracked at this layer
                "robots_allowed": None,
                "pages_fetched": [<homepage>],
                "fetched_at": ISO timestamp,
                "scrape_version": 0,        # 0 marks "lite verification, no scrape"
                "verification_confidence": float,
                "canonical_url": str | None,
                "is_hard_fail": bool,       # true when URL itself is unusable
            },
        }
    """
    result = await verify_website(url, business_name, city)
    verified = bool(result.get("verified"))
    reason = result.get("reason") or "unknown"
    canonical = result.get("canonical_url")
    return {
        "verified": verified,
        "reason": reason,
        "message": result.get("message"),
        "summary": None,
        "services_list": [],
        "has_online_booking": None,
        "online_booking_url": None,
        "tech_stack_signals": [],
        "pain_signals": [],
        "competitors_mentioned": [],
        "key_quotes": [],
        "discovered_emails": [],
        "recommended_email": None,
        "recommended_email_rationale": None,
        "meta": {
            "kind": "verification",
            "provider": None,
            "robots_allowed": None,
            "pages_fetched": [canonical or url] if canonical or url else [],
            "fetched_at": _now_iso(),
            "scrape_version": 0,
            "verification_confidence": float(result.get("confidence") or 0.0),
            "canonical_url": canonical,
            "is_hard_fail": (not verified) and reason in HARD_FAIL_REASONS,
        },
    }


def is_hard_fail(payload: dict | None) -> bool:
    """True when the verifier's reason indicates the URL itself is broken
    (404, parked, unreachable) vs a soft failure (name mismatch). Callers
    use this to decide whether to null the URL or just flag for review."""
    if not payload:
        return False
    meta = payload.get("meta") or {}
    return bool(meta.get("is_hard_fail"))
