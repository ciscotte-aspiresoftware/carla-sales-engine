// /accounts - sales-rep review of pre-classified companies.
//
// Coverage classifies companies via GPT prompts. That gives us a
// machine-generated "qualified" or "rejected" verdict - useful as a
// pre-filter, but not authoritative. The sales rep is the final judge:
// they look at each pre-qualified account and decide to confirm (worth
// pursuing) or reject (with a reason). This page is where that work
// happens.
//
// Three lanes per ICP:
//   Pending   - classifier said qualified, rep hasn't reviewed yet
//   Confirmed - rep approved → moves into Sales Agent / outreach
//   Rejected  - rep declined with a reason → out of the pipeline
//
// Reviews are per-ICP. The same company can be Confirmed by NedFox-Garden
// and Pending under NedFox-Thrift - different ICPs have different bars.
// This is the same orthogonality we have for classifications themselves.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrapedContactsBlock } from '@/components/ui/scraped-contacts'
import { CompanyReport } from '@/components/ui/company-report'
import { CompanyLeads } from '@/components/ui/company-leads'
import { cn } from '@/lib/utils'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import {
  IconLoader2,
  IconRefresh,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconClock,
  IconChevronDown,
  IconChevronUp,
  IconRotateClockwise,
  IconAlertCircle,
  IconMail,
  IconMailForward,
  IconCloudDownload,
  IconCloudUpload,
} from '@tabler/icons-react'
import {
  fetchCompanies,
  submitReview,
  clearReview,
  recoverPlaceDetails,
  pushCompanyToHubSpot,
  pushCompaniesToHubSpot,
  enrichLeadsBulk,
  type CompanyRecord,
  type Review,
  type Classification,
  type Lead,
} from '@/lib/api'
import { ToastContainer, addToast } from '@/components/ui/toast'
import { usePhoneReveal } from '@/hooks/use-phone-reveal'
import { useWorkspace } from '@/context/workspace-context'
import { useAccountsCount } from '@/context/accounts-count-context'
import { API_BASE } from '@/lib/api-base'

const API = API_BASE

interface IcpSummary {
  id: string
  name: string
  vertical: string
  portfolioCompany?: string
}

// Pre-canned reasons for rejecting an account. Match Valsource's "Not
// Software / Too Small / etc." pattern - gives sales reps a fast pick
// without typing every time, and aggregates into clean reject-reason
// analytics later. Free-text note still appears alongside for nuance.
const REJECT_REASONS = [
  { value: 'not-actually-this-vertical', label: "Not actually this vertical" },
  { value: 'too-small', label: 'Too small / hobbyist' },
  { value: 'too-large', label: 'Too large / national chain' },
  { value: 'wrong-geography', label: 'Wrong geography' },
  { value: 'already-customer', label: 'Already a customer of competitor' },
  { value: 'closed-or-dormant', label: 'Closed / dormant / out of business' },
  { value: 'pure-ecommerce', label: 'Pure e-commerce, no physical store' },
  { value: 'wrong-business-model', label: 'Wrong business model (e.g. franchise)' },
  { value: 'duplicate', label: 'Duplicate / already in our pipeline' },
  { value: 'other', label: 'Other (see note)' },
] as const

type LaneKey = 'pending' | 'confirmed' | 'rejected' | 'needs-check'

// Build a Google Maps deep link for a company we couldn't scrape (no
// website). Prefers the exact place_id when we captured one, else falls
// back to a name + address search.
function googleMapsUrl(name?: string | null, address?: string | null, placeId?: string | null, coords?: { lat?: number; lng?: number } | null): string {
  // Falls back to GPS coordinates when neither name nor address are
  // populated - happens on "Needs check" stubs where Scrapingdog's
  // initial search returned just a pin. Without this, the link's query
  // string would be empty and Google Maps just opens to the world map.
  if (placeId) {
    const q = encodeURIComponent([name, address].filter(Boolean).join(' ') || (name || ''))
    return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${encodeURIComponent(placeId)}`
  }
  const nameQ = [name, address].filter(Boolean).join(' ')
  if (nameQ) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(nameQ)}`
  if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
    return `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`
  }
  return `https://www.google.com/maps/search/?api=1&query=`
}

export default function AccountsPage() {
  // Workspace scoping - narrows the ICP chips to just the active workspace's
  // ICPs. "All Companies" shows every ICP.
  const { workspace } = useWorkspace()
  // Sidebar's pending-pill count. Called after every confirm/reject/undo
  // so the pill updates instantly instead of waiting for the 60-s poll.
  const { refresh: refreshSidebarCount } = useAccountsCount()
  const navigate = useNavigate()

  // Send the rep into Email Generation pre-loaded with this account.
  // Query params (not hash) because we're passing structured state, not
  // free-form text - the pipeline page reads them on mount, fetches the
  // company, populates the existing classification, and auto-progresses
  // to lead generation (skipping the URL→Classify step entirely).
  const sendToSalesAgent = (company: CompanyRecord, icpId: string) => {
    const params = new URLSearchParams({ companyId: company.id, icp: icpId })
    navigate(`/email?${params.toString()}`)
  }

  // Drop into the Sequences page with this company + ICP pre-selected so
  // the rep can kick off a multi-step sequence run. The Sequences page
  // detects these params on mount and opens its "New run" dialog with the
  // company snapshot already loaded - no need to retype anything.
  const startSequence = (company: CompanyRecord, icpId: string) => {
    const params = new URLSearchParams({ startCompany: company.id, startIcp: icpId })
    navigate(`/sequences?${params.toString()}`)
  }

  const [icps, setIcps] = useState<IcpSummary[]>([])
  const [icpsLoading, setIcpsLoading] = useState(true)
  const [activeIcp, setActiveIcp] = useState<string>('')   // '' = no ICP picked yet
  const [lane, setLane] = useState<LaneKey>('pending')
  // Page-level portfolio filter. Defaults to the global workspace pick
  // (so switching workspace from the sidebar narrows this page) but the
  // user can override on the page itself - handy when M&A wants to view
  // a different company's accounts while staying in their workspace.
  const [portfolioFilter, setPortfolioFilter] = useState<string>(workspace)
  const [companies, setCompanies] = useState<CompanyRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Counts per lane for the active ICP - fetched in parallel so the tab
  // badges always reflect the truth without re-pulling every lane on lane
  // change.
  const [counts, setCounts] = useState<Record<LaneKey, number>>({ pending: 0, confirmed: 0, rejected: 0, 'needs-check': 0 })

  // Bulk HubSpot export - set of selected company ids + in-flight + last result.
  // Same pattern as the Database page; reuses pushCompaniesToHubSpot.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkPushing, setBulkPushing] = useState(false)
  const [bulkMsg, setBulkMsg] = useState<string | null>(null)
  // Shared async phone-reveal (initiate + poll for the webhook). One instance
  // serves every card; keyed by companyId:apolloId internally.
  const phone = usePhoneReveal()

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
      refresh() // refresh so synced badges render
    } catch (e: any) {
      setBulkMsg(e?.message || 'Bulk push failed')
    } finally {
      setBulkPushing(false)
    }
  }

  // Splice an updated lead (from email/phone reveal) back into the in-memory
  // company so the card re-renders without a full refetch.
  const patchLead = (companyId: string, updated: Lead) => {
    setCompanies((prev) => prev.map((c) => {
      if (c.id !== companyId || !Array.isArray(c.leads)) return c
      return { ...c, leads: c.leads.map((l) => (l.apolloId && l.apolloId === updated.apolloId ? { ...l, ...updated } : l)) }
    }))
  }

  // Fetch ICP list. We use the trimmed listing so the chip row stays
  // light; we'll fetch full classification details per company below.
  useEffect(() => {
    let cancelled = false
    setIcpsLoading(true)
    fetch(`${API}/api/grid/icps`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d?.success) return
        setIcps(d.icps)
      })
      .catch((e) => setError(e.message))
      .finally(() => { if (!cancelled) setIcpsLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Mirror the global workspace pick into the page-level filter so a
  // workspace switch from the sidebar updates the page immediately. The
  // user's per-page override sticks until the next workspace change.
  useEffect(() => {
    setPortfolioFilter(workspace)
  }, [workspace])

  // Distinct portfolio companies present across the loaded ICPs. Powers
  // the Company dropdown options.
  const availablePortfolioCompanies = useMemo(() => {
    const set = new Set<string>()
    for (const i of icps) if (i.portfolioCompany) set.add(i.portfolioCompany)
    return Array.from(set).sort()
  }, [icps])

  // Narrow chip options to the picked portfolio company (which defaults
  // to the workspace). When portfolioFilter is empty, all ICPs across
  // every company show as chips.
  const visibleIcps = useMemo(() => {
    if (!portfolioFilter) return icps
    const w = portfolioFilter.toLowerCase()
    return icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, portfolioFilter])

  // If active ICP isn't in scope (workspace switched), default to the
  // first visible one. Falls back to empty string when the workspace has
  // no ICPs - the page shows an empty-state CTA in that case.
  useEffect(() => {
    if (visibleIcps.length === 0) { setActiveIcp(''); return }
    if (!activeIcp || !visibleIcps.some((i) => i.id === activeIcp)) {
      setActiveIcp(visibleIcps[0].id)
    }
  }, [visibleIcps, activeIcp])

  // Refetch list whenever the active ICP or lane changes. We also refresh
  // the per-lane counts so the tab badges stay accurate as reviews come
  // in. Done with three parallel fetches because the lanes are exclusive.
  const refresh = async () => {
    if (!activeIcp) { setCompanies([]); setCounts({ pending: 0, confirmed: 0, rejected: 0, 'needs-check': 0 }); return }
    setLoading(true)
    setError(null)
    try {
      const [list, pendingList, confirmedList, rejectedList, needsCheckList] = await Promise.all([
        fetchCompanies({ icp: activeIcp, reviewStatus: lane }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'pending' }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'confirmed' }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'rejected' }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'needs-check' }),
      ])
      setCompanies(list.companies)
      setCounts({
        pending: pendingList.companies.length,
        confirmed: confirmedList.companies.length,
        rejected: rejectedList.companies.length,
        'needs-check': needsCheckList.companies.length,
      })
    } catch (e: any) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // Clear any bulk selection when the lane/ICP changes — selected ids from
    // the previous view aren't visible anymore and shouldn't be pushed.
    setSelected(new Set())
    setBulkMsg(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIcp, lane])

  // Optimistic update on submit: stamp the review onto the in-memory
  // record before the server confirms. Falls back to a refresh on error
  // so the user doesn't end up with a ghost decision.
  const handleReview = async (companyId: string, decision: 'confirmed' | 'rejected', reason?: string, note?: string) => {
    try {
      await submitReview(companyId, activeIcp, { decision, reason, note })
      // Remove from the current lane (it moved to confirmed/rejected) and
      // bump counts. Reload counts on next tick to stay accurate without
      // a full reload.
      setCompanies((prev) => prev.filter((c) => c.id !== companyId))
      setCounts((prev) => ({
        ...prev,
        [lane]: Math.max(0, prev[lane] - 1),
        [decision]: prev[decision] + 1,
      }))
      // Tell the sidebar pill to recount - it'll drop by 1 when reviewing
      // a pending item, stay flat for confirmed→rejected toggles, etc.
      // Fire-and-forget so the action feels instant.
      refreshSidebarCount()
    } catch (e: any) {
      setError(e.message || 'Review failed')
      refresh()
    }
  }
  const handleUndo = async (companyId: string) => {
    const company = companies.find((c) => c.id === companyId)
    const prevDecision = company?.reviews?.[activeIcp]?.decision
    // Undo restores to the lane the company came FROM: a null-verdict company
    // (no website / scrape error) goes back to Needs check, everything else
    // to Pending.
    const cls = company?.classifications?.[activeIcp]
    const backLane: LaneKey = cls && cls.is_match !== true && cls.is_match !== false ? 'needs-check' : 'pending'
    try {
      await clearReview(companyId, activeIcp)
      setCompanies((prev) => prev.filter((c) => c.id !== companyId))
      setCounts((prev) => ({
        ...prev,
        [lane]: Math.max(0, prev[lane] - 1),
        [backLane]: prev[backLane] + 1,
        // Decrement whichever lane we were in if we know it
        ...(prevDecision ? { [prevDecision]: Math.max(0, prev[prevDecision] - 1) } : {}),
      }))
      // Undo moves an item back to Pending, so the sidebar pill should
      // tick up. Same fire-and-forget refresh.
      refreshSidebarCount()
    } catch (e: any) {
      setError(e.message || 'Undo failed')
      refresh()
    }
  }

  const activeIcpMeta = visibleIcps.find((i) => i.id === activeIcp)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className={`${GLASS} px-4 py-3 flex items-center gap-3`}>
        <IconCircleCheck className="h-4 w-4 text-emerald-500" />
        <span className="text-sm font-semibold">Accounts</span>
        <span className="text-xs text-muted-foreground">
          {workspace
            ? <>Reviewing pre-qualified leads for <span className="font-medium text-foreground">{workspace}</span></>
            : 'Reviewing pre-qualified leads across all portfolio companies'}
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading || !activeIcp}>
          <IconRefresh className={cn('h-3 w-3 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <IconAlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Company dropdown - page-level scope. Defaults to the workspace
          pick from the sidebar; the user can override here without leaving
          the workspace (handy when M&A wants to peek at another portfolio
          company's accounts while staying logged in as their own team). */}
      {!icpsLoading && availablePortfolioCompanies.length > 0 && (
        <div className={`${GLASS_SUBTLE} px-3 py-2 flex items-center gap-2`}>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Company</span>
          <select
            value={portfolioFilter}
            onChange={(e) => setPortfolioFilter(e.target.value)}
            className="text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
          >
            <option value="">All companies</option>
            {availablePortfolioCompanies.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          {workspace && portfolioFilter !== workspace && (
            <button
              type="button"
              onClick={() => setPortfolioFilter(workspace)}
              className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline ml-1"
              title={`Reset to your workspace (${workspace})`}
            >
              ↻ reset to {workspace}
            </button>
          )}
        </div>
      )}

      {/* ICP chip row - pick which ICP's accounts to review. Hidden when
          there are no ICPs in scope (the empty-state below covers that). */}
      {icpsLoading ? (
        <div className={`${GLASS_SUBTLE} px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground`}>
          <IconLoader2 className="h-3 w-3 animate-spin" />
          Loading ICPs…
        </div>
      ) : visibleIcps.length === 0 ? (
        <Card className={GLASS}>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {portfolioFilter
              ? <>No ICPs yet for <span className="font-semibold">{portfolioFilter}</span>. Create one on the ICPs page to start qualifying leads here.</>
              : <>No ICPs defined. Create one on the ICPs page first.</>}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className={`${GLASS_SUBTLE} px-3 py-2.5 flex items-center gap-2 flex-wrap`}>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">ICP</span>
            {visibleIcps.map((i) => (
              <button
                key={i.id}
                type="button"
                onClick={() => setActiveIcp(i.id)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs border transition-colors',
                  activeIcp === i.id
                    ? 'bg-sky-500/20 border-sky-500/60 text-sky-700 dark:text-sky-300 font-semibold'
                    : 'border-border text-muted-foreground hover:bg-muted/40',
                )}
                title={`${i.name} - ${i.vertical}`}
              >
                {i.name}
              </button>
            ))}
          </div>

          {/* Lane tabs - Pending / Confirmed / Rejected. Counts come from
              parallel fetches above so they update without re-clicking. */}
          <div className={`${GLASS_SUBTLE} px-3 py-2 flex items-center gap-2`}>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Status</span>
            <LaneTab label="Pending" icon={<IconClock className="h-3 w-3" />} count={counts.pending} active={lane === 'pending'} onPick={() => setLane('pending')} color="amber" />
            <LaneTab label="Confirmed" icon={<IconCircleCheck className="h-3 w-3" />} count={counts.confirmed} active={lane === 'confirmed'} onPick={() => setLane('confirmed')} color="emerald" />
            <LaneTab label="Rejected" icon={<IconCircleX className="h-3 w-3" />} count={counts.rejected} active={lane === 'rejected'} onPick={() => setLane('rejected')} color="red" />
            <LaneTab label="Needs check" icon={<IconAlertCircle className="h-3 w-3" />} count={counts['needs-check']} active={lane === 'needs-check'} onPick={() => setLane('needs-check')} color="orange" urgent={counts['needs-check'] > 0} />
            {activeIcpMeta && (
              <span className="ml-auto text-[11px] text-muted-foreground italic">
                {activeIcpMeta.vertical} · {activeIcpMeta.portfolioCompany || '-'}
              </span>
            )}
          </div>

          {/* Bulk HubSpot export toolbar. Only on the qualified lanes
              (pending/confirmed). Companies become selectable once they have at
              least one enriched/email-bearing contact (the per-card checkbox).
              Reuses the same bulk endpoint the Database page uses. */}
          {(lane === 'pending' || lane === 'confirmed') && (selected.size > 0 || bulkMsg) && (
            <div className={`${GLASS_SUBTLE} px-3 py-2 flex items-center gap-2`}>
              <span className="text-[11px] text-muted-foreground">
                {selected.size > 0 ? `${selected.size} selected` : ''}
              </span>
              {bulkMsg && <span className="text-[11px] text-muted-foreground italic">{bulkMsg}</span>}
              <div className="flex-1" />
              {selected.size > 0 && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={bulkPushing}>
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    className="bg-orange-600 hover:bg-orange-700 text-white"
                    onClick={bulkPush}
                    disabled={bulkPushing}
                    title="Push the selected companies (+ their email contacts) to HubSpot. Dedupes by domain/email; re-push updates in place."
                  >
                    {bulkPushing
                      ? <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      : <IconCloudUpload className="h-3.5 w-3.5 mr-1.5" />}
                    {bulkPushing ? 'Pushing…' : `Push ${selected.size} to HubSpot`}
                  </Button>
                </>
              )}
            </div>
          )}

          {/* List */}
          {loading && companies.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-12 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                <IconLoader2 className="h-5 w-5 animate-spin" />
                Loading…
              </CardContent>
            </Card>
          ) : companies.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {lane === 'pending'
                  ? <>Nothing to review. Run a Coverage sweep for this ICP to surface candidates.</>
                  : lane === 'confirmed'
                    ? <>No confirmed accounts yet. Review pending ones first.</>
                    : lane === 'needs-check'
                      ? <>Nothing needs a manual check - every swept company had a usable website.</>
                      : <>No rejected accounts yet.</>}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2.5">
              {companies.map((c) => (
                <AccountCard
                  key={c.id}
                  company={c}
                  icpId={activeIcp}
                  lane={lane}
                  onConfirm={() => handleReview(c.id, 'confirmed')}
                  onReject={(reason, note) => handleReview(c.id, 'rejected', reason, note)}
                  onUndo={() => handleUndo(c.id)}
                  onSendToSalesAgent={() => sendToSalesAgent(c, activeIcp)}
                  onStartSequence={() => startSequence(c, activeIcp)}
                  onChanged={refresh}
                  selectedForPush={selected.has(c.id)}
                  onTogglePush={() => toggleSelect(c.id)}
                  phone={phone}
                  patchLead={patchLead}
                />
              ))}
            </div>
          )}
        </>
      )}
      <ToastContainer />
    </div>
  )
}

function LaneTab({
  label,
  icon,
  count,
  active,
  color,
  onPick,
  urgent = false,
}: {
  label: string
  icon: React.ReactNode
  count: number
  active: boolean
  color: 'amber' | 'emerald' | 'red' | 'orange'
  onPick: () => void
  // When true (used by Needs check when there are items waiting), the tab
  // overrides its base color to red AND bumps the count to a bigger, bolder
  // glyph - the goal is the rep can't miss that there's something to action.
  urgent?: boolean
}) {
  const accents = {
    amber:   'bg-amber-500/20 border-amber-500/60 text-amber-700 dark:text-amber-300',
    emerald: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-700 dark:text-emerald-300',
    red:     'bg-red-500/20 border-red-500/60 text-red-700 dark:text-red-300',
    orange:  'bg-orange-500/20 border-orange-500/60 text-orange-700 dark:text-orange-300',
  }
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors',
        urgent
          ? cn(accents.red, 'font-semibold')
          : active
            ? `${accents[color]} font-semibold`
            : 'border-border text-muted-foreground hover:bg-muted/40',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className={cn(
        'tabular-nums',
        urgent
          ? 'text-sm font-bold text-red-700 dark:text-red-300 px-1.5 py-px rounded-md bg-red-500/30'
          : 'opacity-80',
      )}>{count}</span>
    </button>
  )
}

// Per-account card. Shows the classifier verdict + rich fields (location,
// rating, signals from the report) and the action row. Click "Expand" to
// see the full classification block inline.
function AccountCard({
  company,
  icpId,
  lane,
  onConfirm,
  onReject,
  onUndo,
  onSendToSalesAgent,
  onStartSequence,
  onChanged,
  selectedForPush,
  onTogglePush,
  phone,
  patchLead,
}: {
  company: CompanyRecord
  icpId: string
  lane: LaneKey
  onConfirm: () => void
  onReject: (reason: string, note: string) => void
  onUndo: () => void
  onSendToSalesAgent: () => void
  onStartSequence: () => void
  onChanged: () => void
  selectedForPush: boolean
  onTogglePush: () => void
  phone: ReturnType<typeof usePhoneReveal>
  patchLead: (companyId: string, updated: Lead) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  // "Needs check" recover button - per-card loading + error state so two
  // adjacent cards can run concurrently without their spinners aliasing.
  const [recovering, setRecovering] = useState(false)
  const [recoverErr, setRecoverErr] = useState<string | null>(null)
  // HubSpot push - per-card loading + error so two cards push independently.
  const [pushing, setPushing] = useState(false)
  const [pushErr, setPushErr] = useState<string | null>(null)
  // Per-person email-reveal selection + in-flight state (this card's leads).
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set())
  const [revealingEmails, setRevealingEmails] = useState(false)
  const [emailMsg, setEmailMsg] = useState<string | null>(null)
  const cls = (company.classifications?.[icpId] || company.classification || {}) as Classification & { city?: string; country?: string; rating?: number; reviews?: number; title?: string; phone?: string; address?: string; signals?: string[]; fleetSizeHint?: string; fleetVehicleTypes?: string[]; bookingPlatformHints?: string[]; tagline?: string }
  const review: Review | undefined = company.reviews?.[icpId]

  const leads = company.leads || []
  const hasLeads = leads.length > 0
  // A company is push-eligible once at least one contact has a revealed email
  // (or is marked enriched). The bulk HubSpot push only sends email-bearing
  // contacts, so selecting a company with none would push the company shell
  // with zero contacts — gate it out here (the backend doesn't enforce this).
  const hasEnrichedLead = leads.some((l) => !!l.email || l.enriched)
  const pushSelectable = (lane === 'pending' || lane === 'confirmed') && hasEnrichedLead

  const toggleLead = (apolloId: string) => {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev)
      if (next.has(apolloId)) next.delete(apolloId); else next.add(apolloId)
      return next
    })
  }

  // Bulk-reveal email + LinkedIn for the selected people on this company.
  const handleRevealEmails = async () => {
    if (revealingEmails || selectedLeadIds.size === 0) return
    setRevealingEmails(true); setEmailMsg(null)
    try {
      const res = await enrichLeadsBulk(company.id, Array.from(selectedLeadIds))
      for (const r of res.results) {
        if (r.lead) patchLead(company.id, r.lead)
      }
      const parts = [`${res.enriched} revealed`]
      if (res.skipped) parts.push(`${res.skipped} already done`)
      if (res.errors) parts.push(`${res.errors} failed`)
      if (res.warnings.length) parts.push(res.warnings[0])
      setEmailMsg(parts.join(' · '))
      setSelectedLeadIds(new Set())
    } catch (e: any) {
      setEmailMsg(e?.message || 'Email reveal failed')
    } finally {
      setRevealingEmails(false)
    }
  }

  return (
    <Card className={cn(GLASS, lane === 'rejected' && 'opacity-80')}>
      <CardContent className="p-4 space-y-2.5">
        {/* Top row - name + status + outbound link */}
        <div className="flex items-start gap-2">
          {/* Bulk-HubSpot selection checkbox. Shown on the qualified lanes once
              the company has at least one email-bearing contact (otherwise the
              push would create a contactless company shell). */}
          {pushSelectable && (
            <input
              type="checkbox"
              checked={selectedForPush}
              onChange={onTogglePush}
              className="mt-1 h-3.5 w-3.5 accent-orange-500 shrink-0"
              title="Select for bulk HubSpot export"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <h3 className="text-sm font-semibold truncate">{cls.title || (cls as any).name || company.domain}</h3>
              {lane === 'pending' && (
                <Badge variant="warning" className="text-[10px]">Pending review</Badge>
              )}
              {lane === 'confirmed' && (
                <Badge variant="success" className="text-[10px]">Confirmed</Badge>
              )}
              {lane === 'rejected' && (
                <Badge variant="destructive" className="text-[10px]">Rejected</Badge>
              )}
              {lane === 'needs-check' && (
                <Badge variant="warning" className="text-[10px] bg-orange-500/15 text-orange-700 dark:text-orange-300">Needs manual check</Badge>
              )}
              {company.vertical && (
                <Badge variant="secondary" className="text-[10px]">{company.vertical}</Badge>
              )}
              {company.hubspotId && (
                <Badge variant="secondary" className="text-[10px] bg-orange-500/15 text-orange-700 dark:text-orange-300" title={company.hubspotSyncedAt ? `Last synced ${new Date(company.hubspotSyncedAt).toLocaleString()}` : 'Synced to HubSpot'}>
                  <IconCloudUpload className="h-2.5 w-2.5 mr-1" /> HubSpot
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              {company.url ? (
                <a
                  href={company.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-600 dark:text-sky-400 hover:underline inline-flex items-center gap-1"
                >
                  {company.domain}
                  <IconExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : (
                <span className="font-mono">{company.domain || '(no website)'}</span>
              )}
              {[cls.city, cls.country].filter(Boolean).length > 0 && (
                <span>· {[cls.city, cls.country].filter(Boolean).join(', ')}</span>
              )}
              {cls.rating && (
                <span>· ★{cls.rating} ({cls.reviews || 0})</span>
              )}
            </div>
          </div>
        </div>

        {/* Classifier verdict - the GPT one-liner that landed this in the
            pending lane. The reason is what the rep should sanity-check. For
            needs-check there's no GPT verdict (no website / scrape failed) so
            it's shown as a warning, not a green pass. */}
        {cls.reason && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            {lane === 'needs-check' ? (
              <span className="text-orange-600 dark:text-orange-400 font-semibold mr-1">⚠ Needs check:</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold mr-1">✓ Classifier:</span>
            )}
            {cls.reason}
          </div>
        )}

        {/* No-website / unscrapeable company → surface the Google Maps facts
            we DO have so a human can look it up and decide. When the
            initial Scrapingdog search returned a stub (no title/phone/
            address either - just GPS), the Recover button below spends
            5-10 credits to refetch the full place record. */}
        {lane === 'needs-check' && (
          <div className="text-xs rounded-md border border-orange-500/30 bg-orange-500/5 px-2.5 py-2 space-y-1.5">
            <div className="font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
              <IconAlertCircle className="h-3 w-3" /> Look this one up manually
            </div>
            {cls.phone && <div><span className="opacity-70">Phone:</span> {cls.phone}</div>}
            {cls.address && <div><span className="opacity-70">Address:</span> {cls.address}</div>}
            {/* GPS fallback - when Scrapingdog didn't return phone/address
                but we did capture coordinates from gps_coordinates, show
                them so the rep has something to feed Google Maps. */}
            {!cls.phone && !cls.address && company.location?.lat != null && company.location?.lng != null && (
              <div className="text-muted-foreground">
                <span className="opacity-70">Coords:</span>{' '}
                <span className="font-mono">{company.location.lat.toFixed(5)}, {company.location.lng.toFixed(5)}</span>
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap pt-0.5">
              <a
                href={googleMapsUrl(cls.title || (cls as any).name || company.domain, cls.address, (cls as any).placeId, company.location)}
                target="_blank"
                rel="noreferrer"
                className="text-sky-600 dark:text-sky-400 hover:underline inline-flex items-center gap-1"
              >
                <IconExternalLink className="h-3 w-3" /> Open in Google Maps
              </a>
              {/* Recover button - spends Scrapingdog credits to refetch
                  the full place record (title/phone/address/rating). The
                  base cost is 5 credits when the row has a stored
                  dataId/placeId, 10 when neither and the backend has to
                  lat/lng re-search to find one. The cost shows up in the
                  Costs page after the call. Disabled if the row already
                  has title - no point re-paying for what we have. */}
              {!cls.title && (
                <button
                  type="button"
                  onClick={async () => {
                    if (recovering) return
                    setRecovering(true); setRecoverErr(null)
                    try {
                      const res = await recoverPlaceDetails(company.id, icpId)
                      if (!res.success) throw new Error('Recovery failed')
                      // Trigger parent refresh so the card re-renders with
                      // the newly-populated fields without a full page
                      // reload. The parent's refresh() pulls every lane
                      // from the API.
                      onChanged()
                    } catch (e: any) {
                      setRecoverErr(e?.message || 'Recovery failed')
                    } finally {
                      setRecovering(false)
                    }
                  }}
                  disabled={recovering}
                  className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-500/15 disabled:opacity-60"
                  title="Spend 5 Scrapingdog credits (10 if no dataId stored) to refetch title/phone/address from Google Maps' full place endpoint"
                >
                  {recovering
                    ? <IconLoader2 className="h-3 w-3 animate-spin" />
                    : <IconCloudDownload className="h-3 w-3" />}
                  {recovering ? 'Recovering…' : 'Recover details (5 credits)'}
                </button>
              )}
              {recoverErr && (
                <span className="text-[10px] text-red-600 dark:text-red-400">{recoverErr}</span>
              )}
            </div>
          </div>
        )}

        {/* Quick-glance fields. Pulled from the rich classification block
            written by the sweep pipeline; only render fields that exist. */}
        {(cls.tagline || cls.fleetSizeHint || cls.fleetVehicleTypes?.length || cls.bookingPlatformHints?.length) && (
          <div className="text-[11px] text-muted-foreground space-y-0.5 border-l-2 border-border/50 pl-2.5">
            {cls.tagline && <div>{cls.tagline}</div>}
            {cls.fleetSizeHint && <div><span className="opacity-70">Fleet:</span> {cls.fleetSizeHint}</div>}
            {cls.fleetVehicleTypes && cls.fleetVehicleTypes.length > 0 && (
              <div><span className="opacity-70">Types:</span> {cls.fleetVehicleTypes.join(', ')}</div>
            )}
            {cls.bookingPlatformHints && cls.bookingPlatformHints.length > 0 && (
              <div><span className="opacity-70">Booking:</span> {cls.bookingPlatformHints.join(', ')}</div>
            )}
          </div>
        )}

        {/* Rejected review surfaces the rep's reason inline so reviewing
            the rejected lane is informative, not just "all the X's". */}
        {lane === 'rejected' && review && (
          <div className="text-xs rounded-md bg-red-500/10 border border-red-500/30 px-2.5 py-1.5">
            <div className="font-semibold text-red-700 dark:text-red-300">
              {REJECT_REASONS.find((r) => r.value === review.reason)?.label || review.reason || 'Rejected'}
            </div>
            {review.note && <div className="text-muted-foreground mt-0.5">{review.note}</div>}
          </div>
        )}

        {/* People (inline) — the decision-makers associated with this company
            (from the sweep's auto-associate or a prior Sales Agent run). Shown
            right on the card so the rep doesn't need to expand or open the
            Sales Agent: tick people and "Reveal email (N)" to bulk-reveal their
            email + LinkedIn; reveal each person's cell separately (it's the
            pricier waterfall). */}
        {hasLeads && (
          <div className="space-y-1.5">
            <CompanyLeads
              leads={leads}
              selectable
              selectedApolloIds={selectedLeadIds}
              onToggleLead={toggleLead}
              onRevealPhone={(lead) => {
                if (!lead.apolloId) return
                phone.reveal(company.id, lead.apolloId, lead.phone, (updated) => patchLead(company.id, updated))
              }}
              isRevealingPhone={(apolloId) => phone.isRevealing(company.id, apolloId)}
              phoneEmpty={(apolloId) => phone.isEmpty(company.id, apolloId)}
            />
            {(selectedLeadIds.size > 0 || emailMsg) && (
              <div className="flex items-center gap-2">
                {selectedLeadIds.size > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRevealEmails}
                    disabled={revealingEmails}
                    title="Reveal verified email + LinkedIn for the selected people (~1 Apollo credit each; already-revealed contacts are skipped). Phone is a separate per-person reveal."
                  >
                    {revealingEmails
                      ? <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      : <IconMail className="h-3.5 w-3.5 mr-1.5" />}
                    {revealingEmails ? 'Revealing…' : `Reveal email (${selectedLeadIds.size})`}
                  </Button>
                )}
                {emailMsg && <span className="text-[10px] text-muted-foreground italic">{emailMsg}</span>}
              </div>
            )}
          </div>
        )}

        {/* Action row. Layout per lane:
              Pending:   [Confirm] [Reject▾] [Sales Agent] · [Full report]
              Confirmed: [Undo] [Sales Agent (primary)] · [Full report]
              Rejected:  [Undo] · [Full report]
            Sales Agent button skips its own classify step (we already have
            the classification from Coverage) and jumps straight to lead
            generation. Hidden on Rejected - no point drafting outreach
            to leads we've already declined. */}
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {(lane === 'pending' || lane === 'needs-check') && (
            <>
              <Button size="sm" onClick={onConfirm} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                <IconCircleCheck className="h-3.5 w-3.5 mr-1.5" />
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRejectOpen((v) => !v)}
                className={cn(rejectOpen && 'bg-red-500/10 border-red-500/40 text-red-700 dark:text-red-300')}
              >
                <IconCircleX className="h-3.5 w-3.5 mr-1.5" />
                Reject
                {rejectOpen ? <IconChevronUp className="h-3 w-3 ml-1" /> : <IconChevronDown className="h-3 w-3 ml-1" />}
              </Button>
            </>
          )}
          {(lane === 'confirmed' || lane === 'rejected') && (
            <Button size="sm" variant="outline" onClick={onUndo}>
              <IconRotateClockwise className="h-3.5 w-3.5 mr-1.5" />
              Undo · move back to Pending
            </Button>
          )}
          {/* Sales Agent - primary action on Confirmed (this is the
              expected next step once a lead is approved). Secondary on
              Pending (rep may want to scope it out before deciding).
              Hidden on Rejected. */}
          {lane !== 'rejected' && lane !== 'needs-check' && company.url && (
            <Button
              size="sm"
              onClick={onSendToSalesAgent}
              variant={lane === 'confirmed' ? 'default' : 'outline'}
              className={lane === 'confirmed' ? 'bg-sky-600 hover:bg-sky-700 text-white' : ''}
              title="Open in Email Generation with this account pre-loaded - skips the URL classify step since we already have a classification"
            >
              <IconMail className="h-3.5 w-3.5 mr-1.5" />
              Sales Agent
            </Button>
          )}
          {lane !== 'rejected' && lane !== 'needs-check' && (
            <Button
              size="sm"
              onClick={onStartSequence}
              variant="outline"
              title="Open Sequences page with a new multi-step run pre-staged for this account"
            >
              <IconMailForward className="h-3.5 w-3.5 mr-1.5" />
              Sequence
            </Button>
          )}
          {/* Push to HubSpot - upserts this company (dedupe by domain) with its
              verdict/rating/signals + a report note, and every contact that
              has an email. Idempotent: re-push updates in place. Primary on
              Confirmed; available (outline) on Pending too. */}
          {lane !== 'rejected' && lane !== 'needs-check' && (
            <Button
              size="sm"
              variant={lane === 'confirmed' && !company.hubspotId ? 'default' : 'outline'}
              className={lane === 'confirmed' && !company.hubspotId ? 'bg-orange-600 hover:bg-orange-700 text-white' : ''}
              disabled={pushing}
              onClick={async () => {
                if (pushing) return
                setPushing(true); setPushErr(null)
                try {
                  await pushCompanyToHubSpot(company.id)
                  onChanged() // refresh so the HubSpot badge + sticky state render
                } catch (e: any) {
                  setPushErr(e?.message || 'Push failed')
                } finally {
                  setPushing(false)
                }
              }}
              title="Push this company + its email contacts to HubSpot (dedupes by domain/email; re-push updates in place)"
            >
              {pushing
                ? <IconLoader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                : <IconCloudUpload className="h-3.5 w-3.5 mr-1.5" />}
              {pushing ? 'Pushing…' : company.hubspotId ? 'Re-push' : 'Push to HubSpot'}
            </Button>
          )}
          {pushErr && (
            <span className="text-[10px] text-red-600 dark:text-red-400">{pushErr}</span>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? <><IconChevronUp className="h-3.5 w-3.5 mr-1" /> Hide details</> : <><IconChevronDown className="h-3.5 w-3.5 mr-1" /> Full report</>}
          </Button>
        </div>

        {/* Scraped contacts - ALWAYS visible (even when the full report is
            collapsed). The email / phone / LinkedIn we harvested off the
            site are the actionable bits a rep needs before reaching out, so
            they sit right under the action buttons rather than hidden in
            the expand. */}
        <ScrapedContactsBlock contacts={company.scrapedContacts} />

        {/* Reject panel - expands the card inline rather than popping out
            as a floating dropdown (which could clip off-screen on narrow
            viewports / right-aligned cards). Mirrors the Valsource pattern
            of "the row grows to host the reason form" so the rep stays
            anchored to the account they're rejecting. */}
        {rejectOpen && (lane === 'pending' || lane === 'needs-check') && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2.5 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-red-700 dark:text-red-300 font-semibold flex items-center gap-1.5">
              <IconCircleX className="h-3 w-3" />
              Why is this not a fit?
            </div>
            <RejectForm
              onCancel={() => setRejectOpen(false)}
              onSubmit={(reason, note) => { setRejectOpen(false); onReject(reason, note) }}
            />
          </div>
        )}

        {/* Expanded report */}
        {expanded && (
          <div className="pt-2 border-t border-border/40 space-y-1.5 text-xs">
            <DetailRow label="Domain" value={company.domain} />
            {company.url && <DetailRow label="URL" value={company.url} link />}
            <DetailRow label="Address" value={cls.address} />
            <DetailRow label="Phone" value={cls.phone} />
            <DetailRow label="Vertical" value={company.vertical} />
            <DetailRow label="City" value={company.city || cls.city} />
            <DetailRow label="Country" value={cls.country} />
            {cls.signals && cls.signals.length > 0 && (
              <div className="pt-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Signals</div>
                <ul className="text-[11px] space-y-0.5 leading-relaxed">
                  {cls.signals.map((s, i) => (
                    <li key={i} className="flex gap-1.5"><span className="opacity-50 shrink-0">•</span><span>{s}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {/* Verbatim quotes pulled by the classifier in the same GPT call. */}
            {cls.key_quotes && cls.key_quotes.length > 0 && (
              <div className="pt-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1.5">
                  <span>From the website</span>
                  <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 normal-case tracking-normal text-[10px]" title="Verbatim - taken directly from the scraped page">✓ verbatim</span>
                </div>
                <ul className="space-y-1">
                  {cls.key_quotes.map((q, i) => (
                    <li key={i} className="border-l-2 border-sky-500/40 pl-2 text-[11px] italic leading-snug text-foreground/85">
                      <span className="opacity-50 mr-0.5">&ldquo;</span>{q}<span className="opacity-50 ml-0.5">&rdquo;</span>
                    </li>
                  ))}
                </ul>
                {cls.sourceUrl && (
                  <a
                    href={cls.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-400 hover:underline mt-1"
                  >
                    <IconExternalLink className="h-2.5 w-2.5" />
                    Source
                  </a>
                )}
              </div>
            )}
            {(cls as any).reasoning && (
              <div className="pt-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reasoning</div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">{(cls as any).reasoning}</div>
              </div>
            )}
            {/* GPT markdown report (per-ICP) + generate/regenerate. */}
            <div className="pt-1.5">
              <CompanyReport company={company} icpId={icpId} onChanged={onChanged} />
            </div>
            {/* Leads now render inline above the action row (selectable, with
                per-person email/phone reveal), so they're not duplicated here. */}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Inline reject form - rendered inside the account card itself when the
// user clicks Reject. Reason picklist (canned slugs for clean analytics
// later) + optional free-text note that's stored verbatim. Replaces an
// older absolute-positioned dropdown that clipped off-screen on cards
// near the viewport edge.
function RejectForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (reason: string, note: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState<string>(REJECT_REASONS[0].value)
  const [note, setNote] = useState<string>('')
  return (
    <div className="space-y-2">
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
      >
        {REJECT_REASONS.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Optional note (e.g. 'looks closed, no listings updated since 2022')"
        className="w-full text-xs border border-border rounded-md bg-background text-foreground px-2 py-1.5 resize-y [color-scheme:light_dark]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSubmit(reason, note)} className="flex-1 bg-red-600 hover:bg-red-700 text-white">
          Confirm reject
        </Button>
      </div>
    </div>
  )
}

function DetailRow({ label, value, link }: { label: string; value?: string | null; link?: boolean }) {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0 w-16">{label}</span>
      {link ? (
        <a href={value} target="_blank" rel="noreferrer" className="text-sky-600 dark:text-sky-400 hover:underline break-all">{value}</a>
      ) : (
        <span className="break-words">{value}</span>
      )}
    </div>
  )
}
