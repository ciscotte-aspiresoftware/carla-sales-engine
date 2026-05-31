import json
from pathlib import Path
from typing import Optional
from app.config import settings


class PackLoader:
    _vertical_cache: dict[str, dict] = {}
    _vendor_cache: dict[str, dict] = {}
    _product_cache: dict[str, dict] = {}
    _regional_cache: dict[str, dict] = {}

    @property
    def _base(self) -> Path:
        return settings.packs_path

    # ── Read ─────────────────────────────────────────────────────────────────
    def load_vertical(self, pack_id: str) -> Optional[dict]:
        return self._load("vertical", pack_id, self._vertical_cache)

    def load_vendor(self, pack_id: str) -> Optional[dict]:
        return self._load("vendor", pack_id, self._vendor_cache)

    def load_product(self, pack_id: str) -> Optional[dict]:
        return self._load("product", pack_id, self._product_cache)

    def load_regional(self, pack_id: str) -> Optional[dict]:
        return self._load("regional", pack_id, self._regional_cache)

    def _load(self, kind: str, pack_id: str, cache: dict[str, dict]) -> Optional[dict]:
        if pack_id in cache:
            return cache[pack_id]
        path = self._base / kind / f"{pack_id}.json"
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        cache[pack_id] = data
        return data

    def list_available(self) -> dict:
        return {
            "vertical": self._list_kind("vertical"),
            "vendor": self._list_kind("vendor"),
            "product": self._list_kind("product"),
            "regional": self._list_kind("regional"),
        }

    def _list_kind(self, kind: str) -> list[str]:
        d = self._base / kind
        return [p.stem for p in sorted(d.glob("*.json"))] if d.exists() else []

    # ── Composition ──────────────────────────────────────────────────────────
    def is_legacy_vertical(self, vertical_pack: dict) -> bool:
        """A vertical pack is 'legacy' if it carries product-level fields directly."""
        return any(k in vertical_pack for k in ("messaging_framework", "personas", "email_guidance"))

    def compose(
        self,
        vertical_id: str,
        vendor_id: Optional[str] = None,
        product_id: Optional[str] = None,
    ) -> Optional[dict]:
        """
        Compose vertical + vendor + product into a single pack dict shaped like
        a legacy pack — so agents that read display_name / product_name /
        messaging_framework / personas / email_guidance work unchanged.

        Rules:
        - If the vertical is legacy (has messaging_framework etc.), it is returned as-is.
          vendor_id / product_id are ignored.
        - Otherwise vendor_id and product_id are required. The product layer wins
          for product-specific fields; the vendor layer contributes company facts;
          the vertical layer contributes ICP and industry context.
        """
        vertical = self.load_vertical(vertical_id)
        if not vertical:
            return None

        if self.is_legacy_vertical(vertical):
            # Legacy single-file pack — return verbatim with metadata enriched.
            out = dict(vertical)
            out.setdefault("vertical_id", vertical.get("pack_id"))
            out.setdefault("pack_layout", "legacy")
            return out

        # Layered composition path.
        if not (vendor_id and product_id):
            return None

        vendor = self.load_vendor(vendor_id)
        product = self.load_product(product_id)
        if not (vendor and product):
            return None

        company_name = vendor.get("company_name", vendor.get("display_name", vendor_id))
        product_name = product.get("product_name", product_id)

        composed = {
            "pack_layout": "layered",
            "vertical_id": vertical.get("pack_id"),
            "vendor_id": vendor.get("pack_id"),
            "product_id": product.get("pack_id"),

            # Surface fields used by format_pack_context and the frontend.
            "pack_id": product.get("pack_id"),
            "display_name": product.get("display_name") or f"{company_name} — {product_name}",
            "product_name": product_name,
            "product_url": product.get("product_url", ""),
            "logo_color": product.get("logo_color") or vertical.get("logo_color", "#6366f1"),
            "version": product.get("version", "1.0.0"),

            # Industry context from vertical
            "industry_context": vertical.get("industry_context", {}),

            # ICP from vertical, with optional weighting notes from product
            "icp": vertical.get("icp", {}),
            "icp_overrides": product.get("icp_overrides", {}),

            # Vendor company facts (kept whole for UI / agent reference)
            "vendor": vendor,

            # Product positioning
            "scope_summary": product.get("scope_summary", ""),
            "modules": product.get("modules", []),
            "personas": product.get("personas", {}),
            "messaging_framework": product.get("messaging_framework", {}),
            "email_guidance": product.get("email_guidance", {}),
        }
        return composed

    def compose_default(self, vertical_id: str) -> Optional[dict]:
        """Compose with sensible defaults — used when there is no campaign context.

        For legacy verticals, returns the legacy pack. For layered verticals,
        picks the first vendor that lists this vertical, then that vendor's
        first product.
        """
        vertical = self.load_vertical(vertical_id)
        if not vertical:
            return None
        if self.is_legacy_vertical(vertical):
            return self.compose(vertical_id)

        for vendor_id in self._list_kind("vendor"):
            vendor = self.load_vendor(vendor_id)
            if not vendor:
                continue
            if vertical_id not in vendor.get("verticals", []):
                continue
            for product_id in vendor.get("product_ids", []):
                product = self.load_product(product_id)
                if product and product.get("vertical_id") == vertical_id:
                    return self.compose(vertical_id, vendor_id, product_id)
        return None

    # ── Write ────────────────────────────────────────────────────────────────
    def save_vertical(self, pack_id: str, data: dict) -> None:
        self._save("vertical", pack_id, data, self._vertical_cache)

    def save_vendor(self, pack_id: str, data: dict) -> None:
        self._save("vendor", pack_id, data, self._vendor_cache)

    def save_product(self, pack_id: str, data: dict) -> None:
        self._save("product", pack_id, data, self._product_cache)

    def save_regional(self, pack_id: str, data: dict) -> None:
        self._save("regional", pack_id, data, self._regional_cache)

    def _save(self, kind: str, pack_id: str, data: dict, cache: dict[str, dict]) -> None:
        path = self._base / kind / f"{pack_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        cache[pack_id] = data

    # ── Delete ───────────────────────────────────────────────────────────────
    def delete_vertical(self, pack_id: str) -> bool:
        return self._delete("vertical", pack_id, self._vertical_cache)

    def delete_vendor(self, pack_id: str) -> bool:
        return self._delete("vendor", pack_id, self._vendor_cache)

    def delete_product(self, pack_id: str) -> bool:
        return self._delete("product", pack_id, self._product_cache)

    def _delete(self, kind: str, pack_id: str, cache: dict[str, dict]) -> bool:
        path = self._base / kind / f"{pack_id}.json"
        if not path.exists():
            return False
        path.unlink()
        cache.pop(pack_id, None)
        return True

    def clear_cache(self):
        self._vertical_cache.clear()
        self._vendor_cache.clear()
        self._product_cache.clear()
        self._regional_cache.clear()

    # ── Prompt fragments + capability catalog (Roadmap Phase 5b + 5d) ────
    def load_prompt_fragment(self, vertical_id: str, fragment_name: str) -> Optional[str]:
        """Read a per-vertical prompt fragment from `packs/prompts/<vertical>/<name>.md`.

        Returns None if the file doesn't exist — callers should fall back to a
        sensible default. Fragments are tiny (greeting, signoff, cta, rapport)
        and let pack authors tune voice without touching engine code.
        """
        path = self._base / "prompts" / vertical_id / f"{fragment_name}.md"
        if not path.exists():
            return None
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()

    def supported_capabilities(self, vertical_id: str) -> Optional[list[str]]:
        """Return the pack's declared `supported_capabilities` array, or None
        when the pack didn't opt-in. UI uses this to hide irrelevant channel
        configuration rows."""
        pack = self.load_vertical(vertical_id)
        if not pack:
            return None
        caps = pack.get("supported_capabilities")
        if isinstance(caps, list):
            return [str(c) for c in caps]
        return None


pack_loader = PackLoader()
