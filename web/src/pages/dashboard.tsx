// /dashboard - landing page. Quick-glance health of the lead pipeline:
// how many companies we've discovered, how many are awaiting review,
// how many have been confirmed for outreach. Workspace-scoped so each
// portfolio company's team sees only their own numbers (with "All
// Companies" giving the cross-portfolio aggregate view).
//
// Deliberately read-only and lightweight - actions live on the specific
// pages (Coverage to seed, Accounts to review, Email Generation to send).
// The dashboard is the at-a-glance "where are we today" check, not a
// command center.

import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import {
  IconDashboard,
  IconRefresh,
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconBuildingStore,
  IconSparkles,
  IconMapPin,
  IconArrowRight,
  IconActivity,
  IconRecycle,
} from '@tabler/icons-react'
import { fetchCompanies, type CompanyRecord } from '@/lib/api'
import { useWorkspace } from '@/context/workspace-context'
import { API_BASE } from '@/lib/api-base'

const API = API_BASE

interface IcpSummary {
  id: string
  name: string
  vertical: string
  portfolioCompany?: string
  countries?: string[]
}

// Shape returned by GET /api/grid/sessions. Mirrors the sweep_sessions
// schema (migration 0011) so the panel can render any persisted row.
interface SweepSession {
  id: string
  started_at: string
  ended_at: string | null
  icp_id: string | null
  scope_type: 'city' | 'country' | 'all' | null
  scope_value: string | null
  status: 'running' | 'paused' | 'completed' | 'crashed'
  pause_reason: string | null
  cells_attempted: number
  cells_succeeded: number
  cells_errored: number
  places_found: number
  leads_qualified: number
}

// Shape returned by GET /api/icps/jobs/reclassify. Mirrors reclassify_jobs
// (migration 0014). Workspace filtering happens client-side via icp_id ↔
// scopedIcps.
interface ReclassifyJob {
  id: string
  icp_id: string
  status: 'pending' | 'running' | 'paused' | 'cancelled' | 'completed' | 'crashed'
  total: number
  processed: number
  qualified: number
  rejected: number
  flipped: number
  errors: number
  current_domain: string | null
  created_at: string
  finished_at: string | null
}

export default function DashboardPage() {
  const { workspace } = useWorkspace()
  const [icps, setIcps] = useState<IcpSummary[]>([])
  const [companies, setCompanies] = useState<CompanyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Recent pipeline activity from the persisted queues. Pulled in the
  // same refresh() so a Refresh click updates the whole page in one go.
  // Sessions/jobs fetched globally (no server-side workspace filter);
  // we narrow client-side via the scopedIcps set so the queue list stays
  // consistent with the ICP scope above.
  const [sweepSessions, setSweepSessions] = useState<SweepSession[]>([])
  const [reclassifyJobs, setReclassifyJobs] = useState<ReclassifyJob[]>([])

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [icpsRes, companiesRes, sessionsRes, jobsRes] = await Promise.all([
        fetch(`${API}/api/icps`).then((r) => r.json()),
        // Server filtering by portfolioCompany when a workspace is picked
        // keeps the dashboard fast even as the DB grows.
        fetchCompanies(workspace ? { portfolioCompany: workspace } : {}),
        // Sweep sessions + reclassify jobs are workspace-filtered client-
        // side (the routes only support per-ICP filtering, and the
        // dashboard's scope can span several ICPs in a workspace). Soft-
        // fail to empty arrays so a Supabase blip doesn't blank the whole
        // page - the rest of the dashboard still loads.
        fetch(`${API}/api/grid/sessions?limit=20`).then((r) => r.json()).catch(() => ({ success: false })),
        fetch(`${API}/api/icps/jobs/reclassify?limit=20`).then((r) => r.json()).catch(() => ({ success: false })),
      ])
      if (icpsRes?.success) setIcps(icpsRes.icps)
      setCompanies(companiesRes.companies)
      if (sessionsRes?.success) setSweepSessions(sessionsRes.sessions || [])
      if (jobsRes?.success) setReclassifyJobs(jobsRes.jobs || [])
    } catch (e: any) {
      setError(e.message || 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // Filter ICPs to the active workspace. Counts and per-ICP roll-ups all
  // use this scoped set so switching workspace flips every number on the
  // page in one go.
  const scopedIcps = useMemo(() => {
    if (!workspace) return icps
    const w = workspace.toLowerCase()
    return icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, workspace])

  // Walk every (company, scoped-ICP) pair and bucket into pending/confirmed/
  // rejected. We use the scoped ICP list so an ICP outside the workspace
  // can't sneak into the count (e.g. when workspace=NedFox we don't want
  // a Carla-classified company to count as anything here).
  //
  // "Pending" means classifier said is_match AND there's no review yet -
  // mirrors the Accounts page logic so the numbers match exactly.
  const stats = useMemo(() => {
    const scopedIcpIds = new Set(scopedIcps.map((i) => i.id))
    let pending = 0, confirmed = 0, rejected = 0, classified = 0
    for (const c of companies) {
      if (!c.classifications) continue
      for (const [icpId, cls] of Object.entries(c.classifications)) {
        if (!scopedIcpIds.has(icpId)) continue
        classified++
        const rev = c.reviews?.[icpId]
        if (rev?.decision === 'confirmed') confirmed++
        else if (rev?.decision === 'rejected') rejected++
        else if (cls.is_match === true) pending++
      }
    }
    return {
      totalCompanies: companies.length,
      classified,
      pending,
      confirmed,
      rejected,
      totalIcps: scopedIcps.length,
    }
  }, [companies, scopedIcps])

  // Per-ICP pending counts for the "what needs attention" callout row.
  // Sorted desc by pending so the most-backlogged ICP appears first.
  const perIcpPending = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of companies) {
      if (!c.classifications) continue
      for (const [icpId, cls] of Object.entries(c.classifications)) {
        if (cls.is_match !== true) continue
        if (c.reviews?.[icpId]) continue
        map.set(icpId, (map.get(icpId) || 0) + 1)
      }
    }
    return scopedIcps
      .map((i) => ({ ...i, pending: map.get(i.id) || 0 }))
      .sort((a, b) => b.pending - a.pending)
  }, [companies, scopedIcps])

  // Recent reviews - last N confirmed/rejected actions across the
  // workspace. A casual "what has the team done recently" trail.
  const recentReviews = useMemo(() => {
    const rows: Array<{ company: CompanyRecord; icpId: string; decision: 'confirmed' | 'rejected'; ts: number }> = []
    const scopedIcpIds = new Set(scopedIcps.map((i) => i.id))
    for (const c of companies) {
      if (!c.reviews) continue
      for (const [icpId, rev] of Object.entries(c.reviews)) {
        if (!scopedIcpIds.has(icpId)) continue
        rows.push({ company: c, icpId, decision: rev.decision, ts: rev.reviewedAt })
      }
    }
    return rows.sort((a, b) => b.ts - a.ts).slice(0, 8)
  }, [companies, scopedIcps])

  const icpName = (id: string) => scopedIcps.find((i) => i.id === id)?.name || id

  // Workspace-scope the persisted queues. Sessions with icp_id===null
  // (scope='all') pass through in "All Companies" mode and pass through
  // in any workspace too (they touched every ICP). Top 6 rows for each
  // panel keeps the dashboard scannable without scrolling.
  const scopedSessions = useMemo(() => {
    const ids = new Set(scopedIcps.map((i) => i.id))
    const filtered = workspace
      ? sweepSessions.filter((s) => !s.icp_id || ids.has(s.icp_id))
      : sweepSessions
    return filtered.slice(0, 6)
  }, [sweepSessions, scopedIcps, workspace])

  const scopedReclassifyJobs = useMemo(() => {
    const ids = new Set(scopedIcps.map((i) => i.id))
    const filtered = workspace
      ? reclassifyJobs.filter((j) => ids.has(j.icp_id))
      : reclassifyJobs
    return filtered.slice(0, 6)
  }, [reclassifyJobs, scopedIcps, workspace])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className={`${GLASS} px-4 py-3 flex items-center gap-3`}>
        <IconDashboard className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-semibold">Dashboard</span>
        <span className="text-xs text-muted-foreground">
          {workspace ? <>Scoped to <span className="font-medium text-foreground">{workspace}</span></> : <>All portfolio companies</>}
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <IconRefresh className={cn('h-3 w-3 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Stat grid - top-of-funnel → bottom-of-funnel ordering so the
          eye reads left-to-right as "we discovered N, classified N, X
          are pending, Y confirmed, Z rejected". */}
      <div className={`${GLASS_SUBTLE} p-4`}>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Stat label="ICPs" value={stats.totalIcps} hint="active in this scope" icon={<IconSparkles className="h-3 w-3" />} />
          <Stat label="Companies" value={stats.totalCompanies} hint="in scope" icon={<IconBuildingStore className="h-3 w-3" />} />
          <Stat label="Classifications" value={stats.classified} hint="machine-classified" />
          <Stat label="Pending" value={stats.pending} accent="amber" icon={<IconClock className="h-3 w-3" />} />
          <Stat label="Confirmed" value={stats.confirmed} accent="emerald" icon={<IconCircleCheck className="h-3 w-3" />} />
          <Stat label="Rejected" value={stats.rejected} accent="red" icon={<IconCircleX className="h-3 w-3" />} />
        </div>
      </div>

      {/* Two-column layout below the stat grid: left is "what needs
          attention right now", right is "recent activity". */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* What needs attention - per-ICP pending counts. Click-through
            to Accounts page filtered to that ICP. */}
        <Card className={GLASS}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <IconClock className="h-4 w-4 text-amber-500" />
              <h3 className="text-sm font-semibold">Awaiting review</h3>
              <span className="text-xs text-muted-foreground">- pre-classified, needs human verdict</span>
            </div>
            {loading && perIcpPending.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <IconLoader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading…
              </div>
            ) : perIcpPending.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {workspace
                  ? <>No ICPs in <span className="font-semibold">{workspace}</span> yet. Create one on the ICPs page.</>
                  : <>No ICPs defined yet.</>}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {perIcpPending.map((i) => (
                  <li key={i.id}>
                    <NavLink
                      to="/accounts"
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40 transition-colors text-sm"
                    >
                      <span className="flex-1 min-w-0 truncate">{i.name}</span>
                      <span className="text-xs text-muted-foreground truncate">{i.vertical}</span>
                      <Badge variant={i.pending > 0 ? 'warning' : 'secondary'} className="text-[10px] tabular-nums shrink-0">
                        {i.pending} pending
                      </Badge>
                      <IconArrowRight className="h-3 w-3 opacity-40" />
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent reviews - the trail of recent confirm/reject actions.
            Doubles as a sanity check that the team is keeping up with
            the inbound queue. */}
        <Card className={GLASS}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <IconCircleCheck className="h-4 w-4 text-emerald-500" />
              <h3 className="text-sm font-semibold">Recent reviews</h3>
              <span className="text-xs text-muted-foreground">- last 8 actions</span>
            </div>
            {loading && recentReviews.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <IconLoader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading…
              </div>
            ) : recentReviews.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No reviews yet. Visit Accounts to start confirming pre-classified leads.
              </div>
            ) : (
              <ul className="space-y-1">
                {recentReviews.map((r, i) => (
                  <li key={`${r.company.id}-${r.icpId}-${i}`} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md hover:bg-muted/30 transition-colors">
                    {r.decision === 'confirmed' ? (
                      <IconCircleCheck className="h-3 w-3 text-emerald-500 shrink-0" />
                    ) : (
                      <IconCircleX className="h-3 w-3 text-red-500 shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 truncate font-medium">{r.company.domain}</span>
                    <span className="text-muted-foreground truncate hidden sm:inline">{icpName(r.icpId)}</span>
                    <span className="text-muted-foreground tabular-nums opacity-70 shrink-0">{relativeTime(r.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Second two-column row: persisted pipeline activity. Mirrors the
          Recent sessions / Recent jobs panels that live deeper inside
          Coverage + the ICP editor's Reclassify tab, so the dashboard
          carries a "what's the pipeline doing right now" answer without
          forcing the rep to navigate three pages to assemble it. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent sweep sessions - one row per Resume click, including
            crashed-recovered sessions. Counters come from the persisted
            sweep_sessions row so the dashboard survives a redeploy. */}
        <Card className={GLASS}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <IconActivity className="h-4 w-4 text-sky-500" />
              <h3 className="text-sm font-semibold">Recent sweep sessions</h3>
              <span className="text-xs text-muted-foreground">- coverage queue</span>
              <div className="flex-1" />
              <NavLink to="/coverage" className="text-[10px] text-sky-600 dark:text-sky-400 hover:underline">View all →</NavLink>
            </div>
            {loading && scopedSessions.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <IconLoader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading…
              </div>
            ) : scopedSessions.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No sweep sessions yet. Hit <span className="font-semibold">Resume sweeping</span> on Coverage to start one.
              </div>
            ) : (
              <ul className="space-y-1">
                {scopedSessions.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md hover:bg-muted/30 transition-colors"
                  >
                    <SessionStatusBadge status={s.status} />
                    <span className="flex-1 min-w-0 truncate">
                      <span className="font-medium">{s.icp_id ? icpName(s.icp_id) : 'All ICPs'}</span>
                      {s.scope_value && (
                        <span className="text-muted-foreground"> · {s.scope_value}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {s.cells_succeeded}/{s.cells_attempted} cells
                    </span>
                    {s.leads_qualified > 0 && (
                      <span className="text-emerald-700 dark:text-emerald-400 tabular-nums shrink-0">
                        +{s.leads_qualified} lead{s.leads_qualified === 1 ? '' : 's'}
                      </span>
                    )}
                    {s.cells_errored > 0 && (
                      <span className="text-red-700 dark:text-red-400 tabular-nums shrink-0">
                        {s.cells_errored} err
                      </span>
                    )}
                    <span className="text-muted-foreground tabular-nums opacity-70 shrink-0">
                      {relativeTime(new Date(s.started_at).getTime())}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent reclassify jobs - one row per Reclassify click. Same
            shape as the in-tab "Recent reclassify jobs" strip but rolled
            up to the dashboard for "is anything classifying right now?". */}
        <Card className={GLASS}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <IconRecycle className="h-4 w-4 text-violet-500" />
              <h3 className="text-sm font-semibold">Recent reclassify jobs</h3>
              <span className="text-xs text-muted-foreground">- icp queue</span>
              <div className="flex-1" />
              <NavLink to="/icp" className="text-[10px] text-sky-600 dark:text-sky-400 hover:underline">View all →</NavLink>
            </div>
            {loading && scopedReclassifyJobs.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <IconLoader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading…
              </div>
            ) : scopedReclassifyJobs.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No reclassify jobs yet. Open an ICP and use the <span className="font-semibold">Reclassify</span> tab to re-run cached companies against an updated prompt.
              </div>
            ) : (
              <ul className="space-y-1">
                {scopedReclassifyJobs.map((j) => (
                  <li
                    key={j.id}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md hover:bg-muted/30 transition-colors"
                  >
                    <ReclassifyStatusBadge status={j.status} />
                    <span className="flex-1 min-w-0 truncate">
                      <span className="font-medium">{icpName(j.icp_id)}</span>
                      {j.current_domain && (j.status === 'running' || j.status === 'pending') && (
                        <span className="text-muted-foreground"> · {j.current_domain}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground tabular-nums shrink-0">
                      {j.processed}/{j.total}
                    </span>
                    {j.flipped > 0 && (
                      <span className="text-amber-700 dark:text-amber-400 tabular-nums shrink-0 font-semibold">
                        {j.flipped} flipped
                      </span>
                    )}
                    {j.errors > 0 && (
                      <span className="text-red-700 dark:text-red-400 tabular-nums shrink-0">
                        {j.errors} err
                      </span>
                    )}
                    <span className="text-muted-foreground tabular-nums opacity-70 shrink-0">
                      {relativeTime(new Date(j.created_at).getTime())}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick links footer - common next actions. Cheap to add and
          reduces the "now where do I go?" friction the first time
          someone lands on the dashboard. */}
      <div className={`${GLASS_SUBTLE} px-3 py-2.5 flex items-center gap-2 flex-wrap text-xs`}>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">Quick links</span>
        <QuickLink to="/coverage" icon={<IconMapPin className="h-3 w-3" />} label="Run a sweep" />
        <QuickLink to="/accounts" icon={<IconCircleCheck className="h-3 w-3" />} label="Review accounts" />
        <QuickLink to="/email" icon={<IconArrowRight className="h-3 w-3" />} label="Generate email" />
        <QuickLink to="/icp" icon={<IconSparkles className="h-3 w-3" />} label="Edit ICPs" />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string
  value: number
  hint?: string
  accent?: 'amber' | 'emerald' | 'red'
  icon?: React.ReactNode
}) {
  const accentColor = {
    amber:   'text-amber-600 dark:text-amber-400',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red:     'text-red-600 dark:text-red-400',
  }
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={cn('text-2xl font-bold tabular-nums', accent ? accentColor[accent] : '')}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}

function QuickLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-background hover:bg-muted/40 transition-colors"
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  )
}

// Compact status pill for sweep sessions. Same color rules as the
// Recent Sessions panel on Coverage so the dashboard reads consistently
// when you cross-reference. Width is fixed-character so the right side
// of each row aligns.
function SessionStatusBadge({ status }: { status: SweepSession['status'] }) {
  const tone =
    status === 'running' ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    : status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : status === 'paused' ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider shrink-0 w-[68px] justify-center', tone)}>
      {status === 'running' && <IconLoader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />}
      {status}
    </span>
  )
}

// Mirror of SessionStatusBadge for reclassify jobs. Separate function
// because reclassify has 'pending'/'cancelled' statuses that sweep
// doesn't share, and overlapping logic in one helper would muddle both.
function ReclassifyStatusBadge({ status }: { status: ReclassifyJob['status'] }) {
  const tone =
    status === 'running' || status === 'pending' ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
    : status === 'completed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    : status === 'cancelled' ? 'border-muted-foreground/30 bg-muted/30 text-muted-foreground'
    : 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider shrink-0 w-[72px] justify-center', tone)}>
      {(status === 'running' || status === 'pending') && <IconLoader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />}
      {status}
    </span>
  )
}

// "5m ago", "2h ago", "3d ago" - simple humanizer for the recent-reviews
// list. Keeps timestamps readable without dragging in a date library.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
