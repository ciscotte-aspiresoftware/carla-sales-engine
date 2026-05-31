"""
Shared safety primitives for the website enrichment agent.

  * `get_user_agent()` — identifying UA string, configurable via Settings.
  * `RobotsCache` — per-domain TTL cache wrapping `protego`. RFC 9309 compliant
    (missing / unreachable / malformed robots.txt → allow). Honours Crawl-delay
    capped at 10s.
  * `DomainRateLimiter` — per-registrable-domain async lock + min-interval gate,
    so concurrent scrapes of two prospects on the same parent domain don't
    burst the site.

Constants are exposed here so the agent, provider, verifier, and planner all
agree on the same caps without re-declaring them.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlparse

import httpx
import tldextract
from protego import Protego


# ── Caps & defaults ──────────────────────────────────────────────────────────

# Per-scrape: hard upper bound on pages fetched per prospect. Router clamps
# user-supplied `max_pages` to this number even when Settings allows more.
MAX_PAGES_PER_SITE = 5

# Per-page: response body cap before extraction. Homepages occasionally ship
# multi-MB of inline SVG / base64 imagery; truncating is cheap insurance.
MAX_BYTES_PER_PAGE = 1_048_576  # 1 MB

# Per-domain: minimum gap between requests to the same registrable domain.
# Two prospects sharing a parent site (franchise chains, multi-brand operators)
# must not burst.
PER_DOMAIN_MIN_INTERVAL_SECONDS = 1.5

# Robots.txt fetch timeout. We bias short — if a site can't serve robots.txt
# in 5s, we treat it as "no robots policy" per RFC 9309 §2.2.3.
ROBOTS_TIMEOUT_SECONDS = 5.0

# Page fetch timeout (applies to both local and Firecrawl-routed pulls inside
# LocalScraperProvider). Firecrawl has its own server-side timeout.
HTTP_TIMEOUT_SECONDS = 15.0

# Cap honoured Crawl-delay at this many seconds. Some sites declare 60-120s
# which is not a serious ask, just copy-paste from old guidance.
CRAWL_DELAY_CAP_SECONDS = 10.0

# Robots cache TTL — re-fetch once per hour at most.
ROBOTS_TTL_SECONDS = 3600.0

# Fallback identifying User-Agent. Override via Settings → website_scrape_user_agent.
DEFAULT_USER_AGENT = "AspireSDR/1.0 (+https://aspire.example/sdr-bot)"


def get_user_agent() -> str:
    """Resolve the User-Agent string sent on every scrape request.

    Reads `website_scrape_user_agent` from app settings (DB → env → None).
    Falls back to `DEFAULT_USER_AGENT`. Settings is the single seam — the
    Settings UI exposes this so a portfolio team can pin a fixed string for
    allow-listing without restarting the backend.
    """
    try:
        from app.services.app_settings_service import app_settings_service
        ua = app_settings_service.get_or_env("website_scrape_user_agent")
        if ua:
            return ua
    except Exception:
        pass
    return DEFAULT_USER_AGENT


def _registrable_domain(url: str) -> str:
    """Return the eTLD+1 (e.g. `acme.co.uk`) so the rate limiter buckets
    franchise subdomains together but keeps unrelated parents apart."""
    parts = tldextract.extract(url)
    if parts.suffix and parts.domain:
        return f"{parts.domain}.{parts.suffix}"
    # Fall back to bare host when tldextract can't classify (e.g. IPs, intranets).
    return urlparse(url).hostname or url


# ── Robots cache ─────────────────────────────────────────────────────────────

@dataclass
class _RobotsEntry:
    parser: Optional[Protego]  # None = treat as "allow all"
    fetched_at: float


class RobotsCache:
    """Async, per-registrable-domain cache of parsed robots.txt.

    Usage:
        cache = RobotsCache()
        if await cache.allows(url, user_agent):
            ...

    Behaviour on robots fetch failure (404, 5xx, timeout, DNS, malformed body):
    treat as "no policy in effect" and allow (RFC 9309 §2.2.3). Log via the
    standard FastAPI logger so we can audit if needed.
    """

    def __init__(self) -> None:
        self._cache: dict[str, _RobotsEntry] = {}
        self._lock = asyncio.Lock()

    async def _get(self, url: str) -> _RobotsEntry:
        domain = _registrable_domain(url)
        now = time.monotonic()
        async with self._lock:
            entry = self._cache.get(domain)
            if entry and (now - entry.fetched_at) < ROBOTS_TTL_SECONDS:
                return entry
        # Fetch outside the lock so concurrent callers for different domains
        # don't block each other.
        parser = await self._fetch(url)
        entry = _RobotsEntry(parser=parser, fetched_at=time.monotonic())
        async with self._lock:
            self._cache[domain] = entry
        return entry

    async def _fetch(self, url: str) -> Optional[Protego]:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.hostname:
            return None
        robots_url = f"{parsed.scheme}://{parsed.hostname}/robots.txt"
        try:
            async with httpx.AsyncClient(
                timeout=ROBOTS_TIMEOUT_SECONDS,
                follow_redirects=True,
                headers={"User-Agent": get_user_agent()},
            ) as client:
                resp = await client.get(robots_url)
        except (httpx.HTTPError, Exception):
            return None
        if resp.status_code >= 400:
            return None
        try:
            return Protego.parse(resp.text)
        except Exception:
            return None

    async def allows(self, url: str, user_agent: Optional[str] = None) -> bool:
        ua = user_agent or get_user_agent()
        entry = await self._get(url)
        if entry.parser is None:
            return True
        try:
            return entry.parser.can_fetch(url, ua)
        except Exception:
            return True

    async def crawl_delay(self, url: str, user_agent: Optional[str] = None) -> float:
        """Returns the honoured Crawl-delay for this URL/UA, capped at
        CRAWL_DELAY_CAP_SECONDS. 0.0 when none declared."""
        ua = user_agent or get_user_agent()
        entry = await self._get(url)
        if entry.parser is None:
            return 0.0
        try:
            d = entry.parser.crawl_delay(ua)
        except Exception:
            return 0.0
        if not d:
            return 0.0
        return float(min(d, CRAWL_DELAY_CAP_SECONDS))


# ── Per-domain rate limiter ──────────────────────────────────────────────────

@dataclass
class _DomainState:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_call: float = 0.0


class DomainRateLimiter:
    """Async gate: at most one in-flight request per registrable domain, and
    no closer than `min_interval` seconds between successive requests.

    Usage:
        limiter = DomainRateLimiter()
        async with limiter.gate(url, extra_delay=robots_cache.crawl_delay(...)):
            ...fetch...
    """

    def __init__(self, min_interval: float = PER_DOMAIN_MIN_INTERVAL_SECONDS) -> None:
        self._min_interval = min_interval
        self._domains: dict[str, _DomainState] = {}
        self._registry_lock = asyncio.Lock()

    async def _state_for(self, url: str) -> _DomainState:
        domain = _registrable_domain(url)
        async with self._registry_lock:
            state = self._domains.get(domain)
            if state is None:
                state = _DomainState()
                self._domains[domain] = state
        return state

    def gate(self, url: str, extra_delay: float = 0.0):
        """Return an async context manager that enforces serialised access
        and a min-interval delay for the URL's registrable domain."""
        return _Gate(self, url, extra_delay)


class _Gate:
    def __init__(self, limiter: DomainRateLimiter, url: str, extra_delay: float):
        self._limiter = limiter
        self._url = url
        self._extra_delay = extra_delay
        self._state: Optional[_DomainState] = None

    async def __aenter__(self):
        self._state = await self._limiter._state_for(self._url)
        await self._state.lock.acquire()
        wait_for = max(self._limiter._min_interval, self._extra_delay)
        elapsed = time.monotonic() - self._state.last_call
        delay = wait_for - elapsed
        if delay > 0:
            await asyncio.sleep(delay)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self._state is not None:
            self._state.last_call = time.monotonic()
            self._state.lock.release()
        return False


# Module-level singletons. Both are async-safe and stateful across requests.
robots_cache = RobotsCache()
domain_rate_limiter = DomainRateLimiter()
