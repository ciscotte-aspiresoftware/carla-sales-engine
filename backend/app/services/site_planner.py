"""
Pick the `max_pages - 1` best inner pages to scrape after the homepage.

Strategy: extract every `<a href>` from the homepage HTML, normalise each to
an absolute URL, keep only those on the same registrable domain, deduplicate
by path, then rank by how strongly the path or anchor text matches a user-
configurable list of section keywords (about, services, pricing, ...).

The homepage itself is always returned as the first entry. The result is
deterministic for a given (html, keywords, max_pages) input.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from selectolax.parser import HTMLParser
import tldextract


DEFAULT_PREFERRED_KEYWORDS = (
    "about",
    "services",
    "pricing",
    "products",
    "contact",
    "features",
)

# URL path fragments we never want to follow regardless of keywords. These
# tend to be utility pages or media that won't help the LLM.
_DENY_PATH_FRAGMENTS = (
    "/wp-login",
    "/wp-admin",
    "/login",
    "/signin",
    "/sign-in",
    "/cart",
    "/checkout",
    "/privacy",
    "/terms",
    "/cookie",
    "/legal",
    "/sitemap",
    "/feed",
    "/rss",
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".mp4",
    ".zip",
)


def _registrable(host: str) -> str:
    parts = tldextract.extract(host)
    if parts.suffix and parts.domain:
        return f"{parts.domain}.{parts.suffix}"
    return host.lower()


def _normalise(href: str, base: str) -> str | None:
    if not href:
        return None
    href = href.strip()
    if href.startswith(("mailto:", "tel:", "javascript:", "#")):
        return None
    absolute = urljoin(base, href)
    parsed = urlparse(absolute)
    if parsed.scheme not in ("http", "https"):
        return None
    # Strip fragment, normalise trailing slash for dedup.
    clean = f"{parsed.scheme}://{parsed.hostname}{parsed.path or '/'}"
    if parsed.query:
        clean += f"?{parsed.query}"
    return clean


def select_pages(
    homepage_html: str,
    homepage_url: str,
    *,
    max_pages: int,
    preferred_keywords: list[str] | None = None,
) -> list[str]:
    """Return up to `max_pages` URLs, always starting with `homepage_url`."""
    max_pages = max(1, int(max_pages))
    keywords = [k.lower() for k in (preferred_keywords or DEFAULT_PREFERRED_KEYWORDS) if k]
    keywords = list(dict.fromkeys(keywords))  # dedup, preserve order

    if max_pages == 1 or not homepage_html:
        return [homepage_url]

    base_host = urlparse(homepage_url).hostname or ""
    base_domain = _registrable(base_host)

    try:
        tree = HTMLParser(homepage_html)
    except Exception:
        return [homepage_url]

    candidates: dict[str, tuple[int, int, str]] = {}  # url → (score, position, anchor_text)
    for idx, node in enumerate(tree.css("a")):
        href = node.attributes.get("href") or ""
        url = _normalise(href, homepage_url)
        if not url:
            continue
        host = urlparse(url).hostname or ""
        if _registrable(host) != base_domain:
            continue
        if url.rstrip("/").lower() == homepage_url.rstrip("/").lower():
            continue
        path = urlparse(url).path.lower()
        if any(frag in path for frag in _DENY_PATH_FRAGMENTS):
            continue

        anchor = (node.text(strip=True) or "").lower()
        score = _score_link(path, anchor, keywords)
        if score <= 0:
            continue

        # Keep the highest-scoring (and earliest) hit per URL.
        existing = candidates.get(url)
        if existing is None or score > existing[0] or (score == existing[0] and idx < existing[1]):
            candidates[url] = (score, idx, anchor)

    ranked = sorted(
        candidates.items(),
        # Higher score first, then earlier position on the homepage.
        key=lambda kv: (-kv[1][0], kv[1][1]),
    )
    picks = [url for url, _ in ranked[: max_pages - 1]]
    return [homepage_url, *picks]


def _score_link(path: str, anchor: str, keywords: list[str]) -> int:
    """Higher score = more likely to be a useful "about / services / pricing"
    style page. Keywords earlier in the list count for more so users can
    express a priority."""
    if not keywords:
        return 0
    score = 0
    for rank, kw in enumerate(keywords):
        weight = max(1, len(keywords) - rank)
        if _word_in(path, kw):
            score += weight * 2  # path hit is stronger than anchor hit
        if _word_in(anchor, kw):
            score += weight
    return score


_word_re_cache: dict[str, re.Pattern[str]] = {}


def _word_in(haystack: str, word: str) -> bool:
    if not haystack or not word:
        return False
    pat = _word_re_cache.get(word)
    if pat is None:
        pat = re.compile(rf"\b{re.escape(word)}\b", re.IGNORECASE)
        _word_re_cache[word] = pat
    return bool(pat.search(haystack))
