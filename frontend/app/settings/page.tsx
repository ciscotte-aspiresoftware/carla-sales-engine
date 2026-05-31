"use client"

/**
 * Settings page — engine-wide configuration hub.
 *
 * Sections:
 *   1. API Keys & Integrations — DB-encrypted; takes effect at runtime.
 *   2. Branding / app identity — display name, parent org, default vertical.
 *   3. Display preferences — theme, currency.
 *   4. Demo / data controls — DB stats, reset demo, links to deeper pages.
 *
 * The page is a hub: deeper LLM-model and Guardrails settings link to their
 * existing pages rather than being duplicated here, to avoid drift.
 */

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { api } from "@/lib/api"
import type { AppSettingEntry } from "@/lib/types"
import { useTheme } from "@/components/ThemeProvider"
import { useVertical } from "@/lib/vertical-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Settings as SettingsIcon, Key, Palette, Sliders, Database,
  ShieldCheck, Coins, ChevronRight, ExternalLink, Send, Clock,
  Check, AlertCircle, X, Pencil, RotateCcw, Eye, EyeOff,
  Sun, Moon, Trash2, Save,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ── Section metadata ──────────────────────────────────────────────────────────

const CATEGORY_META: Record<string, { label: string; description: string; icon: React.ElementType }> = {
  api_keys: {
    label: "API Keys & Integrations",
    description: "Stored encrypted in the database. Take effect immediately — no backend restart required. Falls back to .env values when unset here.",
    icon: Key,
  },
  channels: {
    label: "Channels",
    description: "Outbound channels (email, voice, SMS, LinkedIn) and CRM sync. Providers ship as stubs; configuring keys here advertises the capability and prepares the registry — actual sending is wired per docs/integrations/.",
    icon: Send,
  },
  schedule: {
    label: "Schedule",
    description: "Cadence + business-hour defaults consumed by the in-process APScheduler. Per-campaign auto_send + cadence overrides live on the campaign itself.",
    icon: Clock,
  },
  branding: {
    label: "Branding & App Identity",
    description: "Display name, parent organisation, default vertical. Override the engine's defaults for your portfolio company.",
    icon: Palette,
  },
  display: {
    label: "Display Preferences",
    description: "Theme and default currency. Currency seeds the Costs page on first load.",
    icon: Sliders,
  },
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { isDark, toggle: toggleTheme } = useTheme()
  const { availableVerticals } = useVertical()

  const [items, setItems] = useState<AppSettingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>("")

  // Per-row edit state — only one row in edit mode at a time.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)

  // Demo controls
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const refresh = async () => {
    setLoading(true); setError("")
    try {
      const r = await api.getAppSettings()
      setItems(r.settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  // Group by category in a stable order (api_keys first, then branding, then display)
  const grouped = useMemo(() => {
    const order = ["api_keys", "channels", "schedule", "branding", "display"]
    const buckets = new Map<string, AppSettingEntry[]>()
    for (const k of order) buckets.set(k, [])
    for (const it of items) {
      const bucket = buckets.get(it.category) ?? buckets.set(it.category, []).get(it.category)!
      bucket.push(it)
    }
    return Array.from(buckets.entries()).filter(([_, v]) => v.length > 0)
  }, [items])

  const beginEdit = (item: AppSettingEntry) => {
    setEditingKey(item.key)
    // Don't pre-fill secrets — user must type fresh. Branding rows pre-fill the
    // current value for convenience.
    setEditValue(item.is_secret ? "" : (item.source === "db" ? item.value_preview : ""))
    setReveal(false)
  }

  const cancelEdit = () => {
    setEditingKey(null); setEditValue(""); setReveal(false)
  }

  const saveEdit = async (key: string) => {
    if (!editValue.trim()) return
    setSaving(true); setError("")
    try {
      const r = await api.setAppSetting(key, editValue)
      setItems(r.settings)
      cancelEdit()
    } catch (e) {
      setError(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const clearOverride = async (key: string) => {
    setSaving(true); setError("")
    try {
      const r = await api.deleteAppSetting(key)
      setItems(r.settings)
    } catch (e) {
      setError(`Clear failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); return }
    setResetting(true)
    try {
      await api.resetDemo()
      setConfirmReset(false)
    } catch (e) {
      setError(`Reset failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gray-800/60 border border-gray-700/50 flex items-center justify-center">
          <SettingsIcon className="w-5 h-5 text-gray-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Engine-wide configuration. API keys are stored encrypted in the database.
          </p>
        </div>
      </div>

      {error && (
        <Card className="bg-red-950/20 border-red-900/40">
          <CardContent className="p-3 flex items-start gap-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </CardContent>
        </Card>
      )}

      {/* Quick links — Models + Guardrails live on existing pages */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Link href="/costs" className="group">
          <Card className="bg-gray-900 border-gray-800 hover:border-gray-700 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <Coins className="w-5 h-5 text-amber-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-white">Models & Costs</div>
                <div className="text-xs text-gray-500">Active model, per-step overrides, spend</div>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400" />
            </CardContent>
          </Card>
        </Link>
        <Link href="/guardrails" className="group">
          <Card className="bg-gray-900 border-gray-800 hover:border-gray-700 transition-colors">
            <CardContent className="p-4 flex items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
              <div className="flex-1">
                <div className="text-sm font-medium text-white">Guardrails</div>
                <div className="text-xs text-gray-500">Compliance rules baked into every prompt</div>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400" />
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* Settings sections */}
      {loading && items.length === 0 ? (
        <Skeleton className="h-72 bg-gray-900" />
      ) : (
        grouped.map(([category, rows]) => {
          const meta = CATEGORY_META[category]
          if (!meta) return null
          const Icon = meta.icon
          return (
            <Card key={category} className="bg-gray-900 border-gray-800">
              <CardHeader className="pb-3">
                <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5" />
                  {meta.label}
                  <span className="text-[10px] text-gray-600 normal-case font-normal ml-2">· {meta.description}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-gray-800/60">
                  {rows.map((item) => {
                    const isEditing = editingKey === item.key
                    const canClear = item.source === "db"
                    return (
                      <div key={item.key} className="px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-200">{item.label}</span>
                              <SourceChip source={item.source} configured={item.configured} />
                            </div>
                            <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{item.description}</div>
                            {item.env_var && (
                              <div className="text-[10px] text-gray-600 font-mono mt-1">
                                env var: {item.env_var}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 flex items-center gap-2">
                            {!isEditing && (
                              <span className={cn(
                                "text-xs font-mono px-2 py-1 rounded border max-w-[18rem] truncate",
                                item.configured
                                  ? "bg-gray-800/60 border-gray-700 text-gray-300"
                                  : "bg-transparent border-dashed border-gray-700 text-gray-600 italic"
                              )} title={item.value_preview || "not set"}>
                                {item.value_preview || "not set"}
                              </span>
                            )}
                            {!isEditing ? (
                              <>
                                <Button
                                  variant="ghost" size="sm"
                                  onClick={() => beginEdit(item)}
                                  className="h-7 px-2 text-xs text-gray-400 hover:text-violet-300"
                                >
                                  <Pencil className="w-3 h-3 mr-1" />
                                  {item.source === "db" ? "Edit" : "Set"}
                                </Button>
                                {canClear && (
                                  <Button
                                    variant="ghost" size="sm"
                                    onClick={() => clearOverride(item.key)}
                                    disabled={saving}
                                    className="h-7 px-2 text-xs text-gray-500 hover:text-amber-400"
                                    title="Clear DB override; revert to .env value"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                  </Button>
                                )}
                              </>
                            ) : null}
                          </div>
                        </div>
                        {isEditing && (
                          <div className="mt-3 flex items-center gap-2">
                            <input
                              autoFocus
                              type={item.is_secret && !reveal ? "password" : "text"}
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEdit(item.key)
                                if (e.key === "Escape") cancelEdit()
                              }}
                              placeholder={item.placeholder || (item.is_secret ? "paste new value" : "")}
                              className="flex-1 px-3 py-1.5 text-sm bg-gray-800 border border-violet-700 rounded text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500"
                            />
                            {item.is_secret && (
                              <button
                                onClick={() => setReveal(!reveal)}
                                className="text-gray-500 hover:text-gray-300 p-1.5"
                                title={reveal ? "Hide" : "Reveal"}
                              >
                                {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            )}
                            <Button
                              size="sm"
                              onClick={() => saveEdit(item.key)}
                              disabled={saving || !editValue.trim()}
                              className="h-8 bg-violet-700 hover:bg-violet-600 disabled:opacity-40 text-xs"
                            >
                              <Save className="w-3 h-3 mr-1" />
                              {saving ? "Saving…" : "Save"}
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              onClick={cancelEdit}
                              className="h-8 text-gray-500 hover:text-gray-300 text-xs"
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        )}
                        {/* Special: default_vertical shows a dropdown of available pack ids inline */}
                        {item.key === "default_vertical" && !isEditing && availableVerticals.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {availableVerticals.map((v) => (
                              <button
                                key={v.id}
                                onClick={() => api.setAppSetting("default_vertical", v.id).then((r) => setItems(r.settings))}
                                className={cn(
                                  "text-[10px] px-1.5 py-0.5 rounded border",
                                  item.value_preview === v.id
                                    ? "bg-violet-950/40 text-violet-300 border-violet-800/60"
                                    : "bg-gray-800/40 text-gray-500 border-gray-700 hover:text-gray-300"
                                )}
                              >
                                {v.id}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )
        })
      )}

      {/* Display preferences — theme toggle isn't backend-stored; lives in client state */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5" />
            Theme (this browser)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-200">Colour scheme</div>
              <div className="text-[11px] text-gray-500 mt-0.5">Persisted to localStorage; affects this browser only.</div>
            </div>
            <Button onClick={toggleTheme} variant="outline" size="sm" className="border-gray-700 text-gray-300">
              {isDark ? <Sun className="w-3.5 h-3.5 mr-1.5" /> : <Moon className="w-3.5 h-3.5 mr-1.5" />}
              {isDark ? "Light mode" : "Dark mode"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Demo / data controls */}
      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5" />
            Demo data
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-sm font-medium text-gray-200">Reset demo</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Wipes campaigns, sequences, activity events, and AI research profiles. Prospects are preserved (their
              vertical / business_name / capacity_count stay). Engagement counters return to zero.
            </div>
          </div>
          <Button
            onClick={handleReset}
            disabled={resetting}
            variant="outline"
            className={cn(
              "border-amber-800/60 text-amber-300 hover:bg-amber-950/40 disabled:opacity-40",
              confirmReset && "border-red-700 text-red-300 hover:bg-red-950/40"
            )}
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            {resetting ? "Resetting…" : confirmReset ? "Click again to confirm" : "Reset demo"}
          </Button>
        </CardContent>
      </Card>

      {/* External docs link */}
      <Card className="bg-gray-900/50 border-gray-800">
        <CardContent className="p-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5 text-gray-400 font-medium uppercase tracking-wider mb-1">
            <ExternalLink className="w-3 h-3" />
            More
          </div>
          <p>
            Adding a new integration? See <code className="text-gray-300">docs/integrations/</code> for design docs covering
            Tavily, Apollo, Firecrawl, SendGrid, Salesforce, and Inbound — each with the exact hook points, env config, and
            verification steps.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function SourceChip({ source, configured }: { source: AppSettingEntry["source"]; configured: boolean }) {
  if (source === "db") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-950/40 text-violet-300 border border-violet-800/60 inline-flex items-center gap-1">
        <Check className="w-2.5 h-2.5" /> DB override
      </span>
    )
  }
  if (source === "env") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-800/60 inline-flex items-center gap-1">
        <Check className="w-2.5 h-2.5" /> .env
      </span>
    )
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700 inline-flex items-center gap-1">
      not set
    </span>
  )
}
