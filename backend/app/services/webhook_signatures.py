"""
Webhook signature verification helpers.

Pure functions, no DB. Each helper maps to one provider's signature scheme.
Webhook routes import these and gate ActivityEvent creation behind a passing
verification — failed signatures return 200 silently (so retries don't pile up)
but no row is written.

Schemes implemented:
  - SendGrid Event Webhook: ECDSA P-256 over `<timestamp><payload>`, header
    "X-Twilio-Email-Event-Webhook-Signature" + timestamp header. Falls back
    to a generic HMAC-SHA256 mode for portfolio teams that route SendGrid
    events through their own gateway.
  - Twilio: HMAC-SHA1 over `<full URL><sorted form params concatenated>`,
    header "X-Twilio-Signature".
  - Generic HMAC-SHA256: hex digest in a header. Used by Salesforce (with
    salesforce_webhook_secret) and a baseline for inbound parse routes.

Each helper returns True/False; routes branch on the result.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Mapping
from urllib.parse import urlencode


def verify_hmac_sha256(payload: bytes, header_value: str | None, secret: str | None) -> bool:
    """Constant-time compare the HMAC-SHA256 hex digest of `payload` with
    `header_value`. Returns False on any input being missing.
    """
    if not (payload and header_value and secret):
        return False
    expected = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    # Some providers prefix the digest (e.g. "sha256="); accept both forms.
    candidate = header_value.strip()
    if "=" in candidate:
        candidate = candidate.split("=", 1)[1]
    return hmac.compare_digest(expected, candidate)


def verify_generic(payload: bytes, header_value: str | None, secret: str | None,
                   *, algo: str = "sha256") -> bool:
    """Hex-digest HMAC verification with a configurable hash algorithm.
    `algo` must be a name accepted by hashlib.new(...)."""
    if not (payload and header_value and secret):
        return False
    try:
        expected = hmac.new(secret.encode("utf-8"), payload, getattr(hashlib, algo)).hexdigest()
    except (AttributeError, ValueError):
        return False
    candidate = header_value.strip()
    if "=" in candidate:
        candidate = candidate.split("=", 1)[1]
    return hmac.compare_digest(expected, candidate)


def verify_sendgrid(payload: bytes, headers: Mapping[str, str], secret: str | None) -> bool:
    """SendGrid Event Webhook verification.

    The production-correct mechanism is ECDSA P-256 with a public key
    configured on the SendGrid side; for the demo posture we accept either:
      (a) ECDSA when `secret` is a PEM public key (supported via cryptography
          if available), OR
      (b) generic HMAC-SHA256 over the raw payload using `secret` as the HMAC
          key — useful when a portfolio team fronts SendGrid behind their own
          signing gateway, and for unit tests.

    Returns True if either mode succeeds.
    """
    if not (payload and secret):
        return False
    # Try generic HMAC first — covers the common gateway / test-mode case.
    sig_header = headers.get("X-SendGrid-Signature") or headers.get("x-sendgrid-signature")
    if sig_header and verify_hmac_sha256(payload, sig_header, secret):
        return True
    # Optional: try ECDSA P-256 over `<timestamp><payload>` if cryptography
    # is installed and secret looks like a PEM public key. We don't hard-fail
    # if cryptography isn't available — the HMAC path above is sufficient
    # for stub/test traffic.
    if "BEGIN PUBLIC KEY" not in (secret or ""):
        return False
    try:
        from cryptography.hazmat.primitives.asymmetric.ec import ECDSA
        from cryptography.hazmat.primitives import hashes, serialization
    except ImportError:
        return False
    ts = headers.get("X-Twilio-Email-Event-Webhook-Timestamp") or headers.get("x-twilio-email-event-webhook-timestamp")
    sig_b64 = headers.get("X-Twilio-Email-Event-Webhook-Signature") or headers.get("x-twilio-email-event-webhook-signature")
    if not (ts and sig_b64):
        return False
    try:
        public_key = serialization.load_pem_public_key(secret.encode("utf-8"))
        signed_payload = ts.encode("utf-8") + payload
        public_key.verify(base64.b64decode(sig_b64), signed_payload, ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False


def verify_twilio(*, url: str, params: Mapping[str, str], header_value: str | None,
                  auth_token: str | None) -> bool:
    """Twilio's request-validation algorithm:
       base = full URL + sorted(key + value) for every form param
       expected = base64(HMAC-SHA1(auth_token, base))
       compare with X-Twilio-Signature header.
    """
    if not (url and header_value and auth_token):
        return False
    base = url
    for key in sorted(params.keys()):
        base += key + (params[key] or "")
    expected = base64.b64encode(
        hmac.new(auth_token.encode("utf-8"), base.encode("utf-8"), hashlib.sha1).digest()
    ).decode("ascii")
    return hmac.compare_digest(expected, header_value.strip())


def hash_payload(payload: bytes) -> str:
    """sha256 hex digest. Used for the WebhookDelivery.payload_hash column."""
    return hashlib.sha256(payload or b"").hexdigest()


def url_encode_form(params: Mapping[str, str]) -> str:
    """Convenience: stable URL-encoding of form params. Some providers ask
    callers to compute the validation string this way before signing."""
    return urlencode(sorted(params.items()))
