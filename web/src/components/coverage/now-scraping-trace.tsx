// "Now scraping" trace - compact list of the last few company-level events
// from the live activity stream. Sits between NowSweepingPanel (one current
// step) and ActivityLog (full historical timeline), surfacing recent verdicts
// at a glance so the operator can see "we just qualified Acme, just rejected
// Foo" without scrolling the log.
//
// Inspired by Aaron SDR's ScrapeTraceBox pattern - focused on what's
// happening right now, with status icons per company.

import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { GLASS_SUBTLE } from '@/lib/glass'

// Subset of the ActivityEvent shape we care about - just the company-level
// event types. Defined here as a structural type so it stays decoupled from
// the page's full ActivityEvent (which has many more fields).
interface CompanyEvent {
  id: number
  type: string
  domain?: string
  title?: string
  reason?: string
  ts: number
}

interface Props {
  events: CompanyEvent[]
  // Max rows to show. Default 5 - enough to feel alive, short enough to glance.
  limit?: number
}

const COMPANY_TYPES = new Set([
  'company_scrape_start',
  'company_classify_start',
  'company_qualified',
  'company_rejected',
])

export default function NowScrapingTrace({ events, limit = 5 }: Props) {
  // Keep the LATEST event per company - we don't want a single Acme to take
  // up two rows for "scrape_start" AND "qualified". Group by domain || title.
  const latestByCompany = new Map<string, CompanyEvent>()
  for (const e of events) {
    if (!COMPANY_TYPES.has(e.type)) continue
    const key = (e.domain || e.title || `e:${e.id}`).toLowerCase()
    const existing = latestByCompany.get(key)
    if (!existing || existing.id < e.id) latestByCompany.set(key, e)
  }
  const rows = Array.from(latestByCompany.values())
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)

  if (rows.length === 0) return null

  return (
    <div className={`${GLASS_SUBTLE} px-3 py-2 rounded-md space-y-1.5`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Now scraping</div>
      <ul className="space-y-1">
        {rows.map((e) => {
          const name = e.title || e.domain || '(unnamed)'
          return (
            <li key={e.id} className="flex items-center gap-2 text-[11px] leading-tight">
              <StatusIcon type={e.type} />
              <span className="truncate flex-1 font-medium" title={name}>{name}</span>
              <StatusBadge type={e.type} reason={e.reason} />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StatusIcon({ type }: { type: string }) {
  if (type === 'company_qualified') {
    return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
  }
  if (type === 'company_rejected') {
    return <XCircle className="h-3 w-3 text-red-500 shrink-0" />
  }
  // scrape_start / classify_start - still in flight
  return <Loader2 className="h-3 w-3 text-sky-500 animate-spin shrink-0" />
}

function StatusBadge({ type, reason }: { type: string; reason?: string }) {
  if (type === 'company_qualified') {
    return <span className="text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0">qualified</span>
  }
  if (type === 'company_rejected') {
    return (
      <span
        className="text-[10px] text-red-600 dark:text-red-400 shrink-0 max-w-[140px] truncate"
        title={reason}
      >
        rejected
      </span>
    )
  }
  if (type === 'company_classify_start') {
    return <span className="text-[10px] text-sky-600 dark:text-sky-400 shrink-0">classifying…</span>
  }
  return <span className="text-[10px] text-muted-foreground shrink-0">scraping…</span>
}