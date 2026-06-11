// /activity - operator audit trail.
//
// Reads /api/activity?days=N (newest first) and renders one row per action
// with a colored icon + label. Entries are bucketed by Today / Yesterday /
// weekday. Toolbar lets you scope the lookback window (7d/14d/30d) and
// filter to a single action type via a chip row.
//
// Adapted from the valsource activity-log page. SecretGate easter egg
// dropped (Carla has no auth, no need to gate the audit trail).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { GLASS } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import {
  IconActivity,
  IconLoader2,
  IconRefresh,
  IconClock,
  IconUser,
  IconSparkles,
  IconPlayerPlay,
  IconPlayerPause,
  IconRotateClockwise,
  IconMail,
  IconBrandLinkedin,
  IconTemplate,
  IconTrash,
  IconEdit,
  IconWand,
} from '@tabler/icons-react'

const API = API_BASE

// Each entry's `details` is whatever the trackActivity middleware stamped on
// the row. We don't lock down the shape because individual routes can add
// custom fields (e.g. reclassify_run already attaches body.domains via the
// middleware's sanitizeBody). The renderer reads what it knows; everything
// else flows into the (raw) tooltip on click.
interface ActivityEntry {
  id: string
  user_id: string
  action: string
  details: {
    method?: string
    path?: string
    body?: Record<string, unknown>
    [key: string]: unknown
  } | null
  created_at: string
}

// Maps each tracked action to a display label + tabler icon + Tailwind color
// palette. New actions land in the default bucket until added here.
const ACTION_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  icp_created: {
    label: 'ICP created',
    icon: IconSparkles,
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  icp_updated: {
    label: 'ICP edited',
    icon: IconEdit,
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  },
  icp_deleted: {
    label: 'ICP deleted',
    icon: IconTrash,
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
  sweep_resumed: {
    label: 'Sweep resumed',
    icon: IconPlayerPlay,
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  sweep_paused: {
    label: 'Sweep paused',
    icon: IconPlayerPause,
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  reclassify_run: {
    label: 'Reclassify run',
    icon: IconWand,
    color: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  },
  rescan_stale_terms: {
    label: 'Stale-term rescan',
    icon: IconRotateClockwise,
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  },
  email_generated: {
    label: 'Email generated',
    icon: IconMail,
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  },
  li_message_generated: {
    label: 'LinkedIn DM generated',
    icon: IconBrandLinkedin,
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  },
  template_created: {
    label: 'Template created',
    icon: IconTemplate,
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  template_updated: {
    label: 'Template edited',
    icon: IconTemplate,
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  },
  template_deleted: {
    label: 'Template deleted',
    icon: IconTrash,
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  },
}

function getActionConfig(action: string) {
  return (
    ACTION_CONFIG[action] || {
      label: action,
      icon: IconActivity,
      color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    }
  )
}

function formatRelative(dateStr: string): string {
  const date = new Date(dateStr)
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 60_000) return 'just now'
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(diffMs / 3_600_000)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(diffMs / 86_400_000)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

// Build a short "what was acted on" snippet for the row. Reads from the
// middleware-sanitized body when the action's payload is a known shape;
// falls back to the request path so every row still surfaces SOMETHING.
function getDetail(entry: ActivityEntry): string | null {
  const { action, details } = entry
  if (!details) return null
  const body = (details.body as Record<string, unknown>) || {}

  // ICP-scoped actions: prefer ICP id from path, then body name.
  if (action.startsWith('icp_')) {
    const m = (details.path || '').match(/\/api\/icps\/([^/?]+)/)
    if (m) return m[1]
    if (typeof body.name === 'string') return body.name
    if (typeof body.id === 'string') return body.id
  }
  if (action === 'reclassify_run' || action === 'rescan_stale_terms') {
    const m = (details.path || '').match(/\/api\/icps\/([^/]+)\//)
    if (m) {
      const domainsArr = Array.isArray(body.domains) ? body.domains : null
      const n = domainsArr ? ` (${domainsArr.length} compan${domainsArr.length === 1 ? 'y' : 'ies'})` : ''
      return `${m[1]}${n}`
    }
  }
  if (action === 'sweep_resumed') {
    const icp = body.icp as string | undefined
    const scope = body.scope as { type?: string; value?: string | null } | undefined
    if (icp && scope?.type) {
      return `${icp} · ${scope.type}${scope.value ? `=${scope.value}` : ''}`
    }
    if (icp) return icp
  }
  if (action === 'email_generated' || action === 'li_message_generated') {
    const lead = body.lead as { firstName?: string; lastName?: string; companyName?: string } | undefined
    const cls = body.classification as { name?: string; domain?: string } | undefined
    const tpl = body.templateId as string | undefined
    const parts: string[] = []
    if (lead?.firstName || lead?.lastName) parts.push(`${lead.firstName || ''} ${lead.lastName || ''}`.trim())
    if (cls?.name || cls?.domain) parts.push(cls.name || cls.domain || '')
    if (tpl) parts.push(`via ${tpl}`)
    if (parts.length) return parts.filter(Boolean).join(' · ')
  }
  if (action.startsWith('template_')) {
    if (typeof body.name === 'string') return body.name
    const m = (details.path || '').match(/\/api\/email-templates\/([^/?]+)/)
    if (m) return m[1]
  }
  return details.path || null
}

function groupByDate(entries: ActivityEntry[]): { label: string; entries: ActivityEntry[] }[] {
  const buckets = new Map<string, ActivityEntry[]>()
  const todayKey = new Date().toDateString()
  const yesterdayKey = new Date(Date.now() - 86_400_000).toDateString()
  for (const e of entries) {
    const d = new Date(e.created_at)
    const key = d.toDateString()
    const label = key === todayKey
      ? 'Today'
      : key === yesterdayKey
        ? 'Yesterday'
        : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label)!.push(e)
  }
  return Array.from(buckets.entries()).map(([label, entries]) => ({ label, entries }))
}

export default function ActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  const [actionFilter, setActionFilter] = useState<string | null>(null)

  const fetchActivity = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const data = await safeFetchJson(`${API}/api/activity?days=${days}`)
      if (!data?.success) throw new Error(data?.error || 'failed to load')
      setEntries(data.activity || [])
    } catch (e: any) {
      setError(e?.message || 'failed to load activity')
    } finally {
      setLoading(false)
    }
  }, [days])
  useEffect(() => { void fetchActivity() }, [fetchActivity])

  const filtered = useMemo(() => {
    return actionFilter ? entries.filter((e) => e.action === actionFilter) : entries
  }, [entries, actionFilter])
  const grouped = useMemo(() => groupByDate(filtered), [filtered])

  // Per-action chip counts derived from the full (pre-filter) set so the
  // chip values stay stable as the user toggles between filters.
  const actionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries) m.set(e.action, (m.get(e.action) || 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [entries])

  return (
    <div className="relative h-full">
      {/* Header */}
      <div className={`${GLASS} px-4 py-3 mb-4 flex items-center gap-3`}>
        <IconActivity className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-semibold">Activity Log</span>
        <span className="text-xs text-muted-foreground">
          {loading
            ? 'Loading…'
            : `${filtered.length}${actionFilter ? ` of ${entries.length}` : ''} action${filtered.length === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={fetchActivity} disabled={loading} className="h-7 text-xs">
          <IconRefresh className={cn('h-3 w-3 mr-1', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/40 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Controls: time-range segmented toggle + per-action chip filter */}
      <div className="mb-4 flex items-start gap-3 flex-wrap">
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                days === d
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                  : 'text-muted-foreground hover:bg-muted/40',
              )}
            >
              {d}d
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {actionFilter && (
            <button
              type="button"
              onClick={() => setActionFilter(null)}
              className="text-[11px] px-2 py-1 rounded-full border border-border text-muted-foreground hover:bg-muted/40"
            >
              Clear filter
            </button>
          )}
          {actionCounts.map(([action, count]) => {
            const cfg = getActionConfig(action)
            const Icon = cfg.icon
            const active = actionFilter === action
            return (
              <button
                key={action}
                type="button"
                onClick={() => setActionFilter(active ? null : action)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-all',
                  active
                    ? `${cfg.color} ring-2 ring-offset-1 ring-current`
                    : actionFilter
                      ? 'bg-muted text-muted-foreground opacity-50'
                      : cfg.color,
                )}
              >
                <Icon className="h-3 w-3" />
                {cfg.label}
                <span className="opacity-70 font-mono">{count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Feed */}
      {loading && entries.length === 0 ? (
        <Card className={GLASS}>
          <CardContent className="py-16 text-center text-muted-foreground text-xs">
            <IconLoader2 className="h-8 w-8 mx-auto animate-spin mb-3" />
            Loading activity…
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className={GLASS}>
          <CardContent className="py-16 text-center text-muted-foreground text-xs">
            <IconActivity className="h-12 w-12 mx-auto opacity-30 mb-3" />
            {entries.length === 0
              ? 'No activity recorded yet. The log fills up as you create/edit ICPs, run sweeps, generate emails, etc.'
              : 'No matching activity for the selected filter.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <div key={group.label}>
              <div className="flex items-center gap-2 mb-2">
                <IconClock className="h-3 w-3 text-muted-foreground" />
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {group.label}
                </h3>
                <Badge variant="outline" className="text-[10px] h-5">
                  {group.entries.length}
                </Badge>
              </div>
              <Card className={GLASS}>
                <CardContent className="p-0 divide-y divide-border/40">
                  {group.entries.map((entry) => {
                    const cfg = getActionConfig(entry.action)
                    const Icon = cfg.icon
                    const detail = getDetail(entry)
                    return (
                      <div key={entry.id} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors">
                        <div className={cn('flex h-7 w-7 items-center justify-center rounded-full shrink-0', cfg.color)}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium">{cfg.label}</span>
                            {entry.user_id && entry.user_id !== 'anonymous' && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                <IconUser className="h-2.5 w-2.5" />
                                {entry.user_id}
                              </span>
                            )}
                          </div>
                          {detail && (
                            <p className="text-[11px] text-muted-foreground truncate font-mono">{detail}</p>
                          )}
                        </div>
                        <span
                          className="text-[10px] text-muted-foreground shrink-0 tabular-nums"
                          title={formatFullDate(entry.created_at)}
                        >
                          {formatRelative(entry.created_at)}
                        </span>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
