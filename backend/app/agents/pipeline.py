"""
Campaign Pipeline Orchestrator

Runs the full agent sequence for a campaign:
  1. ProspectorAgent — scores all enrolled prospects (batch LLM call)
  2. ResearchAgent — generates personalization profile per prospect (concurrent)
  3. CopywriterAgent — writes email sequence per prospect (concurrent)

Uses asyncio.gather with a semaphore(5) to parallelize per-prospect work
while respecting Claude API rate limits.
"""
import asyncio
from sqlalchemy.orm import Session
from app.models.campaign import Campaign, CampaignProspect
from app.models.prospect import Prospect
from app.models.email_sequence import EmailSequence
from app.models.activity import ActivityEvent
from app.agents.prospector import prospector_agent
from app.agents.researcher import research_agent
from app.agents.copywriter import copywriter_agent
from app.packs.loader import pack_loader
from app.services.holiday_service import holiday_service
from app.services.pipeline_progress import set_progress, clear_progress
from datetime import date


async def run_campaign_pipeline(campaign_id: int, db: Session) -> None:
    campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
    if not campaign:
        return

    vertical_pack = pack_loader.compose(
        campaign.vertical_pack,
        vendor_id=campaign.vendor_pack,
        product_id=campaign.product_pack,
    )
    regional_pack = pack_loader.load_regional(campaign.regional_pack)
    if not vertical_pack or not regional_pack:
        return

    # Load enrolled prospects
    enrolled = (
        db.query(CampaignProspect)
        .filter(CampaignProspect.campaign_id == campaign_id)
        .all()
    )
    prospect_ids = [cp.prospect_id for cp in enrolled]
    prospects = db.query(Prospect).filter(Prospect.id.in_(prospect_ids)).all()
    total = len(prospects)

    prospect_dicts = [
        {
            "id": p.id, "business_name": p.business_name, "contact_name": p.contact_name,
            "contact_title": p.contact_title, "email": p.email, "city": p.city,
            "country_code": p.country_code, "capacity_count": p.capacity_count,
            "services": p.services or [], "website_url": p.website_url,
            "tech_maturity_score": p.tech_maturity_score,
            "has_online_booking": p.has_online_booking,
            "ownership_type": p.ownership_type,
            "icp_score": p.icp_score,
            "provenance": p.provenance or {},
            "website_research": p.website_research or None,
        }
        for p in prospects
    ]

    # --- Step 1: Score all prospects (one batch LLM call) ---
    set_progress(campaign_id, "scoring", f"Scoring {total} prospects against ICP criteria...", done=0, total=total)
    try:
        scores = await prospector_agent.score_batch(prospect_dicts, vertical_pack, regional_pack, campaign_id=campaign_id)
        score_map = {s["prospect_id"]: s for s in scores}
        for p in prospects:
            if p.id in score_map:
                p.icp_score = score_map[p.id]["icp_score"]
                # Save icp_reasoning alongside any existing research profile
                existing = p.research_profile or {}
                p.research_profile = {**existing, "icp_reasoning": score_map[p.id].get("icp_reasoning", "")}
        db.commit()
        # Update prospect dicts with refreshed scores
        for pd in prospect_dicts:
            if pd["id"] in score_map:
                pd["icp_score"] = score_map[pd["id"]]["icp_score"]
    except Exception as e:
        print(f"Prospector error: {e}")  # Non-fatal — continue with existing scores

    # --- Step 2+3: Research + Copywrite per prospect (concurrent, semaphore limited) ---
    semaphore = asyncio.Semaphore(5)
    year = date.today().year
    holiday_dates = await holiday_service.get_holiday_dates_for_prompt(
        regional_pack.get("scheduling", {}).get("nager_country_code", "US"), year
    )

    completed = 0

    async def process_prospect(prospect_dict: dict):
        nonlocal completed
        async with semaphore:
            try:
                name = prospect_dict.get("business_name", f"prospect {prospect_dict['id']}")

                # Research
                set_progress(campaign_id, "researching", f"Researching {name}...", done=completed, total=total)
                research = await research_agent.run(prospect_dict, vertical_pack, regional_pack)

                # Merge the new research output into the existing profile rather
                # than overwriting — discovery's metadata (discovery_source,
                # enrichment_notes, source_url, contact_quality, contact_confidence)
                # plus any prior icp_reasoning need to survive so we keep the
                # provenance chain intact.
                p = db.query(Prospect).filter(Prospect.id == prospect_dict["id"]).first()
                if p:
                    existing = p.research_profile or {}
                    p.research_profile = {**existing, **research}
                    db.commit()

                prospect_dict["research_profile"] = research

                # Copywrite
                set_progress(campaign_id, "writing", f"Writing email sequence for {name}...", done=completed, total=total)
                sequence_result = await copywriter_agent.run(
                    prospect=prospect_dict,
                    research_profile=research,
                    vertical_pack=vertical_pack,
                    regional_pack=regional_pack,
                    num_touches=campaign.sequence_touches,
                    touch_delay_days=campaign.touch_delay_days,
                    holiday_dates=holiday_dates,
                    campaign_id=campaign_id,
                )

                # When ab_test is enabled, run a second copywriter pass to
                # generate the B variant. Same prompt, separate LLM call —
                # temperature drift produces a meaningfully different angle.
                ab_result = None
                if campaign.ab_test:
                    try:
                        ab_result = await copywriter_agent.run(
                            prospect=prospect_dict,
                            research_profile=research,
                            vertical_pack=vertical_pack,
                            regional_pack=regional_pack,
                            num_touches=campaign.sequence_touches,
                            touch_delay_days=campaign.touch_delay_days,
                            holiday_dates=holiday_dates,
                            campaign_id=campaign_id,
                        )
                    except Exception as ab_err:
                        print(f"A/B second pass failed for prospect {prospect_dict['id']}: {ab_err}")

                # Write emails to DB. Variant A = the primary EmailSequence
                # row (back-compat with every existing reader). When ab_test
                # is on, also persist EmailSequenceVariant rows for A and B.
                from app.models.email_sequence_variant import EmailSequenceVariant
                variants_b = (ab_result or {}).get("emails", []) if campaign.ab_test else []
                for idx, email in enumerate(sequence_result.get("emails", [])):
                    seq = EmailSequence(
                        campaign_id=campaign_id,
                        prospect_id=prospect_dict["id"],
                        touch_number=email.get("touch_number", 1),
                        subject=email.get("subject", ""),
                        body=email.get("body", ""),
                        persona_target=email.get("persona_target"),
                        approval_status="pending",
                        agent_metadata={
                            "hook_line": research.get("hook_line"),
                            "pain_hypothesis": research.get("pain_hypothesis"),
                            "credible_detail": research.get("credible_detail"),
                            "send_after_days": email.get("send_after_days", 0),
                        },
                    )
                    db.add(seq)
                    db.flush()  # populate seq.id for the variant FK below

                    if campaign.ab_test:
                        db.add(EmailSequenceVariant(
                            sequence_id=seq.id,
                            label="A",
                            subject=seq.subject,
                            body=seq.body,
                        ))
                        b_email = variants_b[idx] if idx < len(variants_b) else None
                        if b_email:
                            db.add(EmailSequenceVariant(
                                sequence_id=seq.id,
                                label="B",
                                subject=b_email.get("subject", ""),
                                body=b_email.get("body", ""),
                            ))
                db.commit()

            except Exception as e:
                print(f"Error processing prospect {prospect_dict['id']}: {e}")
            finally:
                completed += 1

    await asyncio.gather(*[process_prospect(p) for p in prospect_dicts])

    # Record pipeline completion event
    db.add(ActivityEvent(
        campaign_id=campaign_id,
        event_type="pipeline_completed",
        event_data={"prospect_count": total},
        is_simulated=False,
    ))
    db.commit()

    set_progress(campaign_id, "complete", f"Done — {total} email sequences ready for review", done=total, total=total)


async def run_research_for_prospect(prospect_id: int, db: Session) -> dict | None:
    """Standalone research run for a single prospect (used by /agents/research endpoint)."""
    from app.services.research_progress import set_progress, clear_progress

    p = db.query(Prospect).filter(Prospect.id == prospect_id).first()
    if not p:
        clear_progress(prospect_id)
        return None

    try:
        set_progress(prospect_id, "loading", f"Loading profile for {p.business_name}...")

        # `vertical` is required on every Prospect row (Phase 4) — no silent fallback.
        if not p.vertical:
            clear_progress(prospect_id)
            return None
        vertical_pack = pack_loader.compose_default(p.vertical)
        regional_pack = pack_loader.load_regional("us_en")
        if not vertical_pack or not regional_pack:
            clear_progress(prospect_id)
            return None

        # Use pack-provided unit label so the progress message reads naturally
        # for the active vertical ("200 berths", "200 vehicles", etc.).
        unit_label = (vertical_pack.get("industry_context") or {}).get("default_unit_label") or "units"
        size_str = f"{p.capacity_count} {unit_label}" if p.capacity_count else f"multi-{unit_label}"
        booking = "no online booking" if not p.has_online_booking else "has online booking"
        maturity = f"tech maturity {p.tech_maturity_score}/5" if p.tech_maturity_score else ""
        detail = ", ".join(filter(None, [size_str, booking, maturity]))

        set_progress(prospect_id, "analysing", f"Analysing operation: {detail}...")

        prospect_dict = {
            "id": p.id, "business_name": p.business_name, "contact_title": p.contact_title,
            "city": p.city, "country_code": p.country_code, "capacity_count": p.capacity_count,
            "services": p.services or [], "tech_maturity_score": p.tech_maturity_score,
            "has_online_booking": p.has_online_booking, "ownership_type": p.ownership_type,
            "website_url": p.website_url,
            "provenance": p.provenance or {},
            "website_research": p.website_research or None,
        }

        set_progress(prospect_id, "generating", "Generating personalisation profile...")
        research = await research_agent.run(prospect_dict, vertical_pack, regional_pack)

        set_progress(prospect_id, "saving", "Saving research profile...")
        # Merge rather than overwrite — preserve discovery metadata
        # (enrichment_notes, source_url, contact_quality, etc.) and any prior
        # icp_reasoning so the audit trail survives.
        existing = p.research_profile or {}
        p.research_profile = {**existing, **research}
        db.commit()

        set_progress(prospect_id, "complete", "Research complete.")
        return p.research_profile

    except Exception as e:
        clear_progress(prospect_id)
        raise e


async def run_website_scrape_for_prospect(
    prospect_id: int,
    db: Session,
    options: dict | None = None,
) -> dict | None:
    """Scrape one prospect's website (homepage + selected inner pages) and
    persist the structured payload to `Prospect.website_research`.

    Side effects:
      * Promotes provenance keys when the scrape confirms a fact:
          - `website_url` → "scrape" whenever verification passed.
          - `has_online_booking` → "scrape" only when promoting null → value
            (never overwrite an existing non-null answer; see plan §pitfalls).
          - `services` → "scrape" only when the scrape adds new services to
            the existing list (union merge).
      * Emits ActivityEvent rows reflecting the outcome:
          - `website_scraped` on success.
          - `website_unverified` when the URL fails verification.
          - `website_scrape_blocked_by_robots` when homepage robots.txt
            disallows our UA (no inner pages fetched).
          - `website_scrape_failed` on unexpected errors.
    """
    from app.services.website_scrape_progress import (
        set_progress as set_scrape_progress,
        clear_progress as clear_scrape_progress,
    )
    from app.agents.website_enrichment import website_enrichment_agent

    p = db.query(Prospect).filter(Prospect.id == prospect_id).first()
    if not p:
        clear_scrape_progress(prospect_id)
        return None
    if not p.website_url:
        clear_scrape_progress(prospect_id)
        db.add(ActivityEvent(
            prospect_id=prospect_id,
            event_type="website_scrape_failed",
            event_data={"reason": "no_website_url"},
            is_simulated=False,
        ))
        db.commit()
        return None

    try:
        set_scrape_progress(prospect_id, "verifying", f"Verifying {p.website_url}...")

        if not p.vertical:
            clear_scrape_progress(prospect_id)
            return None
        vertical_pack = pack_loader.compose_default(p.vertical)
        regional_pack = pack_loader.load_regional("us_en")
        if not vertical_pack or not regional_pack:
            clear_scrape_progress(prospect_id)
            return None

        prospect_dict = {
            "id": p.id, "business_name": p.business_name, "contact_title": p.contact_title,
            "city": p.city, "country_code": p.country_code, "vertical": p.vertical,
            "website_url": p.website_url,
            "services": p.services or [],
            "has_online_booking": p.has_online_booking,
            "provenance": p.provenance or {},
        }

        set_scrape_progress(prospect_id, "fetching", "Fetching homepage and inner pages...")
        payload = await website_enrichment_agent.run(
            prospect_dict,
            vertical_pack,
            regional_pack,
            vendor_pack=None,
            options=options or {},
        )

        set_scrape_progress(prospect_id, "saving", "Saving website research...")

        # Write the structured payload.
        p.website_research = payload

        # Promote provenance + write-back when verified.
        if payload.get("verified"):
            provenance = dict(p.provenance or {})
            promoted_fields: list[str] = []

            # website_url is now verified by the scrape itself.
            provenance["website_url"] = "scrape"
            promoted_fields.append("website_url")

            # has_online_booking — only promote null → value. Never overwrite
            # an existing non-null answer (avoids a misread homepage downgrading
            # a manually-corrected fact).
            scraped_booking = payload.get("has_online_booking")
            if scraped_booking is not None and p.has_online_booking is None:
                p.has_online_booking = bool(scraped_booking)
                provenance["has_online_booking"] = "scrape"
                promoted_fields.append("has_online_booking")

            # services — union-merge. Only promote provenance if the list grew.
            scraped_services = [s for s in (payload.get("services_list") or []) if s]
            if scraped_services:
                existing_services = list(p.services or [])
                existing_lower = {s.strip().lower() for s in existing_services if isinstance(s, str)}
                added = [s for s in scraped_services if s.strip().lower() not in existing_lower]
                if added:
                    p.services = [*existing_services, *added]
                    provenance["services"] = "scrape"
                    promoted_fields.append("services")

            # email — auto-promote a discovered, deliverable address to primary.
            # Web-found emails beat Claude-generated guesses (which tend to be
            # pattern-matched placeholders like "manager@<domain>"). We skip
            # the swap when the user has explicitly set the current address
            # (provenance.email == "user") or when the recommended address
            # collides with another prospect's email (unique constraint).
            recommended = payload.get("recommended_email")
            current_email_provenance = provenance.get("email")
            if (
                recommended
                and current_email_provenance != "user"
                and recommended != (p.email or "").strip().lower()
            ):
                discovered = payload.get("discovered_emails") or []
                match = next(
                    (
                        d for d in discovered
                        if (d.get("email") or "").strip().lower() == recommended
                    ),
                    None,
                )
                if match and match.get("deliverable"):
                    conflict = (
                        db.query(Prospect.id)
                        .filter(Prospect.email == recommended, Prospect.id != prospect_id)
                        .first()
                    )
                    if not conflict:
                        previous_email = p.email
                        p.email = recommended
                        provenance["email"] = "scrape"
                        promoted_fields.append("email")
                        db.add(ActivityEvent(
                            prospect_id=prospect_id,
                            event_type="prospect_email_updated",
                            event_data={
                                "source": "website_scrape_auto",
                                "previous_email": previous_email,
                                "new_email": recommended,
                                "reason": "Discovered on the prospect's own website; the previous address had not been confirmed by a user.",
                            },
                            is_simulated=False,
                        ))

            p.provenance = provenance

            db.add(ActivityEvent(
                prospect_id=prospect_id,
                event_type="website_scraped",
                event_data={
                    "pages_fetched": (payload.get("meta") or {}).get("pages_fetched", []),
                    "provider": (payload.get("meta") or {}).get("provider"),
                    "summary_excerpt": (payload.get("summary") or "")[:240],
                    "competitors_count": len(payload.get("competitors_mentioned") or []),
                    "promoted_fields": promoted_fields,
                    "scrape_blocked": payload.get("scrape_blocked"),
                },
                is_simulated=False,
            ))
            if payload.get("scrape_blocked") == "robots_txt":
                db.add(ActivityEvent(
                    prospect_id=prospect_id,
                    event_type="website_scrape_blocked_by_robots",
                    event_data={"website_url": p.website_url},
                    is_simulated=False,
                ))
        else:
            db.add(ActivityEvent(
                prospect_id=prospect_id,
                event_type="website_unverified",
                event_data={
                    "reason": payload.get("reason"),
                    "message": payload.get("message"),
                    "website_url": p.website_url,
                },
                is_simulated=False,
            ))

        db.commit()
        set_scrape_progress(prospect_id, "complete", "Website research complete.")
        return p.website_research

    except Exception as e:
        try:
            db.add(ActivityEvent(
                prospect_id=prospect_id,
                event_type="website_scrape_failed",
                event_data={"reason": "exception", "message": str(e)[:240]},
                is_simulated=False,
            ))
            db.commit()
        except Exception:
            db.rollback()
        clear_scrape_progress(prospect_id)
        raise e
