"use client"

import { useEffect, useRef } from "react"
import type { DiscoveryEvent, DiscoveryStep } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Brain, Globe, FileText, Save, CheckCircle2, AlertTriangle, Eye } from "lucide-react"

const STEP_META: Record<DiscoveryStep, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  idle:             { label: "Idle",       icon: Brain,         color: "text-gray-500",    bg: "bg-gray-900" },
  generating:       { label: "Generate",   icon: Brain,         color: "text-violet-400",  bg: "bg-violet-950/40" },
  ready_for_review: { label: "Review",     icon: Eye,           color: "text-amber-400",   bg: "bg-amber-950/40" },
  verifying:        { label: "Tavily",     icon: Globe,         color: "text-sky-400",     bg: "bg-sky-950/40" },
  enriching:        { label: "Enrich",     icon: FileText,      color: "text-emerald-400", bg: "bg-emerald-950/40" },
  saving:           { label: "Save",       icon: Save,          color: "text-emerald-400", bg: "bg-emerald-950/40" },
  complete:         { label: "Done",       icon: CheckCircle2,  color: "text-emerald-400", bg: "bg-emerald-950/40" },
  error:            { label: "Error",      icon: AlertTriangle, color: "text-red-400",     bg: "bg-red-950/40" },
}

function formatClock(iso: string): string {
  // ISO timestamps from the backend look like "2026-05-08T10:53:33+00:00".
  // We only need HH:MM:SS in the user's wall clock — Date() handles the parse.
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return "--:--:--"
    return d.toLocaleTimeString("en-GB", { hour12: false })
  } catch {
    return "--:--:--"
  }
}

interface DiscoveryTranscriptProps {
  events: DiscoveryEvent[]
  /**
   * When true, the transcript auto-scrolls to the latest event as new ones
   * arrive. Set false on the "done" view if you want the user to start at
   * the top and scroll through the run themselves.
   */
  autoScroll?: boolean
  className?: string
  emptyHint?: string
}

/**
 * Persistent, scrollable transcript of a discovery run.
 *
 * Reads the `events` array surfaced by /agents/discover/status and renders
 * one row per event with a wall-clock timestamp, a colour-coded step chip,
 * and the message verbatim — including the exact Tavily query strings.
 *
 * Used by both the legacy one-shot page and the wizard so a user can scroll
 * back through what happened at every step, even after the run completes.
 */
export function DiscoveryTranscript({
  events,
  autoScroll = true,
  className,
  emptyHint = "No events yet — the transcript will populate as the run progresses.",
}: DiscoveryTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)

  useEffect(() => {
    if (!autoScroll) return
    if (events.length === lastCountRef.current) return
    lastCountRef.current = events.length
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events, autoScroll])

  return (
    <div
      className={cn(
        "rounded-md border border-gray-800 bg-gray-950/60",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-gray-500" />
          <span className="text-[11px] font-semibold text-gray-300 uppercase tracking-wider">
            Discovery transcript
          </span>
        </div>
        <span className="text-[11px] text-gray-500">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="max-h-72 overflow-y-auto p-2 space-y-1 font-mono text-[11px] leading-snug"
      >
        {events.length === 0 ? (
          <div className="px-2 py-3 text-gray-600 italic">{emptyHint}</div>
        ) : (
          events.map((e, i) => {
            const meta = STEP_META[e.step] ?? STEP_META.idle
            const Icon = meta.icon
            return (
              <div
                key={`${e.ts}-${i}`}
                className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-gray-900/50"
              >
                <span className="text-gray-600 shrink-0 tabular-nums">
                  {formatClock(e.ts)}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0",
                    meta.color,
                    meta.bg,
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {meta.label}
                </span>
                <span className="text-gray-300 break-words min-w-0">{e.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
