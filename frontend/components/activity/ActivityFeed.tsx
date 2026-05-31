"use client"

import { useEffect, useState, useRef } from "react"
import { api } from "@/lib/api"
import type { ActivityEvent } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePoll } from "@/lib/use-poll"
import {
  Mail, Eye, MousePointerClick, MessageSquare, CalendarCheck,
  UserX, Cpu, Coins,
} from "lucide-react"

const EVENT_META: Record<string, { icon: React.ElementType; label: string; color: string; bg: string }> = {
  sent:                { icon: Mail,            label: "Email sent",        color: "text-gray-400",   bg: "bg-gray-800" },
  open:                { icon: Eye,             label: "Opened",            color: "text-sky-400",    bg: "bg-sky-950" },
  click:               { icon: MousePointerClick, label: "Clicked link",   color: "text-blue-400",   bg: "bg-blue-950" },
  reply:               { icon: MessageSquare,  label: "Replied",           color: "text-violet-400", bg: "bg-violet-950" },
  meeting_booked:      { icon: CalendarCheck,  label: "Meeting booked",    color: "text-emerald-400", bg: "bg-emerald-950" },
  unsubscribe:         { icon: UserX,          label: "Unsubscribed",      color: "text-red-400",    bg: "bg-red-950" },
  ooo:                 { icon: Mail,           label: "Out of office",     color: "text-yellow-400", bg: "bg-yellow-950" },
  pipeline_completed:  { icon: Cpu,            label: "Pipeline complete", color: "text-purple-400", bg: "bg-purple-950" },
  pipeline_started:    { icon: Cpu,            label: "Pipeline started",  color: "text-purple-400", bg: "bg-purple-950" },
  llm_call:            { icon: Coins,          label: "Claude call",       color: "text-amber-400",  bg: "bg-amber-950" },
}

// Maps the agent ids the backend records into reader-friendly labels.
const AGENT_LABELS: Record<string, string> = {
  discovery_generate: "Discovery (generate)",
  discovery_enrich:   "Discovery (enrich)",
  prospector:         "ICP scoring",
  researcher:         "Research profile",
  copywriter:         "Email sequence",
  optimizer_recommendations: "Revenue Optimizer",
  pack_generate_icp:           "Pack — ICP",
  pack_generate_personas:      "Pack — Personas",
  pack_generate_messaging:     "Pack — Messaging",
  pack_generate_email_guidance: "Pack — Email guidance",
  pack_generate_regional:      "Pack — Regional",
}

function fmtCost(usd: number): string {
  if (usd === 0) return "—"
  if (usd < 0.001) return "<$0.001"
  if (usd < 0.01)  return `$${usd.toFixed(4)}`
  if (usd < 1)     return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60000) return "just now"
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

interface ActivityFeedProps {
  limit?: number
  compact?: boolean
  campaignId?: number
  prospectId?: number
}

export function ActivityFeed({ limit = 20, compact = false, campaignId, prospectId }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    api.getActivity({ campaign_id: campaignId, limit })
      .then((r) => {
        if (mountedRef.current) setEvents(r.events)
      })
      .finally(() => { if (mountedRef.current) setLoading(false) })
  }, [campaignId, prospectId, limit])

  // Refresh on a 5s cadence on the full-page activity view. usePoll
  // pauses entirely when the tab is hidden (so a backgrounded dashboard
  // stops hitting /activity), and cancels the in-flight fetch on unmount
  // via the supplied AbortSignal.
  usePoll(async () => {
    const r = await api.getActivity({ campaign_id: campaignId, limit })
    if (mountedRef.current) setEvents(r.events)
  }, { interval: 5000, enabled: !compact, initialDelay: 5000 })

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: compact ? 4 : 6 }).map((_, i) => (
          <div key={i} className="h-10 bg-gray-800 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-gray-600 text-sm">
        No activity yet. Run a campaign pipeline to generate events.
      </div>
    )
  }

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      {events.map((event) => {
        const meta = EVENT_META[event.event_type] ?? EVENT_META.sent
        const Icon = meta.icon

        // For llm_call events, the headline is the agent + a short model id, with the
        // dollar cost on the right replacing the relative-time string.
        const isLLM = event.event_type === "llm_call"
        const llmData = isLLM
          ? (event.event_data as { agent?: string; model?: string; cost_usd?: number; input_tokens?: number; output_tokens?: number; thinking_tokens?: number; duration_ms?: number } | null)
          : null
        const llmAgent = llmData?.agent ? (AGENT_LABELS[llmData.agent] ?? llmData.agent) : ""
        const llmModelShort = (llmData?.model ?? "").replace(/^claude-/, "").replace(/-20\d{6}$/, "")
        const llmTotalTokens = (llmData?.input_tokens ?? 0) + (llmData?.output_tokens ?? 0) + (llmData?.thinking_tokens ?? 0)

        const headline = isLLM
          ? `${llmAgent}${llmModelShort ? ` · ${llmModelShort}` : ""}`
          : (event.business_name ?? event.campaign_name ?? "Unknown")

        return (
          <div
            key={event.id}
            className={cn(
              "flex items-center gap-3 rounded-lg transition-colors",
              compact ? "px-0 py-1" : "px-3 py-2.5 bg-gray-900 border border-gray-800"
            )}
          >
            <div className={cn("p-1.5 rounded-lg shrink-0", meta.bg)}>
              <Icon className={cn("shrink-0", meta.color, compact ? "w-3 h-3" : "w-3.5 h-3.5")} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className={cn("font-medium text-white truncate", compact ? "text-xs" : "text-sm")}>
                  {headline}
                </span>
                <span className={cn("text-gray-500 shrink-0", compact ? "text-[10px]" : "text-xs")}>
                  {isLLM
                    ? `${fmtTokens(llmTotalTokens)} tok${llmData?.duration_ms ? ` · ${(llmData.duration_ms / 1000).toFixed(1)}s` : ""}`
                    : meta.label}
                </span>
              </div>
              {!compact && !isLLM && event.campaign_name && (
                <div className="text-[11px] text-gray-600 truncate">{event.campaign_name}</div>
              )}
              {!compact && isLLM && (event.campaign_name || event.business_name) && (
                <div className="text-[11px] text-gray-600 truncate">
                  {[event.business_name, event.campaign_name].filter(Boolean).join(" · ")}
                </div>
              )}
              {!compact && event.event_type === "reply" && event.event_data && (
                <div className="text-[11px] text-gray-500 mt-0.5 truncate italic">
                  "{(event.event_data as { text?: string }).text?.slice(0, 80)}..."
                </div>
              )}
            </div>
            {isLLM ? (
              <span className={cn("font-medium tabular-nums text-amber-400 shrink-0", compact ? "text-[10px]" : "text-xs")}
                title={`${formatTime(event.occurred_at)} · ${llmTotalTokens.toLocaleString()} tokens`}>
                {fmtCost(llmData?.cost_usd ?? 0)}
              </span>
            ) : (
              <span className={cn("text-gray-600 shrink-0", compact ? "text-[10px]" : "text-xs")}>
                {formatTime(event.occurred_at)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
