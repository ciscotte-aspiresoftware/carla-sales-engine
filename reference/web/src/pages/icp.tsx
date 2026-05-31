// /icp - manage ICP definitions (Ideal Customer Profile).
//
// CRUD over /api/icps. The list view is the landing page; clicking an
// ICP opens an editor in a side panel. "New ICP" opens the same panel
// with empty fields. The same shape backs the Coverage page's seed
// pipeline, so editing one entry immediately changes what the next
// "Seed cells" run targets.

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Plus, Save, Trash2, Sparkles, X } from 'lucide-react'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/context/workspace-context'

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
}

const API = ''

const DEFAULT_COVERAGE: Coverage = {
  urban: true,
  suburban: false,
  rural: false,
  airports: true,
}

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
      const payload = {
        ...editing,
        searchTerms: editing.searchTerms.map(s => s.trim()).filter(Boolean),
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
      setEditing(null)
      setIsNew(false)
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
  portfolioCompanies,
  onChange,
  onSave,
  onClose,
}: {
  icp: Icp
  isNew: boolean
  saving: boolean
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{isNew ? 'New ICP' : `Edit · ${icp.name || icp.id}`}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <Field label="ID" hint="lowercase, hyphens - used in URLs and data files. Cannot be changed after create.">
        <Input
          value={icp.id}
          onChange={(e) => onChange({ ...icp, id: e.target.value })}
          placeholder="e.g. bluebird"
          disabled={!isNew}
        />
      </Field>

      <Field label="Name" hint="What's shown in the picker dropdown.">
        <Input
          value={icp.name}
          onChange={(e) => onChange({ ...icp, name: e.target.value })}
          placeholder="e.g. Bluebird Auto Rental"
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
              placeholder="e.g. NedFox, Bluebird Auto Rental Systems"
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

      <Field label="Search terms" hint="Scrapingdog Maps queries. Phase 1 uses the first one per cell.">
        <ArrayEditor
          items={icp.searchTerms}
          placeholder="e.g. car rental"
          onChange={(idx, v) => updateArrayItem('searchTerms', idx, v)}
          onRemove={(idx) => removeArrayItem('searchTerms', idx)}
          onAdd={() => addArrayItem('searchTerms')}
        />
      </Field>

      <Field label="Cities" hint="Tier-1 sweep targets. Type any city worldwide - known cities resolve from utils/cities.js, anything else is auto-geocoded via OpenStreetMap on first seed (cached after that). Metro radius is derived from the city's bounding box, capped 12–35 km.">
        <ArrayEditor
          items={icp.cities}
          placeholder="e.g. London, Manchester, Karachi"
          onChange={(idx, v) => updateArrayItem('cities', idx, v)}
          onRemove={(idx) => removeArrayItem('cities', idx)}
          onAdd={() => addArrayItem('cities')}
        />
      </Field>

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
          the entire system prompt from scratch — useful when the
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
          ? 'Sent to GPT verbatim as the system message. End with an instruction to "Reply with JSON: {\"is_match\": true|false, \"reason\": \"<one sentence>\"}." — the sweep pipeline parses that exact shape.'
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
          — composed prompt in "From criteria" mode, raw classifyPrompt in
          custom mode. */}
      <GptRequestPreview promptText={icp.useCustomPrompt ? icp.classifyPrompt : promptPreview} />

      {/* Reclassify panel - only for existing ICPs that have a vertical.
          Shows sibling-ICPs count + cached-company tally, and offers a
          one-click "Reclassify cached data" action that runs this ICP's
          prompt against every already-scraped company in the vertical
          without re-sweeping. The big credit-saver when adding a new ICP
          to an existing vertical. */}
      {!isNew && icp.id && icp.vertical && (
        <ReclassifyPanel icpId={icp.id} icpName={icp.name} vertical={icp.vertical} />
      )}

      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={onSave} disabled={saving} className="flex-1">
          {saving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          {isNew ? 'Create ICP' : 'Save changes'}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </div>
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1">{label}</label>
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
// without dumping 12k characters into the UI. Collapsible — hidden by
// default so it doesn't compete with the structured-criteria fields on
// first glance.
function GptRequestPreview({ promptText }: { promptText: string }) {
  const [open, setOpen] = useState(false)
  // No trim/normalization — the sweep pipeline sends classifyPrompt
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
              <span>system message — verbatim</span>
              <span className="font-normal opacity-70">last-saved classifyPrompt</span>
            </div>
            <pre className="bg-background/60 rounded px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap font-mono max-h-40 overflow-y-auto border border-border/40">
{systemText || ' '}
            </pre>
            {!systemText && (
              <p className="text-[10px] text-muted-foreground/80">
                (empty — fill in the criteria above; this is exactly what GPT would receive today.)
              </p>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center justify-between">
              <span>user message — structure</span>
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
    fetch('/api/grid/countries')
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

// Reclassify-existing panel rendered inside the Editor. Shows:
//   • Sibling ICPs in the same vertical (informational - user knows they're
//     working in a shared pool).
//   • How many cached companies in this vertical haven't been classified
//     by this ICP yet - the bar to-do count.
//   • "Reclassify cached data" button that POSTs to the new endpoint and
//     surfaces qualified/rejected counts on success.
//
// The classify-cached pass is the big credit-saver: it runs only the GPT
// step (no Scrapingdog, no Firecrawl) against all cached companies in
// the vertical. ~$0.0001 per company at gpt-4o-mini pricing - orders of
// magnitude cheaper than a real sweep.
import { Sparkles as SparklesIcon } from 'lucide-react'
import { fetchIcpCoverage, reclassifyIcp, type IcpCoverageRow, type IcpCoverageSummary, type ReclassifySummary } from '@/lib/api'

function ReclassifyPanel({ icpId, icpName, vertical }: { icpId: string; icpName: string; vertical: string }) {
  const [siblings, setSiblings] = useState<Array<{ id: string; name: string }>>([])
  const [summary, setSummary] = useState<IcpCoverageSummary | null>(null)
  const [breakdown, setBreakdown] = useState<IcpCoverageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ReclassifySummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch sibling ICPs (everyone else with this vertical) and the per-city
  // coverage status. Both are read-only inputs to the panel - no need to
  // refetch on save unless the user re-opens the editor.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      fetch('/api/icps').then((r) => r.json()),
      fetchIcpCoverage(icpId).catch(() => null),
    ]).then(([icpsRes, coverageRes]) => {
      if (cancelled) return
      if (icpsRes?.success && Array.isArray(icpsRes.icps)) {
        const others = icpsRes.icps.filter(
          (i: any) => i.id !== icpId && (i.vertical || '').toLowerCase() === vertical.toLowerCase(),
        )
        setSiblings(others.map((i: any) => ({ id: i.id, name: i.name })))
      }
      if (coverageRes?.success) {
        setSummary(coverageRes.summary)
        setBreakdown(coverageRes.breakdown)
      }
    }).catch((e) => {
      if (!cancelled) setError(e?.message || 'Failed to load coverage')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [icpId, vertical])

  const handleReclassify = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await reclassifyIcp(icpId)
      setResult(r.summary)
      // Refresh coverage so the panel reflects the just-completed work
      // (alreadyClassifiedByThisIcp counts move up).
      const c = await fetchIcpCoverage(icpId).catch(() => null)
      if (c?.success) {
        setSummary(c.summary)
        setBreakdown(c.breakdown)
      }
    } catch (e: any) {
      setError(e?.message || 'Reclassify failed')
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <div className={`${GLASS_SUBTLE} p-3 rounded-md text-xs text-muted-foreground flex items-center gap-2`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Loading coverage…
      </div>
    )
  }

  const hasCachedData = (summary?.totalCachedCompanies ?? 0) > 0
  const toClassify = summary?.totalToReclassify ?? 0

  return (
    <div className={`${GLASS_SUBTLE} p-3 rounded-md border border-border/40 space-y-2.5`}>
      <div className="flex items-center gap-2">
        <SparklesIcon className="h-3.5 w-3.5 text-emerald-500" />
        <span className="text-xs font-semibold">Reclassify cached data</span>
        <span className="text-[10px] text-muted-foreground">- skip the sweep, just run GPT</span>
      </div>

      {/* Sibling ICPs callout - orientation for the user about the shared
          vertical pool. Hidden when there are none. */}
      {siblings.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {siblings.length} other ICP{siblings.length === 1 ? '' : 's'} in <span className="font-medium text-foreground">{vertical}</span>: {siblings.map((s) => s.name).join(', ')}
        </div>
      )}

      {/* Per-city breakdown - collapsible if it gets long. Shows what
          would be reclassified vs already done. Empty (no rows) when the
          vertical has no cached companies in any of this ICP's cities. */}
      {hasCachedData ? (
        <ul className="text-[11px] space-y-0.5">
          {breakdown.map((row) => (
            <li key={row.city} className="flex items-center justify-between gap-2">
              <span className={row.covered ? 'text-foreground' : 'text-muted-foreground'}>
                {row.covered ? '✓' : '○'} {row.city}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {row.cachedCompanies > 0
                  ? `${row.cachedCompanies} cached · ${row.alreadyClassifiedByThisIcp}/${row.cachedCompanies} done`
                  : 'no cached data'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[11px] text-muted-foreground italic">
          No cached companies in this vertical yet. Run a sweep on Coverage to populate the cache, then come back to add more ICPs cheaply.
        </div>
      )}

      {/* Action - only enabled when there's something to do. The button
          label tells the user exactly what'll happen. */}
      <Button
        size="sm"
        className="w-full"
        onClick={handleReclassify}
        disabled={running || toClassify === 0}
        title={toClassify === 0 ? 'Nothing to reclassify - every cached company has already been classified by this ICP.' : `Run "${icpName}" classifier on ${toClassify} cached companies`}
      >
        {running ? (
          <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Reclassifying…</>
        ) : toClassify > 0 ? (
          <>Reclassify {toClassify} cached compan{toClassify === 1 ? 'y' : 'ies'}</>
        ) : (
          <>Up to date - nothing to reclassify</>
        )}
      </Button>

      {result && (
        <div className="text-[11px] rounded bg-emerald-500/10 border border-emerald-500/30 px-2 py-1.5 text-emerald-700 dark:text-emerald-300">
          Reclassified {result.processed} · {result.qualified} qualified, {result.rejected} rejected
          {result.skipped > 0 && ` · ${result.skipped} skipped (no cached scrape)`}
          {result.errors > 0 && ` · ${result.errors} errors`}
        </div>
      )}
      {error && (
        <div className="text-[11px] rounded bg-red-500/10 border border-red-500/30 px-2 py-1.5 text-red-700 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
