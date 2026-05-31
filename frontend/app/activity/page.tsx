"use client"

import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { Campaign } from "@/lib/types"
import { ActivityFeed } from "@/components/activity/ActivityFeed"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Activity } from "lucide-react"

export default function ActivityPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<string>("all")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getCampaigns()
      .then((r) => setCampaigns(r.campaigns))
      .finally(() => setLoading(false))
  }, [])

  const campaignId = selectedCampaign !== "all" ? Number(selectedCampaign) : undefined

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" />
            Activity Feed
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Live engagement events — opens, clicks, replies, meetings</p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Skeleton className="h-9 w-40 bg-gray-800" />
          ) : (
            <Select value={selectedCampaign} onValueChange={(v) => setSelectedCampaign(v ?? "all")}>
              <SelectTrigger className="bg-gray-800 border-gray-700 text-sm w-52">
                <SelectValue placeholder="All campaigns" />
              </SelectTrigger>
              <SelectContent className="bg-gray-900 border-gray-700">
                <SelectItem value="all">All campaigns</SelectItem>
                {campaigns.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Main Feed */}
        <div className="lg:col-span-2">
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live events
                </span>
                <span className="text-gray-600 normal-case font-normal">auto-refreshes every 5s</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityFeed
                limit={50}
                compact={false}
                campaignId={campaignId}
              />
            </CardContent>
          </Card>
        </div>

        {/* Sidebar: Event legend + simulate info */}
        <div className="space-y-4">
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Event Types</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {[
                { type: "sent",             label: "Email sent",       color: "text-gray-400",    dot: "bg-gray-500" },
                { type: "open",             label: "Email opened",     color: "text-sky-400",     dot: "bg-sky-500" },
                { type: "click",            label: "Link clicked",     color: "text-blue-400",    dot: "bg-blue-500" },
                { type: "reply",            label: "Reply received",   color: "text-violet-400",  dot: "bg-violet-500" },
                { type: "meeting_booked",   label: "Meeting booked",   color: "text-emerald-400", dot: "bg-emerald-500" },
                { type: "unsubscribe",      label: "Unsubscribed",     color: "text-red-400",     dot: "bg-red-500" },
                { type: "pipeline_completed", label: "Pipeline complete", color: "text-purple-400", dot: "bg-purple-500" },
              ].map(({ label, color, dot }) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                  <span className={color}>{label}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Architecture Note</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-gray-500 space-y-2">
              <p>
                In production this feed would be powered by <span className="text-gray-300">SSE (Server-Sent Events)</span> via a <code className="text-sky-400">/activity/stream</code> endpoint.
              </p>
              <p>The SSE endpoint is implemented at the backend — this demo uses polling for compatibility with the Next.js dev server proxy.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
