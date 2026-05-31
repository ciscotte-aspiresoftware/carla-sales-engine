from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import engine, Base
from app.config import settings
import app.models  # noqa: F401 — ensures all models are registered before create_all

app = FastAPI(
    title="SDR Engine",
    description="Modular AI SDR & GTM Automation Engine — single engine, multi-vertical, pack-driven",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    from app.services.scheduler_service import scheduler_service
    Base.metadata.create_all(bind=engine)
    # Add new prospect columns if upgrading an existing DB (idempotent)
    from sqlalchemy import text, inspect
    inspector = inspect(engine)
    prospect_cols = {c["name"] for c in inspector.get_columns("prospects")}
    campaign_cols = {c["name"] for c in inspector.get_columns("campaigns")} if "campaigns" in inspector.get_table_names() else set()
    sequence_cols = {c["name"] for c in inspector.get_columns("email_sequences")} if "email_sequences" in inspector.get_table_names() else set()
    with engine.connect() as conn:
        if "lat" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN lat FLOAT"))
        if "lng" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN lng FLOAT"))
        if "is_real" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN is_real BOOLEAN NOT NULL DEFAULT 0"))
        if "state" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN state VARCHAR(100)"))
        if campaign_cols and "vendor_pack" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN vendor_pack VARCHAR(50)"))
        if campaign_cols and "product_pack" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN product_pack VARCHAR(50)"))
        # Phase 1 of vertical-agnostic refactor: Revenue Optimizer was removed.
        # Drop the reservations table if upgrading from a pre-strip DB.
        if "reservations" in inspector.get_table_names():
            conn.execute(text("DROP TABLE IF EXISTS reservations"))
        # Phase 3 of vertical-agnostic refactor: rename vertical-coupled fields
        # so a portfolio reading the source doesn't see "marina_name" or
        # "berth_count" in their SDR engine.
        if "business_name" not in prospect_cols and "marina_name" in prospect_cols:
            conn.execute(text("ALTER TABLE prospects RENAME COLUMN marina_name TO business_name"))
        if "capacity_count" not in prospect_cols and "berth_count" in prospect_cols:
            conn.execute(text("ALTER TABLE prospects RENAME COLUMN berth_count TO capacity_count"))
        # Phase 4 of vertical-agnostic refactor: drop the old "marina" default
        # on the vertical column. Backfill any legacy NULL rows once before
        # the NOT NULL constraint kicks in for new writes.
        conn.execute(text("UPDATE prospects SET vertical = 'marina' WHERE vertical IS NULL OR vertical = ''"))
        # Roadmap Phase 3: multi-contact prospect model. Add `phone` to
        # prospects (primary phone) and `contact_id` to email_sequences (NULL
        # means "use the prospect's primary contact"). Both are nullable so
        # this upgrade is non-breaking.
        if "phone" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN phone VARCHAR(50)"))
        if sequence_cols and "contact_id" not in sequence_cols:
            conn.execute(text("ALTER TABLE email_sequences ADD COLUMN contact_id INTEGER REFERENCES prospect_contacts(id)"))
        # Roadmap Phase 4 + 5: campaign-level schedule + tools.
        if campaign_cols and "auto_send" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN auto_send BOOLEAN NOT NULL DEFAULT 0"))
        if campaign_cols and "send_cadence" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN send_cadence VARCHAR(50) NOT NULL DEFAULT 'immediate'"))
        if campaign_cols and "cadence_custom_cron" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN cadence_custom_cron VARCHAR(100)"))
        if campaign_cols and "ab_test" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN ab_test BOOLEAN NOT NULL DEFAULT 0"))
        if campaign_cols and "dry_run" not in campaign_cols:
            conn.execute(text("ALTER TABLE campaigns ADD COLUMN dry_run BOOLEAN NOT NULL DEFAULT 0"))
        # Website Enrichment: stores the structured payload from scraping the
        # prospect's website. See WebsiteEnrichmentAgent + researcher integration.
        if "website_research" not in prospect_cols:
            conn.execute(text("ALTER TABLE prospects ADD COLUMN website_research JSON"))
        # Performance indexes on hot filter columns. `CREATE INDEX IF NOT EXISTS`
        # is itself idempotent in SQLite so no inspector guard is needed; the
        # statements are no-ops once the index exists. SQLAlchemy will also
        # create these from the `index=True` declarations on the next
        # `Base.metadata.create_all`, but stating them explicitly here means
        # they land on existing databases without recreating the schema.
        index_statements = [
            "CREATE INDEX IF NOT EXISTS ix_prospects_country_code ON prospects(country_code)",
            "CREATE INDEX IF NOT EXISTS ix_prospects_vertical ON prospects(vertical)",
            "CREATE INDEX IF NOT EXISTS ix_prospects_ownership_type ON prospects(ownership_type)",
            "CREATE INDEX IF NOT EXISTS ix_prospects_icp_score ON prospects(icp_score)",
            "CREATE INDEX IF NOT EXISTS ix_activity_events_occurred_at ON activity_events(occurred_at)",
            "CREATE INDEX IF NOT EXISTS ix_activity_events_prospect_id ON activity_events(prospect_id)",
            "CREATE INDEX IF NOT EXISTS ix_activity_events_campaign_id ON activity_events(campaign_id)",
            "CREATE INDEX IF NOT EXISTS ix_activity_events_event_type ON activity_events(event_type)",
            "CREATE INDEX IF NOT EXISTS ix_email_sequences_campaign_id ON email_sequences(campaign_id)",
            "CREATE INDEX IF NOT EXISTS ix_email_sequences_prospect_id ON email_sequences(prospect_id)",
            "CREATE INDEX IF NOT EXISTS ix_email_sequences_approval_status ON email_sequences(approval_status)",
        ]
        for stmt in index_statements:
            conn.execute(text(stmt))
        conn.commit()
    # Boot the in-process scheduler. No-op when APScheduler is not installed.
    scheduler_service.start()


@app.on_event("shutdown")
async def on_shutdown():
    from app.services.scheduler_service import scheduler_service
    scheduler_service.shutdown()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "sdr-engine"}


# Routers registered as they are built — stubs here to avoid import errors
from app.routers import prospects, campaigns, sequences, packs, activity, analytics, campaign_briefs, holidays, agents, demo, guardrails, costs, integrations, settings as settings_router  # noqa: E402
from app.routers.webhooks import router as webhooks_router  # noqa: E402

app.include_router(prospects.router, prefix="/api/v1", tags=["prospects"])
app.include_router(campaigns.router, prefix="/api/v1", tags=["campaigns"])
app.include_router(sequences.router, prefix="/api/v1", tags=["sequences"])
app.include_router(packs.router, prefix="/api/v1", tags=["packs"])
app.include_router(activity.router, prefix="/api/v1", tags=["activity"])
app.include_router(analytics.router, prefix="/api/v1", tags=["analytics"])
app.include_router(campaign_briefs.router, prefix="/api/v1", tags=["campaign-briefs"])
app.include_router(holidays.router, prefix="/api/v1", tags=["holidays"])
app.include_router(agents.router, prefix="/api/v1", tags=["agents"])
app.include_router(demo.router, prefix="/api/v1", tags=["demo"])
app.include_router(guardrails.router, prefix="/api/v1", tags=["guardrails"])
app.include_router(costs.router, prefix="/api/v1", tags=["costs"])
app.include_router(integrations.router, prefix="/api/v1", tags=["integrations"])
app.include_router(settings_router.router, prefix="/api/v1", tags=["settings"])
app.include_router(webhooks_router, prefix="/api/v1", tags=["webhooks"])
