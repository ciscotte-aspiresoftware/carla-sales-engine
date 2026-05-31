"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { api } from "@/lib/api"
import type { DiscoveryStatus } from "@/lib/types"
import { useVertical } from "@/lib/vertical-context"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ChevronLeft, Telescope, Brain, Globe, FileText, Save,
  CheckCircle2, AlertTriangle, Wifi, Users, RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { COUNTRIES } from "@/lib/countries"
import { DiscoveryTranscript } from "@/components/prospects/DiscoveryTranscript"

// Per-vertical labels for the discovery flow. Keys mirror the backend SEGMENT_CONFIGS,
// so picking the right segment_type is a one-liner downstream.
type VerticalCopy = {
  segmentType: string
  entityPlural: string
  entitySingular: string
  pageSubtitle: string
  locationPlaceholder: string
  hint: string
}

const VERTICAL_COPY: Record<string, VerticalCopy> = {
  car_rental: {
    segmentType: "car_rental",
    entityPlural: "car rental businesses",
    entitySingular: "car rental business",
    pageSubtitle: "AI agent finds real car rental operators in any US location",
    locationPlaceholder: "Orlando, Dallas, Phoenix, Denver, Atlanta...",
    hint: "Claude identifies real independent car rental operators from its training knowledge",
  },
}

function copyFor(vertical: string): VerticalCopy {
  return VERTICAL_COPY[vertical] ?? VERTICAL_COPY.car_rental
}

const DISCOVERY_STEPS = (copy: VerticalCopy) => [
  {
    key: "generating",
    label: `Generating ${copy.entitySingular} candidates`,
    icon: Brain,
    desc: copy.hint,
  },
  {
    key: "verifying",
    label: "Verifying with live web search",
    icon: Globe,
    desc: `Tavily searches for each ${copy.entitySingular}'s real website and contact info`,
  },
  {
    key: "enriching",
    label: "Enriching contact data",
    icon: FileText,
    desc: "Claude extracts decision-maker contacts from search results",
  },
  {
    key: "saving",
    label: "Saving to database",
    icon: Save,
    desc: "Creating prospect records",
  },
  {
    key: "complete",
    label: "Discovery complete",
    icon: CheckCircle2,
    desc: "",
  },
]

function DiscoveryProgress({
  location,
  copy,
  onComplete,
}: {
  location: string
  copy: VerticalCopy
  onComplete: (status: DiscoveryStatus) => void
}) {
  const [status, setStatus] = useState<DiscoveryStatus>({
    step: "generating",
    message: `Asking Claude about ${copy.entityPlural} in ${location}...`,
    found: 0,
    total: 0,
  })
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      try {
        const s = await api.getDiscoveryStatus()
        if (cancelled) return
        setStatus(s)
        if (s.step === "complete" || s.step === "error") {
          setTimeout(() => onCompleteRef.current(s), 800)
        } else {
          setTimeout(poll, 1500)
        }
      } catch {
        if (!cancelled) setTimeout(poll, 2000)
      }
    }

    setTimeout(poll, 600)
    return () => { cancelled = true }
  }, [location])

  const steps = DISCOVERY_STEPS(copy)
  const currentStepIdx = steps.findIndex((s: { key: string }) => s.key === status.step)

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
            <span className="text-sm font-medium text-white">Discovery Agent Running</span>
            {status.data_source && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-medium",
                status.data_source === "tavily"
                  ? "bg-emerald-900/50 text-emerald-400"
                  : "bg-violet-900/50 text-violet-400"
              )}>
                {status.data_source === "tavily" ? "Live" : "Claude"}
              </span>
            )}
            {status.total > 0 && (
              <span className="ml-auto text-xs text-gray-500">
                {status.found}/{status.total} saved
              </span>
            )}
          </div>

          {status.message && (
            <p className="text-xs text-gray-400 mb-4 min-h-[16px] italic">{status.message}</p>
          )}

          <div className="space-y-3">
            {steps.map((step, i) => {
              const isDone = currentStepIdx > i || status.step === "complete"
              const isActive = status.step === step.key
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
                    )}>
                      {step.label}
                    </div>
                    {isActive && status.message ? (
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

      {/* Persistent transcript — every set_progress event since the run started.
          Stays visible after the run completes (handed off via finalStatus). */}
      <DiscoveryTranscript events={status.events ?? []} />
    </div>
  )
}

export default function DiscoverPage() {
  const { vertical } = useVertical()
  const copy = copyFor(vertical)

  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle")
  const [location, setLocation] = useState("")
  const [countryCode, setCountryCode] = useState("US")
  const [maxResults, setMaxResults] = useState(5)
  const [mode, setMode] = useState<"tavily" | "claude">("tavily")
  const [isStarting, setIsStarting] = useState(false)
  const [tavilyAvailable, setTavilyAvailable] = useState<boolean | null>(null)
  const [finalStatus, setFinalStatus] = useState<DiscoveryStatus | null>(null)
  const [submittedLocation, setSubmittedLocation] = useState("")
  // When the previous run skipped everything because Tavily snippets had no
  // person names, surface this as a follow-up option rather than the user
  // staring at "Found 0".
  const [includeLowConfidence, setIncludeLowConfidence] = useState(false)

  // Check Tavily availability on mount
  useEffect(() => {
    api.getDiscoveryStatus().then((s) => {
      const available = s.tavily_available ?? false
      setTavilyAvailable(available)
      setMode(available ? "tavily" : "claude")
    }).catch(() => {})
  }, [])

  const handleStart = async () => {
    if (!location.trim()) return
    setIsStarting(true)
    try {
      await api.startDiscovery(
        location.trim(), countryCode, maxResults, mode, copy.segmentType,
        includeLowConfidence,
      )
      setSubmittedLocation(location.trim())
      setPhase("running")
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("409")) {
        alert("A discovery is already running. Please wait for it to complete.")
      }
    } finally {
      setIsStarting(false)
    }
  }

  const handleComplete = (status: DiscoveryStatus) => {
    setFinalStatus(status)
    setPhase("done")
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/prospects">
          <Button variant="ghost" size="sm" className="text-gray-400 hover:text-gray-200 -ml-2">
            <ChevronLeft className="w-4 h-4" /> Prospects
          </Button>
        </Link>
        <Link href="/prospects/discover/interactive">
          <Button variant="ghost" size="sm" className="text-violet-400 hover:text-violet-300 hover:bg-violet-950/40">
            Try interactive mode →
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-violet-900/40 border border-violet-800/50 flex items-center justify-center">
          <Telescope className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">Discover Prospects</h1>
          <p className="text-sm text-gray-500 mt-0.5">{copy.pageSubtitle}</p>
        </div>
      </div>

      {/* Phase: idle — input form */}
      {phase === "idle" && (
        <div className="space-y-4">
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
            {mode === "tavily" && (
              <p className="text-xs text-emerald-500/70">
                Tavily searches the live web to verify each {copy.entitySingular} — real websites, current contacts.
              </p>
            )}
            {mode === "claude" && (
              <p className="text-xs text-amber-500/80">
                Uses Claude's training knowledge only — real known businesses but not verified in real-time.
              </p>
            )}
            {tavilyAvailable === false && (
              <p className="text-xs text-gray-600">
                <AlertTriangle className="w-3 h-3 inline mr-1" />
                No Tavily API key configured — live search unavailable.
              </p>
            )}
          </div>

          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="p-5 space-y-4">
              <div>
                <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1.5">
                  Location
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleStart()}
                  placeholder={copy.locationPlaceholder}
                  className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
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

                <div>
                  <label className="text-xs text-gray-500 font-medium uppercase tracking-wider block mb-1.5">
                    Max results (3–10)
                  </label>
                  <input
                    type="number"
                    min={3}
                    max={10}
                    value={maxResults}
                    onChange={(e) => setMaxResults(Math.max(3, Math.min(10, Number(e.target.value))))}
                    className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-md text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>
              </div>

              {/* Include low-confidence contacts toggle */}
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
                    Save businesses where the web doesn't reveal a real decision-maker (Claude returns
                    a generic title like &quot;General Manager&quot;). They&apos;ll be flagged for manual research.
                    Helpful in major-brand-heavy locations.
                  </div>
                </div>
              </label>

              <Button
                onClick={handleStart}
                disabled={!location.trim() || isStarting}
                className="w-full bg-violet-700 hover:bg-violet-600 disabled:opacity-40"
              >
                {isStarting ? (
                  <><RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> Starting...</>
                ) : (
                  <><Telescope className="w-3.5 h-3.5 mr-2" /> Start Discovery</>
                )}
              </Button>
            </CardContent>
          </Card>

          {/* How it works */}
          <Card className="bg-gray-900/50 border-gray-800">
            <CardContent className="p-4">
              <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-3">How it works</div>
              <div className="space-y-2.5">
                {[
                  { icon: Brain, color: "text-violet-400", text: `Claude identifies real ${copy.entityPlural} from its training knowledge` },
                  { icon: Globe, color: "text-sky-400", text: `Tavily searches for each ${copy.entitySingular}'s live website and contact details` },
                  { icon: FileText, color: "text-emerald-400", text: "Claude extracts the decision-maker contact and operational data" },
                  { icon: Users, color: "text-gray-400", text: "New prospects appear in your prospects table, ready for scoring and campaigns" },
                ].map(({ icon: Icon, color, text }, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${color}`} />
                    <span className="text-xs text-gray-500">{text}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Phase: running — live progress */}
      {phase === "running" && (
        <DiscoveryProgress location={submittedLocation} copy={copy} onComplete={handleComplete} />
      )}

      {/* Phase: done — summary */}
      {phase === "done" && finalStatus && (
        <div className="space-y-4 max-w-lg">
          {/* Persistent transcript — survives into the done view so the user
              can scroll through what happened even after the run ends. */}
          <DiscoveryTranscript
            events={finalStatus.events ?? []}
            autoScroll={false}
          />
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
                    Found {finalStatus.found} {finalStatus.found === 1 ? copy.entitySingular : copy.entityPlural}
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    in {submittedLocation}
                    {finalStatus.data_source === "claude_knowledge" && (
                      <span className="ml-2 text-amber-500/80 text-xs">(from Claude knowledge)</span>
                    )}
                    {finalStatus.data_source === "tavily" && (
                      <span className="ml-2 text-emerald-500/70 text-xs">· verified with live web search</span>
                    )}
                  </p>
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
                        if (parts.length === 0) {
                          parts.push(`${finalStatus.total - finalStatus.found} skipped`)
                        }
                        return parts.join(" · ")
                      })()}
                    </p>
                  )}
                </div>
                <div className="flex gap-3 justify-center pt-2">
                  <Link href={`/prospects?country=${encodeURIComponent(countryCode)}`}>
                    <Button className="bg-sky-700 hover:bg-sky-600">
                      <Users className="w-3.5 h-3.5 mr-2" />
                      View All Prospects
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    className="border-gray-700 text-gray-400 hover:text-white"
                    onClick={() => { setPhase("idle"); setFinalStatus(null) }}
                  >
                    Discover More
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Zero results advisory — diagnoses the actual reason and offers a path forward. */}
          {finalStatus.found === 0 && finalStatus.step !== "error" && (() => {
            const noContact = finalStatus.skipped_no_contact ?? 0
            const excluded = finalStatus.skipped_excluded ?? 0
            const dup = finalStatus.skipped_duplicate ?? 0
            // Branch by the dominant reason so the user gets actionable advice, not a guess.
            const allFromNoContact = noContact > 0 && excluded === 0 && dup === 0
            return (
              <Card className="bg-gray-900 border-gray-800">
                <CardContent className="p-4 flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-sm text-gray-400 space-y-2">
                    {allFromNoContact ? (
                      <>
                        <p>
                          All {noContact} candidates were dropped because Claude couldn&apos;t extract
                          a real decision-maker from the web — usually because the location is dominated
                          by major-brand chains where snippets list a phone number but no person.
                        </p>
                        <p>
                          Re-run with the <span className="text-amber-300">Include low-confidence contacts</span>{" "}
                          checkbox above. Prospects will be saved with a &quot;needs research&quot; flag — you can
                          then run the Researcher agent on each to fill in a real contact, or skip them when
                          building campaigns.
                        </p>
                      </>
                    ) : excluded > 0 && noContact === 0 && dup === 0 ? (
                      <p>
                        All {excluded} candidates Claude found are already on your vendor exclusion list
                        (existing customers). Try a different location, or remove names from the vendor
                        pack&apos;s exclusion list if you want to reach out anyway.
                      </p>
                    ) : dup > 0 && noContact === 0 && excluded === 0 ? (
                      <p>
                        All {dup} candidates Claude found are already in your prospects database. Try a
                        different location or a more specific neighbourhood to surface new ones.
                      </p>
                    ) : (
                      <>
                        <p>
                          No new prospects were added. Reasons:
                          {noContact > 0 && <> {noContact} dropped because no real contact name was found · </>}
                          {excluded > 0 && <> {excluded} are existing customers · </>}
                          {dup > 0 && <> {dup} already in your database</>}
                          .
                        </p>
                        <p>
                          Try a broader location, or enable <span className="text-amber-300">Include
                          low-confidence contacts</span> above to save the no-contact ones for manual research.
                        </p>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })()}
        </div>
      )}
    </div>
  )
}
