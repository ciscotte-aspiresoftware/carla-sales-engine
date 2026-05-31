// Live "Now sweeping" panel - shows what the cron is doing this second.
//
// Layered hierarchy, top to bottom:
//   1. Stage line: spinner + cell label (e.g. "Sweeping London cell")
//   2. Progress bar: N of M companies processed in the current cell
//   3. Step line: per-company step (e.g. "Scraping foo.co.uk") +
//      a small connection indicator (live / reconnecting)
//
// When idle (no in-flight sweep), the panel collapses to a single
// "waiting" line - gives the user a stable visual anchor without the
// progress bar flashing in/out between cells.

import { Loader2, Wifi, WifiOff } from 'lucide-react'
import { GLASS_SUBTLE } from '@/lib/glass'
import type { SweepProgress } from '@/hooks/use-sweep-events'

interface Props {
  progress: SweepProgress | null
  connected: boolean
}

export default function NowSweepingPanel({ progress, connected }: Props) {
  if (!progress) {
    return (
      <div className={`${GLASS_SUBTLE} px-3 py-2.5 rounded-md`}>
        <div className="flex items-center gap-2 text-xs">
          {connected ? (
            <>
              <Wifi className="h-3 w-3 text-emerald-500" />
              <span className="font-medium text-muted-foreground">Live · waiting for next cell</span>
            </>
          ) : (
            <>
              <WifiOff className="h-3 w-3 text-amber-500" />
              <span className="font-medium text-amber-600 dark:text-amber-400">Reconnecting…</span>
            </>
          )}
        </div>
      </div>
    )
  }

  const { stage, parentCity, stepLabel, companyIdx, totalCompanies } = progress
  const totalKnown = typeof totalCompanies === 'number' && totalCompanies > 0
  // Progress percentage. While we're still in the "fetching places" stage,
  // total isn't known so we show an indeterminate state by floating the
  // bar at ~10 % rather than 0 - gives the user a "we're working" cue
  // instead of a flat empty bar.
  const pct = !totalKnown
    ? 10
    : Math.min(100, Math.max(0, Math.round(((companyIdx ?? 0) / (totalCompanies as number)) * 100)))

  const headerLabel = `Sweeping ${parentCity || 'cell'}${
    stage === 'fetching_places' ? ' - fetching places' : ''
  }`

  return (
    <div className={`${GLASS_SUBTLE} px-3 py-2.5 rounded-md space-y-2`}>
      {/* Header row: spinner + cell label + (right-aligned) connection indicator */}
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 text-sky-500 animate-spin shrink-0" />
        <span className="text-xs font-semibold flex-1 truncate">{headerLabel}</span>
        {connected ? (
          <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 shrink-0" title="Live socket connection">
            <Wifi className="h-2.5 w-2.5" />
            live
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 shrink-0" title="Socket disconnected - reconnecting">
            <WifiOff className="h-2.5 w-2.5" />
            offline
          </span>
        )}
      </div>

      {/* Progress bar - purely visual; numbers go in the right side of the
          row above for compactness. Indeterminate (10 % flat) while we're
          still in the fetching stage. */}
      <div className="h-1.5 rounded-full bg-border/40 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            stage === 'fetching_places'
              ? 'bg-sky-400/70'
              : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Per-step line: what's happening this second + N/M */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground truncate flex-1" title={stepLabel}>
          {stepLabel}
        </span>
        {totalKnown && companyIdx !== null && (
          <span className="text-muted-foreground tabular-nums shrink-0">
            {companyIdx}/{totalCompanies}
          </span>
        )}
      </div>
    </div>
  )
}
