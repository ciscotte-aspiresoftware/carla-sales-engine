"use client"

import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ShieldCheck, Plus, Trash2, Save, Info } from "lucide-react"

export default function GuardrailsPage() {
  const [rules, setRules] = useState<string[]>([])
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getGuardrails()
      .then((g) => { setRules(g.rules); setNotes(g.notes) })
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    await api.updateGuardrails(rules.filter((r) => r.trim()), notes)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const updateRule = (i: number, val: string) => setRules((r) => r.map((x, j) => j === i ? val : x))
  const removeRule = (i: number) => setRules((r) => r.filter((_, j) => j !== i))
  const addRule = () => setRules((r) => [...r, ""])

  return (
    <div className="p-6 space-y-5 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-white flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-sky-400" />
          Guardrails
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Rules injected into every AI agent prompt. Changes apply on the next pipeline run.
        </p>
      </div>

      <Card className="bg-sky-950/20 border-sky-900/40">
        <CardContent className="p-4 flex gap-3 text-xs text-sky-300">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            These rules are appended to every agent system prompt as hard constraints.
            Use them to enforce tone, style, and compliance requirements across all generated copy.
            Examples: no em dashes, max word count, forbidden phrases, required sign-offs.
          </span>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 bg-gray-800 rounded" />)}
        </div>
      ) : (
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Active Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {rules.length === 0 && (
              <p className="text-sm text-gray-600 py-2">No rules yet. Add one below.</p>
            )}
            {rules.map((rule, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="w-5 h-5 rounded bg-sky-900/40 border border-sky-800/50 flex items-center justify-center shrink-0 mt-2">
                  <ShieldCheck className="w-3 h-3 text-sky-400" />
                </div>
                <input
                  value={rule}
                  onChange={(e) => updateRule(i, e.target.value)}
                  placeholder="e.g. Never use em dashes (—) in any output"
                  className="flex-1 px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
                <button
                  onClick={() => removeRule(i)}
                  className="mt-2 text-gray-600 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}

            <button
              onClick={addRule}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-sky-400 transition-colors mt-1 pt-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add rule
            </button>
          </CardContent>
        </Card>
      )}

      <Card className="bg-gray-900 border-gray-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs text-gray-500 uppercase tracking-wider">Internal Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Optional notes about why these guardrails exist..."
            className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-400 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving || loading} className="bg-sky-600 hover:bg-sky-500">
          <Save className="w-4 h-4 mr-1.5" />
          {saving ? "Saving..." : "Save Guardrails"}
        </Button>
        {saved && <span className="text-xs text-emerald-400">Saved. Active on next pipeline run.</span>}
      </div>
    </div>
  )
}
