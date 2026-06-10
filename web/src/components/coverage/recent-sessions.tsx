// Recent persisted sweep sessions. Reads from /api/grid/sessions which is
// backed by the Supabase `sweep_sessions` table (migration 0011). Survives
// server restarts so the operator can see what was happening last time
// even after a redeploy - unlike the in-memory Socket.IO activity feed
// which resets to empty whenever the cron process restarts.
//
// Click a session to expand its errors (loaded on demand from
// /api/grid/errors?sessionId=...).

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import {
  IconLoader2,
  IconRefresh,
  IconChevronDown,
  IconChevronRight,
  IconAlertCircle,
  IconCheck,
  IconPlayerPlay,
  IconClock,
} from '@tabler/icons-react'

interface SweepSession {
  id: string
  started_at: string
  ended_at: string | null
  icp_id: string | null
  scope_type: string | null
  scope_value: string | null
  cells_attempted: number
  cells_succeeded: number
  cells_errored: number
  places_found: number
  leads_qualified: number
  already_known: number
  chains_filtered: number
  status: 'running' | 'paused' | 'completed' | 'crashed'
  pause_reason: string | null
  metadata: Record<string, unknown>
}
interface SweepError {
  id: string
  occurred_at: string
  cell_id: string | null
  icp_id: string | null
  service: string | null
  error_type: string | null
  error_message: string
  recovered: boolean
  metadata: Record<string, unknown>
}

const API = API_BASE

function fmtRelative(iso: string | null): string {
  if (!iso) return '-'
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function fmtDuration(start: string, end: string | null): string {
  if (!end) return ''
  const ms = Date.parse(end) - Date.parse(start)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function statusBadge(status: SweepSession['status']) {
  const map = {
    running:   { label: 'Running',   color: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40',           icon: IconPlayerPlay },
    paused:    { label: 'Paused',    color: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40',   icon: IconClock },
    completed: { label: 'Done',      color: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40', icon: IconCheck },
    crashed:   { label: 'Crashed',   color: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40',           icon: IconAlertCircle },
  }
  const cfg = map[status]
  const Icon = cfg.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', cfg.color)}>
      <Icon className="h-2.5 w-2.5 mr-0.5" /> {cfg.label}
    </Badge>
  )
}

function scopeLabel(s: SweepSession): string {
  if (!s.scope_type || s.scope_type === 'all') return 'All scopes'
  if (!s.scope_value) return s.scope_type
  return `${s.scope_value}`
}

export default function RecentSessionsPanel({ icpId }: { icpId: string }) {
  const [sessions, setSessions] = useState<SweepSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')
  const [open, setOpen] = useState(false)
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const [errorsBySession, setErrorsBySession] = useState<Record<string, SweepError[]>>({})
  const [errorsLoading, setErrorsLoading] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const q = icpId ? `?icpId=${encodeURIComponent(icpId)}&limit=15` : '?limit=15'
      const r = await safeFetchJson(`${API}/api/grid/sessions${q}`)
      const items = ((r as { sessions?: SweepSession[] }).sessions) || []
      setSessions(items)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [icpId])

  useEffect(() => {
    // Only fetch when the panel is open - avoids hammering the endpoint
    // for pages where the operator never expands the section.
    if (open) load()
  }, [open, load])

  const loadErrors = async (sessionId: string) => {
    setErrorsLoading(sessionId)
    try {
      const r = await safeFetchJson(`${API}/api/grid/errors?sessionId=${encodeURIComponent(sessionId)}&limit=50`)
      const items = ((r as { errors?: SweepError[] }).errors) || []
      setErrorsBySession((prev) => ({ ...prev, [sessionId]: items }))
    } catch (err) {
      console.warn('Failed to load errors:', err)
    } finally {
      setErrorsLoading(null)
    }
  }

  const toggleExpand = (sessionId: string) => {
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null)
      return
    }
    setExpandedSessionId(sessionId)
    if (!errorsBySession[sessionId]) loadErrors(sessionId)
  }

  return (
    <div className="rounded-md border border-border/40 bg-foreground/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-foreground/[0.04] transition-colors"
      >
        <span className="flex items-center gap-1.5">
          {open ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
          <span className="uppercase tracking-wider text-muted-foreground font-semibold">Recent sessions</span>
          {!open && sessions.length > 0 && (
            <span className="text-muted-foreground/60">· {sessions.length}</span>
          )}
        </span>
        {open && (
          <span
            onClick={(e) => { e.stopPropagation(); load() }}
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            role="button"
          >
            {loading ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconRefresh className="h-3 w-3" />}
            refresh
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border/40">
          {error && (
            <div className="px-3 py-2 text-[11px] text-red-600 dark:text-red-400 bg-red-500/5 border-b border-red-500/20">
              {error}
            </div>
          )}
          {loading && sessions.length === 0 ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground"><IconLoader2 className="h-4 w-4 animate-spin" /></div>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-6 text-center px-3">
              No session history yet. Hit <b>Resume sweeping</b> to start one - it'll persist here.
            </p>
          ) : (
            <ul className="divide-y divide-border/40 max-h-[420px] overflow-y-auto">
              {sessions.map((s) => {
                const expanded = expandedSessionId === s.id
                const errs = errorsBySession[s.id] || []
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => toggleExpand(s.id)}
                      className="w-full text-left px-3 py-2 hover:bg-foreground/[0.04] transition-colors space-y-1"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {expanded
                          ? <IconChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                          : <IconChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                        {statusBadge(s.status)}
                        <span className="text-[11px] font-medium truncate min-w-0">{scopeLabel(s)}</span>
                        {s.icp_id && <span className="text-[10px] text-muted-foreground truncate">· {s.icp_id}</span>}
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {fmtRelative(s.started_at)}{s.ended_at ? ` · ${fmtDuration(s.started_at, s.ended_at)}` : ''}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted-foreground pl-5 flex items-center gap-2 flex-wrap">
                        <span><b className="text-foreground">{s.cells_succeeded}</b> swept</span>
                        {s.cells_errored > 0 && (
                          <span className="text-red-600 dark:text-red-400">
                            · <b>{s.cells_errored}</b> error{s.cells_errored === 1 ? '' : 's'}
                          </span>
                        )}
                        <span>· {s.places_found} companies</span>
                        <span>· {s.leads_qualified} qualified</span>
                        {s.pause_reason && s.pause_reason !== 'manual' && (
                          <span className="text-muted-foreground/70">· {s.pause_reason.replace(/_/g, ' ')}</span>
                        )}
                      </div>
                    </button>
                    {expanded && (
                      <div className="pl-8 pr-3 pb-2 bg-foreground/[0.02] border-t border-border/40">
                        {errorsLoading === s.id ? (
                          <div className="flex items-center gap-2 py-2 text-[10px] text-muted-foreground">
                            <IconLoader2 className="h-3 w-3 animate-spin" /> loading errors…
                          </div>
                        ) : errs.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground italic py-2">No errors logged for this session.</p>
                        ) : (
                          <ul className="space-y-1 py-2">
                            {errs.map((e) => (
                              <li key={e.id} className="text-[10px] flex items-start gap-2">
                                <IconAlertCircle className="h-3 w-3 text-red-500 mt-0.5 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    {e.service && <span className="text-muted-foreground">{e.service}</span>}
                                    {e.error_type && <span className="text-muted-foreground/70">· {e.error_type}</span>}
                                    {e.recovered && <span className="text-emerald-600 dark:text-emerald-400">· recovered</span>}
                                    <span className="text-muted-foreground/60 ml-auto">{fmtRelative(e.occurred_at)}</span>
                                  </div>
                                  <div className="text-foreground/80 break-words">{e.error_message}</div>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="pt-1.5 border-t border-border/40">
                          <Button size="sm" variant="ghost" onClick={() => loadErrors(s.id)} className="h-6 text-[10px] px-2">
                            <IconRefresh className="h-2.5 w-2.5 mr-1" /> Refresh errors
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
