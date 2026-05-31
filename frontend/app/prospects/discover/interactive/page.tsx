"use client"

/**
 * Interactive discovery wizard.
 *
 * Drives the new step-gated discovery flow:
 *   1. Setup    — location + country + size preference + result count
 *                 (with an optional "Suggest" call to Claude for a sane count)
 *   2. Review   — Claude returns candidates, user edits/adds/deletes them
 *                 and inspects the exact Tavily query for each row
 *   3. Running  — verify (Tavily) + enrich (Claude) + save (DB), with a
 *                 persistent transcript above the step indicator
 *   4. Done     — summary, transcript still visible
 *
 * The legacy /prospects/discover page is left untouched — this wizard is
 * additive until the team has signed off on it.
 */

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { api } from "@/lib/api"
import type {
  DiscoveryCandidate,
  DiscoveryConfidence,
  DiscoveryStatus,
  Prospect,
  SizePreference,
} from "@/lib/types"
import { useVertical } from "@/lib/vertical-context"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  ChevronLeft, Telescope, Brain, Globe, FileText, Save,
  CheckCircle2, AlertTriangle, Wifi, Users, RefreshCw, Sparkles,
  Pencil, Trash2, Plus, Search, ArrowLeft, ExternalLink,
  Loader2, Play, Circle, Send, FlaskConical,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { COUNTRIES } from "@/lib/countries"
import { DiscoveryTranscript } from "@/components/prospects/DiscoveryTranscript"

// ── Vertical-aware copy ───────────────────────────────────────────────────────

type VerticalCopy = {
  segmentType: string
  entityPlural: string
  entitySingular: string
  pageSubtitle: string
  locationPlaceholder: string
  sizeUnit: string  // "berths" or "vehicles"
}

const VERTICAL_COPY: Record<string, VerticalCopy> = {
  car_rental: {
    segmentType: "car_rental",
    entityPlural: "car rental businesses",
    entitySingular: "car rental business",
    pageSubtitle: "Step-by-step lead generation — review every search before it runs",
    locationPlaceholder: "Orlando, Dallas, Phoenix, Denver, Atlanta...",
    sizeUnit: "vehicles",
  },
}

function copyFor(vertical: string): VerticalCopy {
  return VERTICAL_COPY[vertical] ?? VERTICAL_COPY.car_rental
}

// ── Size preference metadata ──────────────────────────────────────────────────

const SIZE_OPTIONS: Array<{ value: SizePreference; label: string; desc: string }> = [
  { value: "any",               label: "Any size",            desc: "Mix of independents, regional players, and well-known names." },
  { value: "small_independent", label: "Small / independent", desc: "Family-run and independent operators only — skip major chains." },
  { value: "established",       label: "Established",         desc: "Well-known, multi-location, or long-history operators." },
]

// ── Chip styling for the review table ────────────────────────────────────────

function confidenceClass(c: DiscoveryConfidence | null | undefined): string {
  switch (c) {
    case "high":   return "bg-emerald-950/50 text-emerald-300 border-emerald-800/60"
    case "medium": return "bg-amber-950/50 text-amber-300 border-amber-800/60"
    case "low":    return "bg-red-950/40 text-red-300 border-red-900/60"
    default:       return "bg-gray-800 text-gray-500 border-gray-700"
  }
}

function ownershipClass(o: string | null | undefined): string {
  switch (o) {
    case "family":     return "bg-sky-950/40 text-sky-300 border-sky-800/60"
    case "club":       return "bg-violet-950/40 text-violet-300 border-violet-800/60"
    case "corporate":  return "bg-gray-800 text-gray-300 border-gray-700"
    case "franchisee": return "bg-amber-950/40 text-amber-300 border-amber-800/60"
    default:           return "bg-gray-800 text-gray-500 border-gray-700"
  }
}

/** Normalise a guessed_website value into something we can stick in href. Returns
 * null when there's nothing usable. Accepts bare domains ("marina.com") and full
 * URLs alike — Claude is inconsistent. */
function websiteHref(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

// ── Step indicator (shared between running and done views) ───────────────────

type Phase = "setup" | "generating" | "review" | "running" | "done"

/** Per-prospect research state for the done-view sidebar.
 *   idle    — not yet researched in this session
 *   running — kicked off, polling for completion
 *   done    — research_profile populated successfully
 *   error   — backend reported an error or timeout
 */
type ResearchState = "idle" | "running" | "done" | "error"

const RUNNING_STEPS = [
  { key: "verifying",  label: "Tavily verification", icon: Globe,        desc: "Searching the live web for each candidate" },
  { key: "enriching",  label: "Claude enrichment",   icon: FileText,     desc: "Extracting decision-makers from snippets" },
  { key: "saving",     label: "Saving prospects",    icon: Save,         desc: "Writing to the database" },
  { key: "complete",   label: "Complete",            icon: CheckCircle2, desc: "" },
]

function RunningStepIndicator({ status }: { status: DiscoveryStatus | null }) {
  const currentStepIdx = status
    ? RUNNING_STEPS.findIndex((s) => s.key === status.step)
    : -1

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-sm font-medium text-white">Running discovery</span>
          {status?.data_source && (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-medium",
              status.data_source === "tavily"
                ? "bg-emerald-900/50 text-emerald-400"
                : "bg-violet-900/50 text-violet-400"
            )}>
              {status.data_source === "tavily" ? "Live" : "Claude"}
            </span>
          )}
          {status && status.total > 0 && (
            <span className="ml-auto text-xs text-gray-500">
              {status.found}/{status.total} saved
            </span>
          )}
        </div>

        <div className="space-y-3">
          {RUNNING_STEPS.map((step, i) => {
            const isDone = currentStepIdx > i || status?.step === "complete"
            const isActive = status?.step === step.key
            const Icon = step.icon
            return (
              <div key={step.key} className="flex items-start gap-3">
                <div className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all",
                  isDone   ? "bg-emerald-900/60 border border-emerald-700" :
                  isActive ? "bg-violet-900/60 border border-violet-600 animate-pulse" :
                             "bg-gray-800 border border-gray-700"
                )}>
                  <Icon className={cn(
                    "w-3.5 h-3.5",
                    isDone   ? "text-emerald-400" :
                    isActive ? "text-violet-400" :
                               "text-gray-600"
                  )} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    "text-sm font-medium",
                    isDone   ? "text-emerald-400" :
                    isActive ? "text-white" :
                               "text-gray-600"
                  )}>{step.label}</div>
                  {isActive && status?.message ? (
                    <div className="text-xs text-gray-400 mt-0.5">{status.message}</div>
                  ) : !isActive && step.desc ? (
                    <div className="text-xs text-gray-600">{step.desc}</div>
                  ) : null}
                </div>
                {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-1" />}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InteractiveDiscoverPage() {
  const { vertical } = useVertical()
  const copy = copyFor(vertical)

  const [phase, setPhase] = useState<Phase>("setup")

  // Setup-form state
  const [location, setLocation] = useState("")
  const [countryCode, setCountryCode] = useState("US")
  const [sizePreference, setSizePreference] = useState<SizePreference>("any")
  const [maxResults, setMaxResults] = useState(10)
  const [mode, setMode] = useState<"tavily" | "claude">("tavily")
  const [includeLowConfidence, setIncludeLowConfidence] = useState(false)

  // External state
  const [tavilyAvailable, setTavilyAvailable] = useState<boolean | null>(null)
  const [suggestedCount, setSuggestedCount] = useState<{ n: number; reasoning: string } | null>(null)
  const [isSuggesting, setIsSuggesting] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Review-phase state
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([])
  const [skippedExcluded, setSkippedExcluded] = useState(0)
  const [sizeFocus, setSizeFocus] = useState("")

  // Running / done state
  const [status, setStatus] = useState<DiscoveryStatus | null>(null)
  const [finalStatus, setFinalStatus] = useState<DiscoveryStatus | null>(null)

  // Done-view sidebar state — populated when phase=done with prospect_ids returned.
  const [discoveredProspects, setDiscoveredProspects] = useState<Prospect[]>([])
  const [researchStatus, setResearchStatus] = useState<Record<number, ResearchState>>({})
  // Score state mirrors research state but tracks the prospector batch call.
  // Both are independent — a row can have research=done while score=idle.
  const [scoreStatus, setScoreStatus] = useState<Record<number, ResearchState>>({})
  const [scoreReasoning, setScoreReasoning] = useState<Record<number, string>>({})
  const [scoreValue, setScoreValue] = useState<Record<number, number>>({})
  const [researchMode, setResearchMode] = useState<"parallel" | "sequential">("parallel")
  const [isResearchingAll, setIsResearchingAll] = useState(false)
  const [isScoringAll, setIsScoringAll] = useState(false)

  // Tavily availability check on mount.
  useEffect(() => {
    api.getDiscoveryStatus().then((s) => {
      const available = s.tavily_available ?? false
      setTavilyAvailable(available)
      setMode(available ? "tavily" : "claude")
    }).catch(() => {})
  }, [])

  // Poll /status while running.
  const pollRef = useRef<number | null>(null)
  useEffect(() => {
    if (phase !== "running") return
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      try {
        const s = await api.getDiscoveryStatus()
        if (cancelled) return
        setStatus(s)
        if (s.step === "complete" || s.step === "error") {
          setFinalStatus(s)
          setPhase("done")
          return
        }
      } catch {/* swallow — next tick will retry */}
      pollRef.current = window.setTimeout(tick, 1500)
    }

    pollRef.current = window.setTimeout(tick, 600)
    return () => {
      cancelled = true
      if (pollRef.current) {
        window.clearTimeout(pollRef.current)
        pollRef.current = null
      }
    }
  }, [phase])

  // When the run completes, fetch full prospect rows for the IDs the agent
  // saved. Drives the "Discovered prospects" sidebar — shows name / city /
  // contact and lets the user kick off research or jump to a campaign.
  useEffect(() => {
    if (phase !== "done") return
    const ids = finalStatus?.prospect_ids ?? []
    if (ids.length === 0) {
      setDiscoveredProspects([])
      setResearchStatus({})
      return
    }
    let cancelled = false
    Promise.all(ids.map((id) => api.getProspect(id).catch(() => null))).then((results) => {
      if (cancelled) return
      const rows = results.filter((p): p is Prospect => p !== null)
      setDiscoveredProspects(rows)
      // Seed both status maps to "idle". Pre-populate score state from any
      // existing icp_score on the row (a re-discovered prospect that was
      // already scored from a prior session) so the user doesn't re-run.
      setResearchStatus(Object.fromEntries(rows.map((p) => [p.id, "idle" as ResearchState])))
      const initScoreStatus: Record<number, ResearchState> = {}
      const initScoreValue: Record<number, number> = {}
      const initScoreReasoning: Record<number, string> = {}
      for (const p of rows) {
        if (p.icp_score !== null && p.icp_score !== undefined) {
          initScoreStatus[p.id] = "done"
          initScoreValue[p.id] = p.icp_score
          initScoreReasoning[p.id] = p.research_profile?.icp_reasoning ?? ""
        } else {
          initScoreStatus[p.id] = "idle"
        }
      }
      setScoreStatus(initScoreStatus)
      setScoreValue(initScoreValue)
      setScoreReasoning(initScoreReasoning)
    })
    return () => { cancelled = true }
  }, [phase, finalStatus?.prospect_ids])

  // ── Handlers ──────────────────────────────────────────────────────────────

  /** Kick off research for one prospect and poll its progress until done.
   * Resolves on success, throws on error/timeout. Updates researchStatus as
   * a side effect. */
  async function researchOne(id: number): Promise<void> {
    setResearchStatus((prev) => ({ ...prev, [id]: "running" }))
    try {
      await api.runResearch(id)
      // Poll every 1.5s, up to 90s total. The backend persists the "complete"
      // step in the in-memory store so a slightly slow frontend tick still
      // catches it.
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const s = await api.getResearchStatus(id)
        if (s.step === "complete") {
          setResearchStatus((prev) => ({ ...prev, [id]: "done" }))
          return
        }
        if (s.step === "error") throw new Error(s.message || "research failed")
      }
      throw new Error("research timed out after 90s")
    } catch (err) {
      console.error(`research failed for prospect ${id}:`, err)
      setResearchStatus((prev) => ({ ...prev, [id]: "error" }))
    }
  }

  /** Score one or more prospects against the ICP using the standalone
   * prospector endpoint. Synchronous batch call — single LLM invocation
   * scores everyone, so we set all targets to "running" then flip them
   * to "done" or "error" together when the response arrives. */
  async function scoreProspects(ids: number[]): Promise<void> {
    if (ids.length === 0) return
    setScoreStatus((prev) => {
      const next = { ...prev }
      ids.forEach((id) => { next[id] = "running" })
      return next
    })
    try {
      const res = await api.scoreProspects(ids)
      setScoreStatus((prev) => {
        const next = { ...prev }
        for (const s of res.scores) next[s.prospect_id] = "done"
        // Any IDs we asked for but didn't get back → mark error so the chip is honest
        const returned = new Set(res.scores.map((s) => s.prospect_id))
        ids.forEach((id) => { if (!returned.has(id)) next[id] = "error" })
        return next
      })
      setScoreValue((prev) => {
        const next = { ...prev }
        for (const s of res.scores) next[s.prospect_id] = s.icp_score
        return next
      })
      setScoreReasoning((prev) => {
        const next = { ...prev }
        for (const s of res.scores) next[s.prospect_id] = s.icp_reasoning
        return next
      })
    } catch (err) {
      console.error("scoring failed:", err)
      setScoreStatus((prev) => {
        const next = { ...prev }
        ids.forEach((id) => { next[id] = "error" })
        return next
      })
    }
  }

  /** Combined "Run AI" — kicks off research (per researchMode) and ICP
   * scoring (one batch call) for every prospect that hasn't already been
   * processed. The two run in parallel: research is per-prospect, scoring
   * is a single batch call, so they're naturally independent. */
  async function runAI(): Promise<void> {
    const idleScoreIds = discoveredProspects
      .filter((p) => scoreStatus[p.id] !== "running" && scoreStatus[p.id] !== "done")
      .map((p) => p.id)
    setIsScoringAll(true)
    const scorePromise = scoreProspects(idleScoreIds).finally(() => setIsScoringAll(false))
    const researchPromise = researchAll()  // sets/clears its own isResearchingAll flag
    await Promise.all([scorePromise, researchPromise])
  }

  /** Run research across every saved prospect. Honours the researchMode
   * toggle: parallel kicks off up to 3 concurrently for speed; sequential
   * runs one at a time so the demo audience can watch each in turn. */
  async function researchAll(): Promise<void> {
    if (isResearchingAll) return
    const targets = discoveredProspects
      .filter((p) => researchStatus[p.id] !== "running" && researchStatus[p.id] !== "done")
      .map((p) => p.id)
    if (targets.length === 0) return
    setIsResearchingAll(true)
    try {
      if (researchMode === "sequential") {
        for (const id of targets) {
          await researchOne(id)
        }
      } else {
        // Parallel with a fixed concurrency cap of 3 — matches the campaign
        // pipeline's semaphore. Workers pull from a shared queue.
        const queue = [...targets]
        const worker = async () => {
          while (queue.length > 0) {
            const id = queue.shift()
            if (id === undefined) return
            await researchOne(id)
          }
        }
        const workers = Array.from({ length: Math.min(3, queue.length) }, () => worker())
        await Promise.all(workers)
      }
    } finally {
      setIsResearchingAll(false)
    }
  }

  async function handleSuggestCount() {
    if (!location.trim()) return
    setIsSuggesting(true)
    setError(null)
    try {
      const res = await api.suggestDiscoveryCount(
        location.trim(), countryCode, copy.segmentType, sizePreference,
      )
      setSuggestedCount({ n: res.suggested, reasoning: res.reasoning })
      setMaxResults(res.suggested)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Couldn't get a suggestion: ${msg}`)
    } finally {
      setIsSuggesting(false)
    }
  }

  async function handleGenerate() {
    if (!location.trim()) return
    setIsGenerating(true)
    setError(null)
    setPhase("generating")
    try {
      const res = await api.generateDiscoveryCandidates(
        location.trim(), countryCode, maxResults,
        copy.segmentType, sizePreference,
      )
      setCandidates(res.candidates)
      setSkippedExcluded(res.skipped_excluded)
      setSizeFocus(res.size_focus)
      setPhase("review")
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Generate failed: ${msg}`)
      setPhase("setup")
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleRunDiscovery() {
    setError(null)
    setStatus(null)
    setFinalStatus(null)
    setPhase("running")
    try {
      await api.enrichSaveDiscoveryCandidates(
        location.trim(), candidates, mode, copy.segmentType,
        includeLowConfidence, skippedExcluded,
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Run failed: ${msg}`)
      setPhase("review")
    }
  }

  function updateCandidate(idx: number, patch: Partial<DiscoveryCandidate>) {
    setCandidates((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  }

  function removeCandidate(idx: number) {
    setCandidates((prev) => prev.filter((_, i) => i !== idx))
  }

  function addCandidate() {
    const blank: DiscoveryCandidate = {
      business_name: "",
      city: location.trim() || "",
      country_code: countryCode,
      estimated_capacity: null,
      guessed_website: null,
      guessed_ownership_type: null,
      confidence: null,
      notable_for: null,
      planned_query: "",
    }
    setCandidates((prev) => [...prev, blank])
  }

  function rebuildPlannedQuery(idx: number) {
    const c = candidates[idx]
    if (!c) return
    const suffix = "car rental fleet booking official website contact"
    const q = `"${c.business_name}" ${c.city} ${suffix}`
    updateCandidate(idx, { planned_query: q })
  }

  function resetWizard() {
    setPhase("setup")
    setCandidates([])
    setStatus(null)
    setFinalStatus(null)
    setSkippedExcluded(0)
    setError(null)
    setDiscoveredProspects([])
    setResearchStatus({})
    setScoreStatus({})
    setScoreValue({})
    setScoreReasoning({})
    setIsResearchingAll(false)
    setIsScoringAll(false)
  }

  const canGenerate = location.trim().length > 0 && !isGenerating
  const canRun = candidates.length > 0 &&
    candidates.every((c) => c.business_name.trim() && c.city.trim())

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link href="/prospects">
          <Button variant="ghost" size="sm" className="text-gray-400 hover:text-gray-200 -ml-2">
            <ChevronLeft className="w-4 h-4" /> Prospects
          </Button>
        </Link>
        <Link href="/prospects/discover">
          <Button variant="ghost" size="sm" className="text-gray-500 hover:text-gray-300">
            Switch to one-shot mode
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-violet-900/40 border border-violet-800/50 flex items-center justify-center">
          <Telescope className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">Interactive Discovery</h1>
          <p className="text-sm text-gray-500 mt-0.5">{copy.pageSubtitle}</p>
        </div>
      </div>

      {error && (
        <Card className="bg-red-950/20 border-red-900/40">
          <CardContent className="p-3 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm text-red-300">{error}</div>
          </CardContent>
        </Card>
      )}

      {/* ── Phase: setup / generating ─────────────────────────────────────── */}
      {(phase === "setup" || phase === "generating") && (
        <div className="space-y-4 max-w-2xl">
          {/* Data source toggle */}
          <div className="space-y-2">
            <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block">
              Data source
            </label>
            <div className="flex rounded-lg border border-gray-700 overflow-hidden">
              <button
                onClick={() => setMode("tavily")}
                disabled={!tavilyAvailable}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  mode === "tavily"
                    ? "bg-emerald-900/50 text-emerald-300 border-r border-gray-700"
                    : "bg-gray-900 text-gray-500 border-r border-gray-700 hover:text-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                )}
              >
                <Wifi className="w-3.5 h-3.5 shrink-0" />
                Live Web Search
                {tavilyAvailable && (
                  <span className="text-[10px] font-normal text-emerald-500/80 ml-0.5">(Tavily)</span>
                )}
              </button>
              <button
                onClick={() => setMode("claude")}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors",
                  mode === "claude"
                    ? "bg-violet-900/50 text-violet-300"
                    : "bg-gray-900 text-gray-500 hover:text-gray-300"
                )}
              >
                <Brain className="w-3.5 h-3.5 shrink-0" />
                Claude Knowledge
              </button>
            </div>
            {tavilyAvailable === false && (
              <p className="text-xs text-gray-600">
                <AlertTriangle className="w-3 h-3 inline mr-1" />
                No Tavily API key configured — live search unavailable.
              </p>
            )}
          </div>

          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="p-5 space-y-4">
              {/* Location + country */}
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1.5">
                    Location
                  </label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => { setLocation(e.target.value); setSuggestedCount(null) }}
                    placeholder={copy.locationPlaceholder}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1.5">
                    Country
                  </label>
                  <Select value={countryCode} onValueChange={(v) => setCountryCode(v ?? "US")}>
                    <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-900 border-gray-700">
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>{c.flag} {c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Size preference */}
              <div>
                <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1.5">
                  Operator size
                </label>
                <Select
                  value={sizePreference}
                  onValueChange={(v) => { setSizePreference((v as SizePreference) ?? "any"); setSuggestedCount(null) }}
                >
                  <SelectTrigger className="bg-gray-800 border-gray-700 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gray-900 border-gray-700">
                    {SIZE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <div className="flex flex-col items-start">
                          <span className="text-sm">{opt.label}</span>
                          <span className="text-[11px] text-gray-500">{opt.desc}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Max results + suggest */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-gray-500 font-medium uppercase tracking-wider">
                    How many candidates to ask Claude for
                  </label>
                  <Button
                    onClick={handleSuggestCount}
                    disabled={!location.trim() || isSuggesting}
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px] text-violet-400 hover:text-violet-300 hover:bg-violet-950/40"
                  >
                    {isSuggesting ? (
                      <><RefreshCw className="w-3 h-3 mr-1 animate-spin" /> Asking Claude...</>
                    ) : (
                      <><Sparkles className="w-3 h-3 mr-1" /> Suggest from location</>
                    )}
                  </Button>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={1} max={50} value={maxResults}
                    onChange={(e) => setMaxResults(Number(e.target.value))}
                    className="flex-1 accent-violet-500"
                  />
                  <input
                    type="number" min={1} max={50} value={maxResults}
                    onChange={(e) => setMaxResults(Math.max(1, Math.min(50, Number(e.target.value))))}
                    className="w-16 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200 text-center focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>
                {suggestedCount && (
                  <p className="text-[11px] text-violet-400 mt-1.5 italic">
                    Claude suggests {suggestedCount.n} — {suggestedCount.reasoning}
                  </p>
                )}
              </div>

              {/* Include low-confidence */}
              <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-md border border-gray-800 bg-gray-800/30 cursor-pointer hover:border-gray-700">
                <input
                  type="checkbox"
                  checked={includeLowConfidence}
                  onChange={(e) => setIncludeLowConfidence(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 accent-amber-500 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-200 font-medium">
                    Include low-confidence contacts
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">
                    Save businesses where the web doesn&apos;t reveal a real decision-maker (Claude returns
                    a generic title). They&apos;ll be flagged for manual research.
                  </div>
                </div>
              </label>

              <Button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="w-full bg-violet-700 hover:bg-violet-600 disabled:opacity-40"
              >
                {isGenerating ? (
                  <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Asking Claude for candidates...</>
                ) : (
                  <><Brain className="w-3.5 h-3.5 mr-2" /> Generate candidate list</>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-gray-900/50 border-gray-800">
            <CardContent className="p-4 text-xs text-gray-500 space-y-1.5">
              <div className="font-medium uppercase tracking-wider mb-2 text-gray-400">What happens next</div>
              <p>1. Claude lists up to {maxResults} {copy.entityPlural} it confidently knows about — no Tavily, no DB writes.</p>
              <p>2. You review the list. Edit names, edit the planned Tavily query for each row, delete bad ones, add custom ones.</p>
              <p>3. Click <span className="text-violet-400">Run Discovery</span> — Tavily verifies each candidate, Claude extracts contacts, prospects are saved.</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Phase: review ─────────────────────────────────────────────────── */}
      {phase === "review" && (
        <div className="space-y-4">
          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold text-white">
                      {candidates.length} candidate{candidates.length === 1 ? "" : "s"} from Claude
                    </h2>
                    {skippedExcluded > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-950/40 text-amber-400">
                        {skippedExcluded} excluded
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    in {location} · {SIZE_OPTIONS.find((o) => o.value === sizePreference)?.label.toLowerCase()}
                  </p>
                  {sizeFocus && (
                    <p className="text-[11px] text-gray-600 mt-1 italic">{sizeFocus}</p>
                  )}
                </div>
                <Button
                  onClick={() => setPhase("setup")}
                  variant="ghost"
                  size="sm"
                  className="text-gray-400 hover:text-gray-200 shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to setup
                </Button>
              </div>

              {/* Candidate table — two rows per candidate.
                  Row A carries the structured fields Claude returned.
                  Row B carries the editable Tavily query that will be sent. */}
              <div className="border border-gray-800 rounded-md overflow-hidden">
                <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-gray-950/60 border-b border-gray-800 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  <div className="col-span-3">Name</div>
                  <div className="col-span-2">City</div>
                  <div className="col-span-1 text-center">~{copy.sizeUnit}</div>
                  <div className="col-span-1 text-center">Web</div>
                  <div className="col-span-1 text-center">Conf</div>
                  <div className="col-span-1 text-center">Owner</div>
                  <div className="col-span-2">Notable for</div>
                  <div className="col-span-1 text-right">Del</div>
                </div>
                <div className="divide-y divide-gray-800/60">
                  {candidates.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-gray-500">
                      No candidates left. Add one below or go back to regenerate.
                    </div>
                  ) : candidates.map((c, i) => {
                    const href = websiteHref(c.guessed_website)
                    return (
                      <div key={i} className="px-3 py-2 hover:bg-gray-900/40">
                        {/* Row A — structured fields */}
                        <div className="grid grid-cols-12 gap-2 items-center">
                          <input
                            value={c.business_name}
                            onChange={(e) => updateCandidate(i, { business_name: e.target.value })}
                            placeholder="Business name"
                            className="col-span-3 px-2 py-1 bg-gray-800 border border-gray-700/60 rounded text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                          <input
                            value={c.city}
                            onChange={(e) => updateCandidate(i, { city: e.target.value })}
                            placeholder="City"
                            className="col-span-2 px-2 py-1 bg-gray-800 border border-gray-700/60 rounded text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                          <div className="col-span-1 text-center text-xs text-gray-500 tabular-nums">
                            {c.estimated_capacity ?? "—"}
                          </div>
                          <div className="col-span-1 flex justify-center">
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={c.guessed_website ?? ""}
                                className="text-sky-400 hover:text-sky-300 p-1 inline-flex items-center"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            ) : (
                              <span className="text-xs text-gray-700">—</span>
                            )}
                          </div>
                          <div className="col-span-1 flex justify-center">
                            <span
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded border font-medium uppercase tracking-wider",
                                confidenceClass(c.confidence),
                              )}
                              title={c.confidence ? `Claude confidence: ${c.confidence}` : "no confidence reported"}
                            >
                              {c.confidence ?? "—"}
                            </span>
                          </div>
                          <div className="col-span-1 flex justify-center">
                            <span
                              className={cn(
                                "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                                ownershipClass(c.guessed_ownership_type),
                              )}
                              title={c.guessed_ownership_type ?? "ownership unknown"}
                            >
                              {c.guessed_ownership_type
                                ? c.guessed_ownership_type.slice(0, 8)
                                : "—"}
                            </span>
                          </div>
                          <div
                            className="col-span-2 text-[11px] text-gray-400 italic truncate"
                            title={c.notable_for ?? ""}
                          >
                            {c.notable_for ?? <span className="text-gray-700 not-italic">—</span>}
                          </div>
                          <button
                            onClick={() => removeCandidate(i)}
                            title="Remove candidate"
                            className="col-span-1 text-gray-500 hover:text-red-400 p-1 justify-self-end"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Row B — full-width editable Tavily query */}
                        <div className="mt-1.5 flex items-center gap-1">
                          <Search className="w-3 h-3 text-gray-600 shrink-0" />
                          <span className="text-[10px] text-gray-600 uppercase tracking-wider shrink-0">
                            Tavily
                          </span>
                          <input
                            value={c.planned_query}
                            onChange={(e) => updateCandidate(i, { planned_query: e.target.value })}
                            placeholder="Tavily query"
                            className="flex-1 px-2 py-1 bg-gray-800 border border-gray-700/60 rounded text-[11px] text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
                          />
                          <button
                            onClick={() => rebuildPlannedQuery(i)}
                            title="Rebuild query from name + city"
                            className="text-gray-500 hover:text-violet-400 p-1 shrink-0"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <Button
                  onClick={addCandidate}
                  variant="outline"
                  size="sm"
                  className="border-gray-700 text-gray-400 hover:text-white"
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Add custom candidate
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    variant="ghost"
                    size="sm"
                    className="text-gray-400 hover:text-gray-200"
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", isGenerating && "animate-spin")} />
                    Regenerate
                  </Button>
                  <Button
                    onClick={handleRunDiscovery}
                    disabled={!canRun}
                    className="bg-violet-700 hover:bg-violet-600 disabled:opacity-40"
                  >
                    <Telescope className="w-3.5 h-3.5 mr-2" />
                    Run Discovery on {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Phase: running ────────────────────────────────────────────────── */}
      {phase === "running" && (
        <div className="space-y-4 max-w-2xl">
          <RunningStepIndicator status={status} />
          <DiscoveryTranscript events={status?.events ?? []} />
        </div>
      )}

      {/* ── Phase: done ───────────────────────────────────────────────────── */}
      {/* Two-column layout — left holds the transcript + summary card,
          right is a sidebar listing the prospects we just saved with
          per-row research controls and a "create campaign" jump. */}
      {phase === "done" && finalStatus && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            <DiscoveryTranscript events={finalStatus.events ?? []} autoScroll={false} />

            {finalStatus.step === "error" ? (
              <Card className="bg-red-950/20 border-red-900/40">
                <CardContent className="p-5 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-red-400">Discovery failed</div>
                    <div className="text-xs text-gray-500 mt-1">{finalStatus.message}</div>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-emerald-950/20 border-emerald-900/40">
                <CardContent className="p-6 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-emerald-900/40 border border-emerald-700 flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      Saved {finalStatus.found} {finalStatus.found === 1 ? copy.entitySingular : copy.entityPlural}
                    </h2>
                    <p className="text-sm text-gray-500 mt-1">in {location}</p>
                    {finalStatus.total > 0 && finalStatus.found < finalStatus.total && (
                      <p className="text-xs text-gray-600 mt-1">
                        {(() => {
                          const parts: string[] = []
                          const noContact = finalStatus.skipped_no_contact ?? 0
                          const excluded = finalStatus.skipped_excluded ?? 0
                          const dup = finalStatus.skipped_duplicate ?? 0
                          if (noContact) parts.push(`${noContact} skipped (no real contact)`)
                          if (excluded) parts.push(`${excluded} excluded (existing customers)`)
                          if (dup) parts.push(`${dup} already in database`)
                          if (parts.length === 0) parts.push(`${finalStatus.total - finalStatus.found} skipped`)
                          return parts.join(" · ")
                        })()}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-3 justify-center pt-2">
                    <Link href={`/prospects?country=${encodeURIComponent(countryCode)}`}>
                      <Button variant="outline" className="border-gray-700 text-gray-400 hover:text-white">
                        <Users className="w-3.5 h-3.5 mr-2" /> View All Prospects
                      </Button>
                    </Link>
                    <Button
                      onClick={resetWizard}
                      variant="outline"
                      className="border-gray-700 text-gray-400 hover:text-white"
                    >
                      Discover More
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right sidebar — only shown when we actually saved at least one prospect.
              When all candidates were skipped, the user has nothing to act on
              and the empty column would just be noise. */}
          {discoveredProspects.length > 0 ? (
            <DiscoveredProspectsSidebar
              prospects={discoveredProspects}
              researchStatus={researchStatus}
              scoreStatus={scoreStatus}
              scoreValue={scoreValue}
              scoreReasoning={scoreReasoning}
              researchMode={researchMode}
              setResearchMode={setResearchMode}
              isResearchingAll={isResearchingAll}
              isScoringAll={isScoringAll}
              onRunAI={runAI}
              onResearchOne={researchOne}
              onScoreOne={(id) => scoreProspects([id])}
              location={location}
            />
          ) : (
            <div className="rounded-md border border-dashed border-gray-800 bg-gray-900/30 p-4 text-xs text-gray-600 italic">
              No prospects saved this run — nothing to research or campaign with.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Discovered prospects sidebar ──────────────────────────────────────────────

/** Right-column sidebar shown after a successful discovery run.
 *
 * Lists the saved prospects with name / city / contact, lets the user run
 * the AI Research step inline (parallel or sequential), and provides a
 * one-click jump to the campaign creator with these IDs pre-selected. */
function DiscoveredProspectsSidebar({
  prospects, researchStatus, scoreStatus, scoreValue, scoreReasoning,
  researchMode, setResearchMode,
  isResearchingAll, isScoringAll,
  onRunAI, onResearchOne, onScoreOne, location,
}: {
  prospects: Prospect[]
  researchStatus: Record<number, ResearchState>
  scoreStatus: Record<number, ResearchState>
  scoreValue: Record<number, number>
  scoreReasoning: Record<number, string>
  researchMode: "parallel" | "sequential"
  setResearchMode: (m: "parallel" | "sequential") => void
  isResearchingAll: boolean
  isScoringAll: boolean
  onRunAI: () => void
  onResearchOne: (id: number) => void
  onScoreOne: (id: number) => void
  /** The location string the user discovered against — passed to the campaign
   * creator so its prospect picker can default to filtering by this term. */
  location: string
}) {
  const isRunningAny = isResearchingAll || isScoringAll
  // A prospect is "complete" only when BOTH research AND scoring are done.
  // Idle counts respect this so the button always shows pending work.
  const idleCount = prospects.filter((p) =>
    (researchStatus[p.id] ?? "idle") !== "done"
    || (scoreStatus[p.id] ?? "idle") !== "done"
  ).length
  const allDone = idleCount === 0

  const campaignParams = new URLSearchParams({
    prospects: prospects.map((p) => p.id).join(","),
  })
  if (location.trim()) campaignParams.set("location", location.trim())
  const campaignHref = `/campaigns/new?${campaignParams.toString()}`

  return (
    <div className="space-y-4 lg:sticky lg:top-4 self-start">
      {/* Header */}
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-4 space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-violet-400" />
              <h3 className="text-sm font-semibold text-white">
                Discovered prospects
              </h3>
              <span className="text-xs text-gray-500 ml-auto tabular-nums">
                {prospects.length}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Run AI research <span className="text-violet-400">+</span> ICP scoring,
              then launch a campaign — without leaving this page.
            </p>
          </div>

          {/* Research-mode toggle. ICP scoring is a single batch call so it's
              not affected by this toggle — only research execution speed is. */}
          <div>
            <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">
              Research execution
            </div>
            <div className="flex rounded-md border border-gray-700 overflow-hidden text-[11px]">
              <button
                onClick={() => setResearchMode("parallel")}
                disabled={isRunningAny}
                className={cn(
                  "flex-1 px-2 py-1.5 font-medium transition-colors",
                  researchMode === "parallel"
                    ? "bg-violet-600 text-white"
                    : "bg-transparent text-gray-500 hover:text-gray-300 dark:hover:text-gray-200",
                  isRunningAny && "cursor-not-allowed opacity-60",
                )}
                title="Run up to 3 prospects' research concurrently"
              >
                Parallel (3×)
              </button>
              <button
                onClick={() => setResearchMode("sequential")}
                disabled={isRunningAny}
                className={cn(
                  "flex-1 px-2 py-1.5 border-l border-gray-700 font-medium transition-colors",
                  researchMode === "sequential"
                    ? "bg-violet-600 text-white"
                    : "bg-transparent text-gray-500 hover:text-gray-300 dark:hover:text-gray-200",
                  isRunningAny && "cursor-not-allowed opacity-60",
                )}
                title="Run one at a time — calmer to watch in a demo"
              >
                Sequential
              </button>
            </div>
          </div>

          {/* Action buttons */}
          <div className="space-y-2">
            <Button
              onClick={onRunAI}
              disabled={isRunningAny || allDone}
              className="w-full bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-xs h-8"
            >
              {isRunningAny ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Running AI…</>
              ) : allDone ? (
                <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> All processed</>
              ) : (
                <><FlaskConical className="w-3.5 h-3.5 mr-1.5" /> Run AI: research + score {idleCount}</>
              )}
            </Button>
            <Link href={campaignHref}>
              <Button
                variant="outline"
                className="w-full border-emerald-800/60 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200 text-xs h-8"
              >
                <Send className="w-3.5 h-3.5 mr-1.5" />
                Create campaign with {prospects.length}
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* Prospect rows — each shows two chips (R = research, S = score) so
          the user can see which side of the AI pipeline has run. */}
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-0">
          <ul className="divide-y divide-gray-800/60">
            {prospects.map((p) => {
              const rState = researchStatus[p.id] ?? "idle"
              const sState = scoreStatus[p.id] ?? "idle"
              const score = scoreValue[p.id]
              const reasoning = scoreReasoning[p.id]
              return (
                <li key={p.id} className="px-3 py-2.5 hover:bg-gray-900/40">
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-1 shrink-0 mt-0.5">
                      <AIChip kind="R" state={rState} title="Research" />
                      <AIChip kind="S" state={sState} title="ICP score" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/prospects/${p.id}`}
                        className="text-xs font-medium text-gray-200 hover:text-violet-300 truncate block"
                        title={p.business_name}
                      >
                        {p.business_name}
                      </Link>
                      <div className="text-[10px] text-gray-500 truncate">
                        {p.city} · {p.contact_name || p.contact_title || "—"}
                      </div>
                      {/* ICP score badge — only shows once we have a value */}
                      {sState === "done" && score !== undefined && (
                        <div
                          className="mt-1 inline-flex items-center gap-1"
                          title={reasoning || "ICP score"}
                        >
                          <span className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded font-semibold tabular-nums",
                            scoreClass(score),
                          )}>
                            ICP {(score * 100).toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => onResearchOne(p.id)}
                        disabled={rState === "running" || rState === "done"}
                        title={
                          rState === "done" ? "Research complete"
                          : rState === "running" ? "Research in progress"
                          : "Research only"
                        }
                        className={cn(
                          "p-1 rounded transition-colors",
                          rState === "running" || rState === "done"
                            ? "text-gray-700 cursor-not-allowed"
                            : "text-gray-500 hover:text-violet-300 hover:bg-violet-950/30",
                        )}
                      >
                        <FileText className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => onScoreOne(p.id)}
                        disabled={sState === "running" || sState === "done"}
                        title={
                          sState === "done" ? "Already scored"
                          : sState === "running" ? "Scoring in progress"
                          : "ICP score only"
                        }
                        className={cn(
                          "p-1 rounded transition-colors",
                          sState === "running" || sState === "done"
                            ? "text-gray-700 cursor-not-allowed"
                            : "text-gray-500 hover:text-amber-300 hover:bg-amber-950/30",
                        )}
                      >
                        <Sparkles className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

/** Compact dual-purpose chip — same icon set, used for both research and score. */
function AIChip({ kind, state, title }: { kind: "R" | "S"; state: ResearchState; title: string }) {
  const tone = {
    idle:    "bg-gray-800 text-gray-600 border-gray-700",
    running: "bg-violet-950/40 text-violet-300 border-violet-800/60 animate-pulse",
    done:    "bg-emerald-950/40 text-emerald-400 border-emerald-800/60",
    error:   "bg-red-950/40 text-red-400 border-red-900/60",
  }[state]
  return (
    <span
      title={`${title}: ${state}`}
      className={cn(
        "inline-flex items-center justify-center w-4 h-4 rounded-sm border text-[9px] font-bold tabular-nums",
        tone,
      )}
    >
      {kind}
    </span>
  )
}

/** ICP-score colour bands — match the existing icpTier convention used elsewhere. */
function scoreClass(score: number): string {
  const pct = score * 100
  if (pct >= 75) return "bg-emerald-950/50 text-emerald-300 border border-emerald-800/60"
  if (pct >= 55) return "bg-sky-950/50 text-sky-300 border border-sky-800/60"
  if (pct >= 35) return "bg-amber-950/50 text-amber-300 border border-amber-800/60"
  return "bg-gray-800 text-gray-500 border border-gray-700"
}
