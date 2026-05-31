"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { api } from "@/lib/api"
import type { Campaign } from "@/lib/types"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  Megaphone, Plus, Users, Mail, CheckCircle2, Clock,
  TrendingUp, ChevronRight, Play,
} from "lucide-react"
import { useVertical } from "@/lib/vertical-context"

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft:     { color: "bg-gray-800 text-gray-400 border-gray-700", label: "Draft" },
  running:   { color: "bg-sky-900/40 text-sky-400 border-sky-800", label: "Running" },
  paused:    { color: "bg-yellow-900/40 text-yellow-400 border-yellow-800", label: "Paused" },
  completed: { color: "bg-emerald-900/40 text-emerald-400 border-emerald-800", label: "Completed" },
}

const PACK_COLORS: Record<string, string> = {
  car_rental: "bg-purple-900/30 text-purple-300 border-purple-800",
}

const REGION_COLORS: Record<string, string> = {
  us_en: "bg-blue-900/30 text-blue-300 border-blue-800",
  nl_nl: "bg-orange-900/30 text-orange-300 border-orange-800",
  au_en: "bg-green-900/30 text-green-300 border-green-800",
}

export default function CampaignsPage() {
  const { vertical, verticalOption } = useVertical()
  const [allCampaigns, setAllCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getCampaigns()
      .then((r) => setAllCampaigns(r.campaigns))
      .finally(() => setLoading(false))
  }, [])

  // Filter campaigns by selected vertical
  const campaigns = allCampaigns.filter((c) => !vertical || c.vertical_pack === vertical)

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Megaphone className={`w-5 h-5 ${verticalOption.color}`} />
            {verticalOption.label} Campaigns
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">{campaigns.length} campaigns</p>
        </div>
        <Link href="/campaigns/new">
          <Button className="bg-sky-600 hover:bg-sky-500 text-white text-sm">
            <Plus className="w-4 h-4 mr-1.5" />
            New Campaign
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <Card key={i} className="bg-gray-900 border-gray-800">
              <CardContent className="p-5 space-y-3">
                <Skeleton className="h-5 w-48 bg-gray-800" />
                <Skeleton className="h-4 w-32 bg-gray-800" />
                <Skeleton className="h-10 bg-gray-800 rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-12 text-center">
            <Megaphone className="w-10 h-10 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500 text-sm mb-4">No campaigns yet.</p>
            <Link href="/campaigns/new">
              <Button size="sm" className="bg-sky-600 hover:bg-sky-500">Create First Campaign</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {campaigns.map((c) => {
            const statusMeta = STATUS_META[c.status] ?? STATUS_META.draft
            const stats = c.stats
            return (
              <Card key={c.id} className="bg-gray-900 border-gray-800 hover:border-gray-700 transition-colors">
                <CardHeader className="pb-3 pt-4 px-5">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <h2 className="font-semibold text-white text-sm truncate">{c.name}</h2>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        <Badge className={`text-[10px] px-1.5 py-0 border ${statusMeta.color}`}>
                          {statusMeta.label}
                        </Badge>
                        <Badge className={`text-[10px] px-1.5 py-0 border ${PACK_COLORS[c.vertical_pack] ?? "bg-gray-800 text-gray-400 border-gray-700"}`}>
                          {c.vertical_pack}
                        </Badge>
                        <Badge className={`text-[10px] px-1.5 py-0 border ${REGION_COLORS[c.regional_pack] ?? "bg-gray-800 text-gray-400 border-gray-700"}`}>
                          {c.regional_pack}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-5 pb-4 space-y-3">
                  {/* Stats row */}
                  {stats && (
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { label: "Enrolled", value: stats.enrolled, icon: Users },
                        { label: "Sent", value: stats.sent, icon: Mail },
                        { label: "Approved", value: stats.approved, icon: CheckCircle2 },
                        { label: "Pending", value: stats.pending_approval, icon: Clock },
                      ].map(({ label, value, icon: Icon }) => (
                        <div key={label} className="bg-gray-800/50 rounded-lg p-2 text-center">
                          <div className="text-sm font-semibold text-white">{value}</div>
                          <div className="text-[10px] text-gray-500">{label}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {stats && (stats.emails_generated > 0 || stats.sent > 0) && (
                    <div className="flex items-center gap-4 text-xs text-gray-500 pt-1">
                      <span className="flex items-center gap-1">
                        <TrendingUp className="w-3 h-3 text-sky-400" />
                        {stats.open_rate}% open rate
                      </span>
                      <span>{stats.reply_rate}% reply rate</span>
                      {stats.meetings_booked > 0 && (
                        <span className="text-emerald-400">{stats.meetings_booked} meetings booked</span>
                      )}
                    </div>
                  )}
                  <div className="flex gap-2 pt-1">
                    {stats && stats.pending_approval > 0 && (
                      <Link href={`/campaigns/${c.id}/review`} className="flex-1">
                        <Button size="sm" variant="outline" className="w-full border-amber-800 text-amber-400 hover:bg-amber-950 text-xs">
                          <Clock className="w-3 h-3 mr-1" />
                          Review {stats.pending_approval} emails
                        </Button>
                      </Link>
                    )}
                    {stats && stats.enrolled > 0 && stats.emails_generated === 0 && (
                      <RunPipelineButton campaignId={c.id} onDone={() => {
                        api.getCampaigns().then((r) => setAllCampaigns(r.campaigns))
                      }} />
                    )}
                    <Link href={`/campaigns/${c.id}`}>
                      <Button size="sm" variant="ghost" className="text-gray-400 hover:text-white text-xs">
                        Details <ChevronRight className="w-3 h-3 ml-1" />
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RunPipelineButton({ campaignId, onDone }: { campaignId: number; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const run = async () => {
    setRunning(true)
    await api.runPipeline(campaignId)
    const poll = async (attempts: number) => {
      const updated = await api.getCampaign(campaignId)
      if ((updated.stats?.emails_generated ?? 0) > 0) {
        setRunning(false)
        onDone()
      } else if (attempts < 24) {
        setTimeout(() => poll(attempts + 1), 5000)
      } else {
        setRunning(false)
        onDone()
      }
    }
    setTimeout(() => poll(0), 5000)
  }
  return (
    <Button size="sm" onClick={run} disabled={running} className="bg-sky-600 hover:bg-sky-500 text-xs">
      <Play className={`w-3 h-3 mr-1 ${running ? "animate-pulse" : ""}`} />
      {running ? "Running AI..." : "Run Pipeline"}
    </Button>
  )
}
