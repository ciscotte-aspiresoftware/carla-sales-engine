"use client"

import { useEffect, useState, useRef, useCallback } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { api } from "@/lib/api"
import type { Campaign } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChevronLeft, Play, ClipboardCheck, Users, Mail,
  CheckCircle2, Clock, TrendingUp, MessageSquare, CalendarCheck,
  Target, Search, PenLine, CheckCheck, Send,
  Calendar, FlaskConical, Beaker,
} from "lucide-react"
import type { CampaignCadence } from "@/lib/types"
import { cn } from "@/lib/utils"

const PIPELINE_STEPS = [
  { key: "scoring",     label: "Scoring prospects",   icon: Target,    desc: "Evaluating each prospect against ICP criteria" },
  { key: "researching", label: "Researching",          icon: Search,    desc: "Synthesising personalisation profiles" },
  { key: "writing",     label: "Writing sequences",   icon: PenLine,   desc: "Generating multi-touch email sequences" },
  { key: "complete",    label: "Complete",             icon: CheckCheck, desc: "Sequences ready for review" },
]

/** Per-campaign schedule + experimental-tool toggles. Drives the in-process
 * APScheduler (auto_send + cadence) and the copywriter's A/B + dry-run modes.
 * All defaults are off so existing demo flows behave as before. */
function ScheduleAndTools({ campaign, onChange }: { campaign: Campaign; onChange: () => void }) {
  const [saving, setSaving] = useState(false)

  const patch = async (data: Partial<Campaign>) => {
    setSaving(true)
    try {
      await api.updateCampaign(campaign.id, data)
      onChange()
    } finally { setSaving(false) }
  }

  const cadenceLabels: Record<CampaignCadence, string> = {
    immediate: "Immediate",
    next_business_day_9am: "Next business day · 09:00",
    weekly_tuesday_10am: "Weekly · Tuesday 10:00",
    custom: "Custom cron",
  }

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5" />
          Schedule & Tools
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-gray-200 font-medium">Auto-send</div>
            <div className="text-[11px] text-gray-500">
              When enabled, approved sequences self-send per the cadence below. Defaults to manual approval.
            </div>
          </div>
          <button
            onClick={() => patch({ auto_send: !campaign.auto_send })}
            disabled={saving}
            className={cn(
              "px-3 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-40",
              campaign.auto_send
                ? "bg-emerald-900/40 text-emerald-300 border-emerald-700"
                : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300",
            )}
          >
            {campaign.auto_send ? "On" : "Off"}
          </button>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm text-gray-200 font-medium">Cadence</div>
            <div className="text-[11px] text-gray-500">Resolved against the engine's configured timezone + business hours.</div>
          </div>
          <select
            value={campaign.send_cadence}
            disabled={saving || !campaign.auto_send}
            onChange={(e) => patch({ send_cadence: e.target.value as CampaignCadence })}
            className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 disabled:opacity-40"
          >
            {Object.entries(cadenceLabels).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        {campaign.send_cadence === "custom" && (
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-gray-500">Cron (5 fields, mm hh dom mon dow)</div>
            <input
              defaultValue={campaign.cadence_custom_cron || ""}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (campaign.cadence_custom_cron || "")) patch({ cadence_custom_cron: v || null })
              }}
              placeholder="0 9 * * 1-5"
              className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 font-mono w-44"
            />
          </div>
        )}

        <div className="border-t border-gray-800 pt-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <FlaskConical className="w-4 h-4 mt-0.5 text-violet-400 shrink-0" />
              <div>
                <div className="text-sm text-gray-200 font-medium">A/B test variants</div>
                <div className="text-[11px] text-gray-500">
                  Copywriter generates two variants per touch; classifier attributes replies per variant.
                </div>
              </div>
            </div>
            <button
              onClick={() => patch({ ab_test: !campaign.ab_test })}
              disabled={saving}
              className={cn(
                "px-3 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-40",
                campaign.ab_test
                  ? "bg-violet-900/40 text-violet-300 border-violet-700"
                  : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300",
              )}
            >
              {campaign.ab_test ? "On" : "Off"}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <Beaker className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
              <div>
                <div className="text-sm text-gray-200 font-medium">Dry-run mode</div>
                <div className="text-[11px] text-gray-500">
                  mark_sent emits a "dry_run_send" activity event instead of flipping sent_at — safe to validate cadences end-to-end.
                </div>
              </div>
            </div>
            <button
              onClick={() => patch({ dry_run: !campaign.dry_run })}
              disabled={saving}
              className={cn(
                "px-3 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-40",
                campaign.dry_run
                  ? "bg-amber-900/40 text-amber-300 border-amber-700"
                  : "bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300",
              )}
            >
              {campaign.dry_run ? "On" : "Off"}
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function PipelineProgress({ campaignId, onComplete }: { campaignId: number; onComplete: () => void }) {
  const [status, setStatus] = useState({ step: "scoring", message: "", done: 0, total: 0 })
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      try {
        const s = await api.getPipelineStatus(campaignId)
        if (cancelled) return
        setStatus(s)
        if (s.step === "complete") {
          setTimeout(() => onCompleteRef.current(), 1200)
        } else {
          setTimeout(poll, 2500)
        }
      } catch {
        if (!cancelled) setTimeout(poll, 3000)
      }
    }

    // Small delay so backend background task has time to call set_progress
    setTimeout(poll, 1500)
    return () => { cancelled = true }
  }, [campaignId])

  const currentStepIdx = PIPELINE_STEPS.findIndex((s) => s.key === status.step)

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
          <span className="text-sm font-medium text-white">AI Pipeline Running</span>
          {status.total > 0 && (
            <span className="text-xs text-gray-500 ml-auto">{status.done}/{status.total} prospects</span>
          )}
        </div>

        {/* Step indicators */}
        <div className="space-y-3">
          {PIPELINE_STEPS.map((step, i) => {
            const isDone = currentStepIdx > i || status.step === "complete"
            const isActive = status.step === step.key
            const Icon = step.icon
            return (
              <div key={step.key} className="flex items-start gap-3">
                <div className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all",
                  isDone ? "bg-emerald-900/60 border border-emerald-700" :
                  isActive ? "bg-sky-900/60 border border-sky-600 animate-pulse" :
                  "bg-gray-800 border border-gray-700"
                )}>
                  <Icon className={cn(
                    "w-3.5 h-3.5",
                    isDone ? "text-emerald-400" : isActive ? "text-sky-400" : "text-gray-600"
                  )} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    "text-sm font-medium",
                    isDone ? "text-emerald-400" : isActive ? "text-white" : "text-gray-600"
                  )}>
                    {step.label}
                  </div>
                  {isActive && status.message && (
                    <div className="text-xs text-gray-400 truncate mt-0.5">{status.message}</div>
                  )}
                  {!isActive && (
                    <div className="text-xs text-gray-600">{step.desc}</div>
                  )}
                </div>
                {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-1" />}
              </div>
            )
          })}
        </div>

        {status.total > 0 && status.step !== "complete" && (
          <div className="mt-4">
            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-sky-600 rounded-full transition-all duration-500"
                style={{ width: `${Math.round((status.done / status.total) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)

  const load = () => {
    api.getCampaign(Number(id))
      .then(setCampaign)
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  const runPipeline = async () => {
    setRunning(true)
    await api.runPipeline(Number(id))
  }

  const handlePipelineComplete = () => {
    setRunning(false)
    load()
  }

  const sendApproved = async () => {
    setSending(true)
    const res = await api.getSequences({ campaign_id: Number(id), approval_status: "approved" })
    const toSend = res.sequences.filter((s) => !s.sent_at)
    await Promise.all(toSend.map((s) => api.markSent(s.id)))
    setSending(false)
    load()
  }

  if (loading) return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-8 w-48 bg-gray-800" />
      <Skeleton className="h-32 bg-gray-800 rounded-lg" />
    </div>
  )

  if (!campaign) return <div className="p-6 text-gray-500">Campaign not found.</div>

  const s = campaign.stats

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/campaigns">
          <Button variant="ghost" size="sm" className="text-gray-400 -ml-2">
            <ChevronLeft className="w-4 h-4" /> Campaigns
          </Button>
        </Link>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">{campaign.name}</h1>
          <div className="flex items-center gap-2 mt-1.5">
            <Badge className="text-[10px] border bg-sky-900/30 text-sky-300 border-sky-800">{campaign.vertical_pack}</Badge>
            <Badge className="text-[10px] border bg-blue-900/30 text-blue-300 border-blue-800">{campaign.regional_pack}</Badge>
            <Badge className="text-[10px] border bg-gray-800 text-gray-400 border-gray-700">{campaign.status}</Badge>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {s && s.approved > s.sent && (
            <Button
              size="sm"
              onClick={sendApproved}
              disabled={sending}
              className="bg-sky-600 hover:bg-sky-500 text-white"
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
              {sending ? "Sending..." : `Send ${s.approved - s.sent} Approved Email${(s.approved - s.sent) !== 1 ? "s" : ""}`}
            </Button>
          )}
          {s && s.pending_approval > 0 && (
            <Link href={`/campaigns/${id}/review`}>
              <Button size="sm" className="bg-amber-600 hover:bg-amber-500 text-white">
                <ClipboardCheck className="w-3.5 h-3.5 mr-1.5" />
                Review {s.pending_approval} Emails
              </Button>
            </Link>
          )}
          {!running && s && s.emails_generated === 0 && (
            <Button size="sm" onClick={runPipeline} className="bg-sky-600 hover:bg-sky-500">
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Run AI Pipeline
            </Button>
          )}
        </div>
      </div>

      {running && (
        <PipelineProgress campaignId={Number(id)} onComplete={handlePipelineComplete} />
      )}

      {/* Stats Grid */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          {[
            { label: "Enrolled",  value: s.enrolled,           icon: Users,          color: "text-gray-300" },
            { label: "Generated", value: s.emails_generated,   icon: Mail,           color: "text-gray-300" },
            { label: "Pending",   value: s.pending_approval,   icon: Clock,          color: "text-amber-400" },
            { label: "Approved",  value: s.approved,           icon: CheckCircle2,   color: "text-emerald-400" },
            { label: "Sent",      value: s.sent,               icon: Mail,           color: "text-sky-400" },
            { label: "Open Rate", value: `${s.open_rate}%`,    icon: TrendingUp,     color: "text-sky-400" },
            { label: "Replies",   value: s.replies,            icon: MessageSquare,  color: "text-violet-400" },
            { label: "Meetings",  value: s.meetings_booked,    icon: CalendarCheck,  color: "text-emerald-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-gray-900 border-gray-800">
              <CardContent className="p-3 text-center">
                <Icon className={`w-3.5 h-3.5 mx-auto mb-1 ${color}`} />
                <div className={`text-lg font-bold ${color}`}>{value}</div>
                <div className="text-[10px] text-gray-600">{label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ScheduleAndTools campaign={campaign} onChange={load} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ["Vertical pack",          campaign.vertical_pack],
              ["Regional pack",          campaign.regional_pack],
              ["Touches",                campaign.sequence_touches],
              ["Delay between touches",  `${campaign.touch_delay_days} days`],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between py-1.5 border-b border-gray-800">
                <span className="text-gray-500">{label}</span>
                <span className="text-gray-200">{value}</span>
              </div>
            ))}
            <div className="flex justify-between py-1.5 border-b border-gray-800">
              <span className="text-gray-500">Campaign brief</span>
              {campaign.campaign_brief_title ? (
                <span className="text-gray-200 text-right max-w-[60%] truncate" title={campaign.campaign_brief_title}>
                  {campaign.campaign_brief_title}
                </span>
              ) : (
                <span className="text-gray-600 italic text-xs self-center">
                  Generated after pipeline runs
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {s && s.approved > s.sent && (
              <Button
                onClick={sendApproved}
                disabled={sending}
                className="w-full justify-start bg-sky-600 hover:bg-sky-500 text-sm"
              >
                <Send className="w-4 h-4 mr-2" />
                {sending ? "Sending..." : `Send ${s.approved - s.sent} Approved Email${(s.approved - s.sent) !== 1 ? "s" : ""}`}
              </Button>
            )}
            <Link href={`/campaigns/${id}/review`} className="block">
              <Button variant="outline" className="w-full justify-start border-gray-700 text-gray-300 hover:text-white text-sm">
                <ClipboardCheck className="w-4 h-4 mr-2 text-amber-400" />
                Review & Approve Emails
              </Button>
            </Link>
            <Button
              variant="outline"
              onClick={runPipeline}
              disabled={running}
              className="w-full justify-start border-gray-700 text-gray-300 hover:text-white text-sm"
            >
              <Play className="w-4 h-4 mr-2 text-sky-400" />
              {running ? "Pipeline running..." : "Re-run AI Pipeline"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
