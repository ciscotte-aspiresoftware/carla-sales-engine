// /icp - manage ICP definitions (Ideal Customer Profile).
//
// CRUD over /api/icps. The list view is the landing page; clicking an
// ICP opens an editor in a side panel. "New ICP" opens the same panel
// with empty fields. The same shape backs the Coverage page's seed
// pipeline, so editing one entry immediately changes what the next
// "Seed cells" run targets.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Plus, Save, Trash2, Sparkles, X, Check } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/context/workspace-context'
import { API_BASE } from '@/lib/api-base'
import { safeFetchJson } from '@/lib/safe-fetch'
import { ReclassifyTab, type TargetsResponse } from '@/components/icp/reclassify-tab'

interface Coverage {
  urban: boolean      // pop ≥ 50k
  suburban: boolean   // pop 5k–50k
  rural: boolean      // pop 1k–5k + sparse hex backstop
  airports: boolean   // major airports as anchor cells
}

interface Icp {
  id: string
  name: string
  vertical: string
  // Which Valsoft portfolio company this ICP feeds. Optional. Lets a
  // single company (e.g. NedFox) own multiple niche-tuned ICPs across
  // different verticals (Garden Centre + Thrift Store + Camping) while
  // sharing a single sales-team identity at the top level.
  portfolioCompany?: string
  // Internal country codes (UK, NL, IE, BE, etc.) the ICP operates in.
  // Multi-value because a single ICP often spans countries (NedFox sells
  // into NL + UK + IE + BE). Used as a filter dimension and rendered as
  // chips in the form. Matches keys in api/utils/countries.js.
  countries?: string[]
  searchTerms: string[]
  // Per-country search-term overrides. Optional. Shape:
  //   { 'NL': ['tuincentrum', ...], 'UK': ['garden centre', ...] }
  // When present and the cell's country has an entry, the sweep uses that
  // list instead of the flat `searchTerms` above. Lets a multi-country ICP
  // run language-correct queries per market.
  searchTermsByCountry?: Record<string, string[]>
  // Per-city search-term overrides. Keys are city names (case-insensitive
  // match at sweep time). Used for "outlier" cities - the city sits in a
  // country that isn't ticked in `countries` and the user picked
  // "Berlin-only terms" rather than ticking the whole country (which would
  // also trigger Tier-2 country-fill). Highest precedence in the sweep:
  // cityTerms beats searchTermsByCountry beats flat searchTerms.
  cityTerms?: Record<string, string[]>
  cities: string[]
  coverage: Coverage
  // Structured classifier criteria. The backend composes these into
  // classifyPrompt on save - users normally edit these fields rather than
  // the raw prompt. Empty/missing for legacy ICPs that only have the
  // freehand classifyPrompt; the form treats them as empty strings/arrays.
  targetDescription?: string
  customerTypes?: string[]
  excludeTypes?: string[]
  excludeCompanies?: string[]
  extraNotes?: string
  classifyPrompt: string
  // When true the classifyPrompt is treated as a hand-written override:
  // the structured criteria are still persisted but ignored at sweep
  // time, and the prompt is sent to GPT verbatim. Lets advanced users
  // depart from the "Is this X serving Y? Skip Z." template entirely.
  useCustomPrompt?: boolean
  // Markdown report toggle + template. When reportEnabled, the sweep
  // generates a per-company markdown brief (matched → full report following
  // reportTemplate, rejected → short why-rejected). The template is the
  // operator's own markdown - sections named whatever they want.
  reportEnabled?: boolean
  reportTemplate?: string
  // When ON, the sweep cross-references Apollo (search-only) for people at
  // every is_match company: people found are attached as leads so the Accounts
  // pending lane arrives pre-populated; companies with no Apollo people are
  // auto-rejected. Spends Apollo search credits per qualified company.
  autoAssociateLeads?: boolean
}

const API = API_BASE

// Starter report template, pre-filled when the operator first enables
// reports. Mirrors the backend DEFAULT_REPORT_TEMPLATE. Fully editable -
// rename, add, or remove sections freely.
const DEFAULT_REPORT_TEMPLATE = `## Overview
A 2-3 sentence summary of what this business does.

## Products & Services
What they sell or offer, and any specialties or niche focus.

## Size & Scale
Indicators of size - number of locations, staff, years in business, anything the site reveals.

## Fit for this ICP
Why this company is a strong fit for our product, grounded in what the website actually shows.

## Notable Signals
Anything else worth flagging - recent news, expansion, ownership, technology hints, partnerships.`

const DEFAULT_COVERAGE: Coverage = {
  urban: true,
  suburban: false,
  rural: false,
  airports: true,
}

// Per-country styling for the per-country search-terms cards. Each entry is
// a small tailwind palette so each country's section is visually distinct at
// a glance (matches the spec - "each company should have a colored highlight/
// card so we know exactly where it is"). Falls back to slate for unknown
// codes, which keeps the layout sane if a new country code is added.
const COUNTRY_STYLE: Record<string, { border: string; bg: string; chip: string; label: string }> = {
  NL: { border: 'border-orange-500/50', bg: 'bg-orange-500/5',  chip: 'bg-orange-500/15 text-orange-700 dark:text-orange-300', label: 'Netherlands' },
  UK: { border: 'border-sky-500/50',    bg: 'bg-sky-500/5',     chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',          label: 'United Kingdom' },
  IE: { border: 'border-emerald-500/50',bg: 'bg-emerald-500/5', chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', label: 'Ireland' },
  BE: { border: 'border-amber-500/50',  bg: 'bg-amber-500/5',   chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',    label: 'Belgium' },
  US: { border: 'border-red-500/50',    bg: 'bg-red-500/5',     chip: 'bg-red-500/15 text-red-700 dark:text-red-300',          label: 'United States' },
  DE: { border: 'border-slate-500/50',  bg: 'bg-slate-500/5',   chip: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',    label: 'Germany' },
  FR: { border: 'border-indigo-500/50', bg: 'bg-indigo-500/5',  chip: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300', label: 'France' },
  ES: { border: 'border-rose-500/50',   bg: 'bg-rose-500/5',    chip: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',       label: 'Spain' },
  IT: { border: 'border-violet-500/50', bg: 'bg-violet-500/5',  chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', label: 'Italy' },
  AU: { border: 'border-cyan-500/50',   bg: 'bg-cyan-500/5',    chip: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',       label: 'Australia' },
  CA: { border: 'border-pink-500/50',   bg: 'bg-pink-500/5',    chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',       label: 'Canada' },
  PT: { border: 'border-lime-500/50',   bg: 'bg-lime-500/5',    chip: 'bg-lime-500/15 text-lime-700 dark:text-lime-300',       label: 'Portugal' },
}
const DEFAULT_COUNTRY_STYLE = { border: 'border-border', bg: 'bg-muted/20', chip: 'bg-muted text-foreground', label: '' }

const EMPTY_ICP: Icp = {
  id: '',
  name: '',
  vertical: '',
  portfolioCompany: '',
  countries: [],
  searchTerms: [''],
  cities: [''],
  coverage: { ...DEFAULT_COVERAGE },
  targetDescription: '',
  customerTypes: [''],
  excludeTypes: [''],
  excludeCompanies: [''],
  extraNotes: '',
  classifyPrompt: '',
  useCustomPrompt: false,
  reportEnabled: false,
  reportTemplate: '',
  autoAssociateLeads: false,
}

export default function IcpPage() {
  // Workspace pick from the sidebar - when set, the ICP list scopes down
  // to just that portfolio company's ICPs. "All Companies" (workspace = '')
  // shows everything. New ICPs created while a workspace is active get
  // the workspace pre-filled as their portfolioCompany so the user
  // doesn't have to retype it every time.
  const { workspace } = useWorkspace()
  const [icps, setIcps] = useState<Icp[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // null = no edit panel; an Icp object = editing/creating that one.
  // `isNew` distinguishes "create" (POST) from "edit" (PUT).
  const [editing, setEditing] = useState<Icp | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [saving, setSaving] = useState(false)
  // Bumps once on each successful save. The Editor watches this so it can
  // re-snap its definition-baseline (clears the "unsaved edits" indicator)
  // AND re-fetch reclassify-targets (the freshly-saved definition has a new
  // hash, so previously-fresh classifications are now stale on the server).
  // Without this counter, the only way to refresh state after save was to
  // close + reopen the editor - the demo bug we're actually fixing.
  const [savedSignal, setSavedSignal] = useState(0)
  // Briefly toggled true after a successful save so the editor can flash
  // "Saved" feedback. Cleared by a 2-second timer.
  const [justSaved, setJustSaved] = useState(false)

  // ICPs visible after workspace scoping. The full list stays in `icps`
  // so we can still surface things like "siblings under the same portfolio
  // company" inside the editor; this is the user-facing card list.
  const visibleIcps = useMemo(() => {
    if (!workspace) return icps
    const w = workspace.toLowerCase()
    return icps.filter((i) => (i.portfolioCompany || '').toLowerCase() === w)
  }, [icps, workspace])

  // Distinct portfolio companies in use today, derived from the full ICP
  // list. Feeds the editor's portfolio-company dropdown so a user picks
  // an existing company instead of risking a typo (which would silently
  // create a phantom workspace). The dropdown still has an "add new"
  // path for genuinely new portfolio companies.
  const portfolioCompanies = useMemo(() => {
    const set = new Set<string>()
    for (const i of icps) {
      if (i.portfolioCompany && i.portfolioCompany.trim()) set.add(i.portfolioCompany.trim())
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [icps])

  const fetchAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}/api/icps`).then((r) => r.json())
      if (!res.success) throw new Error(res.error || 'failed to load')
      setIcps(res.icps || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAll() }, [])

  const handleNew = () => {
    // Pre-fill portfolioCompany from the active workspace so a user in
    // "NedFox" mode doesn't have to retype it for every new sub-ICP.
    // Empty when in "All Companies" - the user picks one in the form.
    setEditing({ ...EMPTY_ICP, portfolioCompany: workspace || '' })
    setIsNew(true)
  }
  const handleEdit = (icp: Icp) => {
    // Backfill coverage for ICPs persisted before the field existed.
    // Server-side validation does the same fallback, but doing it here
    // means the UI never has to deal with `undefined` coverage.
    const coverage = icp.coverage || DEFAULT_COVERAGE
    // Backfill structured criteria fields too - older ICPs only have
    // classifyPrompt. Hydrate the array fields with a single empty entry
    // so the "add another" UX renders an editable input on first edit.
    setEditing({
      ...icp,
      searchTerms: [...icp.searchTerms],
      // Clone cityTerms / searchTermsByCountry so editor edits don't mutate
      // the list-cache record in place (would make the list rail stale).
      searchTermsByCountry: icp.searchTermsByCountry
        ? Object.fromEntries(Object.entries(icp.searchTermsByCountry).map(([k, v]) => [k, [...v]]))
        : undefined,
      cityTerms: icp.cityTerms
        ? Object.fromEntries(Object.entries(icp.cityTerms).map(([k, v]) => [k, [...v]]))
        : undefined,
      cities: [...icp.cities],
      coverage: { ...coverage },
      portfolioCompany: icp.portfolioCompany || '',
      countries: Array.isArray(icp.countries) ? [...icp.countries] : [],
      targetDescription: icp.targetDescription || '',
      customerTypes: icp.customerTypes && icp.customerTypes.length > 0 ? [...icp.customerTypes] : [''],
      excludeTypes: icp.excludeTypes && icp.excludeTypes.length > 0 ? [...icp.excludeTypes] : [''],
      excludeCompanies: icp.excludeCompanies && icp.excludeCompanies.length > 0 ? [...icp.excludeCompanies] : [''],
      extraNotes: icp.extraNotes || '',
      useCustomPrompt: !!icp.useCustomPrompt,
      reportEnabled: !!icp.reportEnabled,
      reportTemplate: icp.reportTemplate || '',
      autoAssociateLeads: !!icp.autoAssociateLeads,
    })
    setIsNew(false)
  }
  const handleClose = () => {
    setEditing(null)
    setIsNew(false)
  }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    setError(null)
    try {
      // Drop empty entries from the array fields before sending - the
      // form keeps a trailing empty input for "add another" UX, that
      // shouldn't end up in the persisted ICP. Same treatment for the new
      // structured-criteria array fields (customerTypes, excludeTypes,
      // excludeCompanies).
      // Per-country search-terms map. Trim each list, drop empty strings,
      // drop empty countries entirely. Null when nothing usable - the
      // backend then sticks with the flat searchTerms list.
      const stbcRaw = editing.searchTermsByCountry || {}
      const stbcClean: Record<string, string[]> = {}
      for (const [cc, terms] of Object.entries(stbcRaw)) {
        const list = (Array.isArray(terms) ? terms : []).map((s) => String(s).trim()).filter(Boolean)
        if (list.length > 0) stbcClean[cc.toUpperCase()] = list
      }
      // Per-city overrides - same shape as the country map but city-keyed.
      // Drop empty cities and trim whitespace; null when nothing usable so
      // the backend column stays NULL.
      const ctRaw = editing.cityTerms || {}
      const ctClean: Record<string, string[]> = {}
      for (const [city, terms] of Object.entries(ctRaw)) {
        const list = (Array.isArray(terms) ? terms : []).map((s) => String(s).trim()).filter(Boolean)
        const name = String(city).trim()
        if (name && list.length > 0) ctClean[name] = list
      }
      const payload = {
        ...editing,
        searchTerms: editing.searchTerms.map(s => s.trim()).filter(Boolean),
        searchTermsByCountry: Object.keys(stbcClean).length > 0 ? stbcClean : null,
        cityTerms: Object.keys(ctClean).length > 0 ? ctClean : null,
        cities: editing.cities.map(c => c.trim()).filter(Boolean),
        customerTypes: (editing.customerTypes || []).map(s => s.trim()).filter(Boolean),
        excludeTypes: (editing.excludeTypes || []).map(s => s.trim()).filter(Boolean),
        excludeCompanies: (editing.excludeCompanies || []).map(s => s.trim()).filter(Boolean),
      }
      const url = isNew ? `${API}/api/icps` : `${API}/api/icps/${encodeURIComponent(editing.id)}`
      const method = isNew ? 'POST' : 'PUT'
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json())
      if (!res.success) throw new Error(res.error || 'save failed')
      await fetchAll()
      // Keep the editor open: re-sync `editing` to the just-saved record
      // (server may have normalized fields) instead of closing. Bumps the
      // savedSignal counter so the Editor re-baselines + refreshes its
      // reclassify-targets fetch (the new definition_hash is what makes
      // previously-fresh classifications stale).
      if (res.icp) {
        setEditing(res.icp)
      }
      setIsNew(false)
      setSavedSignal((n) => n + 1)
      setJustSaved(true)
      window.setTimeout(() => setJustSaved(false), 2000)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (icp: Icp) => {
    if (!confirm(`Delete ICP "${icp.name}"? This won't remove existing grid cells, but no new sweeps will be possible for it.`)) return
    setError(null)
    try {
      const res = await fetch(`${API}/api/icps/${encodeURIComponent(icp.id)}`, {
        method: 'DELETE',
      }).then((r) => r.json())
      if (!res.success) throw new Error(res.error || 'delete failed')
      await fetchAll()
      if (editing?.id === icp.id) handleClose()
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="relative h-full">
      {/* Header */}
      <div className={`${GLASS} px-4 py-3 mb-4 flex items-center gap-3`}>
        <Sparkles className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-semibold">ICPs</span>
        <span className="text-xs text-muted-foreground">
          {workspace
            ? `${visibleIcps.length} for ${workspace} (of ${icps.length} total)`
            : `${icps.length} defined`} · drives what Coverage sweeps look for
        </span>
        <div className="flex-1" />
        <Button size="sm" onClick={handleNew}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New ICP
        </Button>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/40 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Two-column layout. The list lives in a narrow, sticky/scrollable
          rail on the left so the user can pick from any ICP without losing
          context; the editor takes the wide column so long fields
          (classifyPrompt, target description) have room to breathe. */}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* List rail */}
        <div className="space-y-2 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-100px)] overflow-y-auto pr-1">
          {loading && icps.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-8 text-center text-muted-foreground text-xs">
                <Loader2 className="h-4 w-4 mx-auto mb-2 animate-spin" />
                Loading ICPs…
              </CardContent>
            </Card>
          ) : visibleIcps.length === 0 ? (
            <Card className={GLASS}>
              <CardContent className="py-8 text-center text-muted-foreground text-xs">
                {workspace
                  ? <>No ICPs yet for <span className="font-semibold">{workspace}</span>.</>
                  : <>No ICPs defined yet. Click "New ICP" to create one.</>}
              </CardContent>
            </Card>
          ) : (
            visibleIcps.map((icp) => {
              const active = editing?.id === icp.id
              return (
                <Card
                  key={icp.id}
                  className={`${GLASS} cursor-pointer transition hover:bg-white/65 dark:hover:bg-white/[0.06] ${active ? 'ring-2 ring-sky-500/60 bg-sky-500/[0.06]' : ''}`}
                  onClick={() => handleEdit(icp)}
                >
                  <CardContent className="p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <h3 className="text-sm font-semibold truncate">{icp.name}</h3>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300">
                            {icp.vertical || 'untagged'}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {icp.cities.length} {icp.cities.length === 1 ? 'city' : 'cities'} · {icp.searchTerms.length} {icp.searchTerms.length === 1 ? 'term' : 'terms'}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 text-red-600 dark:text-red-400 hover:bg-red-500/10 shrink-0"
                        title="Delete ICP"
                        onClick={(e) => { e.stopPropagation(); handleDelete(icp) }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>

        {/* Edit panel - wide column, full ICP detail. */}
        <Card className={GLASS}>
          <CardContent className="p-5">
            {!editing ? (
              <div className="text-center text-muted-foreground py-16">
                <Sparkles className="h-8 w-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm mb-1">No ICP open.</p>
                <p className="text-xs leading-relaxed">
                  Click an ICP in the list, or "New ICP" to create one.
                </p>
              </div>
            ) : (
              <Editor
                icp={editing}
                isNew={isNew}
                saving={saving}
                savedSignal={savedSignal}
                justSaved={justSaved}
                portfolioCompanies={portfolioCompanies}
                onChange={setEditing}
                onSave={handleSave}
                onClose={handleClose}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Editor({
  icp,
  isNew,
  saving,
  savedSignal,
  justSaved,
  portfolioCompanies,
  onChange,
  onSave,
  onClose,
}: {
  icp: Icp
  isNew: boolean
  saving: boolean
  // Bumps once per successful save (page-level counter). The Editor uses
  // this to re-snap its definition baseline (clearing the "unsaved edits"
  // indicator) AND refresh reclassify-targets so server-side staleness
  // flags reflect the freshly-saved definition_hash.
  savedSignal: number
  // True for ~2s right after a successful save so the Save button can
  // flash "Saved" feedback without the editor closing.
  justSaved: boolean
  portfolioCompanies: string[]
  onChange: (icp: Icp) => void
  onSave: () => void
  onClose: () => void
}) {
  // "Add new..." mode for the portfolio company dropdown. When the user
  // picks the sentinel option we swap the select for a text input so they
  // can type a brand-new portfolio company name (the ICP is where
  // portfolios get defined in the first place, so we have to allow this).
  const [pcCustomMode, setPcCustomMode] = useState(false)

  // ── Tab state (Edit | Reclassify) ───────────────────────────────────
  // The Reclassify tab is conditional - shown when the ICP's definition
  // fields have changed since the last save, OR when there are unclassified
  // cached companies in this ICP's vertical. Either signal means "you have
  // work to do here", so the tab surfaces; otherwise it's hidden so it
  // doesn't add noise on a fresh open.
  const [activeTab, setActiveTab] = useState<'edit' | 'reclassify'>('edit')
  // Snapshot of the DEFINITION fields the moment this editor instance
  // mounts for this ICP. Anything outside these fields (cities, countries,
  // search terms, coverage tiers, portfolioCompany, name, id) is targeting
  // - changing them doesn't invalidate prior classifications, so it doesn't
  // affect reclassify gating. Captured via JSON.stringify so deep equality
  // is one cheap string compare per render.
  type DefinitionSnapshot = {
    targetDescription: string
    customerTypes: string[]
    excludeTypes: string[]
    excludeCompanies: string[]
    extraNotes: string
    classifyPrompt: string
    useCustomPrompt: boolean
  }
  const definitionFields = (i: Icp): DefinitionSnapshot => ({
    targetDescription: (i.targetDescription || '').trim(),
    customerTypes: (i.customerTypes || []).map((s) => s.trim()).filter(Boolean),
    excludeTypes: (i.excludeTypes || []).map((s) => s.trim()).filter(Boolean),
    excludeCompanies: (i.excludeCompanies || []).map((s) => s.trim()).filter(Boolean),
    extraNotes: (i.extraNotes || '').trim(),
    classifyPrompt: (i.classifyPrompt || '').trim(),
    useCustomPrompt: !!i.useCustomPrompt,
  })
  // Baseline captured on mount; refreshed when (a) the user picks a
  // different ICP (icp.id changes) OR (b) a successful save lands
  // (savedSignal bumps). Kept in a ref so the hasDefinitionChanges
  // computation doesn't trigger re-renders.
  const baselineRef = useRef<string>(JSON.stringify(definitionFields(icp)))
  useEffect(() => {
    baselineRef.current = JSON.stringify(definitionFields(icp))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icp.id, savedSignal])
  // Tab reset is icp.id ONLY - a save shouldn't bounce the user out of the
  // Reclassify tab they were in (after-save is exactly when they want to
  // see the newly-stale rows show up).
  useEffect(() => {
    setActiveTab('edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icp.id])
  const currentDefinition = JSON.stringify(definitionFields(icp))
  const hasDefinitionChanges = currentDefinition !== baselineRef.current

  // ── Reclassify targets fetch ────────────────────────────────────────
  // One shared fetch for both the tab-visibility gate AND the tab's
  // rendered list. Lives at the parent so opening/closing the tab doesn't
  // re-fetch every time. Triggered on mount + on ICP switch.
  const [reclassifyTargets, setReclassifyTargets] = useState<TargetsResponse['targets']>([])
  const [reclassifyTotals, setReclassifyTotals] = useState({ total: 0, classified: 0, unclassified: 0, stale: 0 })
  const [reclassifyLoading, setReclassifyLoading] = useState(false)
  const [reclassifyError, setReclassifyError] = useState<string | null>(null)
  const refreshReclassify = async () => {
    if (!icp.id || isNew) return // no targets endpoint for an unsaved new ICP
    setReclassifyLoading(true); setReclassifyError(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/${encodeURIComponent(icp.id)}/reclassify-targets`) as TargetsResponse
      if (!data?.success) throw new Error(data?.error || 'failed to load targets')
      setReclassifyTargets(data.targets || [])
      setReclassifyTotals({ total: data.total || 0, classified: data.classified || 0, unclassified: data.unclassified || 0, stale: data.stale || 0 })
    } catch (e: any) {
      setReclassifyError(e?.message || 'failed to load targets')
    } finally {
      setReclassifyLoading(false)
    }
  }
  useEffect(() => {
    refreshReclassify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icp.id, savedSignal])
  // Note the savedSignal dep: after the user saves, the persisted ICP has a
  // new definition_hash. The targets endpoint computes stale flags by
  // comparing each stored classification's hash against the ICP's current
  // hash, so we need a fresh fetch to pick those up. Without this, the
  // staleness count on the Reclassify tab would lag behind the save.

  // Tab visibility: armed when any of these are true:
  //   • unsaved definition edits (client-side baseline detects them) - tab
  //     surfaces immediately so the user can see "now reclassify-eligible"
  //     before they save.
  //   • server-side stale verdicts (definition_hash mismatch on any company
  //     classified by this ICP) - the AUTHORITATIVE signal that survives
  //     editor close+reopen and was the actual root cause of the demo bug.
  //   • unclassified companies in this ICP's vertical (sweep ran but this
  //     ICP hasn't classified them yet) - the "pull in new companies" path.
  //   • user is already on the tab - keeps it pinned through saves so it
  //     can't vanish mid-action.
  const showReclassifyTab = !isNew && (
    hasDefinitionChanges
    || reclassifyTotals.stale > 0
    || reclassifyTotals.unclassified > 0
    || activeTab === 'reclassify'
  )
  // Helpers for the array fields - search terms, cities, and the new
  // structured-criteria arrays (customerTypes, excludeTypes, excludeCompanies).
  // Each input edits a single string; an extra empty input at the end lets
  // the user add another. Removed entries become "" and get filtered out
  // on save.
  type ArrayKey = 'searchTerms' | 'cities' | 'customerTypes' | 'excludeTypes' | 'excludeCompanies'
  const getArr = (key: ArrayKey): string[] => (icp[key] as string[] | undefined) || ['']
  const updateArrayItem = (key: ArrayKey, idx: number, value: string) => {
    const arr = [...getArr(key)]
    arr[idx] = value
    onChange({ ...icp, [key]: arr })
  }
  const removeArrayItem = (key: ArrayKey, idx: number) => {
    const arr = getArr(key).filter((_, i) => i !== idx)
    onChange({ ...icp, [key]: arr.length > 0 ? arr : [''] })
  }
  const addArrayItem = (key: ArrayKey) => {
    onChange({ ...icp, [key]: [...getArr(key), ''] })
  }

  // Live preview of the composed classifier prompt. Mirrors the server-side
  // composeClassifyPrompt() in api/utils/icps.js - keep in sync if either
  // side changes. Returns null when no structured fields are populated, in
  // which case we show the raw classifyPrompt instead.
  const composedPreview = composeClassifyPromptClient({
    targetDescription: icp.targetDescription || '',
    customerTypes: getArr('customerTypes').map(s => s.trim()).filter(Boolean),
    excludeTypes: getArr('excludeTypes').map(s => s.trim()).filter(Boolean),
    excludeCompanies: getArr('excludeCompanies').map(s => s.trim()).filter(Boolean),
    extraNotes: icp.extraNotes || '',
  })
  const promptPreview = composedPreview || icp.classifyPrompt || ''
  const isComposed = composedPreview !== null

  // ── AI fill ──────────────────────────────────────────────────────────
  // Free-text → structured ICP. Calls POST /api/icps/generate, then splats
  // the response into the form for the user to review + Save. Preserves the
  // existing id when editing (it's immutable in the UI) and the form's
  // portfolioCompany.
  const [aiDesc, setAiDesc] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiErr, setAiErr] = useState<string | null>(null)
  // AI improve: critique the CURRENT form state + suggest a tightened ICP.
  // The improved payload sits in pending state until the user clicks Apply,
  // so a bad suggestion can't silently overwrite their work.
  const [improveLoading, setImproveLoading] = useState(false)
  const [improveCritique, setImproveCritique] = useState<string | null>(null)
  const [improvedDraft, setImprovedDraft] = useState<Partial<Icp> | null>(null)
  // Report-template autofill: separate loading/error state so it doesn't
  // collide with the form-level AI fill spinner. The button next to the
  // template textarea calls POST /api/icps/generate-report-template with
  // the current description/vertical/customerTypes/extraNotes; the
  // returned markdown replaces the textarea content (still editable
  // before Save).
  const [reportTplLoading, setReportTplLoading] = useState(false)
  const [reportTplErr, setReportTplErr] = useState<string | null>(null)

  // Per-city country lookup. Populated lazily via the batch /cities-info
  // endpoint - any city we haven't seen yet gets resolved on the next render.
  // Cache survives ICP edits (key is city name) so editing London → Lond
  // doesn't immediately drop the chip.
  const [cityCountries, setCityCountries] = useState<Record<string, string | null>>({})
  useEffect(() => {
    const wanted = (icp.cities || [])
      .map((c) => c.trim())
      .filter((c) => c && !(c in cityCountries))
    if (wanted.length === 0) return
    let cancelled = false
    safeFetchJson(`${API}/api/grid/cities-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: wanted }),
    })
      .then((data) => {
        if (cancelled || !data?.success) return
        setCityCountries((prev) => {
          const next = { ...prev }
          for (const name of wanted) {
            const r = data.results?.[name]
            next[name] = r?.country ? String(r.country).toUpperCase() : null
          }
          return next
        })
      })
      .catch(() => { /* leave undefined; UI shows "resolving" until next attempt */ })
    return () => { cancelled = true }
  }, [icp.cities, cityCountries])
  const hasSomethingToImprove = !!(
    icp.name?.trim() || icp.vertical?.trim() ||
    (icp.searchTerms || []).some((s) => s && s.trim()) ||
    icp.targetDescription?.trim()
  )
  const handleAiImprove = async () => {
    if (improveLoading || !hasSomethingToImprove) return
    setImproveLoading(true); setAiErr(null); setImproveCritique(null); setImprovedDraft(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/improve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icp, portfolioCompany: icp.portfolioCompany || '' }),
      })
      if (!data?.success) throw new Error(data?.error || 'Request failed')
      setImproveCritique(String(data.critique || ''))
      setImprovedDraft(data.improved || null)
    } catch (e: any) {
      setAiErr(e?.message || 'AI improve failed')
    } finally {
      setImproveLoading(false)
    }
  }
  const applyImproved = () => {
    if (!improvedDraft) return
    const g = improvedDraft
    onChange({
      ...icp,
      // Same id-preservation rules as AI fill: existing ICPs keep their id;
      // new ones can take the AI-suggested slug.
      name: isNew ? (g.name || icp.name) : icp.name,
      id: isNew ? (g.id || icp.id) : icp.id,
      vertical: g.vertical || icp.vertical,
      portfolioCompany: icp.portfolioCompany || (g as any).portfolioCompany || '',
      countries: (Array.isArray(g.countries) && g.countries.length) ? g.countries : icp.countries,
      searchTerms: (Array.isArray(g.searchTerms) && g.searchTerms.length) ? g.searchTerms : icp.searchTerms,
      searchTermsByCountry: (g.searchTermsByCountry && typeof g.searchTermsByCountry === 'object' && Object.keys(g.searchTermsByCountry).length > 0)
        ? g.searchTermsByCountry
        : icp.searchTermsByCountry,
      cityTerms: (g.cityTerms && typeof g.cityTerms === 'object' && Object.keys(g.cityTerms).length > 0)
        ? g.cityTerms
        : icp.cityTerms,
      cities: (Array.isArray(g.cities) && g.cities.length) ? g.cities : icp.cities,
      coverage: g.coverage || icp.coverage,
      targetDescription: typeof g.targetDescription === 'string' ? g.targetDescription : icp.targetDescription,
      customerTypes: (Array.isArray(g.customerTypes) && g.customerTypes.length) ? g.customerTypes : icp.customerTypes,
      excludeTypes: (Array.isArray(g.excludeTypes) && g.excludeTypes.length) ? g.excludeTypes : icp.excludeTypes,
      excludeCompanies: (Array.isArray(g.excludeCompanies) && g.excludeCompanies.length) ? g.excludeCompanies : icp.excludeCompanies,
      extraNotes: typeof g.extraNotes === 'string' ? g.extraNotes : icp.extraNotes,
    })
    setImproveCritique(null)
    setImprovedDraft(null)
  }
  const dismissImproved = () => { setImproveCritique(null); setImprovedDraft(null) }

  // Distribute - takes the flat searchTerms list and asks GPT to bucket each
  // by language into the country(ies) that speak it. Lets the boss tick
  // additional countries and click ONE button to migrate the historical flat
  // list into the per-country shape, instead of copy-pasting terms by hand
  // into each card. Backed by POST /api/icps/distribute-search-terms.
  const [distributing, setDistributing] = useState(false)
  const flatSharedTerms = (icp.searchTerms || []).map((t) => t.trim()).filter(Boolean)
  const handleDistributeShared = async () => {
    if (distributing) return
    if (flatSharedTerms.length === 0 || (icp.countries || []).length < 2) return
    setDistributing(true); setAiErr(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/distribute-search-terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: flatSharedTerms, countries: icp.countries || [] }),
      })
      if (!data?.success) throw new Error(data?.error || 'distribute failed')
      // Merge into searchTermsByCountry. Per-country buckets are MERGED (not
      // replaced) so any per-country terms the boss already typed survive.
      const existing = icp.searchTermsByCountry || {}
      const nextByCountry: Record<string, string[]> = { ...existing }
      for (const [cc, list] of Object.entries(data.byCountry || {})) {
        const code = cc.toUpperCase()
        const merged = [...(existing[code] || []), ...((list as string[]) || [])]
        // De-dupe, trim
        const seen = new Set<string>()
        nextByCountry[code] = merged.filter((t) => {
          const k = t.trim().toLowerCase()
          if (!k || seen.has(k)) return false
          seen.add(k)
          return true
        })
      }
      // The "shared" leftovers stay in the flat searchTerms list as fallback.
      const nextShared = Array.isArray(data.shared) ? data.shared : []
      onChange({
        ...icp,
        searchTerms: nextShared.length > 0 ? nextShared : [''],
        searchTermsByCountry: nextByCountry,
      })
    } catch (e: any) {
      setAiErr(e?.message || 'distribute failed')
    } finally {
      setDistributing(false)
    }
  }
  // ── Outlier city CTAs ────────────────────────────────────────────────
  // When a city resolves to a country that isn't ticked above, two paths:
  //   1. "Add <CC> to countries" - full country case. Ticks the country and
  //      kicks off /distribute-search-terms so the new country card isn't
  //      empty. User now also has access to Tier-2 country-fill for that
  //      country in Coverage.
  //   2. "City-only terms" - keeps countries unchanged. Calls /terms-for-city
  //      to generate language-correct Maps phrases for the one city, writes
  //      them to cityTerms[city]. The sweep then runs ONLY this one cell
  //      with those terms (rest of the country is left alone).
  // Both are surfaced inline on the grayed city row so the fix is one click.
  const handleAddCountryFromCity = async (cc: string) => {
    const code = cc.toUpperCase()
    if (!code) return
    const existing = (icp.countries || []).map((c) => c.toUpperCase())
    if (existing.includes(code)) return
    const nextCountries = [...existing, code]
    // Tick the country first so the multi-country UI renders the new card.
    onChange({ ...icp, countries: nextCountries })
    // Then, if there are flat shared terms, run distribute so the new card
    // isn't empty. Distribute handles dedup against existing per-country lists.
    const sharedNow = (icp.searchTerms || []).map((t) => t.trim()).filter(Boolean)
    if (sharedNow.length === 0 || nextCountries.length < 2) return
    setDistributing(true); setAiErr(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/distribute-search-terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: sharedNow, countries: nextCountries }),
      })
      if (!data?.success) throw new Error(data?.error || 'distribute failed')
      const existingMap = icp.searchTermsByCountry || {}
      const nextByCountry: Record<string, string[]> = { ...existingMap }
      for (const [k, list] of Object.entries(data.byCountry || {})) {
        const kc = k.toUpperCase()
        const merged = [...(existingMap[kc] || []), ...((list as string[]) || [])]
        const seen = new Set<string>()
        nextByCountry[kc] = merged.filter((t) => {
          const key = t.trim().toLowerCase()
          if (!key || seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      const nextShared = Array.isArray(data.shared) ? data.shared : []
      // We already called onChange with the new countries; chain the next
      // state off the SAME icp object so we don't lose that update.
      onChange({
        ...icp,
        countries: nextCountries,
        searchTerms: nextShared.length > 0 ? nextShared : [''],
        searchTermsByCountry: nextByCountry,
      })
    } catch (e: any) {
      setAiErr(e?.message || 'distribute failed')
    } finally {
      setDistributing(false)
    }
  }
  // City-only terms - call /terms-for-city, write into cityTerms[city]. Tracks
  // the city we're currently working on so multiple grayed rows can each show
  // their own loading state.
  const [cityTermsLoading, setCityTermsLoading] = useState<string | null>(null)
  const handleGenerateCityTerms = async (cityName: string, cc: string) => {
    const name = cityName.trim()
    if (!name || cityTermsLoading) return
    setCityTermsLoading(name); setAiErr(null)
    try {
      const existingTerms: Record<string, string[]> = {
        ...(icp.searchTermsByCountry || {}),
        shared: (icp.searchTerms || []).map((t) => t.trim()).filter(Boolean),
      }
      const data = await safeFetchJson(`${API}/api/icps/terms-for-city`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: name,
          country: cc.toUpperCase(),
          vertical: icp.vertical || '',
          targetDescription: icp.targetDescription || '',
          existingTerms,
        }),
      })
      if (!data?.success) throw new Error(data?.error || 'terms-for-city failed')
      const terms = Array.isArray(data.terms) ? data.terms : []
      if (terms.length === 0) throw new Error('AI returned no terms')
      const nextCityTerms: Record<string, string[]> = { ...(icp.cityTerms || {}) }
      nextCityTerms[name] = terms
      onChange({ ...icp, cityTerms: nextCityTerms })
    } catch (e: any) {
      setAiErr(e?.message || 'terms-for-city failed')
    } finally {
      setCityTermsLoading(null)
    }
  }
  // Lookup helper for the city row UI - returns the current cityTerms[name]
  // (case-insensitive) or null.
  const getCityTerms = (cityName: string): { key: string; terms: string[] } | null => {
    const trimmed = cityName.trim()
    if (!trimmed || !icp.cityTerms) return null
    const key = Object.keys(icp.cityTerms).find((k) => k.toLowerCase() === trimmed.toLowerCase())
    if (!key) return null
    return { key, terms: icp.cityTerms[key] || [] }
  }
  // Helper to mutate a single city's term list (used by the inline ArrayEditor
  // inside the outlier row's expanded panel).
  const setCityTermsFor = (city: string, next: string[]) => {
    const trimmed = city.trim()
    if (!trimmed) return
    const map: Record<string, string[]> = { ...(icp.cityTerms || {}) }
    // Find existing key (case-insensitive) to overwrite, else create.
    const existingKey = Object.keys(map).find((k) => k.toLowerCase() === trimmed.toLowerCase()) || trimmed
    if (next.length === 0) {
      delete map[existingKey]
    } else {
      map[existingKey] = next
    }
    onChange({ ...icp, cityTerms: Object.keys(map).length > 0 ? map : undefined })
  }

  // Per-section AI fill - small "AI" buttons next to Search terms / Cities /
  // Classifier criteria headers. Splat ONLY that section's fields so the
  // user's tweaks elsewhere survive. Shares the same description box as the
  // big AI fill button; sends the current ICP state as context.
  type AiSection = 'search-terms' | 'cities' | 'classifier'
  const [aiSection, setAiSection] = useState<AiSection | null>(null)
  const handleAiSection = async (section: AiSection) => {
    if (!aiDesc.trim() || aiSection) return
    setAiSection(section); setAiErr(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: aiDesc.trim(),
          section,
          portfolioCompany: icp.portfolioCompany || '',
          current: icp,
        }),
      })
      if (!data?.success) throw new Error(data?.error || 'Request failed')
      const fields = data.fields || {}
      // Splat ONLY the returned fields - keep everything else as-is.
      onChange({ ...icp, ...fields })
    } catch (e: any) {
      setAiErr(e?.message || 'AI section fill failed')
    } finally {
      setAiSection(null)
    }
  }
  // Inline factory for a per-section AI button - same shape across the three
  // sections so the disabled / loading / tooltip behavior stays consistent.
  const sectionButton = (section: AiSection, label: string) => (
    <button
      type="button"
      onClick={() => handleAiSection(section)}
      disabled={!aiDesc.trim() || !!aiSection}
      title={aiDesc.trim() ? `AI fill this section only - keeps your other tweaks` : 'Type a description in the AI panel above first'}
      className={cn(
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border/60 transition-colors',
        aiDesc.trim() && !aiSection
          ? 'text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 cursor-pointer'
          : 'text-muted-foreground cursor-not-allowed opacity-60',
      )}
    >
      {aiSection === section
        ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
        : <Sparkles className="h-2.5 w-2.5" />}
      AI: {label}
    </button>
  )
  // Pulls the rep's existing description / vertical / customer types from
  // the form state, asks GPT to design a report-template tailored to that
  // ICP, then drops the markdown into the textarea. Doesn't auto-save -
  // the rep can edit before hitting Save. Disabled when there's no
  // description AND no vertical (GPT has nothing to anchor to). Uses
  // icpAutomationModel via the backend route.
  const handleGenerateReportTemplate = async () => {
    if (reportTplLoading) return
    if (!(icp.targetDescription || '').trim() && !(icp.vertical || '').trim()) {
      setReportTplErr('Fill in the target description or vertical first - the AI needs something to tailor the template to.')
      return
    }
    setReportTplLoading(true); setReportTplErr(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/generate-report-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: icp.targetDescription || '',
          vertical: icp.vertical || '',
          portfolioCompany: icp.portfolioCompany || '',
          customerTypes: icp.customerTypes || [],
          extraNotes: icp.extraNotes || '',
        }),
      })
      if (!data?.success || !data?.reportTemplate) throw new Error(data?.error || 'Request failed')
      onChange({ ...icp, reportTemplate: data.reportTemplate })
    } catch (e: any) {
      setReportTplErr(e?.message || 'Report template fill failed')
    } finally {
      setReportTplLoading(false)
    }
  }

  const handleAiFill = async () => {
    if (!aiDesc.trim() || aiLoading) return
    setAiLoading(true); setAiErr(null)
    try {
      const data = await safeFetchJson(`${API}/api/icps/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: aiDesc.trim(), portfolioCompany: icp.portfolioCompany || '' }),
      })
      if (!data?.success) throw new Error(data?.error || 'Request failed')
      const g = data.icp || {}
      onChange({
        ...icp,
        // Name + id only auto-fill on a brand-new ICP; for existing ones
        // the id is immutable and the existing name is preserved unless
        // the form's name was empty.
        name: isNew ? (g.name || icp.name) : icp.name,
        id: isNew ? (g.id || icp.id) : icp.id,
        vertical: g.vertical || icp.vertical,
        portfolioCompany: icp.portfolioCompany || g.portfolioCompany || '',
        countries: (Array.isArray(g.countries) && g.countries.length) ? g.countries : icp.countries,
        searchTerms: (Array.isArray(g.searchTerms) && g.searchTerms.length) ? g.searchTerms : icp.searchTerms,
      searchTermsByCountry: (g.searchTermsByCountry && typeof g.searchTermsByCountry === 'object' && Object.keys(g.searchTermsByCountry).length > 0)
        ? g.searchTermsByCountry
        : icp.searchTermsByCountry,
        cityTerms: (g.cityTerms && typeof g.cityTerms === 'object' && Object.keys(g.cityTerms).length > 0)
          ? g.cityTerms
          : icp.cityTerms,
        cities: (Array.isArray(g.cities) && g.cities.length) ? g.cities : icp.cities,
        coverage: g.coverage || icp.coverage,
        targetDescription: typeof g.targetDescription === 'string' ? g.targetDescription : icp.targetDescription,
        customerTypes: (Array.isArray(g.customerTypes) && g.customerTypes.length) ? g.customerTypes : icp.customerTypes,
        excludeTypes: (Array.isArray(g.excludeTypes) && g.excludeTypes.length) ? g.excludeTypes : icp.excludeTypes,
        excludeCompanies: (Array.isArray(g.excludeCompanies) && g.excludeCompanies.length) ? g.excludeCompanies : icp.excludeCompanies,
        extraNotes: typeof g.extraNotes === 'string' ? g.extraNotes : icp.extraNotes,
      })
    } catch (e: any) {
      setAiErr(e?.message || 'AI fill failed')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{isNew ? 'New ICP' : `Edit · ${icp.name || icp.id}`}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Tab toggle (Edit | Reclassify) ───────────────────────────────
          Reclassify is conditional - shown only when there's work to do
          (definition fields changed, or unclassified companies waiting),
          so it doesn't add noise on a routine open. Once the user is in
          the Reclassify tab we keep it pinned (showReclassifyTab includes
          the active-tab check) so the tab can't vanish mid-action. */}
      {showReclassifyTab && (
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('edit')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              activeTab === 'edit'
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('reclassify')}
            className={cn(
              'px-3 py-1.5 border-l border-border transition-colors inline-flex items-center gap-1.5',
              activeTab === 'reclassify'
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
            title={hasDefinitionChanges
              ? 'You\'ve edited definition fields - save first, then reclassify'
              : reclassifyTotals.stale > 0
                ? `${reclassifyTotals.stale} verdicts were made under an older ICP definition - reclassify to refresh`
                : reclassifyTotals.unclassified > 0
                  ? `${reclassifyTotals.unclassified} cached companies waiting to be classified`
                  : 'Re-run classifier on cached companies'}
          >
            Reclassify
            {hasDefinitionChanges && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" title="Definition changed since last save" />
            )}
            {!hasDefinitionChanges && reclassifyTotals.stale > 0 && (
              <span
                className="text-[10px] bg-amber-500/20 px-1 rounded font-mono"
                title={`${reclassifyTotals.stale} stale verdicts (ICP edited since last classify)`}
              >
                {reclassifyTotals.stale} stale
              </span>
            )}
            {!hasDefinitionChanges && reclassifyTotals.stale === 0 && reclassifyTotals.unclassified > 0 && (
              <span className="text-[10px] bg-amber-500/20 px-1 rounded font-mono">
                {reclassifyTotals.unclassified}
              </span>
            )}
          </button>
        </div>
      )}

      {/* ── Reclassify panel ─────────────────────────────────────────────
          Mounted only when active so the socket subscription + targets
          fetch don't run in the background while the user is editing. The
          Edit form below stays mounted (display:none when hidden) so the
          form state (AI fill description, expanded sections) survives
          switching tabs - rebuilding the form on every tab toggle would
          be slow and lose typing state. */}
      {activeTab === 'reclassify' && !isNew && (
        <ReclassifyTab
          icpId={icp.id}
          vertical={icp.vertical || ''}
          // CURRENT saved ICP scope - drives the historical-vs-active
          // determination for the city/country filter chips. A row whose
          // city or resolved country is missing from these gets greyed +
          // its checkbox disabled (out of scope per the current definition).
          activeCountries={icp.countries || []}
          activeCities={icp.cities || []}
          targets={reclassifyTargets}
          totals={reclassifyTotals}
          loadingTargets={reclassifyLoading}
          targetsError={reclassifyError}
          refreshTargets={refreshReclassify}
          hasDefinitionChanges={hasDefinitionChanges}
          hasUnsavedChanges={hasDefinitionChanges /* close-enough proxy for now */}
          onRequestSave={onSave}
        />
      )}

      {/* ── Edit form ────────────────────────────────────────────────
          Hidden via display:none when Reclassify is active. Preserves
          form state across tab switches. */}
      <div className={activeTab === 'reclassify' ? 'hidden' : 'space-y-3'}>

      {/* ── AI fill panel ──────────────────────────────────────────────
          Describe the kind of companies you want, GPT fills the form. The
          form is still editable - the user reviews + tweaks before Save. */}
      <div className={cn(GLASS_SUBTLE, 'rounded-md p-3 space-y-2')}>
        <div className="flex items-center gap-2 text-xs font-medium">
          <Sparkles className="h-3.5 w-3.5 text-sky-500" />
          Describe it - AI fills the form
        </div>
        <textarea
          value={aiDesc}
          onChange={(e) => setAiDesc(e.target.value)}
          rows={2}
          placeholder="e.g. Independent garden centres in the Netherlands - exclude big chains; we sell retail PMS so prefer ones with a physical store and an online presence."
          className="w-full rounded-md border border-border bg-background/60 px-3 py-2 text-xs"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            onClick={handleAiFill}
            disabled={aiLoading || !aiDesc.trim()}
            className="h-7 text-xs"
            title={isNew ? 'Generate every field from the description' : 'Refill the form - id is preserved (it is immutable)'}
          >
            {aiLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
            {aiLoading ? 'Generating…' : 'AI fill'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleAiImprove}
            disabled={improveLoading || !hasSomethingToImprove}
            className="h-7 text-xs"
            title={hasSomethingToImprove
              ? 'Critique the current form and suggest tightened fields (review before applying)'
              : 'Fill in some fields (or use AI fill) before asking for an improvement'}
          >
            {improveLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
            {improveLoading ? 'Reviewing…' : 'AI improve'}
          </Button>
          {aiErr && <span className="text-[11px] text-red-600 dark:text-red-400">{aiErr}</span>}
          <span className="ml-auto text-[10px] text-muted-foreground italic">Review + edit before saving.</span>
        </div>

        {/* Critique + apply/dismiss - only shown after /improve returns. */}
        {improveCritique && (
          <div className={cn(GLASS_SUBTLE, 'rounded-md p-3 mt-2 space-y-2 border border-sky-500/30')}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
              <Sparkles className="h-3 w-3" />
              Suggested improvements
            </div>
            <p className="text-xs whitespace-pre-wrap">{improveCritique}</p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={applyImproved}
                disabled={!improvedDraft}
                className="h-6 text-[11px]"
                title="Splat the suggested fields into the form (you can still edit before Save)"
              >
                Apply
              </Button>
              <button
                type="button"
                onClick={dismissImproved}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      <Field label="ID" hint="lowercase, hyphens - used in URLs and data files. Cannot be changed after create.">
        <Input
          value={icp.id}
          onChange={(e) => onChange({ ...icp, id: e.target.value })}
          placeholder="e.g. carla"
          disabled={!isNew}
        />
      </Field>

      <Field label="Name" hint="What's shown in the picker dropdown.">
        <Input
          value={icp.name}
          onChange={(e) => onChange({ ...icp, name: e.target.value })}
          placeholder="e.g. Carla Auto Rental"
        />
      </Field>

      <Field label="Vertical" hint="The market niche this ICP targets - drives scrape-cache pooling. Free-text. ICPs sharing a vertical share their cached scrapes (cheap reuse).">
        <Input
          value={icp.vertical}
          onChange={(e) => onChange({ ...icp, vertical: e.target.value })}
          placeholder="e.g. Car Rental, Garden Centre, Thrift Store"
        />
      </Field>

      <Field label="Portfolio Company" hint="Which Valsoft portfolio company this ICP feeds. Optional. Multiple ICPs can share one company across different verticals (e.g. NedFox sells into Garden Centre + Thrift Store + Camping).">
        {pcCustomMode ? (
          <div className="flex items-center gap-2">
            <Input
              value={icp.portfolioCompany || ''}
              onChange={(e) => onChange({ ...icp, portfolioCompany: e.target.value })}
              placeholder="e.g. NedFox, Carla Auto Rental Systems"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                setPcCustomMode(false)
                onChange({ ...icp, portfolioCompany: '' })
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground shrink-0"
            >
              Cancel
            </button>
          </div>
        ) : (
          <select
            value={icp.portfolioCompany || ''}
            onChange={(e) => {
              const v = e.target.value
              if (v === '__add_new__') {
                setPcCustomMode(true)
                onChange({ ...icp, portfolioCompany: '' })
              } else {
                onChange({ ...icp, portfolioCompany: v })
              }
            }}
            className="w-full text-sm border border-border rounded-md bg-background text-foreground px-2 py-1 [color-scheme:light_dark]"
          >
            <option value="">- none -</option>
            {portfolioCompanies.map((pc) => (
              <option key={pc} value={pc}>{pc}</option>
            ))}
            {/* Pass-through for a legacy value not in the live list (e.g.
                ICP saved before this company existed in the picker). */}
            {icp.portfolioCompany && !portfolioCompanies.includes(icp.portfolioCompany) && (
              <option value={icp.portfolioCompany}>{icp.portfolioCompany} (legacy)</option>
            )}
            <option value="__add_new__">+ Add new portfolio company…</option>
          </select>
        )}
      </Field>

      <Field label="Countries" hint="Markets this ICP operates in. Click to toggle. Drives the country bbox + Maps language for cells in each country (UK = google.co.uk/en, NL = google.nl/nl, etc.).">
        <CountriesPicker
          selected={icp.countries || []}
          onChange={(next) => onChange({ ...icp, countries: next })}
        />
      </Field>

      {/* ── Search terms ──────────────────────────────────────────────
          When the ICP has 2+ countries, a flat list runs every term in
          every market - a Dutch term in UK Maps and vice versa, which
          wastes Scrapingdog credits AND pollutes the candidate pool. So
          for multi-country ICPs we render a per-country colored card +
          a fallback "Shared / all countries" list below. Single-country
          ICPs keep the simpler flat editor. */}
      {(() => {
        // Show the multi-country UI whenever the union of (currently-ticked
        // countries) ∪ (countries with stored per-country terms) is at least
        // two. That way deselecting UK on a NL+UK ICP keeps the UK card
        // visible (grayed out) instead of silently dropping its data.
        const activeUC = (icp.countries || []).map((c) => c.toUpperCase())
        const storedUC = Object.keys(icp.searchTermsByCountry || {}).map((c) => c.toUpperCase())
        const allCountries = Array.from(new Set([...activeUC, ...storedUC]))
        return allCountries.length >= 2
      })() ? (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className="block text-xs font-semibold">Search terms</label>
            {sectionButton('search-terms', 'search terms')}
          </div>
          <p className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
            One list per country - Scrapingdog Maps runs each market in its native language.
            Countries you untick stay visible (grayed) so their terms are preserved if you re-tick them later.
            The Shared / fallback list runs only for countries with no per-country list.
          </p>
          <div className="space-y-2">
            {(() => {
              const activeUC = (icp.countries || []).map((c) => c.toUpperCase())
              const storedUC = Object.keys(icp.searchTermsByCountry || {}).map((c) => c.toUpperCase())
              return Array.from(new Set([...activeUC, ...storedUC]))
            })().map((cc) => {
              const isActive = (icp.countries || []).map((c) => c.toUpperCase()).includes(cc)
              const style = COUNTRY_STYLE[cc] || DEFAULT_COUNTRY_STYLE
              const terms = icp.searchTermsByCountry?.[cc] || ['']
              const setTerms = (next: string[]) => {
                const nextMap = { ...(icp.searchTermsByCountry || {}), [cc]: next }
                onChange({ ...icp, searchTermsByCountry: nextMap })
              }
              return (
                <div key={cc} className={cn('rounded-md border p-2', style.border, style.bg, !isActive && 'opacity-50')}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', style.chip)}>
                      {cc}
                    </span>
                    {style.label && <span className="text-[11px] text-muted-foreground">{style.label}</span>}
                    {!isActive && (
                      <span
                        className="text-[10px] text-amber-600 dark:text-amber-400"
                        title="This country isn't ticked above. Terms are preserved; the sweep skips them until you re-tick."
                      >
                        · inactive
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                      {terms.filter((t) => t.trim()).length} term{terms.filter((t) => t.trim()).length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <ArrayEditor
                    items={terms}
                    placeholder={cc === 'NL' ? 'e.g. tuincentrum' : cc === 'DE' ? 'e.g. Gartencenter' : cc === 'FR' ? 'e.g. jardinerie' : 'e.g. garden centre'}
                    onChange={(idx, v) => { const next = [...terms]; next[idx] = v; setTerms(next) }}
                    onRemove={(idx) => { const next = terms.filter((_, i) => i !== idx); setTerms(next.length > 0 ? next : ['']) }}
                    onAdd={() => setTerms([...terms, ''])}
                  />
                </div>
              )
            })}

            {/* Shared / fallback list - matches the existing flat editor.
                When there are flat terms here AND 2+ countries above, surface
                the "Auto-distribute by language" CTA so the user can migrate
                the historical list into the per-country cards in one click. */}
            <div className="rounded-md border border-border bg-muted/20 p-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-foreground">
                  SHARED
                </span>
                <span className="text-[11px] text-muted-foreground">Fallback (used only when a country above has no list)</span>
                {flatSharedTerms.length > 0 && (icp.countries || []).length >= 2 && (
                  <button
                    type="button"
                    onClick={handleDistributeShared}
                    disabled={distributing}
                    title="GPT classifies each shared term by language and moves it into the matching country card. Per-country terms you already typed are kept."
                    className={cn(
                      'ml-auto inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-sky-500/40 transition-colors',
                      distributing
                        ? 'text-muted-foreground cursor-not-allowed opacity-60'
                        : 'text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 cursor-pointer',
                    )}
                  >
                    {distributing
                      ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      : <Sparkles className="h-2.5 w-2.5" />}
                    {distributing
                      ? 'Distributing…'
                      : `Auto-distribute ${flatSharedTerms.length} term${flatSharedTerms.length === 1 ? '' : 's'} by language`}
                  </button>
                )}
              </div>
              <ArrayEditor
                items={icp.searchTerms}
                placeholder="e.g. car rental"
                onChange={(idx, v) => updateArrayItem('searchTerms', idx, v)}
                onRemove={(idx) => removeArrayItem('searchTerms', idx)}
                onAdd={() => addArrayItem('searchTerms')}
              />
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-1.5">
              <label className="block text-xs font-semibold">Search terms</label>
              {(() => {
                // Single-country: show a small country chip next to the label so
                // the connection is unambiguous. ("These terms run on NL Maps.")
                // Multi-country splits into colored cards above; this branch
                // is only the single-country case.
                const cc = (icp.countries || [])[0]?.toUpperCase()
                if (!cc) return null
                const style = COUNTRY_STYLE[cc] || DEFAULT_COUNTRY_STYLE
                return (
                  <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', style.chip)} title={style.label || cc}>
                    {cc}
                  </span>
                )
              })()}
            </div>
            {sectionButton('search-terms', 'search terms')}
          </div>
          <ArrayEditor
            items={icp.searchTerms}
            placeholder="e.g. car rental"
            onChange={(idx, v) => updateArrayItem('searchTerms', idx, v)}
            onRemove={(idx) => removeArrayItem('searchTerms', idx)}
            onAdd={() => addArrayItem('searchTerms')}
          />
          <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
            Scrapingdog Maps queries{(icp.countries || []).length === 1 ? ` for ${(icp.countries || [])[0]}` : ''}. Phase 1 uses the first one per cell. Tick more countries above to split into per-country lists.
          </p>
        </div>
      )}

      {/* Cities - same shape as the old field, but each row now shows the
          city's country as a colored chip (resolved via the geocoder cache).
          Cities whose country isn't ticked in the ICP's countries list show
          as OUTLIERS - the row gets a yellow banner with two actions:
            • Tick the whole country (full country case)
            • Generate city-only terms (single-city case, e.g. Berlin)
          If the city already has cityTerms set, the row shows them inline
          (editable). The grayed state still applies when the city has neither
          an override nor a ticked country - the sweep will skip it. */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label className="block text-xs font-semibold">Cities</label>
          {sectionButton('cities', 'cities')}
        </div>
        <div className="space-y-1.5">
          {icp.cities.map((city, idx) => {
            const trimmed = city.trim()
            // null = resolved but unknown country; undefined = lookup pending
            const cc = trimmed ? cityCountries[trimmed] : null
            const activeCountries = (icp.countries || []).map((c) => c.toUpperCase())
            const inIcp = cc ? activeCountries.includes(cc) : false
            const cityOverride = trimmed ? getCityTerms(trimmed) : null
            // Outlier = resolved to a country, that country isn't ticked.
            // The city is either active-via-cityTerms (has override) or
            // grayed (no override → sweep will skip).
            const isOutlier = !!cc && !inIcp
            const grayed = isOutlier && !cityOverride
            const style = cc ? (COUNTRY_STYLE[cc] || DEFAULT_COUNTRY_STYLE) : null
            const isLoadingThisCity = cityTermsLoading === trimmed
            return (
              <div key={idx} className="space-y-1">
                <div className={cn('flex items-center gap-1.5', grayed && 'opacity-60')}>
                  <Input
                    value={city}
                    onChange={(e) => updateArrayItem('cities', idx, e.target.value)}
                    placeholder="e.g. London, Amsterdam"
                    className={cn('flex-1', grayed && 'line-through decoration-muted-foreground/40')}
                  />
                  {cc && style && (
                    <span
                      className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0', style.chip)}
                      title={isOutlier
                        ? (cityOverride
                            ? `${cc} not ticked - city runs via city-only terms (${cityOverride.terms.length})`
                            : `${cc} not ticked on this ICP - city will be skipped until you tick the country or give it city-only terms`)
                        : `Resolved as ${cc}${style.label ? ` (${style.label})` : ''}`}
                    >
                      {cc}{isOutlier ? (cityOverride ? ' · custom' : ' · outlier') : ''}
                    </span>
                  )}
                  {trimmed && cc === undefined && (
                    <span className="text-[10px] text-muted-foreground shrink-0">resolving…</span>
                  )}
                  {trimmed && cc === null && (
                    <span
                      className="text-[10px] text-muted-foreground shrink-0"
                      title="Geocoder couldn't resolve this city - it'll still be tried on first seed"
                    >
                      ?
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeArrayItem('cities', idx)}
                    className="text-muted-foreground hover:text-foreground shrink-0 px-1"
                    aria-label="Remove"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>

                {/* Outlier banner - only when the city resolved to a country
                    that isn't ticked AND has no city-only override yet. Two
                    CTAs: tick the whole country, or generate city-only terms. */}
                {isOutlier && !cityOverride && trimmed && cc && (
                  <div className={cn('ml-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] space-y-1.5')}>
                    <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                      <Sparkles className="h-3 w-3" />
                      <span>
                        <strong>{trimmed}</strong> resolved to <strong>{cc}</strong>, which isn't ticked. The sweep will skip it unless you pick one:
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => handleAddCountryFromCity(cc)}
                        disabled={distributing}
                        title={`Tick ${cc} as a full country - also enables Tier-2 country-fill in Coverage`}
                        className={cn(
                          'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                          distributing
                            ? 'text-muted-foreground cursor-not-allowed opacity-60 border-border'
                            : 'text-sky-700 dark:text-sky-300 border-sky-500/40 hover:bg-sky-500/10 cursor-pointer',
                        )}
                      >
                        {distributing
                          ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          : <Plus className="h-2.5 w-2.5" />}
                        Tick {cc} (full country)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleGenerateCityTerms(trimmed, cc)}
                        disabled={!!cityTermsLoading || !(icp.vertical?.trim() || icp.targetDescription?.trim() || (icp.searchTerms || []).some((t) => t.trim()))}
                        title={(icp.vertical?.trim() || icp.targetDescription?.trim() || (icp.searchTerms || []).some((t) => t.trim()))
                          ? `Generate city-only Maps terms in the ${cc} market language - keeps ${cc} out of countries`
                          : 'Add some search terms, a vertical, or a target description first so GPT has anchors to translate from'}
                        className={cn(
                          'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                          isLoadingThisCity
                            ? 'text-muted-foreground cursor-wait opacity-60 border-border'
                            : (icp.vertical?.trim() || icp.targetDescription?.trim() || (icp.searchTerms || []).some((t) => t.trim()))
                              ? 'text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/10 cursor-pointer'
                              : 'text-muted-foreground cursor-not-allowed opacity-50 border-border',
                        )}
                      >
                        {isLoadingThisCity
                          ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          : <Sparkles className="h-2.5 w-2.5" />}
                        {isLoadingThisCity ? 'Generating…' : `${trimmed}-only terms`}
                      </button>
                    </div>
                  </div>
                )}

                {/* City-only terms editor - shown whenever cityTerms[city] is
                    set, whether the country is ticked or not. Lets the user
                    review / tweak the generated phrases. Deleting them all
                    drops the override (cityTerms[name] is removed). */}
                {cityOverride && trimmed && (
                  <div className={cn('ml-1 rounded-md border p-2 space-y-1.5',
                    style ? `${style.border} ${style.bg}` : 'border-border bg-muted/20')}>
                    <div className="flex items-center gap-2">
                      <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', style?.chip || 'bg-muted text-foreground')}>
                        {trimmed.toUpperCase()}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        City-only terms · runs on this city instead of {cc} fallback{!inIcp && ` (${cc} not ticked)`}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCityTermsFor(cityOverride.key, [])}
                        title="Drop the city-only override - city falls back to whatever the country has (or gets skipped if outlier)"
                        className="ml-auto text-[10px] text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                      >
                        Clear
                      </button>
                    </div>
                    <ArrayEditor
                      items={cityOverride.terms.length > 0 ? cityOverride.terms : ['']}
                      placeholder={cc === 'DE' ? 'e.g. Gartencenter' : cc === 'FR' ? 'e.g. jardinerie' : cc === 'NL' ? 'e.g. tuincentrum' : 'e.g. garden centre'}
                      onChange={(termIdx, v) => {
                        const next = [...cityOverride.terms]
                        next[termIdx] = v
                        setCityTermsFor(cityOverride.key, next)
                      }}
                      onRemove={(termIdx) => {
                        const next = cityOverride.terms.filter((_, i) => i !== termIdx)
                        setCityTermsFor(cityOverride.key, next)
                      }}
                      onAdd={() => setCityTermsFor(cityOverride.key, [...cityOverride.terms, ''])}
                    />
                  </div>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => addArrayItem('cities')}
            className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline"
          >
            + Add another
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          Tier-1 sweep targets. Each row shows the resolved country as a chip; cities whose country isn't ticked above are grayed out and skipped by the sweep, but kept so re-ticking the country revives them. Type any city worldwide - unknown ones get auto-geocoded on first seed.
        </p>
      </div>

      <Field
        label="Country fill coverage"
        hint="Toggles which density tiers get cells when you Fill country. Garden centers want Suburban + Rural; car rentals want Urban + Airports. At least one must be on."
      >
        <div className="flex flex-wrap gap-1.5">
          <CoverageToggle
            label="Urban"
            sublabel=">50k pop"
            on={icp.coverage.urban}
            color="sky"
            onClick={() => onChange({ ...icp, coverage: { ...icp.coverage, urban: !icp.coverage.urban } })}
          />
          <CoverageToggle
            label="Suburban"
            sublabel="5k–50k"
            on={icp.coverage.suburban}
            color="indigo"
            onClick={() => onChange({ ...icp, coverage: { ...icp.coverage, suburban: !icp.coverage.suburban } })}
          />
          <CoverageToggle
            label="Rural"
            sublabel="1k–5k + gaps"
            on={icp.coverage.rural}
            color="emerald"
            onClick={() => onChange({ ...icp, coverage: { ...icp.coverage, rural: !icp.coverage.rural } })}
          />
          <CoverageToggle
            label="Airports"
            sublabel="major hubs"
            on={icp.coverage.airports}
            color="amber"
            onClick={() => onChange({ ...icp, coverage: { ...icp.coverage, airports: !icp.coverage.airports } })}
          />
        </div>
      </Field>

      {/* Prompt-mode toggle. "From criteria" composes the system prompt
          from the structured fields below (canonical for most ICPs).
          "Custom prompt" hands the user a blank textarea so they can write
          the entire system prompt from scratch - useful when the
          "Is this X serving Y? Skip Z." template doesn't fit (e.g.
          multi-step reasoning, JSON-schema-heavy verdicts, language-
          specific instructions). Structured fields stay persisted while
          custom is active so toggling back is lossless. */}
      <div className={`${GLASS_SUBTLE} p-3 rounded-md border border-border/40`}>
        <div className="text-xs font-semibold mb-2">Prompt source</div>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => onChange({ ...icp, useCustomPrompt: false })}
            className={cn(
              'px-3 py-1.5 transition-colors',
              !icp.useCustomPrompt
                ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
          >
            From criteria
          </button>
          <button
            type="button"
            onClick={() => {
              // Toggling INTO custom mode: if the textarea is empty,
              // seed it with the currently-composed prompt so the user
              // has a starting point to edit rather than a blank slate.
              const seed = (icp.classifyPrompt || '').trim() || promptPreview || ''
              onChange({ ...icp, useCustomPrompt: true, classifyPrompt: seed })
            }}
            className={cn(
              'px-3 py-1.5 border-l border-border transition-colors',
              icp.useCustomPrompt
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold'
                : 'text-muted-foreground hover:bg-muted/40',
            )}
          >
            Custom prompt
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
          {icp.useCustomPrompt
            ? 'You\'re writing the system prompt yourself. The structured criteria below are preserved but ignored at sweep time.'
            : 'The system prompt is auto-composed from the structured criteria below. Switch to Custom to override.'}
        </p>
      </div>

      {/* Structured classifier criteria - these compose into the
          classifyPrompt on save. Hidden when the user has switched to a
          custom hand-written prompt (the fields stay in state so toggling
          back restores the previous setup, just visually folded away). */}
      {!icp.useCustomPrompt && (
        <div className={`${GLASS_SUBTLE} p-3 rounded-md border border-border/40 space-y-3`}>
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-sky-500" />
            <span className="text-xs font-semibold">Classifier criteria</span>
            <span className="text-[10px] text-muted-foreground">- what GPT looks for on each scraped page</span>
            <span className="ml-auto">{sectionButton('classifier', 'criteria')}</span>
          </div>

          <Field label="What we're looking for" hint='A short phrase finishing "Is this …?" - e.g. "an independent car rental serving end customers".'>
            <Input
              value={icp.targetDescription || ''}
              onChange={(e) => onChange({ ...icp, targetDescription: e.target.value })}
              placeholder="e.g. an independent dental practice"
            />
          </Field>

          <Field label="Customer types" hint='Who they serve. e.g. "consumers", "small businesses", "general dentistry patients". Composed into "serving …".'>
            <ArrayEditor
              items={getArr('customerTypes')}
              placeholder="e.g. consumers"
              onChange={(idx, v) => updateArrayItem('customerTypes', idx, v)}
              onRemove={(idx) => removeArrayItem('customerTypes', idx)}
              onAdd={() => addArrayItem('customerTypes')}
            />
          </Field>

          <Field label="Exclude - types / categories" hint="Categories of businesses we always reject. e.g. national chains, marketplaces, listing sites, franchises.">
            <ArrayEditor
              items={getArr('excludeTypes')}
              placeholder="e.g. national chains"
              onChange={(idx, v) => updateArrayItem('excludeTypes', idx, v)}
              onRemove={(idx) => removeArrayItem('excludeTypes', idx)}
              onAdd={() => addArrayItem('excludeTypes')}
            />
          </Field>

          <Field label="Exclude - specific companies" hint="Big-name competitors to skip by name. e.g. for car rental: Hertz, Enterprise, Avis, Sixt, Turo.">
            <ArrayEditor
              items={getArr('excludeCompanies')}
              placeholder="e.g. Hertz"
              onChange={(idx, v) => updateArrayItem('excludeCompanies', idx, v)}
              onRemove={(idx) => removeArrayItem('excludeCompanies', idx)}
              onAdd={() => addArrayItem('excludeCompanies')}
            />
          </Field>

          <Field label="Extra notes / qualitative criteria" hint="Anything the structured fields can't capture - vibes, signals, edge cases. Appended to the prompt verbatim.">
            <textarea
              value={icp.extraNotes || ''}
              onChange={(e) => onChange({ ...icp, extraNotes: e.target.value })}
              rows={3}
              className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed resize-y`}
              placeholder="e.g. Founder-led practices preferred. Skip practices that look like part of a larger group based on multi-location landing pages."
            />
          </Field>
        </div>
      )}

      <Field
        label={icp.useCustomPrompt ? 'Custom classifier prompt' : 'Classifier prompt - preview'}
        hint={icp.useCustomPrompt
          ? 'Sent to GPT verbatim as the system message. End with an instruction to "Reply with JSON: {\"is_match\": true|false, \"reason\": \"<one sentence>\"}." - the sweep pipeline parses that exact shape.'
          : (isComposed
            ? 'Auto-composed from the criteria above. Edit those fields to update this. (Sent to GPT verbatim.)'
            : 'No structured criteria set - falls back to this raw prompt. Add criteria above to switch to the composed prompt.')}
      >
        {icp.useCustomPrompt || !isComposed ? (
          <textarea
            value={icp.classifyPrompt}
            onChange={(e) => onChange({ ...icp, classifyPrompt: e.target.value })}
            rows={icp.useCustomPrompt ? 10 : 6}
            className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed resize-y font-mono`}
            placeholder='Is this an independent X serving end customers? Skip Y, Z. Reply with JSON: {"is_match": true|false, "reason": "<one sentence>"}.'
          />
        ) : (
          <div
            className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed font-mono whitespace-pre-wrap min-h-[60px] opacity-80`}
            aria-readonly
          >
            {promptPreview || <span className="opacity-50">(empty - fill in fields above)</span>}
          </div>
        )}
      </Field>

      {/* Full GPT request preview. Always reflects what GPT will receive
          - composed prompt in "From criteria" mode, raw classifyPrompt in
          custom mode. */}
      <GptRequestPreview promptText={icp.useCustomPrompt ? icp.classifyPrompt : promptPreview} />

      {/* ─── Markdown report ──────────────────────────────────────────────
          Optional per-ICP brief generated on top of the binary verdict.
          Toggle on → editable template (their own markdown, any sections).
          Matched companies get the full report; rejected get a short
          why-rejected note. Universal fields (name, contacts) come from
          the scraper automatically, so the template is for the EXTRA
          insight the team wants. */}
      <div className="rounded-lg border border-white/30 dark:border-white/10 p-3 space-y-3">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={!!icp.reportEnabled}
            onChange={(e) => {
              const on = e.target.checked
              // Seed the default template the first time it's turned on so
              // the user has an example to edit rather than a blank box.
              onChange({
                ...icp,
                reportEnabled: on,
                reportTemplate: on && !(icp.reportTemplate || '').trim()
                  ? DEFAULT_REPORT_TEMPLATE
                  : icp.reportTemplate,
              })
            }}
            className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
          />
          <span>
            <span className="text-xs font-semibold">Generate a markdown report</span>
            <span className="block text-[11px] text-muted-foreground">
              A per-company brief on top of the qualified/rejected verdict. Matched companies follow your template below; rejected companies get a short "why" note. Uses the Report model (default gpt-4o).
            </span>
          </span>
        </label>

        {icp.reportEnabled && (
          <Field
            label="Report template"
            hint="Your own markdown. Name the sections whatever you want - GPT fills each from the scraped site (and writes 'Not stated on the website' when the page doesn't cover it). Name, address, phone, emails and LinkedIn are captured automatically, so use this for the extra insight you care about."
          >
            <textarea
              value={icp.reportTemplate || ''}
              onChange={(e) => onChange({ ...icp, reportTemplate: e.target.value })}
              className={`${GLASS_SUBTLE} w-full px-3 py-2 text-xs leading-relaxed font-mono resize-y min-h-[16rem] max-h-[50vh] overflow-y-auto`}
              placeholder={DEFAULT_REPORT_TEMPLATE}
            />
            <div className="mt-1.5 flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={handleGenerateReportTemplate}
                disabled={reportTplLoading}
                title="Tailor the section list to this ICP's description / vertical / customer types. Replaces the textarea content - you can still edit before saving."
                className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 hover:bg-sky-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reportTplLoading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Sparkles className="h-3 w-3" />}
                {reportTplLoading ? 'Generating…' : 'AI fill from description'}
              </button>
              <button
                type="button"
                onClick={() => onChange({ ...icp, reportTemplate: DEFAULT_REPORT_TEMPLATE })}
                className="text-[11px] text-sky-600 dark:text-sky-400 hover:underline"
              >
                Reset to example template
              </button>
              {reportTplErr && (
                <span className="text-[11px] text-red-600 dark:text-red-400">{reportTplErr}</span>
              )}
            </div>
          </Field>
        )}
      </div>

      {/* ─── Auto-associate leads ─────────────────────────────────────────
          When ON, the sweep cross-references Apollo (search-only) for people
          at every qualified company: people found are attached as leads so
          the Accounts page arrives pre-populated, and companies with no Apollo
          contacts are auto-rejected. Costs Apollo search credits per match. */}
      <div className="rounded-lg border border-white/30 dark:border-white/10 p-3 space-y-3">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={!!icp.autoAssociateLeads}
            onChange={(e) => onChange({ ...icp, autoAssociateLeads: e.target.checked })}
            className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
          />
          <span>
            <span className="text-xs font-semibold">Auto-associate leads during sweep</span>
            <span className="block text-[11px] text-muted-foreground">
              For every qualified company, search Apollo for the people who work there and attach them as leads — so the Accounts page arrives pre-populated with names (no Sales Agent step needed). Companies with no Apollo contacts are auto-rejected. Spends Apollo search credits per qualified company.
            </span>
          </span>
        </label>
      </div>

      {/* Reclassify CTA at the bottom of the form. Originally this panel ran
          its own reclassify endpoint (with its own per-city status from
          /coverage), which duplicated the Reclassify tab at the top of the
          editor and reported stale verdicts as "up to date" because it didn't
          know about the definition_hash gate. Now it's a redirect: same look,
          same place (so users who scroll to the bottom and look for "Reclassify
          cached data" still find it), but the button just jumps to the tab. */}
      {!isNew && icp.id && icp.vertical && (
        <div className={`${GLASS_SUBTLE} p-3 rounded-md border border-border/40 space-y-2.5`}>
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-xs font-semibold">Reclassify cached data</span>
            <span className="text-[10px] text-muted-foreground">- skip the sweep, just run GPT</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {reclassifyTotals.total === 0 ? (
              <>No cached <span className="font-medium text-foreground">{icp.vertical}</span> companies yet. Run a sweep from Coverage to populate the cache first.</>
            ) : (reclassifyTotals.stale > 0 || reclassifyTotals.unclassified > 0) ? (
              <>
                {reclassifyTotals.stale > 0 && (
                  <><span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">{reclassifyTotals.stale}</span> stale verdict{reclassifyTotals.stale === 1 ? '' : 's'} (ICP definition edited)</>
                )}
                {reclassifyTotals.stale > 0 && reclassifyTotals.unclassified > 0 && <> · </>}
                {reclassifyTotals.unclassified > 0 && (
                  <><span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">{reclassifyTotals.unclassified}</span> unclassified</>
                )}
                {' · '}
                <span className="font-mono">{reclassifyTotals.total}</span> total in <span className="font-medium text-foreground">{icp.vertical}</span>
              </>
            ) : (
              <>All {reclassifyTotals.total} cached <span className="font-medium text-foreground">{icp.vertical}</span> compan{reclassifyTotals.total === 1 ? 'y is' : 'ies are'} up to date with the current ICP definition.</>
            )}
          </p>
          <Button
            size="sm"
            className="w-full"
            onClick={() => setActiveTab('reclassify')}
            disabled={reclassifyTotals.total === 0}
            title={reclassifyTotals.total === 0
              ? 'Nothing to reclassify - vertical has no cached companies yet'
              : 'Switch to the Reclassify tab to pick which companies to re-run the classifier on'}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            {reclassifyTotals.total === 0
              ? 'Nothing to reclassify'
              : (reclassifyTotals.stale > 0 || reclassifyTotals.unclassified > 0)
                ? `Open Reclassify tab (${reclassifyTotals.stale + reclassifyTotals.unclassified} need attention)`
                : 'Open Reclassify tab'}
          </Button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button
          size="sm"
          onClick={onSave}
          disabled={saving}
          className={cn(
            'flex-1 transition-colors',
            // ~2s green pulse after a successful save. Editor stays open so
            // the user can immediately switch to Reclassify (which now shows
            // server-flagged stale rows from the freshly-saved definition).
            justSaved && 'bg-emerald-600 hover:bg-emerald-600 text-white',
          )}
        >
          {saving
            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            : justSaved
              ? <Check className="h-3.5 w-3.5 mr-1.5" />
              : <Save className="h-3.5 w-3.5 mr-1.5" />}
          {saving
            ? (isNew ? 'Creating…' : 'Saving…')
            : justSaved
              ? 'Saved'
              : (isNew ? 'Create ICP' : 'Save changes')}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
      </div>{/* /Edit form wrapper (display:none gate) */}
    </div>
  )
}

// Pill toggle for the coverage tier picker. Color-coded so the active
// tiers visually summarise the ICP's strategy at a glance - sky=Urban,
// indigo=Suburban, emerald=Rural, amber=Airports.
function CoverageToggle({
  label,
  sublabel,
  on,
  color,
  onClick,
}: {
  label: string
  sublabel: string
  on: boolean
  color: 'sky' | 'indigo' | 'emerald' | 'amber'
  onClick: () => void
}) {
  const colors: Record<string, { active: string; muted: string }> = {
    sky:     { active: 'bg-sky-500/20 border-sky-500/60 text-sky-700 dark:text-sky-300',
               muted:  'border-border text-muted-foreground hover:bg-muted/40' },
    indigo:  { active: 'bg-indigo-500/20 border-indigo-500/60 text-indigo-700 dark:text-indigo-300',
               muted:  'border-border text-muted-foreground hover:bg-muted/40' },
    emerald: { active: 'bg-emerald-500/20 border-emerald-500/60 text-emerald-700 dark:text-emerald-300',
               muted:  'border-border text-muted-foreground hover:bg-muted/40' },
    amber:   { active: 'bg-amber-500/20 border-amber-500/60 text-amber-700 dark:text-amber-300',
               muted:  'border-border text-muted-foreground hover:bg-muted/40' },
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1.5 rounded-md border text-xs leading-tight transition-colors ${on ? colors[color].active : colors[color].muted}`}
    >
      <div className="font-semibold">{label}</div>
      <div className="text-[10px] opacity-70">{sublabel}</div>
    </button>
  )
}

function Field({ label, hint, headerAction, children }: { label: string; hint?: string; headerAction?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="block text-xs font-semibold">{label}</label>
        {headerAction}
      </div>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

// Read-only preview of the full chat-completion request the sweep pipeline
// sends to GPT for each scraped page. Two messages: the ICP's
// classifyPrompt as the system role, and a synthesized user message that
// matches the shape api/utils/sweep-pipeline.js's classify() emits. The
// scraped markdown is shown as a placeholder so the structure is clear
// without dumping 12k characters into the UI. Collapsible - hidden by
// default so it doesn't compete with the structured-criteria fields on
// first glance.
function GptRequestPreview({ promptText }: { promptText: string }) {
  const [open, setOpen] = useState(false)
  // No trim/normalization - the sweep pipeline sends classifyPrompt
  // verbatim, so the preview should too. Empty string is shown literally
  // (with a faint placeholder underneath the box) so the operator can
  // see exactly what GPT would receive.
  const systemText = promptText
  // User message: the framing is verbatim from sweep-pipeline.js's
  // classify() helper. The pageTitle + markdown placeholders are
  // substituted per-scraped-page at sweep time and are NOT stored on
  // the ICP, so this part of the preview is a structure, not the
  // literal bytes.
  const userTemplate = `Page title: <pageTitle from Firecrawl, or "(none)">

Page content:
<scraped markdown, sliced to the first 12,000 chars>`
  return (
    <div className={`${GLASS_SUBTLE} rounded-lg px-3 py-2`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left text-xs font-semibold"
      >
        <span>How GPT sees this</span>
        <span className="text-[10px] text-muted-foreground font-normal">
          {open ? 'hide' : 'show full request'}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            For every page Firecrawl scrapes during a sweep, the pipeline calls{' '}
            <code className="px-1 rounded bg-muted/40">chat.completions</code> with two messages: a
            system message holding this ICP's composed classifier prompt, and a user message holding
            the scraped page. GPT returns one JSON object per page that the sweep writes onto the
            company record.
          </p>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center justify-between">
              <span>system message - verbatim</span>
              <span className="font-normal opacity-70">last-saved classifyPrompt</span>
            </div>
            <pre className="bg-background/60 rounded px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap font-mono max-h-40 overflow-y-auto border border-border/40">
{systemText || ' '}
            </pre>
            {!systemText && (
              <p className="text-[10px] text-muted-foreground/80">
                (empty - fill in the criteria above; this is exactly what GPT would receive today.)
              </p>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center justify-between">
              <span>user message - structure</span>
              <span className="font-normal opacity-70">filled in per-page at sweep time</span>
            </div>
            <pre className="bg-background/60 rounded px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap font-mono border border-border/40">
{userTemplate}
            </pre>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              expected response (JSON mode)
            </div>
            <pre className="bg-background/60 rounded px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap font-mono border border-border/40">
{`{ "is_match": true | false, "reason": "<one sentence>" }`}
            </pre>
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Temperature is fixed at 0.2 and{' '}
            <code className="px-1 rounded bg-muted/40">response_format</code> is forced to
            JSON so each verdict parses without retries.
          </p>
        </div>
      )}
    </div>
  )
}

// Multi-select pill row for picking ICP countries. Pulls the live list
// from /api/grid/countries on mount and renders a clickable chip for each.
// Selected chips highlight; clicking toggles. The country list rarely
// changes (it's the static `COUNTRIES` table on the backend) so a single
// fetch on mount is enough - no polling.
function CountriesPicker({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [available, setAvailable] = useState<Array<{ code: string; name: string }>>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/api/grid/countries`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d?.success && Array.isArray(d.countries)) {
          setAvailable(d.countries.map((c: any) => ({ code: c.code, name: c.name })))
        }
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = (code: string) => {
    if (selected.includes(code)) onChange(selected.filter((c) => c !== code))
    else onChange([...selected, code])
  }

  if (loading && available.length === 0) {
    return <div className="text-xs text-muted-foreground italic flex items-center gap-1.5">
      <Loader2 className="h-3 w-3 animate-spin" /> Loading countries…
    </div>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((c) => {
        const isSel = selected.includes(c.code)
        return (
          <button
            key={c.code}
            type="button"
            onClick={() => toggle(c.code)}
            title={c.name}
            className={`px-2 py-1 rounded-md border text-[11px] leading-none transition-colors ${isSel
              ? 'bg-sky-500/20 border-sky-500/60 text-sky-700 dark:text-sky-300 font-semibold'
              : 'border-border text-muted-foreground hover:bg-muted/40'}`}
          >
            {c.code}
          </button>
        )
      })}
      {available.length === 0 && (
        <span className="text-xs text-muted-foreground italic">No countries configured.</span>
      )}
    </div>
  )
}

// Client-side mirror of api/utils/icps.js → composeClassifyPrompt(). Used
// for the live preview in the edit form so users see the assembled prompt
// before saving. MUST stay in sync with the server-side function - they
// produce the same string given the same inputs. (Server is authoritative;
// this is just for preview.)
function composeClassifyPromptClient(opts: {
  targetDescription: string
  customerTypes: string[]
  excludeTypes: string[]
  excludeCompanies: string[]
  extraNotes: string
}): string | null {
  const target = opts.targetDescription.trim()
  const cust = opts.customerTypes.map(s => s.trim()).filter(Boolean)
  const exTypes = opts.excludeTypes.map(s => s.trim()).filter(Boolean)
  const exCos = opts.excludeCompanies.map(s => s.trim()).filter(Boolean)
  const notes = opts.extraNotes.trim()

  if (!target && cust.length === 0 && exTypes.length === 0 && exCos.length === 0 && !notes) {
    return null
  }

  const join = (arr: string[]): string => {
    if (arr.length === 0) return ''
    if (arr.length === 1) return arr[0]
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`
    return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`
  }

  const parts: string[] = []
  if (target) {
    const customerSuffix = cust.length ? ` serving ${join(cust)}` : ''
    parts.push(`Is this ${target}${customerSuffix}?`)
  } else if (cust.length) {
    parts.push(`Is this a business serving ${join(cust)}?`)
  }

  const skipBits: string[] = []
  if (exTypes.length) skipBits.push(join(exTypes))
  if (exCos.length) skipBits.push(`specific companies like ${join(exCos)}`)
  if (skipBits.length) parts.push(`Skip ${skipBits.join(', and ')}.`)

  if (notes) parts.push(notes)

  parts.push('Reply with JSON: {"is_match": true|false, "reason": "<one sentence>"}.')

  return parts.join(' ')
}

function ArrayEditor({
  items,
  placeholder,
  onChange,
  onRemove,
  onAdd,
}: {
  items: string[]
  placeholder: string
  onChange: (idx: number, v: string) => void
  onRemove: (idx: number) => void
  onAdd: () => void
}) {
  return (
    <div className="space-y-1.5">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-1.5">
          <Input
            value={item}
            onChange={(e) => onChange(idx, e.target.value)}
            placeholder={placeholder}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-600"
            onClick={() => onRemove(idx)}
            title="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={onAdd} className="h-7 text-xs text-muted-foreground hover:text-foreground">
        <Plus className="h-3 w-3 mr-1" />Add another
      </Button>
    </div>
  )
}

