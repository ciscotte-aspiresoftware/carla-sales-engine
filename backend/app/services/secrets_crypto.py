"""
Symmetric encryption for app-settings rows that store API keys.

Key resolution order:
  1. SETTINGS_ENCRYPTION_KEY env var — preferred for production / containerised deploys.
  2. {project_root}/.settings_encryption_key file — auto-generated on first boot.

Threat model — this is intended for the demo / handoff tier:
  - Protects API keys in DB backups and casual `sqlite3 .dump` inspection.
  - Does NOT protect against an attacker who has both the DB and the key file.
  - Production deploys should set SETTINGS_ENCRYPTION_KEY from a secret manager
    (AWS Secrets Manager, Vault, etc.) and never write the file fallback.

If the encryption key ever rotates, every existing row becomes unreadable.
There is no automatic re-encryption — the receiving team must clear settings
or write a one-off migration. Document the constraint in the handoff README.
"""
from __future__ import annotations

import os
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken


def _key_file_path() -> Path:
    # Same parent as .app_settings.json — project root.
    return Path(__file__).resolve().parents[3] / ".settings_encryption_key"


def _load_or_create_key() -> bytes:
    env_key = os.environ.get("SETTINGS_ENCRYPTION_KEY")
    if env_key:
        return env_key.encode("ascii")

    p = _key_file_path()
    if p.exists():
        return p.read_bytes().strip()

    # First boot — generate, persist, and warn the operator. Restrict perms
    # where the OS supports it (POSIX 0600). On Windows this is a no-op.
    key = Fernet.generate_key()
    p.write_bytes(key)
    try:
        p.chmod(0o600)
    except (OSError, NotImplementedError):
        pass
    print(
        f"[secrets_crypto] Generated new encryption key at {p}. "
        f"Back this up — losing it makes encrypted settings unrecoverable. "
        f"For production, set SETTINGS_ENCRYPTION_KEY env var instead."
    )
    return key


# Module-level singleton — instantiated at import time.
_fernet: Fernet | None = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string. Returns the base64 token as a str."""
    if plaintext is None:
        raise ValueError("Cannot encrypt None")
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str | None:
    """Decrypt a token produced by encrypt(). Returns None on tampering /
    wrong key — caller decides whether to log or surface. Never raises."""
    if not token:
        return None
    try:
        return _get_fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None
