// ReclassifyTab - the in-editor tab that lets the user re-run the classifier
// against already-scraped companies in this ICP's vertical, without
// re-scraping. Three states:
//
//   1. PREVIEW  - target list rendered with checkboxes + current verdict per
//                 row. User picks subset, clicks Start.
//   2. RUNNING  - streamed per-company log via the existing Socket.IO
//                 sweep_event channel (cellId='reclassify'). Each row's
//                 status flips: pending → scanning → matched/rejected, with
//                 old → new diff inline.
//   3. DONE     - run finished; the after-the-fact view is the same rows but
//                 with the final verdicts + flipped indicator.
//
// State boundary with the parent (Editor):
//   - Parent decides whether this tab is visible (definition fields changed
//     OR there are unclassified companies in the vertical). This component
//     just renders when mounted.
//   - Parent passes `icpId` (immutable for a given mount) and `vertical`
//     (display only). All API calls happen here.
//   - Parent owns the WHOLE ICP form state - we don't mutate anything, only
//     read targets + their classifications via the dedicated endpoint.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw, Play, Sparkles, ChevronDown, ChevronRight, Check, X as XIcon, Pause, AlertTriangle, MapPin, Phone, Star, ExternalLink } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import { useSweepEvents, type SweepEvent } from '@/hooks/use-sweep-events'

const API = API_BASE

interface Classification {
  is_match: boolean
  reason: string
  classifiedAt: number | null
  // Hash of the ICP definition this verdict was made under (added in
  // migration 0005). NULL on legacy classifications from before the
  // server-side staleness check; the targets endpoint then sets
  // definitionStale=true for those rows so the user can clear them up.
  definitionHash?: string | null
  // Google Maps signals captured at sweep time. Optional everywhere -
  // legacy classifications and "no website" placeholder rows may carry
  // only a subset, the renderer falls through cleanly when any is missing.
  title?: string | null
  phone?: string | null
  address?: string | null
  rating?: number | null
  reviews?: number | null
}

interface Target {
  domain: string
  name: string | null
  city: string | null
  url: string | null
  classification: Classification | null
  // Server-side flag: the stored verdict was made under a different
  // (or missing) ICP definition hash than the one currently saved on
  // the ICP, so the verdict is stale. THIS replaces the client-side
  // baseline-snapshot detection that broke on save+close+reopen - the
  // server can tell every time, regardless of session boundaries.
  definitionStale: boolean
}

export interface TargetsResponse {
  success: boolean
  error?: string
  vertical: string
  total: number
  classified: number
  unclassified: number
  stale: number
  currentHash: string | null
  targets: Target[]
}

// Per-row runtime state - merges the static target row data with what's
// happening live via the socket stream.
type RowStatus = 'pending' | 'scanning' | 'qualified' | 'rejected' | 'skipped' | 'error'

interface RowState {
  status: RowStatus
  oldVerdict: { is_match: boolean; reason: string } | null
  newVerdict: { is_match: boolean; reason: string } | null
  flipped: boolean
  skipReason?: string
}

interface ScrapePreview {
  hasScrape: boolean
  pageTitle: string | null
  scrapedAt: number | null
  snippet: string | null
  truncated?: boolean
  totalChars?: number
}

// Shape returned by GET /api/icps/jobs/reclassify and the per-job GET.
// Mirrors api/db/migrations/0014_reclassify_jobs.sql column-for-column so
// the frontend can render any persisted job without a parser shim.
interface ReclassifyJobRow {
  id: string
  icp_id: string
  status: 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'crashed'
  force: boolean
  cancel_requested: boolean
  total: number
  processed: number
  qualified: number
  rejected: number
  skipped: number
  flipped: number
  errors: number
  current_domain: string | null
  last_error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

// Per-domain row returned alongside a job by GET /api/icps/jobs/reclassify/:id.
interface ReclassifyResultRow {
  id: string
  job_id: string
  order_idx: number
  domain: string
  company_name: string | null
  city: string | null
  status: 'pending' | 'in_flight' | 'classified' | 'skipped' | 'errored' | 'cancelled'
  old_is_match: boolean | null
  old_reason: string | null
  new_is_match: boolean | null
  new_reason: string | null
  flipped: boolean
  skip_reason: string | null
  error_message: string | null
  completed_at: string | null
}

export function ReclassifyTab({
  icpId,
  vertical,
  activeCountries,
  activeCities,
  targets,
  totals,
  loadingTargets,
  targetsError,
  refreshTargets,
  hasDefinitionChanges,
  hasUnsavedChanges,
  onRequestSave,
}: {
  icpId: string
  vertical: string
  // ICP's CURRENT definition scope (i.e. what's saved on the icps row right
  // now). Drives the historical-vs-active determination for filter chips:
  // a city/country that appears in `targets` but is missing from these arrays
  // is "historical" - it was classified under a prior definition but isn't
  // in scope anymore. Those chips render greyed and their companies are
  // visible but unselectable.
  activeCountries: string[]
  activeCities: string[]
  // Targets data is owned by the parent (Editor) so the tab-visibility gate
  // and this view share one fetch. The parent also passes the refresh
  // callback so a "Refresh" click here triggers the same loader the gate uses.
  targets: Target[]
  totals: { total: number; classified: number; unclassified: number; stale: number }
  loadingTargets: boolean
  targetsError: string | null
  refreshTargets: () => void
  // When the user has edited definition fields, the previous classifications
  // are stale and reclassify would produce different results. We surface this
  // as a "you should save first" banner since reclassify reads the persisted
  // ICP, not the in-memory edit state.
  hasDefinitionChanges: boolean
  hasUnsavedChanges: boolean
  onRequestSave: () => void
}) {
  // ── Selection ────────────────────────────────────────────────────────
  // Default: per-row staleness (computed server-side via the definition
  // hash). A row is pre-selected when its server-flagged `definitionStale`
  // is true OR it has no classification yet. Survives editor close +
  // reopen because the staleness signal lives on the database row, not in
  // a client-side baseline snapshot.
  //
  // `hasDefinitionChanges` (client-side baseline) is still consulted as a
  // soft override: if the user has UNSAVED edits, every classified row is
  // about-to-be-stale, so pre-select everything to match intent. After
  // they save the server-side `definitionStale` flag takes over and the
  // pre-selection stays consistent.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [defaultsApplied, setDefaultsApplied] = useState(false)
  useEffect(() => {
    if (defaultsApplied || targets.length === 0) return
    const next = new Set<string>()
    for (const t of targets) {
      // Default selection = ONLY stale verdicts (or unsaved-but-about-to-be-
      // stale ones). Never-classified rows are deliberately excluded so a
      // user who edits 10 cells' worth of an ICP doesn't accidentally queue
      // up the other 150 sibling-fanout rows that ICP1 was never run on.
      // "Stale + new" in the toolbar is one click away for the widen case.
      const should = t.definitionStale || hasDefinitionChanges
      if (should) next.add(t.domain)
    }
    setSelected(next)
    setDefaultsApplied(true)
  }, [targets, hasDefinitionChanges, defaultsApplied])
  const toggleOne = (domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain); else next.add(domain)
      return next
    })
  }
  // ── City + country chip filter ───────────────────────────────────────
  // Two rows of toggleable chips above the target list, one per city, one
  // per country (countries derived via the geocoder cache). Chips are
  // multi-select; empty = no filter on that axis. Two filters AND together.
  //
  // Each city/country chip carries an "active" flag (in the ICP's current
  // saved definition) vs "historical" (the city/country shows up in
  // already-classified rows but was removed from the ICP since). Historical
  // chips render greyed but stay clickable so the user can still surface
  // those companies for review. The COMPANIES on historical chips are
  // greyed + their checkboxes are disabled - they can be inspected but not
  // queued for re-classification (out of current scope).

  // Resolve country per target city via the same batch endpoint the ICP
  // editor uses (api/grid/cities-info → geocoded_cities). Cached by city
  // name so editing/filtering doesn't re-fetch.
  const [cityCountries, setCityCountries] = useState<Record<string, string | null>>({})
  useEffect(() => {
    const wanted = Array.from(new Set(
      targets.map((t) => (t.city || '').trim()).filter(Boolean)
    )).filter((c) => !(c in cityCountries))
    if (wanted.length === 0) return
    let cancelled = false
    safeFetchJson(`${API}/api/grid/cities-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: wanted }),
    })
      .then((data) => {
        if (cancelled || !data?.success) return
        setCityCountries((prev) => {
          const next = { ...prev }
          for (const name of wanted) {
            const r = data.results?.[name]
            next[name] = r?.country ? String(r.country).toUpperCase() : null
          }
          return next
        })
      })
      .catch(() => { /* non-fatal; chips just won't show country for unresolved */ })
    return () => { cancelled = true }
  }, [targets, cityCountries])

  // Sets for fast membership checks - case-insensitive city / uppercased country.
  const activeCitiesSet = useMemo(
    () => new Set((activeCities || []).map((c) => c.trim().toLowerCase()).filter(Boolean)),
    [activeCities],
  )
  const activeCountriesSet = useMemo(
    () => new Set((activeCountries || []).map((c) => c.toUpperCase()).filter(Boolean)),
    [activeCountries],
  )
  const isCityActive = (c: string) => activeCitiesSet.has(c.trim().toLowerCase())
  const isCountryActive = (cc: string) => activeCountriesSet.has(cc.toUpperCase())

  // Distinct cities + counts in the target set, sorted by count desc.
  const cityChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of targets) {
      const c = (t.city || '').trim()
      if (!c) continue
      counts.set(c, (counts.get(c) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([city, count]) => ({ city, count, active: isCityActive(city) }))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.count - a.count || a.city.localeCompare(b.city))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, activeCitiesSet])

  // Distinct countries (resolved) + counts. Rows whose city hasn't resolved
  // yet contribute to no country bucket - they'll re-tally on the next render
  // after cityCountries fills in.
  const countryChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of targets) {
      const city = (t.city || '').trim()
      const cc = city ? cityCountries[city] : null
      if (!cc) continue
      counts.set(cc, (counts.get(cc) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([cc, count]) => ({ country: cc, count, active: isCountryActive(cc) }))
      .sort((a, b) => Number(b.active) - Number(a.active) || b.count - a.count || a.country.localeCompare(b.country))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, cityCountries, activeCountriesSet])

  // Filter state - multi-select sets, empty = no filter on that axis.
  const [selectedCityChips, setSelectedCityChips] = useState<Set<string>>(new Set())
  const [selectedCountryChips, setSelectedCountryChips] = useState<Set<string>>(new Set())
  const toggleCityChip = (city: string) => setSelectedCityChips((prev) => {
    const next = new Set(prev); if (next.has(city)) next.delete(city); else next.add(city); return next
  })
  const toggleCountryChip = (cc: string) => setSelectedCountryChips((prev) => {
    const next = new Set(prev); if (next.has(cc)) next.delete(cc); else next.add(cc); return next
  })
  const clearChipFilters = () => { setSelectedCityChips(new Set()); setSelectedCountryChips(new Set()) }

  // Per-row "in current ICP scope" test. A row is OUT of scope (historical) if
  // either its city or its resolved country is missing from the ICP's
  // current definition. Rows where the country hasn't been resolved yet
  // default to in-scope to avoid a flash-of-greyed during the initial load.
  const isRowActive = (t: Target): boolean => {
    const city = (t.city || '').trim()
    const cc = city ? cityCountries[city] : null
    const cityOk = !city || isCityActive(city)
    const countryOk = !cc || isCountryActive(cc)
    return cityOk && countryOk
  }

  // Apply chip filters. Returns the rows the user CAN see in the list -
  // historical rows still pass through here (the "active" determination is
  // separate from the filter), just rendered greyed below.
  const visibleTargets = useMemo(() => {
    return targets.filter((t) => {
      const city = (t.city || '').trim()
      const cc = city ? cityCountries[city] : null
      if (selectedCityChips.size > 0 && !selectedCityChips.has(city)) return false
      if (selectedCountryChips.size > 0 && (!cc || !selectedCountryChips.has(cc))) return false
      return true
    })
  }, [targets, selectedCityChips, selectedCountryChips, cityCountries])

  // Selection helpers operate on visible AND in-scope rows only - selecting
  // historical rows would just produce skipped runs server-side (the
  // reclassify path can run them but conceptually they're out of the ICP's
  // current targeting, so the toolbar buttons exclude them by default).
  const selectAll = () => setSelected((prev) => {
    const next = new Set(prev)
    for (const t of visibleTargets) if (isRowActive(t)) next.add(t.domain)
    return next
  })
  const selectNone = () => setSelected((prev) => {
    const next = new Set(prev); for (const t of visibleTargets) next.delete(t.domain); return next
  })
  const selectUnclassified = () => setSelected((prev) => {
    const next = new Set(prev)
    for (const t of visibleTargets) if (!t.classification && isRowActive(t)) next.add(t.domain)
    return next
  })
  // "Stale" = server-flagged definitionStale OR not yet classified. The two
  // are different categorically but both need a fresh classify run, so the
  // toolbar groups them. Lets the user one-click "everything that needs
  // attention" without including already-fresh rows.
  const selectStale = () => setSelected((prev) => {
    const next = new Set(prev)
    for (const t of visibleTargets) if ((t.definitionStale || !t.classification) && isRowActive(t)) next.add(t.domain)
    return next
  })

  // ── Run state ────────────────────────────────────────────────────────
  // Two-stage: "running" while the POST is in flight, "complete" after the
  // response arrives. The streamed events keep updating row state during
  // the in-flight window. After complete, the streamed log is still in
  // memory but we also overwrite from response.results for resilience
  // (the socket can drop and we don't want to lose the diff).
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  // Per-row dynamic state. Indexed by domain. Empty until the user starts a
  // run - the preview list shows the persisted classification (from targets)
  // rather than RowState.
  const [rowState, setRowState] = useState<Record<string, RowState>>({})
  // Backend job id once a reclassify is enqueued. While set, the polling
  // effect below tracks the worker's progress and flips `running` off when
  // the job hits a terminal status. Cleared on completion or component
  // unmount. The matching ref is used inside startRun's `finally` to read
  // the value synchronously without a stale-closure capture.
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const activeJobIdRef = useRef<string | null>(null)
  useEffect(() => { activeJobIdRef.current = activeJobId }, [activeJobId])
  // Snapshot of recent jobs for this ICP. Refreshed on enqueue + poll so
  // the small "Recent reclassify jobs" strip below the run button shows
  // historical runs (each with status + counters) without a manual reload.
  const [recentJobs, setRecentJobs] = useState<ReclassifyJobRow[]>([])
  const [activeJob, setActiveJob] = useState<ReclassifyJobRow | null>(null)

  // Initial + periodic load of recent jobs for this ICP. Cheap (one
  // indexed query) so we just fetch on mount; the polling effect below
  // refreshes during an active run.
  useEffect(() => {
    let cancelled = false
    safeFetchJson(`${API}/api/icps/jobs/reclassify?icp=${encodeURIComponent(icpId)}&limit=10`)
      .then((d: any) => { if (!cancelled && d?.success) setRecentJobs(d.jobs || []) })
      .catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [icpId])

  // Poll the active job until it reaches a terminal status. The 1500ms
  // cadence is a comfortable middle ground: tight enough that the UI
  // doesn't feel laggy when the worker just finished, loose enough that
  // we don't pound the DB during a long-running job. Live row updates
  // come through Socket.IO (see effect below) - this poll is the safety
  // net for missed events + the authoritative source of the job status.
  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    const POLL_MS = 1500
    const pollOnce = async () => {
      try {
        const d: any = await safeFetchJson(`${API}/api/icps/jobs/reclassify/${encodeURIComponent(activeJobId)}`)
        if (cancelled || !d?.success) return
        const job: ReclassifyJobRow = d.job
        const results: ReclassifyResultRow[] = d.results || []
        setActiveJob(job)
        // Reconcile rowState from the authoritative result list. We don't
        // wipe what's already there - just patch terminal rows. The Socket
        // events handle in-flight transitions visually.
        setRowState((prev) => {
          const next = { ...prev }
          for (const r of results) {
            const cur = next[r.domain] || {
              status: 'pending' as RowStatus,
              oldVerdict: r.old_is_match === null ? null : { is_match: !!r.old_is_match, reason: r.old_reason || '' },
              newVerdict: null,
              flipped: false,
            }
            if (r.status === 'classified' && r.new_is_match !== null) {
              next[r.domain] = {
                ...cur,
                status: r.new_is_match ? 'qualified' : 'rejected',
                oldVerdict: r.old_is_match === null ? cur.oldVerdict : { is_match: !!r.old_is_match, reason: r.old_reason || '' },
                newVerdict: { is_match: !!r.new_is_match, reason: r.new_reason || '' },
                flipped: !!r.flipped,
              }
            } else if (r.status === 'skipped') {
              next[r.domain] = { ...cur, status: 'skipped', skipReason: r.skip_reason || 'skipped' }
            } else if (r.status === 'errored') {
              next[r.domain] = { ...cur, status: 'error', skipReason: r.error_message || 'errored' }
            }
          }
          return next
        })
        const terminal = job.status === 'completed' || job.status === 'cancelled' || job.status === 'crashed'
        if (terminal) {
          setRunning(false)
          setActiveJobId(null)
          // Refresh the recent-jobs strip + refresh persisted targets so
          // re-opening the editor shows the new classifications.
          safeFetchJson(`${API}/api/icps/jobs/reclassify?icp=${encodeURIComponent(icpId)}&limit=10`)
            .then((dd: any) => { if (!cancelled && dd?.success) setRecentJobs(dd.jobs || []) })
            .catch(() => {})
          refreshTargets()
        }
      } catch {
        /* transient errors: just try again on the next tick */
      }
    }
    pollOnce()
    const t = setInterval(pollOnce, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
    // refreshTargets is intentionally omitted - including it would re-run
    // the polling effect whenever the parent re-rendered, which kills the
    // 1.5s cadence we just dialed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId, icpId])

  // Cancel an in-flight job. Tells the backend to flag cancel_requested;
  // the worker stops on the next tick boundary, the poll above sees the
  // 'cancelled' status, and the UI flips back to idle.
  const cancelActiveJob = async () => {
    if (!activeJobId) return
    try {
      await safeFetchJson(`${API}/api/icps/jobs/reclassify/${encodeURIComponent(activeJobId)}/cancel`, { method: 'POST' })
    } catch (e: any) {
      setRunError(e?.message || 'cancel failed')
    }
  }

  // Subscribe to the realtime socket scoped to this ICP. The hook joins the
  // ICP room and surfaces every event whose icpId matches. We filter to
  // cellId='reclassify' so live sweep events (from a sweep running
  // concurrently in another tab) don't leak in.
  const { events } = useSweepEvents(icpId)
  // Track the highest event id we've processed - lets us derive row updates
  // without re-processing the full event buffer on every render.
  const processedEventIdRef = useRef<number>(0)
  useEffect(() => {
    if (events.length === 0) return
    // Hook stores newest-first. Process oldest-new event upward so state
    // transitions land in arrival order.
    const fresh: SweepEvent[] = []
    for (const e of events) {
      if (e.id <= processedEventIdRef.current) break
      fresh.unshift(e)
    }
    if (fresh.length === 0) return
    processedEventIdRef.current = Math.max(processedEventIdRef.current, fresh[fresh.length - 1].id)
    setRowState((prev) => {
      const next = { ...prev }
      for (const e of fresh) {
        if (e.cellId !== 'reclassify') continue
        if (!e.domain) continue
        const cur = next[e.domain] || { status: 'pending', oldVerdict: null, newVerdict: null, flipped: false }
        switch (e.type) {
          case 'company_scanning':
            next[e.domain] = { ...cur, status: 'scanning' }
            break
          case 'company_qualified':
          case 'company_rejected':
            next[e.domain] = {
              status: e.type === 'company_qualified' ? 'qualified' : 'rejected',
              oldVerdict: e.oldVerdict || cur.oldVerdict,
              newVerdict: e.newVerdict || { is_match: e.type === 'company_qualified', reason: e.reason || '' },
              flipped: !!e.flipped,
            }
            break
          case 'company_skipped':
            next[e.domain] = { ...cur, status: 'skipped', skipReason: e.reason || 'skipped' }
            break
          case 'company_error':
            next[e.domain] = { ...cur, status: 'error', skipReason: e.reason || 'error' }
            break
        }
      }
      return next
    })
  }, [events])

  const startRun = async () => {
    if (running || selected.size === 0) return
    setRunning(true); setRunError(null)
    // Seed rowState so every selected row immediately shows "scanning…" -
    // the per-company events that follow will refine each row. Without the
    // seed, rows would stay in their persisted-classification view until
    // the first event lands, which feels laggy.
    const seed: Record<string, RowState> = {}
    for (const t of targets) {
      if (!selected.has(t.domain)) continue
      const old = t.classification ? { is_match: t.classification.is_match, reason: t.classification.reason } : null
      seed[t.domain] = { status: 'pending', oldVerdict: old, newVerdict: null, flipped: false }
    }
    setRowState(seed)
    processedEventIdRef.current = 0
    try {
      // POST now enqueues a background job and returns immediately with a
      // jobId. The actual classification happens in utils/reclassify-worker.js
      // - we drive the UI via Socket.IO `sweep_event` (already wired below)
      // for live row updates AND poll GET /jobs/reclassify/:id for the
      // authoritative final state + a job-done signal. The live events get
      // there first for individual rows; polling is the safety net so we
      // never miss the final "complete" transition when a tab regains focus
      // mid-run.
      const data = await safeFetchJson(`${API}/api/icps/${encodeURIComponent(icpId)}/reclassify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domains: Array.from(selected),
          // Force=true so the user's explicit pick beats the skip-already-
          // classified shortcut. They wouldn't have ticked the row if they
          // didn't want it re-run.
          force: true,
        }),
      })
      if (!data?.success) throw new Error(data?.error || 'reclassify enqueue failed')
      if (data.jobId) {
        setActiveJobId(data.jobId)
        // Don't flip `running` off here - the polling effect handles it
        // when the job reaches a terminal status. Returning early leaves
        // the UI in "running" until the worker finishes.
        return
      }
      // jobId can be null when targets resolved to zero rows (edge case).
      // Fall through to the no-op happy path.
      refreshTargets()
    } catch (e: any) {
      setRunError(e?.message || 'reclassify enqueue failed')
    } finally {
      // Only flip off on the empty-targets / error path. The polling
      // effect handles the running case.
      if (!activeJobIdRef.current) setRunning(false)
    }
  }

  // ── Per-row scrape preview (lazy fetch on expand) ───────────────────
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [scrapeCache, setScrapeCache] = useState<Record<string, ScrapePreview | 'loading' | 'error'>>({})
  const toggleExpand = async (domain: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain); else next.add(domain)
      return next
    })
    if (scrapeCache[domain] !== undefined) return // already fetched / loading
    setScrapeCache((p) => ({ ...p, [domain]: 'loading' }))
    try {
      const data = await safeFetchJson(`${API}/api/icps/${encodeURIComponent(icpId)}/scrape-preview/${encodeURIComponent(domain)}`)
      if (!data?.success) throw new Error(data?.error || 'scrape preview failed')
      setScrapeCache((p) => ({ ...p, [domain]: data as ScrapePreview }))
    } catch {
      setScrapeCache((p) => ({ ...p, [domain]: 'error' }))
    }
  }

  // ── Derived counters ─────────────────────────────────────────────────
  const counters = useMemo(() => {
    let qualified = 0, rejected = 0, scanning = 0, skipped = 0, errored = 0, flipped = 0
    for (const r of Object.values(rowState)) {
      if (r.status === 'qualified') qualified++
      else if (r.status === 'rejected') rejected++
      else if (r.status === 'scanning') scanning++
      else if (r.status === 'skipped') skipped++
      else if (r.status === 'error') errored++
      if (r.flipped) flipped++
    }
    return { qualified, rejected, scanning, skipped, errored, flipped }
  }, [rowState])

  const total = targets.length
  const selectedCount = selected.size

  return (
    <div className="space-y-3">
      {/* Header bar with totals + refresh */}
      <div className={cn(GLASS_SUBTLE, 'rounded-md p-3 flex items-center gap-3')}>
        <RefreshCw className="h-3.5 w-3.5 text-sky-500" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold">Reclassify</div>
          <div className="text-[11px] text-muted-foreground leading-tight">
            {loadingTargets
              ? 'Loading cached companies…'
              : <>
                  <span className="font-mono">{totals.total}</span> cached <span className="font-semibold">{vertical}</span> companies ·
                  {' '}<span className="font-mono">{totals.classified}</span> classified ·
                  {' '}<span className="font-mono text-amber-600 dark:text-amber-400">{totals.unclassified}</span> unclassified
                  {totals.stale > 0 && <>
                    {' '}·{' '}<span className="font-mono text-amber-600 dark:text-amber-400">{totals.stale}</span> stale (ICP edited)
                  </>}
                </>}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => refreshTargets()} disabled={loadingTargets || running} className="h-7 text-xs">
          <RefreshCw className={cn('h-3 w-3 mr-1', loadingTargets && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Banners */}
      {hasUnsavedChanges && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-semibold text-amber-700 dark:text-amber-300">Unsaved edits</div>
            <div className="text-muted-foreground leading-relaxed">
              Reclassify reads the saved ICP from the database, not the form. Save first so the run uses your latest changes.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onRequestSave} className="h-6 text-[11px]">Save</Button>
        </div>
      )}

      {targetsError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-700 dark:text-red-300">
          Failed to load: {targetsError}
        </div>
      )}
      {runError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-700 dark:text-red-300">
          Run failed: {runError}
        </div>
      )}

      {/* Filter chips - countries then cities. Each chip is a multi-select
          toggle. Chips for countries/cities that are no longer in the ICP's
          saved definition render greyed but stay clickable (so the user can
          still surface those rows for review even if the rows themselves
          are out-of-scope). Hidden entirely when there's only a single
          country AND a single city - no point taking up space then. */}
      {!loadingTargets && targets.length > 0 && (countryChips.length > 1 || cityChips.length > 1) && (
        <div className={cn(GLASS, 'rounded-md p-2 space-y-1.5')}>
          {countryChips.length > 1 && (
            <ChipRow
              label="Country"
              chips={countryChips.map((c) => ({ key: c.country, label: c.country, count: c.count, active: c.active, selected: selectedCountryChips.has(c.country) }))}
              onToggle={(k) => toggleCountryChip(k)}
              disabled={running}
            />
          )}
          {cityChips.length > 1 && (
            <ChipRow
              label="City"
              chips={cityChips.map((c) => ({ key: c.city, label: c.city, count: c.count, active: c.active, selected: selectedCityChips.has(c.city) }))}
              onToggle={(k) => toggleCityChip(k)}
              disabled={running}
            />
          )}
          {(selectedCityChips.size > 0 || selectedCountryChips.size > 0) && (
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-1">
              <span>
                Showing <span className="font-mono">{visibleTargets.length}</span> / {targets.length} after filters
              </span>
              <button type="button" onClick={clearChipFilters} disabled={running} className="text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40">
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      {/* Selection toolbar */}
      {!loadingTargets && targets.length > 0 && (
        <div className={cn(GLASS, 'rounded-md p-2 flex items-center gap-2 flex-wrap')}>
          <span className="text-[11px] text-muted-foreground">
            <span className="font-mono font-semibold">{selectedCount}</span> / {total} selected
          </span>
          <div className="h-3 w-px bg-border" />
          <button type="button" onClick={selectAll} disabled={running} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40">All</button>
          <button type="button" onClick={selectNone} disabled={running} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40">None</button>
          <button type="button" onClick={selectStale} disabled={running} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40" title="Pick everything that needs a fresh classify - stale verdicts + never-classified rows">Stale + new</button>
          <button type="button" onClick={selectUnclassified} disabled={running} className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-40">Only unclassified</button>
          <div className="flex-1" />
          {running && (
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {counters.qualified + counters.rejected + counters.skipped + counters.errored}/{selectedCount}
              {counters.flipped > 0 && <span className="text-amber-600 dark:text-amber-400">· {counters.flipped} flipped</span>}
            </span>
          )}
          {!running && Object.keys(rowState).length > 0 && (
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-2">
              <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-0.5"><Check className="h-3 w-3" /> {counters.qualified}</span>
              <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-0.5"><XIcon className="h-3 w-3" /> {counters.rejected}</span>
              {counters.skipped > 0 && <span><Pause className="h-3 w-3 inline" /> {counters.skipped}</span>}
              {counters.errored > 0 && <span className="text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3 w-3 inline" /> {counters.errored}</span>}
              {counters.flipped > 0 && <span className="text-amber-700 dark:text-amber-400 font-semibold">{counters.flipped} flipped</span>}
            </span>
          )}
          <Button
            size="sm"
            onClick={startRun}
            disabled={running || selectedCount === 0 || hasUnsavedChanges}
            title={hasUnsavedChanges ? 'Save the ICP first' : selectedCount === 0 ? 'Pick at least one company' : `Re-run classifier on ${selectedCount} companies`}
            className="h-7 text-xs"
          >
            {running
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <Play className="h-3 w-3 mr-1" />}
            {running ? 'Running…' : `Start (${selectedCount})`}
          </Button>
          {/* Cancel button - only shows while a job is in flight. Sets
              cancel_requested on the backend; the worker stops on the next
              tick boundary, the poll picks up the 'cancelled' status, and
              the UI flips back to idle. */}
          {activeJobId && (
            <Button
              size="sm"
              variant="outline"
              onClick={cancelActiveJob}
              className="h-7 text-xs"
              title="Stop the in-flight reclassify after the next batch finishes"
            >
              <XIcon className="h-3 w-3 mr-1" /> Cancel
            </Button>
          )}
        </div>
      )}

      {/* Live progress strip - visible while a job is in flight. Mirrors
          the persisted job row so the rep sees authoritative counters
          (not just whatever the Socket.IO stream caught). */}
      {activeJob && (activeJob.status === 'running' || activeJob.status === 'pending') && (
        <div className={cn(GLASS, 'rounded-md p-2.5 text-xs flex items-center justify-between gap-3 border border-sky-500/30 bg-sky-500/5')}>
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500 shrink-0" />
            <span className="font-medium tabular-nums">{activeJob.processed} / {activeJob.total}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-emerald-700 dark:text-emerald-400">{activeJob.qualified} qualified</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-red-700 dark:text-red-400">{activeJob.rejected} rejected</span>
            {activeJob.flipped > 0 && <>
              <span className="text-muted-foreground">·</span>
              <span className="text-amber-700 dark:text-amber-400 font-semibold">{activeJob.flipped} flipped</span>
            </>}
            {activeJob.errors > 0 && <>
              <span className="text-muted-foreground">·</span>
              <span className="text-red-700 dark:text-red-400">{activeJob.errors} errors</span>
            </>}
            {activeJob.current_domain && (
              <span className="text-muted-foreground truncate">
                · current: <span className="font-mono">{activeJob.current_domain}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Recent reclassify jobs strip - persisted history for this ICP.
          Each pill shows status + counters; clicking a non-terminal pill
          re-attaches the polling effect so refreshing the page in the
          middle of a job doesn't lose visibility. */}
      {recentJobs.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Recent reclassify jobs</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {recentJobs.map((j) => {
              const tone =
                j.status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : j.status === 'running' || j.status === 'pending' ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : j.status === 'cancelled' ? 'border-muted-foreground/30 bg-muted/30 text-muted-foreground'
                : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
              const active = activeJobId === j.id
              const inflight = j.status === 'running' || j.status === 'pending'
              return (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => { if (inflight && !active) { setActiveJobId(j.id); setRunning(true) } }}
                  disabled={!inflight || active}
                  title={`${j.status} · ${j.processed}/${j.total} processed${j.last_error ? ` · last error: ${j.last_error}` : ''}`}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] tabular-nums',
                    tone,
                    inflight && !active && 'hover:opacity-80 cursor-pointer',
                    !inflight && 'cursor-default',
                  )}
                >
                  {inflight && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                  <span className="font-semibold">{j.status}</span>
                  <span>{j.processed}/{j.total}</span>
                  {j.flipped > 0 && <span className="text-amber-700 dark:text-amber-400">· {j.flipped} flipped</span>}
                  {j.errors > 0 && <span>· {j.errors} err</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loadingTargets && targets.length === 0 && (
        <div className={cn(GLASS, 'rounded-md p-6 text-center text-muted-foreground text-xs')}>
          No cached companies in <span className="font-semibold">{vertical}</span> yet. Run a sweep from Coverage to populate the cache.
        </div>
      )}

      {/* Target list */}
      {!loadingTargets && targets.length > 0 && (
        <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
          {visibleTargets.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic px-2 py-3 text-center">
              No companies match the current city filter.
            </div>
          )}
          {visibleTargets.map((t) => {
            const isSelected = selected.has(t.domain)
            const rs = rowState[t.domain] || null
            const persisted = t.classification
            const isOpen = expanded.has(t.domain)
            const scrape = scrapeCache[t.domain]
            // Status pill for the current state: either the live run state
            // (rs) or the persisted classification (cold view).
            const live = rs && rs.status !== 'pending'
            const oldVerdict = rs?.oldVerdict || (persisted ? { is_match: persisted.is_match, reason: persisted.reason } : null)
            const newVerdict = rs?.newVerdict || null
            const flipped = rs?.flipped || false
            // Out-of-scope (historical) rows: row's city or resolved country
            // is no longer in the ICP's saved definition. Greyed visually,
            // checkbox disabled, and the toolbar buttons skip them so a
            // bulk "Stale + new" can't sneakily queue them.
            const rowActive = isRowActive(t)
            return (
              <div
                key={t.domain}
                className={cn(
                  GLASS_SUBTLE,
                  'rounded-md p-2 transition-colors',
                  isSelected && 'ring-1 ring-sky-500/40',
                  flipped && 'ring-1 ring-amber-500/60 bg-amber-500/[0.06]',
                  !rowActive && 'opacity-50',
                )}
                title={!rowActive ? 'This company is in a city or country that\'s no longer in the ICP\'s saved definition. Not selectable.' : undefined}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleOne(t.domain)}
                    disabled={running || !rowActive}
                    className="h-3.5 w-3.5 accent-sky-500 shrink-0 disabled:cursor-not-allowed"
                  />
                  <button
                    type="button"
                    onClick={() => toggleExpand(t.domain)}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold truncate">{t.name || t.domain}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate font-mono">{t.domain}</div>
                    {/* Glanceable strip - city · phone · rating · reviews.
                        Every part conditionally rendered; if the row carries
                        none of them (e.g. legacy classification with no Maps
                        metadata) we just don't render the strip. */}
                    {(t.city || t.classification?.phone || typeof t.classification?.rating === 'number') && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground flex-wrap">
                        {t.city && (
                          <span className="inline-flex items-center gap-0.5">
                            <MapPin className="h-2.5 w-2.5" /> {t.city}
                          </span>
                        )}
                        {t.classification?.phone && (
                          <span className="inline-flex items-center gap-0.5">
                            <Phone className="h-2.5 w-2.5" />
                            <a href={`tel:${t.classification.phone}`} className="hover:underline">{t.classification.phone}</a>
                          </span>
                        )}
                        {typeof t.classification?.rating === 'number' && (
                          <span className="inline-flex items-center gap-0.5" title={`Google Maps rating: ${t.classification.rating}${typeof t.classification.reviews === 'number' ? ` from ${t.classification.reviews} reviews` : ''}`}>
                            <Star className="h-2.5 w-2.5 fill-amber-500 text-amber-500" />
                            {t.classification.rating.toFixed(1)}
                            {typeof t.classification.reviews === 'number' && (
                              <span className="text-muted-foreground">({t.classification.reviews})</span>
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Status pills */}
                  <div className="flex items-center gap-1 shrink-0">
                    {live ? (
                      <LiveStatusPill state={rs!} />
                    ) : (
                      <PersistedStatusPill cls={persisted} stale={t.definitionStale} />
                    )}
                  </div>
                </div>

                {/* Diff line - only after a run / when row is live */}
                {live && oldVerdict && newVerdict && flipped && (
                  <div className="mt-1.5 ml-7 flex items-center gap-1.5 text-[10px]">
                    <span className="text-muted-foreground">Verdict flipped:</span>
                    <VerdictBadge verdict={oldVerdict} dim />
                    <span className="text-muted-foreground">→</span>
                    <VerdictBadge verdict={newVerdict} />
                  </div>
                )}
                {live && newVerdict && (
                  <div className="mt-1 ml-7 text-[11px] text-muted-foreground italic leading-snug">
                    "{newVerdict.reason}"
                  </div>
                )}

                {/* Expanded panel - Maps facts on top, scrape preview below.
                    The Maps section is always rendered when there's anything
                    to show (full address, website link, place title) since
                    that data lives on the classification row and doesn't
                    depend on the scrape-preview fetch. Scrape preview below
                    is the bigger optional pull. */}
                {isOpen && (
                  <div className="mt-2 ml-7 space-y-2">
                    {/* Maps / classification facts - independent of scrape fetch. */}
                    {(t.url || t.classification?.address || t.classification?.title) && (
                      <div className="rounded border border-border bg-background/50 p-2 text-[11px] space-y-1">
                        {t.classification?.title && t.classification.title !== t.name && (
                          <div className="text-foreground font-medium">{t.classification.title}</div>
                        )}
                        {t.url && (
                          <div className="flex items-center gap-1 text-sky-600 dark:text-sky-400">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline truncate">
                              {t.url}
                            </a>
                          </div>
                        )}
                        {t.classification?.address && (
                          <div className="flex items-start gap-1 text-muted-foreground">
                            <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                            <span className="break-words">{t.classification.address}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Scrape preview - lazy fetched when row is expanded. */}
                    <div className="rounded border border-border bg-background/50 p-2 text-[10px]">
                      {scrape === undefined || scrape === 'loading' ? (
                        <div className="text-muted-foreground inline-flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" /> Loading scrape…
                        </div>
                      ) : scrape === 'error' ? (
                        <div className="text-red-600 dark:text-red-400">Failed to load scrape preview.</div>
                      ) : !scrape.hasScrape ? (
                        <div className="text-amber-600 dark:text-amber-400">
                          No cached scrape - this company can't be reclassified without a sweep run first.
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {scrape.pageTitle && (
                            <div className="font-semibold text-foreground truncate">{scrape.pageTitle}</div>
                          )}
                          <pre className="whitespace-pre-wrap font-sans text-[10px] leading-relaxed text-muted-foreground max-h-48 overflow-y-auto">
                            {scrape.snippet}
                          </pre>
                          {scrape.truncated && (
                            <div className="text-[9px] text-muted-foreground italic">Truncated - {scrape.totalChars} chars total</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Small pills - extracted for clarity. These are entirely presentational.
function VerdictBadge({ verdict, dim }: { verdict: { is_match: boolean }, dim?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded',
        verdict.is_match
          ? (dim ? 'bg-emerald-500/10 text-emerald-700/70 dark:text-emerald-400/70' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300')
          : (dim ? 'bg-red-500/10 text-red-700/70 dark:text-red-400/70' : 'bg-red-500/15 text-red-700 dark:text-red-300'),
      )}
    >
      {verdict.is_match ? <><Check className="h-2.5 w-2.5" />qualified</> : <><XIcon className="h-2.5 w-2.5" />rejected</>}
    </span>
  )
}

function LiveStatusPill({ state }: { state: RowState }) {
  switch (state.status) {
    case 'pending':
      return <span className="text-[10px] text-muted-foreground">pending</span>
    case 'scanning':
      return <span className="text-[10px] text-sky-600 dark:text-sky-400 inline-flex items-center gap-1">
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> scanning…
      </span>
    case 'qualified':
      return <VerdictBadge verdict={{ is_match: true }} />
    case 'rejected':
      return <VerdictBadge verdict={{ is_match: false }} />
    case 'skipped':
      return <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5" title={state.skipReason || 'skipped'}>
        <Pause className="h-2.5 w-2.5" /> skipped
      </span>
    case 'error':
      return <span className="text-[10px] text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5" title={state.skipReason}>
        <AlertTriangle className="h-2.5 w-2.5" /> error
      </span>
  }
}

// Multi-select toggle chips for the country/city filter. Chips for items
// that exist in the data but aren't in the ICP's current saved definition
// ("historical") render greyed-but-clickable so the user can still surface
// those rows for review. Each chip shows label + count, and gets a subtle
// "·legacy" suffix when historical.
interface ChipSpec {
  key: string
  label: string
  count: number
  active: boolean       // in the ICP's current definition
  selected: boolean     // currently in the filter selection
}
function ChipRow({ label, chips, onToggle, disabled }: {
  label: string
  chips: ChipSpec[]
  onToggle: (key: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold pt-0.5 w-14 shrink-0">{label}</span>
      <div className="flex items-center gap-1 flex-wrap">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onToggle(c.key)}
            disabled={disabled}
            title={c.active
              ? (c.selected ? 'Click to deselect' : 'Click to filter to this')
              : 'This is in your data but not in the ICP\'s current definition - its rows are out of scope'}
            className={cn(
              'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors disabled:cursor-not-allowed',
              c.selected
                ? 'bg-sky-500/20 border-sky-500/60 text-sky-700 dark:text-sky-300 font-semibold'
                : 'border-border hover:bg-muted/40',
              !c.active && 'opacity-50 italic',
            )}
          >
            {c.label}
            <span className="text-muted-foreground font-mono">({c.count})</span>
            {!c.active && <span className="text-muted-foreground">· legacy</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function PersistedStatusPill({ cls, stale }: { cls: Classification | null, stale?: boolean }) {
  if (!cls) {
    return <span className="text-[10px] text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5">
      <Sparkles className="h-2.5 w-2.5" /> unclassified
    </span>
  }
  return (
    <span className="inline-flex items-center gap-1">
      <VerdictBadge verdict={cls} />
      {stale && (
        <span
          className="text-[10px] text-amber-600 dark:text-amber-400 inline-flex items-center gap-0.5"
          title="This verdict was made under an older ICP definition. Reclassify to refresh."
        >
          <AlertTriangle className="h-2.5 w-2.5" /> stale
        </span>
      )}
    </span>
  )
}