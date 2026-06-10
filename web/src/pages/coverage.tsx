// /coverage - ICP-driven region mapping dashboard.
// Backed by /api/grid/* endpoints (Phase 1). Globe shows per-cell sweep
// state for the active ICP; user can pick which ICP, seed cells, force
// a sweep, and inspect results in a side drawer.
//
// Data flow:
//   - Mount: fetch ICP list → set active ICP (default first)
//   - On ICP change: fetch cells + coverage
//   - Auto-poll cells every 12s while at least one is `scanning` so the
//     globe updates in real time during a sweep run
//   - User actions (Seed / Force Sweep / Reset Budget) hit POST endpoints
//     and refetch on success

import { useEffect, useMemo, useState, lazy, Suspense, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePoll } from '@/hooks/use-poll'
import { safeFetchJson } from '@/lib/safe-fetch'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw, MapPinned, Play, Inbox, Globe2, MoreHorizontal, CheckCircle2, Sparkles, AlertCircle, Pause } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'

const CoverageGlobe = lazy(() => import('@/components/coverage/coverage-globe'))
const CoverageMap = lazy(() => import('@/components/coverage/coverage-map'))
import NowSweepingPanel from '@/components/coverage/now-sweeping-panel'
import RecentSessionsPanel from '@/components/coverage/recent-sessions'
import NowScrapingTrace from '@/components/coverage/now-scraping-trace'
import GlobePlaceholder from '@/components/coverage/globe-placeholder'
import { useSweepEvents } from '@/hooks/use-sweep-events'
import { useWorkspace } from '@/context/workspace-context'
import { API_BASE } from '@/lib/api-base'

// API_BASE is empty in dev (Vite proxies /api → localhost:3001, see
// vite.config.ts) and the backend's public URL (VITE_API_URL) in a
// deployed frontend. Same pattern used by lib/api.ts.
const API = API_BASE

interface Icp {
  id: string
  name: string
  vertical: string
  // Optional portfolio company tag - lets us group ICPs that feed the
  // same Valsoft portfolio company (e.g. NedFox's Garden + Thrift +
  // Camping sub-ICPs all set portfolioCompany='NedFox').
  portfolioCompany?: string
  cities: string[]
  // Internal country codes (UK / NL / IE / BE / etc.) this ICP targets.
  // Drives the country dropdown filter on Coverage so the operator can
  // only pick countries the ICP actually covers.
  countries?: string[]
  // Cells in `state='pending'` for this ICP, attached server-side at list
  // time. Lets the dropdown render "NedFox - Garden Centres · 23 pending"
  // so the operator sees outstanding work without picking the ICP first.
  pendingCells?: number
}

interface Cell {
  id: string
  icpId: string
  tier: number
  lat: number
  lng: number
  state: 'pending' | 'scanning' | 'complete' | 'no_new' | 'empty'
  parentCity?: string
  country?: string
  placesFound?: number
  leadsQualified?: number
  chainsFiltered?: number
  nonTargetFiltered?: number
  alreadyKnown?: number
  lastScannedAt?: number | null
  // Mid-sweep pause checkpoint (migration 0007). When non-null AND state
  // is 'pending', sweepCell resumes from the saved company index instead
  // of re-running Scrapingdog. CellDrawer surfaces a "Paused at company
  // N/M" chip so the operator sees exactly where the sweep stopped.
  pauseCheckpoint?: {
    stage: string
    nextIdx: number
    survivors?: Array<unknown>
    cumulative?: {
      placesFound?: number
      leadsQualified?: number
    }
    pausedAt?: number
  } | null
}

interface Coverage {
  pending: number
  scanning: number
  complete: number
  no_new: number
  empty: number
  total: number
  donePct: number
  placesFound: number
  leadsQualified: number
}

interface Country {
  code: string
  name: string
  bbox?: {
    minLat: number
    maxLat: number
    minLng: number
    maxLng: number
  }
}

// Cities catalog mirror for pre-zoom - small subset, enough for the
// cities we actually have in the backend's utils/cities.js.
// First-name match against `cell.parentCity`.
interface ActivityEvent {
  id: number
  ts: number
  // Includes the granular per-company progress events that flow through
  // the Socket.IO channel as well as the summary types (cell_start,
  // cell_complete, company_qualified, company_rejected). The activity log
  // filters which types it actually renders - see ActivityRow for the
  // visible subset. Kept as a wide union here so socket events can be
  // merged into the same state without type-narrowing every push.
  type:
    | 'cell_start'
    | 'places_fetching'
    | 'places_fetched'
    | 'company_scrape_start'
    | 'company_classify_start'
    | 'company_qualified'
    | 'company_rejected'
    | 'cell_complete'
    | 'session_summary'
    // Reclassify-only event types - kept in this union so socket events
    // from a reclassify run (cellId='reclassify') flow into the activity
    // state without a type-narrowing detour. ActivityRow's renderer
    // ignores them, so they're functionally invisible in this view.
    | 'company_scanning'
    | 'company_skipped'
    | 'company_error'
  icpId: string
  cellId?: string
  parentCity?: string | null
  domain?: string
  title?: string
  reason?: string
  state?: string
  companyIdx?: number
  totalCompanies?: number
  totalSurvivors?: number
  placesFound?: number
  qualifiedCount?: number
  // session_summary payload - accumulated across the cells in the just-
  // exhausted budget window. Lets the row render the totals inline.
  cellsSwept?: number
  leadsQualified?: number
  alreadyKnown?: number
  chainsFiltered?: number
  elapsedMs?: number
  message: string
}

const CITY_CENTERS: Record<string, { lat: number; lng: number }> = {
  London:     { lat: 51.5074, lng: -0.1278 },
  Manchester: { lat: 53.4808, lng: -2.2426 },
  Edinburgh:  { lat: 55.9533, lng: -3.1883 },
  Birmingham: { lat: 52.4862, lng: -1.8904 },
  Glasgow:    { lat: 55.8642, lng: -4.2518 },
  'New York': { lat: 40.7128, lng: -74.0060 },
  Toronto:    { lat: 43.6532, lng: -79.3832 },
}

export default function CoveragePage() {
  // Workspace is the page-wide default for portfolio filter. Picking a
  // workspace from the sidebar narrows the ICP picker (and the per-city
  // coverage map) to only that company's ICPs by default. The user can
  // still override the portfolio filter on the page itself (e.g. set it
  // to "All companies" while the workspace is NedFox) - handy when M&A
  // wants a cross-portfolio view without leaving the workspace.
  const { workspace } = useWorkspace()
  const [icps, setIcps] = useState<Icp[]>([])
  const [activeIcp, setActiveIcp] = useState<string>('')
  const [cells, setCells] = useState<Cell[]>([])
  const [coverage, setCoverage] = useState<Coverage | null>(null)
  const [loadingCells, setLoadingCells] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [sweeping, setSweeping] = useState<string | null>(null) // cellId being force-swept
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [countries, setCountries] = useState<Country[]>([])
  // Default to UK so the country-scope dropdown is pre-populated on first
  // load. See note on `scope` above - keep the two defaults in sync.
  const [activeCountry, setActiveCountry] = useState<string>('UK')
  // Preview state - populated by /api/grid/preview, cleared on Confirm
  // or Cancel. While non-null the Coverage page shows a banner above the
  // map with the cell breakdown + Confirm/Cancel buttons, and dashed
  // marker outlines on the map for each candidate cell.
  interface PreviewState {
    scope: 'city' | 'country'
    cells: Array<{
      lat: number
      lng: number
      tier?: number
      parentCity?: string | null
      placeSource?: string
      placeTier?: string
      radiusKm?: number
    }>
    stats?: Record<string, number>
    coverage?: { urban: boolean; suburban: boolean; rural: boolean; airports: boolean }
    skippedOcean?: number
    placesSubgridded?: number
    perCity?: Array<{ city: string; count: number; geocoded?: boolean; radiusKm?: number; skipped?: boolean }>
    geocodedCount?: number
  }
  const [preview, setPreview] = useState<PreviewState | null>(null)
  // Scope chooser. 'city' seeds Tier-1 metros (one city or all cities in the
  // ICP); 'country' seeds the Tier-2 country-fill grid. Single "Seed" button
  // routes to the right endpoint based on this.
  // Default to country/UK - gives the page a predictable opening view
  // (whole UK at country zoom) rather than the previous "city scope, all
  // cities" default which depended on cells being loaded to compute a
  // sensible center. Country/UK is the right starting point for every
  // current ICP since they're all UK-anchored; when a non-UK ICP gets
  // added we'd derive this from the ICP itself.
  const [scope, setScope] = useState<'city' | 'country'>('country')
  // Optional vertical filter - '' means "all verticals". Narrows the ICP
  // dropdown to ICPs that share the picked vertical so the user can hop
  // between same-vertical ICPs without scrolling through everything.
  const [verticalFilter, setVerticalFilter] = useState<string>('')
  // Same idea but for portfolio company. Multiple ICPs can share a portfolio
  // company across different verticals (NedFox → Garden Centre + Thrift +
  // Camping). Picking a portfolio company narrows the ICP dropdown to that
  // company's ICPs only. Vertical + portfolio company combine - narrowing
  // by both gives you the unique sub-ICP at their intersection.
  //
  // Initial value comes from the workspace pick - see the effect below
  // that mirrors workspace changes into this filter so the page reacts
  // immediately when the user switches workspace from the sidebar.
  const [portfolioFilter, setPortfolioFilter] = useState<string>(workspace)
  // Per-city coverage status for the active ICP - populated by the
  // /api/icps/:id/coverage endpoint. Drives the "X cached, Y new" badges
  // next to each city option in the seed dropdown so the user can see at
  // a glance which cities will reuse cached data vs which need a real
  // sweep. Refetched on ICP change.
  const [coverageStatus, setCoverageStatus] = useState<{
    summary: import('@/lib/api').IcpCoverageSummary
    breakdown: import('@/lib/api').IcpCoverageRow[]
    staleSweep?: import('@/lib/api').IcpStaleSweep
  } | null>(null)
  // True while POST /rescan-stale-terms is in flight. The banner button
  // gates on this so a double-click can't queue two resets.
  const [rescanRunning, setRescanRunning] = useState(false)
  const [rescanError, setRescanError] = useState<string | null>(null)
  // 'all' = every city in the ICP; otherwise the city label being targeted.
  const [activeCity, setActiveCity] = useState<string>('all')
  // Auto-cancel a stale preview whenever the user changes the ICP, scope
  // (city/country toggle), picked city, or picked country. Otherwise the
  // preview shows cells for the OLD selection while the controls reflect
  // the NEW one - confusing UX that required the rep to manually click
  // "Cancel preview" first. Idempotent: setting null when it's already
  // null is harmless, so we don't bother guarding the no-op case.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only the four pickers
  useEffect(() => {
    setPreview(null)
  }, [activeIcp, scope, activeCity, activeCountry])
  // View mode swaps based on zoom: 'globe' for big-picture / pre-seed,
  // 'map' for street-level cell inspection. Pre-seed (no cells) we force
  // 'globe' UNLESS a preview is active - the user just clicked Preview
  // and needs to see the proposed cells on the map regardless of whether
  // any are already seeded.
  const [viewMode, setViewMode] = useState<'globe' | 'map'>('globe')
  // Cached city-info lookups so the camera can fly to any city the user
  // picks from the dropdown - even ones not in the hardcoded CITY_CENTERS
  // mirror and not yet seeded. Keyed by lowercased trimmed city name.
  const [cityInfoCache, setCityInfoCache] = useState<Record<string, { lat: number; lng: number; metro_radius_km: number } | 'pending'>>({})
  // Pre-seed (no real cells) we'd normally lock to globe - but if the
  // user just clicked Preview, the candidate cells live only in `preview`
  // and need a map to land on. Honoring `preview != null` here lets the
  // map view kick in on Preview even before the first real seed.
  const effectiveMode: 'globe' | 'map' = (cells.length === 0 && !preview) ? 'globe' : viewMode
  // Track whether the cron has work to do - drives the auto-refresh interval.
  // We poll while ANY cell is pending OR scanning, not just scanning, because
  // the cron can sweep a pending cell and finish before the UI ever sees the
  // `scanning` state - without the pending check the page would freeze at the
  // post-seed snapshot until the user manually refreshes.
  const isAnyActive = cells.some((c) => c.state === 'pending' || c.state === 'scanning')

  // Fetch ICPs + countries once. Countries feed the Tier-2 country-fill
  // dropdown; ICPs feed the primary picker.
  useEffect(() => {
    fetch(`${API}/api/grid/icps`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.error || 'failed to load ICPs')
        setIcps(d.icps)
        if (d.icps[0]) setActiveIcp(d.icps[0].id)
      })
      .catch((e) => setError(e.message))

    fetch(`${API}/api/grid/countries`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return
        setCountries(d.countries)
        if (d.countries[0]) setActiveCountry(d.countries[0].code)
      })
      .catch(() => {})
  }, [])

  // Fetch cells + coverage whenever ICP changes.
  const fetchAll = async (icpId: string) => {
    if (!icpId) return
    setLoadingCells(true)
    setError(null)
    try {
      const [cellsRes, covRes] = await Promise.all([
        fetch(`${API}/api/grid?icp=${icpId}`).then((r) => r.json()),
        fetch(`${API}/api/grid/coverage?icp=${icpId}`).then((r) => r.json()),
      ])
      if (!cellsRes.success) throw new Error(cellsRes.error || 'failed')
      if (!covRes.success) throw new Error(covRes.error || 'failed')
      setCells(cellsRes.cells || [])
      setCoverage(covRes.coverage)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingCells(false)
    }
  }

  useEffect(() => {
    fetchAll(activeIcp)
    // Default to the FIRST city in the ICP, not "All cities" - having
    // "All cities" as the default made it too easy to misclick into a wide
    // multi-city seed by accident. "All cities" is still in the dropdown
    // as a deliberate choice. Falls back to "all" only if the ICP has no
    // cities listed (edge case for newly-created ICPs).
    //
    // RACE-CONDITION GUARD: the "← Last paused" chip's click handler
    // batches setActiveIcp + setActiveCity. After React renders the new
    // state, THIS effect fires (activeIcp changed). Before the guard, it
    // would unconditionally re-write activeCity back to icp.cities[0],
    // landing the user on London when they meant Manchester. Now we only
    // override if the current value isn't a valid choice for the new ICP -
    // explicit clicks (chip, programmatic) are preserved; switches from
    // the picker still get the "first city" default because the prior
    // ICP's city is almost always invalid in the new ICP.
    const nextIcp = icps.find((i) => i.id === activeIcp)
    const cities = (nextIcp?.cities || []).map((c) => String(c).toLowerCase())
    const currentCityValid = activeCity === 'all' || cities.includes(String(activeCity || '').toLowerCase())
    if (!currentCityValid) {
      const firstCity = nextIcp?.cities?.[0]
      setActiveCity(firstCity || 'all')
    }
    // Same idea for country, same guard: only snap to the first country
    // when the current value isn't allowed for this ICP. A chip click that
    // set activeCountry='NL' would have been clobbered by the old
    // unconditional setActiveCountry(firstCountry) on the next render.
    const countries = (nextIcp?.countries || []).map((c) => String(c).toUpperCase())
    const currentCountryValid = countries.includes(String(activeCountry || '').toUpperCase())
    if (!currentCountryValid) {
      const firstCountry = nextIcp?.countries?.[0]
      if (firstCountry) setActiveCountry(firstCountry)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIcp, icps])

  // Defensive country re-snap. Belt-and-suspenders alongside the snap above:
  // the <select value={activeCountry}> may end up with a `value` that isn't
  // in its <option> list (e.g. activeCountry='UK' lingering after switching
  // to an NL-only ICP, before the snap-effect committed; or a workspace
  // change that filters the ICP list mid-flight). In that case the browser
  // visually defaults to the first option but state stays stale - so the
  // user sees "Netherlands" in the dropdown but Preview still sends "UK".
  // This effect catches that and snaps to the first allowed country.
  useEffect(() => {
    const icp = icps.find((i) => i.id === activeIcp)
    if (!icp || !icp.countries || icp.countries.length === 0) return
    const allowed = new Set(icp.countries.map((c) => String(c).toUpperCase()))
    if (!allowed.has(String(activeCountry).toUpperCase())) {
      setActiveCountry(icp.countries[0])
    }
  }, [icps, activeIcp, activeCountry])

  // ── Per-city country resolution (for the cities dropdown's outlier gating) ──
  // The ICP carries cities as plain strings, but outlier status is a function
  // of (city's resolved country) vs (icp.countries). We hit the same
  // /api/grid/cities-info batch endpoint the ICP editor uses, so a city that
  // sits in an unticked country shows as disabled in the dropdown - and
  // activeCity gets snapped off it if it lands there. Cache survives ICP
  // edits (key is city name) so re-opening an ICP doesn't re-fetch.
  const [cityCountries, setCityCountries] = useState<Record<string, string | null>>({})
  useEffect(() => {
    const icp = icps.find((i) => i.id === activeIcp)
    if (!icp || !icp.cities || icp.cities.length === 0) return
    const wanted = icp.cities.map((c) => c.trim()).filter((c) => c && !(c in cityCountries))
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
      .catch(() => { /* leave undefined, retry on next ICP change */ })
    return () => { cancelled = true }
  }, [activeIcp, icps, cityCountries])

  // Helper: is this city an "outlier" on the active ICP? (Resolved to a
  // country that isn't ticked.) `null` means we know it's resolved but the
  // country isn't in the ticked set; `undefined` means we haven't resolved
  // yet (treat as not-outlier so the row isn't disabled while loading).
  const isOutlierCity = (cityName: string): boolean => {
    const icp = icps.find((i) => i.id === activeIcp)
    if (!icp || !icp.countries || icp.countries.length === 0) return false
    const cc = cityCountries[cityName.trim()]
    if (!cc) return false   // unresolved or no country resolved - don't block
    const allowed = new Set(icp.countries.map((c) => c.toUpperCase()))
    return !allowed.has(cc)
  }

  // Defensive city re-snap. Same shape as the country one: if activeCity is
  // an outlier (or 'all' on an ICP whose only listed cities are all outliers,
  // which we treat as fine since the backend will filter at preview time),
  // snap to the first active city instead. Stops the user from previewing a
  // grayed city and getting weird results.
  useEffect(() => {
    if (!activeCity || activeCity === 'all') return
    if (!isOutlierCity(activeCity)) return
    const icp = icps.find((i) => i.id === activeIcp)
    const firstActive = (icp?.cities || []).find((c) => !isOutlierCity(c))
    if (firstActive) setActiveCity(firstActive)
    else setActiveCity('all')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCity, activeIcp, cityCountries])

  // Fetch coverage status whenever ICP changes - drives the per-city
  // "covered" / "new" badges in the city dropdown. Soft-fails (sets null)
  // if the endpoint errors, so the rest of the page still works.
  useEffect(() => {
    if (!activeIcp) { setCoverageStatus(null); return }
    let cancelled = false
    fetch(`${API}/api/icps/${encodeURIComponent(activeIcp)}/coverage`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d?.success) setCoverageStatus({ summary: d.summary, breakdown: d.breakdown, staleSweep: d.staleSweep })
        else setCoverageStatus(null)
      })
      .catch(() => { if (!cancelled) setCoverageStatus(null) })
    return () => { cancelled = true }
  }, [activeIcp])

  // Mirror the global workspace pick into this page's portfolio filter.
  // Switching workspace from the sidebar updates the filter automatically;
  // per-page override sticks until the next workspace change.
  useEffect(() => {
    setPortfolioFilter(workspace)
  }, [workspace])

  // Verticals available given the current workspace + portfolio scope.
  // When workspace=NedFox, the list narrows to NedFox's verticals (Garden
  // Centre, Thrift Store, Camping & Outdoor, Personal Care Retail,
  // Bathroom Retail) - Bluebird's "Car Rental" is hidden because it's
  // not relevant to the active workspace. The portfolio filter (which
  // mirrors workspace by default) drives this so per-page overrides also
  // narrow the verticals correctly.
  const availableVerticals = useMemo(() => {
    const set = new Set<string>()
    const pool = portfolioFilter
      ? icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === portfolioFilter.toLowerCase())
      : icps
    for (const i of pool) if (i.vertical) set.add(i.vertical)
    return Array.from(set).sort()
  }, [icps, portfolioFilter])

  // If the user's vertical filter no longer matches the visible verticals
  // (e.g. workspace switched from "All" → "NedFox" while "Car Rental"
  // was selected), clear it so the dropdown reflects a valid state.
  useEffect(() => {
    if (!verticalFilter) return
    if (availableVerticals.length === 0) return
    if (!availableVerticals.includes(verticalFilter)) {
      setVerticalFilter('')
    }
  }, [availableVerticals, verticalFilter])

  // Portfolio companies present in the loaded ICPs.
  const availablePortfolioCompanies = useMemo(() => {
    const set = new Set<string>()
    for (const i of icps) if (i.portfolioCompany) set.add(i.portfolioCompany)
    return Array.from(set).sort()
  }, [icps])

  // ICPs visible after the vertical + portfolio-company filters. AND-combined
  // - picking both narrows to the intersection. Either alone is fine.
  const filteredIcps = useMemo(() => {
    let out = icps
    if (verticalFilter) {
      const v = verticalFilter.toLowerCase()
      out = out.filter((i) => (i.vertical || '').toLowerCase() === v)
    }
    if (portfolioFilter) {
      const p = portfolioFilter.toLowerCase()
      out = out.filter((i) => (i.portfolioCompany || '').toLowerCase() === p)
    }
    return out
  }, [icps, verticalFilter, portfolioFilter])

  // If the user's active ICP gets filtered out by a vertical change, jump
  // to the first ICP that's still in scope so the page doesn't go blank.
  useEffect(() => {
    if (!activeIcp) return
    if (!filteredIcps.length) return
    if (!filteredIcps.some((i) => i.id === activeIcp)) {
      setActiveIcp(filteredIcps[0].id)
    }
  }, [filteredIcps, activeIcp])

  // Quick-lookup map: city (lowercase) → its coverage row. Used by the
  // city dropdown options so they can render "✓ N cached" / "○ new" inline.
  const coverageByCity = useMemo(() => {
    const map = new Map<string, import('@/lib/api').IcpCoverageRow>()
    if (coverageStatus) {
      for (const row of coverageStatus.breakdown) {
        map.set(row.city.toLowerCase(), row)
      }
    }
    return map
  }, [coverageStatus])

  // Resolve activeCity → lat/lng so the camera can fly there even when
  // the city isn't in the hardcoded CITY_CENTERS mirror and hasn't been
  // seeded yet. Hits /api/grid/city-info which goes through findCityAsync
  // (static catalog → geocode cache → live Photon). Cached client-side
  // so re-selecting the same city doesn't refetch.
  useEffect(() => {
    if (!activeCity || activeCity === 'all') return
    const key = activeCity.toLowerCase().trim()
    if (CITY_CENTERS[activeCity]) return                  // already known
    if (cityInfoCache[key]) return                        // cached or pending
    setCityInfoCache((prev) => ({ ...prev, [key]: 'pending' }))
    fetch(`${API}/api/grid/city-info?name=${encodeURIComponent(activeCity)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success || !d.city) return
        const c = d.city
        setCityInfoCache((prev) => ({
          ...prev,
          [key]: { lat: c.lat, lng: c.lng, metro_radius_km: c.metro_radius_km || 15 },
        }))
      })
      .catch(() => {})
  }, [activeCity, cityInfoCache])

  // Cooldown ref - blocks mode-flip events for ~2s after every switch so
  // the new view's flyTo animation finishes before its zoom callbacks
  // re-fire and bounce us back. Without this the modes oscillate every
  // time the threshold is crossed.
  const lastSwitchAtRef = useRef(0)
  const COOLDOWN_MS = 2000
  // Sweep activity feed (rolling buffer of company hits + cell events).
  // Two channels feed it:
  //   1. /api/grid/activity REST poll - seeds the log on mount and acts as
  //      a resilience fallback if the socket drops.
  //   2. Socket.IO `sweep_event` push - primary realtime channel. Events
  //      land sub-second so the per-company progress feels live.
  // Both channels emit events from the same `pushEvent` source on the
  // backend, so each event has a stable `id` we can dedupe against.
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const lastEventIdRef = useRef<number>(0)
  // Tracks where the user is currently looking - updated on every globe
  // zoom and every map move/zoom. Used as the swap-target center so
  // zooming into Tokyo on the globe opens the map at Tokyo (not London).
  // Plain ref to avoid re-render storms; we read it lazily when a swap fires.
  const lastFocusRef = useRef<{ lat: number; lng: number } | null>(null)
  // When a swap fires, capture the lastFocus into state so the next view
  // mounts centered on it. Cleared when the user changes the dropdown so
  // the dropdown selection takes precedence.
  const [swapCenter, setSwapCenter] = useState<{ lat: number; lng: number } | null>(null)

  // When cells appear (post-seed), default to map view so the user sees
  // the city detail view. When they're cleared (Reset all), default back
  // to globe so the empty-state CTA sits over the earth.
  const hadCellsRef = useRef(false)
  useEffect(() => {
    const hasCells = cells.length > 0
    if (hasCells && !hadCellsRef.current) {
      setViewMode('map')
      lastSwitchAtRef.current = Date.now()
    }
    if (!hasCells && hadCellsRef.current) {
      setViewMode('globe')
      lastSwitchAtRef.current = Date.now()
    }
    hadCellsRef.current = hasCells
  }, [cells.length])

  // Zoom thresholds that toggle between globe ↔ map.
  //
  //   Map natural rest:    zoom 11 (city) or ~5 (country fitBounds)
  //   Map → globe trigger: zoom < 4 (must zoom out past country level)
  //
  //   Globe natural rest:  altitude 0.65 (city scope) or 1.0 (country scope)
  //   Globe → map trigger: alt < 0.07 (must scroll right up to the surface
  //                                    so the map only fires on deliberate
  //                                    "I'm aiming at this exact spot" intent)
  //
  // The map trigger is intentionally close to the surface - the user
  // explicitly asked for "have to get very close to actually go to city view".
  const handleMapZoomChange = (zoom: number, center: { lat: number; lng: number }) => {
    lastFocusRef.current = center
    if (Date.now() - lastSwitchAtRef.current < COOLDOWN_MS) return
    if (zoom < 4 && cells.length > 0 && viewMode === 'map') {
      setSwapCenter(center)
      setViewMode('globe')
      lastSwitchAtRef.current = Date.now()
    }
  }
  const handleGlobeZoomChange = (pov: { lat: number; lng: number; altitude: number }) => {
    lastFocusRef.current = { lat: pov.lat, lng: pov.lng }
    if (Date.now() - lastSwitchAtRef.current < COOLDOWN_MS) return
    if (pov.altitude < 0.07 && viewMode === 'globe') {
      // Zooming into ANY part of the globe opens the map there - even
      // if no cells exist at that location, the user can pan around the
      // street view, then scroll back out to return to globe.
      setSwapCenter({ lat: pov.lat, lng: pov.lng })
      setViewMode('map')
      lastSwitchAtRef.current = Date.now()
    }
  }

  // Dropdown changes always win - clear any in-flight swap center so
  // selecting "London" or "United Kingdom" pulls the camera there even
  // if the user had panned elsewhere first.
  useEffect(() => {
    setSwapCenter(null)
  }, [scope, activeCity, activeCountry])

  // Live cell-state polling - every 6s while any cell is pending or scanning.
  // Uses usePoll so it pauses while the tab is hidden (no wasted Render quota
  // when nobody's looking) and fires immediately on tab return so the first
  // glance is up to date. enabled flag stops ticking once everything settles.
  usePoll(
    async () => { if (activeIcp) await fetchAll(activeIcp) },
    { enabled: !!activeIcp && isAnyActive, intervalMs: 6000 },
  )

  // Reset the activity log + cursor on ICP change so we don't show events
  // from a different ICP.
  useEffect(() => {
    setActivity([])
    lastEventIdRef.current = 0
  }, [activeIcp])

  // Activity feed fallback poll. The Socket.IO channel is the primary path -
  // this just catches anything missed during a reconnect or the initial
  // page-load gap before the socket connects. Visibility-aware via usePoll.
  usePoll(
    async (signal) => {
      if (!activeIcp) return
      try {
        const url = `${API}/api/grid/activity?icp=${encodeURIComponent(activeIcp)}&since=${lastEventIdRef.current}`
        const res = await fetch(url, { signal }).then((r) => r.json())
        if (!res.success || !Array.isArray(res.events) || res.events.length === 0) return
        // events come newest-first from the backend
        lastEventIdRef.current = Math.max(
          lastEventIdRef.current,
          ...res.events.map((e: ActivityEvent) => e.id),
        )
        setActivity((prev) => {
          const merged = [...res.events, ...prev]
          return merged.slice(0, 200) // cap so memory doesn't grow unbounded
        })
      } catch { /* swallow - next tick will retry */ }
    },
    { enabled: !!activeIcp, intervalMs: isAnyActive ? 12000 : 30000 },
  )

  // Realtime channel - Socket.IO subscription scoped to the active ICP.
  // Surfaces both the in-flight `progress` (consumed by NowSweepingPanel)
  // and the raw `events` stream we merge into the activity feed below.
  const { events: socketEvents, progress: sweepProgress, connected: socketConnected } = useSweepEvents(activeIcp)

  // "Starting…" state for the gap between pressing Resume sweeping and the
  // first live event. The cron only ticks every ~30s, so the first cell can
  // take a while to emit anything - without this the panel sits on the idle
  // "waiting" line and looks stuck. Set true on Resume, cleared as soon as
  // real progress arrives (below) or after a safety timeout.
  const [sweepStarting, setSweepStarting] = useState(false)
  // Real progress arrived → we're no longer just "starting".
  useEffect(() => { if (sweepProgress) setSweepStarting(false) }, [sweepProgress])
  // Safety net: never spin forever (e.g. nothing pending to sweep). Clear a
  // bit past one cron tick.
  useEffect(() => {
    if (!sweepStarting) return
    const t = setTimeout(() => setSweepStarting(false), 45000)
    return () => clearTimeout(t)
  }, [sweepStarting])
  // Switching ICP abandons any in-flight "starting" state for the old one.
  useEffect(() => { setSweepStarting(false) }, [activeIcp])

  // Per-ICP "last active scope" map - drives the chip near the Resume button
  // ("last: Amsterdam · 12/40 cells"). Refreshed on mount, on ICP switch, and
  // after each Resume Sweeping click so the chip always reflects reality.
  // Cell counts come from the existing `cells` state (no extra fetch).
  type LastScope = { type: string; value: string | null; updatedAt: number }
  const [lastScopes, setLastScopes] = useState<Record<string, LastScope>>({})
  // The cron's live `paused` flag, returned by /api/grid/sweep-state. Drives
  // the "Paused session · N cells waiting · Resume" banner. Defaults to true
  // until the first fetch resolves so we err on "looks paused" rather than
  // "looks running" if the request is in flight.
  const [cronPaused, setCronPaused] = useState<boolean>(true)
  // True between "operator clicked Pause" and "in-flight cell finished its
  // current company + wrote its checkpoint". Drives the "Pausing… current
  // company will finish first" indicator. Cleared on Resume.
  const [pauseRequested, setPauseRequested] = useState<boolean>(false)
  const [pauseClickBusy, setPauseClickBusy] = useState<boolean>(false)
  // The cron's reason for being paused:
  //   'manual'  - operator clicked Pause (banner shows + Resume CTA)
  //   'budget'  - per-ICP cell cap hit (auto-pause; scope button relabels to "Resume sweeping…", banner hidden)
  //   'no_work' - no pending cells in scope (auto-pause; scope button shows "All swept" if scope is done)
  //   'boot'    - fresh restart, no session to resume (no banner)
  //   null      - cron is running
  const [pauseReason, setPauseReason] = useState<string | null>('boot')
  // The most recent operator-paused session. Drives the "← Last paused:
  // {icp} · {scope} ({time}) - click to switch view" chip near the Resume
  // button. Null when the most recent session ended cleanly / auto-paused /
  // is still running, OR when the current picker selection already matches
  // (no need to nudge the user back to where they already are).
  interface LastPausedSession {
    id: string
    started_at: string
    icp_id: string | null
    scope_type: 'city' | 'country' | 'all' | null
    scope_value: string | null
    cells_succeeded: number
    cells_attempted: number
  }
  const [lastPausedSession, setLastPausedSession] = useState<LastPausedSession | null>(null)
  const refreshLastScopes = async () => {
    try {
      const r = await fetch(`${API}/api/grid/sweep-state`).then((res) => res.json())
      if (r?.success && r.lastScopes) setLastScopes(r.lastScopes)
      if (r?.success && typeof r.paused === 'boolean') setCronPaused(r.paused)
      if (r?.success && typeof r.pauseRequested === 'boolean') setPauseRequested(r.pauseRequested)
      // pauseReason is the new field added 2026-06-08 - tolerate missing
      // (older backend) by leaving the previous value in place. The banner
      // gate below treats null as "not paused" so an older backend just
      // falls back to the previous "banner always shows when paused"
      // behavior - no regression.
      if (r?.success && (typeof r.pauseReason === 'string' || r.pauseReason === null)) {
        setPauseReason(r.pauseReason)
      }
      // Piggyback the "last paused session" fetch on the same poll cadence
      // so the chip refreshes without a second timer. Cheap call - one
      // sweep_sessions LIMIT 5 over an indexed table.
      const lp = await fetch(`${API}/api/grid/last-paused-session`).then((res) => res.json())
      if (lp?.success) setLastPausedSession(lp.session || null)
    } catch { /* non-fatal - chip just stays stale */ }
  }
  useEffect(() => { void refreshLastScopes() }, [])
  useEffect(() => { void refreshLastScopes() }, [activeIcp])
  // Re-poll sweep-state every ~10s so the banner clears once the session
  // gets going (the cron flips paused=false on first tick). Cheap endpoint,
  // small payload.
  useEffect(() => {
    const id = window.setInterval(() => { void refreshLastScopes() }, 10000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Merge socket events into the activity log. Dedupe by id so an event
  // can't appear twice if the REST poll and the socket race each other.
  // Updates whenever the socket receives a new event.
  useEffect(() => {
    if (socketEvents.length === 0) return
    setActivity((prev) => {
      const seen = new Set(prev.map((e) => e.id))
      const fresh = socketEvents.filter((e) => !seen.has(e.id))
      if (fresh.length === 0) return prev
      // Advance the REST cursor too so the next poll doesn't redundantly
      // refetch what the socket already delivered.
      lastEventIdRef.current = Math.max(
        lastEventIdRef.current,
        ...fresh.map((e) => e.id),
      )
      return [...fresh, ...prev].slice(0, 200)
    })
  }, [socketEvents])

  // Where the camera/map should focus right now. Driven by:
  //   1. Country scope: country bbox → globe altitude / map fitBounds
  //   2. City scope w/ a specific city picked: that city's center
  //   3. City scope 'all': first cell's parentCity (or cell-average fallback)
  //   4. Empty: London default
  // Globe consumes (lat, lng, altitude); map consumes (lat, lng, bounds).
  // Globe altitudes are kept comfortably ABOVE the map-trigger threshold
  // so when the user lands in globe view they have headroom to scroll a
  // little without bouncing right back to the map.
  const zoomTarget = useMemo(() => {
    // Country scope - fly to the country's bbox.
    if (scope === 'country' && activeCountry) {
      const country = countries.find((c) => c.code === activeCountry)
      if (country?.bbox) {
        const { minLat, maxLat, minLng, maxLng } = country.bbox
        const centerLat = (minLat + maxLat) / 2
        const centerLng = (minLng + maxLng) / 2
        return {
          lat: centerLat,
          lng: centerLng,
          altitude: 1.0, // country fits in viewport with surrounding context
          bounds: [[minLat, minLng], [maxLat, maxLng]] as [[number, number], [number, number]],
        }
      }
    }

    // City scope with a specific city picked (not 'all').
    if (scope === 'city' && activeCity && activeCity !== 'all') {
      // 1. Hardcoded catalog wins - instant, no need to load cells first.
      if (CITY_CENTERS[activeCity]) {
        return { ...CITY_CENTERS[activeCity], altitude: 0.65, bounds: null }
      }
      // 2. Backend city-info cache - resolves any city the user types
      //    (catalog miss + Photon-geocoded). Populated by the effect
      //    above as soon as activeCity changes.
      const key = activeCity.toLowerCase().trim()
      const cached = cityInfoCache[key]
      if (cached && cached !== 'pending') {
        return { lat: cached.lat, lng: cached.lng, altitude: 0.65, bounds: null }
      }
      // 3. Cells already seeded for this city - average their positions
      //    (works even before the city-info fetch resolves).
      const target = activeCity.toLowerCase()
      const cityCells = cells.filter((c) => (c.parentCity || '').toLowerCase() === target)
      if (cityCells.length > 0) {
        const sumLat = cityCells.reduce((a, c) => a + c.lat, 0)
        const sumLng = cityCells.reduce((a, c) => a + c.lng, 0)
        return {
          lat: sumLat / cityCells.length,
          lng: sumLng / cityCells.length,
          altitude: 0.65,
          bounds: null,
        }
      }
      // 4. No catalog, no cache yet (still fetching), no cells - leave
      //    the camera where it is; the effect's setState will trigger a
      //    re-render with the fetched coords moments later.
    }

    // City scope 'all' - first cell's parent city, falls back to cell average.
    const firstCity = cells.find((c) => c.parentCity)?.parentCity
    if (firstCity && CITY_CENTERS[firstCity]) {
      return { ...CITY_CENTERS[firstCity], altitude: 0.65, bounds: null }
    }
    if (cells.length > 0) {
      const sumLat = cells.reduce((a, c) => a + c.lat, 0)
      const sumLng = cells.reduce((a, c) => a + c.lng, 0)
      return {
        lat: sumLat / cells.length,
        lng: sumLng / cells.length,
        altitude: 0.9,
        bounds: null,
      }
    }
    return { lat: 51.5074, lng: -0.1278, altitude: 1.5, bounds: null }
  }, [cells, scope, activeCity, activeCountry, countries, cityInfoCache])

  // The component-facing center: swap target if a recent free-form swap
  // fired, otherwise the dropdown-driven zoomTarget. Bounds is only used
  // when there's no swap (swap = single-point freeform navigation).
  const effectiveCenterLat = swapCenter ? swapCenter.lat : zoomTarget.lat
  const effectiveCenterLng = swapCenter ? swapCenter.lng : zoomTarget.lng
  const effectiveBounds = swapCenter ? null : zoomTarget.bounds

  // Preview - compute the cells a seed WOULD produce, render them on the
  // map as dashed outlines, surface counts in a banner. User reviews and
  // either confirms (real seed) or cancels (drops the preview state).
  const handlePreview = async () => {
    if (!activeIcp) return
    setPreviewing(true)
    setError(null)
    try {
      const body: any = { icp: activeIcp, scope }
      if (scope === 'country') {
        if (!activeCountry) throw new Error('Pick a country first')
        body.country = activeCountry
      } else {
        if (activeCity !== 'all') body.cities = [activeCity]
      }
      const res = await safeFetchJson(`${API}/api/grid/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.success) throw new Error(res.error || 'preview failed')
      setPreview({
        scope: res.scope,
        cells: res.cells || [],
        stats: res.stats,
        coverage: res.coverage,
        skippedOcean: res.skippedOcean,
        placesSubgridded: res.placesSubgridded,
        perCity: res.perCity,
        geocodedCount: res.geocodedCount,
      })
      // Always switch to map view when a preview fires. The map is the
      // only view that renders the dashed-outline preview cells; staying
      // on globe would leave the user wondering "where did my preview go?"
      setViewMode('map')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  // Confirm the preview → calls the real /seed or /seed-country endpoint
  // (which re-runs the same builder server-side and persists the cells).
  const handleConfirmSeed = async () => {
    if (!activeIcp || !preview) return
    setSeeding(true)
    setError(null)
    try {
      let res
      if (preview.scope === 'country') {
        res = await safeFetchJson(`${API}/api/grid/seed-country`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icp: activeIcp, country: activeCountry }),
        })
      } else {
        const body: { icp: string; cities?: string[] } = { icp: activeIcp }
        if (activeCity !== 'all') body.cities = [activeCity]
        res = await safeFetchJson(`${API}/api/grid/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      if (!res.success) throw new Error(res.error || 'seed failed')
      setPreview(null)
      await fetchAll(activeIcp)
      // Bug fix: "Start sweep" actually starts the sweep. Previously it just
      // seeded cells and left the cron paused, forcing a second click on
      // Resume sweeping that wasn't even adjacent on screen. After seed
      // succeeds, fire the same /reset-budget call the main contextual button
      // would have - cron picks up the next pending cell on its next tick.
      await handleResetBudget()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSeeding(false)
    }
  }

  const handleCancelPreview = () => {
    setPreview(null)
  }

  const handleForceSweep = async (cellId: string) => {
    setSweeping(cellId)
    try {
      await fetch(`${API}/api/grid/sweep`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cellId }),
      })
      await fetchAll(activeIcp)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSweeping(null)
    }
  }

  const handleResetBudget = async () => {
    try {
      // Pass the active ICP + current view scope so the cron sweeps only
      // THIS ICP AND only the cells in this view. The operator can pause
      // a city (e.g. Amsterdam), switch to a country fill, hit Resume, and
      // the cron picks up the new scope's pending cells without Amsterdam's
      // Tier-1 cells stealing the budget. Backend persists the scope per
      // ICP so the last-scope chip shows where each ICP was paused.
      const body: { icp: string | null; scope?: { type: string; value: string | null } } = {
        icp: activeIcp || null,
      }
      if (scope === 'country') {
        body.scope = { type: 'country', value: activeCountry || null }
      } else {
        // scope === 'city'. activeCity === 'all' means "every Tier-1 city
        // seed for this ICP" - the backend interprets value=null/'all' that way.
        body.scope = {
          type: 'city',
          value: activeCity && activeCity !== 'all' ? activeCity : null,
        }
      }
      await safeFetchJson(`${API}/api/grid/reset-budget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      // Show the "starting…" spinner until the first live event lands.
      setSweepStarting(true)
      // Refresh the last-scope chip so it reflects this Resume immediately.
      void refreshLastScopes()
    } catch (e: any) {
      setError(e.message)
    }
  }

  // Reset view - pop back out to the globe overview instead of staying
  // dropped into the last sweep's map. Purely a camera/selection reset:
  // it touches NO data (cells, budget, sweeps all untouched), so from the
  // globe the user can either continue the current ICP (Resume sweeping)
  // or pick another ICP / country / city from the dropdowns. Bumps the
  // swap cooldown so the zoom-watcher doesn't immediately bounce back to
  // the map.
  const handleResetView = () => {
    setViewMode('globe')
    setSelectedCellId(null)
    setPreview(null)
    setSwapCenter(null)
    // Keep activeCity as-is - "reset view" is a camera reset, not a filter
    // reset. Wiping the city filter here led to accidental wide sweeps.
    lastSwitchAtRef.current = Date.now()
  }

  // Cold-start retry for Render's free instance lives in @/lib/safe-fetch
  // now (safeFetchJson) - shared with api.ts's postJson/getJson wrappers so
  // the same resilience applies app-wide, not just here. See the call sites
  // below (handlePreview, handleConfirmSeed, handleResetBudget,
  // handleSeedAndSweepDirect) for usage.

  // ── Main contextual sweep button ─────────────────────────────────────
  // Replaces the old "Resume sweeping" + the preview banner's "Start sweep"
  // with a single button whose label and action reflect the actual state.
  // The state-derivation here is purely client-side from existing data
  // (cells + sweep progress + active scope).
  // (seedConfirmOpen removed - the in-page popover had repeated layout /
  // click-interception bugs. Seed + sweep now goes through a native
  // window.confirm() in the main button's action, which is bulletproof.)
  const [overflowOpen, setOverflowOpen] = useState(false)
  // Position the overflow menu via viewport coordinates instead of inline
  // absolute positioning. The Coverage header card uses GLASS, which has
  // overflow-hidden (for the rounded glassmorphism), and that clips any
  // absolutely-positioned child. Rendering the menu through createPortal
  // into document.body escapes the clip; the rect-based positioning
  // anchors it to the trigger button.
  const overflowRef = useRef<HTMLDivElement | null>(null)
  const overflowBtnRef = useRef<HTMLButtonElement | null>(null)
  const overflowMenuRef = useRef<HTMLDivElement | null>(null)
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null)
  const openOverflow = () => {
    const btn = overflowBtnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setOverflowPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    })
    setOverflowOpen(true)
  }
  // Close the menu on viewport changes - simpler than recomputing the
  // anchor position, and matches what most native dropdowns do.
  useEffect(() => {
    if (!overflowOpen) return
    const close = () => setOverflowOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [overflowOpen])
  // Close the overflow menu on outside click. The menu lives in a portal
  // outside overflowRef's DOM tree, so we need to check the menu ref too -
  // otherwise clicking inside the menu would register as an outside click
  // and slam it shut before the button's onClick can fire.
  useEffect(() => {
    if (!overflowOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      const inTrigger = overflowRef.current?.contains(target)
      const inMenu = overflowMenuRef.current?.contains(target)
      if (!inTrigger && !inMenu) setOverflowOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [overflowOpen])

  // Count cells matching the CURRENT view scope (what the main button +
  // status line need). Mirrors the backend's cellMatchesScope() in
  // grid-store.js so the numbers agree.
  const currentScopeCells = useMemo(() => {
    return cells.filter((c) => {
      if (scope === 'city') {
        if (!activeCity || activeCity === 'all') return c.tier === 1
        return c.parentCity === activeCity
      }
      // country scope
      return c.tier === 2 && c.country === activeCountry
    })
  }, [cells, scope, activeCity, activeCountry])
  const currentScopePending = currentScopeCells.filter((c) => c.state === 'pending').length
  // "Done" in the strict sense - a cell that hit a terminal state.
  const currentScopeDone = currentScopeCells.filter((c) => c.state === 'complete' || c.state === 'no_new' || c.state === 'empty').length
  // "Touched" widens the resume signal beyond terminal states. A cell that
  // got paused mid-sweep stays in `state='pending'` with a `pause_checkpoint`
  // JSONB attached (lead list cached, nextIdx saved); without this check the
  // button would say "Sweep" instead of "Resume sweeping" for a scope where
  // every cell was paused mid-flight (the case that hit Manchester after a
  // manual pause). Also counts cells that just got past the Scrapingdog step
  // (`placesFound > 0`) or have ever been scanned (`lastScannedAt` set) so
  // partial progress shows up as resume-worthy too.
  const currentScopeTouched = currentScopeCells.filter((c) =>
    c.state === 'complete' || c.state === 'no_new' || c.state === 'empty'
    || !!c.pauseCheckpoint
    || (c.placesFound || 0) > 0
    || !!c.lastScannedAt,
  ).length
  const currentScopeLabel = scope === 'country'
    ? (countries.find((c) => c.code === activeCountry)?.name || activeCountry || 'a country')
    : (!activeCity || activeCity === 'all' ? 'all cities' : activeCity)

  // Direct seed+sweep, bypassing the preview banner. Called from the
  // confirm popover when the main button is in "seed needed" state.
  const handleSeedAndSweepDirect = async () => {
    if (!activeIcp) return
    setSeeding(true); setError(null)
    try {
      let res
      if (scope === 'country') {
        if (!activeCountry) throw new Error('Pick a country first')
        res = await safeFetchJson(`${API}/api/grid/seed-country`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icp: activeIcp, country: activeCountry }),
        })
      } else {
        const body: { icp: string; cities?: string[] } = { icp: activeIcp }
        if (activeCity && activeCity !== 'all') body.cities = [activeCity]
        res = await safeFetchJson(`${API}/api/grid/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      if (!res.success) throw new Error(res.error || 'seed failed')
      await fetchAll(activeIcp)
      // Hand off to /reset-budget so the cron fires immediately on the
      // freshly-seeded cells - this is what the misleading "Start sweep"
      // used to skip.
      await handleResetBudget()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSeeding(false)
    }
  }

  // The contextual main button - one button, six possible states, no lies.
  interface MainButtonSpec {
    kind: 'noIcp' | 'noLocation' | 'inProgress' | 'seedNeeded' | 'sweep' | 'allDone'
    label: string
    action: () => void
    disabled: boolean
    variant: 'default' | 'outline' | 'amber'
    pulse?: boolean
  }
  const sweepInProgress = !!sweepProgress || sweepStarting
  const mainButton: MainButtonSpec = (() => {
    if (!activeIcp) {
      return { kind: 'noIcp', label: 'Pick an ICP', action: () => {}, disabled: true, variant: 'outline' }
    }
    if (scope === 'country' && !activeCountry) {
      return { kind: 'noLocation', label: 'Pick a country', action: () => {}, disabled: true, variant: 'outline' }
    }
    if (sweepInProgress) {
      const idx = sweepProgress?.companyIdx ?? 0
      const tot = sweepProgress?.totalCompanies ?? 0
      const label = tot > 0 ? `Sweeping… (${idx}/${tot})` : 'Sweeping…'
      return { kind: 'inProgress', label, action: () => {}, disabled: true, variant: 'default', pulse: true }
    }
    if (currentScopeCells.length === 0) {
      return {
        kind: 'seedNeeded',
        label: `Seed + sweep ${currentScopeLabel}`,
        // Direct one-click action via a native confirm() prompt. The
        // earlier in-page seed-confirm popover had repeated layout /
        // pointer-events bugs (sat above the main button, intercepted
        // clicks, never fired) - one of those bugs broke the Confirm
        // button click silently. The native confirm() can't be styled
        // but it's bulletproof and gives the rep the credit warning
        // before any /seed POST goes out.
        action: () => {
          const ok = typeof window === 'undefined' || window.confirm(
            `Seed + sweep ${currentScopeLabel}?\n\n`
            + `This will generate cells for ${currentScopeLabel} and immediately start the sweep.\n\n`
            + `Spends Scrapingdog credits.`
          )
          if (ok) void handleSeedAndSweepDirect()
        },
        disabled: previewing || seeding,
        variant: 'default',
      }
    }
    if (currentScopePending === 0) {
      return { kind: 'allDone', label: 'All swept ✓', action: () => {}, disabled: true, variant: 'outline' }
    }
    // Pending cells exist - relabel based on whether this scope has any
    // prior activity. "Touched" covers terminal states (complete/no_new/
    // empty) AND cells paused mid-sweep with a checkpoint AND cells that
    // got past the Scrapingdog search step (placesFound>0) AND cells that
    // were ever scanned (lastScannedAt). All of those are resume situations
    // - the user already spent some credits + GPT time here and just needs
    // to keep going. Both actions still call handleResetBudget; the verb
    // matches reality.
    const isResume = currentScopeTouched > 0
    return {
      kind: 'sweep',
      label: `${isResume ? 'Resume sweeping' : 'Sweep'} ${currentScopePending} cell${currentScopePending === 1 ? '' : 's'} in ${currentScopeLabel}`,
      action: handleResetBudget,
      disabled: false,
      variant: 'default',
    }
  })()

  // Status line content. Three modes:
  //   - preview pending → shows what's about to be seeded (replaces the
  //     standalone preview banner that used to live further down the page)
  //   - last sweep known → shows progress on that scope
  //   - idle / no ICP → a short hint about what to do next
  const statusLine: { text: string; tone: 'idle' | 'last' | 'preview' } = (() => {
    // PREVIEW mode - shadows the historical Last: info while a preview is
    // pending so the user sees exactly what Confirm will do. Once they
    // Cancel or Confirm, this falls back to the Last: text below.
    if (preview) {
      const n = preview.cells.length
      let breakdown = ''
      if (preview.scope === 'country' && preview.stats) {
        const parts: string[] = []
        if (preview.stats.populated) parts.push(`${preview.stats.populated} populated places`)
        if (preview.stats.airport) parts.push(`${preview.stats.airport} airport${preview.stats.airport === 1 ? '' : 's'}`)
        if (preview.stats.sparse) parts.push(`${preview.stats.sparse} rural backstop`)
        if ((preview.skippedOcean ?? 0) > 0) parts.push(`${preview.skippedOcean} ocean skipped`)
        if ((preview.placesSubgridded ?? 0) > 0) parts.push(`${preview.placesSubgridded} cit${preview.placesSubgridded === 1 ? 'y' : 'ies'} sub-gridded`)
        if (parts.length > 0) breakdown = ' - ' + parts.join(' · ')
      } else if (preview.scope === 'city' && preview.perCity) {
        const list = preview.perCity
          .filter((c) => !c.skipped)
          .map((c) => `${c.city.split(',')[0]} (${c.count}${c.geocoded ? ' geocoded' : ''})`)
          .join(' · ')
        if (list) breakdown = ' - ' + list
      }
      return {
        text: `Preview: ${n} cell${n === 1 ? '' : 's'} would be seeded${breakdown}`,
        tone: 'preview',
      }
    }
    if (!activeIcp) return { text: 'Pick an ICP to get started.', tone: 'idle' }
    const last = lastScopes[activeIcp]
    if (!last || !last.type) {
      return { text: 'No sweep yet - pick a city or country and press Sweep.', tone: 'idle' }
    }
    const inScope = cells.filter((c) => {
      if (last.type === 'city') {
        if (!last.value) return c.tier === 1
        return c.parentCity === last.value
      }
      if (last.type === 'country') {
        if (!last.value) return c.tier === 2
        return c.tier === 2 && c.country === last.value
      }
      return true
    })
    const done = inScope.filter((c) => c.state === 'complete' || c.state === 'no_new' || c.state === 'empty').length
    const pending = inScope.filter((c) => c.state === 'pending').length
    const scopeName = last.type === 'country'
      ? `${last.value || 'all'} country fill`
      : (last.value || 'all cities')
    if (inScope.length === 0) {
      return { text: `Last: ${scopeName} - (cells cleared)`, tone: 'last' }
    }
    return { text: `Last: ${scopeName} - ${inScope.length} cells · ${done} complete, ${pending} pending`, tone: 'last' }
  })()

  const selectedCell = cells.find((c) => c.id === selectedCellId)

  return (
    <div className="relative h-full">
      {/* Header - ICP picker + actions. Floats above the globe. */}
      <div className={`${GLASS} px-4 py-3 mb-4`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <MapPinned className="h-4 w-4 text-sky-500" />
            {/* Portfolio Company filter - narrows the ICP dropdown to ICPs
                that feed a single Valsoft portfolio company. Useful when a
                company has several niche sub-ICPs (NedFox: Garden + Thrift
                + Camping) and the user wants to focus on just that
                company's pool. Hidden when no ICP has a portfolioCompany. */}
            {availablePortfolioCompanies.length > 0 && (
              <>
                <span className="text-sm font-semibold">Portfolio Co.</span>
                <select
                  value={portfolioFilter}
                  onChange={(e) => setPortfolioFilter(e.target.value)}
                  className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                  title="Filter ICPs by portfolio company"
                >
                  <option value="">All companies</option>
                  {availablePortfolioCompanies.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </>
            )}
            {/* Vertical filter - narrows the ICP dropdown to ICPs in the
                picked vertical. Default '' = all verticals. Always shown
                so the user can confirm at a glance which vertical they're
                operating on; with only one vertical the dropdown acts as
                a label and the only meaningful action is "All verticals". */}
            {availableVerticals.length > 0 && (
              <>
                <span className="text-sm font-semibold">Vertical</span>
                <select
                  value={verticalFilter}
                  onChange={(e) => setVerticalFilter(e.target.value)}
                  className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                  title="Narrow ICPs to one vertical"
                >
                  <option value="">All verticals</option>
                  {availableVerticals.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </>
            )}
            {/* ICP picker moved to its own row below - the filters above
                ("Portfolio Co." and "Vertical") narrow what shows in it. */}
          </div>
          {/* Cell legend - sits at the right of the top row, fills the
              empty space that was already there. Two compact clusters:
              State (cell fill colors used on globe + map) and Tier
              (stroke colors that only show up on country-fill cells in
              the map view, where each cell's stroke encodes its density
              source). Kept tiny so it never dominates the controls. */}
          <CellLegend />
        </div>

        {/* ── Row 1: ICP picker ─────────────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap mt-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold w-14">ICP</span>
          <select
            value={activeIcp}
            onChange={(e) => setActiveIcp(e.target.value)}
            className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark] min-w-[260px]"
          >
            {filteredIcps.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.vertical}){i.pendingCells ? ` · ${i.pendingCells} pending` : ''}
              </option>
            ))}
          </select>
          {filteredIcps.find((i) => i.id === activeIcp)?.cities?.length ? (
            <span className="text-[11px] text-muted-foreground truncate">
              · {filteredIcps.find((i) => i.id === activeIcp)?.cities.join(', ')}
            </span>
          ) : null}
        </div>

        {/* ── Row 2: Sweep target (scope + city/country dropdown) ───────── */}
        <div className="flex items-center gap-3 flex-wrap mt-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold w-14">Sweep</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setScope('city')}
              className={`px-2.5 py-1 transition-colors ${scope === 'city'
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40'}`}
              title="Sweep Tier-1 metro sub-cells (5km, dense)"
            >
              <MapPinned className="h-3 w-3 inline mr-1 -mt-0.5" />City
            </button>
            <button
              type="button"
              onClick={() => setScope('country')}
              className={`px-2.5 py-1 border-l border-border transition-colors ${scope === 'country'
                ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40'}`}
              title="Sweep Tier-2 country-fill cells (25km, sparse)"
            >
              <Globe2 className="h-3 w-3 inline mr-1 -mt-0.5" />Country
            </button>
          </div>

          {scope === 'city' ? (
            (filteredIcps.find((i) => i.id === activeIcp)?.cities?.length || 0) > 0 && (
              <select
                value={activeCity}
                onChange={(e) => setActiveCity(e.target.value)}
                className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                title="Which city to sweep. ✓ = already covered (reclassify-only); ○ = new (real sweep)"
              >
                {filteredIcps.find((i) => i.id === activeIcp)?.cities.map((city) => {
                  const row = coverageByCity.get(city.toLowerCase())
                  const tag = row?.covered ? `✓ ${row.cachedCompanies} cached` : '○ new'
                  // Outlier cities (resolved to a country that isn't ticked on
                  // this ICP) get disabled + a marker. Stops the user picking
                  // a grayed-out city and getting a preview that the sweep
                  // would then skip at runtime - misleading. Cities whose
                  // country lookup hasn't resolved yet pass through enabled.
                  const cc = cityCountries[city.trim()]
                  const outlier = isOutlierCity(city)
                  return (
                    <option key={city} value={city} disabled={outlier}>
                      {city}{cc ? ` (${cc})` : ''}{outlier ? ' · inactive' : (coverageStatus ? ` · ${tag}` : '')}
                    </option>
                  )
                })}
                <option value="all">
                  {coverageStatus
                    ? `All cities in ICP (${coverageStatus.summary.coveredCities} covered, ${coverageStatus.summary.newCities} new)`
                    : 'All cities in ICP'}
                </option>
              </select>
            )
          ) : (
            (() => {
              // Show ONLY the countries selected on the active ICP. The
              // global /api/grid/countries response includes every country
              // Atlas knows the bbox for, but if NedFox - Garden Centres
              // only targets NL, the boss shouldn't be able to pick UK / IE /
              // BE / US from the dropdown by accident. Falls back to the
              // global list if the ICP has no countries set (legacy ICPs).
              const icp = filteredIcps.find((i) => i.id === activeIcp)
              const allowed = icp?.countries && icp.countries.length > 0
                ? new Set(icp.countries.map((c) => c.toUpperCase()))
                : null
              const visibleCountries = allowed
                ? countries.filter((c) => allowed.has(c.code.toUpperCase()))
                : countries
              if (visibleCountries.length === 0) return null
              return (
                <select
                  value={activeCountry}
                  onChange={(e) => setActiveCountry(e.target.value)}
                  className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                  title="Country bbox for Tier-2 fill - only the countries this ICP targets"
                >
                  {visibleCountries.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
              )
            })()
          )}
        </div>

        {/* ── Row 3: Status line ────────────────────────────────────────── */}
        <div className="flex items-center gap-3 flex-wrap mt-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold w-14">Status</span>
          <span className={`text-xs ${
            statusLine.tone === 'idle'
              ? 'text-muted-foreground italic'
              : statusLine.tone === 'preview'
                ? 'text-sky-700 dark:text-sky-300 font-medium'
                : 'text-foreground'
          }`}>
            {statusLine.text}
          </span>
        </div>

        {/* Last-paused session chip. Renders only when the most recent
            operator-paused session differs from the current picker selection
            - i.e. you stopped sweeping somewhere then navigated away. One
            click restores the picker so the next Resume targets the same
            scope you actually stopped at. Lives in its own row above the
            action row so it can't shove the main button or interfere with
            the seed-confirm popover's absolute positioning underneath. */}
        {(() => {
          if (!lastPausedSession) return null
          const lp = lastPausedSession
          const sameIcp = lp.icp_id === activeIcp
          const sameScope =
            (lp.scope_type === 'city' && scope === 'city' && (lp.scope_value || '').toLowerCase() === (activeCity || '').toLowerCase())
            || (lp.scope_type === 'country' && scope === 'country' && (lp.scope_value || '').toUpperCase() === (activeCountry || '').toUpperCase())
            || (lp.scope_type === 'all' && scope === 'country' && !activeCountry)
          if (sameIcp && sameScope) return null
          const icpName = icps.find((i) => i.id === lp.icp_id)?.name || lp.icp_id || '(unknown ICP)'
          const scopeLabel = lp.scope_type === 'city'
            ? lp.scope_value || 'city'
            : lp.scope_type === 'country'
              ? lp.scope_value || 'country'
              : 'all scopes'
          const ago = (() => {
            const ms = Date.now() - new Date(lp.started_at).getTime()
            if (ms < 60_000) return 'just now'
            if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
            if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
            return `${Math.round(ms / 86_400_000)}d ago`
          })()
          return (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => {
                  if (lp.icp_id) setActiveIcp(lp.icp_id)
                  if (lp.scope_type === 'city') {
                    setScope('city')
                    if (lp.scope_value) setActiveCity(lp.scope_value)
                  } else if (lp.scope_type === 'country') {
                    setScope('country')
                    if (lp.scope_value) setActiveCountry(lp.scope_value)
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-1 text-[10px] font-medium hover:bg-amber-500/15 max-w-full"
                title={`Switch the picker to ${icpName} · ${scopeLabel} (paused ${ago}, ${lp.cells_succeeded}/${lp.cells_attempted} cells done) so the next Resume targets the same scope you actually stopped at`}
              >
                <span className="shrink-0">← Last paused:</span>
                <span className="font-semibold truncate max-w-[14rem]">{icpName}</span>
                <span className="shrink-0">· {scopeLabel}</span>
                <span className="shrink-0 opacity-70">({ago})</span>
              </button>
            </div>
          )
        })()}

        {/* ── Row 4: Actions ────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-border/40">
          <Button
            size="sm"
            variant="outline"
            onClick={handlePreview}
            disabled={previewing || seeding || !!preview || (scope === 'country' && !activeCountry) || !activeIcp}
            title={
              scope === 'country'
                ? `Preview the Tier-2 cells across ${activeCountry || 'the selected country'} before committing`
                : activeCity === 'all'
                  ? 'Preview Tier-1 metros for every city in this ICP before committing'
                  : `Preview Tier-1 metro sub-cells for ${activeCity}`
            }
          >
            {previewing
              ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : <Inbox className="h-3.5 w-3.5 mr-1.5" />}
            Preview
          </Button>

          {/* When a preview is pending, the action row swaps the main button
              for Cancel + Confirm so the confirm decision lives next to the
              Preview button that triggered it (instead of in a separate
              banner further down the page). Otherwise we render the normal
              contextual main button + seed confirm popover. */}
          {preview ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={handleCancelPreview}
                disabled={seeding}
              >
                Cancel preview
              </Button>
              <Button
                size="sm"
                onClick={handleConfirmSeed}
                disabled={seeding || preview.cells.length === 0}
                title="Seed these cells and immediately start sweeping"
              >
                {seeding
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  : <Play className="h-3.5 w-3.5 mr-1.5" />}
                Confirm: seed {preview.cells.length} cell{preview.cells.length === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            /* The contextual main button. Label + action are state-driven.
               IMPORTANT: this div is `relative` so the seed-confirm popover
               can position absolutely beneath it. Don't add flex / extra
               siblings here - the "Last paused" chip lives in its own row
               BELOW the action row (rendered after the close of this whole
               action div) so it can't shove the button or steal clicks
               from the popover. */
            <div className="relative">
              <Button
                size="sm"
                variant={mainButton.variant === 'outline' ? 'outline' : 'default'}
                onClick={mainButton.action}
                disabled={mainButton.disabled}
                className={mainButton.pulse ? 'animate-pulse' : ''}
                title={mainButton.kind === 'seedNeeded'
                  ? 'Seed cells for this view and start sweeping in one click'
                  : mainButton.kind === 'sweep'
                    ? 'Resume the cron - sweeps the pending cells in your current view'
                    : undefined}
              >
                {mainButton.kind === 'inProgress' ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : mainButton.kind === 'allDone' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-emerald-500" />
                ) : (mainButton.kind === 'sweep' || mainButton.kind === 'seedNeeded') ? (
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                ) : null}
                {mainButton.label}
              </Button>

            </div>
          )}

          <div className="flex-1" />

          {/* Overflow menu (⋯) - housekeeping actions that don't deserve a
              dedicated button. NEVER contains anything destructive (no
              Reset all - we never want to lose existing sweep data).
              Menu renders through a React portal so it escapes the GLASS
              card's overflow-hidden clipping. */}
          <div ref={overflowRef}>
            <Button
              ref={overflowBtnRef}
              size="sm"
              variant="outline"
              onClick={() => (overflowOpen ? setOverflowOpen(false) : openOverflow())}
              title="More actions"
              aria-label="More actions"
              className="px-2"
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
            {overflowOpen && overflowPos && createPortal(
              <div
                ref={overflowMenuRef}
                style={{ position: 'fixed', top: overflowPos.top, right: overflowPos.right, zIndex: 60 }}
                className="w-48 rounded-md border border-border bg-popover shadow-lg py-1"
              >
                <button
                  type="button"
                  onClick={() => { fetchAll(activeIcp); setOverflowOpen(false) }}
                  disabled={loadingCells}
                  className="w-full text-left text-xs px-3 py-1.5 hover:bg-muted/40 flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${loadingCells ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => { handleResetView(); setOverflowOpen(false) }}
                  className="w-full text-left text-xs px-3 py-1.5 hover:bg-muted/40 flex items-center gap-2"
                  title="Camera reset - zooms back out to the globe overview. Doesn't touch any sweep data."
                >
                  <Globe2 className="h-3 w-3" />
                  Reset view
                </button>
              </div>,
              document.body,
            )}
          </div>
        </div>
      </div>

      {/* Stat strip */}
      {coverage && (
        <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          <StatCard label="Coverage" value={`${coverage.donePct}%`} accent="emerald" />
          <StatCard label="Total cells" value={coverage.total} accent="slate" />
          <StatCard label="Pending" value={coverage.pending} accent="sky" />
          <StatCard
            label="Scanning"
            value={coverage.scanning}
            accent={coverage.scanning > 0 ? 'red' : 'slate'}
            pulse={coverage.scanning > 0}
          />
          <StatCard label="Places" value={coverage.placesFound} accent="indigo" />
          <StatCard label="Qualified" value={coverage.leadsQualified} accent="amber" />
        </div>
      )}

      {error && (
        <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/40 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Running banner - symmetric to the paused-session banner below.
          Visible whenever the cron is actively sweeping (NOT paused). Shows
          a Pause CTA so the operator can stop mid-cell at a company
          boundary - the in-flight company's classify+upsert finishes, then
          a checkpoint lands on the cell's pause_checkpoint column. Resume
          (the existing Resume button in the paused-session banner) reads
          the checkpoint and continues from the saved nextIdx. */}
      {activeIcp && !cronPaused && (
        <div className="px-3 py-2 mb-4 rounded-md text-xs flex items-center gap-3 flex-wrap border border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200">
          <Loader2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400 animate-spin" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">
              {pauseRequested ? 'Pausing…' : 'Sweeping in progress'}
            </span>
            <span className="text-muted-foreground">
              {' · '}
              {pauseRequested
                ? 'Current company will finish its classify+upsert, then the cell will checkpoint. Resume picks up at the next company.'
                : 'Click Pause to checkpoint at the next company boundary (the in-flight company will finish first).'}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pauseRequested || pauseClickBusy}
            onClick={async () => {
              if (pauseRequested || pauseClickBusy) return
              setPauseClickBusy(true)
              try {
                const r = await fetch(`${API}/api/grid/pause`, { method: 'POST' }).then((res) => res.json())
                if (r?.success) {
                  if (typeof r.paused === 'boolean') setCronPaused(r.paused)
                  if (typeof r.pauseRequested === 'boolean') setPauseRequested(r.pauseRequested)
                }
              } catch (e: any) {
                setError(e?.message || 'pause failed')
              } finally {
                setPauseClickBusy(false)
              }
            }}
            title="Stop after the in-flight company finishes its classify+upsert. Cell stays pending with a checkpoint; Resume continues from there."
            className="h-7 text-xs shrink-0"
          >
            {pauseRequested || pauseClickBusy
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <Pause className="h-3 w-3 mr-1" />}
            {pauseRequested ? 'Pausing…' : pauseClickBusy ? 'Sending…' : 'Pause sweeping'}
          </Button>
        </div>
      )}

      {/* Paused-session banner. Visible whenever the active ICP has pending
          cells AND the cron is currently paused. Boots paused on every
          backend restart by design (safety), so this banner is the user's
          surfacing of "you have outstanding work and nothing is running -
          want me to start?". The Resume button hands off to the existing
          handleResetBudget so the cron picks up the current view's scope
          (city / country) rather than the global queue. */}
      {(() => {
        const activeIcpPending = filteredIcps.find((i) => i.id === activeIcp)?.pendingCells || 0
        // Banner is for MANUAL pauses only - the operator hit the Pause
        // button mid-session and we want to make Resume one click away.
        // Auto-pauses (budget cap hit, no work left in scope) are an
        // expected end-of-session, not an interruption; for those, the
        // contextual scope button below the picker relabels itself to
        // "Resume sweeping N cells in {scope}" so the action is still
        // discoverable without duplicating a giant banner.
        if (!activeIcp || !cronPaused || activeIcpPending === 0 || pauseReason !== 'manual') return null
        const icpName = filteredIcps.find((i) => i.id === activeIcp)?.name || activeIcp
        // Make the scope (Manchester, Birmingham, NL, etc.) huge in the
        // banner so the rep can't mistake which resume they're about to
        // fire - the most common confusion has been "wait, is this
        // resuming Birmingham or Manchester?" when bouncing between cities
        // within the same ICP. The text-2xl scope label sits between the
        // paused-session header and the explanation line so it reads top-
        // to-bottom: state → target → action.
        const scopeLabel = scope === 'country'
          ? (activeCountry || 'no country')
          : (activeCity && activeCity !== 'all' ? activeCity : 'all cities')
        return (
          <div className="px-3 py-2 mb-4 rounded-md text-xs flex items-start gap-3 flex-wrap border border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200">
            <Pause className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400 mt-1" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">Paused session</span>
                <span className="text-muted-foreground">
                  ·{' '}
                  <span className="font-mono">{activeIcpPending}</span> pending cell{activeIcpPending === 1 ? '' : 's'} for <span className="font-medium text-foreground">{icpName}</span>
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Resume target</span>
                <span className="text-2xl font-bold leading-none text-sky-700 dark:text-sky-200 truncate">{scopeLabel}</span>
                <span className="text-[10px] text-muted-foreground">
                  ({scope === 'country' ? 'country fill' : 'city scope'})
                </span>
              </div>
              <div className="text-[10px] text-muted-foreground italic mt-1">
                The cron boots paused after every backend restart. Click Resume to start sweeping the {scope === 'country' ? 'country' : 'city'} above.
              </div>
            </div>
            <Button
              size="sm"
              onClick={handleResetBudget}
              disabled={sweepStarting}
              title={`Resume sweeping for ${icpName} (${scopeLabel})`}
              className="h-7 text-xs shrink-0"
            >
              {sweepStarting
                ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                : <Play className="h-3 w-3 mr-1" />}
              {sweepStarting ? 'Starting…' : 'Resume sweeping'}
            </Button>
          </div>
        )
      })()}

      {/* Stale-sweep banner. Visible whenever the active ICP has completed
          cells whose stored search-term list is missing terms the ICP's
          current definition would now run. Click "Rescan" → POST
          /rescan-stale-terms marks those cells back to pending, sweep cron
          picks them up, and search_log dedup ensures only the NEW terms hit
          Scrapingdog (old terms get skipped). So if 10 of 30 cells are done
          and you added a new term, only the 10 done cells rescan, and only
          with the new term - no waste on the original ones. */}
      {activeIcp && coverageStatus?.staleSweep && coverageStatus.staleSweep.stale > 0 && (
        <div className="px-3 py-2 mb-4 rounded-md text-xs flex items-center gap-3 flex-wrap border border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">
              {coverageStatus.staleSweep.stale} cell{coverageStatus.staleSweep.stale === 1 ? '' : 's'} need a rescan
            </span>
            <span className="text-muted-foreground">
              {' · '}new term{coverageStatus.staleSweep.newTerms.length === 1 ? '' : 's'} added since the last sweep:{' '}
              <span className="font-mono">
                {coverageStatus.staleSweep.newTerms.slice(0, 5).join(', ')}
                {coverageStatus.staleSweep.newTerms.length > 5 && ` +${coverageStatus.staleSweep.newTerms.length - 5}`}
              </span>
            </span>
            <div className="text-[10px] text-muted-foreground italic mt-0.5">
              Only the new term{coverageStatus.staleSweep.newTerms.length === 1 ? '' : 's'} will hit Scrapingdog (already-run terms are skipped via search_log).
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={rescanRunning}
            onClick={async () => {
              if (rescanRunning || !activeIcp) return
              setRescanRunning(true); setRescanError(null)
              try {
                const { rescanStaleTerms } = await import('@/lib/api')
                await rescanStaleTerms(activeIcp)
                // Refresh coverage so the banner clears once the cells
                // have been bumped back to pending.
                const c = await import('@/lib/api').then((m) => m.fetchIcpCoverage(activeIcp)).catch(() => null)
                if (c?.success) setCoverageStatus({ summary: c.summary, breakdown: c.breakdown, staleSweep: c.staleSweep })
              } catch (e: any) {
                setRescanError(e?.message || 'rescan failed')
              } finally {
                setRescanRunning(false)
              }
            }}
            title="Mark stale cells back to pending - cron resumes them with only the new term(s)"
            className="h-7 text-xs shrink-0"
          >
            {rescanRunning
              ? <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              : <Sparkles className="h-3 w-3 mr-1" />}
            {rescanRunning ? 'Rescanning…' : `Rescan ${coverageStatus.staleSweep.stale} cell${coverageStatus.staleSweep.stale === 1 ? '' : 's'}`}
          </Button>
          {rescanError && (
            <span className="text-[10px] text-red-600 dark:text-red-400 w-full">{rescanError}</span>
          )}
        </div>
      )}

      {/* Coverage-status banner - visible when we're in city scope and the
          backend has reported per-city coverage. Tells the user the split
          before they hit Seed: how many of the ICP's cities are already
          covered (sweep can be skipped, reclassify only) vs how many will
          need a real sweep. Helps avoid surprise credit usage. */}
      {scope === 'city' && coverageStatus && coverageStatus.summary.totalCities > 0 && (
        <div className={`${GLASS_SUBTLE} px-3 py-2 mb-4 rounded-md text-xs flex items-center gap-3 flex-wrap`}>
          <span className="font-semibold">Coverage:</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            ✓ {coverageStatus.summary.coveredCities} covered
            {coverageStatus.summary.totalCachedCompanies > 0 && (
              <span className="text-muted-foreground font-normal"> ({coverageStatus.summary.totalCachedCompanies} cached compan{coverageStatus.summary.totalCachedCompanies === 1 ? 'y' : 'ies'})</span>
            )}
          </span>
          <span className="text-amber-600 dark:text-amber-400">
            ○ {coverageStatus.summary.newCities} new
            {coverageStatus.summary.newCities > 0 && (
              <span className="text-muted-foreground font-normal"> (need a real sweep)</span>
            )}
          </span>
          {coverageStatus.summary.totalToReclassify > 0 && (
            <span className="text-sky-600 dark:text-sky-400">
              · {coverageStatus.summary.totalToReclassify} compan{coverageStatus.summary.totalToReclassify === 1 ? 'y' : 'ies'} ready to reclassify (cheap)
            </span>
          )}
          <span className="text-muted-foreground italic ml-auto">
            Edit ICP → "Reclassify cached data" to run only the GPT step
          </span>
        </div>
      )}

      {/* The standalone preview banner used to live here. It was confusing -
          its Cancel/Start sweep buttons sat far from the Preview button that
          triggered them, and it competed with the contextual main button
          above (both showed sweep-related actions at once). It's now folded
          into the header's Row 3 (status line shows the breakdown) and Row 4
          (action row swaps to Cancel + Confirm while preview is pending). */}

      {/* Globe + drawer */}
      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-[calc(100vh-280px)] min-h-[500px]">
        {/* Globe container - frame only, no frosted-glass wash inside.
            The previous GLASS_SUBTLE wrap had backdrop-blur-xl + bg-white/45
            which sat in front of the canvas and made the (mostly transparent)
            sphere unreadable. We keep just the rounded border + shadow so
            the globe gets a card-like frame without obscuring it. */}
        <div className="relative overflow-hidden rounded-2xl border border-white/30 dark:border-white/10 shadow-lg shadow-black/10 dark:shadow-black/30 bg-slate-950/5 dark:bg-slate-950/30">
          <Suspense fallback={<div className="relative h-full"><GlobePlaceholder /></div>}>
            {/* Globe-or-map driven by `effectiveMode`. Pre-seed (cells empty)
                forces globe and overlays the "Seed cells" CTA. Post-seed
                the user toggles modes by zooming: zoom out past continent
                level → globe; zoom in past city level → map. */}
            {effectiveMode === 'map' ? (
              <CoverageMap
                cells={cells}
                centerLat={effectiveCenterLat}
                centerLng={effectiveCenterLng}
                bounds={effectiveBounds}
                previewCells={preview?.cells}
                onCellClick={(c) => setSelectedCellId(c.id)}
                selectedCellId={selectedCellId}
                onZoomChange={handleMapZoomChange}
              />
            ) : (
              <div className="relative h-full">
                <CoverageGlobe
                  cells={cells}
                  centerLat={effectiveCenterLat}
                  centerLng={effectiveCenterLng}
                  altitude={zoomTarget.altitude}
                  onCellClick={(c) => setSelectedCellId(c.id)}
                  selectedCellId={selectedCellId}
                  onZoomChange={handleGlobeZoomChange}
                />
                {cells.length === 0 && (
                  // Floating CTA - translucent panel over the globe so the
                  // earth backdrop is still visible. Only shown pre-seed.
                  <div className="absolute inset-x-0 bottom-6 flex justify-center pointer-events-none">
                    <div className={`${GLASS} px-5 py-4 max-w-sm pointer-events-auto`}>
                      <p className="text-sm font-medium mb-1">No cells yet for this ICP.</p>
                      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                        Hit "Preview" to see where the cells would land based on the ICP's
                        coverage tiers, then confirm to start the sweep.
                      </p>
                      <Button size="sm" onClick={handlePreview} disabled={previewing} className="w-full">
                        {previewing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Inbox className="h-3.5 w-3.5 mr-1.5" />}
                        Preview
                      </Button>
                    </div>
                  </div>
                )}
                {cells.length > 0 && (
                  // Post-seed globe mode hint - tells the user how to get back.
                  <div className="absolute top-3 left-3 pointer-events-none">
                    <div className={`${GLASS} px-3 py-1.5 text-[11px] text-muted-foreground`}>
                      Scroll in to return to the city map
                    </div>
                  </div>
                )}
              </div>
            )}
          </Suspense>
        </div>

        {/* Cell-detail drawer */}
        <Card className={GLASS}>
          <CardContent className="p-4">
            <div className="flex flex-col h-full max-h-[calc(100vh-300px)]">
              {selectedCell ? (
                <div className="pb-3 mb-3 border-b border-border/50">
                  <CellDetail
                    cell={selectedCell}
                    onForceSweep={() => handleForceSweep(selectedCell.id)}
                    forceSweepBusy={sweeping === selectedCell.id}
                    onClose={() => setSelectedCellId(null)}
                  />
                </div>
              ) : (
                <>
                  {/* Live progress panel - driven by the Socket.IO stream.
                      Shows the current cell + per-company step + N/M progress
                      bar. Collapses to a quiet "waiting" state when no sweep
                      is in flight. Sits above the activity feed so the user's
                      eye lands on "what's happening now" before scanning the
                      log of what's already happened. */}
                  <div className="mb-3 space-y-2">
                    <NowSweepingPanel progress={sweepProgress} connected={socketConnected} starting={sweepStarting} />
                    {/* Compact "last 5 company verdicts" mini-feed. Sits
                        between NowSweepingPanel (one current step) and the
                        full activity timeline below, so recent qualified /
                        rejected calls pop into view at a glance. */}
                    <NowScrapingTrace events={activity} />
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity</span>
                    <span className="text-[10px] text-muted-foreground">click any cell to inspect</span>
                  </div>
                </>
              )}
              <ActivityLog activity={activity} isAnyActive={isAnyActive} />
              {/* Persisted sweep-session history. Collapsed by default so
                  it doesn't compete with the live activity feed above.
                  Backed by sweep_sessions in Supabase - survives restart. */}
              {activeIcp && (
                <div className="mt-3">
                  <RecentSessionsPanel icpId={activeIcp} />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// Compact two-cluster legend for the cell colors shown on the globe + map.
// State cluster (fill colors): pending / scanning / complete / no_new /
// empty. Tier cluster (stroke colors on country-fill cells in the map
// view only): urban / suburban / rural / airport / sparse. Kept in a
// single-row layout with tiny dot swatches so it doesn't compete visually
// with the controls on the left side of the header. Hex values kept in
// sync with coverage-globe.tsx and coverage-map.tsx - if either drifts
// the legend reads wrong without errors, so update both at once.
function CellLegend() {
  // State fill colors. Pulse is just a tooltip hint; the actual pulse
  // animation lives on the globe scanning ring + map cm-cell-pulse class.
  const STATE = [
    { label: 'Pending',  color: '#7dd3fc', help: 'queued for sweep' },
    { label: 'Scanning', color: '#f87171', help: 'in flight (pulsing)' },
    { label: 'Complete', color: '#4ade80', help: 'found qualified leads' },
    { label: 'No new',   color: '#fbbf24', help: 'swept; all already known' },
    { label: 'Empty',    color: '#94a3b8', help: 'swept; no leads at this resolution' },
  ]
  // Country-fill tier strokes. Only relevant when scope=country in the
  // map view; on the globe these are state-coloured solids regardless.
  const TIER = [
    { label: 'Urban',    color: '#0284c7', help: '≥7 km radius city centres' },
    { label: 'Suburban', color: '#7c3aed', help: 'mid-density cells' },
    { label: 'Rural',    color: '#16a34a', help: 'sparse residential / town' },
    { label: 'Airport',  color: '#d97706', help: 'airport hubs (per ICP toggle)' },
    { label: 'Sparse',   color: '#166534', help: 'rural backstop hex' },
  ]
  return (
    <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
      <div className="flex items-center gap-1.5 flex-wrap" title="Cell fill = sweep state">
        <span className="uppercase tracking-wider font-semibold opacity-70">State</span>
        {STATE.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1" title={s.help}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <span className="opacity-30">|</span>
      <div className="flex items-center gap-1.5 flex-wrap" title="Country-fill cell stroke = density source (map view only)">
        <span className="uppercase tracking-wider font-semibold opacity-70">Tier</span>
        {TIER.map((t) => (
          <span key={t.label} className="inline-flex items-center gap-1" title={t.help}>
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2 bg-transparent" style={{ borderColor: t.color }} />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  accent,
  pulse,
}: {
  label: string
  value: number | string
  accent: 'emerald' | 'sky' | 'red' | 'indigo' | 'amber' | 'slate'
  pulse?: boolean
}) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
    sky:     'text-sky-700 dark:text-sky-300 border-sky-500/40',
    red:     'text-red-700 dark:text-red-300 border-red-500/50',
    indigo:  'text-indigo-700 dark:text-indigo-300 border-indigo-500/40',
    amber:   'text-amber-700 dark:text-amber-300 border-amber-500/40',
    slate:   'text-slate-700 dark:text-slate-300 border-slate-500/30',
  }
  return (
    <div className={`${GLASS_SUBTLE} px-3 py-2 border ${colors[accent]} ${pulse ? 'animate-pulse' : ''}`}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  )
}

// "3 days ago" / "12 min ago" / "just now" style. Returns 'never' when the
// timestamp is missing - cells in the `pending` state that haven't been
// scanned yet land here. The CellDrawer pairs this with the full locale
// string as a tooltip so the user can read either.
function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString()
}

function CellDetail({
  cell,
  onForceSweep,
  forceSweepBusy,
  onClose,
}: {
  cell: Cell
  onForceSweep: () => void
  forceSweepBusy: boolean
  onClose: () => void
}) {
  // Two views of the same timestamp: short relative ("3 days ago") rendered
  // inline for fast scanning, full locale string surfaced on tooltip for
  // the exact moment. "never" when the cell has never been swept (pending,
  // first-time seed).
  const lastScannedAbs = cell.lastScannedAt
    ? new Date(cell.lastScannedAt).toLocaleString()
    : 'never'
  const lastScannedRel = formatRelativeTime(cell.lastScannedAt)
  return (
    <div>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{cell.parentCity || 'Cell'}</div>
          <div className="text-sm font-semibold capitalize">{cell.state.replace('_', ' ')}</div>
          {/* Pause checkpoint chip - only when the cell has been mid-sweep
              paused. Tells the operator exactly which company the sweep
              will resume from on next Resume click. */}
          {cell.pauseCheckpoint && (
            <div
              className="mt-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-medium"
              title={cell.pauseCheckpoint.pausedAt
                ? `Paused at ${new Date(cell.pauseCheckpoint.pausedAt).toLocaleString()}. Resume will continue from this company.`
                : 'Mid-sweep checkpoint. Resume will continue from this company.'}
            >
              <Pause className="h-2.5 w-2.5" />
              Paused at company {cell.pauseCheckpoint.nextIdx + 1}
              {Array.isArray(cell.pauseCheckpoint.survivors)
                ? ` / ${cell.pauseCheckpoint.survivors.length}`
                : ''}
            </div>
          )}
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">×</button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs mb-4">
        <dt className="text-muted-foreground">Lat</dt><dd className="tabular-nums">{cell.lat.toFixed(4)}</dd>
        <dt className="text-muted-foreground">Lng</dt><dd className="tabular-nums">{cell.lng.toFixed(4)}</dd>
        <dt className="text-muted-foreground">Tier</dt><dd>{cell.tier}</dd>
        <dt className="text-muted-foreground">Last scanned</dt>
        <dd title={lastScannedAbs}>{lastScannedRel}</dd>
        <dt className="text-muted-foreground">Places found</dt><dd className="font-semibold">{cell.placesFound ?? 0}</dd>
        <dt className="text-muted-foreground">Qualified</dt><dd className="font-semibold text-emerald-600 dark:text-emerald-400">{cell.leadsQualified ?? 0}</dd>
        {typeof cell.chainsFiltered === 'number' && (<>
          <dt className="text-muted-foreground">Chains filtered</dt><dd>{cell.chainsFiltered}</dd>
        </>)}
        {typeof cell.nonTargetFiltered === 'number' && (<>
          <dt className="text-muted-foreground">Non-target</dt><dd>{cell.nonTargetFiltered}</dd>
        </>)}
        {typeof cell.alreadyKnown === 'number' && cell.alreadyKnown > 0 && (<>
          <dt className="text-muted-foreground">Dedup</dt><dd>{cell.alreadyKnown}</dd>
        </>)}
      </dl>

      <Button size="sm" className="w-full" onClick={onForceSweep} disabled={forceSweepBusy || cell.state === 'scanning'}>
        {forceSweepBusy
          ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Sweeping…</>
          : <><Play className="h-3.5 w-3.5 mr-1.5" /> {cell.state === 'pending' ? 'Sweep now' : 'Re-sweep'}</>}
      </Button>
      {cell.state === 'scanning' && (
        <p className="text-xs text-muted-foreground mt-2 text-center">In progress - refreshing every 12 s.</p>
      )}
    </div>
  )
}

// Types that survive into the historical activity log. The granular per-
// company progress events (`places_fetching`, `places_fetched`,
// `company_scrape_start`, `company_classify_start`) drive the live
// NowSweepingPanel above and don't belong in the historical log - they'd
// render as a flicker of "·" rows every few hundred ms during a sweep.
// Outcomes (qualified / rejected) and cell-level milestones (start / complete)
// are what the user actually wants to scan in the log.
const VISIBLE_LOG_TYPES = new Set<ActivityEvent['type']>([
  'cell_start',
  'cell_complete',
  'company_qualified',
  'company_rejected',
  'session_summary',
])

// Live sweep activity feed - newest events at the top, scrollable. Each
// entry's color/icon comes from the event type so the user can scan the
// log and see at a glance "qualified", "rejected", "cell complete", etc.
// Empty state shows a friendly placeholder so the panel never looks dead.
function ActivityLog({
  activity,
  isAnyActive,
}: {
  activity: ActivityEvent[]
  isAnyActive: boolean
}) {
  // Filter once per render - cheap, and keeps the visible-types decision
  // out of the row component (which then doesn't need to early-return).
  const visible = activity.filter((e) => VISIBLE_LOG_TYPES.has(e.type))
  if (visible.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-center px-4">
        <div>
          <div className="w-2 h-2 rounded-full bg-muted-foreground/30 mx-auto mb-2 animate-pulse" />
          <p className="text-xs text-muted-foreground">
            {isAnyActive ? 'Waiting for the next sweep…' : 'No sweeps running. Hit "Seed cells" to start.'}
          </p>
        </div>
      </div>
    )
  }
  return (
    <ul className="flex-1 overflow-y-auto pr-1 space-y-1.5 text-xs">
      {visible.map((e) => (
        <ActivityRow key={e.id} event={e} />
      ))}
    </ul>
  )
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const ts = new Date(event.ts)
  const timeStr = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

  let icon = '·'
  let iconClass = 'text-muted-foreground'
  let lineClass = ''
  if (event.type === 'company_qualified') { icon = '✓'; iconClass = 'text-emerald-600 dark:text-emerald-400 font-bold' }
  else if (event.type === 'company_rejected') { icon = '✗'; iconClass = 'text-red-600 dark:text-red-400 font-bold' }
  else if (event.type === 'cell_start') { icon = '▶'; iconClass = 'text-sky-600 dark:text-sky-400'; lineClass = 'opacity-70' }
  else if (event.type === 'cell_complete') {
    // Three end states render distinctly in the activity feed so a glance
    // tells you whether the cell pulled new leads (◀ green), found
    // already-known places (◐ amber), or genuinely had nothing (○ slate).
    if (event.state === 'no_new') {
      icon = '◐'
      iconClass = 'text-amber-600 dark:text-amber-400'
    } else if (event.state === 'empty') {
      icon = '○'
      iconClass = 'text-slate-500'
    } else {
      icon = '◀'
      iconClass = 'text-emerald-600 dark:text-emerald-400'
    }
    lineClass = 'opacity-80 italic'
  }

  // Session summary - visually a milestone row. Amber accent + bordered
  // pill so it doesn't get lost in the stream of per-company verdicts.
  if (event.type === 'session_summary') {
    return (
      <li className="rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 px-2 py-1.5 flex gap-2 leading-tight">
        <span className="shrink-0 w-3 text-center">⏸</span>
        <div className="flex-1 break-words">
          <div className="font-semibold text-[11px]">Session paused - budget exhausted</div>
          <div className="text-[11px] opacity-90 mt-0.5">{event.message}</div>
          <div className="text-[10px] opacity-70 mt-1 tabular-nums">
            {event.cellsSwept ?? 0} cells · {event.placesFound ?? 0} scraped · {event.leadsQualified ?? 0} qualified
            {typeof event.alreadyKnown === 'number' && event.alreadyKnown > 0 && ` · ${event.alreadyKnown} already known`}
            {typeof event.chainsFiltered === 'number' && event.chainsFiltered > 0 && ` · ${event.chainsFiltered} chains skipped`}
          </div>
        </div>
        <span className="shrink-0 tabular-nums opacity-60 text-[10px] mt-0.5">{timeStr}</span>
      </li>
    )
  }

  return (
    <li className={`flex gap-2 leading-tight ${lineClass}`}>
      <span className={`shrink-0 w-3 text-center ${iconClass}`}>{icon}</span>
      <span className="flex-1 break-words">
        {event.message}
        {event.reason && event.type === 'company_rejected' && (
          <span className="block opacity-70 text-[10px] mt-0.5">{event.reason}</span>
        )}
      </span>
      <span className="shrink-0 tabular-nums opacity-50 text-[10px] mt-0.5">{timeStr}</span>
    </li>
  )
}
