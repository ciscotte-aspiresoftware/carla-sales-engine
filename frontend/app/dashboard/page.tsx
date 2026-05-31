"use client"

import { useEffect, useState, useMemo } from "react"
import Link from "next/link"
import { api } from "@/lib/api"
import type { Campaign, Prospect } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts"
import {
  Mail, MousePointerClick, MessageSquare, CalendarCheck,
  Users, TrendingUp, Megaphone, ChevronRight, Clock, CheckCircle2,
} from "lucide-react"
import { ActivityFeed } from "@/components/activity/ActivityFeed"
import { useVertical } from "@/lib/vertical-context"
import { COUNTRY_NAMES } from "@/lib/countries"

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({
  title, value, subtitle, icon: Icon, color = "text-sky-400",
}: {
  title: string; value: string | number; subtitle?: string
  icon: React.ElementType; color?: string
}) {
  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wider">{title}</p>
            <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <div className="p-2 rounded-lg bg-gray-800">
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Campaign mini-card ────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  running:   "bg-sky-400",
  draft:     "bg-gray-500",
  paused:    "bg-yellow-400",
  completed: "bg-emerald-400",
}

function CampaignCard({ c }: { c: Campaign }) {
  const dot = STATUS_DOT[c.status] ?? "bg-gray-500"
  const stats = c.stats
  return (
    <Link href={`/campaigns/${c.id}`}>
      <div className="group bg-gray-800/50 hover:bg-gray-800 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-all cursor-pointer h-full">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
              <span className="text-sm font-medium text-white truncate">{c.name}</span>
            </div>
            <div className="text-[11px] text-gray-500 ml-3.5 capitalize">{c.status}</div>
          </div>
          <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 shrink-0 mt-0.5 transition-colors" />
        </div>
        {stats && (
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { label: "Enrolled", value: stats.enrolled,         icon: Users },
              { label: "Sent",     value: stats.sent,             icon: Mail },
              { label: "Pending",  value: stats.pending_approval, icon: Clock },
              { label: "Approved", value: stats.approved,         icon: CheckCircle2 },
            ].map(({ label, value }) => (
              <div key={label} className="text-center bg-gray-900/60 rounded-lg py-1.5">
                <div className="text-sm font-semibold text-white">{value}</div>
                <div className="text-[10px] text-gray-600">{label}</div>
              </div>
            ))}
          </div>
        )}
        {stats && stats.sent > 0 && (
          <div className="mt-2.5 pt-2 border-t border-gray-700/50 flex gap-3 text-[11px] text-gray-500">
            <span><span className="text-emerald-400 font-medium">{stats.open_rate}%</span> open</span>
            <span><span className="text-sky-400 font-medium">{stats.reply_rate}%</span> reply</span>
            {stats.meetings_booked > 0 && (
              <span><span className="text-amber-400 font-medium">{stats.meetings_booked}</span> meetings</span>
            )}
          </div>
        )}
      </div>
    </Link>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const FUNNEL_COLORS = ["#0ea5e9", "#38bdf8", "#7dd3fc", "#bae6fd"]

export default function DashboardPage() {
  const { vertical, verticalOption } = useVertical()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [prospects, setProspects] = useState<Prospect[]>([])
  const [prospectTotal, setProspectTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getCampaigns({ vertical: vertical || undefined }),
      api.getProspects({ vertical: vertical || undefined, limit: 500 }),
    ]).then(([cRes, pRes]) => {
      setCampaigns(cRes.campaigns)
      setProspects(pRes.prospects)
      setProspectTotal(pRes.total)
    }).finally(() => setLoading(false))
  }, [vertical])

  // Compute KPIs from campaign stats
  const kpis = useMemo(() => {
    const totalSent = campaigns.reduce((s, c) => s + (c.stats?.sent ?? 0), 0)
    const meetings  = campaigns.reduce((s, c) => s + (c.stats?.meetings_booked ?? 0), 0)
    let openNum = 0, replyNum = 0, denom = 0
    campaigns.forEach(c => {
      const sent = c.stats?.sent ?? 0
      if (sent > 0) {
        openNum  += (c.stats?.open_rate  ?? 0) * sent
        replyNum += (c.stats?.reply_rate ?? 0) * sent
        denom    += sent
      }
    })
    const openRate  = denom > 0 ? +(openNum  / denom).toFixed(1) : 0
    const replyRate = denom > 0 ? +(replyNum / denom).toFixed(1) : 0
    const active    = campaigns.filter(c => c.status === "running").length
    return { totalSent, openRate, replyRate, meetings, active }
  }, [campaigns])

  // Funnel
  const funnelData = useMemo(() => [
    { name: "Prospects", value: prospectTotal,                                         fill: FUNNEL_COLORS[0] },
    { name: "Contacted", value: kpis.totalSent,                                        fill: FUNNEL_COLORS[1] },
    { name: "Replied",   value: Math.round(kpis.totalSent * kpis.replyRate / 100),    fill: FUNNEL_COLORS[2] },
    { name: "Meetings",  value: kpis.meetings,                                         fill: FUNNEL_COLORS[3] },
  ], [kpis, prospectTotal])

  // Region breakdown from prospects
  const regions = useMemo(() => {
    const counts: Record<string, number> = {}
    prospects.forEach(p => { counts[p.country_code] = (counts[p.country_code] ?? 0) + 1 })
    return Object.entries(counts)
      .map(([country_code, count]) => ({ country_code, count }))
      .sort((a, b) => b.count - a.count)
  }, [prospects])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {verticalOption.label} GTM pipeline — {loading ? "…" : `${kpis.active} active campaign${kpis.active !== 1 ? "s" : ""}, ${prospectTotal} prospects`}
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="bg-gray-900 border-gray-800">
              <CardContent className="p-5">
                <Skeleton className="h-4 w-24 mb-2 bg-gray-800" />
                <Skeleton className="h-7 w-16 bg-gray-800" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <MetricCard title="Emails Sent"    value={kpis.totalSent}        icon={Mail}              color="text-sky-400"     subtitle={`across ${campaigns.length} campaigns`} />
            <MetricCard title="Open Rate"       value={`${kpis.openRate}%`}   icon={MousePointerClick} color="text-emerald-400" subtitle="industry avg ~22%" />
            <MetricCard title="Reply Rate"      value={`${kpis.replyRate}%`}  icon={MessageSquare}     color="text-violet-400"  subtitle="industry avg ~8%" />
            <MetricCard title="Meetings Booked" value={kpis.meetings}         icon={CalendarCheck}     color="text-amber-400"   subtitle="qualified pipeline" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Funnel Chart */}
        <Card className="bg-gray-900 border-gray-800 lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <TrendingUp className={`w-4 h-4 ${verticalOption.color}`} />
              Pipeline Funnel
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48 bg-gray-800 rounded" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={funnelData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 12 }} />
                  <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: "8px" }}
                    labelStyle={{ color: "#f9fafb" }}
                    itemStyle={{ color: "#9ca3af" }}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={FUNNEL_COLORS[0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Region Breakdown */}
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <Users className={`w-4 h-4 ${verticalOption.color}`} />
              Prospects by Region
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48 bg-gray-800 rounded" />
            ) : regions.length === 0 ? (
              <p className="text-xs text-gray-600 py-4 text-center">No prospect data yet.</p>
            ) : (
              <div className="space-y-3">
                {regions.slice(0, 8).map((r) => {
                  const max = regions[0].count
                  const pct = Math.round((r.count / max) * 100)
                  const name = COUNTRY_NAMES[r.country_code] ?? r.country_code
                  return (
                    <div key={r.country_code}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-300 font-medium">{name}</span>
                        <span className="text-gray-500">{r.count}</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-sky-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Campaigns Grid */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-gray-300 flex items-center gap-2">
              <Megaphone className={`w-4 h-4 ${verticalOption.color}`} />
              {verticalOption.label} Campaigns
              {!loading && kpis.active > 0 && (
                <Badge className="ml-1 text-[10px] bg-sky-900/40 text-sky-400 border-sky-800 border px-1.5 py-0">
                  {kpis.active} running
                </Badge>
              )}
            </CardTitle>
            <Link href="/campaigns" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
              View all →
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 bg-gray-800 rounded-xl" />)}
            </div>
          ) : campaigns.length === 0 ? (
            <div className="text-center py-8">
              <Megaphone className="w-8 h-8 text-gray-700 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No {verticalOption.label} campaigns yet.</p>
              <Link href="/campaigns/new" className="text-xs text-sky-400 hover:underline mt-1 inline-block">
                Create your first campaign →
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {campaigns.slice(0, 9).map(c => <CampaignCard key={c.id} c={c} />)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-gray-300">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityFeed limit={8} compact />
        </CardContent>
      </Card>
    </div>
  )
}
