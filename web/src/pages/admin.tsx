// /admin - operator settings.
//
// Two tunable groups today, both with a Default/Custom toggle so the
// team can either ride the baked-in defaults or override per-knob:
//
//   - Cell generation: search radii + zoom per tier (urban/suburban/rural
//     /sparse/airport), city sub-cell spacing, sub-grid threshold,
//     population-radius ladder. Changes take effect on the NEXT seed -
//     existing cells keep their original zoom (it's baked into cell.ll).
//
//   - Firecrawl: scrape (single landing page, the default) vs crawl
//     (multiple pages per site, costs N× more credits). Applies on the
//     next scrape - no need to re-seed.
//
// Background style stays at the bottom as before. The page fetches
// `/api/admin/settings` on mount to pull defaults + current state, then
// PUTs each card's edits independently so a half-finished edit in one
// card doesn't block saving another.

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { GLASS } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { API_BASE } from '@/lib/api-base'
import { useBackground } from '@/context/background-context'
import { Image as ImageIcon, Square, MapPinned, Loader2, AlertTriangle, Save, RotateCcw, FileSearch, Sparkles, Linkedin, Scissors, Layers, CheckCircle2 } from 'lucide-react'

type ZoomEntry = { zoom: number; radiusKm: number }
type ZoomTier = 'urban' | 'suburban' | 'rural' | 'sparse' | 'airport'
type LadderRow = { minPop: number; radiusKm: number }

interface CellGenerationCustom {
  subCellSpacingKm: number
  ruralSparseKm: number
  ruralAvoidPlaceKm: number
  subgridThresholdPop: number
  maxPagesPerSearch: number
  conflictKeepFactor: number
  zoomBySource: Record<ZoomTier, ZoomEntry>
  populationLadder: LadderRow[]
}

interface IcpOption {
  id: string
  name: string
}

interface PrunePreview {
  total: number
  pending: number
  droppedPending: number
  keepFactor: number
}

interface FirecrawlCustom {
  mode: 'scrape' | 'crawl'
  crawlMaxPages: number
}

interface AiTaskEntry {
  provider: string
  model: string
}

interface AiCustom {
  classify: AiTaskEntry
  email: AiTaskEntry
  report: AiTaskEntry
  icpAutomation: AiTaskEntry
}

interface AiCatalogEntry {
  label: string
  models: string[]
  hasKey: boolean
}

type AiCatalog = Record<string, AiCatalogEntry>

interface LinkedinCustom {
  postsPerProfile: number
}

interface SettingsPayload {
  state: {
    cellGeneration: { useDefault: boolean; custom: CellGenerationCustom }
    firecrawl: { useDefault: boolean; custom: FirecrawlCustom }
    ai: { useDefault: boolean; custom: AiCustom }
    linkedin: { useDefault: boolean; custom: LinkedinCustom }
  }
  defaults: {
    cellGeneration: CellGenerationCustom
    firecrawl: FirecrawlCustom
    ai: AiCustom
    linkedin: LinkedinCustom
  }
  effective: {
    cellGeneration: CellGenerationCustom
    firecrawl: FirecrawlCustom
    ai: AiCustom
    linkedin: LinkedinCustom
  }
  allowedModels: string[]
  aiCatalog: AiCatalog
}

const TIER_ORDER: ZoomTier[] = ['urban', 'suburban', 'rural', 'sparse', 'airport']
const TIER_LABELS: Record<ZoomTier, string> = {
  urban: 'Urban populated',
  suburban: 'Suburban populated',
  rural: 'Rural populated',
  sparse: 'Sparse rural backstop',
  airport: 'Airport anchors',
}

export default function AdminPage() {
  const { background, setBackground } = useBackground()

  const [settings, setSettings] = useState<SettingsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Refresh from the server. Used on mount + after every successful save
  // so the UI always reflects what's actually persisted.
  async function refresh() {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`)
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Failed to load settings')
      setSettings(data)
    } catch (e: any) {
      setLoadError(e?.message || 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Tune the pipeline knobs the team uses most. Each section has a Default mode (baked-in numbers) and a Custom mode for per-knob overrides.
        </p>
      </div>

      {loading && (
        <Card className={cn(GLASS)}>
          <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings…
          </CardContent>
        </Card>
      )}

      {loadError && (
        <Card className={cn(GLASS)}>
          <CardContent className="p-6 flex items-start gap-2 text-sm text-red-600 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </CardContent>
        </Card>
      )}

      {settings && !loading && (
        <>
          <CellGenerationCard settings={settings} onSaved={refresh} />
          <ConflictPruneCard settings={settings} />
          <FirecrawlCard settings={settings} onSaved={refresh} />
          <AiCard settings={settings} onSaved={refresh} />
          <LinkedinCard settings={settings} onSaved={refresh} />
        </>
      )}

      <Card className={cn(GLASS)}>
        <CardContent className="p-6 space-y-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/15 text-purple-600 dark:text-purple-400">
              {background === 'photo' ? <ImageIcon className="h-5 w-5" /> : <Square className="h-5 w-5" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">Background</h2>
                <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30">
                  {background}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {background === 'photo'
                  ? 'The cinematic photo backdrop with drifting gradient blobs is on. Cards refract over it.'
                  : 'Flat backdrop - white in light mode, near-black in dark mode. Card surfaces are lifted for readability.'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <BackgroundOption
              active={background === 'photo'}
              onClick={() => setBackground('photo')}
              icon={<ImageIcon className="h-4 w-4" />}
              title="Photo"
              line1="Cinematic backdrop"
              line2="Refracting glass cards"
            />
            <BackgroundOption
              active={background === 'plain'}
              onClick={() => setBackground('plain')}
              icon={<Square className="h-4 w-4" />}
              title="Plain"
              line1="Flat white / black"
              line2="Default · less visual chatter"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Cell generation card ─────────────────────────────────────────────

function CellGenerationCard({ settings, onSaved }: { settings: SettingsPayload; onSaved: () => Promise<void> }) {
  const initial = settings.state.cellGeneration
  const defaults = settings.defaults.cellGeneration
  const [useDefault, setUseDefault] = useState<boolean>(initial.useDefault)
  const [custom, setCustom] = useState<CellGenerationCustom>(initial.custom)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  function patchZoom(tier: ZoomTier, field: keyof ZoomEntry, value: number) {
    setCustom((c) => ({
      ...c,
      zoomBySource: { ...c.zoomBySource, [tier]: { ...c.zoomBySource[tier], [field]: value } },
    }))
  }
  function patchLadder(idx: number, field: keyof LadderRow, value: number) {
    setCustom((c) => {
      const next = c.populationLadder.map((row, i) => (i === idx ? { ...row, [field]: value } : row))
      return { ...c, populationLadder: next }
    })
  }
  function resetCustomToDefaults() {
    setCustom(structuredClone(defaults))
  }

  async function save() {
    setSaving(true)
    setErr(null)
    setOk(false)
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cellGeneration: { useDefault, custom } }),
      })
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Failed to save')
      setOk(true)
      await onSaved()
      setTimeout(() => setOk(false), 2500)
    } catch (e: any) {
      setErr(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400">
            <MapPinned className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Search radii & cell generation</h2>
              <Badge variant="secondary" className={cn(
                'uppercase tracking-wide text-[10px]',
                useDefault
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
              )}>
                {useDefault ? 'Default' : 'Custom'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Hex spacing, sub-grid threshold, and per-tier zoom + radius for the grid seeder. Changes apply on the <b>next seed</b> - existing cells keep their original zoom.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            active={useDefault}
            onClick={() => setUseDefault(true)}
            title="Default"
            line1="Use the baked-in values"
            line2="Same as before any tuning"
            accent="sky"
          />
          <ModeOption
            active={!useDefault}
            onClick={() => setUseDefault(false)}
            title="Custom"
            line1="Edit per-tier values below"
            line2="Saved per-knob; revert any time"
            accent="amber"
          />
        </div>

        {!useDefault && (
          <div className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <SectionHeader>Spacing &amp; thresholds</SectionHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <NumField
                label="City sub-cell spacing (km)"
                hint={`Default ${defaults.subCellSpacingKm} · hex gap between cells inside a metro`}
                value={custom.subCellSpacingKm}
                onChange={(v) => setCustom((c) => ({ ...c, subCellSpacingKm: v }))}
              />
              <NumField
                label="Rural sparse spacing (km)"
                hint={`Default ${defaults.ruralSparseKm} · gap for the rural backstop hex`}
                value={custom.ruralSparseKm}
                onChange={(v) => setCustom((c) => ({ ...c, ruralSparseKm: v }))}
              />
              <NumField
                label="Rural avoid-place (km)"
                hint={`Default ${defaults.ruralAvoidPlaceKm} · sparse cells must be ≥ this far from any town`}
                value={custom.ruralAvoidPlaceKm}
                onChange={(v) => setCustom((c) => ({ ...c, ruralAvoidPlaceKm: v }))}
              />
              <NumField
                label="Sub-grid pop threshold"
                hint={`Default ${defaults.subgridThresholdPop} · places above this get a hex sub-grid`}
                value={custom.subgridThresholdPop}
                onChange={(v) => setCustom((c) => ({ ...c, subgridThresholdPop: v }))}
              />
              <NumField
                label="Max pages per search"
                hint={`Default ${defaults.maxPagesPerSearch} · 1-6 · each extra page = 5 Scrapingdog credits, 20 more results`}
                value={custom.maxPagesPerSearch}
                onChange={(v) => setCustom((c) => ({ ...c, maxPagesPerSearch: v }))}
              />
              <NumField
                label="Conflict keep factor"
                hint={`Default ${defaults.conflictKeepFactor} · 0-1 · 0 = no prune, 0.6 = balanced, 1 = no overlap`}
                value={custom.conflictKeepFactor}
                onChange={(v) => setCustom((c) => ({ ...c, conflictKeepFactor: Math.max(0, Math.min(1, v)) }))}
              />
            </div>
            <p className="text-[11px] text-muted-foreground -mt-1">
              Each Scrapingdog page returns up to 20 results (5 credits). Default 1 = first 20 only. Bumping to 3 fetches up to 60 places per search term per cell - useful for dense urban cells but multiplies cost. Capped at 6 per the Scrapingdog docs.
            </p>

            <SectionHeader>Zoom &amp; radius per tier</SectionHeader>
            <p className="text-[11px] text-muted-foreground -mt-1.5">
              Scrapingdog uses the <b>zoom</b> at sweep time (8 ≈ 100 km, 10 ≈ 28 km, 12 ≈ 7 km, 13 ≈ 4 km). Radius is stored on the cell record for UI / audit, it doesn't change the actual search width.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-2">
              {TIER_ORDER.map((tier) => (
                <div key={tier} className="grid grid-cols-[1fr,5rem,5rem] items-center gap-2">
                  <div className="text-sm">
                    <div className="font-medium">{TIER_LABELS[tier]}</div>
                    <div className="text-[10px] text-muted-foreground">
                      Default zoom {defaults.zoomBySource[tier].zoom} · radius {defaults.zoomBySource[tier].radiusKm} km
                    </div>
                  </div>
                  <NumField
                    label="Zoom"
                    compact
                    value={custom.zoomBySource[tier].zoom}
                    onChange={(v) => patchZoom(tier, 'zoom', v)}
                  />
                  <NumField
                    label="Radius km"
                    compact
                    value={custom.zoomBySource[tier].radiusKm}
                    onChange={(v) => patchZoom(tier, 'radiusKm', v)}
                  />
                </div>
              ))}
            </div>

            <SectionHeader>Population → metro radius ladder</SectionHeader>
            <p className="text-[11px] text-muted-foreground -mt-1.5">
              For each populated place above the sub-grid threshold, the seeder picks the first row whose minPop is ≤ that place's population, and lays a hex grid of that radius.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {custom.populationLadder.map((row, idx) => (
                <div key={idx} className="grid grid-cols-2 gap-2 rounded-md border border-amber-500/20 bg-white/40 dark:bg-white/[0.03] p-2">
                  <NumField
                    label={`Min pop`}
                    compact
                    value={row.minPop}
                    onChange={(v) => patchLadder(idx, 'minPop', v)}
                  />
                  <NumField
                    label="Radius (km)"
                    compact
                    value={row.radiusKm}
                    onChange={(v) => patchLadder(idx, 'radiusKm', v)}
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetCustomToDefaults}
                className="text-xs gap-1.5"
              >
                <RotateCcw className="h-3 w-3" /> Reset custom values to defaults
              </Button>
            </div>
          </div>
        )}

        {err && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {ok && <span className="text-xs text-emerald-600 dark:text-emerald-300">Saved</span>}
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Conflict prune card ─────────────────────────────────────────────
//
// Lets the operator (a) preview how many existing pending cells the prune
// algorithm would drop at various keepFactor values, and (b) actually
// execute the prune against the live grid for a chosen ICP. Doesn't own
// the keepFactor value itself - that lives in the Cell Generation card
// above. This card just acts on it.

function ConflictPruneCard({ settings }: { settings: SettingsPayload }) {
  const effectiveFactor = settings.effective.cellGeneration.conflictKeepFactor

  const [icps, setIcps] = useState<IcpOption[]>([])
  const [icpsLoading, setIcpsLoading] = useState(true)
  const [icpId, setIcpId] = useState<string>('')

  // The slider for "what if I tried this factor?" - independent of the
  // saved setting. Lets the operator scrub values before committing.
  const [scrubFactor, setScrubFactor] = useState<number>(effectiveFactor > 0 ? effectiveFactor : 0.6)
  const [preview, setPreview] = useState<PrunePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const [pruning, setPruning] = useState(false)
  const [pruneResult, setPruneResult] = useState<{ removed: number; keepFactor: number } | null>(null)
  const [pruneError, setPruneError] = useState<string | null>(null)

  // Fetch ICPs once on mount. Use the trimmed listing - we only need
  // id + name for the picker.
  useEffect(() => {
    let cancelled = false
    setIcpsLoading(true)
    fetch(`${API_BASE}/api/grid/icps`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const list: IcpOption[] = Array.isArray(data?.icps) ? data.icps.map((i: any) => ({ id: i.id, name: i.name })) : []
        setIcps(list)
        // Auto-pick the first ICP so the user sees a preview without
        // an extra click.
        if (list.length > 0 && !icpId) setIcpId(list[0].id)
      })
      .catch(() => { if (!cancelled) setIcps([]) })
      .finally(() => { if (!cancelled) setIcpsLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Debounced live preview - hit the backend ~300ms after the user
  // stops sliding so we don't spam the endpoint with every increment.
  useEffect(() => {
    if (!icpId || scrubFactor <= 0) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    setPreviewError(null)
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/grid/preview-prune?icp=${encodeURIComponent(icpId)}&keepFactor=${scrubFactor}`)
        const data = await res.json()
        if (!data?.success) throw new Error(data?.error || 'Failed to preview')
        setPreview({
          total: data.total,
          pending: data.pending,
          droppedPending: data.droppedPending,
          keepFactor: data.keepFactor,
        })
      } catch (e: any) {
        setPreviewError(e?.message || 'Preview failed')
      } finally {
        setPreviewLoading(false)
      }
    }, 300)
    return () => clearTimeout(handle)
  }, [icpId, scrubFactor])

  async function executePrune() {
    if (!icpId || scrubFactor <= 0) return
    setPruning(true)
    setPruneError(null)
    setPruneResult(null)
    try {
      const res = await fetch(`${API_BASE}/api/grid/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icp: icpId, keepFactor: scrubFactor }),
      })
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Prune failed')
      setPruneResult({ removed: data.removed, keepFactor: data.keepFactor })
      // Refresh the preview so the user sees the new "after" state.
      setPreview({
        total: (preview?.total || 0) - (data.removed || 0),
        pending: (preview?.pending || 0) - (data.removed || 0),
        droppedPending: 0,
        keepFactor: data.keepFactor,
      })
    } catch (e: any) {
      setPruneError(e?.message || 'Prune failed')
    } finally {
      setPruning(false)
    }
  }

  const reductionPct = preview && preview.pending > 0
    ? Math.round((preview.droppedPending / preview.pending) * 100)
    : 0

  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600 dark:text-rose-400">
            <Scissors className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold">Conflict prune</h2>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30">
                Saved factor · {effectiveFactor}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Greedy disc-conflict algorithm. Walks cells in importance order (city scope &gt; population &gt; airports &gt; sparse) and drops any whose center sits inside a higher-importance cell's search radius × keepFactor. Lower-importance neighbors get absorbed; coverage stays intact via the surviving cells' overlap.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr] gap-4">
          <div>
            <label className="block">
              <div className="text-[11px] font-medium text-muted-foreground mb-1">ICP to preview / prune</div>
              <select
                value={icpId}
                onChange={(e) => setIcpId(e.target.value)}
                disabled={icpsLoading || icps.length === 0}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {icpsLoading && <option>Loading ICPs…</option>}
                {!icpsLoading && icps.length === 0 && <option>No ICPs configured</option>}
                {!icpsLoading && icps.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <label className="block">
              <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1">
                <span>Try keepFactor</span>
                <span className="font-mono text-[11px] text-foreground">{scrubFactor.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={scrubFactor}
                onChange={(e) => setScrubFactor(Number(e.target.value))}
                className="w-full accent-rose-500"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground/70 mt-0.5">
                <span>0 (off)</span>
                <span>0.6 (balanced)</span>
                <span>1 (no overlap)</span>
              </div>
            </label>
          </div>
        </div>

        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 space-y-3">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex items-center gap-2">
            <Layers className="h-3 w-3" /> Live preview
            {previewLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />}
          </div>

          {scrubFactor <= 0 && (
            <p className="text-sm text-muted-foreground">
              Slide the keepFactor above 0 to see how many cells would be dropped.
            </p>
          )}

          {scrubFactor > 0 && !icpId && (
            <p className="text-sm text-muted-foreground">Pick an ICP to preview.</p>
          )}

          {scrubFactor > 0 && icpId && preview && (
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Stat label="Total cells" value={preview.total} />
              <Stat label="Pending now" value={preview.pending} />
              <Stat
                label="Would drop"
                value={`${preview.droppedPending}${preview.pending > 0 ? ` (${reductionPct}%)` : ''}`}
                accent="rose"
              />
            </div>
          )}

          {previewError && (
            <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{previewError}</span>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Only <b>pending</b> cells get dropped - completed and in-flight cells are always kept. Sweeps you've already paid for stay on the map.
          </p>
        </div>

        {pruneError && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{pruneError}</span>
          </div>
        )}

        {pruneResult && (
          <div className="flex items-start gap-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-sm">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Pruned {pruneResult.removed} pending cell{pruneResult.removed === 1 ? '' : 's'} at keepFactor {pruneResult.keepFactor}.</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[11px] text-muted-foreground">
            Save the keepFactor in Cell Generation above to apply it to <b>new seeds</b>. Use Prune now to also clean up the <b>existing pending queue</b> for this ICP.
          </p>
          <Button
            onClick={executePrune}
            disabled={pruning || !icpId || scrubFactor <= 0 || (preview?.droppedPending ?? 0) === 0}
            variant="destructive"
            className="gap-1.5"
          >
            {pruning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
            Prune now
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: 'rose' }) {
  return (
    <div className={cn(
      'rounded-md border border-white/40 dark:border-white/10 bg-white/50 dark:bg-white/[0.03] px-3 py-2',
      accent === 'rose' && 'border-rose-500/40 bg-rose-500/10',
    )}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', accent === 'rose' && 'text-rose-700 dark:text-rose-300')}>{value}</div>
    </div>
  )
}

// ─── Firecrawl card ───────────────────────────────────────────────────

function FirecrawlCard({ settings, onSaved }: { settings: SettingsPayload; onSaved: () => Promise<void> }) {
  const initial = settings.state.firecrawl
  const defaults = settings.defaults.firecrawl
  const [useDefault, setUseDefault] = useState<boolean>(initial.useDefault)
  const [custom, setCustom] = useState<FirecrawlCustom>(initial.custom)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  async function save() {
    setSaving(true)
    setErr(null)
    setOk(false)
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firecrawl: { useDefault, custom } }),
      })
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Failed to save')
      setOk(true)
      await onSaved()
      setTimeout(() => setOk(false), 2500)
    } catch (e: any) {
      setErr(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const effectiveMode = useDefault ? defaults.mode : custom.mode

  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <FileSearch className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Firecrawl</h2>
              <Badge variant="secondary" className={cn(
                'uppercase tracking-wide text-[10px]',
                useDefault
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
              )}>
                {useDefault ? 'Default' : 'Custom'}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                {effectiveMode === 'crawl' ? `Crawl · ${useDefault ? defaults.crawlMaxPages : custom.crawlMaxPages} pages` : 'Scrape · 1 page'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              How Firecrawl reads each company's website. Applies on the <b>next scrape</b> - no restart needed.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            active={useDefault}
            onClick={() => setUseDefault(true)}
            title="Default"
            line1="Scrape · single landing page"
            line2="Cheapest. Sufficient for most ICPs"
            accent="sky"
          />
          <ModeOption
            active={!useDefault}
            onClick={() => setUseDefault(false)}
            title="Custom"
            line1="Scrape OR crawl multiple pages"
            line2="Pick mode + page cap below"
            accent="amber"
          />
        </div>

        {!useDefault && (
          <div className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ModeOption
                active={custom.mode === 'scrape'}
                onClick={() => setCustom((c) => ({ ...c, mode: 'scrape' }))}
                title="Scrape one page"
                line1="Landing page only"
                line2="~1 Firecrawl credit per company"
                accent="emerald"
              />
              <ModeOption
                active={custom.mode === 'crawl'}
                onClick={() => setCustom((c) => ({ ...c, mode: 'crawl' }))}
                title="Crawl all pages"
                line1="Multi-page · up to the cap"
                line2={`~${custom.crawlMaxPages || 10}× credits per company`}
                accent="emerald"
              />
            </div>

            {custom.mode === 'crawl' && (
              <div className="space-y-2">
                <NumField
                  label="Max pages per site"
                  hint={`Default ${defaults.crawlMaxPages} · hard cap on pages crawled per company (1-250)`}
                  value={custom.crawlMaxPages}
                  onChange={(v) => setCustom((c) => ({ ...c, crawlMaxPages: v }))}
                />
                <p className="text-[11px] text-muted-foreground">
                  Warning: crawling 20 pages costs ~20× more Firecrawl credits per company than the default single-page scrape.
                </p>
              </div>
            )}
          </div>
        )}

        {err && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {ok && <span className="text-xs text-emerald-600 dark:text-emerald-300">Saved</span>}
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── AI card (classify + email models) ───────────────────────────────

function AiCard({ settings, onSaved }: { settings: SettingsPayload; onSaved: () => Promise<void> }) {
  const initial = settings.state.ai
  const defaults = settings.defaults.ai
  const catalog = settings.aiCatalog ?? {}
  const [useDefault, setUseDefault] = useState<boolean>(initial.useDefault)
  const [custom, setCustom] = useState<AiCustom>(initial.custom)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  async function save() {
    setSaving(true)
    setErr(null)
    setOk(false)
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai: { useDefault, custom } }),
      })
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Failed to save')
      setOk(true)
      await onSaved()
      setTimeout(() => setOk(false), 2500)
    } catch (e: any) {
      setErr(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const effective = useDefault ? defaults : custom

  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold">AI models</h2>
              <Badge variant="secondary" className={cn(
                'uppercase tracking-wide text-[10px]',
                useDefault
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
              )}>
                {useDefault ? 'Default' : 'Custom'}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30">
                Classify · {effective.classify.model}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30">
                Email · {effective.email.model}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30">
                Report · {effective.report.model}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30">
                ICP automation · {effective.icpAutomation.model}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Pick the AI provider and model for each job independently: <b>classify</b> (the qualified/rejected verdict), <b>email, LI message & sequences</b>, the <b>markdown report</b>, and <b>ICP automation</b> (wizard auto-fill / regen-section / terms-for-city). Applies on the next call - no restart.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            active={useDefault}
            onClick={() => setUseDefault(true)}
            title="Default"
            line1={`Classify ${defaults.classify.model} · Report ${defaults.report.model}`}
            line2={`${defaults.classify.provider} / ${defaults.report.provider}`}
            accent="sky"
          />
          <ModeOption
            active={!useDefault}
            onClick={() => setUseDefault(false)}
            title="Custom"
            line1="Pick each independently"
            line2="Mix providers and models per task"
            accent="amber"
          />
        </div>

        {!useDefault && (
          <div className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <TaskPicker
                label="Classify (verdict)"
                task={custom.classify}
                catalog={catalog}
                onChange={(entry) => setCustom((c) => ({ ...c, classify: entry }))}
                defaultEntry={defaults.classify}
              />
              <TaskPicker
                label="Email, LI & sequences"
                task={custom.email}
                catalog={catalog}
                onChange={(entry) => setCustom((c) => ({ ...c, email: entry }))}
                defaultEntry={defaults.email}
              />
              <TaskPicker
                label="Markdown report"
                task={custom.report}
                catalog={catalog}
                onChange={(entry) => setCustom((c) => ({ ...c, report: entry }))}
                defaultEntry={defaults.report}
              />
              <TaskPicker
                label="ICP automation"
                task={custom.icpAutomation}
                catalog={catalog}
                onChange={(entry) => setCustom((c) => ({ ...c, icpAutomation: entry }))}
                defaultEntry={defaults.icpAutomation}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Cheapest: <code>claude-haiku-4-5</code> (~$0.08/Mtok in). Mid-tier: <code>claude-sonnet-4-6</code> ($3/Mtok), <code>gpt-4o-mini</code> ($0.15/Mtok), <code>gemini-2.5-flash</code> (~$0.15/Mtok). Strongest: <code>claude-opus-4-8</code> ($15/Mtok), <code>gpt-4o</code> ($2.50/Mtok). See live spend by model on the{' '}
              <a href="/costs" className="underline">Costs</a> page.
            </p>
          </div>
        )}

        {err && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {ok && <span className="text-xs text-emerald-600 dark:text-emerald-300">Saved</span>}
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── LinkedIn card ───────────────────────────────────────────────────

function LinkedinCard({ settings, onSaved }: { settings: SettingsPayload; onSaved: () => Promise<void> }) {
  const initial = settings.state.linkedin
  const defaults = settings.defaults.linkedin
  const [useDefault, setUseDefault] = useState<boolean>(initial.useDefault)
  const [custom, setCustom] = useState<LinkedinCustom>(initial.custom)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  async function save() {
    setSaving(true)
    setErr(null)
    setOk(false)
    try {
      const res = await fetch(`${API_BASE}/api/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin: { useDefault, custom } }),
      })
      const data = await res.json()
      if (!data?.success) throw new Error(data?.error || 'Failed to save')
      setOk(true)
      await onSaved()
      setTimeout(() => setOk(false), 2500)
    } catch (e: any) {
      setErr(e?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const effective = useDefault ? defaults : custom

  return (
    <Card className={cn(GLASS)}>
      <CardContent className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600 dark:text-blue-400">
            <Linkedin className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold">LinkedIn</h2>
              <Badge variant="secondary" className={cn(
                'uppercase tracking-wide text-[10px]',
                useDefault
                  ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
              )}>
                {useDefault ? 'Default' : 'Custom'}
              </Badge>
              <Badge variant="secondary" className="uppercase tracking-wide text-[10px] bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30">
                {effective.postsPerProfile} posts / profile
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              How many recent posts to pull per LinkedIn profile. Direct multiplier on Apify cost (~$0.001 per post).
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ModeOption
            active={useDefault}
            onClick={() => setUseDefault(true)}
            title="Default"
            line1={`${defaults.postsPerProfile} posts per profile`}
            line2="Cheap, decent signal"
            accent="sky"
          />
          <ModeOption
            active={!useDefault}
            onClick={() => setUseDefault(false)}
            title="Custom"
            line1="Pick your own cap"
            line2="1-25 posts per profile"
            accent="amber"
          />
        </div>

        {!useDefault && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <NumField
              label="Posts per profile"
              hint={`Default ${defaults.postsPerProfile} · clamped 1-25`}
              value={custom.postsPerProfile}
              onChange={(v) => setCustom((c) => ({ ...c, postsPerProfile: v }))}
            />
          </div>
        )}

        {err && (
          <div className="flex items-start gap-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {ok && <span className="text-xs text-emerald-600 dark:text-emerald-300">Saved</span>}
          <Button onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Shared widgets ───────────────────────────────────────────────────

function TaskPicker({
  label, task, catalog, onChange, defaultEntry,
}: {
  label: string
  task: AiTaskEntry
  catalog: AiCatalog
  onChange: (entry: AiTaskEntry) => void
  defaultEntry: AiTaskEntry
}) {
  const providerIds = Object.keys(catalog)
  const models = catalog[task.provider]?.models ?? [task.model]
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <select
        value={task.provider}
        onChange={(e) => {
          const p = e.target.value
          const firstModel = catalog[p]?.models?.[0] ?? task.model
          onChange({ provider: p, model: firstModel })
        }}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {providerIds.map((id) => (
          <option key={id} value={id}>{catalog[id].label ?? id}</option>
        ))}
      </select>
      <select
        value={task.model}
        onChange={(e) => onChange({ ...task, model: e.target.value })}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {models.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <div className="text-[10px] text-muted-foreground/80 mt-0.5">
        Default: {defaultEntry.provider} / {defaultEntry.model}
      </div>
    </div>
  )
}

function ModelPicker({
  label, value, options, onChange, hint,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  hint?: string
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-medium text-muted-foreground mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      {hint && <div className="text-[10px] text-muted-foreground/80 mt-1">{hint}</div>}
    </label>
  )
}

function NumField({
  label, value, onChange, hint, compact,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  hint?: string
  compact?: boolean
}) {
  return (
    <label className="block">
      <div className={cn('text-[11px] font-medium text-muted-foreground', compact ? 'mb-0.5' : 'mb-1')}>{label}</div>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 text-sm"
      />
      {hint && !compact && <div className="text-[10px] text-muted-foreground/80 mt-1">{hint}</div>}
    </label>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{children}</div>
  )
}

function BackgroundOption({
  active, onClick, icon, title, line1, line2,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  line1: string
  line2: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={active}
      className={cn(
        'h-auto justify-start gap-3 px-4 py-3 text-left rounded-xl border-white/40 dark:border-white/10',
        active && 'ring-2 ring-purple-500/60 bg-purple-500/10',
      )}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-white/40 dark:bg-white/10">
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{line1}</span>
        <span className="block text-[10px] text-muted-foreground/70">{line2}</span>
      </span>
    </Button>
  )
}

function ModeOption({
  active, onClick, title, line1, line2, accent,
}: {
  active: boolean
  onClick: () => void
  title: string
  line1: string
  line2: string
  accent: 'sky' | 'amber' | 'emerald'
}) {
  const ring =
    accent === 'sky' ? 'ring-sky-500/60 bg-sky-500/10' :
    accent === 'amber' ? 'ring-amber-500/60 bg-amber-500/10' :
    'ring-emerald-500/60 bg-emerald-500/10'
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        'h-auto justify-start gap-3 px-4 py-3 text-left rounded-xl border-white/40 dark:border-white/10',
        active && `ring-2 ${ring}`,
      )}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{line1}</span>
        <span className="block text-[10px] text-muted-foreground/70">{line2}</span>
      </span>
    </Button>
  )
}
