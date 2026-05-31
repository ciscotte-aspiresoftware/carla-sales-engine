"use client"

import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { Pack } from "@/lib/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Car, Globe, ChevronDown, ChevronRight,
  Target, Layers, CheckCircle2,
  ArrowLeftRight, Zap, Plus, Trash2, Save, X,
  Package, AlertCircle, Pencil, Wand2, Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useVertical } from "@/lib/vertical-context"

// ── Static metadata ───────────────────────────────────────────────────────────

// Vertical card labels show INDUSTRY names (not vendor names). The vendor and product
// labels surface separately in the Vendor Pack and Product Pack sections below.
const BUILTIN_META: Record<string, { icon: React.ElementType; color: string; accent: string; label: string; product: string; badge?: string }> = {
  car_rental: { icon: Car, color: "#7c3aed", accent: "violet", label: "Car Rental", product: "ICP, industry KPIs, common pains" },
}

const REGION_META: Record<string, { flag: string; label: string }> = {
  us_en: { flag: "🇺🇸", label: "United States (English)" },
  nl_nl: { flag: "🇳🇱", label: "Netherlands (Dutch)"    },
  au_en: { flag: "🇦🇺", label: "Australia (English)"    },
}

const ACCENT_COLORS = ["#6366f1", "#0ea5e9", "#7c3aed", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6"]

// Human-readable ICP field definitions. These are fallback labels — packs
// can override via `prospect_schema_hints.size_field_label` for the active
// vertical's preferred wording (e.g. "Berth Count" vs "Fleet Size").
const FIELD_META: Record<string, { label: string; description: string }> = {
  capacity_count:      { label: "Fleet Size",            description: "Number of vehicles in the rental fleet. Larger fleets have greater operational complexity and higher inbound call volume — the primary driver of Carla ROI." },
  vehicle_count:       { label: "Fleet Size (vehicles)", description: "Number of rental vehicles operated. Larger fleets have greater operational complexity at the counter and back office." },
  tech_maturity_score: { label: "Tech Maturity Score",   description: "1–5 scale measuring how sophisticated the prospect's current software stack is. Score ≥ 2 indicates they already have a basic digital presence that Carla can layer onto." },
  has_online_booking:  { label: "Has Online Booking",    description: "Whether the business currently accepts reservations online. Indicates a tech-forward operator likely to be receptive to AI voice integration." },
  ownership_type:      { label: "Ownership Type",        description: "Family or corporate-owned businesses have a single clear decision-maker (owner or GM). Club-owned structures require committee approval, making sales cycles significantly longer." },
  fleet_size:          { label: "Fleet Size",            description: "Total number of vehicles or units in the rental fleet. Larger fleets have greater complexity and therefore higher ROI from fleet management software." },
  services:            { label: "Services Offered",      description: "Service mix the business operates (e.g. insurance replacement, airport transfer, van hire, long-term lease). A broader mix means more booking sources, more rate complexity, and more leverage from a unified rental management system." },
  country_code:        { label: "Country",               description: "The prospect's country of operation. Used for regional pack matching, holiday-aware scheduling, and compliance language selection." },
  has_api_integration: { label: "Has API Integration",   description: "Whether the business already uses API-connected tools. Indicates tech-forward operations more likely to see value in deep software integration." },
}

const OPERATOR_LABELS: Record<string, string> = {
  gte: "≥ (at least)",
  lte: "≤ (at most)",
  eq:  "= (equals)",
  in:  "∈ (one of)",
  gt:  "> (greater than)",
  lt:  "< (less than)",
}

function FieldLabel({ field }: { field: string }) {
  const meta = FIELD_META[field]
  if (!meta) return <span className="font-mono text-xs text-gray-400">{field}</span>
  return (
    <span className="group relative inline-flex items-center gap-1 cursor-help">
      <span className="text-xs text-gray-300">{meta.label}</span>
      <span className="w-3.5 h-3.5 rounded-full bg-gray-700 text-gray-400 text-[9px] flex items-center justify-center font-bold shrink-0">?</span>
      <span className="absolute left-0 bottom-full mb-2 z-50 hidden group-hover:block w-72 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-[11px] text-gray-300 leading-relaxed shadow-xl">
        <span className="font-semibold text-white block mb-0.5">{meta.label}</span>
        {meta.description}
      </span>
    </span>
  )
}

function getPackMeta(packId: string, pack?: Pack | null) {
  if (BUILTIN_META[packId]) return BUILTIN_META[packId]
  const color = pack?.logo_color ?? "#6366f1"
  return { icon: Package, color, accent: "indigo", label: pack?.product_name ?? packId, product: pack?.display_name ?? "" }
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left"
      >
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">{title}</span>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
      </button>
      {open && <div className="p-4 bg-gray-900/50">{children}</div>}
    </div>
  )
}

// ── Pack viewer sub-components ────────────────────────────────────────────────

function IcpCriteria({ pack }: { pack: Pack }) {
  const criteria = pack.icp?.criteria ?? []
  return (
    <div className="space-y-0">
      {/* Column headers */}
      <div className="grid grid-cols-12 gap-2 pb-2 mb-1 border-b border-gray-800">
        <span className="col-span-5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Field</span>
        <span className="col-span-3 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Condition</span>
        <span className="col-span-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider text-right">Weight</span>
        <span className="col-span-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider text-right">Score Impact</span>
      </div>
      {criteria.map((c, i) => {
        const opLabel = OPERATOR_LABELS[c.operator] ?? c.operator
        const impact = Math.round(c.weight * 100)
        return (
          <div key={i} className="grid grid-cols-12 gap-2 items-start py-2.5 border-b border-gray-800/40 last:border-0">
            <div className="col-span-5 flex items-start gap-2">
              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <FieldLabel field={c.field} />
                <div className="text-[10px] text-gray-600 mt-0.5">{c.label}</div>
              </div>
            </div>
            <div className="col-span-3 text-xs text-gray-400">
              <span className="text-gray-500">{opLabel}</span>{" "}
              <span className="font-mono text-gray-300">{Array.isArray(c.value) ? c.value.join(", ") : String(c.value)}</span>
            </div>
            <div className="col-span-2 text-right">
              <Badge className="text-[9px] px-1.5 py-0 bg-gray-800 text-gray-400 border-gray-700 border">{c.weight}</Badge>
            </div>
            <div className="col-span-2 text-right">
              <span className="text-[11px] text-sky-400 font-medium">+{impact}%</span>
            </div>
          </div>
        )
      })}
      {criteria.length === 0 && <p className="text-xs text-gray-600 py-2">No ICP criteria defined.</p>}
    </div>
  )
}

function PersonaCards({ pack }: { pack: Pack }) {
  const personas = pack.personas ?? {}
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {Object.entries(personas).map(([key, persona]) => (
        <div key={key} className="bg-gray-800/40 rounded-lg p-3 border border-gray-800">
          <div className="text-xs font-semibold text-white mb-1 capitalize">{key.replace(/_/g, " ")}</div>
          <div className="text-[10px] text-gray-500 mb-2">{persona.titles?.join(", ")}</div>
          <div className="space-y-1">
            {(persona.value_props ?? []).slice(0, 3).map((vp, i) => (
              <div key={i} className="flex gap-1.5 text-[11px] text-gray-400">
                <Zap className="w-2.5 h-2.5 text-amber-400 mt-0.5 shrink-0" />{vp}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function MessagingFramework({ pack }: { pack: Pack }) {
  const mf = pack.messaging_framework
  if (!mf) return <p className="text-xs text-gray-600">No messaging framework defined.</p>
  return (
    <div className="space-y-3">
      <div className="bg-gray-800/40 rounded-lg p-3 border border-gray-800">
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5">Elevator pitch</div>
        <p className="text-xs text-gray-300 leading-relaxed">{mf.elevator_pitch}</p>
      </div>
      {mf.differentiators && mf.differentiators.length > 0 && (
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Differentiators</div>
          <ul className="space-y-1">
            {mf.differentiators.map((d, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] text-gray-400">
                <ArrowLeftRight className="w-2.5 h-2.5 text-sky-400 mt-0.5 shrink-0" />{d}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function VerticalPackPanel({ packId, active, onEdit }: { packId: string; active: boolean; onEdit: () => void }) {
  const [pack, setPack] = useState<Pack | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!active) return
    setLoading(true)
    api.getVerticalPack(packId).then(setPack).finally(() => setLoading(false))
  }, [packId, active])

  if (!active) return null
  if (loading) return <div className="space-y-3 mt-4">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-gray-800 rounded" />)}</div>
  if (!pack) return null

  return (
    <div className="space-y-3 mt-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={onEdit}
          className="border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 text-xs h-7"
        >
          <Pencil className="w-3 h-3 mr-1.5" /> Edit Pack
        </Button>
      </div>
      <CollapsibleSection title="ICP Scoring Criteria" defaultOpen><IcpCriteria pack={pack} /></CollapsibleSection>
      <CollapsibleSection title="Buyer Personas" defaultOpen><PersonaCards pack={pack} /></CollapsibleSection>
      <CollapsibleSection title="Messaging Framework"><MessagingFramework pack={pack} /></CollapsibleSection>
    </div>
  )
}

function RegionalPackPanel({ packId }: { packId: string }) {
  const [pack, setPack] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getRegionalPack(packId).then((p) => setPack(p as unknown as Record<string, unknown>)).finally(() => setLoading(false))
  }, [packId])

  if (loading) return <Skeleton className="h-24 bg-gray-800 rounded mt-2" />
  if (!pack) return null

  const tone = pack.tone as Record<string, unknown> | undefined
  const scheduling = pack.scheduling as Record<string, unknown> | undefined
  const compliance = pack.compliance as Record<string, unknown> | undefined
  const localization = pack.localization as Record<string, unknown> | undefined

  return (
    <div className="space-y-3 mt-4">
      {tone && (
        <CollapsibleSection title="Tone & Style" defaultOpen>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(tone).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => (
              <div key={k} className="text-xs">
                <span className="text-gray-500 capitalize">{k.replace(/_/g, " ")}: </span>
                <span className="text-gray-300">{String(v)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {scheduling && (
        <CollapsibleSection title="Send Scheduling">
          <div className="space-y-1.5">
            {Object.entries(scheduling).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs">
                <span className="text-gray-500 capitalize w-40 shrink-0">{k.replace(/_/g, " ")}:</span>
                <span className="text-gray-300">{Array.isArray(v) ? v.join(", ") : String(v)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {compliance && (
        <CollapsibleSection title="Compliance">
          <div className="space-y-1.5">
            {Object.entries(compliance).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs">
                <span className="text-gray-500 capitalize w-40 shrink-0">{k.replace(/_/g, " ")}:</span>
                <span className="text-gray-300">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
      {localization && (
        <CollapsibleSection title="Localization">
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(localization).filter(([, v]) => typeof v === "string").map(([k, v]) => (
              <div key={k} className="text-xs">
                <span className="text-gray-500 capitalize">{k.replace(/_/g, " ")}: </span>
                <span className="text-gray-300">{String(v)}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  )
}

// ── Pack Builder / Editor ─────────────────────────────────────────────────────

type IcpRow = { field: string; operator: string; value: string; weight: string; label: string }
type PersonaRow = { key: string; titles: string; value_props: string; communication_style: string }

const OPERATORS = ["gte", "lte", "eq", "in", "gt", "lt"]

interface PackBuilderProps {
  onSaved: (packId: string) => void
  onCancel: () => void
  /** If provided, the builder is in edit mode */
  editingPack?: Pack & { pack_id: string }
  editingPackId?: string
}

function PackBuilder({ onSaved, onCancel, editingPack, editingPackId }: PackBuilderProps) {
  const isEditing = !!editingPackId

  // Initialise from existing pack if editing
  const initIcp = (): IcpRow[] => {
    const criteria = editingPack?.icp?.criteria ?? []
    if (criteria.length === 0) return [
      { field: "", operator: "gte", value: "", weight: "0.25", label: "" },
      { field: "", operator: "eq", value: "false", weight: "0.25", label: "" },
    ]
    return criteria.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value),
      weight: String(c.weight),
      label: c.label,
    }))
  }

  const initPersonas = (): PersonaRow[] => {
    const personas = editingPack?.personas ?? {}
    const entries = Object.entries(personas)
    if (entries.length === 0) return [{ key: "owner", titles: "", value_props: "", communication_style: "" }]
    return entries.map(([key, p]) => ({
      key,
      titles: (p.titles ?? []).join(", "),
      value_props: (p.value_props ?? []).join("\n"),
      communication_style: p.communication_style ?? "",
    }))
  }

  const [packId, setPackId] = useState(editingPackId ?? "")
  const [displayName, setDisplayName] = useState(editingPack?.display_name ?? "")
  const [productName, setProductName] = useState(editingPack?.product_name ?? "")
  const [logoColor, setLogoColor] = useState(editingPack?.logo_color ?? "#6366f1")
  const [elevatorPitch, setElevatorPitch] = useState(editingPack?.messaging_framework?.elevator_pitch ?? "")
  const [differentiators, setDifferentiators] = useState<string[]>(
    editingPack?.messaging_framework?.differentiators?.length
      ? editingPack.messaging_framework.differentiators
      : ["", "", ""]
  )
  const [sequenceStrategy, setSequenceStrategy] = useState(editingPack?.email_guidance?.sequence_strategy ?? "")
  const [ctaProgression, setCtaProgression] = useState<string[]>(
    editingPack?.email_guidance?.cta_progression?.length
      ? editingPack.email_guidance.cta_progression
      : ["", "", ""]
  )
  const [avoid, setAvoid] = useState<string[]>(
    editingPack?.email_guidance?.avoid?.length
      ? editingPack.email_guidance.avoid
      : ["", ""]
  )
  const [icp, setIcp] = useState<IcpRow[]>(initIcp)
  const [personas, setPersonas] = useState<PersonaRow[]>(initPersonas)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [aiFillingIcp, setAiFillingIcp] = useState(false)

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

  const buildPayload = () => ({
    pack_id: packId,
    display_name: displayName,
    product_name: productName,
    logo_color: logoColor,
    icp: {
      description: `ICP for ${displayName}`,
      minimum_score: 0.55,
      criteria: icp
        .filter(r => r.field && r.label)
        .map(r => ({
          field: r.field,
          operator: r.operator,
          value: r.operator === "in"
            ? r.value.split(",").map(s => s.trim())
            : r.value === "true" ? true : r.value === "false" ? false : isNaN(Number(r.value)) ? r.value : Number(r.value),
          weight: parseFloat(r.weight) || 0.25,
          label: r.label,
        })),
    },
    personas: Object.fromEntries(
      personas
        .filter(p => p.key && p.value_props)
        .map(p => [
          p.key,
          {
            titles: p.titles.split(",").map(s => s.trim()).filter(Boolean),
            primary_motivators: [],
            communication_style: p.communication_style,
            value_props: p.value_props.split("\n").map(s => s.trim()).filter(Boolean),
            objection_handles: {},
          },
        ])
    ),
    messaging_framework: {
      elevator_pitch: elevatorPitch,
      category: displayName,
      differentiators: differentiators.filter(Boolean),
      proof_points: [],
    },
    email_guidance: {
      sequence_strategy: sequenceStrategy,
      subject_line_style: "",
      cta_progression: ctaProgression.filter(Boolean),
      avoid: avoid.filter(Boolean),
    },
  })

  const handleSave = async () => {
    if (!packId || !displayName || !elevatorPitch) {
      setError("Pack ID, display name, and elevator pitch are required.")
      return
    }
    setSaving(true)
    setError("")
    try {
      const payload = buildPayload()
      if (isEditing) {
        await api.updateVerticalPack(editingPackId!, payload)
      } else {
        await api.createVerticalPack(payload)
      }
      onSaved(packId)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes("409") ? `A pack with ID "${packId}" already exists.` : `Save failed: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const updateIcp = (i: number, field: keyof IcpRow, val: string) =>
    setIcp(rows => rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))

  const updatePersona = (i: number, field: keyof PersonaRow, val: string) =>
    setPersonas(rows => rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r))

  return (
    <div className="border border-gray-700 rounded-xl bg-gray-900/80 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          {isEditing
            ? <><Pencil className="w-4 h-4 text-sky-400" /> Edit Pack: {editingPackId}</>
            : <><Plus className="w-4 h-4 text-indigo-400" /> New Vertical Pack</>
          }
        </h3>
        <button onClick={onCancel} className="text-gray-600 hover:text-gray-300">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/30 border border-red-900/40 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
        </div>
      )}

      {/* Basic info */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Pack ID *</label>
          <input
            value={packId}
            onChange={e => !isEditing && setPackId(slugify(e.target.value))}
            readOnly={isEditing}
            placeholder="e.g. hotel_management"
            className={cn(
              "w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500",
              isEditing && "opacity-50 cursor-not-allowed"
            )}
          />
          {!isEditing && <p className="text-[10px] text-gray-600 mt-0.5">Lowercase letters, numbers, underscores</p>}
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Display Name *</label>
          <input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. HotelOS — Property Management"
            className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Product Name</label>
          <input
            value={productName}
            onChange={e => setProductName(e.target.value)}
            placeholder="e.g. HotelOS"
            className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Brand Color</label>
          <div className="flex gap-2 flex-wrap">
            {ACCENT_COLORS.map(c => (
              <button
                key={c}
                onClick={() => setLogoColor(c)}
                className={cn("w-6 h-6 rounded-full border-2 transition-all", logoColor === c ? "border-white scale-110" : "border-transparent")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Elevator pitch */}
      <div>
        <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Elevator Pitch *</label>
        <textarea
          value={elevatorPitch}
          onChange={e => setElevatorPitch(e.target.value)}
          rows={2}
          placeholder="One or two sentences that describe exactly what this product does and for whom..."
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
        />
      </div>

      {/* ICP Criteria */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">ICP Scoring Criteria</label>
          <div className="flex items-center gap-3">
            <button
              onClick={async () => {
                if (!packId && !displayName) {
                  setError("Set a Pack ID or Display Name first so the AI knows what industry to score.")
                  return
                }
                setError("")
                setAiFillingIcp(true)
                try {
                  const generated = await api.generatePackSection({
                    section: "icp",
                    vertical_id: isEditing ? editingPackId : (packId || undefined),
                    draft: isEditing ? undefined : {
                      _layer: "vertical",
                      pack_id: packId,
                      display_name: displayName,
                      product_name: productName,
                    },
                  })
                  type IcpCrit = { field: string; operator: string; value: unknown; weight: number; label: string }
                  const criteria = (generated as { criteria?: IcpCrit[] }).criteria ?? []
                  if (criteria.length > 0) {
                    setIcp(criteria.map((c) => ({
                      field: c.field,
                      operator: c.operator,
                      value: Array.isArray(c.value) ? c.value.join(", ") : String(c.value),
                      weight: String(c.weight),
                      label: c.label,
                    })))
                  } else {
                    setError("AI returned no criteria. Try adding a Display Name or Product Name for context.")
                  }
                } catch (e) {
                  setError(`AI auto-fill failed: ${e instanceof Error ? e.message : String(e)}`)
                } finally {
                  setAiFillingIcp(false)
                }
              }}
              disabled={aiFillingIcp}
              className="text-[10px] text-sky-300 hover:text-sky-200 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Wand2 className={cn("w-3 h-3", aiFillingIcp && "animate-pulse")} />
              {aiFillingIcp ? "Generating..." : "AI Auto-fill"}
            </button>
            <button
              onClick={() => setIcp(r => [...r, { field: "", operator: "gte", value: "", weight: "0.25", label: "" }])}
              className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add criterion
            </button>
          </div>
        </div>
        {/* Column headers */}
        <div className="grid grid-cols-12 gap-2 mb-1.5 px-0.5">
          <div className="col-span-3 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1">
            Field Name
            <span className="text-gray-600 normal-case font-normal">(data field)</span>
          </div>
          <div className="col-span-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Operator</div>
          <div className="col-span-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            Match Value
          </div>
          <div className="col-span-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Weight</div>
          <div className="col-span-3 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
            Human-readable label
          </div>
          <div className="col-span-1" />
        </div>
        <div className="space-y-2">
          {icp.map((row, i) => {
            const fieldHint = FIELD_META[row.field]
            return (
              <div key={i} className="space-y-1">
                <div className="grid grid-cols-12 gap-2 items-start">
                  <div className="col-span-3">
                    <input
                      value={row.field}
                      onChange={e => updateIcp(i, "field", e.target.value)}
                      placeholder="e.g. capacity_count"
                      className="w-full px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
                    />
                    {fieldHint && (
                      <div className="text-[10px] text-indigo-400 mt-0.5 truncate" title={fieldHint.description}>
                        → {fieldHint.label}
                      </div>
                    )}
                  </div>
                  <select value={row.operator} onChange={e => updateIcp(i, "operator", e.target.value)} className="col-span-2 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500">
                    {OPERATORS.map(op => (
                      <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>
                    ))}
                  </select>
                  <input value={row.value} onChange={e => updateIcp(i, "value", e.target.value)} placeholder="e.g. 50 or false" className="col-span-2 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <div className="col-span-1">
                    <input
                      value={row.weight}
                      onChange={e => updateIcp(i, "weight", e.target.value)}
                      placeholder="0.25"
                      className="w-full px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <div className="text-[10px] text-gray-600 mt-0.5 text-center">0–1 share</div>
                  </div>
                  <input value={row.label} onChange={e => updateIcp(i, "label", e.target.value)} placeholder="Explain this rule in plain English..." className="col-span-3 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                  <button onClick={() => setIcp(r => r.filter((_, idx) => idx !== i))} className="col-span-1 text-gray-600 hover:text-red-400 flex justify-center pt-1.5">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {fieldHint && (
                  <div className="text-[10px] text-gray-600 pl-0.5 leading-relaxed">
                    <span className="text-gray-500">What this means: </span>{fieldHint.description}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <p className="text-[10px] text-gray-600 mt-2">Weights should sum to ~1.0. Each matched criterion adds (weight × 100)% to the ICP score.</p>
      </div>

      {/* Personas */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider">Personas</label>
          <button
            onClick={() => setPersonas(r => [...r, { key: "", titles: "", value_props: "", communication_style: "" }])}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Add persona
          </button>
        </div>
        <div className="space-y-3">
          {personas.map((p, i) => (
            <div key={i} className="bg-gray-800/40 rounded-lg p-3 border border-gray-800 space-y-2">
              <div className="flex gap-2">
                <input value={p.key} onChange={e => updatePersona(i, "key", slugify(e.target.value))} placeholder="Persona key (e.g. owner)" className="flex-1 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <input value={p.titles} onChange={e => updatePersona(i, "titles", e.target.value)} placeholder="Titles (comma-separated)" className="flex-1 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
                <button onClick={() => setPersonas(r => r.filter((_, idx) => idx !== i))} className="text-gray-600 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <input value={p.communication_style} onChange={e => updatePersona(i, "communication_style", e.target.value)} placeholder="Communication style" className="w-full px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              <textarea value={p.value_props} onChange={e => updatePersona(i, "value_props", e.target.value)} rows={3} placeholder={"Value props (one per line)\nLine 1\nLine 2\nLine 3"} className="w-full px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none" />
            </div>
          ))}
        </div>
      </div>

      {/* Differentiators */}
      <div>
        <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-2">Key Differentiators</label>
        <div className="space-y-2">
          {differentiators.map((d, i) => (
            <input key={i} value={d} onChange={e => setDifferentiators(arr => arr.map((v, idx) => idx === i ? e.target.value : v))}
              placeholder={`Differentiator ${i + 1}`}
              className="w-full px-3 py-2 text-xs bg-gray-800 border border-gray-700 rounded-md text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          ))}
        </div>
      </div>

      {/* Email guidance */}
      <div>
        <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Sequence Strategy</label>
        <textarea value={sequenceStrategy} onChange={e => setSequenceStrategy(e.target.value)} rows={2}
          placeholder="Describe the email sequence pattern — e.g. Teach-Teach-Ask: Touch 1 leads with insight..."
          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
        />
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-800">
        <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
        <Button onClick={handleSave} disabled={saving} className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50">
          {saving
            ? <><Save className="w-3.5 h-3.5 mr-2 animate-pulse" /> Saving...</>
            : <><Save className="w-3.5 h-3.5 mr-2" /> {isEditing ? "Save Changes" : "Create Pack"}</>
          }
        </Button>
      </div>
    </div>
  )
}

// ── Regional Pack Builder ─────────────────────────────────────────────────────

function RegionalPackBuilder({ onSaved, onCancel }: { onSaved: (id: string) => void; onCancel: () => void }) {
  const [country, setCountry] = useState("")
  const [generating, setGenerating] = useState(false)

  const [packId, setPackId] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [language, setLanguage] = useState("en")
  const [locale, setLocale] = useState("")
  const [countryCode, setCountryCode] = useState("")
  const [timezone, setTimezone] = useState("")
  const [currency, setCurrency] = useState("")
  const [currencySymbol, setCurrencySymbol] = useState("")

  const [toneFormality, setToneFormality] = useState("informal")
  const [toneDirectness, setToneDirectness] = useState("high")
  const [toneHumor, setToneHumor] = useState("light")
  const [toneRelStyle, setToneRelStyle] = useState("")
  const [toneNotes, setToneNotes] = useState("")

  const [noSendDays, setNoSendDays] = useState<number[]>([0, 6])
  const [noSendStart, setNoSendStart] = useState(18)
  const [noSendEnd, setNoSendEnd] = useState(8)
  const [bestWindows, setBestWindows] = useState("")
  const [blackouts, setBlackouts] = useState("[]")

  const [dateFormat, setDateFormat] = useState("")
  const [numberFormat, setNumberFormat] = useState("")
  const [greetingStyle, setGreetingStyle] = useState("")
  const [signOff, setSignOff] = useState("")
  const [units, setUnits] = useState("metric")
  const [measurementNotes, setMeasurementNotes] = useState("")

  const [relevantLaw, setRelevantLaw] = useState("")
  const [optOutLanguage, setOptOutLanguage] = useState("")
  const [requiredFooter, setRequiredFooter] = useState("")
  const [complianceNotes, setComplianceNotes] = useState("")

  const [culturalNotes, setCulturalNotes] = useState("")

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")

  const applyGenerated = (d: Record<string, unknown>) => {
    if (d.pack_id)        setPackId(d.pack_id as string)
    if (d.display_name)   setDisplayName(d.display_name as string)
    if (d.language)       setLanguage(d.language as string)
    if (d.locale)         setLocale(d.locale as string)
    if (d.country_code)   setCountryCode((d.country_code as string).toUpperCase().slice(0, 2))
    if (d.timezone)       setTimezone(d.timezone as string)
    if (d.currency)       setCurrency(d.currency as string)
    if (d.currency_symbol) setCurrencySymbol(d.currency_symbol as string)
    const tone = d.tone as Record<string, unknown> | undefined
    if (tone) {
      if (tone.formality)         setToneFormality(tone.formality as string)
      if (tone.directness)        setToneDirectness(tone.directness as string)
      if (tone.humor)             setToneHumor(tone.humor as string)
      if (tone.relationship_style) setToneRelStyle(tone.relationship_style as string)
      if (tone.notes)             setToneNotes(tone.notes as string)
    }
    const sched = d.scheduling as Record<string, unknown> | undefined
    if (sched) {
      if (Array.isArray(sched.no_send_days_of_week))  setNoSendDays(sched.no_send_days_of_week as number[])
      if (sched.no_send_hours_start !== undefined)    setNoSendStart(sched.no_send_hours_start as number)
      if (sched.no_send_hours_end !== undefined)      setNoSendEnd(sched.no_send_hours_end as number)
      if (Array.isArray(sched.best_send_windows))     setBestWindows((sched.best_send_windows as string[]).join("\n"))
      if (Array.isArray(sched.blackout_periods))      setBlackouts(JSON.stringify(sched.blackout_periods, null, 2))
    }
    const loc = d.localization as Record<string, unknown> | undefined
    if (loc) {
      if (loc.date_format)       setDateFormat(loc.date_format as string)
      if (loc.number_format)     setNumberFormat(loc.number_format as string)
      if (loc.greeting_style)    setGreetingStyle(loc.greeting_style as string)
      if (loc.sign_off)          setSignOff(loc.sign_off as string)
      if (loc.units)             setUnits(loc.units as string)
      if (loc.measurement_notes) setMeasurementNotes(loc.measurement_notes as string)
    }
    const comp = d.compliance as Record<string, unknown> | undefined
    if (comp) {
      if (comp.relevant_law)     setRelevantLaw(comp.relevant_law as string)
      if (comp.opt_out_language) setOptOutLanguage(comp.opt_out_language as string)
      if (comp.required_footer)  setRequiredFooter(comp.required_footer as string)
      if (comp.notes)            setComplianceNotes(comp.notes as string)
    }
    if (d.cultural_notes) setCulturalNotes(d.cultural_notes as string)
  }

  const handleGenerate = async () => {
    if (!country.trim()) return
    setGenerating(true)
    setError("")
    try {
      const data = await api.generateRegionalPack(country.trim())
      applyGenerated(data)
    } catch (e: unknown) {
      setError(`AI generation failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
    }
  }

  const buildPayload = () => {
    let blackoutArr: unknown[] = []
    try { blackoutArr = JSON.parse(blackouts) } catch { blackoutArr = [] }
    return {
      pack_id: packId,
      display_name: displayName,
      language,
      locale,
      country_code: countryCode.toUpperCase().slice(0, 2),
      timezone,
      currency,
      currency_symbol: currencySymbol,
      tone: { formality: toneFormality, directness: toneDirectness, humor: toneHumor, relationship_style: toneRelStyle, notes: toneNotes },
      scheduling: {
        nager_country_code: countryCode.toUpperCase().slice(0, 2),
        no_send_days_of_week: noSendDays,
        no_send_hours_start: noSendStart,
        no_send_hours_end: noSendEnd,
        best_send_windows: bestWindows.split("\n").map(s => s.trim()).filter(Boolean),
        blackout_periods: blackoutArr,
      },
      localization: { date_format: dateFormat, number_format: numberFormat, greeting_style: greetingStyle, sign_off: signOff, units, measurement_notes: measurementNotes },
      compliance: { opt_out_language: optOutLanguage, required_footer: requiredFooter, relevant_law: relevantLaw, notes: complianceNotes },
      cultural_notes: culturalNotes,
    }
  }

  const handleSave = async () => {
    if (!packId || !displayName) { setError("Pack ID and display name are required."); return }
    setSaving(true)
    setError("")
    try {
      await api.createRegionalPack(buildPayload())
      onSaved(packId)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes("409") ? `Pack "${packId}" already exists.` : `Save failed: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const inp = "w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
  const lbl = "text-[10px] text-gray-500 uppercase tracking-wider block mb-1"
  const sel = "w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 focus:outline-none focus:ring-1 focus:ring-sky-500"

  return (
    <div className="border border-gray-700 rounded-xl bg-gray-900/80 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Globe className="w-4 h-4 text-sky-400" /> New Regional Pack
        </h3>
        <button onClick={onCancel} className="text-gray-600 hover:text-gray-300"><X className="w-4 h-4" /></button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/30 border border-red-900/40 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
        </div>
      )}

      {/* AI auto-fill */}
      <div className="bg-sky-950/20 border border-sky-800/30 rounded-lg p-3 space-y-2">
        <p className="text-xs font-medium text-sky-300 flex items-center gap-1.5"><Wand2 className="w-3.5 h-3.5" /> AI Auto-fill</p>
        <p className="text-[11px] text-gray-500">Enter a country and Claude will generate all pack fields — tone, scheduling, compliance, localization, and cultural notes.</p>
        <div className="flex gap-2">
          <input
            value={country} onChange={e => setCountry(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleGenerate()}
            placeholder="e.g. Germany, Japan, France, Brazil…"
            className={cn(inp, "flex-1")}
          />
          <Button onClick={handleGenerate} disabled={!country.trim() || generating} className="bg-sky-700 hover:bg-sky-600 disabled:opacity-50 shrink-0">
            {generating
              ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Generating…</>
              : <><Wand2 className="w-3.5 h-3.5 mr-2" /> Generate</>}
          </Button>
        </div>
      </div>

      {/* Basic */}
      <div className="space-y-3">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Basic Info</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Pack ID *</label>
            <input value={packId} onChange={e => setPackId(slugify(e.target.value))} placeholder="e.g. de_de" className={inp} />
            <p className="text-[10px] text-gray-600 mt-0.5">Lowercase letters, numbers, underscores</p>
          </div>
          <div>
            <label className={lbl}>Display Name *</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Germany (German)" className={inp} />
          </div>
          <div>
            <label className={lbl}>Language Code</label>
            <input value={language} onChange={e => setLanguage(e.target.value)} placeholder="e.g. de" className={inp} />
          </div>
          <div>
            <label className={lbl}>Locale</label>
            <input value={locale} onChange={e => setLocale(e.target.value)} placeholder="e.g. de-DE" className={inp} />
          </div>
          <div>
            <label className={lbl}>Country Code (ISO)</label>
            <input value={countryCode} onChange={e => setCountryCode(e.target.value.toUpperCase().slice(0, 2))} placeholder="e.g. DE" className={inp} />
          </div>
          <div>
            <label className={lbl}>Timezone</label>
            <input value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="e.g. Europe/Berlin" className={inp} />
          </div>
          <div>
            <label className={lbl}>Currency</label>
            <input value={currency} onChange={e => setCurrency(e.target.value)} placeholder="e.g. EUR" className={inp} />
          </div>
          <div>
            <label className={lbl}>Currency Symbol</label>
            <input value={currencySymbol} onChange={e => setCurrencySymbol(e.target.value)} placeholder="e.g. €" className={inp} />
          </div>
        </div>
      </div>

      {/* Tone */}
      <CollapsibleSection title="Tone & Style" defaultOpen>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <label className={lbl}>Formality</label>
            <select value={toneFormality} onChange={e => setToneFormality(e.target.value)} className={sel}>
              <option value="informal">Informal</option>
              <option value="semi-formal">Semi-formal</option>
              <option value="formal">Formal</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Directness</label>
            <select value={toneDirectness} onChange={e => setToneDirectness(e.target.value)} className={sel}>
              <option value="low">Low</option>
              <option value="moderate">Moderate</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Humor</label>
            <select value={toneHumor} onChange={e => setToneHumor(e.target.value)} className={sel}>
              <option value="none">None</option>
              <option value="minimal">Minimal</option>
              <option value="light">Light</option>
              <option value="moderate">Moderate</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Relationship Style</label>
            <input value={toneRelStyle} onChange={e => setToneRelStyle(e.target.value)} placeholder="e.g. professional_first" className={inp} />
          </div>
          <div className="col-span-2">
            <label className={lbl}>Tone Notes</label>
            <textarea value={toneNotes} onChange={e => setToneNotes(e.target.value)} rows={3} placeholder="B2B tone guidance for this market…" className={cn(inp, "resize-none")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Scheduling */}
      <CollapsibleSection title="Scheduling">
        <div className="space-y-3 pt-1">
          <div>
            <label className={lbl}>No-send Days</label>
            <div className="flex gap-2 flex-wrap">
              {DAY_LABELS.map((d, i) => (
                <button key={i} type="button"
                  onClick={() => setNoSendDays(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                  className={cn("px-2.5 py-1 text-xs rounded border transition-all",
                    noSendDays.includes(i) ? "bg-red-900/40 border-red-700 text-red-300" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                  )}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>No-send Start Hour (24h)</label>
              <input type="number" min={0} max={23} value={noSendStart} onChange={e => setNoSendStart(Number(e.target.value))} className={inp} />
            </div>
            <div>
              <label className={lbl}>No-send End Hour (24h)</label>
              <input type="number" min={0} max={23} value={noSendEnd} onChange={e => setNoSendEnd(Number(e.target.value))} className={inp} />
            </div>
          </div>
          <div>
            <label className={lbl}>Best Send Windows (one per line)</label>
            <textarea value={bestWindows} onChange={e => setBestWindows(e.target.value)} rows={3} placeholder={"Tue 10:00-11:30\nWed 14:00-15:30"} className={cn(inp, "resize-none font-mono")} />
          </div>
          <div>
            <label className={lbl}>Blackout Periods (JSON array)</label>
            <textarea value={blackouts} onChange={e => setBlackouts(e.target.value)} rows={5} className={cn(inp, "resize-none font-mono text-[11px]")} />
          </div>
        </div>
      </CollapsibleSection>

      {/* Localization */}
      <CollapsibleSection title="Localization">
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div><label className={lbl}>Date Format</label><input value={dateFormat} onChange={e => setDateFormat(e.target.value)} placeholder="e.g. DD.MM.YYYY" className={inp} /></div>
          <div><label className={lbl}>Number Format</label><input value={numberFormat} onChange={e => setNumberFormat(e.target.value)} placeholder="e.g. 1.000,00" className={inp} /></div>
          <div><label className={lbl}>Greeting Style</label><input value={greetingStyle} onChange={e => setGreetingStyle(e.target.value)} placeholder='e.g. Sehr geehrte(r) {first_name},' className={inp} /></div>
          <div><label className={lbl}>Sign-off</label><input value={signOff} onChange={e => setSignOff(e.target.value)} placeholder="e.g. Mit freundlichen Grüßen," className={inp} /></div>
          <div>
            <label className={lbl}>Units</label>
            <select value={units} onChange={e => setUnits(e.target.value)} className={sel}>
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
            </select>
          </div>
          <div><label className={lbl}>Measurement Notes</label><input value={measurementNotes} onChange={e => setMeasurementNotes(e.target.value)} placeholder="e.g. Use miles, gallons, and USD" className={inp} /></div>
        </div>
      </CollapsibleSection>

      {/* Compliance */}
      <CollapsibleSection title="Compliance">
        <div className="space-y-3 pt-1">
          <div><label className={lbl}>Relevant Law</label><input value={relevantLaw} onChange={e => setRelevantLaw(e.target.value)} placeholder="e.g. GDPR, CAN-SPAM" className={inp} /></div>
          <div><label className={lbl}>Opt-out Language</label><textarea value={optOutLanguage} onChange={e => setOptOutLanguage(e.target.value)} rows={2} className={cn(inp, "resize-none")} /></div>
          <div><label className={lbl}>Required Footer</label><textarea value={requiredFooter} onChange={e => setRequiredFooter(e.target.value)} rows={2} className={cn(inp, "resize-none")} /></div>
          <div><label className={lbl}>Notes</label><textarea value={complianceNotes} onChange={e => setComplianceNotes(e.target.value)} rows={2} className={cn(inp, "resize-none")} /></div>
        </div>
      </CollapsibleSection>

      {/* Cultural Notes */}
      <CollapsibleSection title="Cultural Notes">
        <textarea value={culturalNotes} onChange={e => setCulturalNotes(e.target.value)} rows={4} placeholder="Key cultural context for this market…" className={cn(inp, "resize-none mt-1")} />
      </CollapsibleSection>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-800">
        <button onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
        <Button onClick={handleSave} disabled={saving} className="bg-sky-700 hover:bg-sky-600 disabled:opacity-50">
          {saving ? <><Save className="w-3.5 h-3.5 mr-2 animate-pulse" /> Saving…</> : <><Save className="w-3.5 h-3.5 mr-2" /> Save Pack</>}
        </Button>
      </div>
    </div>
  )
}

// ── Vendor pack panel + editor ────────────────────────────────────────────────

function VendorPackPanel({ packId }: { packId: string }) {
  const [vendor, setVendor] = useState<import("@/lib/types").VendorPack | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [senderName, setSenderName] = useState("")
  const [senderEmail, setSenderEmail] = useState("")
  const [excludedRows, setExcludedRows] = useState<{ name: string; reason: string }[]>([])
  const [competitorRows, setCompetitorRows] = useState<string[]>([])

  const load = () => {
    api.getVendorPack(packId).then(v => {
      setVendor(v)
      setSenderName(v.outreach_sender?.name ?? "")
      setSenderEmail(v.outreach_sender?.email ?? "")
      setExcludedRows((v.excluded_customers ?? []).map((e) => {
        if (typeof e === "string") return { name: e, reason: "" }
        return { name: e.name, reason: e.reason ?? "" }
      }))
      setCompetitorRows((v.competitor_signals ?? []).slice())
    }).catch(() => setError(`Vendor pack '${packId}' not found.`))
  }

  useEffect(load, [packId])

  if (error) return <div className="text-xs text-red-400 px-3 py-2">{error}</div>
  if (!vendor) return <div className="text-xs text-gray-500 px-3 py-2">Loading vendor pack…</div>

  const save = async () => {
    if (!vendor) return
    setSaving(true); setError("")
    try {
      // Dedupe competitor entries case-insensitively to keep the saved JSON
      // tidy; keep the first occurrence's casing so the user's intent shows
      // up verbatim on the prospect's Competitors Mentioned card.
      const seenCompetitor = new Set<string>()
      const cleanedCompetitors: string[] = []
      for (const raw of competitorRows) {
        const t = raw.trim()
        if (!t) continue
        const k = t.toLowerCase()
        if (seenCompetitor.has(k)) continue
        seenCompetitor.add(k)
        cleanedCompetitors.push(t)
      }

      const payload = {
        ...vendor,
        outreach_sender: senderName && senderEmail ? { name: senderName, email: senderEmail } : null,
        excluded_customers: excludedRows
          .filter(r => r.name.trim())
          .map(r => r.reason.trim() ? { name: r.name.trim(), reason: r.reason.trim() } : { name: r.name.trim() }),
        competitor_signals: cleanedCompetitors,
      }
      await api.updateVendorPack(packId, payload)
      setEditing(false)
      load()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 text-xs">
        <div>
          <div className="text-gray-500">Company</div>
          <div className="text-gray-200">{vendor.company_name}</div>
        </div>
        <div>
          <div className="text-gray-500">Parent / Portfolio</div>
          <div className="text-gray-200">{vendor.parent_company || "—"} {vendor.portfolio_group ? ` · ${vendor.portfolio_group}` : ""}</div>
        </div>
        <div>
          <div className="text-gray-500">HQ / years</div>
          <div className="text-gray-200">{vendor.headquarters || "—"}, {vendor.years_in_business || "—"}</div>
        </div>
        <div>
          <div className="text-gray-500">Verticals</div>
          <div className="text-gray-200">{(vendor.verticals ?? []).join(", ") || "—"}</div>
        </div>
      </div>

      <CollapsibleSection title={`Customer logos (${(vendor.customer_logos ?? []).length})`}>
        <div className="flex flex-wrap gap-2">
          {(vendor.customer_logos ?? []).map((l, i) => (
            <Badge key={i} className="bg-gray-800 text-gray-300 border-gray-700 text-[11px]">
              {l.name}{l.geography ? ` · ${l.geography}` : ""}
            </Badge>
          ))}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={`Outreach sender · From line on emails`} defaultOpen>
        {editing ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Sender name</label>
              <input value={senderName} onChange={e => setSenderName(e.target.value)} placeholder="The Acme Team"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Sender email</label>
              <input value={senderEmail} onChange={e => setSenderEmail(e.target.value)} placeholder="outreach@acme.com"
                className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500" />
            </div>
          </div>
        ) : (
          <div className="text-sm text-gray-300">
            {vendor.outreach_sender
              ? <span>{vendor.outreach_sender.name} &lt;{vendor.outreach_sender.email}&gt;</span>
              : <span className="text-gray-600">Not set — emails will use a fallback sender.</span>}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={`Excluded customers (${excludedRows.length}) · skip in discovery`} defaultOpen>
        {editing ? (
          <div className="space-y-2">
            {excludedRows.map((row, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input value={row.name} onChange={e => setExcludedRows(rs => rs.map((r, j) => j === i ? { ...r, name: e.target.value } : r))}
                  placeholder="Company name" className="col-span-5 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                <input value={row.reason} onChange={e => setExcludedRows(rs => rs.map((r, j) => j === i ? { ...r, reason: e.target.value } : r))}
                  placeholder="Reason (optional)" className="col-span-6 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                <button onClick={() => setExcludedRows(rs => rs.filter((_, j) => j !== i))}
                  className="col-span-1 text-gray-600 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <button onClick={() => setExcludedRows(rs => [...rs, { name: "", reason: "" }])}
              className="text-[10px] text-violet-400 hover:text-violet-300 flex items-center gap-1"><Plus className="w-3 h-3" /> Add exclusion</button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {excludedRows.length === 0 ? (
              <span className="text-xs text-gray-600">None — every prospect Claude finds will be saved.</span>
            ) : excludedRows.map((row, i) => (
              <Badge key={i} className="bg-amber-950/30 text-amber-300 border-amber-900/50 text-[11px]" title={row.reason}>
                {row.name}
              </Badge>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title={`Competitor signals (${competitorRows.length}) · flag when found on prospect site`} defaultOpen>
        <div className="text-[10px] text-gray-500 mb-2">
          Names listed here are case-insensitively matched against the text of each scraped prospect website. Matches surface on the prospect&apos;s Website Research tab under <span className="text-amber-400">Competitors mentioned</span>. The list is aggregated across every vendor pack targeting the same vertical.
        </div>
        {editing ? (
          <div className="space-y-2">
            {competitorRows.map((row, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input value={row} onChange={e => setCompetitorRows(rs => rs.map((r, j) => j === i ? e.target.value : r))}
                  placeholder="Competitor product or company name" className="col-span-11 px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded text-gray-300 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                <button onClick={() => setCompetitorRows(rs => rs.filter((_, j) => j !== i))}
                  className="col-span-1 text-gray-600 hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <button onClick={() => setCompetitorRows(rs => [...rs, ""])}
              className="text-[10px] text-violet-400 hover:text-violet-300 flex items-center gap-1"><Plus className="w-3 h-3" /> Add competitor</button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {competitorRows.length === 0 ? (
              <span className="text-xs text-gray-600">None — the agent won&apos;t flag any competitor mentions for this vendor.</span>
            ) : competitorRows.map((row, i) => (
              <Badge key={i} className="bg-amber-900/40 text-amber-300 border-amber-800/60 text-[11px]">
                {row}
              </Badge>
            ))}
          </div>
        )}
      </CollapsibleSection>

      {error && <div className="text-xs text-red-400 px-1">{error}</div>}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-800">
        {editing ? (
          <>
            <button onClick={() => { setEditing(false); load() }} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
            <Button onClick={save} disabled={saving} className="bg-violet-700 hover:bg-violet-600 disabled:opacity-50 text-xs h-8">
              {saving ? <><Save className="w-3 h-3 mr-1.5 animate-pulse" /> Saving…</> : <><Save className="w-3 h-3 mr-1.5" /> Save vendor</>}
            </Button>
          </>
        ) : (
          <Button onClick={() => setEditing(true)} variant="outline" className="border-gray-700 text-gray-400 hover:text-white text-xs h-8">
            <Pencil className="w-3 h-3 mr-1.5" /> Edit sender / exclusions / competitors
          </Button>
        )}
      </div>
    </div>
  )
}


// ── Product pack panel + editor ───────────────────────────────────────────────

type ProductDraft = {
  personas: import("@/lib/types").Pack["personas"]
  messaging_framework: import("@/lib/types").Pack["messaging_framework"]
  email_guidance: import("@/lib/types").Pack["email_guidance"]
}

function ProductPackPanel({ packId }: { packId: string }) {
  const [product, setProduct] = useState<import("@/lib/types").ProductPack | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [draft, setDraft] = useState<ProductDraft>({
    personas: {}, messaging_framework: { elevator_pitch: "", differentiators: [] }, email_guidance: { sequence_strategy: "", cta_progression: [], avoid: [] },
  })
  const [filling, setFilling] = useState<null | "personas" | "messaging" | "email_guidance">(null)

  const load = () => {
    api.getProductPack(packId).then(p => {
      setProduct(p)
      setDraft({
        personas: p.personas ?? {},
        messaging_framework: p.messaging_framework ?? { elevator_pitch: "", differentiators: [] },
        email_guidance: p.email_guidance ?? { sequence_strategy: "", cta_progression: [], avoid: [] },
      })
    }).catch(() => setError(`Product pack '${packId}' not found.`))
  }

  useEffect(load, [packId])

  if (error && !product) return <div className="text-xs text-red-400 px-3 py-2">{error}</div>
  if (!product) return <div className="text-xs text-gray-500 px-3 py-2">Loading product pack…</div>

  const aiFill = async (section: "personas" | "messaging" | "email_guidance") => {
    setFilling(section); setError("")
    try {
      const generated = await api.generatePackSection({
        section,
        vertical_id: product.vertical_id,
        vendor_id: product.vendor_id,
        product_id: product.pack_id,
      })
      setDraft(d => {
        if (section === "personas") return { ...d, personas: generated as ProductDraft["personas"] }
        if (section === "messaging") return { ...d, messaging_framework: generated as ProductDraft["messaging_framework"] }
        return { ...d, email_guidance: generated as ProductDraft["email_guidance"] }
      })
    } catch (e) {
      setError(`AI ${section} generation failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setFilling(null)
    }
  }

  const save = async () => {
    if (!product) return
    setSaving(true); setError("")
    try {
      const payload = {
        ...product,
        personas: draft.personas,
        messaging_framework: draft.messaging_framework,
        email_guidance: draft.email_guidance,
      }
      await api.updateProductPack(packId, payload)
      setEditing(false)
      load()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const personas = draft.personas ?? {}
  const messaging = draft.messaging_framework ?? { elevator_pitch: "", differentiators: [] }
  const emailG = draft.email_guidance ?? { sequence_strategy: "", cta_progression: [], avoid: [] }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 text-xs">
        <div>
          <div className="text-gray-500">Product</div>
          <div className="text-gray-200">{product.product_name}</div>
        </div>
        <div>
          <div className="text-gray-500">Vendor / Vertical</div>
          <div className="text-gray-200">{product.vendor_id} · {product.vertical_id}</div>
        </div>
      </div>

      {product.scope_summary && (
        <p className="text-xs text-gray-400 italic px-1">{product.scope_summary}</p>
      )}

      {(product.modules ?? []).length > 0 && (
        <CollapsibleSection title={`Modules (${product.modules?.length})`}>
          <ul className="text-xs text-gray-400 list-disc pl-5 space-y-1">
            {(product.modules ?? []).map((m, i) => <li key={i}>{m}</li>)}
          </ul>
        </CollapsibleSection>
      )}

      <CollapsibleSection title={`Buyer personas (${Object.keys(personas).length})`} defaultOpen>
        <div className="flex justify-end mb-2">
          {editing && (
            <button onClick={() => aiFill("personas")} disabled={filling !== null}
              className="text-[10px] text-sky-300 hover:text-sky-200 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
              <Wand2 className={cn("w-3 h-3", filling === "personas" && "animate-pulse")} />
              {filling === "personas" ? "Generating personas…" : "AI Auto-fill personas"}
            </button>
          )}
        </div>
        {Object.keys(personas).length === 0 ? (
          <div className="text-xs text-gray-600 italic">No personas yet — click AI Auto-fill or save edits with personas defined.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.entries(personas).map(([id, p]) => (
              <div key={id} className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
                <div className="text-xs font-semibold text-sky-300 capitalize">{id.replace(/_/g, " ")}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">{(p.titles ?? []).slice(0, 3).join(", ")}{(p.titles ?? []).length > 3 ? "…" : ""}</div>
                <div className="text-[11px] text-gray-400 mt-2 italic">{p.communication_style}</div>
                <ul className="mt-2 space-y-0.5 text-[11px] text-gray-300 list-disc pl-4">
                  {(p.value_props ?? []).slice(0, 3).map((v, i) => <li key={i}>{v}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Messaging framework" defaultOpen>
        <div className="flex justify-end mb-2">
          {editing && (
            <button onClick={() => aiFill("messaging")} disabled={filling !== null}
              className="text-[10px] text-sky-300 hover:text-sky-200 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
              <Wand2 className={cn("w-3 h-3", filling === "messaging" && "animate-pulse")} />
              {filling === "messaging" ? "Generating messaging…" : "AI Auto-fill messaging"}
            </button>
          )}
        </div>
        <div className="text-xs space-y-2">
          <div><span className="text-gray-500">Elevator pitch:</span> <span className="text-gray-300">{messaging.elevator_pitch || "—"}</span></div>
          {(messaging.differentiators ?? []).length > 0 && (
            <div>
              <div className="text-gray-500 mb-1">Differentiators</div>
              <ul className="list-disc pl-5 text-gray-300 space-y-0.5">
                {(messaging.differentiators ?? []).map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Email sequence guidance">
        <div className="flex justify-end mb-2">
          {editing && (
            <button onClick={() => aiFill("email_guidance")} disabled={filling !== null}
              className="text-[10px] text-sky-300 hover:text-sky-200 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
              <Wand2 className={cn("w-3 h-3", filling === "email_guidance" && "animate-pulse")} />
              {filling === "email_guidance" ? "Generating guidance…" : "AI Auto-fill email guidance"}
            </button>
          )}
        </div>
        <div className="text-xs space-y-2">
          <div><span className="text-gray-500">Strategy:</span> <span className="text-gray-300">{emailG.sequence_strategy || "—"}</span></div>
          {(emailG.cta_progression ?? []).length > 0 && (
            <div>
              <div className="text-gray-500 mb-1">CTA progression</div>
              <ol className="list-decimal pl-5 text-gray-300 space-y-0.5">
                {(emailG.cta_progression ?? []).map((c, i) => <li key={i}>{c}</li>)}
              </ol>
            </div>
          )}
          {(emailG.avoid ?? []).length > 0 && (
            <div>
              <div className="text-gray-500 mb-1">Avoid</div>
              <ul className="list-disc pl-5 text-gray-300 space-y-0.5">
                {(emailG.avoid ?? []).map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {error && <div className="text-xs text-red-400 px-1">{error}</div>}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-800">
        {editing ? (
          <>
            <button onClick={() => { setEditing(false); load() }} className="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
            <Button onClick={save} disabled={saving} className="bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-xs h-8">
              {saving ? <><Save className="w-3 h-3 mr-1.5 animate-pulse" /> Saving…</> : <><Save className="w-3 h-3 mr-1.5" /> Save product</>}
            </Button>
          </>
        ) : (
          <Button onClick={() => setEditing(true)} variant="outline" className="border-gray-700 text-gray-400 hover:text-white text-xs h-8">
            <Pencil className="w-3 h-3 mr-1.5" /> Edit + AI Auto-fill
          </Button>
        )}
      </div>
    </div>
  )
}


// ── Main page ─────────────────────────────────────────────────────────────────

export default function PacksPage() {
  const { vertical, setVertical } = useVertical()
  const [availablePacks, setAvailablePacks] = useState<string[]>([])
  // Initialise from global context so navigating back shows the correct pack
  const [activeVertical, setActiveVertical] = useState(vertical || "car_rental")
  const [activeRegional, setActiveRegional] = useState("us_en")
  const [switching, setSwitching] = useState(false)
  const [showBuilder, setShowBuilder] = useState(false)
  const [editingPackId, setEditingPackId] = useState<string | null>(null)
  const [editingPackData, setEditingPackData] = useState<(Pack & { pack_id: string }) | null>(null)

  // Vendor pack state — store full vendor objects so we can filter by `verticals`
  const [allVendors, setAllVendors] = useState<import("@/lib/types").VendorPack[]>([])
  const [activeVendor, setActiveVendor] = useState<string>("")

  // Product pack state — store full product objects so we can filter by vertical_id
  const [allProducts, setAllProducts] = useState<import("@/lib/types").ProductPack[]>([])
  const [activeProduct, setActiveProduct] = useState<string>("")

  // Regional pack state
  const [availableRegional, setAvailableRegional] = useState<string[]>(Object.keys(REGION_META))
  const [regionalLabels, setRegionalLabels] = useState<Record<string, { flag: string; label: string }>>(REGION_META)
  const [showRegionalBuilder, setShowRegionalBuilder] = useState(false)

  const PACK_ORDER = ["car_rental"]
  const sortPacks = (ids: string[]) => [
    ...PACK_ORDER.filter(id => ids.includes(id)),
    ...ids.filter(id => !PACK_ORDER.includes(id)).sort(),
  ]

  const loadRegional = (ids: string[]) => {
    setAvailableRegional(ids)
    ids.filter(id => !REGION_META[id]).forEach(id => {
      api.getRegionalPack(id).then(pack => {
        const p = pack as unknown as Record<string, unknown>
        setRegionalLabels(prev => ({ ...prev, [id]: { flag: "🌐", label: (p.display_name as string) || id } }))
      }).catch(() => {
        setRegionalLabels(prev => ({ ...prev, [id]: { flag: "🌐", label: id } }))
      })
    })
  }

  const loadVendorAndProductLabels = async (vendorIds: string[], productIds: string[]) => {
    // Fetch full vendor + product objects so the lists below the vertical picker
    // can filter by `verticals` / `vertical_id`.
    const [vendors, products] = await Promise.all([
      Promise.all(vendorIds.map(id => api.getVendorPack(id).catch(() => null))),
      Promise.all(productIds.map(id => api.getProductPack(id).catch(() => null))),
    ])
    const vendorPacks = vendors.filter((v): v is import("@/lib/types").VendorPack => v !== null)
    const productPacks = products.filter((p): p is import("@/lib/types").ProductPack => p !== null)
    setAllVendors(vendorPacks)
    setAllProducts(productPacks)
  }

  useEffect(() => {
    api.getPacks().then(r => {
      setAvailablePacks(sortPacks(r.vertical ?? []))
      loadRegional(r.regional ?? Object.keys(REGION_META))
      loadVendorAndProductLabels(r.vendor ?? [], r.product ?? [])
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refreshPacks = () => api.getPacks().then(r => {
    setAvailablePacks(sortPacks(r.vertical ?? []))
    loadRegional(r.regional ?? Object.keys(REGION_META))
    loadVendorAndProductLabels(r.vendor ?? [], r.product ?? [])
  })

  const switchVertical = (id: string) => {
    if (id === activeVertical) return
    setSwitching(true)
    setTimeout(() => {
      setActiveVertical(id)
      setVertical(id)          // sync global context
      setSwitching(false)
      setShowBuilder(false)
      setEditingPackId(null)
    }, 200)
  }

  // Also sync if context changes externally (e.g. from another page)
  useEffect(() => {
    if (vertical && vertical !== activeVertical) {
      setActiveVertical(vertical)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertical])

  // When the active vertical changes (or vendor/product data finishes loading),
  // make sure the active vendor + product are valid for this vertical. If not,
  // pick the first one that targets it. Empty string = "no selection" (Select stays controlled).
  useEffect(() => {
    if (allVendors.length === 0 && allProducts.length === 0) return
    const vendorsForVertical = allVendors.filter((v) => (v.verticals ?? []).includes(activeVertical))
    const productsForVertical = allProducts.filter((p) => p.vertical_id === activeVertical)

    setActiveVendor((prev) => {
      if (prev && vendorsForVertical.some((v) => v.pack_id === prev)) return prev
      return vendorsForVertical[0]?.pack_id ?? ""
    })
    setActiveProduct((prev) => {
      if (prev && productsForVertical.some((p) => p.pack_id === prev)) return prev
      return productsForVertical[0]?.pack_id ?? ""
    })
  }, [activeVertical, allVendors, allProducts])

  const handlePackSaved = (packId: string) => {
    setShowBuilder(false)
    setEditingPackId(null)
    setEditingPackData(null)
    refreshPacks()
    setTimeout(() => {
      setActiveVertical(packId)
      setVertical(packId)
    }, 100)
  }

  const handleRegionalSaved = (packId: string) => {
    setShowRegionalBuilder(false)
    refreshPacks()
    setTimeout(() => setActiveRegional(packId), 100)
  }

  const handleEditClick = async () => {
    const pack = await api.getVerticalPack(activeVertical) as Pack & { pack_id: string }
    pack.pack_id = activeVertical
    setEditingPackData(pack)
    setEditingPackId(activeVertical)
    setShowBuilder(false)
  }

  const isFormOpen = showBuilder || !!editingPackId
  const meta = getPackMeta(activeVertical)

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <Layers className="w-5 h-5 text-sky-400" />
          Pack Explorer
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Configure vertical and regional intelligence packs — swap to repurpose the entire AI SDR engine for any portfolio company
        </p>
      </div>

      {/* Vertical Pack Switcher */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" /> Vertical Pack — ICP, Personas & Messaging
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowBuilder(!showBuilder); setEditingPackId(null) }}
              className="border-gray-700 text-gray-400 hover:text-white hover:border-indigo-600 text-xs h-7"
            >
              {showBuilder ? <><X className="w-3 h-3 mr-1.5" /> Cancel</> : <><Plus className="w-3 h-3 mr-1.5" /> New Pack</>}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Pack buttons */}
          <div className="flex gap-3 mb-1 flex-wrap">
            {availablePacks.map((id) => {
              const m = getPackMeta(id)
              const VIcon = m.icon
              const active = activeVertical === id
              return (
                <button
                  key={id}
                  onClick={() => switchVertical(id)}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all duration-200",
                    active ? "border-gray-600 bg-gray-800 shadow-lg" : "border-gray-800 bg-gray-800/30 hover:border-gray-700"
                  )}
                  style={active ? { borderColor: `${m.color}50`, boxShadow: `0 0 20px ${m.color}15` } : {}}
                >
                  <div className="p-2 rounded-lg" style={{ backgroundColor: `${m.color}20` }}>
                    <VIcon className="w-5 h-5" style={{ color: m.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-white text-sm">{m.label || id}</div>
                    <div className="text-[11px] text-gray-500">{m.product}</div>
                  </div>
                  {active && (
                    <Badge className="text-[10px] border shrink-0" style={{ backgroundColor: `${m.color}20`, color: m.color, borderColor: `${m.color}40` }}>
                      Active
                    </Badge>
                  )}
                  {!BUILTIN_META[id] && (
                    <Badge className="text-[10px] border shrink-0 bg-indigo-900/30 text-indigo-400 border-indigo-800">
                      Custom
                    </Badge>
                  )}
                </button>
              )
            })}
          </div>

          {/* Portfolio reuse callout */}
          {activeVertical === "car_rental" && !isFormOpen && (
            <div className="flex items-center gap-2 mt-3 px-3 py-2 bg-violet-950/30 border border-violet-900/40 rounded-lg text-xs text-violet-300">
              <Car className="w-3.5 h-3.5 shrink-0" />
              Same AI pipeline, same regional packs — only the vertical intelligence changes. This is how a single engine scales across every vertical in the portfolio.
            </div>
          )}

          {/* New pack builder */}
          {showBuilder && (
            <div className="mt-4">
              <PackBuilder onSaved={handlePackSaved} onCancel={() => setShowBuilder(false)} />
            </div>
          )}

          {/* Edit pack form */}
          {editingPackId && editingPackData && (
            <div className="mt-4">
              <PackBuilder
                onSaved={handlePackSaved}
                onCancel={() => { setEditingPackId(null); setEditingPackData(null) }}
                editingPack={editingPackData}
                editingPackId={editingPackId}
              />
            </div>
          )}

          {/* Active pack detail */}
          {!isFormOpen && (
            <div className={cn("transition-opacity duration-200", switching ? "opacity-0" : "opacity-100")}>
              <VerticalPackPanel
                packId={activeVertical}
                active={!switching}
                onEdit={handleEditClick}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vendor Packs — filtered by the active vertical */}
      {(() => {
        const verticalVendors = allVendors.filter((v) => (v.verticals ?? []).includes(activeVertical))
        if (verticalVendors.length === 0) return null
        // If the active vendor is no longer valid for this vertical, the cards still render —
        // just show "no vendor selected" rather than auto-jumping (avoids fighting the user's clicks).
        const activeVendorIsValid = verticalVendors.some((v) => v.pack_id === activeVendor)
        return (
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5" /> Vendor Pack — Company facts, sender + customer exclusions
                <span className="ml-2 text-[10px] text-gray-500 normal-case font-normal">
                  · {verticalVendors.length} vendor{verticalVendors.length !== 1 ? "s" : ""} targeting {meta.label}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                {verticalVendors.map((v) => (
                  <button
                    key={v.pack_id}
                    onClick={() => { setActiveVendor(v.pack_id); setActiveProduct("") }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all",
                      activeVendor === v.pack_id ? "border-violet-700 bg-violet-950/30 text-white" : "border-gray-800 bg-gray-800/30 text-gray-400 hover:border-gray-700"
                    )}
                  >
                    <span className="text-xs">{v.display_name || v.company_name}</span>
                  </button>
                ))}
              </div>
              {activeVendorIsValid && <VendorPackPanel packId={activeVendor} />}
              {!activeVendorIsValid && (
                <div className="text-xs text-gray-600 italic">Pick a vendor above to view its company details, sender, and exclusion list.</div>
              )}
            </CardContent>
          </Card>
        )
      })()}

      {/* Product Packs — filtered by the active vertical, grouped by vendor */}
      {(() => {
        const verticalProducts = allProducts.filter((p) => p.vertical_id === activeVertical)
        if (verticalProducts.length === 0) return null
        // Group products by vendor for clarity. Vendors that target this vertical determine the order.
        const vendorsForVertical = allVendors.filter((v) => (v.verticals ?? []).includes(activeVertical))
        const grouped: { vendor: import("@/lib/types").VendorPack | null; products: import("@/lib/types").ProductPack[] }[] =
          vendorsForVertical.map((v) => ({
            vendor: v,
            products: verticalProducts.filter((p) => p.vendor_id === v.pack_id),
          })).filter((g) => g.products.length > 0)
        // Anything orphaned (product whose vendor isn't in this vertical, shouldn't happen) goes in a stray bucket.
        const grouped_ids = new Set(grouped.flatMap((g) => g.products.map((p) => p.pack_id)))
        const orphans = verticalProducts.filter((p) => !grouped_ids.has(p.pack_id))
        if (orphans.length > 0) grouped.push({ vendor: null, products: orphans })

        const activeProductIsValid = verticalProducts.some((p) => p.pack_id === activeProduct)
        return (
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" /> Product Pack — Personas, Messaging & Email Guidance
                <span className="ml-2 text-[10px] text-gray-500 normal-case font-normal">
                  · {verticalProducts.length} product{verticalProducts.length !== 1 ? "s" : ""} for {meta.label}
                </span>
                <span className="ml-2 text-[10px] text-sky-300 normal-case font-normal flex items-center gap-1">
                  <Wand2 className="w-3 h-3" /> AI Auto-fill available
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Grouped product picker — vendor heading + their product chips on the same row */}
              <div className="space-y-2">
                {grouped.map((g) => (
                  <div key={g.vendor?.pack_id ?? "orphans"} className="flex items-center gap-3 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium min-w-[6rem] shrink-0">
                      {g.vendor ? (g.vendor.display_name || g.vendor.company_name) : "Other"}
                    </span>
                    <div className="flex gap-2 flex-wrap">
                      {g.products.map((p) => (
                        <button
                          key={p.pack_id}
                          onClick={() => setActiveProduct(p.pack_id)}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all",
                            activeProduct === p.pack_id ? "border-sky-700 bg-sky-950/30 text-white" : "border-gray-800 bg-gray-800/30 text-gray-400 hover:border-gray-700"
                          )}
                        >
                          <span className="text-xs">{p.product_name || p.display_name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {activeProductIsValid && <ProductPackPanel packId={activeProduct} />}
              {!activeProductIsValid && (
                <div className="text-xs text-gray-600 italic">Pick a product above to view its personas, messaging, and email guidance.</div>
              )}
            </CardContent>
          </Card>
        )
      })()}

      {/* Regional Packs */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" /> Regional Pack — Tone, Scheduling & Compliance
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowRegionalBuilder(v => !v)}
              className="border-gray-700 text-gray-400 hover:text-white hover:border-sky-600 text-xs h-7"
            >
              {showRegionalBuilder ? <><X className="w-3 h-3 mr-1.5" /> Cancel</> : <><Plus className="w-3 h-3 mr-1.5" /> New Pack</>}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            {availableRegional.map(id => {
              const m = regionalLabels[id] ?? { flag: "🌐", label: id }
              return (
                <button
                  key={id}
                  onClick={() => { setActiveRegional(id); setShowRegionalBuilder(false) }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all",
                    activeRegional === id ? "border-sky-700 bg-sky-950/30 text-white" : "border-gray-800 bg-gray-800/30 text-gray-400 hover:border-gray-700"
                  )}
                >
                  <span>{m.flag}</span>
                  <span className="text-xs">{m.label}</span>
                </button>
              )
            })}
          </div>
          {showRegionalBuilder
            ? <RegionalPackBuilder onSaved={handleRegionalSaved} onCancel={() => setShowRegionalBuilder(false)} />
            : <RegionalPackPanel packId={activeRegional} />
          }
        </CardContent>
      </Card>

      {/* Architecture note */}
      <Card className="bg-gray-900/50 border-gray-800/50">
        <CardContent className="p-4">
          <div className="flex gap-3">
            <ArrowLeftRight className="w-4 h-4 text-sky-400 mt-0.5 shrink-0" />
            <div className="text-xs text-gray-500 space-y-1">
              <p className="text-gray-300 font-medium">How the pack system works</p>
              <p>Vertical packs define <span className="text-gray-300">WHO to target</span> (ICP criteria + scoring weights), <span className="text-gray-300">HOW to speak to them</span> (personas + value props), and <span className="text-gray-300">WHAT to say</span> (messaging framework + email guidance).</p>
              <p>Regional packs define <span className="text-gray-300">WHERE and WHEN</span> to reach them — tone calibration, scheduling constraints, public holiday awareness, and jurisdiction-specific compliance language.</p>
              <p>All four AI agents (Prospector → Researcher → Copywriter → Classifier) read from both packs at runtime. <span className="text-gray-300">Swapping a pack changes every AI output without touching agent code</span> — this is how the same engine runs every vertical in the portfolio.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
