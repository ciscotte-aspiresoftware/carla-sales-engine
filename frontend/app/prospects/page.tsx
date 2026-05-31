"use client"

import { useEffect, useState, useCallback, useRef, memo } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { api } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { COUNTRY_NAMES } from "@/lib/countries"
import type { Prospect, ProspectListResponse } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Users, Globe, Wifi, WifiOff, ChevronRight, Search, Brain, Telescope, ShieldCheck, ShieldAlert, CheckCircle2, X, Loader2 } from "lucide-react"
import { useVertical } from "@/lib/vertical-context"
import { cn } from "@/lib/utils"

interface ScrapeTraceEntry {
  prospect_id: number
  business_name: string
  step: string
  message: string
  /** True once the polling loop has stopped because the scrape finished
   * (step === "complete") or errored out. */
  done: boolean
  /** True only when done AND it finished successfully (vs. timed out / errored). */
  ok: boolean
  started_at: number
}

const SCRAPE_STEP_LABELS: Record<string, string> = {
  queued: "Queued",
  verifying: "Verifying URL",
  fetching: "Fetching pages",
  extracting: "Extracting facts",
  saving: "Saving",
  complete: "Complete",
}

function ScrapeTraceBox({
  trace,
  onDismiss,
}: {
  trace: Record<number, ScrapeTraceEntry>
  onDismiss: () => void
}) {
  // Stable order: in-flight first (most recently active at the top), then
  // completed below. Within each group, newest started first.
  const entries = Object.values(trace).filter(Boolean) as ScrapeTraceEntry[]
  const inFlight = entries.filter((e) => !e.done).sort((a, b) => b.started_at - a.started_at)
  const finished = entries.filter((e) => e.done).sort((a, b) => b.started_at - a.started_at)
  const ordered = [...inFlight, ...finished]
  const doneCount = finished.length
  const total = entries.length
  const allDone = doneCount === total && total > 0

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {allDone ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
            )}
            <span className="text-xs font-medium text-gray-300 uppercase tracking-wider">
              Scrape trace
            </span>
            <span className="text-[11px] text-gray-500">
              {doneCount}/{total} complete
            </span>
          </div>
          <button
            onClick={onDismiss}
            className="text-gray-500 hover:text-gray-300 text-xs inline-flex items-center gap-1"
            title="Dismiss the trace (in-flight scrapes keep running in the background)"
          >
            <X className="w-3 h-3" /> Dismiss
          </button>
        </div>
        <ul className="space-y-1.5 max-h-64 overflow-y-auto">
          {ordered.map((e) => {
            // Cap animated spinners to the first few in-flight rows. The
            // rest get a static dot — visually distinguishable, ~zero GPU
            // cost. Running 25 spinning <Loader2/>s during a big batch was
            // a real contributor to the fan noise.
            const inFlightIdx = inFlight.findIndex((x) => x.prospect_id === e.prospect_id)
            const animateSpinner = !e.done && inFlightIdx >= 0 && inFlightIdx < 3
            return (
            <li key={e.prospect_id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0">
                {e.done && e.ok ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                ) : e.done ? (
                  <ShieldAlert className="w-3 h-3 text-amber-400" />
                ) : animateSpinner ? (
                  <Loader2 className="w-3 h-3 text-sky-400 animate-spin" />
                ) : (
                  <span className="block w-3 h-3 rounded-full border border-sky-800 bg-sky-950/40" />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link href={`/prospects/${e.prospect_id}`} className="text-gray-300 hover:text-white font-medium truncate">
                    {e.business_name}
                  </Link>
                  <span className={cn(
                    "text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border",
                    e.done && e.ok ? "border-emerald-800 text-emerald-400" :
                    e.done            ? "border-amber-800 text-amber-400" :
                                        "border-sky-800 text-sky-400",
                  )}>
                    {SCRAPE_STEP_LABELS[e.step] ?? e.step}
                  </span>
                </div>
                {e.message && <div className="text-[11px] text-gray-500 truncate">{e.message}</div>}
              </div>
            </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

/** One row in the prospect list. Extracted + memoised so trace-box ticks
 * during a batch scrape don't rerender the entire 25-row table — only the
 * row whose data actually changed. `memo` does a shallow prop compare,
 * which is sufficient here because the parent passes the `Prospect` object
 * straight through; the API returns new instances on each round-trip so
 * identity changes when content changes, and stays stable between
 * unrelated parent renders (trace state, toast, etc.). */
const ProspectRow = memo(function ProspectRow({ p }: { p: Prospect }) {
  return (
    <TableRow className="border-gray-800 hover:bg-gray-900/50 cursor-pointer">
      <TableCell>
        <Link href={`/prospects/${p.id}`} className="block">
          <div className="font-medium text-white text-sm">{p.business_name}</div>
          <div className="text-xs text-gray-500">{p.city}</div>
        </Link>
      </TableCell>
      <TableCell className="w-8">
        {p.research_profile ? (
          <span title="Research profile complete">
            <Brain className="w-3.5 h-3.5 text-violet-400" />
          </span>
        ) : (
          <Brain className="w-3.5 h-3.5 text-gray-800" />
        )}
      </TableCell>
      <TableCell className="w-8">
        {p.provenance?.website_url === "needs_review" ? (
          <span title="Website needs human review — system couldn't confirm it belongs to this prospect">
            <ShieldAlert className="w-3.5 h-3.5 text-yellow-400" />
          </span>
        ) : p.website_research ? (
          p.website_research.verified ? (
            <span title={
              p.website_research.meta.kind === "verification"
                ? `URL verified ${p.website_research.meta.fetched_at}`
                : `Website research complete (${p.website_research.meta.pages_fetched.length} pages, provider: ${p.website_research.meta.provider ?? "?"})`
            }>
              <ShieldCheck className={`w-3.5 h-3.5 ${p.website_research.meta.kind === "verification" ? "text-emerald-400" : "text-sky-400"}`} />
            </span>
          ) : (
            <span title={`Website unverified: ${p.website_research.reason ?? "unknown"}`}>
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            </span>
          )
        ) : (
          <span title={p.website_url ? "Not verified yet" : "No website URL"}>
            <Globe className={`w-3.5 h-3.5 ${p.website_url ? "text-gray-700" : "text-gray-900"}`} />
          </span>
        )}
      </TableCell>
      <TableCell>
        <div className="text-sm text-gray-300">{p.contact_name}</div>
        <div className="text-xs text-gray-500">{p.contact_title}</div>
      </TableCell>
      <TableCell>
        <span className="text-sm text-gray-300">
          {COUNTRY_NAMES[p.country_code] ?? p.country_code}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-sm text-gray-300">
          {p.capacity_count ?? "—"}
        </span>
      </TableCell>
      <TableCell>
        {p.has_online_booking ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <Wifi className="w-3 h-3" /> Yes
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-red-400">
            <WifiOff className="w-3 h-3" /> No
          </span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-xs border-gray-700 text-gray-400 capitalize">
          {p.ownership_type}
        </Badge>
      </TableCell>
      <TableCell>
        <IcpBadge score={p.icp_score} />
      </TableCell>
      <TableCell>
        <Link href={`/prospects/${p.id}`}>
          <ChevronRight className="w-4 h-4 text-gray-600 hover:text-gray-300" />
        </Link>
      </TableCell>
    </TableRow>
  )
})

function IcpBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-gray-600 text-xs">—</span>
  const pct = Math.round(score * 100)
  const color =
    pct >= 75 ? "bg-emerald-900/40 text-emerald-400 border-emerald-800" :
    pct >= 55 ? "bg-sky-900/40 text-sky-400 border-sky-800" :
    pct >= 35 ? "bg-yellow-900/40 text-yellow-400 border-yellow-800" :
    "bg-gray-800 text-gray-500 border-gray-700"
  const label = pct >= 75 ? "Hot" : pct >= 55 ? "Warm" : pct >= 35 ? "Cold" : "Out"
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border ${color}`}>
      {pct}% · {label}
    </span>
  )
}

export default function ProspectsPage() {
  const searchParams = useSearchParams()
  const { vertical, verticalOption } = useVertical()
  const [data, setData] = useState<ProspectListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [country, setCountry] = useState(() => searchParams.get("country") ?? "")
  const [ownership, setOwnership] = useState("")
  const [booking, setBooking] = useState("")
  const [search, setSearch] = useState(() => searchParams.get("search") ?? "")
  const [page, setPage] = useState(1)

  // Reset page when vertical changes
  useEffect(() => { setPage(1) }, [vertical])

  const load = useCallback(() => {
    setLoading(true)
    api.getProspects({
      country_code: country || undefined,
      ownership_type: ownership || undefined,
      has_online_booking: booking === "" ? undefined : booking === "true",
      vertical: vertical || undefined,
      search: search || undefined,
      page,
      limit: 25,
    })
      .then(setData)
      .finally(() => setLoading(false))
  }, [country, ownership, booking, vertical, search, page])

  useEffect(() => { load() }, [load])

  const [batchScraping, setBatchScraping] = useState(false)
  const [batchVerifying, setBatchVerifying] = useState(false)
  const [batchToast, setBatchToast] = useState<string | null>(null)
  const [trace, setTrace] = useState<Record<number, ScrapeTraceEntry>>({})

  // Trailing-edge debounced reload — when one or more rows finish in
  // quick succession, we fire a single `load()` instead of N. Saves the
  // table from re-rendering 25× during a big batch scrape.
  const reloadTimerRef = useRef<number | null>(null)
  const debouncedReload = useCallback(() => {
    if (reloadTimerRef.current !== null) {
      window.clearTimeout(reloadTimerRef.current)
    }
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null
      load()
    }, 300)
  }, [load])

  // Sweep all in-flight trace entries on each tick. One poll loop drives
  // up to N statuses — cheaper than N concurrent recursive setTimeouts,
  // and it gets the visibility / cancellation discipline of usePoll for
  // free. Stops polling automatically when every row has reached a
  // terminal state.
  const traceRef = useRef(trace)
  traceRef.current = trace
  const hasInFlight = Object.values(trace).some((e) => !e.done)
  usePoll(async (signal) => {
    const inFlight = Object.values(traceRef.current).filter((e) => !e.done)
    if (inFlight.length === 0) return "stop"
    let anyJustCompleted = false
    await Promise.all(inFlight.map(async (e) => {
      try {
        const s = await api.getWebsiteScrapeStatus(e.prospect_id)
        if (signal.aborted) return
        setTrace((prev) => {
          const existing = prev[e.prospect_id]
          if (!existing || existing.done) return prev
          const justComplete = s.step === "complete"
          if (justComplete) anyJustCompleted = true
          return {
            ...prev,
            [e.prospect_id]: {
              ...existing,
              step: s.step || existing.step,
              message: s.message || existing.message,
              done: justComplete || existing.done,
              ok: justComplete ? true : existing.ok,
            },
          }
        })
      } catch {
        /* transient — try again next tick */
      }
      // Time-out rows that have been alive >3 min, so a stuck job
      // doesn't keep the poll loop running forever.
      const age = Date.now() - e.started_at
      if (age > 180_000) {
        setTrace((prev) => {
          const existing = prev[e.prospect_id]
          if (!existing || existing.done) return prev
          return {
            ...prev,
            [e.prospect_id]: { ...existing, done: true, ok: false, message: "Timed out — check Activity Timeline." },
          }
        })
      }
    }))
    if (anyJustCompleted) debouncedReload()
  }, { interval: 1500, enabled: hasInFlight, initialDelay: 800 })

  // Cancel any debounced reload on unmount.
  useEffect(() => {
    return () => {
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current)
    }
  }, [])

  const startScrapeTrace = (prospects: Pick<Prospect, "id" | "business_name">[]) => {
    const now = Date.now()
    setTrace((prev) => {
      const next = { ...prev }
      for (const p of prospects) {
        next[p.id] = {
          prospect_id: p.id,
          business_name: p.business_name,
          step: "queued",
          message: "Queued",
          done: false,
          ok: false,
          started_at: now,
        }
      }
      return next
    })
    // The usePoll above sees the trace is non-empty (hasInFlight=true) and
    // starts ticking on its own — no per-row poller spawn needed.
  }

  const dismissTrace = () => {
    setTrace({})
  }

  const verifyVisibleUrls = async () => {
    if (!data) return
    const ids = data.prospects.map((p) => p.id).slice(0, 50)
    if (ids.length === 0) {
      setBatchToast("Nothing to verify on this page.")
      setTimeout(() => setBatchToast(null), 4000)
      return
    }
    setBatchVerifying(true)
    try {
      const r = await api.verifyWebsitesBatch(ids)
      const s = r.summary
      setBatchToast(
        `Verified ${s.verified} · needs review ${s.needs_review} · broken ${s.broken} · no URL ${s.no_url}${s.errored ? ` · errored ${s.errored}` : ""}`,
      )
      setTimeout(() => setBatchToast(null), 8000)
      load()
    } catch (e) {
      setBatchToast(`Batch verify failed: ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setBatchToast(null), 6000)
    } finally {
      setBatchVerifying(false)
    }
  }

  const scrapeVisibleUnenriched = async () => {
    if (!data) return
    // Target prospects with a URL that haven't had a FULL scrape yet —
    // including ones with only lite-verification records (meta.kind ==
    // "verification"). Those would otherwise be excluded by a naive
    // !website_research check.
    const targets = data.prospects.filter((p) => {
      if (!p.website_url) return false
      const kind = p.website_research?.meta?.kind
      return !p.website_research || kind === "verification"
    }).slice(0, 25)
    if (targets.length === 0) {
      setBatchToast("Nothing to scrape on this page — every prospect with a website has already been fully scraped, or none have a URL.")
      setTimeout(() => setBatchToast(null), 4000)
      return
    }
    setBatchScraping(true)
    try {
      const r = await api.runWebsiteScrapeBatch(
        targets.map((p) => p.id),
        { max_pages: 2, preferred_keywords: ["about", "services"] },
      )
      setBatchToast(`Started scraping ${r.started} prospect${r.started === 1 ? "" : "s"}. Watch the trace below for progress.`)
      setTimeout(() => setBatchToast(null), 5000)
      startScrapeTrace(targets)
    } catch (e) {
      setBatchToast(`Batch scrape failed: ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setBatchToast(null), 6000)
    } finally {
      setBatchScraping(false)
    }
  }

  const scrapeVerifiedUnscraped = async () => {
    if (!data) return
    // Prospects whose URL passed verification but haven't had the full
    // scrape pipeline run yet. This is the natural follow-up after a
    // "Verify URLs" batch — pull the green-flagged ones into the full
    // enrichment pipeline.
    const targets = data.prospects.filter((p) => {
      if (!p.website_url) return false
      const wr = p.website_research
      if (!wr) return false
      if (!wr.verified) return false
      return wr.meta?.kind === "verification"
    }).slice(0, 25)
    if (targets.length === 0) {
      setBatchToast("No verified-but-not-scraped prospects on this page. Run 'Verify URLs' first, then come back.")
      setTimeout(() => setBatchToast(null), 5000)
      return
    }
    setBatchScraping(true)
    try {
      const r = await api.runWebsiteScrapeBatch(
        targets.map((p) => p.id),
        { max_pages: 2, preferred_keywords: ["about", "services"] },
      )
      setBatchToast(`Started scraping ${r.started} verified prospect${r.started === 1 ? "" : "s"}. Watch the trace below for progress.`)
      setTimeout(() => setBatchToast(null), 5000)
      startScrapeTrace(targets)
    } catch (e) {
      setBatchToast(`Batch scrape failed: ${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setBatchToast(null), 6000)
    } finally {
      setBatchScraping(false)
    }
  }

  const colLabel = "Fleet Size"
  const searchPlaceholder = "Search by company or contact..."

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Users className={`w-5 h-5 ${verticalOption.color}`} />
            {verticalOption.label} Prospects
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {data?.total ?? "—"} prospects · sorted by ICP score
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={verifyVisibleUrls}
            disabled={batchVerifying || loading || !data}
            className="border-gray-700 text-gray-300 hover:text-white"
            title="Check that each prospect's website URL still resolves and plausibly belongs to them (capped at 50)"
          >
            <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
            {batchVerifying ? "Verifying…" : "Verify URLs"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={scrapeVerifiedUnscraped}
            disabled={batchScraping || loading || !data}
            className="border-gray-700 text-gray-300 hover:text-white"
            title="Run the full scrape pipeline on prospects whose URL was verified but never fully scraped (capped at 25)"
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
            {batchScraping ? "Scraping…" : "Scrape Verified"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={scrapeVisibleUnenriched}
            disabled={batchScraping || loading || !data}
            className="border-gray-700 text-gray-300 hover:text-white"
            title="Scrape all prospects on this page that don't have a full scrape yet (capped at 25)"
          >
            <Globe className="w-3.5 h-3.5 mr-1.5" />
            {batchScraping ? "Scraping…" : "Scrape Websites"}
          </Button>
          <Link href="/prospects/discover">
            <Button size="sm" className="bg-violet-700 hover:bg-violet-600">
              <Telescope className="w-3.5 h-3.5 mr-1.5" />
              Discover Prospects
            </Button>
          </Link>
        </div>
      </div>

      {batchToast && (
        <div className="rounded-md border border-sky-800/60 bg-sky-950/30 text-sky-300 text-sm px-3 py-2">
          {batchToast}
        </div>
      )}

      {Object.keys(trace).length > 0 && (
        <ScrapeTraceBox trace={trace} onDismiss={dismissTrace} />
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            className="pl-9 pr-3 py-2 text-sm bg-gray-900 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500 w-56"
          />
        </div>
        <Select value={country} onValueChange={(v) => { setCountry((v ?? "all") === "all" ? "" : (v ?? "")); setPage(1) }}>
          <SelectTrigger className="w-36 bg-gray-900 border-gray-700 text-sm">
            <Globe className="w-3.5 h-3.5 mr-1.5 text-gray-500" />
            <SelectValue placeholder="All regions" />
          </SelectTrigger>
          <SelectContent className="bg-gray-900 border-gray-700">
            <SelectItem value="all">All regions</SelectItem>
            {Object.entries(COUNTRY_NAMES).map(([code, label]) => (
              <SelectItem key={code} value={code}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ownership} onValueChange={(v) => { setOwnership((v ?? "all") === "all" ? "" : (v ?? "")); setPage(1) }}>
          <SelectTrigger className="w-36 bg-gray-900 border-gray-700 text-sm">
            <SelectValue placeholder="Ownership" />
          </SelectTrigger>
          <SelectContent className="bg-gray-900 border-gray-700">
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="family">Family</SelectItem>
            <SelectItem value="corporate">Corporate</SelectItem>
            <SelectItem value="club">Club</SelectItem>
          </SelectContent>
        </Select>
        <Select value={booking} onValueChange={(v) => { setBooking((v ?? "all") === "all" ? "" : (v ?? "")); setPage(1) }}>
          <SelectTrigger className="w-40 bg-gray-900 border-gray-700 text-sm">
            <SelectValue placeholder="Online booking" />
          </SelectTrigger>
          <SelectContent className="bg-gray-900 border-gray-700">
            <SelectItem value="all">Any booking status</SelectItem>
            <SelectItem value="false">No online booking</SelectItem>
            <SelectItem value="true">Has online booking</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-gray-800 hover:bg-transparent">
              <TableHead className="text-gray-500 text-xs">Prospect</TableHead>
              <TableHead className="text-gray-500 text-xs w-8" title="Research profile status" />
              <TableHead className="text-gray-500 text-xs w-8" title="Website research status" />
              <TableHead className="text-gray-500 text-xs">Contact</TableHead>
              <TableHead className="text-gray-500 text-xs">Region</TableHead>
              <TableHead className="text-gray-500 text-xs">{colLabel}</TableHead>
              <TableHead className="text-gray-500 text-xs">Online Booking</TableHead>
              <TableHead className="text-gray-500 text-xs">Ownership</TableHead>
              <TableHead className="text-gray-500 text-xs">ICP Score</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i} className="border-gray-800">
                    {Array.from({ length: 9 }).map((__, j) => (
                      <TableCell key={j}><Skeleton className="h-4 bg-gray-800 rounded w-full" /></TableCell>
                    ))}
                    <TableCell />
                  </TableRow>
                ))
              : data?.prospects.map((p) => <ProspectRow key={p.id} p={p} />)}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {data && data.pages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>Page {data.page} of {data.pages} · {data.total} total</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 rounded bg-gray-900 border border-gray-700 hover:border-gray-500 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
              disabled={page === data.pages}
              className="px-3 py-1.5 rounded bg-gray-900 border border-gray-700 hover:border-gray-500 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
