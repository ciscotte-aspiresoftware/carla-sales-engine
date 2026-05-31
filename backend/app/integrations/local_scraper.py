"""
Local URL_SCRAPE provider — free fallback when Firecrawl is not configured.

Uses httpx for fetch, trafilatura for main-text extraction, selectolax for
title/description and same-domain link discovery. Caps response size and
honours the User-Agent + rate-limit conventions set in
`app.services.scrape_safety`. JS-only sites and Cloudflare-protected sites
will fail here — for those, configure FIRECRAWL_API_KEY.

Return shape mirrors FirecrawlProvider.scrape() so the agent doesn't care
which provider answered:

    {
        "data": {
            "markdown": str,
            "html": str,
            "metadata": {
                "title": str | None,
                "description": str | None,
                "statusCode": int,
                "finalUrl": str,
            },
        }
    }
"""
from __future__ import annotations

import httpx
from selectolax.parser import HTMLParser
import trafilatura

from app.integrations.base import BaseProvider, Capability, ProviderError


class LocalScraperProvider(BaseProvider):
    name = "local_scraper"
    capabilities = frozenset({Capability.URL_SCRAPE})

    def is_configured(self) -> bool:
        # No credentials — always available as a fallback.
        return True

    async def scrape(self, url: str, formats: list[str] | None = None) -> dict:
        """Fetch `url` and return a Firecrawl-shaped payload.

        `formats` is accepted for API compatibility with FirecrawlProvider but
        is otherwise ignored — we always return markdown + html.
        """
        # Imported lazily so the integration module can be imported during
        # startup without forcing scrape_safety's transitive imports.
        from app.services.scrape_safety import (
            MAX_BYTES_PER_PAGE,
            HTTP_TIMEOUT_SECONDS,
            get_user_agent,
        )

        headers = {"User-Agent": get_user_agent()}
        try:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT_SECONDS,
                follow_redirects=True,
                headers=headers,
            ) as client:
                resp = await client.get(url)
        except httpx.HTTPError as e:
            raise ProviderError(f"Local scrape failed for {url}: {e}") from e

        # Cap the body — some homepages ship 5 MB of inline SVG / fonts.
        raw = resp.content[:MAX_BYTES_PER_PAGE]
        html = raw.decode(resp.encoding or "utf-8", errors="replace")

        markdown = trafilatura.extract(
            html,
            output_format="markdown",
            include_links=True,
            include_tables=True,
            with_metadata=False,
            favor_recall=True,
        ) or ""

        title, description = _extract_meta(html)

        return {
            "data": {
                "markdown": markdown,
                "html": html,
                "metadata": {
                    "title": title,
                    "description": description,
                    "statusCode": resp.status_code,
                    "finalUrl": str(resp.url),
                },
            }
        }


def _extract_meta(html: str) -> tuple[str | None, str | None]:
    """Pull <title> and <meta name=description> via selectolax (fast, lenient)."""
    try:
        tree = HTMLParser(html)
    except Exception:
        return None, None
    title_node = tree.css_first("title")
    title = title_node.text(strip=True) if title_node else None
    desc = None
    meta = tree.css_first('meta[name="description"]')
    if meta and meta.attributes.get("content"):
        desc = meta.attributes["content"].strip()
    if not desc:
        og = tree.css_first('meta[property="og:description"]')
        if og and og.attributes.get("content"):
            desc = og.attributes["content"].strip()
    return title or None, desc or None
