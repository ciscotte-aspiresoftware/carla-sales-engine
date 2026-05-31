"use client"

import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import type {
  CostSummary, CostBreakdownRow, CostDailyRow, LLMCall,
  LLMSettings, ModelPricing, CurrencyPayload,
  CostDailyByModelResponse, AgentLatencyRow,
} from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  DollarSign, TrendingUp, Coins, Cpu, Zap,
  CheckCircle2, RefreshCw, AlertCircle, Settings2, RotateCcw, Lightbulb,
  CalendarRange, Timer, PieChart as PieChartIcon, BarChart3,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ── Currency helpers ──────────────────────────────────────────────────────────

type Currency = "USD" | "EUR" | "GBP"

const SYMBOL: Record<Currency, string> = { USD: "$", EUR: "€", GBP: "£" }

function fmtMoney(usd: number, currency: Currency, rates: Record<string, number>): string {
  const value = usd * (rates[currency] ?? 1)
  // Show 4 decimals for small values (sub-cent), 2 for normal, no decimals for big sums.
  const abs = Math.abs(value)
  let digits = 2
  if (abs > 0 && abs < 0.01) digits = 4
  else if (abs >= 100) digits = 0
  return `${SYMBOL[currency]}${value.toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  })}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortAgent(agent: string | null | undefined): string {
  // Map machine-readable agent ids to friendly labels.
  if (!agent) return "(unknown)"
  const map: Record<string, string> = {
    discovery_generate: "Discovery (generate)",
    discovery_enrich:   "Discovery (enrich)",
    prospector:         "Prospector (ICP scoring)",
    researcher:         "Researcher",
    copywriter:         "Copywriter",
    optimizer_recommendations: "Revenue Optimizer",
    pack_generate_icp:           "Pack — ICP",
    pack_generate_personas:      "Pack — Personas",
    pack_generate_messaging:     "Pack — Messaging",
    pack_generate_email_guidance: "Pack — Email guidance",
    pack_generate_regional:      "Pack — Regional",
  }
  return map[agent] ?? agent
}

function shortModel(model: string | null | undefined): string {
  if (!model) return "(unknown)"
  return model
    .replace(/^claude-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-/g, " ")
}

// ── KPI tile ──────────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, icon: Icon, accent }: {
  label: string
  value: string
  sub?: string
  icon: React.ElementType
  accent: string
}) {
  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">{label}</span>
          <Icon className={cn("w-3.5 h-3.5", accent)} />
        </div>
        <div className="text-xl font-semibold text-white tabular-nums">{value}</div>
        {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  )
}

// ── Daily cost spark ──────────────────────────────────────────────────────────

function DailyChart({ days, currency, rates }: {
  days: CostDailyRow[]
  currency: Currency
  rates: Record<string, number>
}) {
  const max = Math.max(...days.map((d) => d.cost_usd), 0.0001)
  return (
    <div className="space-y-2">
      <div className="flex items-end h-32 gap-px">
        {days.map((d) => {
          const h = max > 0 ? Math.max(2, (d.cost_usd / max) * 100) : 2
          const isActive = d.cost_usd > 0
          return (
            <div
              key={d.date}
              title={`${d.date} · ${fmtMoney(d.cost_usd, currency, rates)} · ${d.calls} calls`}
              className={cn(
                "flex-1 rounded-t transition-all hover:opacity-100",
                isActive ? "bg-sky-600 opacity-80" : "bg-gray-800 opacity-40",
              )}
              style={{ height: `${h}%` }}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-600">
        <span>{days[0]?.date.slice(5) ?? ""}</span>
        <span>{days[Math.floor(days.length / 2)]?.date.slice(5) ?? ""}</span>
        <span>{days[days.length - 1]?.date.slice(5) ?? ""}</span>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CostsPage() {
  const [currency, setCurrency] = useState<Currency>("USD")
  const [rates, setRates] = useState<CurrencyPayload | null>(null)

  const [summary, setSummary] = useState<CostSummary | null>(null)
  const [byModel, setByModel] = useState<CostBreakdownRow[]>([])
  const [byAgent, setByAgent] = useState<CostBreakdownRow[]>([])
  const [byCampaign, setByCampaign] = useState<CostBreakdownRow[]>([])
  const [daily, setDaily] = useState<CostDailyRow[]>([])
  const [dailyByModel, setDailyByModel] = useState<CostDailyByModelResponse | null>(null)
  const [latency, setLatency] = useState<AgentLatencyRow[]>([])
  const [recent, setRecent] = useState<LLMCall[]>([])

  const [llmSettings, setLLMSettings] = useState<LLMSettings | null>(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string>("")

  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    setLoading(true); setError("")
    try {
      const [s, m, a, c, d, r, ls, fx, dbm, lat] = await Promise.all([
        api.getCostSummary(),
        api.getCostByModel(),
        api.getCostByAgent(),
        api.getCostByCampaign(),
        api.getCostDaily(30),
        api.getRecentLLMCalls(40),
        api.getLLMSettings(),
        api.getCurrencyRates(),
        api.getCostDailyByModel(30),
        api.getLatencyByAgent(),
      ])
      setSummary(s); setByModel(m.rows); setByAgent(a.rows); setByCampaign(c.rows)
      setDaily(d.days); setRecent(r.calls); setLLMSettings(ls); setRates(fx)
      setDailyByModel(dbm); setLatency(lat.rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  const switchModel = async (model_id: string) => {
    if (!llmSettings || llmSettings.active_model === model_id) return
    setSwitching(true); setError("")
    try {
      await api.setActiveModel(model_id)
      const ls = await api.getLLMSettings()
      setLLMSettings(ls)
    } catch (e) {
      setError(`Switch failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSwitching(false)
    }
  }

  /** Pin (or clear, when model_id is null) an agent's per-step model override. */
  const setAgentOverride = async (agent: string, model_id: string | null) => {
    if (!llmSettings) return
    setError("")
    try {
      const res = await api.setAgentModel(agent, model_id)
      setLLMSettings({ ...llmSettings, overrides: res.overrides })
    } catch (e) {
      setError(`Override failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const fxRates = useMemo(() => rates?.rates ?? { USD: 1, EUR: 0.92, GBP: 0.78 }, [rates])

  // Map of model_id → { cost, calls } for the Active Model cards. The data is
  // already in `byModel`; we just index it by id for cheap per-card lookups.
  const spendByModelId = useMemo(() => {
    const out: Record<string, { cost_usd: number; calls: number }> = {}
    for (const row of byModel) {
      const id = (row as unknown as Record<string, unknown>).model as string | undefined
      if (id) out[id] = { cost_usd: row.cost_usd, calls: row.calls }
    }
    return out
  }, [byModel])

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Coins className="w-5 h-5 text-amber-400" />
            Costs & Models
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Token usage, dollar spend, and which Claude model the engine is currently running on.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-gray-900 border border-gray-800 rounded-lg p-0.5 gap-0.5">
            {(["USD", "EUR", "GBP"] as Currency[]).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs transition-colors",
                  currency === c ? "bg-amber-700/30 text-amber-300" : "text-gray-400 hover:text-gray-200"
                )}
              >
                {SYMBOL[c]} {c}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}
            className="border-gray-700 text-gray-300 hover:text-white text-xs h-8">
            <RefreshCw className={cn("w-3 h-3 mr-1.5", loading && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/30 border border-red-900/40 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
        </div>
      )}

      {/* Top-line tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {loading && !summary ? (
          [1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20 bg-gray-900" />)
        ) : summary ? (
          <>
            <KpiTile label="All-time spend"
              value={fmtMoney(summary.all_time.cost_usd, currency, fxRates)}
              sub={`${summary.all_time.calls.toLocaleString()} Claude calls`}
              icon={DollarSign} accent="text-emerald-400" />
            <KpiTile label="Last 30 days"
              value={fmtMoney(summary.last_30d.cost_usd, currency, fxRates)}
              sub={`${fmtTokens(summary.last_30d.input_tokens + summary.last_30d.output_tokens)} tokens`}
              icon={TrendingUp} accent="text-sky-400" />
            <KpiTile label="Last 7 days"
              value={fmtMoney(summary.last_7d.cost_usd, currency, fxRates)}
              sub={`${summary.last_7d.calls.toLocaleString()} calls`}
              icon={Zap} accent="text-violet-400" />
            {/* Run-rate projection — extrapolates the last-7d burn to a 30-day month.
                Useful for budget conversations: 'at this pace, monthly is $X.' */}
            <KpiTile label="Monthly run-rate"
              value={fmtMoney((summary.last_7d.cost_usd / 7) * 30, currency, fxRates)}
              sub={summary.last_7d.calls > 0
                ? `Projected from last 7d burn`
                : "No spend in last 7d"}
              icon={CalendarRange} accent="text-amber-400" />
            <KpiTile label="Total tokens"
              value={fmtTokens(summary.all_time.input_tokens + summary.all_time.output_tokens + summary.all_time.thinking_tokens)}
              sub={`Includes ${fmtTokens(summary.all_time.thinking_tokens)} thinking`}
              icon={Cpu} accent="text-amber-400" />
          </>
        ) : null}
      </div>

      {/* Daily chart */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">
            Daily spend · last 30 days
          </CardTitle>
        </CardHeader>
        <CardContent>
          {daily.length > 0 ? (
            <DailyChart days={daily} currency={currency} rates={fxRates} />
          ) : (
            <div className="text-xs text-gray-600 italic py-4 text-center">No usage in the last 30 days.</div>
          )}
        </CardContent>
      </Card>

      {/* Model switcher + pricing table */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5" /> Active Model
            <span className="text-[10px] text-gray-600 normal-case font-normal ml-2">
              · changes apply to every agent and AI Auto-fill call
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {llmSettings ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {llmSettings.available_models.map((m: ModelPricing) => {
                const isActive = m.model_id === llmSettings.active_model
                const spend = spendByModelId[m.model_id]
                return (
                  <button
                    key={m.model_id}
                    onClick={() => switchModel(m.model_id)}
                    disabled={isActive || switching}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-all",
                      isActive
                        ? "border-emerald-700 bg-emerald-950/30 ring-1 ring-emerald-600/40 cursor-default"
                        : "border-gray-800 bg-gray-800/30 hover:border-gray-600 cursor-pointer"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white">{m.label}</span>
                          {isActive && (
                            <Badge className="text-[10px] bg-emerald-900/50 text-emerald-300 border-emerald-700">
                              <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                            </Badge>
                          )}
                        </div>
                        <code className="text-[10px] text-gray-600 font-mono">{m.model_id}</code>
                      </div>
                      {/* All-time spend on this model — sourced from /costs/by-model. */}
                      <div className="text-right shrink-0">
                        <div className="text-[9px] text-gray-600 uppercase tracking-wider">Spent</div>
                        <div className={cn(
                          "text-sm font-semibold tabular-nums",
                          spend && spend.cost_usd > 0 ? "text-emerald-400" : "text-gray-700",
                        )}>
                          {spend ? fmtMoney(spend.cost_usd, currency, fxRates) : "—"}
                        </div>
                        {spend && spend.calls > 0 && (
                          <div className="text-[9px] text-gray-600">
                            {spend.calls.toLocaleString()} call{spend.calls === 1 ? "" : "s"}
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{m.notes}</p>
                    <div className="grid grid-cols-4 gap-2 mt-3 text-[10px]">
                      <div>
                        <div className="text-gray-600 uppercase tracking-wider">Input</div>
                        <div className="text-gray-200 font-mono">{fmtMoney(m.input_per_mtok, currency, fxRates)}</div>
                        <div className="text-gray-600">/Mtok</div>
                      </div>
                      <div>
                        <div className="text-gray-600 uppercase tracking-wider">Output</div>
                        <div className="text-gray-200 font-mono">{fmtMoney(m.output_per_mtok, currency, fxRates)}</div>
                        <div className="text-gray-600">/Mtok</div>
                      </div>
                      <div>
                        <div className="text-gray-600 uppercase tracking-wider">Cache read</div>
                        <div className="text-gray-200 font-mono">{fmtMoney(m.cache_read_per_mtok, currency, fxRates)}</div>
                        <div className="text-gray-600">/Mtok</div>
                      </div>
                      <div>
                        <div className="text-gray-600 uppercase tracking-wider">Cache write</div>
                        <div className="text-gray-200 font-mono">{fmtMoney(m.cache_write_5m_per_mtok, currency, fxRates)}</div>
                        <div className="text-gray-600">/Mtok 5m</div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <Skeleton className="h-32 bg-gray-800" />
          )}
          {rates && (
            <div className="flex justify-end mt-3 text-[10px] text-gray-600">
              FX rates as of {rates.as_of} · {rates.source}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-step model overrides — every agent can be pinned to a specific
          model independently of the global active model above. */}
      {llmSettings && llmSettings.agents.length > 0 && (
        <PerStepModelCard
          settings={llmSettings}
          onSet={setAgentOverride}
          byAgent={byAgent}
          currency={currency}
          rates={fxRates}
        />
      )}

      {/* Cost-analysis row — stacked daily by-model chart on the left,
          spend-mix donut on the right. Bottom row: latency table full-width. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" /> Daily spend by model · last 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyByModel && dailyByModel.models.length > 0 ? (
              <StackedDailyByModel data={dailyByModel} currency={currency} rates={fxRates} />
            ) : (
              <div className="text-xs text-gray-600 italic py-6 text-center">
                No multi-model spend in the last 30 days yet — switch a few agents to different models and run a campaign.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <PieChartIcon className="w-3.5 h-3.5" /> Spend mix · last 30 days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyByModel && dailyByModel.models.length > 0 ? (
              <SpendMixDonut data={dailyByModel} currency={currency} rates={fxRates} />
            ) : (
              <div className="text-xs text-gray-600 italic py-6 text-center">
                No spend yet.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Timer className="w-3.5 h-3.5" /> Latency by agent
            <span className="text-[10px] text-gray-600 normal-case font-normal ml-2">
              · p50 / p95 of round-trip duration
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {latency.length === 0 ? (
            <div className="text-xs text-gray-600 italic py-6 text-center">No latency data yet.</div>
          ) : (
            <LatencyTable rows={latency} />
          )}
        </CardContent>
      </Card>

      {/* Breakdowns row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <BreakdownCard title="Spend by model" rows={byModel} keyField="model" labelFn={shortModel} currency={currency} rates={fxRates} />
        <BreakdownCard title="Spend by agent" rows={byAgent} keyField="agent" labelFn={shortAgent} currency={currency} rates={fxRates} />
        <BreakdownCard title="Spend by campaign" rows={byCampaign} keyField="campaign_name" labelFn={(s) => s ?? "(no campaign)"} currency={currency} rates={fxRates} />
      </div>

      {/* Recent calls table */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">
            Recent Claude calls
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <div className="text-xs text-gray-600 italic py-6 text-center">No Claude calls recorded yet. Run a campaign or AI Auto-fill to populate this list.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/50 text-gray-500">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-3 py-2">Agent</th>
                    <th className="text-left font-medium px-3 py-2">Model</th>
                    <th className="text-left font-medium px-3 py-2">Campaign</th>
                    <th className="text-right font-medium px-3 py-2">Tokens (in / out)</th>
                    <th className="text-right font-medium px-3 py-2">Duration</th>
                    <th className="text-right font-medium px-3 py-2">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => (
                    <tr key={r.id} className="border-t border-gray-800/60 hover:bg-gray-800/30">
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                        {r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-200">{shortAgent(r.agent)}</td>
                      <td className="px-3 py-2 text-gray-400 font-mono">{shortModel(r.model)}</td>
                      <td className="px-3 py-2 text-gray-400 truncate max-w-[14rem]">{r.campaign_name ?? "—"}</td>
                      <td className="px-3 py-2 text-right text-gray-400 tabular-nums">
                        {fmtTokens(r.input_tokens)} / {fmtTokens(r.output_tokens)}
                        {r.thinking_tokens > 0 && <span className="text-violet-400"> + {fmtTokens(r.thinking_tokens)}t</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                        {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-400 tabular-nums font-medium">
                        {fmtMoney(r.cost_usd, currency, fxRates)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Breakdown card ────────────────────────────────────────────────────────────

function BreakdownCard({
  title, rows, keyField, labelFn, currency, rates,
}: {
  title: string
  rows: CostBreakdownRow[]
  keyField: string
  labelFn: (val: string | null | undefined) => string
  currency: Currency
  rates: Record<string, number>
}) {
  const total = rows.reduce((acc, r) => acc + r.cost_usd, 0)
  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="text-xs text-gray-600 italic py-6 text-center px-4">No data yet.</div>
        ) : (
          <ul className="divide-y divide-gray-800/60">
            {rows.map((r, i) => {
              const v = (r as unknown as Record<string, unknown>)[keyField]
              const label = labelFn(typeof v === "string" ? v : null)
              const pct = total > 0 ? (r.cost_usd / total) * 100 : 0
              return (
                <li key={i} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-gray-200 truncate flex-1" title={label}>{label}</span>
                    <span className="text-emerald-400 tabular-nums font-medium shrink-0">
                      {fmtMoney(r.cost_usd, currency, rates)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 mt-1">
                    <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-600/60" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-600 tabular-nums shrink-0 w-24 text-right">
                      {r.calls.toLocaleString()} calls · {((r.tokens || 0) / 1000).toFixed(1)}k tok
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

// ── Per-step model card ───────────────────────────────────────────────────────

/**
 * Compact table that pins each agent to a specific Claude model — or leaves it
 * on the global default. Saves on every change (no separate "apply" button).
 *
 * Right-hand column shows last-30d / all-time spend for that agent so you can
 * spot the agents that would benefit most from a cheaper model.
 */
function PerStepModelCard({
  settings, onSet, byAgent, currency, rates,
}: {
  settings: LLMSettings
  onSet: (agent: string, model_id: string | null) => void | Promise<void>
  byAgent: CostBreakdownRow[]
  currency: Currency
  rates: Record<string, number>
}) {
  const activeLabel =
    settings.available_models.find((m) => m.model_id === settings.active_model)?.label
    ?? settings.active_model

  // Build a {agent → spend} lookup from the existing /costs/by-agent payload.
  const spendByAgent = useMemo(() => {
    const out: Record<string, { cost_usd: number; calls: number }> = {}
    for (const row of byAgent) {
      const a = (row as unknown as Record<string, unknown>).agent as string | undefined
      if (a) out[a] = { cost_usd: row.cost_usd, calls: row.calls }
    }
    return out
  }, [byAgent])

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Settings2 className="w-3.5 h-3.5" /> Per-step models
          <span className="text-[10px] text-gray-600 normal-case font-normal ml-2">
            · pin individual agents to a different model than the global default ({activeLabel})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-800/40 text-gray-500">
              <tr>
                <th className="text-left font-medium px-3 py-2">Agent</th>
                <th className="text-left font-medium px-3 py-2 w-72">Model</th>
                <th className="text-right font-medium px-3 py-2 w-40">Spend so far</th>
              </tr>
            </thead>
            <tbody>
              {settings.agents.map((a) => {
                const overridden = settings.overrides[a.name]
                const value = overridden ?? ""
                const spend = spendByAgent[a.name]
                // The model that calls actually run on right now: the override
                // if pinned, otherwise the global default.
                const effectiveModel = overridden ?? settings.active_model
                const recommended = a.recommended_model
                const recommendedLabel = recommended
                  ? settings.available_models.find((m) => m.model_id === recommended)?.label ?? recommended
                  : null
                const matchesRecommendation = !!recommended && effectiveModel === recommended

                return (
                  <tr key={a.name} className="border-t border-gray-800/60 hover:bg-gray-800/30 align-top">
                    <td className="px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-gray-200 font-medium">{a.label}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5 leading-snug">{a.description}</div>
                          <code className="text-[10px] text-gray-700 font-mono">{a.name}</code>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={value}
                          onChange={(e) => onSet(a.name, e.target.value || null)}
                          className={cn(
                            "flex-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500",
                            overridden && "border-amber-700/60",
                          )}
                        >
                          <option value="">Use default ({activeLabel})</option>
                          {settings.available_models.map((m) => (
                            <option key={m.model_id} value={m.model_id}>{m.label}</option>
                          ))}
                        </select>
                        {overridden ? (
                          <button
                            onClick={() => onSet(a.name, null)}
                            title="Clear override — revert to global default"
                            className="text-gray-500 hover:text-amber-400 p-1"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <span className="w-5 h-5 inline-block" />
                        )}
                      </div>
                      {overridden && (
                        <div className="text-[10px] text-amber-400/80 mt-1">
                          Override active — every {a.label.toLowerCase()} call uses this model.
                        </div>
                      )}
                      {/* Recommendation row — green checkmark when on recommended,
                          amber "Apply" suggestion otherwise. Always shows the rationale. */}
                      {recommended && (
                        <div className="mt-1 flex items-start gap-1.5 text-[10px]">
                          {matchesRecommendation ? (
                            <>
                              <Lightbulb className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />
                              <span className="text-emerald-400">
                                Recommended: <span className="font-medium">{recommendedLabel}</span>
                                <span className="text-gray-600"> · {a.recommendation_reason}</span>
                              </span>
                            </>
                          ) : (
                            <>
                              <Lightbulb className="w-3 h-3 text-violet-400 shrink-0 mt-0.5" />
                              <span className="text-gray-400">
                                Recommended: <span className="font-medium text-violet-300">{recommendedLabel}</span>
                                <button
                                  onClick={() => {
                                    // Clicking Apply: if the recommendation matches the global
                                    // default, we clear the override (cleaner state). Otherwise
                                    // pin the agent to the recommended model.
                                    const target = recommended === settings.active_model ? null : recommended
                                    onSet(a.name, target)
                                  }}
                                  className="ml-1.5 text-violet-400 hover:text-violet-300 underline underline-offset-2"
                                >
                                  Apply
                                </button>
                                {a.recommendation_reason && (
                                  <span className="text-gray-600"> · {a.recommendation_reason}</span>
                                )}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {spend ? (
                        <>
                          <div className="text-emerald-400 font-medium">
                            {fmtMoney(spend.cost_usd, currency, rates)}
                          </div>
                          <div className="text-[10px] text-gray-600">
                            {spend.calls.toLocaleString()} call{spend.calls === 1 ? "" : "s"}
                          </div>
                        </>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Stacked daily by-model chart + donut + latency table ─────────────────────

/** Deterministic colour palette for model_ids. Stable across renders. */
const MODEL_COLORS = [
  "#34d399", // emerald-400
  "#a78bfa", // violet-400
  "#38bdf8", // sky-400
  "#fbbf24", // amber-400
  "#f472b6", // pink-400
  "#22d3ee", // cyan-400
  "#fb7185", // rose-400
  "#a3e635", // lime-400
  "#c084fc", // purple-400
  "#94a3b8", // slate-400
  "#f97316", // orange-500
]
function colorForModel(model_id: string, allModels: string[]): string {
  const idx = allModels.indexOf(model_id)
  return MODEL_COLORS[(idx >= 0 ? idx : 0) % MODEL_COLORS.length]
}

/** Pure-CSS stacked-bar timeseries. One column per day, segments per model.
 * Heaviest spender sits at the bottom of the stack (matches the legend order). */
function StackedDailyByModel({
  data, currency, rates,
}: {
  data: CostDailyByModelResponse
  currency: Currency
  rates: Record<string, number>
}) {
  const { days, models } = data

  // Day totals — used for the y-axis scale.
  const dayTotals = days.map((d) => Object.values(d.by_model).reduce((a, b) => a + b, 0))
  const max = Math.max(...dayTotals, 0.0001)

  return (
    <div className="space-y-2">
      <div className="flex items-end h-32 gap-px">
        {days.map((d, i) => {
          const total = dayTotals[i]
          if (total === 0) {
            return <div key={d.date} className="flex-1 h-full bg-transparent" title={`${d.date}: no spend`} />
          }
          const heightPct = (total / max) * 100
          return (
            <div
              key={d.date}
              className="flex-1 flex flex-col-reverse rounded-sm overflow-hidden hover:opacity-80 transition-opacity"
              style={{ height: `${heightPct}%` }}
              title={`${d.date}\n${fmtMoney(total, currency, rates)}`}
            >
              {models.map((m) => {
                const c = d.by_model[m]
                if (!c || c <= 0) return null
                const segPct = (c / total) * 100
                return (
                  <div
                    key={m}
                    style={{ height: `${segPct}%`, background: colorForModel(m, models) }}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-600">
        <span>{days[0]?.date.slice(5) ?? ""}</span>
        <span>{days[Math.floor(days.length / 2)]?.date.slice(5) ?? ""}</span>
        <span>{days[days.length - 1]?.date.slice(5) ?? ""}</span>
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] pt-1">
        {models.map((m) => (
          <div key={m} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ background: colorForModel(m, models) }} />
            <span className="text-gray-300">{shortModel(m)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** SVG donut showing the % of last-30d spend per model. Hover for absolute $. */
function SpendMixDonut({
  data, currency, rates,
}: {
  data: CostDailyByModelResponse
  currency: Currency
  rates: Record<string, number>
}) {
  // Aggregate: model_id → total cost in window.
  const totals: Record<string, number> = {}
  for (const d of data.days) {
    for (const [m, c] of Object.entries(d.by_model)) {
      totals[m] = (totals[m] ?? 0) + c
    }
  }
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0)

  if (grandTotal === 0) {
    return <div className="text-xs text-gray-600 italic py-6 text-center">No spend yet.</div>
  }

  // Build segments — preserve the order from data.models (top spender first).
  const segments = data.models
    .map((m) => ({ model: m, value: totals[m] ?? 0 }))
    .filter((s) => s.value > 0)

  const radius = 60
  const innerRadius = 38
  const cx = 80
  const cy = 80

  // Build SVG <path> arcs.
  let cumulative = 0
  const paths = segments.map((s) => {
    const startAngle = (cumulative / grandTotal) * Math.PI * 2 - Math.PI / 2
    cumulative += s.value
    const endAngle = (cumulative / grandTotal) * Math.PI * 2 - Math.PI / 2
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
    const x1 = cx + radius * Math.cos(startAngle)
    const y1 = cy + radius * Math.sin(startAngle)
    const x2 = cx + radius * Math.cos(endAngle)
    const y2 = cy + radius * Math.sin(endAngle)
    const x3 = cx + innerRadius * Math.cos(endAngle)
    const y3 = cy + innerRadius * Math.sin(endAngle)
    const x4 = cx + innerRadius * Math.cos(startAngle)
    const y4 = cy + innerRadius * Math.sin(startAngle)
    return {
      model: s.model,
      value: s.value,
      pct: (s.value / grandTotal) * 100,
      d: `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`,
    }
  })

  return (
    <div className="flex items-center gap-4">
      <svg width="160" height="160" viewBox="0 0 160 160" className="shrink-0">
        {paths.map((p) => (
          <path
            key={p.model}
            d={p.d}
            fill={colorForModel(p.model, data.models)}
            stroke="#0f172a"  // matches bg
            strokeWidth="1"
          >
            <title>{`${shortModel(p.model)}: ${fmtMoney(p.value, currency, rates)} (${p.pct.toFixed(1)}%)`}</title>
          </path>
        ))}
        {/* Centre label */}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-gray-300 text-[10px]" style={{ fontFamily: "inherit" }}>
          Total
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" className="fill-emerald-400 text-[12px] font-semibold" style={{ fontFamily: "inherit" }}>
          {fmtMoney(grandTotal, currency, rates)}
        </text>
      </svg>
      <ul className="flex-1 text-xs space-y-1 min-w-0">
        {paths.map((p) => (
          <li key={p.model} className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colorForModel(p.model, data.models) }} />
            <span className="text-gray-300 truncate flex-1" title={p.model}>{shortModel(p.model)}</span>
            <span className="text-emerald-400 tabular-nums">{p.pct.toFixed(1)}%</span>
            <span className="text-gray-500 tabular-nums w-16 text-right">{fmtMoney(p.value, currency, rates)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function fmtMs(ms: number): string {
  if (ms < 1) return "0ms"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** p50 / p95 / count per agent. Sortable could come later — for now sorted by
 * total time descending so the agents that consume the most wall-clock time
 * (and therefore the most user attention) sit at the top. */
function LatencyTable({ rows }: { rows: AgentLatencyRow[] }) {
  // Use the slowest p95 across all rows as the bar-chart denominator so the
  // bars are comparable. Cap at a sensible minimum to avoid 0-divide.
  const maxP95 = Math.max(...rows.map((r) => r.p95_ms), 1)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-gray-800/40 text-gray-500">
          <tr>
            <th className="text-left font-medium px-3 py-2">Agent</th>
            <th className="text-right font-medium px-3 py-2 w-20">Calls</th>
            <th className="text-right font-medium px-3 py-2 w-20">p50</th>
            <th className="text-right font-medium px-3 py-2 w-20">p95</th>
            <th className="text-left font-medium px-3 py-2 w-64">p95 distribution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = (r.p95_ms / maxP95) * 100
            // Colour bar by latency band — green <5s, amber <15s, red beyond.
            const tone =
              r.p95_ms < 5000 ? "bg-emerald-600/60" :
              r.p95_ms < 15000 ? "bg-amber-600/60" :
              "bg-red-600/60"
            return (
              <tr key={r.agent} className="border-t border-gray-800/60 hover:bg-gray-800/30">
                <td className="px-3 py-2 text-gray-200 font-mono text-[11px]">{r.agent}</td>
                <td className="px-3 py-2 text-right text-gray-400 tabular-nums">{r.calls.toLocaleString()}</td>
                <td className="px-3 py-2 text-right text-gray-300 tabular-nums">{fmtMs(r.p50_ms)}</td>
                <td className="px-3 py-2 text-right text-gray-300 tabular-nums font-semibold">{fmtMs(r.p95_ms)}</td>
                <td className="px-3 py-2">
                  <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div className={cn("h-full transition-all", tone)} style={{ width: `${pct}%` }} />
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
