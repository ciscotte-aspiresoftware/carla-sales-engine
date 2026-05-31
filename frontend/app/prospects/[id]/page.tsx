"use client"

import { useEffect, useState, useRef } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { api } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import type { Prospect, ProspectContact, ProvenanceSource, WebsiteResearch } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger, DialogClose,
} from "@/components/ui/dialog"
import {
  ChevronLeft, Car, MapPin, Mail, Building2, Wifi, WifiOff,
  Zap, Brain, RefreshCw, Target, Search, FileText, Save, CheckCircle2,
  ExternalLink, ShieldCheck, ShieldAlert, ShieldQuestion,
  Phone, Plus, Trash2, Star, X, Globe, Quote, AlertCircle, Pencil, Check,
} from "lucide-react"
import { ActivityFeed } from "@/components/activity/ActivityFeed"
import { cn } from "@/lib/utils"

const SERVICE_LABELS: Record<string, string> = {
  fuel: "Fuel", repairs: "Repairs", dry_storage: "Dry Storage", boat_sales: "Boat Sales",
}

const RESEARCH_STEPS = [
  { key: "loading",    label: "Loading prospect data",      icon: Search,       desc: "Reading prospect profile and CRM data" },
  { key: "analysing",  label: "Analysing operation",        icon: Target,       desc: "Evaluating fleet size, tech maturity, services" },
  { key: "generating", label: "Generating profile",         icon: Brain,        desc: "Synthesising hook, pain hypothesis, credible detail" },
  { key: "saving",     label: "Saving to profile",          icon: FileText,     desc: "Writing insights to prospect record" },
  { key: "complete",   label: "Research complete",          icon: CheckCircle2, desc: "" },
]

const SCRAPE_STEPS = [
  { key: "queued",     label: "Queued",                     icon: Search,       desc: "Waiting to start" },
  { key: "verifying",  label: "Verifying URL",              icon: ShieldCheck,  desc: "Confirming the site belongs to this prospect" },
  { key: "fetching",   label: "Fetching pages",             icon: Globe,        desc: "Respecting robots.txt + rate limits" },
  { key: "extracting", label: "Extracting facts",           icon: Brain,        desc: "Claude reads the markdown and structures findings" },
  { key: "saving",     label: "Saving research",            icon: FileText,     desc: "Writing payload + promoting provenance" },
  { key: "complete",   label: "Scrape complete",            icon: CheckCircle2, desc: "" },
]

const PREFERRED_KEYWORD_OPTIONS = [
  { value: "about",    label: "About" },
  { value: "services", label: "Services" },
  { value: "pricing",  label: "Pricing" },
  { value: "products", label: "Products" },
  { value: "contact",  label: "Contact" },
  { value: "features", label: "Features" },
]

/** Tiny chip showing the source recorded by discovery for a single field.
 * Tooltip explains what the source means in plain English. */
function ProvenanceBadge({ source }: { source: ProvenanceSource | undefined }) {
  if (!source || source === "unknown") {
    return (
      <span title="No source recorded — value may be a Claude estimate or seed data" className="inline-flex">
        <ShieldQuestion className="w-3 h-3 text-gray-600" />
      </span>
    )
  }
  if (source === "snippet" || source === "user" || source === "scrape") {
    const label =
      source === "snippet" ? "Verified via Tavily web snippets" :
      source === "user"    ? "User-edited (verified)" :
                             "Confirmed from the prospect's own website"
    return (
      <span title={label} className="inline-flex">
        <ShieldCheck className="w-3 h-3 text-emerald-400" />
      </span>
    )
  }
  if (source === "needs_review") {
    return (
      <span title="The system found this value but couldn't auto-confirm it. Please review." className="inline-flex">
        <ShieldAlert className="w-3 h-3 text-yellow-400" />
      </span>
    )
  }
  // training
  return (
    <span title="Claude training-knowledge estimate — unverified" className="inline-flex">
      <ShieldAlert className="w-3 h-3 text-amber-400" />
    </span>
  )
}

/** Best-effort website href that handles bare domains and full URLs. */
function websiteHref(raw: string | null): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

function TechBar({ score }: { score: number | null }) {
  if (!score) return null
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className={`w-5 h-1.5 rounded-full ${n <= score ? "bg-sky-500" : "bg-gray-700"}`} />
        ))}
      </div>
      <span className="text-xs text-gray-500">{score}/5</span>
    </div>
  )
}

/** Additional personas for a prospect — owner, GM, dockmaster, etc. The
 * primary contact still lives on the prospect's top-level fields; this
 * section is for the extras voice/SMS/LinkedIn channels would target. */
/** Inline edit affordance for the prospect's website URL. PATCH-es via
 * `api.updateProspect({ website_url })` — the backend service flips
 * `provenance.website_url` to "user" automatically so future scrapes
 * respect the manual edit. After save, the parent reloads the prospect
 * so the new URL renders + the verified/needs-review banners refresh.
 *
 * Accepts blank input as a way to clear the URL (sometimes useful when
 * a user knows the saved URL is wrong but can't find a replacement).
 */
function WebsiteUrlField({
  prospectId,
  currentUrl,
  onSaved,
  // When set, the field renders open by default (used by the "Add
  // website URL" CTA on the no-URL banner).
  autoOpen = false,
}: {
  prospectId: number
  currentUrl: string | null
  onSaved: () => void
  autoOpen?: boolean
}) {
  const [editing, setEditing] = useState(autoOpen)
  const [value, setValue] = useState(currentUrl ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing) {
      // Reset to the latest stored value whenever we enter edit mode and
      // give focus to the input.
      setValue(currentUrl ?? "")
      setError(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [editing, currentUrl])

  const cancel = () => {
    setEditing(false)
    setError(null)
  }

  const save = async () => {
    setError(null)
    const trimmed = value.trim()
    // Accept either bare domains or full URLs; normalise to https on
    // submit so the backend verifier doesn't reject "acme.com" outright.
    const normalised =
      trimmed === "" ? null :
      /^https?:\/\//i.test(trimmed) ? trimmed :
      `https://${trimmed}`
    setSaving(true)
    try {
      await api.updateProspect(prospectId, { website_url: normalised })
      setEditing(false)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
            if (e.key === "Escape") cancel()
          }}
          placeholder="https://example.com"
          disabled={saving}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white w-[200px] focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        <button
          onClick={save}
          disabled={saving}
          title="Save (Enter)"
          className="text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          title="Cancel (Esc)"
          className="text-gray-500 hover:text-gray-300 disabled:opacity-40"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        {error && <span className="text-[10px] text-red-400 ml-1" title={error}>!</span>}
      </span>
    )
  }

  const href = websiteHref(currentUrl)
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:text-sky-300 text-xs inline-flex items-center gap-1 truncate max-w-[180px]"
          title={currentUrl ?? ""}
        >
          <span className="truncate">{currentUrl}</span>
          <ExternalLink className="w-3 h-3 shrink-0" />
        </a>
      ) : (
        <span className="text-gray-600 text-xs">—</span>
      )}
      <button
        onClick={() => setEditing(true)}
        title={currentUrl ? "Edit website URL" : "Add a website URL"}
        className="text-gray-500 hover:text-sky-400"
      >
        <Pencil className="w-3 h-3" />
      </button>
    </span>
  )
}

function ContactsSection({
  prospectId,
  contacts,
  onChange,
}: {
  prospectId: number
  contacts: ProspectContact[]
  onChange: (next: ProspectContact[]) => void
}) {
  const [draft, setDraft] = useState<Partial<ProspectContact> | null>(null)
  const [saving, setSaving] = useState(false)

  const addRow = () => setDraft({ full_name: "", role: "", email: "", phone: "", linkedin_url: "", is_primary: false, contact_priority: 0 })

  const saveDraft = async () => {
    if (!draft?.full_name?.trim()) return
    setSaving(true)
    try {
      const created = await api.createProspectContact(prospectId, draft)
      onChange([...contacts, created])
      setDraft(null)
    } finally { setSaving(false) }
  }

  const remove = async (contactId: number) => {
    setSaving(true)
    try {
      await api.deleteProspectContact(prospectId, contactId)
      onChange(contacts.filter((c) => c.id !== contactId))
    } finally { setSaving(false) }
  }

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-gray-500 font-medium uppercase tracking-wider flex items-center justify-between">
          <span>Additional Contacts</span>
          {!draft && (
            <Button
              size="sm" variant="ghost"
              onClick={addRow}
              className="h-6 px-2 text-[11px] text-gray-400 hover:text-violet-300"
            >
              <Plus className="w-3 h-3 mr-1" /> Add contact
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {contacts.length === 0 && !draft && (
          <p className="text-xs text-gray-600">
            No additional personas. Voice / SMS / LinkedIn channels will fall back to the primary contact above.
          </p>
        )}
        {contacts.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2 rounded border border-gray-800 bg-gray-950/40">
            <div className="w-7 h-7 rounded-full bg-gray-800 flex items-center justify-center text-[11px] text-gray-400 shrink-0">
              {c.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-200 truncate">{c.full_name}</span>
                {c.role && <Badge className="bg-gray-800 text-gray-400 border-gray-700 text-[10px] capitalize">{c.role}</Badge>}
                {c.is_primary && <Star className="w-3 h-3 text-amber-400" />}
              </div>
              <div className="flex flex-wrap gap-3 text-[11px] text-gray-500 mt-0.5">
                {c.email && (<span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span>)}
                {c.phone && (<span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>)}
                {c.linkedin_url && (
                  <a href={c.linkedin_url} target="_blank" rel="noreferrer"
                     className="inline-flex items-center gap-1 hover:text-sky-300">
                    <ExternalLink className="w-3 h-3" />LinkedIn
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => remove(c.id)}
              disabled={saving}
              className="text-gray-600 hover:text-red-400 disabled:opacity-40"
              title="Remove contact"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {draft && (
          <div className="space-y-2 px-3 py-2 rounded border border-violet-700/60 bg-violet-950/10">
            <div className="grid grid-cols-2 gap-2">
              <input
                autoFocus placeholder="Full name (required)"
                value={draft.full_name || ""}
                onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
                className="px-2 py-1 text-sm bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-violet-600"
              />
              <input
                placeholder="Role (e.g. owner, gm)"
                value={draft.role || ""}
                onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                className="px-2 py-1 text-sm bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-violet-600"
              />
              <input
                placeholder="Email"
                value={draft.email || ""}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                className="px-2 py-1 text-sm bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-violet-600"
              />
              <input
                placeholder="Phone"
                value={draft.phone || ""}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                className="px-2 py-1 text-sm bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-violet-600"
              />
              <input
                placeholder="LinkedIn URL"
                value={draft.linkedin_url || ""}
                onChange={(e) => setDraft({ ...draft, linkedin_url: e.target.value })}
                className="col-span-2 px-2 py-1 text-sm bg-gray-900 border border-gray-700 rounded text-gray-200 focus:outline-none focus:border-violet-600"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={saveDraft}
                disabled={saving || !draft.full_name?.trim()}
                className="h-7 bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-xs"
              >
                <Save className="w-3 h-3 mr-1" />
                {saving ? "Saving…" : "Save contact"}
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={() => setDraft(null)}
                className="h-7 text-gray-500 hover:text-gray-300 text-xs"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function WebsiteScrapeProgress({ prospectId, onComplete }: { prospectId: number; onComplete: () => void }) {
  const [status, setStatus] = useState({ step: "queued", message: "" })
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const [done, setDone] = useState(false)

  usePoll(async () => {
    const s = await api.getWebsiteScrapeStatus(prospectId)
    setStatus(s)
    if (s.step === "complete") {
      // Defer the parent reload by ~800ms so the user sees the green
      // checkmark land before we redraw the page.
      setTimeout(() => onCompleteRef.current(), 800)
      setDone(true)
      return "stop"
    }
  }, { interval: 1500, enabled: !done, initialDelay: 600 })

  const currentStepIdx = SCRAPE_STEPS.findIndex((s) => s.key === status.step)

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-sky-400" />
          <span className="text-sm font-medium text-white">Website Enrichment Agent Running</span>
        </div>
        <div className="space-y-3">
          {SCRAPE_STEPS.map((step, i) => {
            const isDone = currentStepIdx > i || status.step === "complete"
            const isActive = status.step === step.key
            const Icon = step.icon
            return (
              <div key={step.key} className="flex items-start gap-3">
                <div className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all",
                  isDone  ? "bg-emerald-900/60 border border-emerald-700" :
                  isActive ? "bg-sky-900/60 border border-sky-600 animate-pulse" :
                             "bg-gray-800 border border-gray-700"
                )}>
                  <Icon className={cn(
                    "w-3.5 h-3.5",
                    isDone  ? "text-emerald-400" :
                    isActive ? "text-sky-400" :
                               "text-gray-600"
                  )} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    "text-sm font-medium",
                    isDone  ? "text-emerald-400" :
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
  )
}

function ScrapeOptionsDialog({
  websiteUrl,
  onStart,
  triggerLabel = "Scrape Website",
  triggerVariant = "default",
}: {
  websiteUrl: string | null
  onStart: (options: { max_pages: number; preferred_keywords: string[] }) => void
  triggerLabel?: string
  triggerVariant?: "default" | "outline"
}) {
  const [open, setOpen] = useState(false)
  const [maxPages, setMaxPages] = useState(2)
  const [keywords, setKeywords] = useState<string[]>(["about", "services"])
  const disabled = !websiteUrl

  const toggleKw = (k: string) => {
    setKeywords((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k])
  }

  const submit = () => {
    onStart({
      max_pages: Math.max(1, Math.min(5, Number(maxPages) || 2)),
      preferred_keywords: keywords,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant}
            disabled={disabled}
            className={triggerVariant === "outline"
              ? "border-gray-700 text-gray-300 hover:text-white text-xs"
              : "bg-sky-700 hover:bg-sky-600 text-xs"}
            title={disabled ? "Prospect has no website_url" : undefined}
          />
        }
      >
        <Globe className="w-3.5 h-3.5 mr-1.5" />
        {triggerLabel}
      </DialogTrigger>
      <DialogContent className="bg-gray-900 border-gray-800 text-gray-100 max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">Scrape Website</DialogTitle>
          <DialogDescription className="text-gray-400 text-xs">
            {websiteUrl ? <>Target: <span className="text-sky-400">{websiteUrl}</span></> : "No website URL on this prospect."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-500 block mb-1.5">Pages to scrape (1–5)</label>
            <input
              type="number"
              min={1}
              max={5}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
              className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            />
            <p className="text-[10px] text-gray-600 mt-1">Homepage is always included. The rest are picked by section keywords below.</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1.5">Inner page priorities</label>
            <div className="flex flex-wrap gap-1.5">
              {PREFERRED_KEYWORD_OPTIONS.map((opt) => {
                const on = keywords.includes(opt.value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleKw(opt.value)}
                    className={cn(
                      "px-2.5 py-1 rounded text-xs border transition-colors",
                      on ? "bg-sky-900/40 border-sky-700 text-sky-300"
                         : "bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200",
                    )}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <p className="text-[10px] text-gray-600 mt-1.5">Keywords matched against link path + anchor text on the homepage. Order = priority.</p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" onClick={submit} disabled={disabled} className="bg-sky-700 hover:bg-sky-600">
            Start scrape
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiscoveredEmailsCard({
  emails,
  recommended,
  rationale,
  currentEmail,
  onAdopt,
}: {
  emails: WebsiteResearch["discovered_emails"]
  recommended: string | null
  rationale: string | null
  currentEmail: string | null
  onAdopt: (email: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cur = (currentEmail ?? "").trim().toLowerCase()

  if (!emails || emails.length === 0) {
    return (
      <Card className="bg-gray-900 border-gray-800">
        <CardContent className="p-4">
          <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1.5">Email addresses found</div>
          <div className="text-xs text-gray-600">No email addresses were exposed on the scraped pages. Try increasing pages-to-scrape or include the contact page in the keyword priorities.</div>
        </CardContent>
      </Card>
    )
  }

  const adopt = async (email: string) => {
    setError(null)
    setBusy(email)
    try {
      await onAdopt(email)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">Email addresses found on the site</div>
          <span className="text-[10px] text-gray-600">{emails.length} candidate{emails.length === 1 ? "" : "s"}</span>
        </div>
        {recommended && rationale && (
          <div className="mb-3 rounded-md border border-sky-800/60 bg-sky-950/30 px-3 py-2 text-xs text-sky-300">
            <span className="text-sky-400 font-medium">Recommended:</span> {recommended} — {rationale}
          </div>
        )}
        {error && (
          <div className="mb-3 rounded-md border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
        <ul className="divide-y divide-gray-800/80">
          {emails.map((e) => {
            const isCurrent = cur && e.email.toLowerCase() === cur
            const isRecommended = recommended && e.email.toLowerCase() === recommended.toLowerCase()
            const isBusy = busy === e.email
            return (
              <li key={e.email} className="py-2.5 flex items-start gap-3">
                <Mail className="w-3.5 h-3.5 mt-0.5 shrink-0 text-gray-500" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a href={`mailto:${e.email}`} className="text-sm text-sky-300 hover:text-sky-200 break-all">{e.email}</a>
                    {isCurrent && (
                      <Badge className="bg-emerald-900/30 text-emerald-300 border-emerald-800 text-[10px]">primary</Badge>
                    )}
                    {isRecommended && !isCurrent && (
                      <Badge className="bg-sky-900/30 text-sky-300 border-sky-800 text-[10px]">recommended</Badge>
                    )}
                    {e.deliverable === true && (
                      <Badge title={e.deliverability_detail ?? "MX/A record present — domain accepts mail"} className="bg-emerald-900/30 text-emerald-300 border-emerald-800 text-[10px]">deliverable</Badge>
                    )}
                    {e.deliverable === false && (
                      <Badge title={e.deliverability_detail ?? e.deliverability_status ?? "Domain has no MX or A record"} className="bg-red-900/30 text-red-300 border-red-800 text-[10px]">
                        {e.deliverability_status === "unknown_domain" ? "domain not found" :
                         e.deliverability_status === "no_mx" ? "no mail server" :
                         e.deliverability_status === "dns_error" ? "dns error" :
                         e.deliverability_status === "bad_format" ? "bad format" :
                         "undeliverable"}
                      </Badge>
                    )}
                    <Badge className="bg-gray-800 text-gray-400 border-gray-700 text-[10px]">{e.kind}</Badge>
                  </div>
                  <div className="text-[10px] text-gray-600 mt-0.5 truncate" title={e.context}>{e.context}</div>
                  <a href={e.source_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-gray-600 hover:text-gray-400 inline-flex items-center gap-1 mt-0.5 truncate">
                    {e.source_url} <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                  </a>
                </div>
                <Button
                  size="sm"
                  variant={isRecommended ? "default" : "outline"}
                  disabled={isCurrent || isBusy}
                  onClick={() => adopt(e.email)}
                  title={e.deliverable === false ? `Domain failed deliverability check (${e.deliverability_status ?? "unknown"}). Mail to this address will likely bounce.` : undefined}
                  className={cn(
                    "text-xs shrink-0",
                    isCurrent
                      ? "bg-gray-800 text-gray-500"
                      : e.deliverable === false
                        ? "border-red-900 text-red-300 hover:text-red-200 hover:bg-red-950/40"
                        : isRecommended
                          ? "bg-sky-700 hover:bg-sky-600"
                          : "border-gray-700 text-gray-300 hover:text-white",
                  )}
                >
                  {isCurrent ? "In use" : isBusy ? "Saving…" : e.deliverable === false ? "Use anyway" : "Use as primary"}
                </Button>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Renders a tiny "/about" or "/" link pointing at the page a fact was
 * extracted from. Tooltip carries the full URL so the user can hover for
 * the absolute path. Returns null when no source is known (older scrapes
 * pre-evidence tracking, or items the agent couldn't attribute). */
function EvidenceLink({ url }: { url: string | null | undefined }) {
  if (!url) return null
  let label = url
  try {
    const u = new URL(url)
    label = (u.pathname || "/") + (u.search || "")
    // Collapse trailing slash for non-root paths so "/about/" reads as
    // "/about" — fewer pixels, same information.
    if (label.length > 1 && label.endsWith("/")) label = label.slice(0, -1)
  } catch {
    // Non-URL string — show as-is.
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Extracted from ${url}`}
      className="text-[10px] text-gray-500 hover:text-sky-400 inline-flex items-center gap-0.5 align-middle"
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="w-2.5 h-2.5" />
      <span className="max-w-[100px] truncate">{label}</span>
    </a>
  )
}

function WebsiteResearchPanel({
  wr,
  currentEmail,
  onAdoptEmail,
}: {
  wr: WebsiteResearch
  currentEmail: string | null
  onAdoptEmail: (email: string) => Promise<void>
}) {
  const evidence = wr.evidence
  if (!wr.verified) {
    const reasonLabel: Record<string, string> = {
      name_mismatch: "Couldn't confirm this site belongs to this prospect",
      parked_domain: "Domain looks parked or for sale",
      empty_page:    "Homepage was effectively empty",
      http_error:    "Couldn't reach the homepage",
      empty_url:     "Prospect has no website URL",
      provider_unavailable: "No scrape provider is configured",
    }
    const label = reasonLabel[wr.reason ?? ""] ?? `Unverified: ${wr.reason ?? "unknown"}`
    return (
      <Card className="bg-amber-950/20 border-amber-900/40">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
          <div>
            <div className="text-xs text-amber-400 font-medium uppercase tracking-wider mb-1">Website not verified</div>
            <div className="text-sm text-gray-200">{label}</div>
            {wr.message && <div className="text-xs text-gray-500 mt-1">{wr.message}</div>}
            <div className="text-xs text-gray-600 mt-2">Edit the prospect's website URL on the Overview tab, then re-run the scrape.</div>
          </div>
        </CardContent>
      </Card>
    )
  }

  const isLiteVerification = wr.meta.kind === "verification"

  return (
    <div className="space-y-3">
      {isLiteVerification && (
        <Card className="bg-emerald-950/20 border-emerald-900/40">
          <CardContent className="p-3 flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-emerald-400">URL verified</div>
              <div className="text-xs text-emerald-300 mt-0.5">
                {wr.meta.canonical_url ?? wr.meta.pages_fetched[0]} resolved and matched this prospect&apos;s name. No full scrape yet — run one for services, pain signals, and email candidates.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {wr.scrape_blocked === "robots_txt" && (
        <Card className="bg-amber-950/20 border-amber-900/40">
          <CardContent className="p-3 flex items-start gap-3">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-400" />
            <div className="text-xs text-amber-300">
              The site&apos;s robots.txt disallowed crawling beyond the homepage — only the homepage was used.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      {wr.summary && (
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-4">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1.5">Summary</div>
            <div className="text-sm text-gray-200 leading-relaxed">{wr.summary}</div>
          </CardContent>
        </Card>
      )}

      {/* Services + booking + tech */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-3 space-y-2">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">Services on site</div>
            <div className="flex flex-wrap gap-1.5 items-center">
              {wr.services_list.length > 0 ? wr.services_list.map((s) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <Badge className="bg-sky-900/30 text-sky-300 border-sky-800 text-xs">{s}</Badge>
                  <EvidenceLink url={evidence?.services_list?.[s]} />
                </span>
              )) : <span className="text-gray-600 text-xs">None recorded</span>}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-3 space-y-2">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider">Online booking</div>
            {wr.has_online_booking === true && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-emerald-400 inline-flex items-center gap-1"><Wifi className="w-3 h-3" />Yes</span>
                {wr.online_booking_url && (
                  <a href={wr.online_booking_url} target="_blank" rel="noopener noreferrer" className="text-xs text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 truncate max-w-[180px]">
                    open <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                )}
                <EvidenceLink url={evidence?.has_online_booking} />
              </div>
            )}
            {wr.has_online_booking === false && (
              <div className="inline-flex items-center gap-2 flex-wrap">
                <span className="text-xs text-red-400 inline-flex items-center gap-1"><WifiOff className="w-3 h-3" />No</span>
                <EvidenceLink url={evidence?.has_online_booking} />
              </div>
            )}
            {wr.has_online_booking === null && (
              <div className="text-xs text-gray-600">Not stated on site</div>
            )}
            {wr.tech_stack_signals.length > 0 && (
              <div className="pt-2 border-t border-gray-800/80">
                <div className="text-[10px] text-gray-600 mb-1">Tech-stack signals</div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  {wr.tech_stack_signals.map((t) => (
                    <span key={t} className="inline-flex items-center gap-1">
                      <Badge className="bg-gray-800 text-gray-300 border-gray-700 text-[10px]">{t}</Badge>
                      <EvidenceLink url={evidence?.tech_stack_signals?.[t]} />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Competitors */}
      {wr.competitors_mentioned.length > 0 && (
        <Card className="bg-amber-950/15 border-amber-900/40">
          <CardContent className="p-4">
            <div className="text-xs text-amber-400 font-medium uppercase tracking-wider mb-1.5">Competitors mentioned</div>
            <div className="text-[10px] text-gray-500 mb-2">Names from pack-defined competitor list found verbatim on the site.</div>
            <div className="flex flex-wrap gap-1.5 items-center">
              {wr.competitors_mentioned.map((c) => (
                <span key={c} className="inline-flex items-center gap-1">
                  <Badge className="bg-amber-900/40 text-amber-300 border-amber-800/60 text-xs">{c}</Badge>
                  <EvidenceLink url={evidence?.competitors_mentioned?.[c]} />
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pain signals */}
      {wr.pain_signals.length > 0 && (
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-4">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-1.5">Pain signals on site</div>
            <ul className="space-y-1 text-sm text-gray-300">
              {wr.pain_signals.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-violet-400 mt-1.5 shrink-0">•</span>
                  <span className="flex-1 inline-flex items-baseline gap-2 flex-wrap">
                    <span>{p}</span>
                    <EvidenceLink url={evidence?.pain_signals?.[p]} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Key quotes */}
      {wr.key_quotes.length > 0 && (
        <Card className="bg-gray-900 border-gray-800">
          <CardContent className="p-4">
            <div className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-2">Verbatim quotes</div>
            <div className="space-y-2">
              {wr.key_quotes.map((q, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <Quote className="w-3 h-3 mt-1 shrink-0 text-sky-500" />
                  <div className="min-w-0">
                    <div className="text-gray-200 italic">&ldquo;{q.quote}&rdquo;</div>
                    <a href={q.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 truncate">
                      {q.source_url} <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Discovered emails */}
      <DiscoveredEmailsCard
        emails={wr.discovered_emails}
        recommended={wr.recommended_email}
        rationale={wr.recommended_email_rationale}
        currentEmail={currentEmail}
        onAdopt={onAdoptEmail}
      />

      {/* Meta */}
      <Card className="bg-gray-900/40 border-gray-800/60">
        <CardContent className="p-3 text-[10px] text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
          <span>Provider: <span className="text-gray-300">{wr.meta.provider ?? "unknown"}</span></span>
          <span>Pages: <span className="text-gray-300">{wr.meta.pages_fetched.length}</span></span>
          {wr.meta.robots_allowed === false && <span className="text-amber-400">robots.txt blocked inner pages</span>}
          <span>Fetched: <span className="text-gray-300">{wr.meta.fetched_at}</span></span>
        </CardContent>
      </Card>
    </div>
  )
}

function ResearchProgress({ prospectId, onComplete }: { prospectId: number; onComplete: () => void }) {
  const [status, setStatus] = useState({ step: "loading", message: "" })
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const [done, setDone] = useState(false)

  usePoll(async () => {
    const s = await api.getResearchStatus(prospectId)
    setStatus(s)
    if (s.step === "complete") {
      setTimeout(() => onCompleteRef.current(), 800)
      setDone(true)
      return "stop"
    }
  }, { interval: 1500, enabled: !done, initialDelay: 600 })

  const currentStepIdx = RESEARCH_STEPS.findIndex((s) => s.key === status.step)

  return (
    <Card className="bg-gray-900 border-gray-800">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-violet-400" />
          <span className="text-sm font-medium text-white">Research Agent Running</span>
        </div>

        <div className="space-y-3">
          {RESEARCH_STEPS.map((step, i) => {
            const isDone = currentStepIdx > i || status.step === "complete"
            const isActive = status.step === step.key
            const Icon = step.icon
            return (
              <div key={step.key} className="flex items-start gap-3">
                <div className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 transition-all",
                  isDone  ? "bg-emerald-900/60 border border-emerald-700" :
                  isActive ? "bg-violet-900/60 border border-violet-600 animate-pulse" :
                             "bg-gray-800 border border-gray-700"
                )}>
                  <Icon className={cn(
                    "w-3.5 h-3.5",
                    isDone  ? "text-emerald-400" :
                    isActive ? "text-violet-400" :
                               "text-gray-600"
                  )} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    "text-sm font-medium",
                    isDone  ? "text-emerald-400" :
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
  )
}

export default function ProspectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [prospect, setProspect] = useState<Prospect | null>(null)
  const [loading, setLoading] = useState(true)
  const [researching, setResearching] = useState(false)
  const [scraping, setScraping] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")

  const loadProspect = () =>
    api.getProspect(Number(id)).then(setProspect).finally(() => setLoading(false))

  useEffect(() => { loadProspect() }, [id])

  const runResearch = async () => {
    setResearching(true)
    await api.runResearch(Number(id))
    // UI polls status independently; onComplete will reload the prospect
  }

  const handleResearchComplete = async () => {
    const updated = await api.getProspect(Number(id))
    setProspect(updated)
    setResearching(false)
  }

  const runWebsiteScrape = async (options: { max_pages: number; preferred_keywords: string[] }) => {
    setScraping(true)
    setActiveTab("website")
    await api.runWebsiteScrape(Number(id), options)
    // UI polls status independently; onScrapeComplete will reload the prospect
  }

  const handleScrapeComplete = async () => {
    const updated = await api.getProspect(Number(id))
    setProspect(updated)
    setScraping(false)
  }

  const adoptDiscoveredEmail = async (email: string) => {
    const updated = await api.adoptDiscoveredEmail(Number(id), email)
    setProspect(updated)
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48 bg-gray-800" />
        <Skeleton className="h-40 bg-gray-800 rounded-lg" />
      </div>
    )
  }

  if (!prospect) return <div className="p-6 text-gray-500">Prospect not found.</div>

  const icpPct = prospect.icp_score ? Math.round(prospect.icp_score * 100) : null

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/prospects">
          <Button variant="ghost" size="sm" className="text-gray-400 hover:text-gray-200 -ml-2">
            <ChevronLeft className="w-4 h-4" /> Prospects
          </Button>
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-violet-900/40 border border-violet-800/50 flex items-center justify-center">
            <Car className="w-6 h-6 text-violet-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">{prospect.business_name}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" />{prospect.city}, {prospect.country_code}
              </span>
              <span className="flex items-center gap-1">
                <Mail className="w-3.5 h-3.5" />{prospect.email}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {(() => {
            const hasFullScrape = prospect.website_research?.meta?.kind === "scrape"
            return (
              <ScrapeOptionsDialog
                websiteUrl={prospect.website_url}
                onStart={runWebsiteScrape}
                triggerLabel={hasFullScrape ? "Re-scrape" : "Scrape Website"}
                triggerVariant={hasFullScrape ? "outline" : "default"}
              />
            )
          })()}
          {icpPct !== null && (
            <div className="text-right">
              <div className={`text-2xl font-bold ${icpPct >= 75 ? "text-emerald-400" : icpPct >= 55 ? "text-sky-400" : "text-yellow-400"}`}>
                {icpPct}%
              </div>
              <div className="text-xs text-gray-500">ICP Score</div>
            </div>
          )}
        </div>
      </div>

      {prospect.provenance?.website_url === "needs_review" && (
        <Card className="bg-yellow-950/30 border-yellow-800/60">
          <CardContent className="p-3 flex items-start gap-3">
            <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-yellow-400" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-yellow-400">Website needs human review</div>
              <div className="text-xs text-yellow-300 mt-0.5">
                The system reached <span className="font-mono">{prospect.website_url}</span> but couldn&apos;t confirm it belongs to this prospect ({prospect.website_research?.reason ?? "unknown reason"}). Please check the URL is correct, then re-verify or run a full scrape.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {!prospect.website_url && (
        <Card className="bg-gray-900/40 border-gray-800/60">
          <CardContent className="p-3 flex items-start gap-3">
            <ShieldQuestion className="w-4 h-4 mt-0.5 shrink-0 text-gray-500" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-300">No website URL on file</div>
              <div className="text-xs text-gray-500 mt-0.5 mb-2">
                Either discovery couldn&apos;t find a URL, or a previous verification flagged it as broken and removed it. Add one manually to enable scraping and research.
              </div>
              <WebsiteUrlField
                prospectId={prospect.id}
                currentUrl={prospect.website_url}
                onSaved={loadProspect}
                autoOpen
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-gray-900 border border-gray-800">
          <TabsTrigger value="overview"  className="text-xs data-[state=active]:bg-gray-800">Overview</TabsTrigger>
          <TabsTrigger value="research"  className="text-xs data-[state=active]:bg-gray-800">
            Research Profile
            {prospect.research_profile && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-violet-400 inline-block" />
            )}
          </TabsTrigger>
          <TabsTrigger value="website"   className="text-xs data-[state=active]:bg-gray-800">
            Website Research
            {prospect.website_research && (
              <span className={cn(
                "ml-1.5 w-1.5 h-1.5 rounded-full inline-block",
                prospect.website_research.verified ? "bg-sky-400" : "bg-amber-400",
              )} />
            )}
          </TabsTrigger>
          <TabsTrigger value="activity"  className="text-xs data-[state=active]:bg-gray-800">Activity Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card className="bg-gray-900 border-gray-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-gray-500 font-medium uppercase tracking-wider flex items-center justify-between">
                  <span>Operation</span>
                  {/* Legend in the card header — small enough not to dominate. */}
                  <span className="flex items-center gap-2 text-[9px] normal-case font-normal text-gray-600">
                    <span className="inline-flex items-center gap-1"><ShieldCheck className="w-2.5 h-2.5 text-emerald-400" />verified</span>
                    <span className="inline-flex items-center gap-1"><ShieldAlert className="w-2.5 h-2.5 text-amber-400" />estimate</span>
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-500">Fleet size</span>
                  <span className="flex items-center gap-1.5">
                    <ProvenanceBadge source={prospect.provenance?.capacity_count} />
                    <span className="text-white font-medium">{prospect.capacity_count ?? "—"}</span>
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-500">Website</span>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <ProvenanceBadge source={prospect.provenance?.website_url} />
                    <WebsiteUrlField
                      prospectId={prospect.id}
                      currentUrl={prospect.website_url}
                      onSaved={loadProspect}
                    />
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-500">Ownership</span>
                  <span className="flex items-center gap-1.5">
                    <ProvenanceBadge source={prospect.provenance?.ownership_type} />
                    <Badge variant="outline" className="text-xs border-gray-700 text-gray-300 capitalize">
                      {prospect.ownership_type}
                    </Badge>
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-500">Online booking</span>
                  <span className="flex items-center gap-1.5">
                    <ProvenanceBadge source={prospect.provenance?.has_online_booking} />
                    {prospect.has_online_booking ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-400"><Wifi className="w-3 h-3" />Yes</span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-400"><WifiOff className="w-3 h-3" />No</span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm items-center">
                  <span className="text-gray-500">Tech maturity</span>
                  <span className="flex items-center gap-1.5">
                    <ProvenanceBadge source={prospect.provenance?.tech_maturity_score} />
                    <TechBar score={prospect.tech_maturity_score} />
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-gray-900 border-gray-800">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-gray-500 font-medium uppercase tracking-wider">Services Offered</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {(prospect.services ?? []).map((s) => (
                    <Badge key={s} className="bg-sky-900/30 text-sky-300 border-sky-800 text-xs">
                      {SERVICE_LABELS[s] ?? s}
                    </Badge>
                  ))}
                  {(!prospect.services || prospect.services.length === 0) && (
                    <span className="text-gray-600 text-sm">None recorded</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-gray-500 font-medium uppercase tracking-wider">Primary contact</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-sm font-medium text-gray-300">
                {prospect.contact_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium">{prospect.contact_name}</div>
                <div className="text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
                  <span>{prospect.contact_title}</span>
                  <span className="text-gray-700">·</span>
                  <ProvenanceBadge source={prospect.provenance?.email} />
                  <span>{prospect.email}</span>
                </div>
                {prospect.phone && (
                  <div className="text-xs text-gray-500 mt-0.5 inline-flex items-center gap-1">
                    <Phone className="w-3 h-3" />{prospect.phone}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <ContactsSection
            prospectId={prospect.id}
            contacts={prospect.contacts || []}
            onChange={(next) => setProspect({ ...prospect, contacts: next })}
          />
        </TabsContent>

        <TabsContent value="research" className="mt-4">
          {researching ? (
            <ResearchProgress
              prospectId={Number(id)}
              onComplete={handleResearchComplete}
            />
          ) : prospect.research_profile ? (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Button
                  size="sm" variant="outline"
                  onClick={runResearch}
                  className="border-gray-700 text-gray-400 hover:text-white text-xs"
                >
                  <RefreshCw className="w-3 h-3 mr-1.5" />
                  Re-run Research
                </Button>
              </div>

              {/* ICP Reasoning from Prospector Agent */}
              {prospect.research_profile.icp_reasoning && (
                <Card className="bg-emerald-950/20 border-emerald-900/40">
                  <CardContent className="p-4 flex items-start gap-3">
                    <Target className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
                    <div>
                      <div className="text-xs text-emerald-400/70 font-medium uppercase tracking-wider mb-1">Why Claude selected this prospect</div>
                      <div className="text-sm text-gray-200 leading-relaxed">{prospect.research_profile.icp_reasoning}</div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {[
                { label: "Hook Line",       key: "hook_line",       icon: Zap,       color: "text-amber-400",  sub: "Opening angle for outreach" },
                { label: "Pain Hypothesis", key: "pain_hypothesis", icon: Brain,     color: "text-violet-400", sub: "Core operational pain inferred from data" },
                { label: "Credible Detail", key: "credible_detail", icon: Building2, color: "text-sky-400",    sub: "Industry benchmark used as proof point" },
              ].map(({ label, key, icon: Icon, color, sub }) => (
                <Card key={key} className="bg-gray-900 border-gray-800">
                  <CardContent className="p-4 flex items-start gap-3">
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} />
                    <div>
                      <div className="text-xs text-gray-500 font-medium mb-0.5">{label}</div>
                      <div className="text-[10px] text-gray-600 mb-1.5">{sub}</div>
                      <div className="text-sm text-gray-200 leading-relaxed">
                        {prospect.research_profile?.[key as keyof typeof prospect.research_profile] as string}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}

              <Card className="bg-gray-900 border-gray-800">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Save className="w-4 h-4 mt-0.5 shrink-0 text-gray-500" />
                    <div className="flex-1">
                      <div className="text-xs text-gray-500 font-medium mb-0.5">Personalization Notes</div>
                      <div className="text-[10px] text-gray-600 mb-1.5">Copywriter guidance — tone and angle for this contact</div>
                      <p className="text-sm text-gray-400 leading-relaxed">
                        {prospect.research_profile.personalization_notes}
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-xs text-gray-500">Target persona:</span>
                        <Badge className="bg-gray-800 text-gray-300 border-gray-700 text-xs capitalize">
                          {prospect.research_profile.suggested_persona}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card className="bg-gray-900 border-gray-800">
              <CardContent className="p-8 text-center">
                <Brain className="w-8 h-8 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 text-sm mb-1">No research profile yet.</p>
                <p className="text-gray-600 text-xs mb-5">
                  The research agent will analyse this prospect's operation and generate a personalised outreach profile.
                </p>
                <Button onClick={runResearch} size="sm" className="bg-violet-700 hover:bg-violet-600">
                  <Brain className="w-3 h-3 mr-1.5" />
                  Run Research Agent
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="website" className="mt-4">
          {scraping ? (
            <WebsiteScrapeProgress
              prospectId={Number(id)}
              onComplete={handleScrapeComplete}
            />
          ) : prospect.website_research ? (
            <div className="space-y-4">
              <div className="flex justify-end">
                <ScrapeOptionsDialog
                  websiteUrl={prospect.website_url}
                  onStart={runWebsiteScrape}
                  triggerLabel={prospect.website_research.meta?.kind === "scrape" ? "Re-scrape" : "Scrape Website"}
                  triggerVariant="outline"
                />
              </div>
              <WebsiteResearchPanel
                wr={prospect.website_research}
                currentEmail={prospect.email}
                onAdoptEmail={adoptDiscoveredEmail}
              />
            </div>
          ) : (
            <Card className="bg-gray-900 border-gray-800">
              <CardContent className="p-8 text-center">
                <Globe className="w-8 h-8 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 text-sm mb-1">No website research yet.</p>
                <p className="text-gray-600 text-xs mb-5">
                  Scrape the prospect&apos;s website to extract services, online-booking status, tech stack, pain signals, and competitor mentions.
                </p>
                <ScrapeOptionsDialog
                  websiteUrl={prospect.website_url}
                  onStart={runWebsiteScrape}
                  triggerLabel="Scrape Website"
                />
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityFeed prospectId={Number(id)} limit={20} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
