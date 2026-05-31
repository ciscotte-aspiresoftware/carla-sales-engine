"""
Lightweight email-deliverability verification.

Two checks, in order of cost:
  1. Format / RFC-5321 length validation.
  2. DNS lookup for the address's domain — MX records preferred, falling
     back to A/AAAA per RFC 5321 §5 ("implicit MX").

We deliberately stop short of SMTP HELO probing. That tier of verification
either gets you IP-banned by major mailbox providers or returns false
positives for catch-all domains; for a B2B SDR tool the cost/benefit of
SMTP probing isn't there. The MX/A check catches the common failure modes
(parked domain, expired domain, typo'd TLD, missing mail config).

The verifier caches results in-process keyed by the email's domain — DNS
results are slow to fetch and stable over the lifetime of a request batch.
"""
from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Optional

import dns.resolver  # type: ignore[import-not-found]
import dns.exception  # type: ignore[import-not-found]


_EMAIL_FORMAT_RE = re.compile(
    r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$"
)

# Per-domain DNS cache. Lifetime is intentionally short — long enough to
# survive a batch verify across hundreds of prospects sharing a domain,
# but not so long that a fixed-MX domain stays stuck.
_DNS_CACHE_TTL_SECONDS = 600.0


@dataclass
class _CachedResult:
    status: str  # "deliverable" | "no_mx" | "unknown_domain" | "dns_error"
    detail: Optional[str]
    fetched_at: float


_cache: dict[str, _CachedResult] = {}
_cache_lock = asyncio.Lock()


def _format_ok(email: str) -> bool:
    if not email or len(email) > 254:
        return False
    return bool(_EMAIL_FORMAT_RE.match(email))


def _domain_of(email: str) -> str:
    at = email.rfind("@")
    if at < 0:
        return ""
    return email[at + 1:].strip().lower().rstrip(".")


async def _resolve_domain(domain: str) -> _CachedResult:
    """Synchronous DNS lookups, wrapped in an executor so the FastAPI event
    loop doesn't block while dnspython does its sockets thing. Returns a
    classified result + a short detail string."""
    loop = asyncio.get_event_loop()

    def _do() -> _CachedResult:
        # MX first — the canonical "this domain accepts mail" signal.
        try:
            answers = dns.resolver.resolve(domain, "MX", lifetime=4.0)
            if len(answers) > 0:
                primary = sorted(
                    [(int(getattr(r, "preference", 0)), str(r.exchange).rstrip(".")) for r in answers]
                )[0]
                return _CachedResult(
                    status="deliverable",
                    detail=f"MX → {primary[1]}",
                    fetched_at=time.monotonic(),
                )
        except dns.resolver.NoAnswer:
            pass  # fall through to A check
        except dns.resolver.NXDOMAIN:
            return _CachedResult(status="unknown_domain", detail="NXDOMAIN", fetched_at=time.monotonic())
        except (dns.resolver.NoNameservers, dns.exception.Timeout) as exc:
            return _CachedResult(status="dns_error", detail=str(exc)[:120], fetched_at=time.monotonic())
        except Exception as exc:
            return _CachedResult(status="dns_error", detail=str(exc)[:120], fetched_at=time.monotonic())

        # RFC 5321 implicit MX: if A/AAAA exists, mail can be delivered.
        try:
            dns.resolver.resolve(domain, "A", lifetime=3.0)
            return _CachedResult(
                status="deliverable",
                detail="implicit MX (A record only)",
                fetched_at=time.monotonic(),
            )
        except dns.resolver.NXDOMAIN:
            return _CachedResult(status="unknown_domain", detail="NXDOMAIN", fetched_at=time.monotonic())
        except dns.resolver.NoAnswer:
            return _CachedResult(status="no_mx", detail="No MX and no A record", fetched_at=time.monotonic())
        except Exception as exc:
            return _CachedResult(status="dns_error", detail=str(exc)[:120], fetched_at=time.monotonic())

    return await loop.run_in_executor(None, _do)


async def verify_email(email: str) -> dict:
    """Returns:

        {
            "verified": bool,       # convenience: True iff status == "deliverable"
            "status": str,          # one of: "deliverable" | "no_mx" |
                                    # "unknown_domain" | "dns_error" | "bad_format"
            "detail": str | None,   # short human-readable reason (e.g. "MX → mx1.…")
        }
    """
    e = (email or "").strip().lower()
    if not _format_ok(e):
        return {"verified": False, "status": "bad_format", "detail": None}

    domain = _domain_of(e)
    if not domain:
        return {"verified": False, "status": "bad_format", "detail": None}

    now = time.monotonic()
    async with _cache_lock:
        cached = _cache.get(domain)
        if cached and (now - cached.fetched_at) < _DNS_CACHE_TTL_SECONDS:
            return {
                "verified": cached.status == "deliverable",
                "status": cached.status,
                "detail": cached.detail,
            }

    result = await _resolve_domain(domain)
    async with _cache_lock:
        _cache[domain] = result

    return {
        "verified": result.status == "deliverable",
        "status": result.status,
        "detail": result.detail,
    }


async def verify_emails(emails: list[str]) -> dict[str, dict]:
    """Bulk verify with bounded concurrency. Returns `{email: result}`.

    Concurrency is capped at 5 simultaneous DNS lookups — most of the work
    is in `socket.gethostbyname`-style calls run in an executor; more than
    a handful at once doesn't help and stresses the resolver."""
    if not emails:
        return {}
    sem = asyncio.Semaphore(5)

    async def _one(addr: str) -> tuple[str, dict]:
        async with sem:
            return addr, await verify_email(addr)

    pairs = await asyncio.gather(*[_one(e) for e in emails])
    return dict(pairs)
