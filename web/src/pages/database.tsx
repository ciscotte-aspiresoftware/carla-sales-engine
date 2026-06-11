// Database - read-only inspector for api/data/companies.json.
// Lists every company that's been classified (or seeded from the Sourcing
// page). Each row expands to show the full classification + cached Apollo
// leads. Hits GET /api/companies on mount; pure read, no edits, no delete.

import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconDatabase,
  IconLoader2,
  IconAlertTriangle,
  IconRefresh,
  IconChevronDown,
  IconChevronRight,
  IconCheck,
  IconX,
  IconWorld,
  IconUsers,
  IconArrowRight,
  IconBrandLinkedin,
  IconList,
  IconMap2,
  IconCloudUpload,
} from '@tabler/icons-react'

const CompaniesMap = lazy(() => import('@/components/database/companies-map'))
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrapedContactsBlock } from '@/components/ui/scraped-contacts'
import { CompanyReport } from '@/components/ui/company-report'
import { CompanyLeads } from '@/components/ui/company-leads'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { fetchCompanies, fetchVerticals, fetchPortfolioCompanies, pushCompanyToHubSpot, pushCompaniesToHubSpot, type CompanyRecord, type FetchCompaniesFilters } from '@/lib/api'
import { API_BASE } from '@/lib/api-base'
import { useWorkspace } from '@/context/workspace-context'

// Source on a company record can be either the legacy object shape (used
// when promoted from Sourcing - has .type, .dataId, etc.) or the newer
// string form ("carla:London:demo" - first colon-separated segment is
// the type/icpId). These helpers normalize either into the values the UI
// wants to render so call sites don't have to type-narrow inline.
function sourceType(s: CompanyRecord['source']): string | null {
  if (!s) return null
  if (typeof s === 'string') {
    const idx = s.indexOf(':')
    return idx === -1 ? s : s.slice(0, idx)
  }
  return s.type || null
}
function sourceDataId(s: CompanyRecord['source']): string | null {
  if (!s || typeof s === 'string') return null
  return s.dataId || null
}

// Resolve the verdict the UI should show for a company, matching the row
// badge logic exactly: when an ICP is in scope use THAT ICP's per-ICP
// verdict, otherwise the pinned (latest-written) classification. `matched`
// treats both the sweep shape (is_match) and the legacy paste-classify
// shape (isCarRental) as positive. `classified` gates out seeded-only rows
// (scrapedAt === 0) which are neither qualified nor rejected.
function resolveVerdict(c: CompanyRecord, icpFilter: string): { classified: boolean; matched: boolean } {
  const perIcpCls = icpFilter ? c.classifications?.[icpFilter] : null
  const cls = (perIcpCls || c.classification || {}) as any
  const classified = c.scrapedAt > 0
  const matched = cls.is_match === true || cls.isCarRental === true
  return { classified, matched }
}

export default function DatabasePage() {
  const navigate = useNavigate()
  // Workspace = global "which portfolio company am I scoped to" pick from
  // the sidebar switcher. Used as the default for the page's portfolio
  // filter so switching workspace narrows the Database without an extra
  // click. The user can still override per-page (e.g. set the portfolio
  // filter to "All Companies" while the workspace is NedFox).
  const { workspace } = useWorkspace()
  const [companies, setCompanies] = useState<CompanyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // List vs map view. Map only shows companies with a stored lat/lng;
  // list shows everything (including paste-classified rows that have no
  // coordinate). Selected company in map view drives the side drawer.
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Bulk HubSpot push - set of selected company ids + in-flight + last-result
  // message. Checkbox per row toggles membership; the toolbar button pushes
  // the whole set best-effort and reports a summary.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkPushing, setBulkPushing] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  async function bulkPush() {
    if (bulkPushing || selected.size === 0) return
    setBulkPushing(true); setBulkMsg(null)
    try {
      const res = await pushCompaniesToHubSpot(Array.from(selected))
      const parts = [`Pushed ${res.pushed.length}`]
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped`)
      if (res.errors.length) parts.push(`${res.errors.length} failed`)
      setBulkMsg(parts.join(' · '))
      setSelected(new Set())
      load() // refresh so synced badges render
    } catch (e: any) {
      setBulkMsg(e?.message || 'Bulk push failed')
    } finally {
      setBulkPushing(false)
    }
  }

  // Filter state. Vertical and ICP are independently selectable; match
  // (qualified/rejected) only kicks in when an ICP is picked because match
  // status is per-ICP - without an ICP context there's no canonical
  // "matched/rejected" answer to filter on. Portfolio Company is yet
  // another independent dimension - picking one narrows the ICP options
  // to that company's ICPs and filters the company list to those whose
  // classifications include any of those ICPs.
  const [verticalFilter, setVerticalFilter] = useState<string>('') // '' = all
  const [icpFilter, setIcpFilter] = useState<string>('')           // '' = any
  const [matchFilter, setMatchFilter] = useState<'all' | 'true' | 'false'>('all')
  // Initialize the portfolio filter from the workspace pick on first
  // render, then track changes via the effect below. Reading lazily so
  // refresh-on-workspace doesn't bounce through "" first.
  const [portfolioFilter, setPortfolioFilter] = useState<string>(workspace)
  const [verticals, setVerticals] = useState<string[]>([])
  const [portfolioCompanies, setPortfolioCompanies] = useState<string[]>([])
  const [icps, setIcps] = useState<Array<{ id: string; name: string; vertical: string; portfolioCompany?: string }>>([])

  // Initial load - companies, plus the dropdown sources (verticals + ICPs).
  // Companies refetch whenever filters change; verticals/ICPs are fetched
  // once and don't need to update unless the user adds new ones (the ICP
  // edit page handles that flow elsewhere).
  useEffect(() => {
    fetchVerticals()
      .then((r) => setVerticals(r.verticals))
      .catch(() => { /* non-fatal */ })
    fetchPortfolioCompanies()
      .then((r) => setPortfolioCompanies(r.portfolioCompanies))
      .catch(() => { /* non-fatal */ })
    fetch(`${API_BASE}/api/icps`)
      .then((r) => r.json())
      .then((r) => {
        if (r?.success && Array.isArray(r.icps)) {
          setIcps(r.icps.map((i: any) => ({
            id: i.id,
            name: i.name,
            vertical: i.vertical || '',
            portfolioCompany: i.portfolioCompany || '',
          })))
        }
      })
      .catch(() => { /* non-fatal */ })
  }, [])

  // Mirror the workspace pick into the portfolio filter. Switching
  // workspace from "All Companies" → "NedFox" auto-narrows the page to
  // NedFox; switching back to "All Companies" expands it again. The user
  // can still override per-page after the workspace is set (the explicit
  // override sticks until the next workspace change).
  useEffect(() => {
    setPortfolioFilter(workspace)
  }, [workspace])

  // Refetch on filter change. Server-side filtering keeps the wire small
  // and avoids client doing the work over a potentially large list.
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verticalFilter, icpFilter, portfolioFilter])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Compose only the filters that are actually set so the URL stays
      // clean. Match (qualified/rejected) is applied client-side via
      // visibleCompanies so it can work with OR without an ICP in scope -
      // see resolveVerdict - so it's intentionally not sent to the backend.
      const filters: FetchCompaniesFilters = {}
      if (verticalFilter) filters.vertical = verticalFilter
      if (portfolioFilter) filters.portfolioCompany = portfolioFilter
      if (icpFilter) filters.icp = icpFilter
      const res = await fetchCompanies(filters)
      // Newest first - the file already stores companies in reverse-insert
      // order via unshift(), but sort by updatedAt to be safe in case the
      // user edits the JSON file by hand.
      const sorted = [...res.companies].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      setCompanies(sorted)
    } catch (err: any) {
      setError(err.message || 'Failed to load companies')
    } finally {
      setLoading(false)
    }
  }

  // ICPs available in the picker. Narrowed by both vertical AND portfolio
  // company when either filter is set, so the user can't pick a mismatch
  // (e.g. "vertical=Car Rental, ICP=Dental" or "portfolio=NedFox, ICP=Carla").
  // Both filters are AND-combined.
  const availableIcps = useMemo(() => {
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

  // If either vertical or portfolio changes and the currently-selected
  // ICP doesn't belong to the new scope, clear the ICP filter. Saves
  // the user a clearing click.
  useEffect(() => {
    if (!icpFilter) return
    if (!verticalFilter && !portfolioFilter) return
    const stillValid = availableIcps.some((i) => i.id === icpFilter)
    if (!stillValid) setIcpFilter('')
  }, [verticalFilter, portfolioFilter, availableIcps, icpFilter])

  // Verticals visible in the dropdown - narrow by portfolio company when
  // one is set so workspace=NedFox doesn't show Carla's "Car Rental"
  // as a pickable option. The full list comes from /api/companies/verticals
  // (every vertical present in the company database). When a portfolio
  // filter is active, intersect with the verticals belonging to that
  // company's ICPs so the dropdown only offers things you can actually
  // see in this workspace.
  const visibleVerticals = useMemo(() => {
    if (!portfolioFilter) return verticals
    const p = portfolioFilter.toLowerCase()
    const allowed = new Set(
      icps
        .filter((i) => (i.portfolioCompany || '').toLowerCase() === p)
        .map((i) => (i.vertical || '').toLowerCase())
        .filter(Boolean),
    )
    return verticals.filter((v) => allowed.has(v.toLowerCase()))
  }, [verticals, icps, portfolioFilter])

  // Auto-clear vertical filter if it falls out of scope after a workspace
  // / portfolio change.
  useEffect(() => {
    if (!verticalFilter) return
    if (visibleVerticals.length === 0) return
    if (!visibleVerticals.includes(verticalFilter)) setVerticalFilter('')
  }, [visibleVerticals, verticalFilter])

  function toggleExpand(id: string) {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  function openInSalesAgent(c: CompanyRecord) {
    if (!c.url) return
    navigate(`/email#prefill=${encodeURIComponent(c.url)}`)
  }

  // Quick stats summary so the page has signal even before the user expands
  // any rows. Computed once whenever the list changes.
  const stats = useMemo(() => {
    const total = companies.length
    const classified = companies.filter((c) => c.scrapedAt > 0).length
    const fromSourcing = companies.filter((c) => sourceType(c.source) === 'scrapingdog-maps').length
    const totalLeads = companies.reduce((sum, c) => sum + (c.leads?.length || 0), 0)
    const enrichedLeads = companies.reduce(
      (sum, c) => sum + (c.leads?.filter((l) => l.enriched).length || 0),
      0
    )
    const mapped = companies.filter((c) => c.location && Number.isFinite(c.location.lat)).length
    return { total, classified, fromSourcing, totalLeads, enrichedLeads, mapped }
  }, [companies])

  // Apply the Qualified/Rejected toggle client-side so it works with or
  // without an ICP selected (resolveVerdict picks the per-ICP verdict when
  // an ICP is in scope, else the pinned one). Seeded-only rows (not yet
  // classified) are excluded from both Qualified and Rejected.
  const visibleCompanies = useMemo(() => {
    if (matchFilter === 'all') return companies
    return companies.filter((c) => {
      const { classified, matched } = resolveVerdict(c, icpFilter)
      if (!classified) return false
      return matchFilter === 'true' ? matched : !matched
    })
  }, [companies, matchFilter, icpFilter])

  // Currently-selected company (drawer in map view).
  const selectedCompany = companies.find((c) => c.id === selectedId) || null

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Database</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Read-only view of <code className="rounded bg-muted px-1 py-0.5 text-xs">api/data/companies.json</code> - every company classified or seeded from sourcing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* List ↔ map toggle. Segmented control so the active mode is
              always obvious; map view requires lat/lng on the records,
              which only sweep-found companies have today. */}
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={cn(
                'px-2.5 py-1.5 transition-colors',
                viewMode === 'list'
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-muted-foreground hover:bg-muted/40',
              )}
              title="List view - every company"
            >
              <IconList className="h-3.5 w-3.5 inline mr-1 -mt-0.5" />List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('map')}
              className={cn(
                'px-2.5 py-1.5 border-l border-border transition-colors',
                viewMode === 'map'
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold'
                  : 'text-muted-foreground hover:bg-muted/40',
              )}
              title={`Map view - ${stats.mapped} companies have a coordinate`}
            >
              <IconMap2 className="h-3.5 w-3.5 inline mr-1 -mt-0.5" />Map
            </button>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
            {loading ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconRefresh className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* ─── Stats strip ──────────────────────────────────────────────── */}
      <Card className={cn(GLASS_SUBTLE, 'bb-card-in')}>
        <CardContent className="grid grid-cols-2 md:grid-cols-6 gap-4 py-5">
          <Stat label="Companies" value={stats.total} />
          <Stat label="Classified" value={stats.classified} hint={`${stats.total - stats.classified} seeded only`} />
          <Stat label="Mapped" value={stats.mapped} hint="have lat/lng" />
          <Stat label="From sourcing" value={stats.fromSourcing} />
          <Stat label="Leads stored" value={stats.totalLeads} />
          <Stat label="Apollo-enriched" value={stats.enrichedLeads} />
        </CardContent>
      </Card>

      {/* ─── Filters ──────────────────────────────────────────────────── */}
      {/* Vertical = which industry pool we're looking at. ICP = which
          ICP's verdict to scope the rows to. Match = qualified/rejected
          within the selected ICP (only meaningful with an ICP selected,
          since match status is per-ICP). All filters are server-side. */}
      <Card className={cn(GLASS_SUBTLE, 'bb-card-in')}>
        <CardContent className="py-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Filter</span>
          {portfolioCompanies.length > 0 && (
            <FilterSelect
              label="Portfolio Co."
              value={portfolioFilter}
              onChange={setPortfolioFilter}
              options={[{ value: '', label: 'All companies' }, ...portfolioCompanies.map((p) => ({ value: p, label: p }))]}
            />
          )}
          <FilterSelect
            label="Vertical"
            value={verticalFilter}
            onChange={setVerticalFilter}
            options={[{ value: '', label: 'All verticals' }, ...visibleVerticals.map((v) => ({ value: v, label: v }))]}
          />
          <FilterSelect
            label="ICP"
            value={icpFilter}
            onChange={setIcpFilter}
            options={[
              { value: '', label: 'Any ICP' },
              ...availableIcps.map((i) => ({ value: i.id, label: i.name })),
            ]}
          />
          {/* Qualified/Rejected toggle, always visible. Applied client-side
              (visibleCompanies): when an ICP is selected it scopes to that
              ICP's verdict, otherwise it uses each company's pinned verdict.
              Seeded-only rows are excluded from both buckets. */}
          <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
            {(['all', 'true', 'false'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setMatchFilter(v)}
                className={cn(
                  'px-2.5 py-1 transition-colors border-l first:border-l-0 border-border',
                  matchFilter === v
                    ? v === 'true'
                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold'
                      : v === 'false'
                        ? 'bg-red-500/15 text-red-700 dark:text-red-400 font-semibold'
                        : 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                    : 'text-muted-foreground hover:bg-muted/40',
                )}
              >
                {v === 'all' ? 'All' : v === 'true' ? 'Qualified' : 'Rejected'}
              </button>
            ))}
          </div>
          {(verticalFilter || icpFilter || matchFilter !== 'all' || portfolioFilter) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setVerticalFilter(''); setIcpFilter(''); setMatchFilter('all'); setPortfolioFilter('') }}
              className="h-7 text-xs"
            >
              Clear
            </Button>
          )}
          <div className="flex-1" />
          {bulkMsg && (
            <span className="text-[11px] text-muted-foreground">{bulkMsg}</span>
          )}
          {selected.size > 0 && (
            <Button
              size="sm"
              onClick={bulkPush}
              disabled={bulkPushing}
              className="h-7 text-xs gap-1.5 bg-orange-600 hover:bg-orange-700 text-white"
              title="Push the selected companies (+ their email contacts) to HubSpot"
            >
              {bulkPushing
                ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                : <IconCloudUpload className="h-3.5 w-3.5" />}
              {bulkPushing ? 'Pushing…' : `Push ${selected.size} to HubSpot`}
            </Button>
          )}
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {visibleCompanies.length} result{visibleCompanies.length === 1 ? '' : 's'}
          </span>
        </CardContent>
      </Card>

      {error && (
        <Card className={cn(GLASS, 'border-destructive/30')}>
          <CardContent className="py-4 flex items-start gap-2 text-sm text-destructive">
            <IconAlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>{error}</div>
          </CardContent>
        </Card>
      )}

      {loading && companies.length === 0 && (
        <Card className={cn(GLASS, 'bb-card-in')}>
          <CardContent className="py-10 flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 className="h-5 w-5 animate-spin" />
            Loading…
          </CardContent>
        </Card>
      )}

      {!loading && !error && companies.length === 0 && (
        <Card className={cn(GLASS, 'bb-card-in')}>
          <CardContent className="py-12 flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <IconDatabase className="h-8 w-8 opacity-40" />
            <div className="font-medium text-foreground">No companies stored yet</div>
            <div className="text-xs">Classify a URL on the Sales Agent page or send a sourcing result here.</div>
          </CardContent>
        </Card>
      )}

      {/* No rows match the active filter (but the DB isn't empty). */}
      {!loading && !error && companies.length > 0 && visibleCompanies.length === 0 && (
        <Card className={cn(GLASS, 'bb-card-in')}>
          <CardContent className="py-10 flex flex-col items-center gap-2 text-sm text-muted-foreground">
            <IconDatabase className="h-7 w-7 opacity-40" />
            <div className="font-medium text-foreground">No companies match these filters</div>
            <div className="text-xs">Try clearing the Qualified/Rejected toggle or widening the filters.</div>
          </CardContent>
        </Card>
      )}

      {/* ─── List or map ──────────────────────────────────────────────── */}
      {visibleCompanies.length > 0 && viewMode === 'list' && (
        <div className="space-y-2">
          {visibleCompanies.map((c) => (
            <CompanyRow
              key={c.id}
              company={c}
              icpFilter={icpFilter}
              expanded={expanded.has(c.id)}
              onToggle={() => toggleExpand(c.id)}
              onOpen={() => openInSalesAgent(c)}
              onChanged={load}
              selected={selected.has(c.id)}
              onToggleSelect={() => toggleSelect(c.id)}
            />
          ))}
        </div>
      )}

      {visibleCompanies.length > 0 && viewMode === 'map' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 h-[calc(100vh-340px)] min-h-[500px]">
          <Card className={cn(GLASS, 'overflow-hidden p-0')}>
            <Suspense fallback={<div className="h-full grid place-items-center text-muted-foreground"><IconLoader2 className="h-5 w-5 animate-spin" /></div>}>
              <CompaniesMap
                companies={visibleCompanies}
                selectedId={selectedId}
                onSelect={(c) => setSelectedId(c.id)}
              />
            </Suspense>
          </Card>
          <Card className={GLASS}>
            <CardContent className="p-4 max-h-full overflow-y-auto">
              {selectedCompany ? (
                <MapDetail
                  company={selectedCompany}
                  icpFilter={icpFilter}
                  onClose={() => setSelectedId(null)}
                  onOpen={() => openInSalesAgent(selectedCompany)}
                  onChanged={load}
                />
              ) : (
                <div className="text-center text-muted-foreground py-12">
                  <IconMap2 className="h-8 w-8 mx-auto mb-3 opacity-30" />
                  <p className="text-sm mb-1">Click a marker to inspect.</p>
                  <ul className="text-xs space-y-1.5 mt-4 inline-block text-left">
                    <li className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-emerald-500 shrink-0" />
                      <span>Qualified</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-red-500 shrink-0" />
                      <span>Rejected</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="inline-block w-3 h-3 rounded-full bg-slate-400 shrink-0" />
                      <span>Stub / no website</span>
                    </li>
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// Compact company detail rendered in the right drawer of the map view.
// Header is custom (close button, badge) so the drawer has its own
// affordance, but the body reuses the same CompanyDetails component the
// list view's expanded row uses - that block already renders the full
// classification report (name, tagline, fleet, vehicle types, booking
// platforms, signals, reasoning) plus the cached leads list with names,
// titles, emails, and LinkedIn links. Saves us reimplementing the
// "report card" pattern, and means whichever view the user is in, the
// company information is identical.
function MapDetail({
  company,
  icpFilter,
  onClose,
  onOpen,
  onChanged,
}: {
  company: CompanyRecord
  icpFilter: string
  onClose: () => void
  onOpen: () => void
  onChanged: () => void
}) {
  const cls = (company.classification || {}) as any
  const verdictBadge: 'success' | 'destructive' | 'warning' =
    cls.is_match === true ? 'success' : cls.is_match === false ? 'destructive' : 'warning'
  const verdictText = cls.is_match === true ? 'Qualified' : cls.is_match === false ? 'Rejected' : 'Stub'
  const leadCount = company.leads?.length || 0
  const enrichedCount = company.leads?.filter((l) => l.enriched).length || 0

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{cls.name || cls.title || company.domain}</h3>
          <a
            href={company.url || '#'}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-600 dark:text-sky-400 hover:underline truncate block"
          >
            {company.domain || company.url}
          </a>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <Badge variant={verdictBadge} className="text-[10px]">{verdictText}</Badge>
            {leadCount > 0 && (
              <Badge variant="secondary" className="text-[10px] gap-1">
                <IconUsers className="h-2.5 w-2.5" />
                {leadCount} lead{leadCount === 1 ? '' : 's'}
                {enrichedCount > 0 && ` · ${enrichedCount} enriched`}
              </Badge>
            )}
            {company.location && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {company.location.lat.toFixed(3)}, {company.location.lng.toFixed(3)}
              </span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm shrink-0" aria-label="Close">×</button>
      </div>

      {company.url && (
        <Button size="sm" className="w-full" onClick={onOpen}>
          Open in Sales Agent <IconArrowRight className="h-3.5 w-3.5 ml-1.5" />
        </Button>
      )}

      {/* Reuses the list-view's expanded row body verbatim. CompanyDetails
          renders inside its own CardContent with a top border - we want it
          flush in the drawer, so we wrap in a `-mx-4` to pull the inner
          padding back out and align with the drawer's edge. */}
      <div className="-mx-4 -mb-4">
        <CompanyDetails
          company={company}
          icpId={icpFilter || Object.keys(company.classifications || {})[0] || ''}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}

// Compact label + native <select> pair. Reusable for the vertical and ICP
// filter dropdowns on this page. Native select keeps the bundle small and
// gives the user the platform's familiar keyboard search behavior; the
// surrounding label is just visual scaffolding.
//
// Styling note: native <select> elements don't honor backdrop-blur or
// background-opacity classes the way regular divs do - Chrome/Safari draw
// the closed select with their own widget rendering, and the open dropdown
// popup is OS-themed. Two things matter for dark-mode legibility:
//   1. Explicit background color (the closed select needs a real opaque
//      background, not bg-white/45 - that renders as bright white because
//      the browser composites without our blur layer).
//   2. The `color-scheme` CSS property - telling the browser the element
//      is in dark mode flips the popup, scrollbar, and option-row colors
//      to the dark theme. Without it, Chrome serves a white popup over
//      the dark UI.
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Explicit theme-aware bg + text. `[color-scheme:light_dark]` tells
        // the browser to render the dropdown popup using the OS dark theme
        // when the document is dark - fixes the "all white popup over dark
        // UI" bug.
        className={cn(
          'border border-border rounded-md px-2 py-1 text-xs cursor-pointer',
          'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100',
          '[color-scheme:light_dark]',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function CompanyRow({
  company: c,
  icpFilter,
  expanded,
  onToggle,
  onOpen,
  onChanged,
  selected,
  onToggleSelect,
}: {
  company: CompanyRecord
  icpFilter: string
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
  onChanged: () => void
  selected: boolean
  onToggleSelect: () => void
}) {
  // Per-row HubSpot push - local in-flight + error so rows push independently.
  const [pushing, setPushing] = useState(false)
  const [pushErr, setPushErr] = useState<string | null>(null)
  // Classification picker. `c.classification` is whichever ICP wrote last
  // (auto-fanout means a sibling ICP's stricter verdict often overwrites
  // the primary's, even though both verdicts are still stored under
  // c.classifications[icpId]). When the user has scoped the view to one
  // ICP, show THAT ICP's verdict - otherwise the row can look "rejected"
  // when the filtered ICP actually qualified it.
  const perIcpCls = icpFilter ? c.classifications?.[icpFilter] : null
  const cls = (perIcpCls || c.classification || {}) as any
  const isClassified = c.scrapedAt > 0
  // Quick-access external links for the collapsed row (open without
  // expanding). Website prefers the scraped URL, falls back to the domain.
  // LinkedIn comes from the contacts harvested off the site.
  const websiteUrl = c.url || (c.domain ? `https://${c.domain}` : null)
  const liUrl = c.scrapedContacts?.linkedinCompanyUrls?.[0] || c.scrapedContacts?.linkedinPersonUrls?.[0] || null
  // Sweep-pipeline verdicts only write `{ is_match, reason }`. Legacy
  // paste-classify verdicts wrote the richer `{ isCarRental, isIndependent,
  // confidence, ... }` shape. Treat either as a positive match.
  const isMatch = cls.is_match === true || cls.isCarRental === true
  const isIndependent = cls.isIndependent === true
  const hasConfidence = typeof cls.confidence === 'string' && cls.confidence.length > 0
  const confidenceVariant: 'success' | 'warning' | 'destructive' =
    cls.confidence === 'high' ? 'success' : cls.confidence === 'medium' ? 'warning' : 'destructive'

  return (
    <Card className={cn(GLASS, 'bb-card-in')}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex items-start gap-3 p-4 hover:bg-foreground/[0.03] transition-colors"
      >
        {/* Bulk-select checkbox (clickable span, not an <input>, to avoid
            nesting an interactive element inside the row toggle button). */}
        <span
          role="checkbox"
          aria-checked={selected}
          onClick={(e) => { e.stopPropagation(); onToggleSelect() }}
          className={cn(
            'mt-0.5 h-4 w-4 rounded border flex items-center justify-center cursor-pointer shrink-0 transition-colors',
            selected ? 'bg-orange-600 border-orange-600 text-white' : 'border-border hover:border-orange-500/60',
          )}
          title={selected ? 'Deselect' : 'Select for bulk HubSpot push'}
        >
          {selected && <IconCheck className="h-3 w-3" />}
        </span>
        <div className="mt-0.5 text-muted-foreground">
          {expanded ? <IconChevronDown className="h-4 w-4" /> : <IconChevronRight className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-base">{cls.name || c.domain || '(unnamed)'}</span>
            {isClassified ? (
              <>
                {isMatch ? (
                  <Badge variant="success" className="gap-1 text-[10px]"><IconCheck className="h-2.5 w-2.5" /> Qualified</Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1 text-[10px]"><IconX className="h-2.5 w-2.5" /> Rejected</Badge>
                )}
                {isMatch && isIndependent && (
                  <Badge variant="secondary" className="text-[10px]">Independent</Badge>
                )}
                {hasConfidence && (
                  <Badge variant={confidenceVariant} className="text-[10px]">{cls.confidence} confidence</Badge>
                )}
              </>
            ) : (
              <Badge variant="warning" className="text-[10px]">Seeded - not classified</Badge>
            )}
            {sourceType(c.source) === 'scrapingdog-maps' && (
              <Badge variant="outline" className="text-[10px]">via Sourcing</Badge>
            )}
            {c.hubspotId && (
              <Badge
                variant="secondary"
                className="text-[10px] bg-orange-500/15 text-orange-700 dark:text-orange-300 gap-1"
                title={c.hubspotSyncedAt ? `Last synced ${new Date(c.hubspotSyncedAt).toLocaleString()}` : 'Synced to HubSpot'}
              >
                <IconCloudUpload className="h-2.5 w-2.5" /> HubSpot
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {c.domain && (
              websiteUrl ? (
                <span
                  role="link"
                  title={websiteUrl}
                  onClick={(e) => { e.stopPropagation(); window.open(websiteUrl, '_blank', 'noopener,noreferrer') }}
                  className="flex items-center gap-1 cursor-pointer text-sky-600 dark:text-sky-400 hover:underline"
                >
                  <IconWorld className="h-3 w-3" /> {c.domain}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <IconWorld className="h-3 w-3" /> {c.domain}
                </span>
              )
            )}
            {liUrl && (
              <span
                role="link"
                title={liUrl}
                onClick={(e) => { e.stopPropagation(); window.open(liUrl, '_blank', 'noopener,noreferrer') }}
                className="flex items-center gap-1 cursor-pointer text-sky-600 dark:text-sky-400 hover:underline"
              >
                <IconBrandLinkedin className="h-3 w-3" /> LinkedIn
              </span>
            )}
            {[cls.city, cls.country].filter(Boolean).join(', ') && (
              <span>{[cls.city, cls.country].filter(Boolean).join(', ')}</span>
            )}
            <span className={cn(
              'flex items-center gap-1',
              (c.leads?.length || 0) > 0 && 'font-semibold text-amber-500 dark:text-amber-400',
            )}>
              <IconUsers className="h-3 w-3" /> {c.leads?.length || 0} lead{(c.leads?.length || 0) === 1 ? '' : 's'}
            </span>
            <span title={new Date(c.updatedAt).toLocaleString()}>
              Updated {relativeTime(c.updatedAt)}
            </span>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={async (e) => {
            e.stopPropagation()
            if (pushing) return
            setPushing(true); setPushErr(null)
            try {
              await pushCompanyToHubSpot(c.id)
              onChanged()
            } catch (err: any) {
              setPushErr(err?.message || 'Push failed')
            } finally {
              setPushing(false)
            }
          }}
          disabled={pushing || !c.domain}
          className="gap-1 h-7 text-xs shrink-0"
          title={pushErr || (!c.domain ? 'No domain - cannot dedupe in HubSpot' : 'Push this company + email contacts to HubSpot')}
        >
          {pushing ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconCloudUpload className="h-3 w-3" />}
          {c.hubspotId ? 'Re-push' : 'HubSpot'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          disabled={!c.url}
          className="gap-1 h-7 text-xs shrink-0"
          title={c.url || 'No URL stored'}
        >
          <IconArrowRight className="h-3 w-3" />
          Sales Agent
        </Button>
      </button>

      {expanded && (
        <CompanyDetails
          company={c}
          icpId={icpFilter || Object.keys(c.classifications || {})[0] || ''}
          onChanged={onChanged}
        />
      )}
    </Card>
  )
}

function CompanyDetails({ company: c, icpId, onChanged }: { company: CompanyRecord; icpId: string; onChanged: () => void }) {
  // Show the per-ICP classification when an ICP is in scope (its report +
  // verdict), otherwise the pinned latest. Reports are stored per-ICP.
  const cls = ((icpId && c.classifications?.[icpId]) || c.classification || {}) as any

  return (
    <CardContent className="border-t border-white/20 dark:border-white/10 pt-4 space-y-4 text-xs">
      {/* ─── Classification fields ───────────────────────────────────────
          Vertical-agnostic. These come from Google Maps (Scrapingdog) on
          every sweep regardless of ICP, so they apply to a garden centre,
          a thrift store, or a car rental equally. Vertical-specific detail
          (fleet, plant range, etc.) now lives in the GPT markdown report
          below - never hardcode car-rental fields here again. */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Classification</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <Field label="Name" value={cls.name || cls.title} />
          <Field label="Phone" value={cls.phone} />
          <Field label="Address" value={cls.address} />
          <Field
            label="Rating"
            value={cls.rating != null ? `${cls.rating}${cls.reviews != null ? ` · ${cls.reviews} reviews` : ''}` : ''}
          />
        </div>
        {cls.reason && (
          <div className="mt-2">
            <span className="text-muted-foreground">Verdict: </span>
            <span className="font-medium">{cls.reason}</span>
          </div>
        )}
        {cls.signals && cls.signals.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Signals</div>
            <ul className="list-disc list-inside space-y-0.5">
              {cls.signals.map((s: string, i: number) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {/* Verbatim quotes pulled by the classifier in the same GPT call. */}
        {cls.key_quotes && cls.key_quotes.length > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
              <span>From the website</span>
              <span className="text-emerald-600 dark:text-emerald-400 normal-case tracking-normal text-[10px]" title="Verbatim - taken directly from the scraped page">✓ verbatim</span>
            </div>
            <ul className="space-y-1">
              {cls.key_quotes.map((q: string, i: number) => (
                <li key={i} className="border-l-2 border-sky-500/40 pl-2 italic leading-snug">
                  <span className="opacity-50 mr-0.5">&ldquo;</span>{q}<span className="opacity-50 ml-0.5">&rdquo;</span>
                </li>
              ))}
            </ul>
            {cls.sourceUrl && (
              <a
                href={cls.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[10px] text-sky-600 dark:text-sky-400 hover:underline mt-1"
              >
                Source →
              </a>
            )}
          </div>
        )}
        {cls.reasoning && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Classifier reasoning</div>
            <div className="text-muted-foreground italic">{cls.reasoning}</div>
          </div>
        )}
      </div>

      {/* ─── Scraped contacts ─────────────────────────────────────────── */}
      <ScrapedContactsBlock contacts={c.scrapedContacts} />

      {/* ─── GPT markdown report ──────────────────────────────────────── */}
      <CompanyReport company={c} icpId={icpId} onChanged={onChanged} />

      {/* ─── Cached leads ─────────────────────────────────────────────── */}
      <CompanyLeads leads={c.leads} />

      {/* ─── Source breadcrumb ───────────────────────────────────────── */}
      {c.source && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Source</div>
          <div className="text-muted-foreground">
            {sourceType(c.source) === 'scrapingdog-maps' ? 'Promoted from Google Maps sourcing' : sourceType(c.source)}
            {sourceDataId(c.source) && <span className="ml-2 font-mono text-[10px]">data_id={sourceDataId(c.source)!.slice(0, 24)}…</span>}
          </div>
        </div>
      )}

      {/* ─── Raw URL ────────────────────────────────────────────────── */}
      {c.url && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">URL</div>
          <a
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-600 dark:text-sky-400 hover:underline break-all"
          >
            {c.url}
          </a>
        </div>
      )}
    </CardContent>
  )
}

function Field({ label, value }: { label: string; value: string | undefined | null }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium">{value || '-'}</span>
    </div>
  )
}

function relativeTime(ts: number | undefined): string {
  if (!ts) return 'unknown'
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
