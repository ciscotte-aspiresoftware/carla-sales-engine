"""
WebsiteEnrichmentAgent — scrapes a prospect's website (homepage + selected
inner pages) and extracts a structured payload Claude can cite from.

Pipeline:
  1. `verify_website` (catches parked / wrong-company / dead URLs)
  2. robots.txt check + per-domain rate limiting
  3. `select_pages` from the homepage HTML (reuses the verifier's fetched body)
  4. Fetch the rest concurrently, capped pages + capped bytes per page
  5. Concatenate markdown with `## SOURCE: <url>` separators, cap at 50 KB
  6. Single Claude call → strict JSON schema
  7. Reconcile competitor mentions against the pack-provided list (substring
     match via `_is_excluded` from discovery.py — no hallucinated competitors)

The agent is provenance-aware but does NOT touch Prospect rows directly; the
pipeline layer (`pipeline.py:run_website_scrape_for_prospect`) reads this
agent's payload and decides what to write back + which provenance keys to
promote to "scrape".
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from selectolax.parser import HTMLParser
import tldextract

from app.agents.base import get_llm, format_pack_context, tracked_invoke
from app.agents.discovery import _is_excluded
from app.services.scrape_provider import pick_scrape_provider
from app.services.scrape_safety import (
    MAX_BYTES_PER_PAGE,
    MAX_PAGES_PER_SITE,
    domain_rate_limiter,
    get_user_agent,
    robots_cache,
)
from app.services.site_planner import select_pages
from app.services.website_verifier import verify_website


SCRAPE_VERSION = 1

# Total markdown sent to Claude across all pages. Beyond this we truncate
# trailing content. Picked so the prompt stays well under Sonnet's 200K ctx
# while leaving room for the system prompt + pack context.
MAX_TOTAL_MARKDOWN_CHARS = 50_000

# Concurrency cap for inner-page fetches per prospect. Combined with the
# per-domain rate limiter this also caps real wire traffic.
INNER_PAGE_CONCURRENCY = 3


WEBSITE_ENRICHMENT_SYSTEM = """You are a B2B sales researcher analysing a prospect's own website to extract verifiable facts for a sales outreach campaign.

{pack_context}

You will receive concatenated markdown from the prospect's homepage and a few selected inner pages (each clearly demarcated by `## SOURCE: <url>` headings). Your job: extract a structured JSON payload that captures what the site itself says, using the site's own words where possible.

CRITICAL RULES:
- Only report facts that are clearly stated on the page. If a page does not mention online booking, set `has_online_booking` to null — do NOT guess.
- For `services_list`, prefer terms from the vertical's service vocabulary (in the PRODUCT/INDUSTRY context above) when they match what the site offers. Add site-specific services only if no vocab term fits.
- For `competitors_mentioned`, ONLY list names you see verbatim on the page. We provide a small candidate list of known competitor names; restrict your output to that list, but case-insensitive. If you don't see any of them, return an empty list.
- For `key_quotes`, copy verbatim text from the markdown (≤120 chars each, no paraphrasing, no edits, no ellipsis). Always include the exact `source_url` from the nearest `## SOURCE:` heading above the quote.
- Keep `summary` to 3-5 sentences. Operator-facing, factual, no marketing fluff.
- `pain_signals` are short phrases the page itself uses that imply manual operations, dated tools, or recent investment (e.g. "call to enquire", "fax us your booking", "hand-written waiting list"). Do not invent.
- `tech_stack_signals` are concrete vendor/tool names mentioned on the site (e.g. "Stripe", "Calendly", "WordPress", "Shopify"). Empty list if none observed.

EMAIL CANDIDATES:
We deterministically extracted every email address that appears in the scraped pages (`mailto:` links and visible text). You CANNOT add new email addresses — only pick from this list. For each candidate we tell you the source page and the text immediately surrounding it ("context").

The prospect's contact role to target is:
  Contact name: {contact_name}
  Contact title: {contact_title}

Each candidate also carries a `deliverable` flag (true / false / unchecked) — the result of an MX/A DNS check on the address's domain. Only `deliverable: true` addresses can actually receive mail; everything else either has no mail config or the domain doesn't resolve.

Your job: pick the SINGLE best email for reaching this contact, ranking on:
  1. **Deliverability** — if any deliverable candidate exists, NEVER recommend an undeliverable one. Mail to an undeliverable address bounces.
  2. Local part contains the contact's first or last name → strongest signal.
  3. Local part or surrounding context names a role matching the contact title (e.g. owner/manager/director/dockmaster/dealer principal).
  4. Department / role addresses (sales@, info@, contact@, hello@) — usable when nothing better exists.
  5. Avoid: no-reply / noreply / do-not-reply / postmaster / abuse / webmaster.
Return null for `recommended_email` ONLY if every candidate is undeliverable, on the "Avoid" list above, or the candidate list is empty.

CANDIDATE EMAILS (already extracted from the scraped pages — pick from these, NEVER invent new ones):
{email_candidates_block}

CANDIDATE COMPETITOR NAMES (only list these if you see them verbatim on the site, case-insensitive):
{competitor_candidates}

EVIDENCE MAP:
Alongside the extracted facts, return an `evidence` object that records WHICH PAGE each fact came from. For every item in `services_list`, `pain_signals`, `competitors_mentioned`, and `tech_stack_signals`, give the verbatim source URL (must be one of the `## SOURCE:` URLs above). For `has_online_booking`, give the URL of the page where you concluded the value (or null if you couldn't decide). The map keys must match the items verbatim. Hallucinated URLs will be discarded — only URLs listed in the `## SOURCE:` headings are accepted.

Return ONLY valid JSON with exactly these fields:
{{
  "summary": str,
  "services_list": [str, ...],
  "has_online_booking": true | false | null,
  "online_booking_url": str | null,
  "tech_stack_signals": [str, ...],
  "pain_signals": [str, ...],
  "competitors_mentioned": [str, ...],
  "key_quotes": [{{"quote": str, "source_url": str}}, ...],
  "evidence": {{
    "services_list":         {{"<item>": "<source_url>", ...}},
    "pain_signals":          {{"<item>": "<source_url>", ...}},
    "competitors_mentioned": {{"<item>": "<source_url>", ...}},
    "tech_stack_signals":    {{"<item>": "<source_url>", ...}},
    "has_online_booking":    "<source_url>" | null
  }},
  "recommended_email": str | null,
  "recommended_email_rationale": str
}}"""


WEBSITE_ENRICHMENT_HUMAN = """Prospect: {business_name} ({city}, {country_code})
Vertical: {vertical_id}

Pages scraped ({n_pages}):
{page_list}

Concatenated page markdown:
---
{markdown}
---

Extract the JSON payload now. Return ONLY the JSON — no preamble, no postscript. Remember: `recommended_email` MUST come from the CANDIDATE EMAILS list verbatim (or be null), and `recommended_email_rationale` is one short sentence (≤25 words)."""


class WebsiteEnrichmentAgent:
    async def run(
        self,
        prospect: dict,
        vertical_pack: dict,
        regional_pack: dict,
        vendor_pack: dict | None = None,
        options: dict | None = None,
    ) -> dict:
        """Returns a payload conforming to the shape documented at the top of
        `models/prospect.py`'s `website_research` field.

        On verification failure or robots block the payload still includes
        `verified` and `meta`, but most fact fields are empty — callers should
        check `verified` (and `scrape_blocked` if present) before promoting
        provenance.
        """
        options = options or {}
        max_pages = max(1, min(int(options.get("max_pages", 2) or 2), MAX_PAGES_PER_SITE))
        preferred_keywords = options.get("preferred_keywords") or None

        url = (prospect.get("website_url") or "").strip()
        business_name = prospect.get("business_name") or ""
        city = prospect.get("city") or ""
        vertical_id = prospect.get("vertical") or vertical_pack.get("vertical_id") or ""

        if not url:
            return _failure_payload("no_website_url", provider=None)

        # 1. Verify the URL belongs to this prospect.
        verifier = await verify_website(url, business_name, city)
        provider_name = "unknown"
        try:
            provider_name = pick_scrape_provider().name
        except Exception:
            pass

        if not verifier.get("verified"):
            return {
                "verified": False,
                "reason": verifier.get("reason") or "unknown",
                "message": verifier.get("message"),
                "summary": None,
                "services_list": [],
                "has_online_booking": None,
                "online_booking_url": None,
                "tech_stack_signals": [],
                "pain_signals": [],
                "competitors_mentioned": [],
                "key_quotes": [],
                "evidence": _empty_evidence(),
                "discovered_emails": [],
                "recommended_email": None,
                "recommended_email_rationale": None,
                "meta": {
                    "provider": provider_name,
                    "robots_allowed": None,
                    "pages_fetched": [],
                    "fetched_at": _now_iso(),
                    "scrape_version": SCRAPE_VERSION,
                    "verification_confidence": verifier.get("confidence", 0.0),
                    "canonical_url": verifier.get("canonical_url"),
                },
            }

        homepage_url = verifier.get("canonical_url") or url
        homepage_html = verifier.get("fetched_html") or ""
        homepage_markdown = verifier.get("fetched_markdown") or ""

        # 2. Robots.txt check for the homepage. If the homepage itself is
        # disallowed, the verifier already fetched it but we still respect
        # the policy for any further pages — and we mark scrape_blocked so
        # the pipeline can emit a distinct activity event.
        homepage_allowed = await robots_cache.allows(homepage_url, get_user_agent())

        # 3. Pick inner pages and fetch them. Keep HTML alongside markdown so
        # we can extract <a href="mailto:..."> links deterministically below.
        inner_pages: list[str] = []
        pages: list[dict] = [{
            "url": homepage_url,
            "html": homepage_html,
            "markdown": homepage_markdown,
        }]
        if homepage_allowed and max_pages > 1:
            candidates = select_pages(
                homepage_html,
                homepage_url,
                max_pages=max_pages,
                preferred_keywords=preferred_keywords,
            )
            inner_pages = [u for u in candidates if u != homepage_url]
            if inner_pages:
                fetched = await _fetch_inner_pages(inner_pages)
                pages.extend(fetched)

        # 4. Concatenate, cap at MAX_TOTAL_MARKDOWN_CHARS.
        joined = _join_markdown([(p["url"], p["markdown"]) for p in pages])
        if len(joined) > MAX_TOTAL_MARKDOWN_CHARS:
            joined = joined[:MAX_TOTAL_MARKDOWN_CHARS]

        # 5. Competitor candidates from the active vendor pack.
        vendor_id = (vendor_pack or {}).get("vendor_id")
        competitor_candidates = _collect_competitor_signals(vertical_id, vendor_id)

        # 6. Deterministically extract email candidates from each page. Claude
        # only ever picks FROM this list — it never invents one.
        contact_name = prospect.get("contact_name") or ""
        contact_title = prospect.get("contact_title") or ""
        site_domain = _registrable(homepage_url)
        email_candidates = _extract_email_candidates(
            pages,
            site_domain=site_domain,
            contact_name=contact_name,
            contact_title=contact_title,
        )

        # 6b. DNS-verify each candidate. Cheap (~50ms per unique domain,
        # cached across the batch). Surfaces parked / expired / typo'd
        # domains so the UI can mark which addresses can actually receive
        # mail. Undeliverable addresses also lose their score so the
        # ranked list and Claude's recommendation prefer reachable ones.
        from app.services.email_verifier import verify_emails
        try:
            verification_results = await verify_emails([c["email"] for c in email_candidates])
        except Exception as exc:
            print(f"[website_enrichment] email DNS verify failed: {exc}")
            verification_results = {}
        for c in email_candidates:
            v = verification_results.get(c["email"]) or {"verified": False, "status": "unchecked", "detail": None}
            c["deliverable"] = bool(v.get("verified"))
            c["deliverability_status"] = v.get("status") or "unchecked"
            c["deliverability_detail"] = v.get("detail")
            # Penalise undeliverable so they sink in the ranked list; only
            # the recommend step uses the score, the original extraction
            # order is preserved otherwise.
            if not c["deliverable"]:
                c["score"] = c["score"] - 20
        email_candidates.sort(key=lambda e: (-e["score"], e["email"]))

        # 7. Single Claude call.
        llm = get_llm(temperature=0.3, agent="website_enrichment")
        prompt = ChatPromptTemplate.from_messages([
            ("system", WEBSITE_ENRICHMENT_SYSTEM),
            ("human", WEBSITE_ENRICHMENT_HUMAN),
        ])
        pages_fetched = [p["url"] for p in pages]
        result = await tracked_invoke(
            prompt | llm,
            {
                "pack_context": format_pack_context(vertical_pack, regional_pack),
                "competitor_candidates": ", ".join(competitor_candidates) if competitor_candidates else "(none configured)",
                "email_candidates_block": _format_email_candidates_for_prompt(email_candidates),
                "contact_name": contact_name or "(none on file)",
                "contact_title": contact_title or "(none on file)",
                "business_name": business_name,
                "city": city,
                "country_code": prospect.get("country_code", ""),
                "vertical_id": vertical_id,
                "n_pages": len(pages_fetched),
                "page_list": "\n".join(f"  - {u}" for u in pages_fetched),
                "markdown": joined,
            },
            agent="website_enrichment",
            prospect_id=prospect.get("id"),
            parser=JsonOutputParser(),
        )

        # 8. Reconcile competitor mentions — drop anything Claude returned
        # that isn't in our candidate list (case-insensitive substring).
        raw_competitors = result.get("competitors_mentioned") or []
        confirmed_competitors = _filter_competitors(raw_competitors, competitor_candidates)

        # 9. Clamp key_quotes (Claude sometimes ignores the 120-char limit).
        quotes = []
        for q in (result.get("key_quotes") or [])[:8]:
            if not isinstance(q, dict):
                continue
            quote = (q.get("quote") or "").strip()
            src = (q.get("source_url") or "").strip()
            if not quote or not src:
                continue
            if len(quote) > 120:
                quote = quote[:120].rstrip() + "…"
            quotes.append({"quote": quote, "source_url": src})

        # 10. Reconcile recommended email: only trust an LLM pick that exists
        # verbatim in our extracted candidate list (case-insensitive). Anything
        # else means hallucination — drop to null.
        recommended_email = _reconcile_recommended_email(
            result.get("recommended_email"), email_candidates,
        )
        recommended_rationale = (result.get("recommended_email_rationale") or "").strip() or None

        # 11. Validate the evidence map — only keep per-item URLs that exist
        # in our actual `pages_fetched` set, and only for items that survived
        # the post-validation above. Drops Claude-hallucinated sources.
        evidence = _sanitise_evidence(
            result.get("evidence"),
            allowed_urls=set(pages_fetched),
            services=_as_str_list(result.get("services_list")),
            pain_signals=_as_str_list(result.get("pain_signals")),
            competitors=confirmed_competitors,
            tech_stack=_as_str_list(result.get("tech_stack_signals")),
        )

        return {
            "verified": True,
            "reason": "ok",
            "scrape_blocked": None if homepage_allowed else "robots_txt",
            "summary": (result.get("summary") or "").strip() or None,
            "services_list": _as_str_list(result.get("services_list")),
            "has_online_booking": _as_bool_or_none(result.get("has_online_booking")),
            "online_booking_url": _as_str_or_none(result.get("online_booking_url")),
            "tech_stack_signals": _as_str_list(result.get("tech_stack_signals")),
            "pain_signals": _as_str_list(result.get("pain_signals")),
            "competitors_mentioned": confirmed_competitors,
            "key_quotes": quotes,
            "evidence": evidence,
            "discovered_emails": email_candidates,
            "recommended_email": recommended_email,
            "recommended_email_rationale": recommended_rationale,
            "meta": {
                "provider": provider_name,
                "robots_allowed": homepage_allowed,
                "pages_fetched": pages_fetched,
                "fetched_at": _now_iso(),
                "scrape_version": SCRAPE_VERSION,
                "verification_confidence": verifier.get("confidence", 0.0),
                "canonical_url": verifier.get("canonical_url"),
            },
        }


async def _fetch_inner_pages(urls: list[str]) -> list[dict]:
    """Fetch each URL via the picked provider, gated by robots + rate limit.
    Returns [{url, html, markdown}, ...]. Failures are silently skipped — the
    LLM call still runs on the homepage if every inner page fails.
    """
    provider = pick_scrape_provider()
    sem = asyncio.Semaphore(INNER_PAGE_CONCURRENCY)
    ua = get_user_agent()

    async def _one(u: str) -> dict | None:
        async with sem:
            if not await robots_cache.allows(u, ua):
                return None
            crawl_delay = await robots_cache.crawl_delay(u, ua)
            try:
                async with domain_rate_limiter.gate(u, extra_delay=crawl_delay):
                    payload = await provider.scrape(u)
            except Exception:
                return None
            data = payload.get("data") or {}
            md = (data.get("markdown") or "").strip()
            html = data.get("html") or ""
            if not md and not html:
                return None
            # Cap per-page markdown.
            if len(md) > MAX_BYTES_PER_PAGE:
                md = md[:MAX_BYTES_PER_PAGE]
            final_url = (data.get("metadata") or {}).get("finalUrl") or u
            return {"url": final_url, "html": html, "markdown": md}

    results = await asyncio.gather(*[_one(u) for u in urls])
    return [r for r in results if r is not None]


def _join_markdown(pages: list[tuple[str, str]]) -> str:
    parts: list[str] = []
    for (url, md) in pages:
        parts.append(f"## SOURCE: {url}\n\n{md.strip()}")
    return "\n\n---\n\n".join(parts)


def _collect_competitor_signals(vertical_id: str, vendor_id: str | None) -> list[str]:
    """Aggregate `competitor_signals` from every vendor pack targeting the
    active vertical. When a specific vendor_id is given, that vendor's list
    is prioritised (placed first) but other same-vertical vendors are still
    included — they often share competitor catalogues.
    """
    from app.packs.loader import pack_loader

    primary: list[str] = []
    other: list[str] = []
    for vid in pack_loader.list_available().get("vendor", []):
        v = pack_loader.load_vendor(vid)
        if not v:
            continue
        if vertical_id and vertical_id not in (v.get("verticals") or []):
            continue
        for entry in v.get("competitor_signals") or []:
            if isinstance(entry, dict) and entry.get("name"):
                name = str(entry["name"]).strip()
            elif isinstance(entry, str):
                name = entry.strip()
            else:
                continue
            if not name:
                continue
            target = primary if (vendor_id and vid == vendor_id) else other
            if name.lower() not in {x.lower() for x in target}:
                target.append(name)

    seen: set[str] = set()
    result: list[str] = []
    for n in [*primary, *other]:
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(n)
    return result


def _filter_competitors(llm_output: list, candidate_names: list[str]) -> list[str]:
    """Keep only LLM-reported names that match (substring, case-insensitive)
    one of the pack-provided candidate names. Returns the canonical
    candidate name (i.e. the pack's spelling) so the UI is stable."""
    if not llm_output or not candidate_names:
        return []
    candidates_lower = [c.lower() for c in candidate_names]
    out: list[str] = []
    seen: set[str] = set()
    for raw in llm_output:
        if not isinstance(raw, str):
            continue
        n = raw.strip().lower()
        if not n:
            continue
        for canon_lower, canon in zip(candidates_lower, candidate_names):
            if _is_excluded(n, [canon_lower]):
                if canon not in seen:
                    out.append(canon)
                    seen.add(canon)
                break
    return out


def _failure_payload(reason: str, *, provider: str | None) -> dict:
    return {
        "verified": False,
        "reason": reason,
        "summary": None,
        "services_list": [],
        "has_online_booking": None,
        "online_booking_url": None,
        "tech_stack_signals": [],
        "pain_signals": [],
        "competitors_mentioned": [],
        "key_quotes": [],
        "evidence": _empty_evidence(),
        "discovered_emails": [],
        "recommended_email": None,
        "recommended_email_rationale": None,
        "meta": {
            "provider": provider,
            "robots_allowed": None,
            "pages_fetched": [],
            "fetched_at": _now_iso(),
            "scrape_version": SCRAPE_VERSION,
        },
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _empty_evidence() -> dict:
    return {
        "services_list": {},
        "pain_signals": {},
        "competitors_mentioned": {},
        "tech_stack_signals": {},
        "has_online_booking": None,
    }


def _sanitise_evidence(
    raw: object,
    *,
    allowed_urls: set[str],
    services: list[str],
    pain_signals: list[str],
    competitors: list[str],
    tech_stack: list[str],
) -> dict:
    """Filter the LLM-emitted evidence map. For each fact list, only keep
    item → URL mappings where:
      - the item appears verbatim in the validated fact list (so a competitor
        Claude hallucinated, then post-filtered out, can't sneak in via
        the evidence sidecar), and
      - the URL is one of the pages we actually fetched (no invented sources).
    Returns a payload with the same shape as `_empty_evidence`."""
    out = _empty_evidence()
    if not isinstance(raw, dict):
        return out

    def _filter_map(key: str, allowed_items: list[str]) -> dict:
        m = raw.get(key)
        if not isinstance(m, dict):
            return {}
        # Case-insensitive item lookup so a small casing drift between the
        # fact-list pass and the evidence pass doesn't drop the mapping.
        item_lower_to_canonical = {s.strip().lower(): s for s in allowed_items if s}
        result: dict[str, str] = {}
        for item_raw, url_raw in m.items():
            if not isinstance(item_raw, str) or not isinstance(url_raw, str):
                continue
            canonical = item_lower_to_canonical.get(item_raw.strip().lower())
            if canonical is None:
                continue
            url = url_raw.strip()
            if url in allowed_urls:
                result[canonical] = url
        return result

    out["services_list"] = _filter_map("services_list", services)
    out["pain_signals"] = _filter_map("pain_signals", pain_signals)
    out["competitors_mentioned"] = _filter_map("competitors_mentioned", competitors)
    out["tech_stack_signals"] = _filter_map("tech_stack_signals", tech_stack)

    booking_url = raw.get("has_online_booking")
    if isinstance(booking_url, str) and booking_url.strip() in allowed_urls:
        out["has_online_booking"] = booking_url.strip()
    return out


def _as_str_list(v) -> list[str]:
    if not isinstance(v, list):
        return []
    return [s.strip() for s in v if isinstance(s, str) and s.strip()]


def _as_bool_or_none(v):
    if isinstance(v, bool):
        return v
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
    return None


def _as_str_or_none(v):
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


# ── Email extraction ─────────────────────────────────────────────────────────

# Local-parts we treat as "avoid unless nothing else exists". Includes
# automated / abuse / catch-all addresses that won't reach a human.
_EMAIL_AVOID_LOCALPARTS = {
    "noreply", "no-reply", "do-not-reply", "donotreply", "mailer-daemon",
    "postmaster", "abuse", "webmaster", "hostmaster", "spam", "unsubscribe",
    "bounce", "bounces",
}

# Generic department / role addresses — usable when no named address exists,
# but always ranked below a named or role-matching one.
_EMAIL_GENERIC_LOCALPARTS = {
    "info", "contact", "hello", "enquiries", "enquiry", "inquiries",
    "general", "office", "admin", "administration", "support", "help",
    "team", "mail", "email",
}

# Localparts that hint at the contact's role. Matched as a substring inside
# the local part, case-insensitive, so "the.owner" / "ownerjeff" both hit.
_ROLE_KEYWORDS = {
    "owner", "founder", "ceo", "president", "principal", "director",
    "manager", "gm", "general", "operations", "ops", "dockmaster",
    "harbormaster", "fleet", "rental", "sales", "service",
}

# Single email regex. Conservative — no IDN, no quoted local parts.
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")

# Catches `mailto:foo@bar.com` strings anywhere in raw HTML — including
# inside JS-escaped builder blobs (Divi / Elementor / Wix often embed
# their config as `"mailto:foo@bar.com"`-style strings inside
# <script> tags). The selectolax CSS selector only finds real <a> elements
# in the rendered DOM, which misses those.
_MAILTO_IN_RAW_RE = re.compile(
    r"mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})",
    re.IGNORECASE,
)

# Some sites obfuscate emails by inserting word-break or zero-width markers
# between the local part and the domain so the email survives copy-paste but
# our regex (which wants a contiguous string) skips it. Strip these tags
# from the HTML before any text-based extraction.
_NOISE_TAG_RE = re.compile(
    r"<(wbr|br)\s*/?>",
    re.IGNORECASE,
)
_ZERO_WIDTH_RE = re.compile(r"[​‌‍﻿]")


def _registrable(url_or_host: str) -> str:
    """Return the eTLD+1 of a URL or hostname; lowercase. Falls back to the
    bare host when tldextract can't classify."""
    parts = tldextract.extract(url_or_host)
    if parts.suffix and parts.domain:
        return f"{parts.domain}.{parts.suffix}".lower()
    p = urlparse(url_or_host)
    return (p.hostname or url_or_host).lower()


def _email_domain(email: str) -> str:
    at = email.rfind("@")
    if at < 0:
        return ""
    return _registrable(email[at + 1:])


def _surrounding_text(text: str, idx: int, *, width: int = 120) -> str:
    start = max(0, idx - width)
    end = min(len(text), idx + width)
    snippet = text[start:end].strip()
    # Collapse internal whitespace so the context fits on one line in the prompt.
    return re.sub(r"\s+", " ", snippet)


def _extract_email_candidates(
    pages: list[dict],
    *,
    site_domain: str,
    contact_name: str,
    contact_title: str,
) -> list[dict]:
    """Pull every email visible on the scraped pages (mailto: hrefs +
    regex over markdown). Dedupe + score; drop obvious junk. Returns
    `[{email, source_url, context, score, kind}]` sorted best-first.

    Scoring is purely a sort key — the LLM still picks the recommended
    address (constrained to this list), so a wrong score just changes
    presentation order in the prompt, not correctness.
    """
    contact_tokens = _name_tokens(contact_name)
    title_tokens = {t for t in re.findall(r"[a-z]{3,}", (contact_title or "").lower())}

    # email_lower → entry (we keep the first-seen casing for display)
    by_email: dict[str, dict] = {}

    def _record(email: str, source_url: str, context: str, kind: str) -> None:
        email_clean = email.strip().strip(".,;:()<>[]\"'").lower()
        if not email_clean or "@" not in email_clean or len(email_clean) > 254:
            return
        # Skip image / sentry / placeholder noise.
        if any(s in email_clean for s in ("@sentry.io", "@example.com", "@yourdomain", "@email.com", "@domain.com")):
            return
        local, _, domain = email_clean.partition("@")
        if not local or not domain:
            return

        existing = by_email.get(email_clean)
        score = _score_email(
            local=local,
            email_domain=_registrable(domain),
            site_domain=site_domain,
            contact_tokens=contact_tokens,
            title_tokens=title_tokens,
            kind=kind,
        )
        if existing:
            # Keep the higher score + the first context that gave it.
            if score > existing["score"]:
                existing["score"] = score
                existing["kind"] = kind
            return
        by_email[email_clean] = {
            "email": email_clean,
            "source_url": source_url,
            "context": context,
            "score": score,
            "kind": kind,
        }

    for page in pages:
        url = page.get("url") or ""
        html = page.get("html") or ""
        md = page.get("markdown") or ""

        # 1. Pre-process: strip <wbr>/<br> tags and zero-width chars so emails
        # that the site obfuscates with word-break markers (e.g.
        # "info@example.<wbr>com") survive as contiguous strings.
        cleaned_html = _ZERO_WIDTH_RE.sub("", _NOISE_TAG_RE.sub("", html)) if html else ""

        # 2. mailto: hrefs from the rendered DOM (most reliable — operator-curated).
        tree = None
        if cleaned_html:
            try:
                tree = HTMLParser(cleaned_html)
            except Exception:
                tree = None
            if tree is not None:
                for a in tree.css("a[href^='mailto:']"):
                    href = a.attributes.get("href") or ""
                    raw = href[len("mailto:"):]
                    raw = raw.split("?", 1)[0].split(",", 1)[0].strip()
                    anchor = (a.text(strip=True) or "")[:120]
                    _record(raw, url, f"mailto link · anchor: {anchor}" if anchor else "mailto link", "mailto")

        # 3. mailto: strings anywhere in the raw HTML (catches JS-embedded
        # config blobs from Divi / Elementor / Wix that aren't rendered as
        # actual <a> elements).
        if cleaned_html:
            for m in _MAILTO_IN_RAW_RE.finditer(cleaned_html):
                addr = m.group(1)
                _record(addr, url, "mailto string in page source", "mailto")

        # 4. Regex over the visible body text (selectolax). This catches
        # emails that trafilatura dropped as boilerplate (footers, contact
        # sections) and recovers anything in plain text on the page.
        if tree is not None:
            body = tree.css_first("body")
            if body is not None:
                visible = body.text(separator=" ", strip=True)
                visible = _ZERO_WIDTH_RE.sub("", visible)
                for m in _EMAIL_RE.finditer(visible):
                    addr = m.group(0)
                    _record(addr, url, _surrounding_text(visible, m.start()), "text")

        # 5. Regex over the cleaned markdown (still useful — trafilatura
        # often produces a tidier context snippet than raw body text).
        if md:
            for m in _EMAIL_RE.finditer(md):
                addr = m.group(0)
                _record(addr, url, _surrounding_text(md, m.start()), "text")

    # Drop addresses on domains that have nothing to do with this prospect
    # AND aren't a known role address. (e.g. 'press@apple.com' embedded in a
    # case study.) Done as a soft filter: if there are any same-domain
    # candidates, drop any cross-domain ones; otherwise keep all.
    same_domain = [e for e in by_email.values() if _email_domain(e["email"]) == site_domain]
    if same_domain:
        candidates = same_domain
    else:
        candidates = list(by_email.values())

    candidates.sort(key=lambda e: (-e["score"], e["email"]))
    return candidates[:12]


def _name_tokens(name: str) -> set[str]:
    return {t for t in re.findall(r"[a-z]{3,}", (name or "").lower())}


def _score_email(
    *,
    local: str,
    email_domain: str,
    site_domain: str,
    contact_tokens: set[str],
    title_tokens: set[str],
    kind: str,
) -> int:
    score = 0
    if email_domain == site_domain and email_domain:
        score += 6
    if kind == "mailto":
        score += 2  # operator put the link on the site — strong intent signal
    # Name match in the local part — strongest signal.
    if contact_tokens and any(t in local for t in contact_tokens):
        score += 12
    # Role match (owner/manager/director/etc.).
    if title_tokens and any(t in local for t in title_tokens):
        score += 6
    if any(rk in local for rk in _ROLE_KEYWORDS):
        score += 4
    if local in _EMAIL_GENERIC_LOCALPARTS:
        score -= 2
    if local in _EMAIL_AVOID_LOCALPARTS:
        score -= 12
    return score


def _format_email_candidates_for_prompt(candidates: list[dict]) -> str:
    if not candidates:
        return "(no email addresses found on the scraped pages — return null for recommended_email)"
    lines: list[str] = []
    for i, c in enumerate(candidates, 1):
        deliv = c.get("deliverable")
        deliv_str = "true" if deliv else "false" if deliv is False else "unchecked"
        detail = c.get("deliverability_detail") or c.get("deliverability_status") or ""
        lines.append(
            f"  {i}. {c['email']}\n"
            f"     deliverable: {deliv_str}{f' ({detail})' if detail else ''}\n"
            f"     source: {c['source_url']}\n"
            f"     kind: {c['kind']}\n"
            f"     context: {c['context'][:200]}"
        )
    return "\n".join(lines)


def _reconcile_recommended_email(raw: object, candidates: list[dict]) -> str | None:
    """Trust an LLM-recommended email only if it appears verbatim in the
    deterministic candidate list. Drops hallucinations to null.

    Defensive override: if Claude picked an undeliverable address (failed DNS
    check) but at least one deliverable candidate exists, switch the
    recommendation to the highest-scoring deliverable one. Mail to a non-MX
    domain bounces — better to surface a working address even if Claude
    judged it weaker on role-match alone.
    """
    if not raw or not isinstance(raw, str):
        # No recommendation — but if there's a single clear deliverable
        # winner, surface it anyway. Saves a re-prompt when Claude
        # over-cautiously returns null.
        deliverable = [c for c in candidates if c.get("deliverable")]
        if len(deliverable) == 1:
            return deliverable[0]["email"]
        return None
    target = raw.strip().lower()
    if not target:
        return None
    picked = next((c for c in candidates if c["email"] == target), None)
    if picked is None:
        return None
    if picked.get("deliverable") is False:
        # Hunt for a deliverable alternative.
        better = next((c for c in candidates if c.get("deliverable")), None)
        if better is not None:
            return better["email"]
    return picked["email"]


website_enrichment_agent = WebsiteEnrichmentAgent()
