// /costs - spend + usage observability across every external service Atlas
// calls (OpenAI, Scrapingdog, Firecrawl, Apollo, Apify).
//
// Read-only view over the api_usage ledger. Model selection lives on the
// Admin page; the per-model cards here just show pricing + spend with an
// "Active" badge on whichever model the current Admin config is using
// (classify, email, report - up to three actives simultaneously).
//
// All costs are approximations - we apply the rates baked into
// api/utils/api-cost.js at write time, so historical rows survive future
// pricing changes. Tenants on enterprise contracts pay less per credit,
// so treat the numbers as directional, not billing-grade.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import { Link } from 'react-router-dom'
import {
  IconCoin,
  IconRefresh,
  IconLoader2,
  IconBolt,
  IconCalendar,
  IconClock,
  IconCpu,
  IconTrendingUp,
  IconCheck,
  IconWorld,
  IconMap2,
  IconBrandLinkedin,
  IconUsers,
  IconRobot,
} from '@tabler/icons-react'

const API = API_BASE

interface Summary {
  enabled: boolean
  allTime: { calls: number; usd_cost: number; tokens: number }
  last30d: { calls: number; usd_cost: number; tokens: number }
  last7d:  { calls: number; usd_cost: number; tokens: number }
  last24h: { calls: number; usd_cost: number; tokens: number }
}
interface BreakdownRow {
  key: string
  calls: number
  units: number
  units_in: number
  units_out: number
  usd_cost: number
}
interface DailyRow { date: string; calls: number; usd_cost: number }
interface RecentRow {
  id: string
  created_at: string
  service: string
  operation: string | null
  model: string | null
  units: number
  units_in: number
  units_out: number
  usd_cost: number
  duration_ms: number | null
}
interface PricingPayload {
  openai: Record<string, { in: number; out: number }>
  services: Record<string, number>
  monthlySubscriptions?: Record<string, number>
  fx?: { rates: Record<string, number>; asOf: string }
}

type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD'
// CAD uses 'C$' so it doesn't collide visually with USD - relevant since
// every subscription Atlas pays is billed in USD and the user is likely
// the one who needs to convert mentally to CAD when reconciling their
// Canadian credit card statement.
const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$' }
const DEFAULT_FX: Record<string, number> = { USD: 1.0, EUR: 0.92, GBP: 0.79, CAD: 1.36 }
interface AiSettings {
  classifyModel: string
  emailModel: string
  reportModel: string
}

// Window options for the toolbar. days=0 means all-time on the backend.
const WINDOWS: { label: string; days: number }[] = [
  { label: '24h',  days: 1 },
  { label: '7d',   days: 7 },
  { label: '30d',  days: 30 },
  { label: '90d',  days: 90 },
  { label: 'All',  days: 0 },
]

// Icon + label + accent per service for the per-service breakdown cards.
const SERVICE_META: Record<string, { label: string; icon: React.ElementType; accent: string }> = {
  openai:      { label: 'OpenAI',      icon: IconRobot,         accent: 'text-emerald-500' },
  scrapingdog: { label: 'Scrapingdog', icon: IconMap2,          accent: 'text-sky-500' },
  firecrawl:   { label: 'Firecrawl',   icon: IconWorld,         accent: 'text-amber-500' },
  apollo:      { label: 'Apollo',      icon: IconUsers,         accent: 'text-violet-500' },
  apify:       { label: 'Apify (LI)',  icon: IconBrandLinkedin, accent: 'text-rose-500' },
}

// Currency-aware money formatter. All ledger rows are stored in USD; we
// multiply by the picked currency's rate at display time. Sub-cent precision
// kicks in for tiny values so a $0.0001/token rate doesn't render as $0.00.
function fmtMoney(usd: number, currency: Currency, rates: Record<string, number>): string {
  const value = usd * (rates[currency] ?? 1)
  const abs = Math.abs(value)
  let digits = 2
  if (abs > 0 && abs < 0.01) digits = 4
  else if (abs >= 1000) digits = 0
  return `${CURRENCY_SYMBOL[currency]}${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}
// Per-Mtok pricing for the model cards is just fmt(perToken * 1_000_000)
// inline - the standalone helper got folded back into the call sites.

export default function CostsPage() {
  const [days, setDays] = useState<number>(30)
  const [currency, setCurrency] = useState<Currency>('USD')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [byService, setByService] = useState<BreakdownRow[]>([])
  const [byModel, setByModel] = useState<BreakdownRow[]>([])
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [recent, setRecent] = useState<RecentRow[]>([])
  const [pricing, setPricing] = useState<PricingPayload | null>(null)
  const [activeAi, setActiveAi] = useState<AiSettings | null>(null)
  // Allowed-model list from the Admin settings. The Costs page filters
  // per-model cards down to these (+ any model that has spend, so historical
  // legacy rows still show up) - prevents cluttering the grid with 22 cards
  // when only 10 are pickable in Admin.
  const [allowedModels, setAllowedModels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')

  // FX rates pulled from the backend /pricing payload (single source of
  // truth, updated by hand in api/utils/api-cost.js). Falls back to a
  // baked-in default so the toggle still works pre-fetch.
  const fxRates = useMemo(() => pricing?.fx?.rates ?? DEFAULT_FX, [pricing])
  // Currency-aware $ formatter for the whole page. Closes over the current
  // toggle + rates so every call site just writes fmt(x) - cleaner than
  // threading (currency, rates) through every prop.
  const fmt = useMemo(() => (usd: number) => fmtMoney(usd, currency, fxRates), [currency, fxRates])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [s, svc, mdl, dly, rec, pr, adm] = await Promise.all([
        safeFetchJson(`${API}/api/costs/summary`),
        safeFetchJson(`${API}/api/costs/by-service?days=${days}`),
        safeFetchJson(`${API}/api/costs/by-model?days=${days}`),
        safeFetchJson(`${API}/api/costs/daily?days=${Math.max(days, 30)}`),
        safeFetchJson(`${API}/api/costs/recent?limit=40`),
        safeFetchJson(`${API}/api/costs/pricing`),
        safeFetchJson(`${API}/api/admin/settings`),
      ])
      setSummary(s as Summary)
      setByService((svc as { rows: BreakdownRow[] }).rows || [])
      setByModel((mdl as { rows: BreakdownRow[] }).rows || [])
      setDaily((dly as { days: DailyRow[] }).days || [])
      setRecent((rec as { rows: RecentRow[] }).rows || [])
      setPricing(pr as PricingPayload)
      const settings = adm as { effective?: { ai?: AiSettings }; allowedModels?: string[] }
      if (settings?.effective?.ai) setActiveAi(settings.effective.ai)
      if (Array.isArray(settings?.allowedModels)) setAllowedModels(settings.allowedModels)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  // Map model_id → {cost, calls} for the per-model card lookups.
  const spendByModel = useMemo(() => {
    const out: Record<string, { cost_usd: number; calls: number; units_in: number; units_out: number }> = {}
    for (const r of byModel) {
      out[r.key] = { cost_usd: r.usd_cost, calls: r.calls, units_in: r.units_in, units_out: r.units_out }
    }
    return out
  }, [byModel])

  // Set of currently-active model ids across the three task slots, for the
  // "Active" badge on the model cards. A single model can fill more than one
  // slot - the badge shows which slots it's serving.
  const activeSlotsByModel = useMemo(() => {
    if (!activeAi) return {} as Record<string, string[]>
    const out: Record<string, string[]> = {}
    const push = (m: string, label: string) => {
      if (!m) return
      if (!out[m]) out[m] = []
      out[m].push(label)
    }
    push(activeAi.classifyModel, 'classify')
    push(activeAi.emailModel, 'email')
    push(activeAi.reportModel, 'report')
    return out
  }, [activeAi])

  // Stable list of model ids for the per-model cards. Two-step filter:
  //   1. Show models in allowedModels (the Admin-pickable set) - these
  //      are the ones the user actually cares about pricing for.
  //   2. ALSO show any model that has spend in this window - covers
  //      historical legacy spend on models we've since removed from the
  //      allowed list, so the Costs total still reconciles.
  // If allowedModels hasn't loaded yet, fall back to showing every priced
  // model so the grid renders something on first paint.
  const modelIds = useMemo(() => {
    if (!pricing) return [] as string[]
    const allowed = new Set(allowedModels)
    const ids = new Set<string>()
    if (allowed.size === 0) {
      // Pre-load fallback: show everything we have pricing for.
      for (const k of Object.keys(pricing.openai)) ids.add(k)
    } else {
      for (const k of Object.keys(pricing.openai)) {
        if (allowed.has(k)) ids.add(k)
      }
    }
    for (const k of Object.keys(spendByModel)) ids.add(k)
    return Array.from(ids).sort((a, b) => {
      // Active models first, then by spend desc, then alphabetical.
      const aActive = !!activeSlotsByModel[a]
      const bActive = !!activeSlotsByModel[b]
      if (aActive !== bActive) return aActive ? -1 : 1
      const aSpend = spendByModel[a]?.cost_usd || 0
      const bSpend = spendByModel[b]?.cost_usd || 0
      if (aSpend !== bSpend) return bSpend - aSpend
      return a.localeCompare(b)
    })
  }, [pricing, spendByModel, activeSlotsByModel, allowedModels])

  return (
    <div className="space-y-6">
      {/* Header + toolbar */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-3">
            <IconCoin className="h-6 w-6 text-amber-500" />
            <h1 className="text-2xl font-semibold">Costs & API usage</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Approximate spend across every external service Atlas calls.
            Numbers are computed from the rates baked into{' '}
            <code className="text-foreground">api/utils/api-cost.js</code> at the moment each call landed
            - real billing will differ depending on your plan. Switch models on the{' '}
            <Link to="/admin" className="underline text-sky-500">Admin</Link> page.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Currency toggle. FX rates come from the backend pricing
              payload; all ledger rows are stored in USD and just multiplied
              at display time. */}
          <div className={cn(GLASS_SUBTLE, 'flex items-center rounded-md p-0.5 gap-0.5')}>
            {(['USD', 'EUR', 'GBP', 'CAD'] as Currency[]).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs transition-colors',
                  currency === c ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {CURRENCY_SYMBOL[c]} {c}
              </button>
            ))}
          </div>
          {/* Segmented period selector. Affects breakdowns + the daily chart,
              not the all-time summary tile (that's always all-time). */}
          <div className={cn(GLASS_SUBTLE, 'flex items-center rounded-md p-0.5 gap-0.5')}>
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs transition-colors',
                  days === w.days ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="text-xs h-8">
            {loading ? <IconLoader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <IconRefresh className="h-3 w-3 mr-1.5" />}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {summary && !summary.enabled && (
        <Card className={cn(GLASS, 'p-4')}>
          <p className="text-sm text-muted-foreground">
            Cost tracking writes to the Supabase <code>api_usage</code> table. It looks like
            Supabase isn't enabled on this backend (<code>USE_SUPABASE=false</code>), so this page
            will stay empty. Flip <code>USE_SUPABASE=true</code> and rerun migration{' '}
            <code>0009_api_usage.sql</code> to start collecting.
          </p>
        </Card>
      )}

      {/* Top-line KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiTile label="All-time spend"
          value={summary ? fmt(summary.allTime.usd_cost) : '-'}
          sub={summary ? `${summary.allTime.calls.toLocaleString()} calls` : ''}
          Icon={IconCoin} accent="text-emerald-500" />
        <KpiTile label="Last 30 days"
          value={summary ? fmt(summary.last30d.usd_cost) : '-'}
          sub={summary ? `${fmtNumber(summary.last30d.tokens)} tokens` : ''}
          Icon={IconTrendingUp} accent="text-sky-500" />
        <KpiTile label="Last 7 days"
          value={summary ? fmt(summary.last7d.usd_cost) : '-'}
          sub={summary ? `${summary.last7d.calls.toLocaleString()} calls` : ''}
          Icon={IconBolt} accent="text-violet-500" />
        <KpiTile label="Last 24 hours"
          value={summary ? fmt(summary.last24h.usd_cost) : '-'}
          sub={summary ? `${summary.last24h.calls.toLocaleString()} calls` : ''}
          Icon={IconClock} accent="text-amber-500" />
        <KpiTile label="Monthly run-rate"
          value={summary ? fmt((summary.last7d.usd_cost / 7) * 30) : '-'}
          sub={summary && summary.last7d.calls > 0 ? 'Projected from 7d' : 'No recent spend'}
          Icon={IconCalendar} accent="text-rose-500" />
      </div>

      {/* Daily timeline */}
      <Card className={cn(GLASS)}>
        <CardContent className="p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3">
            Daily spend · last {Math.max(days, 30)} days
          </div>
          {daily.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-6 text-center">No usage recorded yet.</div>
          ) : (
            <DailyChart days={daily} fmt={fmt} />
          )}
        </CardContent>
      </Card>

      {/* Per-model cards (read-only) */}
      <Card className={cn(GLASS)}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5">
                <IconCpu className="h-3 w-3" /> OpenAI models · pricing + spend
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Read-only view. Pick which model serves classify / email / report on{' '}
                <Link to="/admin" className="underline text-sky-500">Admin</Link>.
              </p>
            </div>
          </div>
          {modelIds.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-6 text-center">No pricing data loaded.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {modelIds.map((modelId) => (
                <ModelCard
                  key={modelId}
                  modelId={modelId}
                  pricing={pricing!.openai[modelId]}
                  spend={spendByModel[modelId]}
                  activeSlots={activeSlotsByModel[modelId] || []}
                  fmt={fmt}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Flat monthly subscriptions - NOT in the per-call ledger. These
          are the always-on infrastructure costs Atlas needs regardless of
          how many calls you make. Shown so the total cost of running the
          tool reads honestly. Numbers come from the backend pricing config,
          edit in api/utils/api-cost.js if your plans change. */}
      {pricing?.monthlySubscriptions && Object.keys(pricing.monthlySubscriptions).length > 0 && (
        <Card className={cn(GLASS)}>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              Monthly subscriptions
            </div>
            <p className="text-[11px] text-muted-foreground mb-3">
              Flat infrastructure costs - not in the per-call ledger above.
              Total: <span className="font-semibold text-foreground">{fmt(Object.values(pricing.monthlySubscriptions).reduce((a, b) => a + b, 0))}/mo</span>
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {Object.entries(pricing.monthlySubscriptions).map(([key, usd]) => (
                <div key={key} className="rounded-md border border-border bg-foreground/[0.02] px-2.5 py-2">
                  <div className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}</div>
                  <div className="font-semibold tabular-nums">{usd === 0 ? 'Free' : `${fmt(usd)}/mo`}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-service breakdown cards */}
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-3 px-1">
          Spend by service · last {days === 0 ? 'all-time' : `${days}d`}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {Object.keys(SERVICE_META).map((service) => {
            const row = byService.find((r) => r.key === service)
            return <ServiceCard key={service} service={service} row={row || null} fmt={fmt} />
          })}
        </div>
      </div>

      {/* Recent calls table */}
      <Card className={cn(GLASS)}>
        <CardContent className="p-0">
          <div className="px-4 pt-4 pb-2 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
            Recent API calls
          </div>
          {recent.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-8 text-center">No calls recorded yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border/40">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-3 py-2">Service</th>
                    <th className="text-left font-medium px-3 py-2">Operation</th>
                    <th className="text-left font-medium px-3 py-2">Model</th>
                    <th className="text-right font-medium px-3 py-2">Units (in / out)</th>
                    <th className="text-right font-medium px-3 py-2">Duration</th>
                    <th className="text-right font-medium px-3 py-2">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const meta = SERVICE_META[r.service]
                    const Icon = meta?.icon
                    return (
                      <tr key={r.id} className="border-t border-border/30 hover:bg-foreground/[0.03]">
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            {Icon && <Icon className={cn('h-3.5 w-3.5', meta?.accent)} />}
                            <span>{meta?.label || r.service}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{r.operation || '-'}</td>
                        <td className="px-3 py-2 text-muted-foreground font-mono text-[11px]">{r.model || '-'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.service === 'openai'
                            ? `${fmtNumber(r.units_in)} / ${fmtNumber(r.units_out)}`
                            : fmtNumber(r.units)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                          {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '-'}
                        </td>
                        <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 tabular-nums font-medium">
                          {fmt(r.usd_cost)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* FX provenance footer - only shown when the user has picked a
          non-USD currency, so they know our rates are baked-in (not live)
          and what date they're from. Edit in api/utils/api-cost.js. */}
      {currency !== 'USD' && pricing?.fx?.asOf && (
        <p className="text-[10px] text-muted-foreground text-right">
          FX rates as of {pricing.fx.asOf} · baked into{' '}
          <code className="text-foreground">api/utils/api-cost.js</code>
        </p>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────

function KpiTile({ label, value, sub, Icon, accent }: {
  label: string
  value: string
  sub?: string
  Icon: React.ElementType
  accent: string
}) {
  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</span>
          <Icon className={cn('h-3.5 w-3.5', accent)} />
        </div>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  )
}

function ModelCard({ modelId, pricing, spend, activeSlots, fmt }: {
  modelId: string
  pricing: { in: number; out: number } | undefined
  spend: { cost_usd: number; calls: number; units_in: number; units_out: number } | undefined
  activeSlots: string[]
  fmt: (usd: number) => string
}) {
  const isActive = activeSlots.length > 0
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        isActive
          ? 'border-emerald-500/40 bg-emerald-500/[0.06] ring-1 ring-emerald-500/20'
          : 'border-border bg-foreground/[0.02]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{modelId}</span>
            {isActive && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300 bg-emerald-500/10">
                <IconCheck className="h-2.5 w-2.5 mr-0.5" />
                Active · {activeSlots.join(' + ')}
              </Badge>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Spent</div>
          <div className={cn(
            'text-sm font-semibold tabular-nums',
            spend && spend.cost_usd > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/50',
          )}>
            {spend ? fmt(spend.cost_usd) : '$0.00'}
          </div>
          {spend && spend.calls > 0 && (
            <div className="text-[9px] text-muted-foreground">{spend.calls.toLocaleString()} call{spend.calls === 1 ? '' : 's'}</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3 text-[10px]">
        <div>
          <div className="text-muted-foreground uppercase tracking-wider">Input</div>
          <div className="font-mono tabular-nums">{pricing ? fmt(pricing.in * 1_000_000) : '-'}</div>
          <div className="text-muted-foreground">/Mtok</div>
        </div>
        <div>
          <div className="text-muted-foreground uppercase tracking-wider">Output</div>
          <div className="font-mono tabular-nums">{pricing ? fmt(pricing.out * 1_000_000) : '-'}</div>
          <div className="text-muted-foreground">/Mtok</div>
        </div>
      </div>

      {spend && (spend.units_in > 0 || spend.units_out > 0) && (
        <div className="mt-2 pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
          {fmtNumber(spend.units_in)} prompt · {fmtNumber(spend.units_out)} completion
        </div>
      )}
    </div>
  )
}

function ServiceCard({ service, row, fmt }: { service: string; row: BreakdownRow | null; fmt: (usd: number) => string }) {
  const meta = SERVICE_META[service]
  const Icon = meta?.icon
  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            {Icon && <Icon className={cn('h-4 w-4', meta?.accent)} />}
            <span className="text-sm font-semibold">{meta?.label || service}</span>
          </span>
          <span className={cn(
            'text-xl font-semibold tabular-nums',
            row && row.usd_cost > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/50',
          )}>
            {row ? fmt(row.usd_cost) : '$0.00'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3 text-[10px]">
          <div>
            <div className="text-muted-foreground uppercase tracking-wider">Calls</div>
            <div className="tabular-nums">{row ? row.calls.toLocaleString() : '0'}</div>
          </div>
          <div>
            <div className="text-muted-foreground uppercase tracking-wider">Units</div>
            <div className="tabular-nums">{row ? fmtNumber(row.units) : '0'}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function DailyChart({ days, fmt }: { days: DailyRow[]; fmt: (usd: number) => string }) {
  const max = Math.max(...days.map((d) => d.usd_cost), 0.0001)
  return (
    <div className="space-y-2">
      <div className="flex items-end h-28 gap-px">
        {days.map((d) => {
          const h = max > 0 ? Math.max(2, (d.usd_cost / max) * 100) : 2
          const active = d.usd_cost > 0
          return (
            <div
              key={d.date}
              title={`${d.date} · ${fmt(d.usd_cost)} · ${d.calls} calls`}
              className={cn(
                'flex-1 rounded-t transition-opacity hover:opacity-100',
                active ? 'bg-sky-500/60 opacity-90' : 'bg-muted/40 opacity-50',
              )}
              style={{ height: `${h}%` }}
            />
          )
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{days[0]?.date.slice(5) ?? ''}</span>
        <span>{days[Math.floor(days.length / 2)]?.date.slice(5) ?? ''}</span>
        <span>{days[days.length - 1]?.date.slice(5) ?? ''}</span>
      </div>
    </div>
  )
}
