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
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw, MapPinned, Play, Inbox, Globe2, Trash2 } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'

const CoverageGlobe = lazy(() => import('@/components/coverage/coverage-globe'))
const CoverageMap = lazy(() => import('@/components/coverage/coverage-map'))
import NowSweepingPanel from '@/components/coverage/now-sweeping-panel'
import { useSweepEvents } from '@/hooks/use-sweep-events'
import { useWorkspace } from '@/context/workspace-context'

// All API calls go through Vite's /api proxy to localhost:3001 (see
// vite.config.ts) - same pattern used by lib/api.ts. Keeps the frontend
// agnostic of the backend URL.
const API = ''

interface Icp {
  id: string
  name: string
  vertical: string
  // Optional portfolio company tag - lets us group ICPs that feed the
  // same Valsoft portfolio company (e.g. NedFox's Garden + Thrift +
  // Camping sub-ICPs all set portfolioCompany='NedFox').
  portfolioCompany?: string
  cities: string[]
}

interface Cell {
  id: string
  icpId: string
  tier: number
  lat: number
  lng: number
  state: 'pending' | 'scanning' | 'complete' | 'empty'
  parentCity?: string
  country?: string
  placesFound?: number
  leadsQualified?: number
  chainsFiltered?: number
  nonTargetFiltered?: number
  alreadyKnown?: number
  lastScannedAt?: number | null
}

interface Coverage {
  pending: number
  scanning: number
  complete: number
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
  // session_summary payload — accumulated across the cells in the just-
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
  } | null>(null)
  // 'all' = every city in the ICP; otherwise the city label being targeted.
  const [activeCity, setActiveCity] = useState<string>('all')
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
    // Reset the per-ICP city selection so we don't carry over a city that
    // doesn't exist in the new ICP's cities[].
    setActiveCity('all')
  }, [activeIcp])

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
        if (d?.success) setCoverageStatus({ summary: d.summary, breakdown: d.breakdown })
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

  // Live polling - every 6s while any cell is pending or scanning. Stops
  // when everything's settled so we don't hammer the API in idle states.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!activeIcp) return
    if (pollRef.current) clearInterval(pollRef.current)
    if (isAnyActive) {
      pollRef.current = setInterval(() => fetchAll(activeIcp), 6000)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [activeIcp, isAnyActive])

  // Activity feed polling - every 4s while there's activity, runs
  // independently of the cell poll so new company hits surface in the
  // log within 4s rather than waiting up to 6s for the next cell tick.
  // Reset the activity log + cursor on ICP change so we don't show
  // events from a different ICP.
  useEffect(() => {
    setActivity([])
    lastEventIdRef.current = 0
  }, [activeIcp])
  useEffect(() => {
    if (!activeIcp) return
    let cancelled = false
    const tick = async () => {
      try {
        const url = `${API}/api/grid/activity?icp=${encodeURIComponent(activeIcp)}&since=${lastEventIdRef.current}`
        const res = await fetch(url).then((r) => r.json())
        if (cancelled) return
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
    }
    tick() // immediate fire on mount/ICP change
    // Slower fallback poll now that the socket is the primary channel -
    // 12s active / 30s idle. The socket pushes new events sub-second; the
    // poll just catches anything we miss during a reconnect or initial
    // page-load gap before the socket connects.
    const id = setInterval(tick, isAnyActive ? 12000 : 30000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeIcp, isAnyActive])

  // Realtime channel - Socket.IO subscription scoped to the active ICP.
  // Surfaces both the in-flight `progress` (consumed by NowSweepingPanel)
  // and the raw `events` stream we merge into the activity feed below.
  const { events: socketEvents, progress: sweepProgress, connected: socketConnected } = useSweepEvents(activeIcp)

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
      const res = await fetch(`${API}/api/grid/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
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
        res = await fetch(`${API}/api/grid/seed-country`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ icp: activeIcp, country: activeCountry }),
        }).then((r) => r.json())
      } else {
        const body: { icp: string; cities?: string[] } = { icp: activeIcp }
        if (activeCity !== 'all') body.cities = [activeCity]
        res = await fetch(`${API}/api/grid/seed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }).then((r) => r.json())
      }
      if (!res.success) throw new Error(res.error || 'seed failed')
      setPreview(null)
      await fetchAll(activeIcp)
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
      await fetch(`${API}/api/grid/reset-budget`, { method: 'POST' })
    } catch (e: any) {
      setError(e.message)
    }
  }

  // Full wipe - drops every cell for the active ICP and resets the cron's
  // per-session budget. Used to start the demo over from scratch.
  const handleResetAll = async () => {
    if (!activeIcp) return
    if (!confirm(`Wipe every cell for "${activeIcp}" and reset the cron budget? This can't be undone.`)) return
    setLoadingCells(true)
    setError(null)
    try {
      const res = await fetch(`${API}/api/grid/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ icp: activeIcp }),
      }).then((r) => r.json())
      if (!res.success) throw new Error(res.error || 'reset failed')
      setSelectedCellId(null)
      await fetchAll(activeIcp)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingCells(false)
    }
  }

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
            <span className="text-sm font-semibold">ICP</span>
            <select
              value={activeIcp}
              onChange={(e) => setActiveIcp(e.target.value)}
              className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
            >
              {filteredIcps.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.vertical})
                </option>
              ))}
            </select>
            {filteredIcps.find((i) => i.id === activeIcp)?.cities?.length ? (
              <span className="text-xs text-muted-foreground">
                · {filteredIcps.find((i) => i.id === activeIcp)?.cities.join(', ')}
              </span>
            ) : null}
          </div>

          <div className="flex-1" />

          <Button size="sm" variant="outline" onClick={() => fetchAll(activeIcp)} disabled={loadingCells}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingCells ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={handleResetBudget} title="Resume sweeping - the cron pauses after 30 cells per session to protect API credits. Clears the counter so it picks up where it left off. Cells stay.">
            Resume sweeping
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleResetAll}
            title="Wipe every cell for this ICP and start over from a fresh seed. This can't be undone."
            className="text-red-600 dark:text-red-400 hover:bg-red-500/10"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Reset all
          </Button>
          {/* Scope chooser - segmented toggle. Drives which dropdown shows
              and which endpoint Seed hits. Mutually exclusive: a single
              seed pass is either a Tier-1 city grid OR a Tier-2 country
              fill, never both. */}
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setScope('city')}
              className={`px-2.5 py-1 transition-colors ${scope === 'city'
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40'}`}
              title="Seed Tier-1 metro sub-cells (5km, dense)"
            >
              <MapPinned className="h-3 w-3 inline mr-1 -mt-0.5" />City
            </button>
            <button
              type="button"
              onClick={() => setScope('country')}
              className={`px-2.5 py-1 border-l border-border transition-colors ${scope === 'country'
                ? 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40'}`}
              title="Seed Tier-2 country-fill cells (25km, sparse)"
            >
              <Globe2 className="h-3 w-3 inline mr-1 -mt-0.5" />Country
            </button>
          </div>

          {/* Target dropdown - switches between city list (from the active
              ICP) and country list. Only shown when there's something to
              pick. City options annotate their coverage status: "✓ cached"
              means the vertical has scraped companies in that city already
              (seeding will use the reclassify-only path), "○ new" means a
              real sweep is required. */}
          {scope === 'city' ? (
            (filteredIcps.find((i) => i.id === activeIcp)?.cities?.length || 0) > 0 && (
              <select
                value={activeCity}
                onChange={(e) => setActiveCity(e.target.value)}
                className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                title="Which city to seed. ✓ = covered (reclassify-only); ○ = new (real sweep)"
              >
                <option value="all">
                  {coverageStatus
                    ? `All cities in ICP (${coverageStatus.summary.coveredCities} covered, ${coverageStatus.summary.newCities} new)`
                    : 'All cities in ICP'}
                </option>
                {filteredIcps.find((i) => i.id === activeIcp)?.cities.map((city) => {
                  const row = coverageByCity.get(city.toLowerCase())
                  const tag = row?.covered ? `✓ ${row.cachedCompanies} cached` : '○ new'
                  return (
                    <option key={city} value={city}>
                      {city} {coverageStatus ? `· ${tag}` : ''}
                    </option>
                  )
                })}
              </select>
            )
          ) : (
            countries.length > 0 && (
              <select
                value={activeCountry}
                onChange={(e) => setActiveCountry(e.target.value)}
                className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
                title="Country bbox for Tier-2 fill"
              >
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
            )
          )}

          <Button
            size="sm"
            onClick={handlePreview}
            disabled={previewing || seeding || !!preview || (scope === 'country' && !activeCountry)}
            title={
              scope === 'country'
                ? `Preview the Tier-2 cells across ${activeCountry || 'the selected country'} based on the ICP's coverage tiers - review before committing`
                : activeCity === 'all'
                  ? 'Preview Tier-1 metros for every city in this ICP - review before committing'
                  : `Preview Tier-1 metro sub-cells for ${activeCity}`
            }
          >
            {previewing
              ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : scope === 'country'
                ? <Globe2 className="h-3.5 w-3.5 mr-1.5" />
                : <Inbox className="h-3.5 w-3.5 mr-1.5" />}
            Preview {scope === 'country' ? 'country fill' : 'city seed'}
          </Button>
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

      {/* Preview banner - appears between the stats and the map when a
          /api/grid/preview response is in flight. Shows the breakdown of
          where cells would land + Confirm/Cancel buttons. */}
      {preview && (
        <div className={`${GLASS} px-4 py-3 mb-4 flex items-center gap-3 flex-wrap`}>
          <span className="text-sm font-semibold">
            {preview.cells.length} cell{preview.cells.length === 1 ? '' : 's'} ready to seed
          </span>
          {preview.scope === 'country' && preview.stats && (
            <span className="text-xs text-muted-foreground">
              {preview.stats.populated ? `${preview.stats.populated} populated places` : ''}
              {preview.stats.airport ? `${preview.stats.populated ? ' · ' : ''}${preview.stats.airport} airport${preview.stats.airport === 1 ? '' : 's'}` : ''}
              {preview.stats.sparse ? `${(preview.stats.populated || preview.stats.airport) ? ' · ' : ''}${preview.stats.sparse} rural backstop` : ''}
              {(preview.skippedOcean ?? 0) > 0 ? ` · ${preview.skippedOcean} ocean skipped` : ''}
              {(preview.placesSubgridded ?? 0) > 0 ? ` · ${preview.placesSubgridded} cit${preview.placesSubgridded === 1 ? 'y' : 'ies'} sub-gridded` : ''}
            </span>
          )}
          {preview.scope === 'city' && preview.perCity && (
            <span className="text-xs text-muted-foreground">
              {preview.perCity
                .filter((c) => !c.skipped)
                .map((c) => `${c.city.split(',')[0]} (${c.count}${c.geocoded ? ' geocoded' : ''})`)
                .join(' · ')}
              {(preview.geocodedCount ?? 0) > 0 ? '' : ''}
            </span>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={handleCancelPreview} disabled={seeding}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirmSeed} disabled={seeding || preview.cells.length === 0}>
            {seeding ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
            Start sweep
          </Button>
        </div>
      )}

      {/* Globe + drawer */}
      <div className="relative grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-[calc(100vh-280px)] min-h-[500px]">
        {/* Globe container - frame only, no frosted-glass wash inside.
            The previous GLASS_SUBTLE wrap had backdrop-blur-xl + bg-white/45
            which sat in front of the canvas and made the (mostly transparent)
            sphere unreadable. We keep just the rounded border + shadow so
            the globe gets a card-like frame without obscuring it. */}
        <div className="relative overflow-hidden rounded-2xl border border-white/30 dark:border-white/10 shadow-lg shadow-black/10 dark:shadow-black/30 bg-slate-950/5 dark:bg-slate-950/30">
          <Suspense fallback={<div className="h-full grid place-items-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
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
                  <div className="mb-3">
                    <NowSweepingPanel progress={sweepProgress} connected={socketConnected} />
                  </div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity</span>
                    <span className="text-[10px] text-muted-foreground">click any cell to inspect</span>
                  </div>
                </>
              )}
              <ActivityLog activity={activity} isAnyActive={isAnyActive} />
            </div>
          </CardContent>
        </Card>
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
  const lastScanned = cell.lastScannedAt
    ? new Date(cell.lastScannedAt).toLocaleString()
    : 'never'
  return (
    <div>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{cell.parentCity || 'Cell'}</div>
          <div className="text-sm font-semibold capitalize">{cell.state}</div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm">×</button>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs mb-4">
        <dt className="text-muted-foreground">Lat</dt><dd className="tabular-nums">{cell.lat.toFixed(4)}</dd>
        <dt className="text-muted-foreground">Lng</dt><dd className="tabular-nums">{cell.lng.toFixed(4)}</dd>
        <dt className="text-muted-foreground">Tier</dt><dd>{cell.tier}</dd>
        <dt className="text-muted-foreground">Last scanned</dt><dd>{lastScanned}</dd>
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
    icon = event.state === 'empty' ? '○' : '◀'
    iconClass = event.state === 'empty' ? 'text-slate-500' : 'text-emerald-600 dark:text-emerald-400'
    lineClass = 'opacity-80 italic'
  }

  // Session summary — visually a milestone row. Amber accent + bordered
  // pill so it doesn't get lost in the stream of per-company verdicts.
  if (event.type === 'session_summary') {
    return (
      <li className="rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 px-2 py-1.5 flex gap-2 leading-tight">
        <span className="shrink-0 w-3 text-center">⏸</span>
        <div className="flex-1 break-words">
          <div className="font-semibold text-[11px]">Session paused — budget exhausted</div>
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
