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
} from '@tabler/icons-react'
import {
  fetchCompanies,
  submitReview,
  clearReview,
  type CompanyRecord,
  type Review,
  type Classification,
} from '@/lib/api'
import { useWorkspace } from '@/context/workspace-context'
import { useAccountsCount } from '@/context/accounts-count-context'

const API = ''

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

type LaneKey = 'pending' | 'confirmed' | 'rejected'

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
  const [counts, setCounts] = useState<Record<LaneKey, number>>({ pending: 0, confirmed: 0, rejected: 0 })

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
    if (!activeIcp) { setCompanies([]); setCounts({ pending: 0, confirmed: 0, rejected: 0 }); return }
    setLoading(true)
    setError(null)
    try {
      const [list, pendingList, confirmedList, rejectedList] = await Promise.all([
        fetchCompanies({ icp: activeIcp, reviewStatus: lane }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'pending' }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'confirmed' }),
        fetchCompanies({ icp: activeIcp, reviewStatus: 'rejected' }),
      ])
      setCompanies(list.companies)
      setCounts({
        pending: pendingList.companies.length,
        confirmed: confirmedList.companies.length,
        rejected: rejectedList.companies.length,
      })
    } catch (e: any) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
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
    try {
      await clearReview(companyId, activeIcp)
      setCompanies((prev) => prev.filter((c) => c.id !== companyId))
      setCounts((prev) => ({
        ...prev,
        [lane]: Math.max(0, prev[lane] - 1),
        pending: prev.pending + 1,
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
            {activeIcpMeta && (
              <span className="ml-auto text-[11px] text-muted-foreground italic">
                {activeIcpMeta.vertical} · {activeIcpMeta.portfolioCompany || '-'}
              </span>
            )}
          </div>

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
                />
              ))}
            </div>
          )}
        </>
      )}
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
}: {
  label: string
  icon: React.ReactNode
  count: number
  active: boolean
  color: 'amber' | 'emerald' | 'red'
  onPick: () => void
}) {
  const accents = {
    amber:   'bg-amber-500/20 border-amber-500/60 text-amber-700 dark:text-amber-300',
    emerald: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-700 dark:text-emerald-300',
    red:     'bg-red-500/20 border-red-500/60 text-red-700 dark:text-red-300',
  }
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors',
        active
          ? `${accents[color]} font-semibold`
          : 'border-border text-muted-foreground hover:bg-muted/40',
      )}
    >
      {icon}
      <span>{label}</span>
      <span className="tabular-nums opacity-80">{count}</span>
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
}: {
  company: CompanyRecord
  icpId: string
  lane: LaneKey
  onConfirm: () => void
  onReject: (reason: string, note: string) => void
  onUndo: () => void
  onSendToSalesAgent: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const cls = (company.classifications?.[icpId] || company.classification || {}) as Classification & { city?: string; country?: string; rating?: number; reviews?: number; title?: string; phone?: string; address?: string; signals?: string[]; fleetSizeHint?: string; fleetVehicleTypes?: string[]; bookingPlatformHints?: string[]; tagline?: string }
  const review: Review | undefined = company.reviews?.[icpId]

  return (
    <Card className={cn(GLASS, lane === 'rejected' && 'opacity-80')}>
      <CardContent className="p-4 space-y-2.5">
        {/* Top row - name + status + outbound link */}
        <div className="flex items-start gap-2">
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
              {company.vertical && (
                <Badge variant="secondary" className="text-[10px]">{company.vertical}</Badge>
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
                <span className="font-mono">{company.domain}</span>
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
            pending lane. The reason is what the rep should sanity-check. */}
        {cls.reason && (
          <div className="text-xs leading-relaxed text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400 font-semibold mr-1">✓ Classifier:</span>
            {cls.reason}
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

        {/* Action row. Layout per lane:
              Pending:   [Confirm] [Reject▾] [Sales Agent] · [Full report]
              Confirmed: [Undo] [Sales Agent (primary)] · [Full report]
              Rejected:  [Undo] · [Full report]
            Sales Agent button skips its own classify step (we already have
            the classification from Coverage) and jumps straight to lead
            generation. Hidden on Rejected - no point drafting outreach
            to leads we've already declined. */}
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {lane === 'pending' && (
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
          {lane !== 'rejected' && (
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
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? <><IconChevronUp className="h-3.5 w-3.5 mr-1" /> Hide details</> : <><IconChevronDown className="h-3.5 w-3.5 mr-1" /> Full report</>}
          </Button>
        </div>

        {/* Reject panel - expands the card inline rather than popping out
            as a floating dropdown (which could clip off-screen on narrow
            viewports / right-aligned cards). Mirrors the Valsource pattern
            of "the row grows to host the reason form" so the rep stays
            anchored to the account they're rejecting. */}
        {rejectOpen && lane === 'pending' && (
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
            {(cls as any).reasoning && (
              <div className="pt-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reasoning</div>
                <div className="text-[11px] text-muted-foreground leading-relaxed">{(cls as any).reasoning}</div>
              </div>
            )}
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
