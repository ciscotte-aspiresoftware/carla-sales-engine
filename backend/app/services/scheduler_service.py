"""
Lightweight in-process cadence scheduler.

Wraps APScheduler with a SQLite job store so the backend can self-send
sequences on a per-campaign cadence without introducing a real job queue
(Celery/Redis). Single-process, restart-safe (jobs persist across reboots),
demo-grade.

Cadence options on a Campaign:
  - "immediate"              fire on enqueue
  - "next_business_day_9am"  next weekday at the configured business_hours_start in the configured timezone
  - "weekly_tuesday_10am"    next Tuesday at 10:00 in the configured timezone
  - "custom"                 cron expression in `Campaign.cadence_custom_cron`

Auto-send is opt-in per campaign (`Campaign.auto_send`). When False, the
scheduler ignores the campaign — sequences only ship when a user clicks
through manually or hits POST /api/v1/sequences/{id}/mark-sent.

If APScheduler is not installed the scheduler degrades gracefully: every
call no-ops, the backend still boots, the rest of the engine is unaffected.
This lets us land the integration before the receiving portfolio team runs
`pip install -r requirements.txt`.
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone as _tz
from typing import Optional
from zoneinfo import ZoneInfo

from app.database import SessionLocal
from app.models.campaign import Campaign
from app.models.email_sequence import EmailSequence

logger = logging.getLogger(__name__)


# ── Optional dependency: APScheduler ─────────────────────────────────────
try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
    from apscheduler.triggers.cron import CronTrigger
    from apscheduler.triggers.date import DateTrigger
    _HAS_APSCHEDULER = True
except ImportError:
    BackgroundScheduler = None  # type: ignore
    SQLAlchemyJobStore = None  # type: ignore
    CronTrigger = None  # type: ignore
    DateTrigger = None  # type: ignore
    _HAS_APSCHEDULER = False


# ── Cadence resolution ───────────────────────────────────────────────────


def _tz_obj() -> ZoneInfo:
    from app.services.app_settings_service import app_settings_service
    name = app_settings_service.get_or_env("timezone") or "UTC"
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("UTC")


def _business_hours_start() -> time:
    from app.services.app_settings_service import app_settings_service
    raw = app_settings_service.get_or_env("business_hours_start") or "09:00"
    try:
        h, m = raw.split(":")
        return time(int(h), int(m))
    except Exception:
        return time(9, 0)


def _next_business_day_at(start: time, *, after: Optional[datetime] = None) -> datetime:
    """Return the next weekday (Mon–Fri) at `start` in the configured TZ.
    If today's start time is still in the future, today qualifies."""
    tz = _tz_obj()
    now = (after or datetime.now(_tz.utc)).astimezone(tz)
    candidate = now.replace(hour=start.hour, minute=start.minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:  # 5,6 = Sat, Sun
        candidate += timedelta(days=1)
    return candidate


def _next_weekly_tuesday_10am(*, after: Optional[datetime] = None) -> datetime:
    tz = _tz_obj()
    now = (after or datetime.now(_tz.utc)).astimezone(tz)
    candidate = now.replace(hour=10, minute=0, second=0, microsecond=0)
    days_ahead = (1 - now.weekday()) % 7  # Tuesday = 1
    if days_ahead == 0 and candidate <= now:
        days_ahead = 7
    return candidate + timedelta(days=days_ahead)


def resolve_send_at(campaign: Campaign, *, after: Optional[datetime] = None) -> datetime:
    """Return the next datetime at which a sequence for this campaign should
    fire under its cadence. Always returns a TZ-aware datetime."""
    cadence = campaign.send_cadence or "immediate"
    if cadence == "immediate":
        return (after or datetime.now(_tz.utc))
    if cadence == "next_business_day_9am":
        return _next_business_day_at(_business_hours_start(), after=after)
    if cadence == "weekly_tuesday_10am":
        return _next_weekly_tuesday_10am(after=after)
    # custom cron: caller uses CronTrigger directly; we still surface a
    # rough "now" so consumers that don't deal with cron get a usable value.
    return (after or datetime.now(_tz.utc))


# ── Scheduler singleton ──────────────────────────────────────────────────


class SchedulerService:
    def __init__(self) -> None:
        self._scheduler = None  # type: ignore

    def start(self) -> None:
        if not _HAS_APSCHEDULER:
            logger.warning("scheduler_service: APScheduler not installed — auto_send is a no-op until `pip install apscheduler`")
            return
        if self._scheduler is not None:
            return
        # Reuse the engine's SQLite database for the job store so jobs survive
        # backend restarts. Falls back to the configured DATABASE_URL.
        from app.config import settings
        jobstores = {"default": SQLAlchemyJobStore(url=settings.database_url)}
        self._scheduler = BackgroundScheduler(jobstores=jobstores, timezone=str(_tz_obj()))
        self._scheduler.start()
        logger.info("scheduler_service: APScheduler started (jobstore=%s)", settings.database_url)

    def shutdown(self) -> None:
        if self._scheduler is not None:
            self._scheduler.shutdown(wait=False)
            self._scheduler = None

    def schedule_sequence_send(self, sequence_id: int, send_at: datetime, *, cron: Optional[str] = None) -> None:
        """Register an APScheduler job that calls sequence_service.mark_sent.
        If `cron` is provided the job uses CronTrigger; otherwise DateTrigger
        at `send_at`. Idempotent — replaces an existing job with the same id.
        """
        if not _HAS_APSCHEDULER or self._scheduler is None:
            return
        job_id = _job_id(sequence_id)
        if cron:
            try:
                trigger = CronTrigger.from_crontab(cron, timezone=str(_tz_obj()))
            except Exception as e:
                logger.warning("scheduler_service: invalid cron %r — %s", cron, e)
                trigger = DateTrigger(run_date=send_at)
        else:
            trigger = DateTrigger(run_date=send_at)
        self._scheduler.add_job(
            _fire_sequence_send,
            trigger=trigger,
            args=[sequence_id],
            id=job_id,
            replace_existing=True,
            misfire_grace_time=600,
        )

    def cancel_sequence_send(self, sequence_id: int) -> None:
        if not _HAS_APSCHEDULER or self._scheduler is None:
            return
        try:
            self._scheduler.remove_job(_job_id(sequence_id))
        except Exception:
            pass

    def reschedule_campaign(self, campaign_id: int) -> int:
        """Walk every approved-but-unsent sequence for a campaign and either
        schedule or cancel its job based on the campaign's cadence + auto_send.
        Returns the count of sequences scheduled."""
        if not _HAS_APSCHEDULER or self._scheduler is None:
            return 0
        db = SessionLocal()
        try:
            campaign = db.query(Campaign).filter(Campaign.id == campaign_id).first()
            if not campaign:
                return 0
            sequences = (
                db.query(EmailSequence)
                .filter(
                    EmailSequence.campaign_id == campaign_id,
                    EmailSequence.sent_at.is_(None),
                    EmailSequence.approval_status == "approved",
                )
                .all()
            )
            scheduled = 0
            for seq in sequences:
                if not campaign.auto_send:
                    self.cancel_sequence_send(seq.id)
                    continue
                send_at = resolve_send_at(campaign)
                if campaign.send_cadence == "custom" and campaign.cadence_custom_cron:
                    self.schedule_sequence_send(seq.id, send_at, cron=campaign.cadence_custom_cron)
                else:
                    self.schedule_sequence_send(seq.id, send_at)
                scheduled += 1
            return scheduled
        finally:
            db.close()


def _job_id(sequence_id: int) -> str:
    return f"sequence_send:{sequence_id}"


def _fire_sequence_send(sequence_id: int) -> None:
    """Top-level callable so APScheduler can persist a reference to it across
    process restarts (lambdas don't pickle)."""
    from app.services.sequence_service import sequence_service
    db = SessionLocal()
    try:
        sequence_service.mark_sent(db, sequence_id)
    except Exception as e:
        logger.exception("scheduler_service: mark_sent failed for sequence %s: %s", sequence_id, e)
    finally:
        db.close()


scheduler_service = SchedulerService()
