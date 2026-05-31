from sqlalchemy import Column, Integer, String, Boolean, Float, JSON, DateTime
from sqlalchemy.sql import func
from app.database import Base


class Prospect(Base):
    __tablename__ = "prospects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # business_name and capacity_count are vertical-neutral. Pack JSON's
    # `prospect_schema_hints.size_field_label` carries the human-friendly
    # label for the active vertical ("Berth Count" for marinas, "Fleet Size"
    # for car rental, etc.).
    business_name = Column(String(200), nullable=False)
    contact_name = Column(String(200), nullable=False)
    contact_title = Column(String(100), nullable=False)
    email = Column(String(200), unique=True, nullable=False)
    # Primary phone for the prospect. ProspectContact rows can carry additional
    # personas (owner + manager + dockmaster, etc.) — voice/SMS channels can
    # target either the primary number here or a contact-specific number.
    phone = Column(String(50), nullable=True)
    city = Column(String(100), nullable=False)
    state = Column(String(100), nullable=True)          # state/region used during discovery
    country_code = Column(String(10), nullable=False, index=True)  # ISO 3166-1 alpha-2
    capacity_count = Column(Integer, nullable=True)
    services = Column(JSON, nullable=True)  # vertical-specific service tags from pack discovery_copy.service_options
    website_url = Column(String(500), nullable=True)
    tech_maturity_score = Column(Integer, nullable=True)  # 1-5
    has_online_booking = Column(Boolean, nullable=False, default=False)
    ownership_type = Column(String(50), nullable=False, index=True)  # family, corporate, club
    # Required at write time. Pack JSON drives per-vertical behavior; the
    # engine code never assumes a specific vertical. Backfill of legacy NULLs
    # happens in main.py:on_startup before this constraint is enforced.
    vertical = Column(String(50), nullable=False, index=True)
    icp_score = Column(Float, nullable=True, index=True)  # populated by ProspectorAgent
    research_profile = Column(JSON, nullable=True)  # populated by ResearchAgent
    # Populated by WebsiteEnrichmentAgent. Holds the structured payload from
    # scraping the prospect's website (homepage + selected inner pages):
    # verified, summary, services_list, has_online_booking, tech_stack_signals,
    # pain_signals, competitors_mentioned, key_quotes, meta. When verified,
    # fields the scrape confirms (has_online_booking, services, website_url)
    # are also written back to the structured columns above and their
    # provenance is promoted to "scrape".
    website_research = Column(JSON, nullable=True)
    # Per-field source map: { "berth_count": "snippet" | "training" | "user" | "scrape" | "needs_review" | "unknown", ... }
    # Populated at discovery time by the enrich step. Survives across the
    # research/copywriter pipeline. Lets the researcher conditionally cite
    # specific numbers when the source is "snippet" (Tavily-verified),
    # "user" (manual edit), or "scrape" (confirmed from the prospect's
    # own live website), and hedge otherwise. The value "needs_review" is
    # set specifically on `website_url` when discovery's lite verifier
    # couldn't confirm the URL belongs to the prospect (name token mismatch
    # or low confidence) but the URL was still saved — the user should
    # manually check / correct it.
    provenance = Column(JSON, nullable=True)
    lat = Column(Float, nullable=True)   # geographic coordinates
    lng = Column(Float, nullable=True)
    is_real = Column(Boolean, nullable=False, default=False)  # true = known real marina
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
