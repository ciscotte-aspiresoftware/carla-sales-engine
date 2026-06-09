// New Leads - Scrapingdog Google Maps sourcing.
// User picks a location (via Cities dropdown OR by clicking a 3D globe),
// hits Search (5 credits), gets a list of independent car rentals.
//   - Filter client-side (rating, has-website, min-reviews) - free
//   - "Get details" on a row → Places API call (5 credits, cached)
//   - "Send to Sales Agent" → seeds companies.json + jumps to /

import { useEffect, useState, useMemo, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconCompass,
  IconLoader2,
  IconAlertTriangle,
  IconStar,
  IconWorld,
  IconPhone,
  IconMapPin,
  IconChevronDown,
  IconChevronUp,
  IconArrowRight,
  IconSearch,
  IconRefresh,
  IconWorldLatitude,
  IconList,
  IconMapPinFilled,
  IconMinimize,
  IconMaximize,
  IconX,
  IconHistory,
} from '@tabler/icons-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  fetchSourcingCities,
  searchSourcing,
  getPlaceDetails,
  promoteToSalesAgent,
  fetchSourcingScans,
  type SourcingCity,
  type SourcingResult,
  type SourcingScanCounts,
  type SourcingScanSummary,
  type PlaceDetailsTrimmed,
} from '@/lib/api'
import type { GlobeSelection } from '@/components/sourcing/globe-picker'

// Globe is heavy (~600KB gzipped including three.js), so we lazy-load it
// behind Suspense - only fetched when the user actually opens the Globe tab.
// Sales Agent and the Cities tab stay fast.
const GlobePicker = lazy(() => import('@/components/sourcing/globe-picker'))

type PickerMode = 'cities' | 'globe'

interface Selection {
  type: 'city' | 'point'
  cityKey?: string
  lat: number
  lng: number
  label: string
}

export default function SourcingPage() {
  const navigate = useNavigate()

  // Cities loaded once on mount - they're static so no refetch needed.
  const [cities, setCities] = useState<SourcingCity[]>([])

  // Picker mode: Cities tab (dropdown) or Globe tab (3D map).
  const [pickerMode, setPickerMode] = useState<PickerMode>('cities')

  // Globe-mode only: lets the user dismiss the picker card down to a tiny
  // pill so the globe canvas isn't blocked. They can re-expand any time.
  const [pickerCollapsed, setPickerCollapsed] = useState(false)

  // Unified selection - the Cities dropdown writes a city-mode entry, the
  // Globe writes either city-mode (clicked marker) or point-mode (clicked
  // free space). Both feed the same Search call.
  const [selection, setSelection] = useState<Selection | null>(null)

  // Search state
  const [results, setResults] = useState<SourcingResult[]>([])
  const [scanId, setScanId] = useState<string | null>(null)
  const [counts, setCounts] = useState<SourcingScanCounts | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasLoadedPage1, setHasLoadedPage1] = useState(false)

  // Per-row state - expanded details + in-flight detail fetches + the
  // promote spinner so we know which row's button to disable.
  const [expanded, setExpanded] = useState<Record<string, PlaceDetailsTrimmed | 'loading' | 'error'>>({})
  const [promoting, setPromoting] = useState<string | null>(null)

  // Filters (client-side, free)
  const [minRating, setMinRating] = useState<number>(0)
  const [minReviews, setMinReviews] = useState<number>(0)
  const [onlyWithWebsite, setOnlyWithWebsite] = useState(false)

  // Recent scans footer. Dismissible because the list grows over time and
  // starts covering the globe in globe-mode. Re-opens automatically when
  // a new scan completes (fresh data is worth surfacing again).
  const [scans, setScans] = useState<SourcingScanSummary[]>([])
  const [scansDismissed, setScansDismissed] = useState(false)

  useEffect(() => {
    fetchSourcingCities()
      .then(({ cities }) => {
        setCities(cities)
        // Default to the first city so the user has something selected
        // even before they touch the controls.
        if (cities.length > 0) {
          setSelection({
            type: 'city',
            cityKey: cities[0].key,
            lat: cities[0].lat,
            lng: cities[0].lng,
            label: cities[0].label,
          })
        }
      })
      .catch((err) => setError(`Failed to load cities: ${err.message}`))
    refreshScans()
  }, [])

  function refreshScans() {
    fetchSourcingScans().then(({ scans }) => {
      setScans(scans)
      // A fresh scan just landed - un-dismiss so the new entry is visible.
      setScansDismissed(false)
    }).catch(() => {})
  }

  // Build the search-args payload from the current selection.
  function buildSearchArgs(page: number) {
    if (!selection) return null
    if (selection.type === 'city' && selection.cityKey) {
      return { cityKey: selection.cityKey, page }
    }
    return { point: { lat: selection.lat, lng: selection.lng, label: selection.label }, page }
  }

  async function handleSearch() {
    if (!selection || loading) return
    const args = buildSearchArgs(0)
    if (!args) return
    setLoading(true)
    setError(null)
    setResults([])
    setExpanded({})
    setScanId(null)
    setCounts(null)
    setHasLoadedPage1(false)

    try {
      const res = await searchSourcing(args)
      setResults(res.results)
      setScanId(res.scanId)
      setCounts(res.counts)
      refreshScans()
    } catch (err: any) {
      setError(err.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleLoadMore() {
    if (!selection || loadingMore) return
    const args = buildSearchArgs(20)
    if (!args) return
    setLoadingMore(true)
    setError(null)
    try {
      const res = await searchSourcing(args)
      // Dedupe by dataId - the second page sometimes overlaps the first.
      const seen = new Set(results.map((r) => r.dataId))
      const additions = res.results.filter((r) => !seen.has(r.dataId))
      setResults([...results, ...additions])
      setHasLoadedPage1(true)
      refreshScans()
    } catch (err: any) {
      setError(err.message || 'Load more failed')
    } finally {
      setLoadingMore(false)
    }
  }

  // Globe picker callback. The picker hands us either a city or a free
  // point - translate to our internal Selection shape.
  function handleGlobeSelect(s: GlobeSelection) {
    setSelection(s.type === 'city'
      ? { type: 'city', cityKey: s.cityKey, lat: s.lat, lng: s.lng, label: s.label }
      : { type: 'point', lat: s.lat, lng: s.lng, label: s.label })
  }

  // Cities dropdown change handler.
  function handleCityChange(cityKey: string) {
    const c = cities.find(x => x.key === cityKey)
    if (!c) return
    setSelection({ type: 'city', cityKey: c.key, lat: c.lat, lng: c.lng, label: c.label })
  }

  // Map our selection back to the picker's GlobeSelection (so the globe
  // can sync its highlighted marker / camera position when the user
  // changes the dropdown in the Cities tab).
  const globeSelection: GlobeSelection | null = selection
    ? selection.type === 'city' && selection.cityKey
      ? { type: 'city', cityKey: selection.cityKey, lat: selection.lat, lng: selection.lng, label: selection.label }
      : { type: 'point', lat: selection.lat, lng: selection.lng, label: selection.label }
    : null

  async function handleToggleDetails(row: SourcingResult) {
    const id = row.dataId
    if (!id) return

    // Collapse if already expanded with data.
    if (expanded[id] && expanded[id] !== 'loading') {
      setExpanded({ ...expanded, [id]: undefined as any })
      return
    }
    if (expanded[id] === 'loading') return

    setExpanded({ ...expanded, [id]: 'loading' })
    try {
      const res = await getPlaceDetails({ dataId: id })
      setExpanded({ ...expanded, [id]: res.details })
    } catch (err: any) {
      console.warn('[Sourcing] details failed:', err.message)
      setExpanded({ ...expanded, [id]: 'error' })
    }
  }

  async function handlePromote(row: SourcingResult) {
    if (promoting) return
    setPromoting(row.dataId)
    try {
      await promoteToSalesAgent({ result: row, scanId: scanId || undefined })
      // Pre-fill the Email Generation page's URL via the location hash.
      // Pipeline page (now at /email) reads location.hash on mount and
      // prefills the input so the user doesn't have to copy-paste the URL.
      const target = row.website || ''
      navigate(`/email${target ? `#prefill=${encodeURIComponent(target)}` : ''}`)
    } catch (err: any) {
      setError(err.message || 'Promote failed')
    } finally {
      setPromoting(null)
    }
  }

  // Apply client-side filters AFTER we have the results - purely cosmetic
  // so the user can dial in without spending another 5 credits.
  const filtered = useMemo(() => {
    return results.filter((r) => {
      if (onlyWithWebsite && !r.website) return false
      if (minRating > 0 && (r.rating ?? 0) < minRating) return false
      if (minReviews > 0 && (r.reviews ?? 0) < minReviews) return false
      return true
    })
  }, [results, minRating, minReviews, onlyWithWebsite])

  const isGlobeMode = pickerMode === 'globe'

  return (
    // In Globe mode: cancel Main's padding so the globe spans the full
    // content area (sidebar + header still visible). In Cities mode:
    // keep the original constrained centered layout.
    <div className={cn(
      'relative',
      isGlobeMode
        ? '-mx-6 -my-6 md:-mx-8 md:-my-8 min-h-[calc(100vh-3.5rem)]'
        : 'mx-auto max-w-4xl space-y-6'
    )}>
      {/* ─── Globe backdrop (full-bleed) - only in Globe mode ─────────── */}
      {isGlobeMode && (
        <div className="absolute inset-0 z-0">
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                  <IconLoader2 className="h-5 w-5 animate-spin" />
                  Loading globe… (~600KB three.js bundle)
                </div>
              </div>
            }
          >
            <GlobePicker
              fill
              cities={cities.map(c => ({
                key: c.key,
                label: c.label,
                country: c.country,
                lat: c.lat,
                lng: c.lng,
              }))}
              selection={globeSelection}
              onSelect={handleGlobeSelect}
              hintClassName="bottom-6 left-6"
            />
          </Suspense>
        </div>
      )}

      {/* ─── Foreground content - page header + cards ────────────────── */}
      {/* In globe mode this is a flex column with min-h-screen + gap-6 so
          we can use mt-auto on the picker card to pin it to the bottom of
          the viewport in the empty state.

          pointer-events-none on the wrapper + pointer-events-auto on the
          actual visible elements means clicks on EMPTY SPACE (between
          header text and picker card) pass through to the globe canvas
          underneath. Without that, the wrapper would silently catch all
          clicks across the whole viewport even where it's transparent. */}
      <div className={cn(
        isGlobeMode
          ? 'relative z-10 flex flex-col gap-6 min-h-[calc(100vh-3.5rem)] max-w-3xl mx-auto p-6 md:p-8 pointer-events-none'
          : 'space-y-6'
      )}>
      {/* In globe mode the page title moves to the top bar (RouteTitle),
          so we suppress this header entirely - every pixel of globe is
          worth more than a redundant title. Cities mode still shows it. */}
      {!isGlobeMode && (
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Leads</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Source independent car rentals from Google Maps via Scrapingdog. Each search costs 5 credits - chains and non-rentals get filtered out automatically.
          </p>
        </div>
      )}

      {/* ─── Step 1: location picker (Cities or Globe) ─────────────────
          In globe mode the user can collapse this card to a tiny pill
          (rendered in the JSX block below) so it doesn't block the globe.
          mt-auto pins to bottom of viewport when there's leftover space. */}
      {isGlobeMode && pickerCollapsed ? (
        <div className="mt-auto pointer-events-auto flex justify-center bb-card-in">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/40 dark:border-white/15 bg-white/55 dark:bg-white/[0.06] backdrop-blur-xl px-3 py-1.5 shadow-lg shadow-black/10">
            <IconMapPinFilled className="h-3.5 w-3.5 text-foreground/70" />
            <span className="text-xs font-medium">
              {selection?.label || 'No location'}
              {selection?.type === 'point' && (
                <span className="text-[9px] opacity-60 ml-1">(free point)</span>
              )}
            </span>
            <Button size="sm" onClick={handleSearch} disabled={!selection || loading} className="h-7 gap-1 text-xs px-2.5">
              {loading ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconSearch className="h-3 w-3" />}
              Find rentals
            </Button>
            <Button size="icon" variant="ghost" onClick={() => setPickerCollapsed(false)} title="Expand picker" className="h-7 w-7">
              <IconMaximize className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : (
      <Card className={cn(GLASS, 'bb-card-in', 'pointer-events-auto', isGlobeMode && 'mt-auto')}>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <IconCompass className="h-5 w-5" /> Pick a location
              </CardTitle>
              <CardDescription>
                Use the dropdown for the prefilled English-market cities, or spin the globe to free-pick any point on Earth.
              </CardDescription>
            </div>
            {isGlobeMode && (
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setPickerCollapsed(true)}
                title="Minimize picker"
                className="h-7 w-7 shrink-0"
              >
                <IconMinimize className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Tab toggle: Cities vs Globe */}
          <div className="inline-flex rounded-md border border-white/30 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] backdrop-blur-md p-0.5">
            <button
              onClick={() => setPickerMode('cities')}
              className={cn(
                'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors',
                pickerMode === 'cities'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <IconList className="h-3 w-3" /> Cities
            </button>
            <button
              onClick={() => setPickerMode('globe')}
              className={cn(
                'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors',
                pickerMode === 'globe'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <IconWorldLatitude className="h-3 w-3" /> Globe
            </button>
          </div>

          {/* Cities mode - dropdown */}
          {pickerMode === 'cities' && (
            <div className="flex gap-2 flex-wrap items-center">
              <select
                value={selection?.type === 'city' ? selection.cityKey || '' : ''}
                onChange={(e) => handleCityChange(e.target.value)}
                disabled={loading}
                className="h-9 rounded-md border border-input bg-background/70 backdrop-blur px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {cities.length === 0 && <option value="">Loading…</option>}
                {cities.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Globe mode - globe is the backdrop now, not embedded here.
              Show a hint about how to interact with it instead. */}
          {pickerMode === 'globe' && (
            <div className="text-xs text-muted-foreground italic">
              The globe behind covers the whole page - click any city marker, or click anywhere on Earth for a free point.
            </div>
          )}

          {/* Selection summary - always visible across both modes */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-xs text-muted-foreground">Selected:</span>
            {selection ? (
              <Badge variant="secondary" className="gap-1.5">
                <IconMapPinFilled className="h-3 w-3" />
                {selection.label}
                {selection.type === 'point' && (
                  <span className="text-[9px] opacity-70 ml-1">(free point)</span>
                )}
              </Badge>
            ) : (
              <span className="text-xs italic text-muted-foreground">none</span>
            )}
          </div>

          {/* Search button - works regardless of picker mode */}
          <div className="flex gap-2 flex-wrap items-center">
            <Button onClick={handleSearch} disabled={!selection || loading} className="gap-2">
              {loading ? (
                <>
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                  Searching…
                </>
              ) : (
                <>
                  <IconSearch className="h-4 w-4" />
                  Find rentals (5cr)
                </>
              )}
            </Button>
            {results.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleSearch} disabled={loading} className="gap-1">
                <IconRefresh className="h-3 w-3" /> Re-search
              </Button>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{error}</div>
            </div>
          )}

          {counts && (
            <div className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{filtered.length}</span> of <span className="font-semibold text-foreground">{counts.keptCount}</span> rentals
              {' · '}
              <span title="Filtered out as major chains via blocklist">{counts.chainsFiltered} chains filtered</span>
              {' · '}
              <span title="Filtered out because their Google type didn't match a rental category">{counts.nonTargetFiltered} non-rentals filtered</span>
              {' · '}
              <span>{counts.totalRaw} raw results</span>
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* ─── Step 2: results list ───────────────────────────────────────── */}
      {results.length > 0 && (
        <Card className={cn(GLASS, 'bb-card-in', 'pointer-events-auto')} style={{ animationDelay: '80ms' }}>
          <CardHeader>
            <CardTitle className="text-base">Results</CardTitle>
            <CardDescription>
              Click "Get details" to spend 5 more credits on a deeper Places API record. Click "Send to Sales Agent" to seed a company and jump to the Sales Agent flow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Client-side filters */}
            <div className="flex gap-3 flex-wrap text-xs">
              <label className="flex items-center gap-1.5">
                Min rating:
                <select
                  value={minRating}
                  onChange={(e) => setMinRating(Number(e.target.value))}
                  className="h-7 rounded-md border border-input bg-background/70 px-2 text-xs"
                >
                  <option value={0}>any</option>
                  <option value={3}>3.0+</option>
                  <option value={4}>4.0+</option>
                  <option value={4.5}>4.5+</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                Min reviews:
                <select
                  value={minReviews}
                  onChange={(e) => setMinReviews(Number(e.target.value))}
                  className="h-7 rounded-md border border-input bg-background/70 px-2 text-xs"
                >
                  <option value={0}>any</option>
                  <option value={10}>10+</option>
                  <option value={50}>50+</option>
                  <option value={100}>100+</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={onlyWithWebsite}
                  onChange={(e) => setOnlyWithWebsite(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Has website only
              </label>
            </div>

            {filtered.length === 0 && (
              <div className="text-sm text-muted-foreground italic py-4">
                No results match your filters - loosen the rating or reviews threshold.
              </div>
            )}

            <div className="space-y-2">
              {filtered.map((r) => (
                <ResultRow
                  key={r.dataId || r.placeId || r.title}
                  row={r}
                  expanded={expanded[r.dataId]}
                  onToggleDetails={() => handleToggleDetails(r)}
                  onPromote={() => handlePromote(r)}
                  promoting={promoting === r.dataId}
                />
              ))}
            </div>

            {!hasLoadedPage1 && (
              <div className="pt-2">
                <Button variant="outline" size="sm" onClick={handleLoadMore} disabled={loadingMore} className="gap-2">
                  {loadingMore ? (
                    <>
                      <IconLoader2 className="h-3 w-3 animate-spin" />
                      Loading more…
                    </>
                  ) : (
                    <>Load more (page 2 · 5cr)</>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Recent scans footer ──────────────────────────────────────────
          Dismissible: in globe view this card grew tall enough to occlude
          the globe itself. Hidden via the X; a small pill replaces it so
          the user can reopen without leaving the page. Auto-reopens on
          the next successful scan via refreshScans(). */}
      {scans.length > 0 && !scansDismissed && (
        <Card className={cn(GLASS_SUBTLE, 'bb-card-in', 'pointer-events-auto')} style={{ animationDelay: '160ms' }}>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-sm">Recent scans</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 -mr-1 text-muted-foreground hover:text-foreground"
              onClick={() => setScansDismissed(true)}
              title="Hide recent scans"
            >
              <IconX className="h-3.5 w-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <ul className="text-xs text-muted-foreground space-y-1">
              {scans.map((s) => (
                <li key={s.id}>
                  <span className="font-medium text-foreground">{s.city}</span> · {s.keptCount} rentals · page {s.page} ·{' '}
                  <span title={new Date(s.ranAt).toLocaleString()}>{relativeTime(s.ranAt)}</span>
                  {s.chainsFiltered > 0 && (
                    <span className="text-muted-foreground/70"> · filtered {s.chainsFiltered} chains</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {scans.length > 0 && scansDismissed && (
        <div className="flex justify-end pointer-events-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setScansDismissed(false)}
            title="Show recent scans"
          >
            <IconHistory className="h-3.5 w-3.5" />
            Recent scans ({scans.length})
          </Button>
        </div>
      )}
      </div>
    </div>
  )
}

function ResultRow({
  row,
  expanded,
  onToggleDetails,
  onPromote,
  promoting,
}: {
  row: SourcingResult
  expanded: PlaceDetailsTrimmed | 'loading' | 'error' | undefined
  onToggleDetails: () => void
  onPromote: () => void
  promoting: boolean
}) {
  const detailsLoaded = expanded && expanded !== 'loading' && expanded !== 'error'

  return (
    <div className="rounded-lg border border-white/30 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] p-3 backdrop-blur-md">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{row.title || '(unnamed)'}</span>
            {row.rating != null && (
              <Badge variant="secondary" className="gap-1 px-2 py-0 text-[10px]">
                <IconStar className="h-2.5 w-2.5 fill-current" />
                {row.rating.toFixed(1)}
                {row.reviews != null && <span className="text-muted-foreground">({row.reviews})</span>}
              </Badge>
            )}
            {row.primaryType && (
              <span className="text-[10px] text-muted-foreground italic">{row.primaryType}</span>
            )}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {row.address && (
              <div className="flex items-center gap-1.5">
                <IconMapPin className="h-3 w-3 shrink-0" /> {row.address}
              </div>
            )}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {row.phone && (
                <span className="flex items-center gap-1">
                  <IconPhone className="h-3 w-3" /> {row.phone}
                </span>
              )}
              {row.website && (
                <a
                  href={row.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-sky-600 dark:text-sky-400 hover:underline"
                >
                  <IconWorld className="h-3 w-3" /> {row.domain || row.website}
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <Button size="sm" variant="ghost" onClick={onToggleDetails} className="gap-1 h-7 text-xs">
            {expanded === 'loading' ? (
              <IconLoader2 className="h-3 w-3 animate-spin" />
            ) : detailsLoaded ? (
              <IconChevronUp className="h-3 w-3" />
            ) : (
              <IconChevronDown className="h-3 w-3" />
            )}
            {detailsLoaded ? 'Hide details' : expanded === 'loading' ? 'Loading…' : 'Get details (5cr)'}
          </Button>
          <Button
            size="sm"
            onClick={onPromote}
            disabled={promoting || !row.website}
            title={!row.website ? 'No website on this row - Sales Agent needs a URL to classify' : undefined}
            className="gap-1 h-7 text-xs"
          >
            {promoting ? (
              <IconLoader2 className="h-3 w-3 animate-spin" />
            ) : (
              <IconArrowRight className="h-3 w-3" />
            )}
            Send to Sales Agent
          </Button>
        </div>
      </div>

      {expanded === 'error' && (
        <div className="mt-3 text-xs text-destructive">
          Failed to fetch details - try again or skip.
        </div>
      )}

      {detailsLoaded && <DetailsBlock details={expanded as PlaceDetailsTrimmed} />}
    </div>
  )
}

function DetailsBlock({ details }: { details: PlaceDetailsTrimmed }) {
  // Most useful fields for car rentals: rating breakdown + service options.
  // Atmosphere/dining_options/etc. usually come back empty for rentals so
  // we only render extension blocks that have actual content.
  const populatedExtensions = details.extensions.filter(
    (group) => Object.values(group).some((v) => Array.isArray(v) && v.length > 0)
  )

  const totalReviews = details.ratingSummary.reduce((s, r) => s + (r.amount || 0), 0) || 1

  return (
    <div className="mt-3 space-y-3 rounded-md border border-white/30 dark:border-white/10 bg-white/30 dark:bg-white/[0.02] p-3 backdrop-blur-md">
      {details.ratingSummary.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Rating breakdown</div>
          <div className="space-y-1">
            {[5, 4, 3, 2, 1].map((stars) => {
              const entry = details.ratingSummary.find((r) => r.stars === stars)
              const amount = entry?.amount || 0
              const pct = (amount / totalReviews) * 100
              return (
                <div key={stars} className="flex items-center gap-2 text-xs">
                  <span className="w-6 text-muted-foreground">{stars}★</span>
                  <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-amber-400"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-12 text-right text-muted-foreground">{amount}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {Object.keys(details.serviceOptions || {}).length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Service options</div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(details.serviceOptions).map(([key, val]) => (
              <Badge key={key} variant={val ? 'success' : 'outline'} className="text-[10px] capitalize">
                {key.replace(/[_-]/g, ' ')}: {val ? 'yes' : 'no'}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {populatedExtensions.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Other</div>
          <div className="space-y-1.5">
            {populatedExtensions.map((group, i) => {
              const [key, vals] = Object.entries(group)[0] || ['', []]
              if (!Array.isArray(vals) || vals.length === 0) return null
              return (
                <div key={i} className="flex flex-wrap gap-1.5 items-baseline">
                  <span className="text-[10px] text-muted-foreground capitalize">{key.replace(/[_-]/g, ' ')}:</span>
                  {vals.map((v, j) => (
                    <Badge key={j} variant="outline" className="text-[10px]">{v}</Badge>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// "5 minutes ago" / "2 hours ago" / "3 days ago" - small dependency-free
// formatter for the recent scans footer.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}
