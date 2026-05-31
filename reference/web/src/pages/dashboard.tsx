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
} from '@tabler/icons-react'
import { fetchCompanies, type CompanyRecord } from '@/lib/api'
import { useWorkspace } from '@/context/workspace-context'

const API = ''

interface IcpSummary {
  id: string
  name: string
  vertical: string
  portfolioCompany?: string
  countries?: string[]
}

export default function DashboardPage() {
  const { workspace } = useWorkspace()
  const [icps, setIcps] = useState<IcpSummary[]>([])
  const [companies, setCompanies] = useState<CompanyRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const [icpsRes, companiesRes] = await Promise.all([
        fetch(`${API}/api/icps`).then((r) => r.json()),
        // Server filtering by portfolioCompany when a workspace is picked
        // keeps the dashboard fast even as the DB grows.
        fetchCompanies(workspace ? { portfolioCompany: workspace } : {}),
      ])
      if (icpsRes?.success) setIcps(icpsRes.icps)
      setCompanies(companiesRes.companies)
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
  // a Bluebird-classified company to count as anything here).
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
