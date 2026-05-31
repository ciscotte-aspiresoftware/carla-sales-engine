from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel, field_validator
from app.database import get_db, SessionLocal
from app.services.research_progress import get_progress, clear_progress
from app.config import settings

router = APIRouter()


# ── Discover endpoints ────────────────────────────────────────────────────────

VALID_SIZE_PREFERENCES = {"any", "small_independent", "established"}


def _valid_segment_types() -> set[str]:
    """Vertical pack ids currently on disk. Computed on each request so adding
    a new pack JSON surfaces immediately as a valid segment_type — no code
    change. Phase 5 of the vertical-agnostic refactor."""
    from app.packs.loader import pack_loader
    return set(pack_loader.list_available().get("vertical", []))


class DiscoverRequest(BaseModel):
    location: str
    country_code: str = "US"
    max_results: int = 5
    mode: str = "auto"  # "auto" | "tavily" | "claude"
    segment_type: str = "marina"  # vertical pack id; valid set = pack_loader.list_available()["vertical"]
    # When True, candidates with placeholder contacts ("General Manager / General Manager")
    # are saved with contact_quality="low" instead of being skipped. Useful for
    # locations where major-brand chains dominate web search results.
    include_low_confidence: bool = False
    size_preference: str = "any"

    @field_validator("max_results")
    @classmethod
    def clamp_max(cls, v: int) -> int:
        return max(3, min(10, v))

    @field_validator("location")
    @classmethod
    def clean_location(cls, v: str) -> str:
        return v.strip()[:100]

    @field_validator("mode")
    @classmethod
    def valid_mode(cls, v: str) -> str:
        return v if v in ("auto", "tavily", "claude") else "auto"

    @field_validator("segment_type")
    @classmethod
    def valid_segment(cls, v: str) -> str:
        valid = _valid_segment_types()
        if v not in valid:
            raise ValueError(f"Unknown segment_type: {v!r}. Valid options: {sorted(valid)}")
        return v

    @field_validator("size_preference")
    @classmethod
    def valid_size_preference(cls, v: str) -> str:
        return v if v in VALID_SIZE_PREFERENCES else "any"


# ── Wizard request models ─────────────────────────────────────────────────────

class DiscoverGenerateRequest(BaseModel):
    """Step 1 of the wizard — Claude lists candidates, no Tavily, no DB."""
    location: str
    country_code: str = "US"
    max_results: int = 10
    segment_type: str = "marina"
    size_preference: str = "any"

    @field_validator("max_results")
    @classmethod
    def clamp_max(cls, v: int) -> int:
        # Wizard allows up to 50; legacy one-shot endpoint stays clamped at 10.
        return max(1, min(50, v))

    @field_validator("location")
    @classmethod
    def clean_location(cls, v: str) -> str:
        return v.strip()[:100]

    @field_validator("segment_type")
    @classmethod
    def valid_segment(cls, v: str) -> str:
        valid = _valid_segment_types()
        if v not in valid:
            raise ValueError(f"Unknown segment_type: {v!r}. Valid options: {sorted(valid)}")
        return v

    @field_validator("size_preference")
    @classmethod
    def valid_size_preference(cls, v: str) -> str:
        return v if v in VALID_SIZE_PREFERENCES else "any"


class WizardCandidate(BaseModel):
    """A candidate the user has reviewed (and possibly edited / added) in the
    wizard. Only business_name and city are required; everything else is best-effort.

    confidence and notable_for are display-only — they're surfaced in the
    review table to help the user prune the list, but the enrich step doesn't
    consume them (Tavily snippets + the enrich prompt take over from there)."""
    business_name: str
    city: str
    country_code: str = "US"
    estimated_capacity: Optional[int] = None
    guessed_website: Optional[str] = None
    guessed_ownership_type: Optional[str] = None
    confidence: Optional[str] = None
    notable_for: Optional[str] = None
    planned_query: Optional[str] = None  # if user edited the Tavily query


class DiscoverEnrichSaveRequest(BaseModel):
    """Step 2 of the wizard — verify (Tavily) + enrich (Claude) + save (DB)."""
    location: str
    candidates: list[WizardCandidate]
    mode: str = "auto"
    segment_type: str = "marina"
    include_low_confidence: bool = False
    skipped_excluded: int = 0  # passthrough from generate so completion counts add up

    @field_validator("location")
    @classmethod
    def clean_location(cls, v: str) -> str:
        return v.strip()[:100]

    @field_validator("mode")
    @classmethod
    def valid_mode(cls, v: str) -> str:
        return v if v in ("auto", "tavily", "claude") else "auto"

    @field_validator("segment_type")
    @classmethod
    def valid_segment(cls, v: str) -> str:
        valid = _valid_segment_types()
        if v not in valid:
            raise ValueError(f"Unknown segment_type: {v!r}. Valid options: {sorted(valid)}")
        return v


class DiscoverSuggestCountRequest(BaseModel):
    """Mini-endpoint — Claude estimates a sensible result count for a location."""
    location: str
    country_code: str = "US"
    segment_type: str = "marina"
    size_preference: str = "any"

    @field_validator("location")
    @classmethod
    def clean_location(cls, v: str) -> str:
        return v.strip()[:100]

    @field_validator("segment_type")
    @classmethod
    def valid_segment(cls, v: str) -> str:
        valid = _valid_segment_types()
        if v not in valid:
            raise ValueError(f"Unknown segment_type: {v!r}. Valid options: {sorted(valid)}")
        return v

    @field_validator("size_preference")
    @classmethod
    def valid_size_preference(cls, v: str) -> str:
        return v if v in VALID_SIZE_PREFERENCES else "any"


async def _run_discovery_background(
    location: str, country_code: str, max_results: int, mode: str,
    segment_type: str = "marina",
    include_low_confidence: bool = False,
    size_preference: str = "any",
) -> None:
    from app.agents.discovery import discovery_agent
    from app.services.discovery_progress import set_progress
    db = SessionLocal()
    try:
        await discovery_agent.run_discovery(
            location, country_code, max_results, db,
            mode=mode, segment_type=segment_type,
            include_low_confidence=include_low_confidence,
            size_preference=size_preference,
        )
    except Exception as e:
        set_progress("error", f"Discovery failed: {str(e)[:120]}")
    finally:
        db.close()


@router.post("/agents/discover", status_code=202)
async def start_discovery(payload: DiscoverRequest, background_tasks: BackgroundTasks):
    from app.services.discovery_progress import get_progress, set_progress, clear_progress
    # Prevent concurrent runs
    current = get_progress()
    if current and current.get("step") not in ("idle", "complete", "error", None):
        raise HTTPException(status_code=409, detail="A discovery is already running.")
    # Reset transcript so the new run doesn't inherit events from the previous one.
    clear_progress()
    use_tavily = payload.mode == "tavily" or (payload.mode == "auto" and bool(settings.tavily_api_key))
    from app.agents.discovery import _segment_config
    label = _segment_config(payload.segment_type)["entity_label"]
    set_progress(
        "generating",
        f"Asking Claude about {label} in {payload.location}...",
        data_source="tavily" if use_tavily else "claude_knowledge",
    )
    background_tasks.add_task(
        _run_discovery_background,
        payload.location,
        payload.country_code,
        payload.max_results,
        payload.mode,
        payload.segment_type,
        payload.include_low_confidence,
        payload.size_preference,
    )
    return {"status": "started", "location": payload.location, "segment_type": payload.segment_type}


@router.get("/agents/discover/status")
async def discovery_status():
    from app.services.discovery_progress import get_progress
    progress = get_progress()
    if not progress:
        return {
            "step": "idle",
            "message": "",
            "found": 0,
            "total": 0,
            "data_source": None,
            "prospect_ids": [],
            "events": [],
            "tavily_available": bool(settings.tavily_api_key),
        }
    return {**progress, "tavily_available": bool(settings.tavily_api_key)}


# ── Wizard endpoints ──────────────────────────────────────────────────────────

@router.post("/agents/discover/suggest-count")
async def discover_suggest_count(payload: DiscoverSuggestCountRequest):
    """Tiny Claude call: estimate how many real operators it knows about in
    this location, scoped by size preference. Wizard uses this to pre-fill the
    result-count slider."""
    from app.agents.discovery import discovery_agent
    return await discovery_agent.suggest_count(
        location=payload.location,
        country_code=payload.country_code,
        segment_type=payload.segment_type,
        size_preference=payload.size_preference,
    )


@router.post("/agents/discover/generate")
async def discover_generate(payload: DiscoverGenerateRequest):
    """Wizard step 1 — return Claude's candidate list + the planned Tavily
    query for each. No Tavily calls, no DB writes. The user reviews / edits
    this list before kicking off enrich-save."""
    from app.agents.discovery import discovery_agent
    from app.services.discovery_progress import (
        clear_progress, get_progress, set_progress,
    )
    # Block only when a verify/enrich/save is mid-flight. ready_for_review is
    # allowed — the user is permitted to regenerate with tweaked params.
    current = get_progress()
    if current and current.get("step") not in (
        "idle", "complete", "error", "ready_for_review", None,
    ):
        raise HTTPException(status_code=409, detail="A discovery is already running.")
    # Fresh transcript for this wizard run.
    clear_progress()

    from app.agents.discovery import _segment_config
    label = _segment_config(payload.segment_type)["entity_label"]
    set_progress(
        "generating",
        f"Asking Claude about {label} in {payload.location} (size: {payload.size_preference}, up to {payload.max_results})...",
        data_source="tavily" if settings.tavily_api_key else "claude_knowledge",
    )
    try:
        result = await discovery_agent.generate_with_queries(
            location=payload.location,
            country_code=payload.country_code,
            max_results=payload.max_results,
            segment_type=payload.segment_type,
            size_preference=payload.size_preference,
        )
    except Exception as e:
        set_progress("error", f"Generate failed: {str(e)[:120]}")
        raise HTTPException(status_code=500, detail=f"Generate failed: {str(e)[:200]}")

    candidates = result["candidates"]
    n = len(candidates)
    excluded = result["skipped_excluded"]
    plural = "s" if n != 1 else ""
    excluded_note = f" (filtered {excluded} excluded)" if excluded else ""
    set_progress(
        "ready_for_review",
        f"Claude returned {n} candidate{plural}{excluded_note}. Review and edit before continuing.",
        found=0, total=n,
        data_source="tavily" if settings.tavily_api_key else "claude_knowledge",
        skipped_excluded=excluded,
    )
    return {
        "candidates": candidates,
        "skipped_excluded": result["skipped_excluded"],
        "size_preference": result["size_preference"],
        "size_focus": result["size_focus"],
        "tavily_available": bool(settings.tavily_api_key),
    }


async def _run_enrich_save_background(
    candidates: list[dict],
    location: str,
    mode: str,
    segment_type: str,
    include_low_confidence: bool,
    skipped_excluded: int,
) -> None:
    from app.agents.discovery import discovery_agent
    from app.services.discovery_progress import set_progress
    db = SessionLocal()
    try:
        await discovery_agent.verify_enrich_save_selected(
            candidates=candidates,
            location=location,
            db=db,
            mode=mode,
            segment_type=segment_type,
            include_low_confidence=include_low_confidence,
            skipped_excluded=skipped_excluded,
        )
    except Exception as e:
        set_progress("error", f"Enrich/save failed: {str(e)[:120]}")
    finally:
        db.close()


@router.post("/agents/discover/enrich-save", status_code=202)
async def discover_enrich_save(
    payload: DiscoverEnrichSaveRequest, background_tasks: BackgroundTasks,
):
    """Wizard step 2 — take user-reviewed candidates and run verify (Tavily) +
    enrich (Claude) + save (DB). Continues the transcript started by /generate."""
    from app.services.discovery_progress import get_progress
    current = get_progress()
    if current and current.get("step") not in (
        "idle", "complete", "error", "ready_for_review", "generating", None,
    ):
        raise HTTPException(status_code=409, detail="A discovery is already running.")

    candidates = [c.model_dump() for c in payload.candidates]
    background_tasks.add_task(
        _run_enrich_save_background,
        candidates,
        payload.location,
        payload.mode,
        payload.segment_type,
        payload.include_low_confidence,
        payload.skipped_excluded,
    )
    return {"status": "started", "candidate_count": len(candidates)}


async def _run_research_background(prospect_id: int) -> None:
    from app.agents.pipeline import run_research_for_prospect
    db = SessionLocal()
    try:
        await run_research_for_prospect(prospect_id, db)
    finally:
        db.close()


@router.post("/agents/research/{prospect_id}", status_code=202)
async def research_prospect(prospect_id: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from app.models.prospect import Prospect
    prospect = db.query(Prospect).filter(Prospect.id == prospect_id).first()
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")

    from app.services.research_progress import set_progress
    set_progress(prospect_id, "loading", f"Loading profile for {prospect.business_name}...")

    background_tasks.add_task(_run_research_background, prospect_id)
    return {"status": "started", "prospect_id": prospect_id}


@router.get("/agents/research/{prospect_id}/status")
async def research_status(prospect_id: int):
    progress = get_progress(prospect_id)
    if not progress:
        return {"step": "idle", "message": ""}
    return progress


# ── Website scraping endpoints ────────────────────────────────────────────────

from app.services.scrape_safety import MAX_PAGES_PER_SITE  # noqa: E402


class WebsiteScrapeOptions(BaseModel):
    """Per-request scrape parameters. Sensible defaults so callers can POST
    an empty body and get a homepage + about scrape."""
    max_pages: Optional[int] = None
    preferred_keywords: Optional[list[str]] = None

    @field_validator("max_pages")
    @classmethod
    def clamp_max_pages(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        return max(1, min(MAX_PAGES_PER_SITE, int(v)))

    @field_validator("preferred_keywords")
    @classmethod
    def clean_keywords(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return None
        cleaned = [k.strip().lower() for k in v if isinstance(k, str) and k.strip()]
        # Cap at 10 to avoid runaway prompt-injection vectors.
        return cleaned[:10] or None


class WebsiteScrapeBatchRequest(BaseModel):
    prospect_ids: list[int]
    max_pages: Optional[int] = None
    preferred_keywords: Optional[list[str]] = None

    @field_validator("prospect_ids")
    @classmethod
    def non_empty_capped(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("at least one prospect_id required")
        if len(v) > 25:
            raise ValueError("max 25 prospects per batch")
        seen: set[int] = set()
        out: list[int] = []
        for pid in v:
            if pid not in seen:
                seen.add(pid)
                out.append(pid)
        return out

    @field_validator("max_pages")
    @classmethod
    def clamp_max_pages(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        return max(1, min(MAX_PAGES_PER_SITE, int(v)))

    @field_validator("preferred_keywords")
    @classmethod
    def clean_keywords(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is None:
            return None
        cleaned = [k.strip().lower() for k in v if isinstance(k, str) and k.strip()]
        return cleaned[:10] or None


def _resolve_max_pages(requested: Optional[int]) -> int:
    """Settings-aware default. Router clamps to [1, MAX_PAGES_PER_SITE]."""
    if requested is not None:
        return requested
    try:
        from app.services.app_settings_service import app_settings_service
        raw = app_settings_service.get_or_env("website_scrape_default_max_pages")
        if raw:
            n = int(raw)
            return max(1, min(MAX_PAGES_PER_SITE, n))
    except Exception:
        pass
    return 2


async def _run_website_scrape_background(prospect_id: int, options: dict) -> None:
    from app.agents.pipeline import run_website_scrape_for_prospect
    db = SessionLocal()
    try:
        await run_website_scrape_for_prospect(prospect_id, db, options=options)
    except Exception:
        # Errors are recorded as ActivityEvent("website_scrape_failed") inside
        # the pipeline; swallow here to avoid background-task tracebacks
        # bringing down the worker.
        pass
    finally:
        db.close()


# NOTE: the /batch route must be declared BEFORE /{prospect_id}. FastAPI
# matches routes in declaration order; with the parametric route first,
# "batch" gets captured as `prospect_id` and the int-parse validation
# returns 422 before reaching the batch handler. (Same reason the GET
# /…/{prospect_id}/status route works fine — its path doesn't collide.)
@router.post("/agents/website-scrape/batch", status_code=202)
async def scrape_prospect_websites_batch(
    payload: WebsiteScrapeBatchRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Kick off scrapes for a batch of prospects. Skips IDs with no
    website_url (they'd just emit failure events). Returns the count
    actually enqueued."""
    from app.models.prospect import Prospect
    from app.services.website_scrape_progress import set_progress as set_scrape_progress

    prospects = (
        db.query(Prospect.id, Prospect.website_url, Prospect.business_name)
        .filter(Prospect.id.in_(payload.prospect_ids))
        .all()
    )
    enqueued: list[int] = []
    skipped: list[int] = []
    opts_base: dict = {}
    if payload.max_pages is not None:
        opts_base["max_pages"] = payload.max_pages
    if payload.preferred_keywords:
        opts_base["preferred_keywords"] = payload.preferred_keywords
    opts_base["max_pages"] = _resolve_max_pages(opts_base.get("max_pages"))

    for pid, url, name in prospects:
        if not url:
            skipped.append(pid)
            continue
        set_scrape_progress(pid, "queued", f"Queued scrape of {url}...")
        background_tasks.add_task(_run_website_scrape_background, pid, dict(opts_base))
        enqueued.append(pid)

    return {"started": len(enqueued), "enqueued_ids": enqueued, "skipped_ids": skipped, "options": opts_base}


@router.post("/agents/website-scrape/{prospect_id}", status_code=202)
async def scrape_prospect_website(
    prospect_id: int,
    payload: WebsiteScrapeOptions | None = None,
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db),
):
    from app.models.prospect import Prospect
    from app.services.website_scrape_progress import set_progress as set_scrape_progress

    prospect = db.query(Prospect).filter(Prospect.id == prospect_id).first()
    if not prospect:
        raise HTTPException(status_code=404, detail="Prospect not found")
    if not prospect.website_url:
        raise HTTPException(status_code=400, detail="Prospect has no website_url to scrape")

    opts = (payload.model_dump(exclude_none=True) if payload else {})
    opts["max_pages"] = _resolve_max_pages(opts.get("max_pages"))

    set_scrape_progress(prospect_id, "queued", f"Queued scrape of {prospect.website_url}...")
    background_tasks.add_task(_run_website_scrape_background, prospect_id, opts)
    return {"status": "started", "prospect_id": prospect_id, "options": opts}


@router.get("/agents/website-scrape/{prospect_id}/status")
async def website_scrape_status(prospect_id: int):
    from app.services.website_scrape_progress import get_progress as get_scrape_progress
    progress = get_scrape_progress(prospect_id)
    if not progress:
        return {"step": "idle", "message": ""}
    return progress


# ── Lite URL verification (no LLM, no full scrape) ──────────────────────────

class VerifyWebsitesBatchRequest(BaseModel):
    """Lite URL check for a batch of existing prospects. Caps at 50 IDs
    per call because each prospect is just one HTTP fetch + heuristic —
    much cheaper than the full scrape pipeline."""
    prospect_ids: list[int]

    @field_validator("prospect_ids")
    @classmethod
    def non_empty_capped(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("at least one prospect_id required")
        if len(v) > 50:
            raise ValueError("max 50 prospects per batch")
        seen: set[int] = set()
        out: list[int] = []
        for pid in v:
            if pid not in seen:
                seen.add(pid)
                out.append(pid)
        return out


@router.post("/agents/verify-websites/batch")
async def verify_websites_batch(
    payload: VerifyWebsitesBatchRequest,
    db: Session = Depends(get_db),
):
    """Run the lite URL verifier across a batch of prospects. Synchronous
    (verifier is cheap — no LLM call), so the caller gets the per-prospect
    outcome inline. Updates `website_research` + `provenance.website_url`
    and emits one `website_verified` / `website_verification_failed` /
    `website_needs_review` activity event per prospect.

    Concurrency is internally capped via the per-domain rate limiter; each
    HTTP fetch goes through the same provider as the full scrape pipeline.
    """
    import asyncio
    from app.models.prospect import Prospect
    from app.models.activity import ActivityEvent
    from app.services.website_url_check import check_website

    prospects = (
        db.query(Prospect)
        .filter(Prospect.id.in_(payload.prospect_ids))
        .all()
    )
    if not prospects:
        raise HTTPException(status_code=404, detail="No prospects found for the given ids")

    # Cap concurrency: 8 in-flight verifications at a time keeps wall-clock
    # reasonable for a 50-prospect run without bursting any one site (the
    # per-domain rate limiter already serialises same-domain hits).
    sem = asyncio.Semaphore(8)

    async def _verify(p: Prospect) -> dict:
        async with sem:
            url = (p.website_url or "").strip()
            if not url:
                return {
                    "prospect_id": p.id,
                    "status": "no_url",
                    "verified": False,
                    "reason": "empty_url",
                }
            try:
                result = await check_website(
                    url, p.business_name or "", p.city,
                )
            except Exception as exc:
                return {
                    "prospect_id": p.id,
                    "status": "error",
                    "verified": False,
                    "reason": "exception",
                    "message": str(exc)[:200],
                }
            return {
                "prospect_id": p.id,
                "status": "ok",
                "verified": bool(result.get("verified")),
                "reason": result.get("reason"),
                "_payload": result,
            }

    results = await asyncio.gather(*[_verify(p) for p in prospects])
    by_id = {r["prospect_id"]: r for r in results}

    # Apply results + emit activity events.
    summary = {"verified": 0, "needs_review": 0, "broken": 0, "no_url": 0, "errored": 0}
    for p in prospects:
        r = by_id.get(p.id)
        if not r:
            continue
        if r["status"] == "no_url":
            summary["no_url"] += 1
            db.add(ActivityEvent(
                prospect_id=p.id,
                event_type="website_verification_failed",
                event_data={"reason": "no_url"},
                is_simulated=False,
            ))
            continue
        if r["status"] == "error":
            summary["errored"] += 1
            db.add(ActivityEvent(
                prospect_id=p.id,
                event_type="website_verification_failed",
                event_data={"reason": "exception", "message": r.get("message")},
                is_simulated=False,
            ))
            continue

        result_payload = r["_payload"]
        meta = result_payload.get("meta") or {}
        provenance = dict(p.provenance or {})

        if result_payload.get("verified"):
            # Only promote provenance if it was previously unverified — never
            # downgrade a real source like "scrape" or "snippet".
            current = provenance.get("website_url")
            if current not in ("snippet", "user", "scrape"):
                provenance["website_url"] = "snippet" if current != "needs_review" else current
            # If it was previously "needs_review", clear it now that we've
            # confirmed the URL.
            if provenance.get("website_url") == "needs_review":
                provenance["website_url"] = "snippet"
            # Don't overwrite a full scrape payload with the lite verifier —
            # a scrape always wins.
            existing_kind = ((p.website_research or {}).get("meta") or {}).get("kind")
            if existing_kind != "scrape":
                p.website_research = result_payload
            p.provenance = provenance
            summary["verified"] += 1
            db.add(ActivityEvent(
                prospect_id=p.id,
                event_type="website_verified",
                event_data={
                    "url": p.website_url,
                    "canonical_url": meta.get("canonical_url"),
                    "confidence": meta.get("verification_confidence"),
                },
                is_simulated=False,
            ))
        elif meta.get("is_hard_fail"):
            # URL itself is broken — null it. Prospect stays; user must
            # supply a working URL before further work happens.
            provenance["website_url"] = "unknown"
            p.website_url = None
            existing_kind = ((p.website_research or {}).get("meta") or {}).get("kind")
            if existing_kind != "scrape":
                p.website_research = result_payload
            p.provenance = provenance
            summary["broken"] += 1
            db.add(ActivityEvent(
                prospect_id=p.id,
                event_type="website_verification_failed",
                event_data={
                    "reason": result_payload.get("reason"),
                    "message": result_payload.get("message"),
                },
                is_simulated=False,
            ))
        else:
            # Soft fail — name mismatch or low confidence. Keep URL, flag.
            provenance["website_url"] = "needs_review"
            existing_kind = ((p.website_research or {}).get("meta") or {}).get("kind")
            if existing_kind != "scrape":
                p.website_research = result_payload
            p.provenance = provenance
            summary["needs_review"] += 1
            db.add(ActivityEvent(
                prospect_id=p.id,
                event_type="website_needs_review",
                event_data={
                    "reason": result_payload.get("reason"),
                    "url": p.website_url,
                },
                is_simulated=False,
            ))

    db.commit()

    return {
        "summary": summary,
        "results": [
            {
                "prospect_id": r["prospect_id"],
                "status": r["status"],
                "verified": r["verified"],
                "reason": r.get("reason"),
            }
            for r in results
        ],
    }


@router.post("/agents/classify-reply")
async def classify_reply(reply_text: str, sequence_id: int, db: Session = Depends(get_db)):
    from app.agents.classifier import classifier_agent
    result = await classifier_agent.classify(reply_text, sequence_id, db)
    return result


# ── Standalone ICP scoring ────────────────────────────────────────────────────

class ScoreProspectsRequest(BaseModel):
    """Score a list of prospects against their vertical's ICP criteria.

    The same prospector agent that runs inside run_campaign_pipeline — exposed
    standalone so users can see ICP fit before committing to a campaign. Synchronous
    by design: a batch of up to 50 takes ~5-10s and the wizard wants the result inline.
    """
    prospect_ids: list[int]

    @field_validator("prospect_ids")
    @classmethod
    def non_empty_capped(cls, v: list[int]) -> list[int]:
        if not v:
            raise ValueError("at least one prospect_id required")
        if len(v) > 50:
            raise ValueError("max 50 prospects per call")
        # Dedup while preserving order
        seen: set[int] = set()
        out: list[int] = []
        for pid in v:
            if pid not in seen:
                seen.add(pid)
                out.append(pid)
        return out


@router.post("/agents/score-prospects")
async def score_prospects(payload: ScoreProspectsRequest, db: Session = Depends(get_db)):
    """Run the prospector against the given prospects, persist their icp_score
    (and icp_reasoning into research_profile), return the results."""
    from app.agents.prospector import prospector_agent
    from app.models.prospect import Prospect
    from app.packs.loader import pack_loader

    prospects = db.query(Prospect).filter(Prospect.id.in_(payload.prospect_ids)).all()
    if not prospects:
        raise HTTPException(status_code=404, detail="no prospects found for the given ids")

    # Group by vertical so a mixed-vertical batch (rare but possible — e.g. an
    # admin scoring across portfolios) still gets the right ICP criteria per group.
    by_vertical: dict[str, list[Prospect]] = {}
    for p in prospects:
        # vertical is required (Phase 4); skip rows missing it rather than silently default
        if not p.vertical:
            continue
        by_vertical.setdefault(p.vertical, []).append(p)

    regional_pack = pack_loader.load_regional("us_en")
    all_scored: list[dict] = []

    for vertical, ps in by_vertical.items():
        vertical_pack = pack_loader.compose_default(vertical)
        if not vertical_pack:
            # Skip the group rather than error — the rest can still be scored.
            continue
        pdicts = [{
            "id": p.id,
            "business_name": p.business_name,
            "capacity_count": p.capacity_count,
            "has_online_booking": p.has_online_booking,
            "tech_maturity_score": p.tech_maturity_score,
            "ownership_type": p.ownership_type,
            "services": p.services or [],
            "country_code": p.country_code,
        } for p in ps]
        try:
            scores = await prospector_agent.score_batch(pdicts, vertical_pack, regional_pack)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"prospector failed: {str(exc)[:200]}")

        score_map = {s["prospect_id"]: s for s in scores}
        for p in ps:
            s = score_map.get(p.id)
            if not s:
                continue
            p.icp_score = s["icp_score"]
            existing = p.research_profile or {}
            p.research_profile = {**existing, "icp_reasoning": s.get("icp_reasoning", "")}
            all_scored.append({
                "prospect_id": p.id,
                "icp_score": p.icp_score,
                "icp_reasoning": s.get("icp_reasoning", ""),
            })

    db.commit()
    return {"scores": all_scored}
