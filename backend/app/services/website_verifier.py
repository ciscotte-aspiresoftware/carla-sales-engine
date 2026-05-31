"""
Pre-scrape sanity check: confirm `website_url` actually belongs to the prospect.

Catches three classes of mis-mapped URL:
  * Parked / for-sale domains (GoDaddy, Sedo, dan.com, hugedomains.com markers).
  * Domains that resolve but return a tiny / empty body (200 with <200 chars).
  * Domains that load fine but belong to an unrelated business — checked by
    token overlap between the prospect's business name (and city) and the
    page's <title> + first 500 chars of body.

This is the front line of the scrape pipeline. A `verified=False` result
short-circuits the agent before any further pages are fetched, so we never
write a misleading summary to `Prospect.website_research`.

The fetched homepage HTML and extracted markdown are returned in the result
so the agent can reuse them without a second round-trip.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from app.services.scrape_provider import pick_scrape_provider


# Substrings that scream "this domain is parked". Lowercase, matched against
# the page title + first ~1KB of markdown.
_PARKED_MARKERS = (
    "this domain is for sale",
    "this domain may be for sale",
    "domain is parked",
    "buy this domain",
    "godaddy",
    "sedo",
    "dan.com",
    "hugedomains",
    "namebright",
    "afternic",
)

# Final-URL hosts that indicate a redirect to a parking marketplace.
_PARKING_HOSTS = (
    "sedo.com",
    "dan.com",
    "hugedomains.com",
    "afternic.com",
)

# Business-name suffixes to drop before tokenising — they're noise.
_NOISE_SUFFIXES = re.compile(
    r"\b(ltd|llc|inc|corp|corporation|co|company|gmbh|sa|ag|bv|b\.v\.|nv|n\.v\.|s\.r\.l|sarl|plc|pty|llp|limited|holdings|group|the)\b",
    re.IGNORECASE,
)

# Generic words that don't disambiguate one business from another inside a
# vertical — strip before doing name-token overlap.
_GENERIC_TOKENS = {
    "marina", "marinas", "harbor", "harbour", "yacht", "yachts", "club",
    "rental", "rentals", "rent", "car", "cars", "auto", "automotive",
    "services", "service", "and", "of",
}


def _tokens(s: str) -> set[str]:
    s = _NOISE_SUFFIXES.sub(" ", s)
    raw = re.findall(r"[a-z0-9]{3,}", s.lower())
    return {t for t in raw if t not in _GENERIC_TOKENS}


def _normalise_url(url: str) -> str:
    if not url:
        return url
    url = url.strip()
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    return url


async def verify_website(url: str, business_name: str, city: str | None = None) -> dict:
    """Returns:
        {
          verified: bool,
          confidence: float in [0, 1],
          reason: str,                     # short slug, e.g. "ok" / "parked_domain" / "name_mismatch" / "http_error"
          canonical_url: str | None,       # final URL after redirects, if successful
          title: str | None,
          fetched_html: str | None,        # for re-use by the agent
          fetched_markdown: str | None,
        }
    """
    norm = _normalise_url(url)
    if not norm:
        return _fail("empty_url", "No website URL on this prospect.")
    try:
        provider = pick_scrape_provider()
    except RuntimeError as e:
        return _fail("provider_unavailable", str(e))

    try:
        payload = await provider.scrape(norm)
    except Exception as e:
        return _fail("http_error", f"Could not fetch the homepage: {e}")

    data = payload.get("data") or {}
    meta = data.get("metadata") or {}
    status = meta.get("statusCode")
    final_url = meta.get("finalUrl") or norm
    title = meta.get("title")
    markdown = data.get("markdown") or ""
    html = data.get("html") or ""

    if status and status >= 400:
        return _fail("http_error", f"Homepage returned HTTP {status}.",
                     fetched_html=html, fetched_markdown=markdown,
                     canonical_url=final_url, title=title)

    # Parked-domain heuristics.
    final_host = (urlparse(final_url).hostname or "").lower()
    if any(h in final_host for h in _PARKING_HOSTS):
        return _fail("parked_domain", "Final URL is a known parking marketplace.",
                     fetched_html=html, fetched_markdown=markdown,
                     canonical_url=final_url, title=title)
    body_snippet = (markdown or "")[:1024].lower()
    title_lower = (title or "").lower()
    if any(m in title_lower or m in body_snippet for m in _PARKED_MARKERS):
        return _fail("parked_domain", "Page content matches a known parked-domain template.",
                     fetched_html=html, fetched_markdown=markdown,
                     canonical_url=final_url, title=title)
    if len((markdown or "").strip()) < 200 and len((html or "").strip()) < 500:
        return _fail("empty_page", "Homepage body is too short to be a real site.",
                     fetched_html=html, fetched_markdown=markdown,
                     canonical_url=final_url, title=title)

    # Name / city token overlap. Pass rule: name-token present OR city present.
    name_tokens = _tokens(business_name or "")
    city_tokens = _tokens(city or "")
    haystack = f"{title_lower}\n{body_snippet}"
    haystack_tokens = set(re.findall(r"[a-z0-9]{3,}", haystack))
    name_hit = bool(name_tokens & haystack_tokens) if name_tokens else False
    city_hit = bool(city_tokens & haystack_tokens) if city_tokens else False

    if not name_hit and not city_hit and (name_tokens or city_tokens):
        return {
            "verified": False,
            "confidence": 0.0,
            "reason": "name_mismatch",
            "canonical_url": final_url,
            "title": title,
            "fetched_html": html,
            "fetched_markdown": markdown,
        }

    confidence = 0.5
    if name_hit:
        confidence += 0.4
    if city_hit:
        confidence += 0.1
    confidence = min(confidence, 1.0)
    return {
        "verified": True,
        "confidence": confidence,
        "reason": "ok",
        "canonical_url": final_url,
        "title": title,
        "fetched_html": html,
        "fetched_markdown": markdown,
    }


def _fail(reason: str, message: str, *,
          fetched_html: str | None = None,
          fetched_markdown: str | None = None,
          canonical_url: str | None = None,
          title: str | None = None) -> dict:
    return {
        "verified": False,
        "confidence": 0.0,
        "reason": reason,
        "message": message,
        "canonical_url": canonical_url,
        "title": title,
        "fetched_html": fetched_html,
        "fetched_markdown": fetched_markdown,
    }
